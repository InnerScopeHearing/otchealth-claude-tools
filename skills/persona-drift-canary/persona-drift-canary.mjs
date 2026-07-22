#!/usr/bin/env node
// persona-drift-canary.mjs -- the fleet ONE-BRAIN PERSONA DRIFT CANARY.
//
// WHAT IT WATCHES: the "One Brain" persona block (the paragraph starting "You are the OTCHealth AI
// Operating System ..." through the "Voice: ..." sentence that ends it) is hand-copy-pasted, in full,
// into 11+ separate repos' CLAUDE.md files (see expected-repos.json for the registry). It CANNOT
// safely be de-duplicated into a short pointer: each repo's Claude Code session reads its own
// CLAUDE.md directly at session start, and there is no guaranteed mechanism that makes a session
// additionally fetch a separate canonical doc before acting -- a session that never follows a pointer
// would silently lose the persona instructions, a real regression. So each copy stays full-text on
// purpose (see dream-team/ONE-BRAIN-PERSONA.md's "Why this is not a pointer" section), and the actual
// gap this file closes is DRIFT DETECTION: catching when one repo's copy has been hand-edited,
// partially updated, or left behind after a fleet-wide wording change, so the divergence is caught and
// reported instead of silently trusted as ground truth by whatever session reads that repo next.
//
// REUSE (do not duplicate; mirrors skills/continuity-canary/continuity-canary.mjs's exact shape,
// itself mirroring skills/azure-canary/canary.mjs's assessFreshness()/pageExitCode()/emitPosthog()
// pattern): config-driven registry (expected-repos.json, same convention as continuity-canary's
// expected-docs.json and azure-canary's expected-indexes.json/expected-streams.json); a pure
// classifier with no I/O (assessPersonaDrift); a pure exit-code function (pageExitCode, byte-identical
// semantics to continuity-canary's); fail-open everywhere (a single repo read failure degrades that
// repo to NO_DATA, never crashes the run); --report (default, always exits 0) / --strict (any anomaly
// pages, non-zero exit) mirroring azure-canary's and continuity-canary's convention exactly; a
// best-effort PostHog emit via the same kb-memory/azure-secret.mjs kvSecret() chain continuity-canary
// already uses. NEVER auto-edits any repo's CLAUDE.md -- it only reports. This is a detection tool,
// not a remediation tool: reconciling real drifted wording across repos is a separate, deliberate
// review, not something this canary does on its own.
//
// THE CANONICAL TEXT: dream-team/ONE-BRAIN-PERSONA.md, between its PERSONA-BLOCK-START/END markers.
// Both the canonical file and every registered repo's CLAUDE.md are read through the SAME
// extractPersonaBlock() function below, so there is exactly one extraction rule in the codebase (no
// second hard-coded copy of the persona text anywhere that could itself drift out of sync with the
// canonical file).
//
// Auth: none of its own. Reading repo files + the canonical file is local fs I/O only, no credentials.
// The optional PostHog emit reuses whatever creds azure-secret.mjs itself resolves (Key Vault via the
// shared kb-memory/azure-secret.mjs kvSecret chain); a missing/broken emit path is never itself an
// anomaly. Non-PHI; no secret value or repo content is ever printed beyond short diff-context snippets
// of the (non-secret, already-fleet-wide) persona prose itself.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { kvSecret } from "../kb-memory/azure-secret.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const CONFIG_PATH = join(HERE, "expected-repos.json");
const CANONICAL_PATH = join(REPO_ROOT, "dream-team", "ONE-BRAIN-PERSONA.md");

const argv = process.argv.slice(2);
// STRICT/--report mirror continuity-canary's convention exactly: default is report-only (safe for
// manual/local runs); --strict (how a scheduled workflow would run it) turns any anomaly into a
// non-zero exit so the run goes red and pages. --report is accepted as an explicit no-op synonym for
// the default.
const STRICT = argv.includes("--strict") || process.env.PERSONA_DRIFT_CANARY_STRICT === "1";
const JSONOUT = argv.includes("--json");

function warn(msg) { console.log(`::warning::[persona-drift-canary] ${msg}`); }

const START_MARKER = "You are the OTCHealth AI Operating System";
const END_LINE_PREFIX = "Voice:";
const SEARCH_WINDOW_LINES = 60; // bounded lookahead from the start marker to the Voice: line, so a
                                  // missing end marker fails fast (returns null) instead of scanning
                                  // an entire large CLAUDE.md.

/**
 * PURE extraction of the persona block from a full CLAUDE.md (or the canonical doc) text. Finds the
 * line containing the start marker, then the next line (within SEARCH_WINDOW_LINES) that starts with
 * "Voice:", and returns everything from the start line through that Voice line, inclusive, joined with
 * "\n". Returns null if either marker is not found -- a repo whose copy has been fully removed, or a
 * canonical file whose markers are broken, is a distinct, explicit anomaly (ABSENT / a fatal canonical
 * read failure), never silently treated as "no drift". No I/O; pure string processing; unit-tested.
 */
export function extractPersonaBlock(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  const lines = text.split("\n");
  const startIdx = lines.findIndex((l) => l.includes(START_MARKER));
  if (startIdx === -1) return null;
  const scanEnd = Math.min(lines.length, startIdx + SEARCH_WINDOW_LINES);
  let endIdx = -1;
  for (let i = startIdx; i < scanEnd; i++) {
    if (lines[i].trimStart().startsWith(END_LINE_PREFIX)) { endIdx = i; break; }
  }
  if (endIdx === -1) return null;
  return lines.slice(startIdx, endIdx + 1).join("\n");
}

/**
 * PURE normalization: collapses all whitespace (spaces, tabs, newlines, blank-line paragraph breaks)
 * into single spaces and trims. This is the "only trivially whitespace-different" tolerance the work
 * order calls for -- a repo whose copy is reflowed onto different line lengths, has an extra trailing
 * blank line, or uses CRLF is NOT flagged as drifted; any actual wording/punctuation/content difference
 * still is, because the flattened word sequence itself would differ. Pure, no I/O, unit-tested.
 */
export function normalizeBlock(block) {
  if (block == null) return "";
  return block.replace(/\s+/g, " ").trim();
}

/**
 * PURE first-divergence finder for reporting: given two normalized flat strings, returns the character
 * index of the first mismatch plus a short context window around it on each side, or null if the
 * strings are identical. Used only to make a DRIFTED report actionable (show roughly WHERE the two
 * texts diverge) -- never used to decide MATCH vs DRIFTED itself (that is a plain !== on the full
 * normalized strings, so no substring-window edge case can mask a real difference). Pure, unit-tested.
 */
export function firstDivergence(a, b, contextChars = 50) {
  const shorter = Math.min(a.length, b.length);
  let i = 0;
  while (i < shorter && a[i] === b[i]) i++;
  if (i === shorter && a.length === b.length) return null;
  const start = Math.max(0, i - contextChars);
  return {
    index: i,
    canonicalContext: a.slice(start, i + contextChars),
    repoContext: b.slice(start, i + contextChars),
  };
}

/**
 * PURE per-repo drift verdict. Mirrors continuity-canary's assessDocFreshness() shape: takes already-
 * resolved inputs (no I/O inside), returns a state. States:
 *   - NO_DATA: the repo's file could not be read at all (readError set by the caller).
 *   - ABSENT: the file was read fine, but extractPersonaBlock found no persona block in it at all --
 *     distinct from DRIFTED (we have text to compare) and distinct from NO_DATA (we have no text at
 *     all), mirroring continuity-canary's NO_DATA-vs-ABSENT_REQUIRED distinction.
 *   - MATCH: the extracted block, normalized, is identical to the canonical block, normalized.
 *   - DRIFTED: the extracted block exists but normalizes to something different from canonical.
 * Pure, no I/O, unit-tested.
 */
export function assessPersonaDrift({ repoPath, repoRawText, readError, canonicalNormalized }) {
  if (readError) return { repoPath, state: "NO_DATA", drifted: false, reason: readError, block: null };
  const block = extractPersonaBlock(repoRawText);
  if (block == null) return { repoPath, state: "ABSENT", drifted: false, block: null };
  const normalized = normalizeBlock(block);
  const drifted = normalized !== canonicalNormalized;
  return { repoPath, state: drifted ? "DRIFTED" : "MATCH", drifted, block, normalized };
}

/** Exit-code policy (pure, unit-tested, byte-identical semantics to continuity-canary's
 * pageExitCode()): strict mode pages (exit 1) when anomalyCount > 0; default report-only mode never
 * pages regardless of anomalies. */
export function pageExitCode(anomalyCount, strict) { return strict && anomalyCount > 0 ? 1 : 0; }

function safeRead(path) {
  try {
    if (!existsSync(path)) return { text: null, error: "file does not exist" };
    return { text: readFileSync(path, "utf8"), error: null };
  } catch (e) {
    return { text: null, error: e.message };
  }
}

async function emitPosthog(props) {
  try {
    const key = await kvSecret("posthog-fleet-ingest-key");
    const host = process.env.POSTHOG_HOST || "https://us.i.posthog.com";
    if (!key) return;
    await fetch(`${host}/capture/`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: key, event: "persona_drift_canary", distinct_id: "fleet-persona-drift-canary", properties: props }),
    });
  } catch { /* emit is best-effort */ }
}

function loadConfig() {
  const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  return parsed.repos || [];
}

async function main() {
  // Resolve the canonical block first. A canonical file that is missing, unreadable, or whose own
  // markers cannot be found is FATAL for this run (there is nothing to diff against) -- report it and
  // exit 0 (fail-open; --strict still pages via the normal anomaly path below, not a hard crash).
  const canonicalRead = safeRead(CANONICAL_PATH);
  if (canonicalRead.error || !canonicalRead.text) {
    console.error(`::error::[persona-drift-canary] FATAL: could not read canonical doc ${CANONICAL_PATH}: ${canonicalRead.error || "empty file"}`);
    await emitPosthog({ ok: false, fatal: true, error: `canonical doc unreadable: ${canonicalRead.error || "empty"}` });
    process.exit(STRICT ? 1 : 0);
    return;
  }
  const canonicalBlock = extractPersonaBlock(canonicalRead.text);
  if (canonicalBlock == null) {
    console.error(`::error::[persona-drift-canary] FATAL: canonical doc ${CANONICAL_PATH} has no PERSONA block between its own start/Voice: markers.`);
    await emitPosthog({ ok: false, fatal: true, error: "canonical doc markers not found" });
    process.exit(STRICT ? 1 : 0);
    return;
  }
  const canonicalNormalized = normalizeBlock(canonicalBlock);

  const repos = loadConfig();
  const results = [];
  for (const repo of repos) {
    const optional = !!repo.optional;
    const { text, error } = safeRead(repo.path);
    const v = assessPersonaDrift({ repoPath: repo.path, repoRawText: text, readError: error, canonicalNormalized });
    const result = { ...v, name: repo.name || repo.path, optional, note: repo.note };
    if (v.state === "DRIFTED") {
      result.divergence = firstDivergence(canonicalNormalized, v.normalized);
    }
    results.push(result);
  }

  // Anomaly = DRIFTED, ABSENT (a registered repo that no longer carries the block at all -- the block
  // was removed or never landed), or NO_DATA (the file could not even be read). An OPTIONAL repo's
  // ABSENT/NO_DATA is informational only (mirrors continuity-canary's optional-doc convention); no repo
  // in the current registry is marked optional, but the field is honored for future entries.
  const anomalies = results.filter((r) => !r.optional && (r.state === "DRIFTED" || r.state === "ABSENT" || r.state === "NO_DATA"));
  const summary = {
    ok: anomalies.length === 0,
    repos_total: repos.length,
    repos_match: results.filter((r) => r.state === "MATCH").length,
    repos_drifted: results.filter((r) => r.state === "DRIFTED").length,
    repos_absent: results.filter((r) => r.state === "ABSENT").length,
    repos_no_data: results.filter((r) => r.state === "NO_DATA").length,
    anomaly_count: anomalies.length,
    canonical_path: CANONICAL_PATH,
    results: results.map(({ block, ...rest }) => rest), // never print the full block text on every row; keep the summary compact
  };
  await emitPosthog(summary);

  if (JSONOUT) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`[persona-drift-canary] repos ${summary.repos_match}/${summary.repos_total} MATCH | drifted ${summary.repos_drifted} | absent ${summary.repos_absent} | no-data ${summary.repos_no_data}`);
    console.log(`  canonical: ${CANONICAL_PATH}`);
    for (const r of results) {
      console.log(`  ${r.state.padEnd(10)} ${r.name}  (${r.repoPath})`);
      if (r.state === "DRIFTED" && r.divergence) {
        console.log(`      canonical: ...${r.divergence.canonicalContext}...`);
        console.log(`      repo:      ...${r.divergence.repoContext}...`);
      }
      if (r.note) console.log(`      note: ${r.note}`);
    }
  }
  for (const r of anomalies) {
    if (r.state === "NO_DATA") warn(`${r.name}: could not read ${r.repoPath} (${r.reason})`);
    else if (r.state === "ABSENT") warn(`${r.name}: registered repo's CLAUDE.md no longer contains a persona block at all (${r.repoPath})`);
    else warn(`${r.name}: DRIFTED from canonical (${r.repoPath})`);
  }
  console.log(summary.ok ? "[persona-drift-canary] OK (all registered repos MATCH the canonical block)" : `[persona-drift-canary] ANOMALIES: ${anomalies.length} repo(s) drifted/absent/unreadable`);
  if (STRICT && !summary.ok) console.error(`::error::[persona-drift-canary] STRICT: paging on the above anomalies; a drifted persona copy means that repo's sessions read an out-of-sync One Brain persona.`);
  process.exit(pageExitCode(anomalies.length, STRICT));
}

// Only run as a script (not when imported by the test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(async (e) => {
    await emitPosthog({ ok: false, fatal: true, error: e.message });
    console.error(`::error::[persona-drift-canary] FATAL: ${e.message}`);
    process.exit(0); // fail-open even on a fatal error -- never let this canary itself break a caller's gate unexpectedly outside --strict's own anomaly path
  });
}
