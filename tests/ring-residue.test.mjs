// Adjudication round 2, finding 22 (2026-09-29): ring-private material was live in the OPEN commons room
// (87 _MEMORY/ ledger chunks, 28 _HANDOFF/ chunks incl. cfo/clo/capital, 17 _JOURNAL/cfo/ digests).
// Three durable guards, one test each: (1) the privileged journal lanes are SKIP_PREFIXES and every
// ring-private prefix is skipped; (2) an UNSCOPED commons push-search is refused by indexer.mjs itself
// (not only by nightly.sh); (3) the aws-dr-canary asserts ZERO chunks under every ring-private prefix.
// The purge tool may only narrow the reviewed prefix list, never widen it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SKIP_PREFIXES, RING_PRIVATE_PREFIXES, RING_PRIVATE_JOURNAL_LANES, isSkippedPath, unscopedPushRefusal, selectPushRows } from "../skills/doc-indexer/push-rules.mjs";
import { assessRingResidue, pageExitCode, ANOMALY_STATUSES, RING_RESIDUE_ROOM } from "../skills/aws-dr-canary/canary.mjs";
import { purgePrefixes, prefixQuery, ROOM, ROOM_PATH_PREFIX } from "../skills/doc-indexer/purge-ring-residue.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

test("every ring-private prefix is a SKIP_PREFIX; the privileged journal lanes are included, ordinary lanes are not", () => {
  for (const p of RING_PRIVATE_PREFIXES) assert.ok(SKIP_PREFIXES.includes(p), p);
  for (const p of ["_MEMORY/", "_HANDOFF/", "_DISPATCH/", "_JOURNAL/cfo/", "_JOURNAL/clo/", "_JOURNAL/clo-personal/", "_JOURNAL/exec/", "_JOURNAL/capital/"]) assert.ok(RING_PRIVATE_PREFIXES.includes(p), p);
  assert.deepEqual([...RING_PRIVATE_JOURNAL_LANES].sort(), ["capital", "cfo", "clo", "clo-personal", "exec"]);
  assert.equal(isSkippedPath("_JOURNAL/cfo/2026-09-01/_DIGEST.md"), true);
  assert.equal(isSkippedPath("_JOURNAL/cto/2026-09-01/_DIGEST.md"), false);
  assert.equal(isSkippedPath("_JOURNAL/cfox/x.md"), false, "a lane prefix is a whole segment");
  assert.equal(isSkippedPath("_KNOWLEDGE/research/fleet/x.md"), false);
  assert.deepEqual(selectPushRows([{ path: "_JOURNAL/cfo/a/_DIGEST.md" }, { path: "_JOURNAL/cto/a/_DIGEST.md" }], ["_JOURNAL/"]).map((r) => r.path), ["_JOURNAL/cto/a/_DIGEST.md"]);
});

test("unscopedPushRefusal: the commons profile (or the commons room by --index) must be scoped; other rooms keep the legacy push", () => {
  assert.match(unscopedPushRefusal("commons", null), /UNSCOPED commons push-search/);
  assert.match(unscopedPushRefusal("generic", null, "commons-company-journal"), /UNSCOPED/);
  assert.equal(unscopedPushRefusal("commons", ["_KNOWLEDGE/"]), "");
  assert.equal(unscopedPushRefusal("commons", []), "", "an empty allow-list is allowed and selects NOTHING");
  assert.equal(unscopedPushRefusal("finance", null, "finance-cfo-source-docs"), "");
});

test("indexer.mjs push-search --profile commons with no --prefixes exits 2 before any storage or network work", () => {
  const indexer = join(HERE, "..", "skills", "doc-indexer", "indexer.mjs");
  let code = 0;
  let stderr = "";
  try { execFileSync(process.execPath, [indexer, "push-search", "--profile", "commons", "--s3"], { env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdio: ["ignore", "pipe", "pipe"], timeout: 30000 }); }
  catch (e) { code = e.status; stderr = String(e.stderr || ""); }
  assert.equal(code, 2, stderr);
  assert.match(stderr, /refusing an UNSCOPED commons push-search/);
});

test("aws-dr-canary ring residue: zero chunks is OK; any chunk is a LEAK anomaly that pages under --strict", () => {
  assert.equal(RING_RESIDUE_ROOM.index, "commons-company-journal");
  const ok = assessRingResidue(RING_PRIVATE_PREFIXES.map((prefix) => ({ prefix, count: 0 })));
  assert.equal(ok.status, "OK");
  const leak = assessRingResidue([{ prefix: "_MEMORY/", count: 87 }, { prefix: "_HANDOFF/", count: 28 }, { prefix: "_JOURNAL/cfo/", count: 17 }, { prefix: "_DISPATCH/", count: 0 }]);
  assert.equal(leak.status, "LEAK");
  assert.match(leak.detail, /132 chunk\(s\).*_MEMORY\/ 87, _HANDOFF\/ 28, _JOURNAL\/cfo\/ 17/);
  assert.ok(!/_DISPATCH/.test(leak.detail), "zero-count prefixes are not listed as leaks");
  assert.ok(ANOMALY_STATUSES.includes("LEAK"));
  assert.equal(pageExitCode([{ name: "commons-ring-residue", ...leak }], true), 1);
  assert.equal(pageExitCode([{ name: "commons-ring-residue", ...leak }], false), 0, "report-only without --strict");
});

test("purge-ring-residue: the prefix list can only be narrowed, never widened; queries are path.keyword prefixes in the commons room", () => {
  assert.deepEqual(purgePrefixes(null), RING_PRIVATE_PREFIXES.slice());
  assert.deepEqual(purgePrefixes("_MEMORY/,_JOURNAL/cfo/"), ["_MEMORY/", "_JOURNAL/cfo/"]);
  assert.throws(() => purgePrefixes("_KNOWLEDGE/"), /may only name ring-private prefixes/);
  assert.throws(() => purgePrefixes("_JOURNAL/"), /may only name ring-private prefixes/, "never the whole journal tree");
  assert.equal(ROOM, "commons-company-journal");
  assert.deepEqual(prefixQuery("_MEMORY/"), { prefix: { "path.keyword": `${ROOM_PATH_PREFIX}_MEMORY/` } });
  assert.equal(ROOM_PATH_PREFIX, "otchealthcommons/company-journal/");
});
