#!/usr/bin/env node
// continuity-canary.mjs -- the fleet CONTINUITY-DOC FRESHNESS CANARY.
//
// WHAT IT WATCHES: the fleet's load-bearing hand-authored continuity docs (the CTO's CLAUDE.md,
// CTO-KICKOFF-PROMPT.md, CAPABILITY-INDEX.md if present, the claude-tools CLAUDE.md, ... see
// expected-docs.json) are read as ground truth by every agent at session start, but nothing has ever
// asserted they are actually KEPT CURRENT. A doc nobody has touched in weeks, while the underlying
// memory-of-record (kb-memory / company-brain) keeps moving, is silent DRIFT: every session that reads
// it inherits a stale picture of reality with zero warning. This mirrors azure-canary's AGE-not-FLOOR
// lesson (skills/azure-canary/canary.mjs's header tells the otchealth-brain story in full) applied to
// hand-authored docs instead of search indexes or scheduled jobs: a doc's last-commit AGE is the only
// signal that catches "nobody has touched this in a month" the same way a frozen index's age caught
// otchealth-brain sitting dead for ~12 days. (Built 2026-07-21: CTO-KICKOFF-PROMPT.md's own last commit
// touching it was already 32 days old at build time against its 10-day SLO here, a live, real example
// of exactly the drift class this file exists to catch, not a hypothetical.)
//
// REUSE (do not duplicate; see the work order):
//   - The {config-driven registry, --strict non-zero exit, PostHog emit, pure classifier + pure exit-
//     code function, fail-open, never-throw} shape mirrors skills/azure-canary/canary.mjs's
//     assessFreshness()/pageExitCode()/emitPosthog() pattern exactly. Same registry-file convention as
//     setup/expected-indexes.json and setup/expected-streams.json, scoped small and skill-local here
//     (expected-docs.json in this same directory) because continuity docs are added rarely and by hand.
//   - The ledger-drift enrichment shells out to the EXISTING skills/company-brain/brain.mjs
//     `diff "<topic>" --since <date> --json` mode (best-effort, only for docs already flagged STALE)
//     rather than reimplementing memory-of-record walking; see brain.mjs's diffMemory()/renderDiff()/
//     selectLanes() for how that ledger walk and its ring wall actually work.
//
// REPORT-ONLY by default (any anomaly is a ::warning:: + a PostHog event, exit 0); --strict makes any
// anomaly (a STALE doc, a required doc that could not be dated at all, or a required doc that is
// missing) a non-zero exit, mirroring azure-canary's --strict convention so this can gate/page the same
// way in a scheduled workflow. NEVER auto-edits a doc -- it only reports.
//
// Auth: none of its own. The freshness check is local `git log` (no credentials, no network). The
// optional brain.mjs diff enrichment reuses whatever creds brain.mjs itself resolves (Key Vault via the
// shared kb-memory/azure-secret.mjs kvSecret chain); a missing/broken diff path degrades to "enrichment
// unavailable" and is never itself an anomaly. Non-PHI; no secret value is ever read or printed here.
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { kvSecret } from "../kb-memory/azure-secret.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const CONFIG_PATH = join(HERE, "expected-docs.json");
const BRAIN_CLI = join(REPO_ROOT, "skills", "company-brain", "brain.mjs");

const argv = process.argv.slice(2);
// STRICT mirrors azure-canary's convention: default is report-only (safe for manual/local runs);
// --strict (how a scheduled workflow would run it) turns any anomaly into a non-zero exit so the run
// goes red and pages. --report is accepted as an explicit no-op synonym for the default, since the work
// order names it as the default mode rather than requiring a literal flag.
const STRICT = argv.includes("--strict") || process.env.CONTINUITY_CANARY_STRICT === "1";
const JSONOUT = argv.includes("--json");
const NO_DIFF = argv.includes("--no-diff");

function warn(msg) { console.log(`::warning::[continuity-canary] ${msg}`); }

/**
 * PURE freshness verdict for one doc. Mirrors azure-canary's assessFreshness() shape and boundary
 * convention exactly (age <= maxAge is fresh; the boundary itself is NOT stale). lastCommitEpoch ===
 * null/non-finite means "no commit date could be established" (git failed, the path is not tracked, or
 * the caller never found a date) -- classified NO_DATA, never conflated with STALE: a doc we could not
 * even date is a different anomaly than a doc we dated and found unmaintained. Pure, no I/O, unit-tested.
 */
export function assessDocFreshness({ path, lastCommitEpoch, maxAgeDays, nowEpoch }) {
  if (lastCommitEpoch == null || !Number.isFinite(lastCommitEpoch)) {
    return { path, state: "NO_DATA", stale: false, ageDays: null, maxAgeDays };
  }
  const ageDays = (nowEpoch - lastCommitEpoch) / 86_400_000;
  const stale = ageDays > maxAgeDays;
  return { path, state: stale ? "STALE" : "FRESH", stale, ageDays: Math.round(ageDays * 10) / 10, maxAgeDays };
}

/** Exit-code policy (pure, unit-tested, mirrors azure-canary's pageExitCode()): strict mode pages
 * (exit 1) when anomalyCount > 0; default report-only mode never pages regardless of anomalies. */
export function pageExitCode(anomalyCount, strict) { return strict && anomalyCount > 0 ? 1 : 0; }

/** Walk up from `path`'s own directory looking for a `.git` entry, so a doc need not sit at its repo's
 * root. Returns the repo root dir, or null if none is found within `maxUp` levels. Pure filesystem
 * probing, no git invocation yet; kept separate from lastCommitEpoch() so tests could stub it, though
 * the required unit test here targets the pure classifier above, not this I/O helper. */
function findRepoRoot(path, maxUp = 8) {
  let dir = dirname(resolve(path));
  for (let i = 0; i <= maxUp; i++) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Last commit datetime (ms epoch) that touched `path`, via a real `git log -1`, cwd'd to the doc's
 * own repo root. Returns null on ANY failure whatsoever, missing file, path untracked, no repo found,
 * git absent from PATH, permission denied, timeout, never throws. execFileSync with an argv array
 * (never a shell string), so no path is ever concatenated into a shell command. */
function lastCommitEpoch(path) {
  try {
    if (!existsSync(path)) return null;
    const repoRoot = findRepoRoot(path);
    if (!repoRoot) return null;
    const rel = resolve(path).slice(repoRoot.length + 1);
    const out = execFileSync(
      "git",
      ["log", "-1", "--format=%cI", "--", rel],
      { cwd: repoRoot, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (!out) return null; // file exists on disk but has no commit history (untracked / never committed)
    const ms = Date.parse(out);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/** Best-effort ledger-drift enrichment for a STALE doc: shell out to the EXISTING
 * skills/company-brain/brain.mjs `diff` mode (reused, not reimplemented) asking what the shared memory
 * ledger has recorded on this doc's topic since the doc's own last commit. Returns a short rendered
 * summary string, or null on ANY failure (missing creds, network, timeout, brain.mjs not present, bad
 * JSON), never throws, never blocks or fails the rest of the report. Deliberately scoped to STALE docs
 * only (the work order calls this optional/best-effort; running an embedding + LLM round trip for every
 * FRESH doc on every canary tick would be pure cost with no signal). */
function diffEnrichment(doc, lastCommitIso) {
  try {
    if (!existsSync(BRAIN_CLI)) return null;
    const topic = doc.topic || doc.path.split("/").slice(-2).join(" ").replace(/\.md$/i, "");
    const out = execFileSync(
      process.execPath,
      [BRAIN_CLI, "diff", topic, "--since", lastCommitIso, "--json"],
      { encoding: "utf8", timeout: 45_000, stdio: ["ignore", "pipe", "ignore"] },
    );
    const delta = JSON.parse(out);
    const added = delta.added?.length || 0, changed = delta.changed?.length || 0, retired = delta.retired?.length || 0;
    if (!added && !changed && !retired) return "brain ledger shows no recorded change on this topic since the doc's last commit";
    return `brain ledger: ${added} added, ${changed} changed, ${retired} retired fact(s)/decision(s) on this topic since ${lastCommitIso.slice(0, 10)} the doc has likely not absorbed`;
  } catch {
    return null; // best-effort only; a diff failure is never itself a canary anomaly
  }
}

async function emitPosthog(props) {
  try {
    const key = await kvSecret("posthog-fleet-ingest-key");
    const host = process.env.POSTHOG_HOST || "https://us.i.posthog.com";
    if (!key) return;
    await fetch(`${host}/capture/`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: key, event: "continuity_canary", distinct_id: "fleet-continuity-canary", properties: props }),
    });
  } catch { /* emit is best-effort */ }
}

function loadConfig() {
  const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  return parsed.docs || [];
}

async function main() {
  const docs = loadConfig();
  const now = Date.now();
  const results = [];

  for (const doc of docs) {
    const optional = !!doc.optional;
    if (!existsSync(doc.path)) {
      results.push({ path: doc.path, state: optional ? "ABSENT_OPTIONAL" : "ABSENT_REQUIRED", stale: false, ageDays: null, maxAgeDays: doc.max_age_days, optional });
      continue;
    }
    const epoch = lastCommitEpoch(doc.path);
    const v = assessDocFreshness({ path: doc.path, lastCommitEpoch: epoch, maxAgeDays: doc.max_age_days, nowEpoch: now });
    const result = { ...v, optional };
    if (v.state === "STALE" && !NO_DIFF && epoch != null) {
      result.driftNote = diffEnrichment(doc, new Date(epoch).toISOString());
    }
    results.push(result);
  }

  // Anomaly = STALE, NO_DATA (we found the file but could not date it at all), or a REQUIRED doc that
  // is ABSENT. An OPTIONAL doc's absence is informational only, never an anomaly (mirrors azure-canary's
  // "a lane with no creds yet is a SKIP, not an anomaly" convention for probeLane()).
  const anomalies = results.filter((r) => r.state === "STALE" || r.state === "NO_DATA" || r.state === "ABSENT_REQUIRED");
  const summary = {
    ok: anomalies.length === 0,
    docs_total: docs.length,
    docs_fresh: results.filter((r) => r.state === "FRESH").length,
    docs_stale: results.filter((r) => r.state === "STALE").length,
    docs_no_data: results.filter((r) => r.state === "NO_DATA").length,
    docs_absent_required: results.filter((r) => r.state === "ABSENT_REQUIRED").length,
    docs_absent_optional: results.filter((r) => r.state === "ABSENT_OPTIONAL").length,
    anomaly_count: anomalies.length,
    results,
  };
  await emitPosthog(summary);

  if (JSONOUT) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`[continuity-canary] docs ${summary.docs_fresh}/${summary.docs_total} FRESH | stale ${summary.docs_stale} | no-data ${summary.docs_no_data} | missing(required) ${summary.docs_absent_required} | missing(optional) ${summary.docs_absent_optional}`);
    for (const r of results) {
      const age = r.ageDays != null ? ` (${r.ageDays}d/${r.maxAgeDays}d)` : "";
      console.log(`  ${r.state.padEnd(16)} ${r.path}${age}`);
      if (r.driftNote) console.log(`      ${r.driftNote}`);
    }
  }
  for (const r of anomalies) {
    if (r.state === "ABSENT_REQUIRED") warn(`${r.path}: required continuity doc is MISSING`);
    else if (r.state === "NO_DATA") warn(`${r.path}: could not establish a last-commit date (git unavailable, path untracked, or not a repo)`);
    else warn(`${r.path}: STALE (${r.ageDays}d old, SLO ${r.maxAgeDays}d)${r.driftNote ? ` -- ${r.driftNote}` : ""}`);
  }
  console.log(summary.ok ? "[continuity-canary] OK (all continuity docs fresh)" : `[continuity-canary] ANOMALIES: ${anomalies.length} doc(s) stale/missing/undated`);
  if (STRICT && !summary.ok) console.error(`::error::[continuity-canary] STRICT: paging on the above anomalies; a stale or missing continuity doc means agents are reading an out-of-date picture of reality.`);
  process.exit(pageExitCode(anomalies.length, STRICT));
}

// Only run as a script (not when imported by the test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(async (e) => {
    await emitPosthog({ ok: false, fatal: true, error: e.message });
    console.error(`::error::[continuity-canary] FATAL: ${e.message}`);
    process.exit(0); // fail-open even on a fatal error -- never let this canary itself break a caller's gate unexpectedly outside --strict's own anomaly path
  });
}
