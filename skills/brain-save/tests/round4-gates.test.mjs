// Adjudication round 4 (2026-09-29): ring / security findings B1, S3, S4, N1 for brain-save. Every test here
// fails on the round-3 code (see the run recorded in the commit message). All against the in-memory fake
// backend or pure functions: no S3, OpenSearch, SSM or gateway.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BS from "../brain-save.mjs";
import * as PROV from "../lib/provenance.mjs";
import { prepareDoc } from "../lib/pipeline.mjs";
import { scanLayerB, scanParts } from "../lib/secret-gate.mjs";
import { declaredSignals, classifyRing } from "../lib/ring-gate.mjs";
import { buildHeader, buildObject, registryKey, keyRefFor } from "../lib/provenance.mjs";
import { _resetShapeCacheForTests } from "../lib/push.mjs";
import { createFakeBackend } from "./fake-backend.mjs";

const { main, runAudit } = BS;
// The round-3 code has no parseTarget / parseKnowledgeKey export: those two tests must FAIL there, not the whole file.
const parseTarget = (...a) => { if (typeof BS.parseTarget !== "function") throw new Error("parseTarget does not exist on the round-3 code"); return BS.parseTarget(...a); };
const parseKnowledgeKey = (...a) => { if (typeof PROV.parseKnowledgeKey !== "function") throw new Error("parseKnowledgeKey does not exist on the round-3 code"); return PROV.parseKnowledgeKey(...a); };

process.env.BRAIN_SAVE_VERIFY_DELAY_MS = "0";
beforeEach(() => { process.env.BRAIN_SAVE_STATE_DIR = mkdtempSync(join(tmpdir(), "bs4-state-")); process.env.KB_AGENT = "cto"; _resetShapeCacheForTests(); });

const KEY = "_KNOWLEDGE/research/fleet/2026-09-29-widget-planning-notes-abcd1234.md";
function storedObject(body, over = {}) {
  const h = buildHeader({ brain_id: "KN-RES-1234567890", version: "1", title: "Widget planning notes", kind: "research", app: "fleet", source: "", artifact_url: "", author_agent: "cto", session: "", doc_date: "2026-09-29", saved_at: "2026-09-29T00:00:00Z", content_sha256: "a".repeat(64), key_ref: keyRefFor(KEY), supersedes: "", ring: "commons", ring_warnings: "", ring_override: "", tags: "", saved_by: "brain-save 1", ...over });
  return buildObject(h, body);
}
const quiet = () => ({ out() {} });

// ---------------- B1: audit --repair never repairs a gated object ----------------
test("B1: audit --repair on a ring-banner + SSN object with 0 chunks makes ZERO embed calls and ZERO pushes, and reports it blocked", async () => {
  const be = createFakeBackend();
  be.s3.set(KEY, { text: storedObject("ATTORNEY-CLIENT PRIVILEGED\n\nPatient SSN: 512-34-6789 must never be here. Plenty of widget text follows.\n"), etag: '"e1"' });
  const out = [];
  const res = await runAudit(be, { needles: [], secrets: true, ring: true, searchable: true, repair: true }, { out: (s) => out.push(s) });
  assert.equal(be.calls.embed, 0, "no embedding call: the object was never sent to the OpenAI processor");
  assert.equal(be.calls.pushDocs, 0, "nothing pushed into the open room");
  assert.equal(be.room.size, 0);
  assert.ok(res.findings.some((f) => f.kind === "ring"), JSON.stringify(res.findings));
  assert.ok(res.findings.some((f) => f.kind === "dark" && /repair BLOCKED/.test(f.detail)), "the dark finding is reported as blocked, not repaired");
  assert.ok(!out.some((l) => /repaired/.test(l)));
});

test("B1: `--searchable --repair` alone still runs BOTH content gates (repair implies them)", async () => {
  const be = createFakeBackend();
  be.s3.set(KEY, { text: storedObject("ATTORNEY-CLIENT PRIVILEGED\n\nPatient SSN: 512-34-6789. Plenty of widget text follows.\n"), etag: '"e1"' });
  const res = await runAudit(be, { needles: [], secrets: false, ring: false, searchable: true, repair: true }, quiet());
  assert.equal(be.calls.pushDocs, 0);
  assert.ok(res.findings.some((f) => f.kind === "ring"));
});

test("B1: a SECRET-bearing dark object is not repaired either (needle match in the object)", async () => {
  const be = createFakeBackend();
  const secret = "Zq8Kd93LmNpQr7Xy2vWb5T-live-secret";
  be.s3.set(KEY, { text: storedObject(`Deployment notes about widgets. Token value: ${secret}. More text here.\n`), etag: '"e1"' });
  const res = await runAudit(be, { needles: [{ name: "/otchealth/widget-token", needle: secret }], secrets: true, ring: true, searchable: true, repair: true }, quiet());
  assert.equal(be.calls.embed, 0);
  assert.equal(be.calls.pushDocs, 0);
  assert.ok(res.findings.some((f) => f.kind === "secret"));
  assert.ok(res.findings.some((f) => f.kind === "dark" && /BLOCKED/.test(f.detail)));
});

test("B1: a CLEAN dark object is still repaired (the block is per-object, not a global switch)", async () => {
  const be = createFakeBackend();
  be.s3.set(KEY, { text: storedObject("Ordinary widget sprocket engineering notes with nothing sensitive in them at all.\n"), etag: '"e1"' });
  const res = await runAudit(be, { needles: [], secrets: true, ring: true, searchable: true, repair: true }, quiet());
  assert.ok(be.calls.pushDocs >= 1);
  assert.equal(res.findings.filter((f) => f.kind === "dark").length, 0, JSON.stringify(res.findings));
});

test("B1: a live-missing object whose ARCHIVED copy is gated is not restored", async () => {
  const be = createFakeBackend();
  const key = KEY;
  be.s3.set(`_ARCHIVE/${key}`, { text: storedObject("ATTORNEY-CLIENT PRIVILEGED\n\nPatient SSN: 512-34-6789. widget text.\n"), etag: '"e1"' });
  be.s3.set(registryKey("KN-RES-1234567890"), { text: JSON.stringify({ brain_id: "KN-RES-1234567890", live_key: key, status: "live", versions: [{ version: 1, key, status: "live" }] }), etag: '"e2"' });
  const res = await runAudit(be, { needles: [], secrets: true, ring: true, searchable: true, repair: true }, quiet());
  assert.equal(be.s3.has(key), false, "the gated archive copy was NOT written back under _KNOWLEDGE/");
  assert.ok(res.findings.some((f) => f.kind === "live-missing" && /BLOCKED/.test(f.detail)), JSON.stringify(res.findings));
});

// ---------------- S3: declared ring / classification / audience is an ALLOWlist ----------------
test("S3: ring: exec, sensitivity: high and audience: cfo only refuse; ring: commons passes", () => {
  for (const [k, v] of [["ring", "exec"], ["sensitivity", "high"], ["audience", "cfo only"], ["classification", "board only"], ["confidentiality", "confidential"], ["privilege", "counsel"]]) {
    assert.equal(declaredSignals({ [k]: v }).length, 1, `${k}: ${v}`);
    assert.equal(classifyRing({ text: "x", frontmatter: { [k]: v } }).allowed, false, `${k}: ${v}`);
  }
  for (const [k, v] of [["ring", "commons"], ["ring", "public"], ["ring", "internal"], ["ring", "none"], ["ring", "fleet"], ["audience", "engineering"], ["audience", "https://api.example.com/v1"], ["ring", "non-phi"], ["classification", ["public", "internal"]]]) {
    assert.equal(declaredSignals({ [k]: v }).length, 0, `${k}: ${v}`);
  }
});

test("S3: the same declarations refuse through prepareDoc (front matter, JSON and HTML meta), audience included", () => {
  const OPTS = { kind: "research", app: "fleet", title: "Declared ring probe about widget sprockets", agent: "cto", ring: "commons" };
  const TEXT = "Ordinary engineering prose about widget sprockets and gizmos, long enough to count as text.\n";
  const prep = (ext, text) => prepareDoc({ localPath: "", displayPath: `probe${ext}`, bytes: Buffer.from(text), ext }, OPTS, { needles: [] });
  const refuses = (fn) => { try { fn(); return false; } catch (e) { return e.exit === 2; } };
  assert.ok(refuses(() => prep(".md", `---\nring: exec\n---\n${TEXT}`)));
  assert.ok(refuses(() => prep(".md", `---\nsensitivity: high\n---\n${TEXT}`)));
  assert.ok(refuses(() => prep(".md", `---\naudience: cfo only\n---\n${TEXT}`)));
  assert.ok(refuses(() => prep(".json", JSON.stringify({ meta: { audience: "cfo only" }, notes: TEXT }))));
  assert.ok(refuses(() => prep(".html", `<html><head><title>Declared ring probe about widget sprockets</title><meta name="audience" content="cfo only"></head><body><p>${TEXT}</p></body></html>`)));
  assert.doesNotThrow(() => prep(".md", `---\nring: commons\n---\n${TEXT}`));
  assert.doesNotThrow(() => prep(".json", JSON.stringify({ audience: "https://api.example.com", notes: TEXT })), "an OAuth/JWT audience URL is not a ring");
});

// ---------------- S4: encoded secrets ----------------
test("S4: base64 (standard and url-safe, all 3 byte alignments) and hex (either case) encodings of a needle are found", () => {
  const secret = "Zq8+/Kd93LmNpQr7Xy2vWb5T-live";
  const needles = [{ name: "/otchealth/widget-key", needle: secret }];
  let n = 0;
  for (const pre of ["", "a", "ab", "abc", "abcd", "abcde"]) for (const post of ["", "z", "zz", "zzz"]) for (const urlSafe of [false, true]) {
    let enc = Buffer.from(pre + secret + post).toString("base64");
    if (urlSafe) enc = enc.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const hits = scanLayerB(`config blob: ${enc} end`, needles);
    assert.equal(hits.length, 1, `pre=${JSON.stringify(pre)} post=${JSON.stringify(post)} urlSafe=${urlSafe}`);
    assert.equal(hits[0].name, "/otchealth/widget-key");
    assert.ok(!JSON.stringify(hits).includes(secret), "a hit never carries the value");
    n++;
  }
  assert.equal(n, 48);
  const hex = Buffer.from(secret).toString("hex");
  assert.equal(scanLayerB(`dump ${hex}`, needles).length, 1);
  assert.equal(scanLayerB(`dump ${hex.toUpperCase()}`, needles).length, 1);
  assert.equal(scanParts({ body: `wrapped ${Buffer.from(secret).toString("base64").slice(0, 12)}\n${Buffer.from(secret).toString("base64").slice(12)}` }, needles).length, 1, "a line-wrapped base64 blob");
  assert.equal(scanLayerB("nothing here, ordinary prose about widgets and sprockets, aGVsbG8gd29ybGQ=", needles).length, 0, "no false positive on unrelated base64");
});

test("S4: a base64-encoded secret is refused at put (raw, body and object views)", async () => {
  const secret = "Xr7Kq2LmNp9Vb4TzWy6Dc3Hs";
  const be = createFakeBackend();
  const f = join(mkdtempSync(join(tmpdir(), "bs4-doc-")), "cfg.md");
  writeFileSync(f, `# Widget deployment configuration notes\n\nThe deploy blob is ${Buffer.from(`user:${secret}`).toString("base64")} and nothing else of interest.\n`);
  const out = []; const err = [];
  const code = await main(["put", f, "--kind", "doc", "--app", "fleet", "--agent", "cto", "--json"], { backend: be, needles: [{ name: "/otchealth/deploy-secret", needle: secret }], now: new Date("2026-09-29T01:00:00Z") }, { stdout: (s) => out.push(s), stderr: (s) => err.push(s) });
  assert.equal(code, 2, out.join("\n"));
  assert.equal(be.s3.size + be.calls.embed, 0);
});

// ---------------- N1: --supersedes / retract / audit --keys validate keys ----------------
test("N1: --supersedes and retract reject `..` and non-matching key shapes (exit 1, nothing read or written)", async () => {
  const bad = ["_KNOWLEDGE/../_MEMORY/cfo.md", "_KNOWLEDGE/research/fleet/../../x-abcd1234.md", "_KNOWLEDGE/research/fleet/notes.md", "_KNOWLEDGE//research/fleet/2026-09-29-x-abcd1234.md", "_KNOWLEDGE/nokind/fleet/2026-09-29-x-abcd1234.md", "not-a-brain-id", "KN-RES-xyz"];
  for (const t of bad) {
    assert.throws(() => parseTarget(t, "retract"), (e) => e.exit === 1, t);
    assert.equal(parseKnowledgeKey(t), null, t);
  }
  assert.deepEqual(parseTarget(KEY, "retract"), { key: KEY });
  assert.deepEqual(parseTarget("KN-RES-1234567890", "retract"), { brainId: "KN-RES-1234567890" });
  // through the CLI
  const be = createFakeBackend();
  const run = async (argv) => { const out = []; const err = []; const code = await main(argv, { backend: be, needles: [], now: new Date("2026-09-29T01:00:00Z") }, { stdout: (s) => out.push(s), stderr: (s) => err.push(s) }); return { code, text: out.join("\n") + err.join("\n") }; };
  let r = await run(["retract", "_KNOWLEDGE/../_MEMORY/cfo.md", "--reason", "test"]);
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /not a valid stored key/);
  assert.equal(be.calls.get + be.calls.del + be.calls.put, 0, "nothing was read or written");
  r = await run(["audit", "--keys", "_KNOWLEDGE/../_MEMORY/cfo.md", "--repair"]);
  assert.equal(r.code, 1, r.text);
  assert.equal(be.calls.get + be.calls.pushDocs, 0);
  const f = join(mkdtempSync(join(tmpdir(), "bs4-doc-")), "n.md");
  writeFileSync(f, "# Widget supersede probe notes\n\nOrdinary widget sprocket text about nothing sensitive at all.\n");
  r = await run(["put", f, "--kind", "doc", "--app", "fleet", "--agent", "cto", "--supersedes", "_KNOWLEDGE/../_MEMORY/cfo.md", "--json"]);
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /not a valid stored key/);
  assert.equal(be.room.size, 0);
});

test("N1: a well-formed stored key still works as a --supersedes / retract target", async () => {
  const be = createFakeBackend();
  const f = join(mkdtempSync(join(tmpdir(), "bs4-doc-")), "n.md");
  writeFileSync(f, "# Widget supersede happy path notes\n\nOrdinary widget sprocket text about nothing sensitive at all.\n");
  const out = []; const err = [];
  const run = async (argv) => { out.length = 0; return main(argv, { backend: be, needles: [], now: new Date("2026-09-29T01:00:00Z") }, { stdout: (s) => out.push(s), stderr: (s) => err.push(s) }); };
  assert.equal(await run(["put", f, "--kind", "doc", "--app", "fleet", "--agent", "cto", "--json"]), 0, out.join("\n"));
  const { key } = JSON.parse(out[0]);
  assert.equal(await run(["retract", key, "--reason", "test retraction"]), 0, out.join("\n") + err.join("\n"));
});
