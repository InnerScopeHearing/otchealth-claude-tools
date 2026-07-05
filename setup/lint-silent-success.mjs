#!/usr/bin/env node
// lint-silent-success.mjs — CI/audit check for the exact anti-pattern that caused the kb-journal /
// reflect / memory-librarian / fleet-dispatch outages found 2026-07-05: `process.exit(0)` (SUCCESS)
// sitting immediately after a log line that names a credential/auth failure. A job in this shape
// reports "Succeeded" to every monitor while having silently done nothing — the worst failure mode
// because it's invisible without reading source, not just logs.
//
// This is a deliberately narrow, high-precision grep, not a general linter: it only flags
// exit(0)-after-cred-failure-message, the specific shape that was real and already cost weeks of
// silent data loss. Maps to CWE-390 (Detection of Error Condition Without Action) /
// CWE-252 (Unchecked Return Value) if you want a category name for it.
//
// Usage: node setup/lint-silent-success.mjs [--dir skills] [--json]
// Exit code: 0 if clean, 1 if any hit found (wire into CI to block merges introducing this shape).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const ROOT = val("--dir", "skills");
const JSON_OUT = argv.includes("--json");

const CRED_RE = /no\s+(sa|claude-driver\s+sa|creds?|credentials?|key|secret|account)|missing\s+(sa|creds?|credentials?|key|secret|account)|(sa|creds?|credentials?|key|secret|account)\s+(unavailable|missing)/i;
const EXIT0_RE = /process\.exit\(\s*0\s*\)/;

function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== ".git") yield* walk(p); }
    else if (extname(e.name) === ".mjs" || extname(e.name) === ".js") yield p;
  }
}

const hits = [];
for (const file of walk(ROOT)) {
  let text;
  try { text = readFileSync(file, "utf8"); } catch { continue; }
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // A single line doing both (the common minified-one-liner shape: `if (!X) { console.error("no
    // SA..."); process.exit(0); }`) OR a console.error/log line immediately followed within 2 lines
    // by a bare exit(0) — catches both the one-liner and the multi-line block shape.
    // Suppression: a line tagged `lint-silent-success: ok (<reason>)` on the SAME line or the line
    // directly above is a reviewed, deliberate fail-open (e.g. a genuinely best-effort job where both
    // Azure AND the dead GCP path are checked before exiting 0) — not the silent-outage anti-pattern.
    const lookback = lines.slice(Math.max(0, i - 3), i + 1).join(" ");
    const suppressed = /lint-silent-success:\s*ok/i.test(lookback);
    if (suppressed) continue;
    if (EXIT0_RE.test(line) && CRED_RE.test(line)) {
      hits.push({ file, line: i + 1, text: line.trim().slice(0, 200) });
      continue;
    }
    if (CRED_RE.test(line) && !EXIT0_RE.test(line)) {
      const window = lines.slice(i, i + 3).join(" ");
      if (EXIT0_RE.test(window)) hits.push({ file, line: i + 1, text: line.trim().slice(0, 200) });
    }
  }
}

if (JSON_OUT) { console.log(JSON.stringify(hits, null, 2)); process.exit(hits.length ? 1 : 0); }
if (!hits.length) { console.log(`[lint-silent-success] clean: 0 hits under ${ROOT}/`); process.exit(0); }
console.log(`[lint-silent-success] ${hits.length} hit(s) — process.exit(0) (SUCCESS) next to a credential-failure message. A job in this shape reports "Succeeded" while silently doing nothing.\n`);
for (const h of hits) console.log(`  ${h.file}:${h.line}\n    ${h.text}`);
console.log(`\nFix: exit non-zero (fail loud) or route through requireSecrets()/kvSecretOrThrow() from skills/kb-memory/azure-secret.mjs, UNLESS this is a genuinely best-effort/telemetry job where fail-open is a deliberate, documented choice (in which case add a comment saying so and this line should stay off this list by rewording the log message to avoid the credential-failure phrasing this check keys on).`);
process.exit(1);
