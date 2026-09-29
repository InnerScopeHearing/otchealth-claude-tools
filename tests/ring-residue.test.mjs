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
import { SKIP_PREFIXES, RING_PRIVATE_PREFIXES, isSkippedPath, unscopedPushRefusal, selectPushRows } from "../skills/doc-indexer/push-rules.mjs";
import { assessRingResidue, pageExitCode, ANOMALY_STATUSES, RING_RESIDUE_ROOM } from "../skills/aws-dr-canary/canary.mjs";
import { purgePrefixes, prefixQuery, ROOM, ROOM_PATH_PREFIX } from "../skills/doc-indexer/purge-ring-residue.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

test("every ring-private prefix is a SKIP_PREFIX; ALL of _JOURNAL/ and _VAULT/ are never-push (round 4: no per-lane list)", () => {
  for (const p of RING_PRIVATE_PREFIXES) assert.ok(SKIP_PREFIXES.includes(p), p);
  assert.deepEqual([...RING_PRIVATE_PREFIXES].sort(), ["_DISPATCH/", "_HANDOFF/", "_JOURNAL/", "_MEMORY/", "_VAULT/"]);
  for (const lane of ["cfo", "clo", "clo-personal", "exec", "capital", "cto", "coo", "developer"]) assert.equal(isSkippedPath(`_JOURNAL/${lane}/2026-09-01/_DIGEST.md`), true, lane);
  assert.equal(isSkippedPath("_VAULT/registry.md"), true);
  assert.equal(isSkippedPath("_KNOWLEDGE/research/fleet/x.md"), false);
  assert.deepEqual(selectPushRows([{ path: "_JOURNAL/cfo/a/_DIGEST.md" }, { path: "_JOURNAL/cto/a/_DIGEST.md" }, { path: "_DAILY/2026-09-01.md" }], ["_JOURNAL/", "_DAILY/"]).map((r) => r.path), ["_DAILY/2026-09-01.md"]);
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
  const leak = assessRingResidue([{ prefix: "_MEMORY/", count: 87 }, { prefix: "_HANDOFF/", count: 28 }, { prefix: "_JOURNAL/", count: 17 }, { prefix: "_DISPATCH/", count: 0 }]);
  assert.equal(leak.status, "LEAK");
  assert.match(leak.detail, /132 chunk\(s\).*_MEMORY\/ 87, _HANDOFF\/ 28, _JOURNAL\/ 17/);
  assert.ok(!/_DISPATCH/.test(leak.detail), "zero-count prefixes are not listed as leaks");
  assert.ok(ANOMALY_STATUSES.includes("LEAK"));
  assert.equal(pageExitCode([{ name: "commons-ring-residue", ...leak }], true), 1);
  assert.equal(pageExitCode([{ name: "commons-ring-residue", ...leak }], false), 0, "report-only without --strict");
});

test("purge-ring-residue: the prefix list can only be narrowed, never widened; queries are path.keyword prefixes in the commons room", () => {
  assert.deepEqual(purgePrefixes(null), RING_PRIVATE_PREFIXES.slice());
  assert.deepEqual(purgePrefixes("_MEMORY/,_JOURNAL/"), ["_MEMORY/", "_JOURNAL/"]);
  assert.throws(() => purgePrefixes("_KNOWLEDGE/"), /may only name ring-private prefixes/);
  assert.deepEqual(purgePrefixes("_JOURNAL/"), ["_JOURNAL/"], "the whole journal tree IS ring-private now");
  assert.throws(() => purgePrefixes("_JOURNAL/cto/"), /may only name ring-private prefixes/, "a sub-prefix is not on the reviewed list");
  assert.throws(() => purgePrefixes("_DAILY/"), /may only name ring-private prefixes/);
  assert.equal(ROOM, "commons-company-journal");
  assert.deepEqual(prefixQuery("_MEMORY/"), { prefix: { "path.keyword": { value: `${ROOM_PATH_PREFIX}_MEMORY/`, case_insensitive: true } } });
  assert.equal(ROOM_PATH_PREFIX, "otchealthcommons/company-journal/");
});
