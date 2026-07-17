// Hermetic tests for skills/cfo-reconstruction. NO live gateway/Xero/Azure/Cosmos anywhere in this
// file: every I/O touchpoint in runSweep() is dependency-injected via opts and replaced with an
// in-memory fake, mirroring skills/legal-deadline-pager/tests/pager.test.mjs's pattern. This is what
// proves the "never posts to Xero" and resumability/idempotency guarantees hold at the code-path
// level, not just in prose.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  sha256Hex,
  computeItemId,
  computeBatchId,
  dueOrgsForSnapshot,
  hasMaterialChange,
  selectPendingManifestItems,
  countAttachments,
  classifyAttachmentVerdict,
  buildStagedBatch,
  runSweep,
  ORG_KEYS,
  DEFAULT_STALE_HOURS,
} from "../reconstruct.mjs";
import { isReadOnlyXeroTool, READ_ONLY_XERO_TOOLS, callXeroReadOnly } from "../xero-readonly.mjs";

const NOW = "2026-07-18T06:00:00.000Z";

// ============================ pure: id/hash helpers ============================

test("computeItemId is stable for identical items and differs when any field differs", () => {
  const a = { org: "otchealth", kind: "xero-snapshot" };
  const b = { ...a };
  const c = { ...a, org: "innd" };
  assert.equal(computeItemId(a), computeItemId(b));
  assert.notEqual(computeItemId(a), computeItemId(c));
});

test("computeBatchId is stable for the same item ids + date, and changes when either changes", () => {
  const ids = ["cfr_aaa", "cfr_bbb"];
  const id1 = computeBatchId(ids, "2026-07-18");
  const id2 = computeBatchId([...ids].reverse(), "2026-07-18"); // order-independent (sorted internally)
  const id3 = computeBatchId(ids, "2026-07-19");
  const id4 = computeBatchId(["cfr_aaa", "cfr_ccc"], "2026-07-18");
  assert.equal(id1, id2, "batch id must not depend on item order");
  assert.notEqual(id1, id3, "a new day must yield a new batch id");
  assert.notEqual(id1, id4, "a different item set must yield a new batch id");
  assert.match(id1, /^batch_[0-9a-f]{16}$/);
});

test("sha256Hex is deterministic", () => {
  assert.equal(sha256Hex("x"), sha256Hex("x"));
  assert.notEqual(sha256Hex("x"), sha256Hex("y"));
});

// ============================ pure: snapshot due/change logic ============================

test("dueOrgsForSnapshot: an org never snapshotted is always due", () => {
  const due = dueOrgsForSnapshot({ last_snapshot: {} }, NOW);
  assert.deepEqual([...due].sort(), [...ORG_KEYS].sort());
});

test("dueOrgsForSnapshot: a snapshot taken 1 hour ago is NOT due (default 20h staleness)", () => {
  const oneHourAgo = new Date(Date.parse(NOW) - 3600 * 1000).toISOString();
  const state = { last_snapshot: { otchealth: { content_hash: "h", staged_at: oneHourAgo } } };
  const due = dueOrgsForSnapshot(state, NOW);
  assert.ok(!due.includes("otchealth"));
  assert.equal(due.length, ORG_KEYS.length - 1);
});

test("dueOrgsForSnapshot: a snapshot older than staleHours IS due again", () => {
  const longAgo = new Date(Date.parse(NOW) - (DEFAULT_STALE_HOURS + 1) * 3600 * 1000).toISOString();
  const state = { last_snapshot: { otchealth: { content_hash: "h", staged_at: longAgo } } };
  const due = dueOrgsForSnapshot(state, NOW);
  assert.ok(due.includes("otchealth"));
});

test("hasMaterialChange: no prior hash always counts as changed; equal hashes do not", () => {
  assert.equal(hasMaterialChange(undefined, "abc"), true);
  assert.equal(hasMaterialChange("abc", "abc"), false);
  assert.equal(hasMaterialChange("abc", "def"), true);
});

// ============================ pure: manifest batch selection ============================

test("selectPendingManifestItems: only pending items are selected, bounded by n, in file order", () => {
  const items = [
    { id: "1", status: "pending" },
    { id: "2", status: "staged" },
    { id: "3", status: "pending" },
    { id: "4", status: "pending" },
  ];
  const batch = selectPendingManifestItems(items, 2);
  assert.deepEqual(batch.map((i) => i.id), ["1", "3"]);
});

test("selectPendingManifestItems: n=0 or empty input returns an empty batch, never throws", () => {
  assert.deepEqual(selectPendingManifestItems([{ id: "1", status: "pending" }], 0), []);
  assert.deepEqual(selectPendingManifestItems([], 5), []);
  assert.deepEqual(selectPendingManifestItems(null, 5), []);
});

// ============================ pure: attachment verdict + shape tolerance ============================

test("countAttachments tolerates the plausible wrapper shapes and defaults unknown shapes to 0", () => {
  assert.equal(countAttachments([{ a: 1 }, { a: 2 }]), 2);
  assert.equal(countAttachments({ Attachments: [{ a: 1 }] }), 1);
  assert.equal(countAttachments({ attachments: [] }), 0);
  assert.equal(countAttachments({ somethingElse: true }), 0);
  assert.equal(countAttachments(null), 0);
});

test("classifyAttachmentVerdict covers all four combinations", () => {
  assert.equal(classifyAttachmentVerdict({ xeroHasAttachment: true, sourceDocExists: true }), "MATCHED");
  assert.equal(classifyAttachmentVerdict({ xeroHasAttachment: false, sourceDocExists: false }), "MISSING_BOTH");
  assert.equal(classifyAttachmentVerdict({ xeroHasAttachment: false, sourceDocExists: true }), "MISSING_XERO_ATTACHMENT");
  assert.equal(classifyAttachmentVerdict({ xeroHasAttachment: true, sourceDocExists: false }), "MISSING_SOURCE_DOC");
});

// ============================ pure: staged-batch envelope ============================

test("buildStagedBatch: envelope is explicit that nothing was posted, and contains no em/en dashes", () => {
  const batch = buildStagedBatch({ batchId: "batch_x", mode: "xero-snapshot", items: [{ id: "1" }], nowIso: NOW });
  assert.equal(batch.posting_performed, false);
  assert.equal(batch.sign_off_required, true);
  assert.equal(batch.item_count, 1);
  assert.doesNotMatch(batch.note, /[–—]/, "no em dash or en dash in staged output");
});

// ============================ the read-only rail (xero-readonly.mjs) ============================

test("READ_ONLY_XERO_TOOLS never contains the gateway's write-capable Xero tool", () => {
  assert.ok(!READ_ONLY_XERO_TOOLS.includes("xero_request"), "the write tool must never be allowlisted");
});

test("isReadOnlyXeroTool: true only for allowlisted names, false for the write tool and junk input", () => {
  assert.equal(isReadOnlyXeroTool("xero_report"), true);
  assert.equal(isReadOnlyXeroTool("xero_get"), true);
  assert.equal(isReadOnlyXeroTool("xero_request"), false);
  assert.equal(isReadOnlyXeroTool("xero_bulk_post"), false);
  assert.equal(isReadOnlyXeroTool(undefined), false);
  assert.equal(isReadOnlyXeroTool(""), false);
});

test("callXeroReadOnly REFUSES a disallowed tool name before any network call is made", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error("fetch must never be called for a disallowed tool"); };
  try {
    await assert.rejects(
      () => callXeroReadOnly("fake-bearer", "xero_request", { org: "otchealth", method: "POST", path: "/Invoices" }),
      /REFUSED \(read-only rail\)/,
    );
  } finally { global.fetch = originalFetch; }
});

test("callXeroReadOnly allows an allowlisted tool and forces acknowledge_warning:true", async () => {
  const originalFetch = global.fetch;
  let capturedBody = null;
  const innerPayload = { Reports: [{ ReportID: "TrialBalance" }] };
  global.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    const envelope = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(innerPayload) }] } };
    return { ok: true, status: 200, text: async () => JSON.stringify(envelope) };
  };
  try {
    const result = await callXeroReadOnly("fake-bearer", "xero_report", { org: "otchealth", report: "TrialBalance", acknowledge_warning: false });
    assert.deepEqual(result, innerPayload);
    assert.equal(capturedBody.params.name, "xero_report");
    assert.equal(capturedBody.params.arguments.acknowledge_warning, true, "acknowledge_warning must be forced true even if the caller passed false");
  } finally { global.fetch = originalFetch; }
});

// ============================ source scan: forbidden tokens never appear in this skill ============================

function listSourceFiles(dir) {
  let out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== "tests") out = out.concat(listSourceFiles(p)); }
    else if (/\.(mjs|sh)$/.test(entry.name)) out.push(p);
  }
  return out;
}

test("no source file in this skill (outside tests/) references the Xero write tool or the separate posting jobs", () => {
  const skillDir = join(dirname(fileURLToPath(import.meta.url)), "..");
  const files = listSourceFiles(skillDir);
  assert.ok(files.length >= 3, "sanity: the scan should see at least xero-readonly.mjs, reconstruct.mjs, job/cfo-nightly.sh");
  const forbidden = ["xero_request", "xero-bulk", "xero-run"];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const token of forbidden) {
      assert.ok(!text.includes(token), `${f} must never reference "${token}" -- this skill must never import or call the write-capable Xero path or the separate posting jobs`);
    }
  }
});

// ============================ runSweep: dependency-injected I/O (NO live gateway/Azure/Cosmos) ============================

/** A cursor state where every entity already has a just-taken snapshot, so dueOrgsForSnapshot()
 *  returns nothing due -- used to isolate manifest-drain (kind B) tests from the self-bootstrapping
 *  snapshot pass (kind A) without touching the `orgs` filter (which scopes BOTH kinds at once). */
function freshSnapshotState(nowIso) {
  const last_snapshot = {};
  for (const org of ORG_KEYS) last_snapshot[org] = { content_hash: "seed", staged_at: nowIso };
  return { last_snapshot, updated_at: nowIso };
}

function mockIo(overrides = {}) {
  const store = new Map();
  if (overrides.initialState) store.set("STATE", overrides.initialState);
  const manifestStore = { ...(overrides.manifests || {}) };
  const xeroCalls = [];
  const putStateCalls = [];
  const putManifestCalls = [];
  const onedriveDeliveries = [];
  const gatesOpened = [];
  const statusLines = [];
  const xeroResponses = overrides.xeroResponses || {};
  return {
    store, manifestStore, xeroCalls, putStateCalls, putManifestCalls, onedriveDeliveries, gatesOpened, statusLines,
    getBearer: async () => "fake-cfo-bearer",
    xeroCall: async (bearer, name, args) => {
      xeroCalls.push({ name, args });
      if (!isReadOnlyXeroTool(name)) throw new Error(`test harness caught a disallowed tool call: ${name}`);
      const key = `${name}|${args.org}|${args.report || args.endpoint || ""}`;
      return Object.prototype.hasOwnProperty.call(xeroResponses, key) ? xeroResponses[key] : {};
    },
    getState: async () => (store.has("STATE") ? store.get("STATE") : null),
    putState: async (s) => { putStateCalls.push(s); store.set("STATE", s); },
    getManifest: async (org) => manifestStore[org] || [],
    putManifest: async (org, items) => { putManifestCalls.push({ org, items }); manifestStore[org] = items; },
    sourceDocExists: overrides.sourceDocExists || (async () => true),
    putStagedBatch: overrides.putStagedBatch || (async (batchId, batch) => { store.set(`staged:${batchId}`, batch); return { ok: true, path: `mock://staged/${batchId}.json` }; }),
    deliverToOneDrive: overrides.deliverToOneDrive || (async (batchId) => { onedriveDeliveries.push(batchId); return { ok: true, path: `mock-onedrive/${batchId}.json` }; }),
    openReviewGate: overrides.openReviewGate || (async (batch, evidenceLink, innd) => { gatesOpened.push({ batchId: batch.batch_id, evidenceLink, innd }); return { ok: true }; }),
    logStatus: overrides.logStatus || (async (text) => { statusLines.push(text); }),
  };
}

test("runSweep: first-ever run stages a xero-snapshot batch for all four entities and persists state", async () => {
  const io = mockIo();
  const summary = await runSweep({ nowIso: NOW, ...io });
  assert.equal(summary.staged, true);
  assert.equal(summary.item_count, ORG_KEYS.length);
  assert.equal(summary.mode, "xero-snapshot");
  assert.ok(io.store.has(`staged:${summary.batch_id}`));
  assert.equal(io.onedriveDeliveries.length, 1);
  assert.equal(io.gatesOpened.length, 1);
  assert.equal(io.statusLines.length, 1);
  const persisted = io.store.get("STATE");
  for (const org of ORG_KEYS) assert.ok(persisted.last_snapshot[org], `${org} should have a persisted snapshot`);
});

test("runSweep --dry-run computes the batch but writes nothing anywhere", async () => {
  const io = mockIo();
  const summary = await runSweep({ nowIso: NOW, dryRun: true, ...io });
  assert.equal(summary.dryRun, true);
  assert.equal(summary.staged, false);
  assert.ok(summary.batch, "dry-run still reports what WOULD be staged");
  assert.equal(summary.batch.item_count, ORG_KEYS.length);
  assert.equal(io.store.size, 0, "cfo-store must not be touched by a dry run");
  assert.equal(io.onedriveDeliveries.length, 0);
  assert.equal(io.gatesOpened.length, 0);
  assert.equal(io.statusLines.length, 0);
});

test("runSweep: running twice back to back only stages once (nothing is due yet on the second run)", async () => {
  const io = mockIo();
  const first = await runSweep({ nowIso: NOW, ...io });
  assert.equal(first.staged, true);
  const second = await runSweep({ nowIso: NOW, ...io });
  assert.equal(second.staged, false);
  assert.equal(second.reason, "nothing due: no stale snapshots and no pending manifest items");
  assert.equal(io.onedriveDeliveries.length, 1, "a second immediate run must not deliver a second time");
});

test("runSweep: a snapshot with unchanged content reports UNCHANGED; a genuinely different one reports CHANGED", async () => {
  const laterButStillFresh = (h) => new Date(Date.parse(NOW) + h * 3600 * 1000).toISOString();
  const sameResponse = { Reports: [{ ReportID: "TrialBalance", value: 1 }] };
  const changedResponse = { Reports: [{ ReportID: "TrialBalance", value: 2 }] };

  const io = mockIo({ xeroResponses: { "xero_report|otchealth|TrialBalance": sameResponse } });
  await runSweep({ nowIso: NOW, orgs: ["otchealth"], ...io });

  // Run again after the 20h staleness window with the SAME data -> UNCHANGED.
  const t2 = laterButStillFresh(DEFAULT_STALE_HOURS + 1);
  const run2 = await runSweep({ nowIso: t2, orgs: ["otchealth"], ...io });
  assert.equal(run2.staged, true);
  const batch2 = io.store.get(`staged:${run2.batch_id}`);
  assert.equal(batch2.items[0].verdict, "UNCHANGED");

  // Run a third time, past staleness again, with DIFFERENT data -> CHANGED.
  io.xeroCall = async (bearer, name, args) => {
    io.xeroCalls.push({ name, args });
    if (name === "xero_report" && args.report === "TrialBalance") return changedResponse;
    return {};
  };
  const t3 = laterButStillFresh(2 * (DEFAULT_STALE_HOURS + 1));
  const run3 = await runSweep({ nowIso: t3, orgs: ["otchealth"], ...io });
  const batch3 = io.store.get(`staged:${run3.batch_id}`);
  assert.equal(batch3.items[0].verdict, "CHANGED");
});

test("runSweep: an org whose Xero call errors is reported ERROR and is NOT marked snapshotted (retried next run)", async () => {
  const io = mockIo();
  io.xeroCall = async (bearer, name, args) => {
    if (args.org === "innd") throw new Error("simulated Xero timeout");
    return {};
  };
  const summary = await runSweep({ nowIso: NOW, ...io });
  const batch = io.store.get(`staged:${summary.batch_id}`);
  const inndItem = batch.items.find((i) => i.org === "innd");
  assert.equal(inndItem.verdict, "ERROR");
  const persisted = io.store.get("STATE");
  assert.ok(!persisted.last_snapshot.innd, "a failed org must not be recorded as snapshotted");
  assert.ok(persisted.last_snapshot.otchealth, "orgs that succeeded must still be recorded");
});

test("runSweep: manifest-drain is bounded by --batch-size and marks only the drained items staged", async () => {
  const manifests = {
    otchealth: [
      { id: "m1", kind: "attachment-check", endpoint: "Invoices", guid: "g1", expectedDoc: "doc1.pdf", status: "pending" },
      { id: "m2", kind: "attachment-check", endpoint: "Invoices", guid: "g2", expectedDoc: "doc2.pdf", status: "pending" },
      { id: "m3", kind: "attachment-check", endpoint: "Invoices", guid: "g3", expectedDoc: "doc3.pdf", status: "pending" },
    ],
  };
  const io = mockIo({ manifests, initialState: freshSnapshotState(NOW), xeroResponses: { "xero_attachments|otchealth|Invoices": { Attachments: [{ FileName: "a.pdf" }] } } });
  const summary = await runSweep({ nowIso: NOW, batchSize: 2, ...io });
  // Every entity already has a fresh snapshot (see freshSnapshotState), so kind A contributes
  // nothing this run and this is a clean, isolated test of kind B's batch-size bounding.
  assert.equal(summary.item_count, 2, "only batchSize items should be processed this run");
  const staged = io.manifestStore.otchealth.filter((i) => i.status === "staged");
  const pending = io.manifestStore.otchealth.filter((i) => i.status === "pending");
  assert.equal(staged.length, 2);
  assert.equal(pending.length, 1);
});

test("runSweep: an explicitly empty --orgs list processes zero entities (kind A and kind B both scoped)", async () => {
  const manifests = { otchealth: [{ id: "m1", kind: "attachment-check", endpoint: "Invoices", guid: "g1", status: "pending" }] };
  const io = mockIo({ manifests });
  const summary = await runSweep({ nowIso: NOW, orgs: [], ...io });
  assert.equal(summary.staged, false);
  assert.equal(io.xeroCalls.length, 0, "an empty --orgs must reach zero entities, not silently fall back to all of them");
});

test("runSweep: manifest attachment-check verdicts (MATCHED and MISSING_SOURCE_DOC)", async () => {
  const manifests = {
    otchealth: [
      { id: "m1", kind: "attachment-check", endpoint: "Invoices", guid: "g1", expectedDoc: "doc1.pdf", status: "pending" },
      { id: "m2", kind: "attachment-check", endpoint: "Invoices", guid: "g2", expectedDoc: "doc2.pdf", status: "pending" },
    ],
  };
  const io = mockIo({
    manifests,
    initialState: freshSnapshotState(NOW),
    xeroResponses: { "xero_attachments|otchealth|Invoices": { Attachments: [{ FileName: "a.pdf" }] } },
    sourceDocExists: async (name) => name === "doc1.pdf", // doc2.pdf "missing" from the data room
  });
  const summary = await runSweep({ nowIso: NOW, batchSize: 10, ...io });
  const batch = io.store.get(`staged:${summary.batch_id}`);
  const byId = Object.fromEntries(batch.items.map((i) => [i.id, i.verdict]));
  assert.equal(byId.m1, "MATCHED");
  assert.equal(byId.m2, "MISSING_SOURCE_DOC");
});

test("runSweep: only ever calls xeroCall with allowlisted tool names", async () => {
  const manifests = { otchealth: [{ id: "m1", kind: "attachment-check", endpoint: "Invoices", guid: "g1", status: "pending" }] };
  const io = mockIo({ manifests });
  await runSweep({ nowIso: NOW, ...io });
  assert.ok(io.xeroCalls.length > 0, "sanity: some Xero calls should have happened");
  for (const call of io.xeroCalls) assert.ok(isReadOnlyXeroTool(call.name), `disallowed tool called: ${call.name}`);
});

test("runSweep: if the authoritative store write fails, state and manifest are NOT advanced (resumable, not silently lost)", async () => {
  const manifests = { otchealth: [{ id: "m1", kind: "attachment-check", endpoint: "Invoices", guid: "g1", status: "pending" }] };
  const io = mockIo({ manifests, putStagedBatch: async () => { throw new Error("simulated store outage"); } });
  await assert.rejects(() => runSweep({ nowIso: NOW, ...io }));
  assert.equal(io.putStateCalls.length, 0, "the cursor must not advance if the batch write failed");
  assert.equal(io.putManifestCalls.length, 0, "manifest items must not be marked staged if the batch write failed");
  assert.equal(io.gatesOpened.length, 0);
  assert.equal(io.statusLines.length, 0);
});

test("runSweep: a OneDrive delivery failure is best-effort and does not fail the whole run", async () => {
  const io = mockIo({ deliverToOneDrive: async () => { throw new Error("simulated Graph outage"); } });
  const summary = await runSweep({ nowIso: NOW, ...io });
  assert.equal(summary.staged, true, "the authoritative cfo-store write still succeeds and the run still reports staged");
  assert.equal(summary.onedrive.ok, false);
  assert.match(summary.onedrive.error, /simulated Graph outage/);
});

test("runSweep: an INND or HearingAssist item flags the review gate innd:true", async () => {
  const io = mockIo();
  const summary = await runSweep({ nowIso: NOW, orgs: ["innd", "otchealth"], ...io });
  assert.equal(summary.staged, true);
  assert.equal(io.gatesOpened[0].innd, true);
});

test("runSweep: an INND-free batch does not flag the review gate innd", async () => {
  const io = mockIo();
  const summary = await runSweep({ nowIso: NOW, orgs: ["otchealth", "personal"], ...io });
  assert.equal(summary.staged, true);
  assert.equal(io.gatesOpened[0].innd, false);
});
