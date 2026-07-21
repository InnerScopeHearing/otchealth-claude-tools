#!/usr/bin/env node
// regression-ledger / ledger.mjs — durable, append-only record of every bug found across the fleet:
// root cause, fix commit, and whether that SAME root cause was ever fixed before. Exists to answer
// one question with evidence instead of self-report: "is this a genuinely new finding, or the same
// mistake happening again?" (Matt, direct, 2026-07-12, after catching a real repeat -- the ARM
// pagination bug -- and asking how anyone could tell the difference without doing git archaeology
// on demand.)
//
// DESIGN CHOICE: lives as a git-tracked file (REGRESSION-LEDGER.md in otchealth-claude-tools), not an
// Azure Blob object. Reasons: (1) it naturally cross-references commit SHAs, which is the whole point;
// (2) github__search_code / fleet-search already reach it for free; (3) most importantly, THIS TOOL
// must not repeat bulletin.mjs's exact mistake from earlier today (silently editing a local file and
// printing a message implying a push happened) -- so `add` here ALWAYS writes via the authenticated
// GitHub Contents API directly and VERIFIES via a follow-up commit-list read before reporting success.
// It never touches a local clone's working tree.
//
// Usage:
//   node ledger.mjs add --tag <root-cause-tag> --bug "<one-line>" --root-cause "<why, not just what>"
//        --fix-repo <owner/repo> --fix-commit <sha> --fix-summary "<one-line>" [--verified-by "<how>"]
//   node ledger.mjs check <tag>                 # has this root-cause tag ever appeared before?
//   node ledger.mjs list [--json]                # dump all entries
//
// Auth (2026-07-13): tries the CI job token (GITHUB_TOKEN), then the fleet-bot GitHub App token minted
// from Key Vault (the canonical, always-fresh fleet identity), then the legacy github-user-pat — each
// VALIDATED before use, so a stale GITHUB_TOKEN or an expired PAT falls through instead of 401ing the run
// (the github-user-pat went stale and broke this skill's default auth).
//
// FINDINGS LEDGER (2026-07-21, Wave 1.1): this same tool also tracks AUDIT / RECONCILIATION findings,
// a different record than the bug regressions above (see the FINDINGS LEDGER section further down for
// the full design note), in a sibling git-tracked file, FINDINGS-LEDGER.md, via new
// `finding add|list|close|check` verbs. Reuses the same auth and the same GitHub Contents API write
// plus independent reread verify pattern, generalized into fetchFile/putFile/verifyCommitLanded below
// so both ledgers share one write path instead of duplicating it.
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { kvSecret } from "../kb-memory/azure-secret.mjs";

const OWNER = "InnerScopeHearing";
const REPO = "otchealth-claude-tools";
const PATH = "REGRESSION-LEDGER.md";
const ENTRY_START = /^### \[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z)\] tag:([a-z0-9\-]+) — (.+)$/;

const argv = process.argv.slice(2);
const cmd = argv[0];
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const ghHeaders = (token) => ({ Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json", "X-GitHub-Api-Version": "2022-11-28" });

// Mint a fleet-bot GitHub App installation token from Key Vault creds — the canonical, always-fresh
// fleet GitHub identity. Mirrors skills/github-app/gh-app.mjs; kept self-contained here (that module
// runs its CLI on import, so it cannot be imported). Returns null on any failure.
async function fleetBotToken() {
  try {
    const iss = (await kvSecret("github-app-id")) || (await kvSecret("github-app-client-id"));
    let key = await kvSecret("github-app-private-key");
    const installationId = await kvSecret("github-app-installation-id");
    if (!iss || !key || !installationId) return null;
    if (key.includes("\\n") && !key.includes("\n")) key = key.replace(/\\n/g, "\n"); // tolerate escaped newlines
    const now = Math.floor(Date.now() / 1000);
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const input = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iat: now - 60, exp: now + 540, iss })}`;
    const jwt = `${input}.${crypto.createSign("RSA-SHA256").update(input).sign(key, "base64url")}`;
    const r = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (!r.ok) return null;
    return (await r.json()).token || null;
  } catch { return null; }
}

// A token is only usable if it actually authenticates — /rate_limit is a free, side-effect-free probe.
async function tokenWorks(token) {
  if (!token) return false;
  try { const r = await fetch("https://api.github.com/rate_limit", { headers: ghHeaders(token) }); return r.ok; } catch { return false; }
}

async function pat() {
  const candidates = [
    ["GITHUB_TOKEN env", process.env.GITHUB_TOKEN || null],
    ["fleet-bot App (Key Vault)", await fleetBotToken()],
    ["github-user-pat (legacy)", await kvSecret("github-user-pat")],
  ];
  for (const [, tok] of candidates) {
    if (await tokenWorks(tok)) return tok;
  }
  throw new Error("no working GitHub token (tried GITHUB_TOKEN env, fleet-bot App from Key Vault, github-user-pat)");
}

// Generic GitHub-Contents-API read/write, factored out of the original cmdAdd so the bug ledger and
// the findings ledger below share exactly one write path (same auth, same independent reread verify).
async function fetchFile(token, path) {
  const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}?ref=main`, { headers: ghHeaders(token) });
  if (r.status === 404) return { content: null, sha: null };
  if (!r.ok) throw new Error(`fetch ${path} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return { content: Buffer.from(j.content, "base64").toString("utf8"), sha: j.sha };
}

async function putFile(token, path, newContent, sha, message) {
  const putRes = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`, {
    method: "PUT",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      content: Buffer.from(newContent, "utf8").toString("base64"),
      sha: sha || undefined,
      branch: "main",
    }),
  });
  if (!putRes.ok) throw new Error(`push ${path} ${putRes.status}: ${(await putRes.text()).slice(0, 300)}`);
  const putJson = await putRes.json();
  return { commitSha: putJson.commit?.sha };
}

// Independent reread verify -- never trust the PUT response alone. Same discipline the header
// comment for this whole file describes; both ledgers call this one implementation.
async function verifyCommitLanded(token, path, commitSha) {
  const verifyRes = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/commits?path=${path}&per_page=1`, { headers: ghHeaders(token) });
  const verifyJson = verifyRes.ok ? await verifyRes.json() : [];
  return verifyJson[0]?.sha === commitSha;
}

async function fetchLedger(token) { return fetchFile(token, PATH); }

function parseEntries(content) {
  if (!content) return [];
  const lines = content.split("\n");
  const entries = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(ENTRY_START);
    if (m) { if (cur) entries.push(cur); cur = { ts: m[1], tag: m[2], title: m[3], body: [] }; }
    else if (cur) cur.body.push(line);
  }
  if (cur) entries.push(cur);
  return entries.map((e) => ({ ...e, body: e.body.join("\n").trim() }));
}

const HEADER = `# Regression Ledger

Durable, append-only record of every bug found across the fleet: what it was, its ROOT CAUSE (not
just the symptom), the fix (repo + commit, verified via a real commit-history read, never trusted
from a tool's own stdout), and whether that same root cause has ever been seen before. Built
2026-07-12 after a real repeat (the Azure ARM list-pagination bug, first hit 2026-07-01, hit again
2026-07-12 before being caught and structurally fixed) prompted the direct question: how does anyone
— including the agent itself — tell a genuinely new finding from the same mistake recurring, without
doing git archaeology on demand every time?

**Before closing out any bug fix, run \`node ledger.mjs check <tag>\`** for the root-cause tag you're
about to use. If it returns a prior hit, that is a REGRESSION, not a discovery — say so plainly, don't
report it as new. Add every fix with \`node ledger.mjs add\`, which writes here directly via the
authenticated GitHub API and verifies the commit landed before reporting success — this tool does not
repeat bulletin.mjs's mistake of silently editing a local file only.

`;

function renderEntry({ ts, tag, bug, rootCause, fixRepo, fixCommit, fixSummary, verifiedBy, priorHits }) {
  const priorLine = priorHits && priorHits.length
    ? `\n**REGRESSION — this root-cause tag has fired before:** ${priorHits.map((h) => `[${h.ts}]`).join(", ")}. This is not a new finding; the earlier fix did not hold or did not cover this case.`
    : `\n**First recorded occurrence of this root-cause tag.**`;
  return `### [${ts}] tag:${tag} — ${bug}

- **Root cause:** ${rootCause}
- **Fix:** ${fixRepo}@${fixCommit} — ${fixSummary}
- **Verified:** ${verifiedBy || "not stated"}${priorLine}
`;
}

async function cmdAdd() {
  const tag = val("--tag");
  const bug = val("--bug");
  const rootCause = val("--root-cause");
  const fixRepo = val("--fix-repo");
  const fixCommit = val("--fix-commit");
  const fixSummary = val("--fix-summary");
  const verifiedBy = val("--verified-by", "");
  if (!tag || !bug || !rootCause || !fixRepo || !fixCommit || !fixSummary) {
    console.error("usage: ledger.mjs add --tag <tag> --bug \"...\" --root-cause \"...\" --fix-repo <owner/repo> --fix-commit <sha> --fix-summary \"...\" [--verified-by \"...\"]");
    process.exit(2);
  }
  const token = await pat();
  const { content, sha } = await fetchLedger(token);
  const existing = parseEntries(content);
  const priorHits = existing.filter((e) => e.tag === tag);
  const ts = new Date().toISOString().slice(0, 16) + "Z";
  const entryMd = renderEntry({ ts, tag, bug, rootCause, fixRepo, fixCommit, fixSummary, verifiedBy, priorHits });
  const newContent = (content || HEADER).replace(/\n*$/, "\n\n") + entryMd;

  const { commitSha } = await putFile(token, PATH, newContent, sha, `regression-ledger: ${priorHits.length ? "REGRESSION" : "new"} tag:${tag} — ${bug}`);

  // Verify via an independent read before reporting success -- never trust the push response alone.
  const verifiedLanded = await verifyCommitLanded(token, PATH, commitSha);

  if (priorHits.length) {
    console.log(`[ledger] REGRESSION recorded: tag:${tag} has fired ${priorHits.length + 1} time(s) now (prior: ${priorHits.map((h) => h.ts).join(", ")}).`);
  } else {
    console.log(`[ledger] New entry recorded: tag:${tag}.`);
  }
  console.log(`[ledger] commit ${commitSha} -- independently verified via commit-history read: ${verifiedLanded ? "CONFIRMED" : "NOT CONFIRMED (check manually)"}`);
  if (!verifiedLanded) process.exitCode = 1;
}

async function cmdCheck() {
  const tag = argv[1];
  if (!tag) { console.error("usage: ledger.mjs check <tag>"); process.exit(2); }
  const token = await pat();
  const { content } = await fetchLedger(token);
  const hits = parseEntries(content).filter((e) => e.tag === tag);
  if (!hits.length) { console.log(`[ledger] no prior entries for tag:${tag} -- this looks like a first occurrence.`); return; }
  console.log(`[ledger] tag:${tag} has ${hits.length} prior entr${hits.length === 1 ? "y" : "ies"}:`);
  for (const h of hits) console.log(`  [${h.ts}] ${h.title}`);
  console.log(`\nIf you are about to fix this again, this is a REGRESSION -- say so, and check whether the earlier fix's approach actually holds this time (a memory/habit fix vs a structural code fix).`);
}

async function cmdList() {
  const token = await pat();
  const { content } = await fetchLedger(token);
  const entries = parseEntries(content);
  if (argv.includes("--json")) { console.log(JSON.stringify(entries, null, 2)); return; }
  console.log(`[ledger] ${entries.length} total entries.`);
  for (const e of entries) console.log(`  [${e.ts}] tag:${e.tag} — ${e.title}`);
}

// ============================================================================
// FINDINGS LEDGER (2026-07-21, Wave 1.1)
//
// Extends this same skill to track AUDIT / RECONCILIATION findings, so a finding raised in one
// session cannot silently vanish by the next one, and so any future audit or "PR done" step can
// reconcile against what is still open instead of re-discovering (or re-forgetting) the same gap.
// This is the exact recurrence class the bug ledger above exists for, applied to a different kind
// of record: a finding has a MUTABLE lifecycle (open, then fixed or wontfix), where a regression
// entry above is an immutable historical fact once written. So findings live in their own
// git-tracked file, FINDINGS-LEDGER.md (this same repo), instead of mixed into
// REGRESSION-LEDGER.md's append-only format.
//
// Reuses, unchanged: pat()/ghHeaders()/tokenWorks()/fleetBotToken() (auth), and the generic
// fetchFile()/putFile()/verifyCommitLanded() helpers above (factored out of the original cmdAdd so
// both ledgers share one write path). No new dependency, no new auth scheme, no Cosmos, no second
// storage backend.
//
// Schema: { id, severity: critical|high|medium|low, source_audit_doc, title,
//           status: open|fixed|wontfix, fix_commit, verified_by, opened, closed }
//
// Verbs:
//   node ledger.mjs finding add --severity <critical|high|medium|low> --source-audit-doc "<path>"
//        --title "<one-line>" [--id <id>] [--status open|fixed|wontfix] [--fix-commit <sha>]
//        [--verified-by "<how>"]
//   node ledger.mjs finding list [--status <s>] [--severity <s>] [--source <substring>] [--json]
//   node ledger.mjs finding close <id> [--status fixed|wontfix] [--fix-commit <sha>] [--verified-by "<how>"]
//   node ledger.mjs finding check [<id-or-source-substring>]   # the reconcile gate, see SKILL.md
//
// Fail-open contract: addFinding/closeFinding/reconcileOpenFindings NEVER throw into an importing
// caller -- any validation or network failure resolves to { ok:false, error }, so an audit script or
// hook can call these directly without wrapping every call in its own try/catch.
export const SEVERITIES = new Set(["critical", "high", "medium", "low"]);
export const FINDING_STATUSES = new Set(["open", "fixed", "wontfix"]);
const FINDINGS_PATH = "FINDINGS-LEDGER.md";
// The separator is a pipe, not an em dash, purely so the header line has one unambiguous token
// boundary before the free-text title (the title itself may contain punctuation).
const FINDING_HEADER_RE = /^### finding:([A-Za-z0-9_.\-]+) severity:(critical|high|medium|low) status:(open|fixed|wontfix) \| (.+)$/;
const FINDING_FIELD_RE = {
  source_audit_doc: /^- \*\*Source audit doc:\*\* (.*)$/m,
  fix_commit: /^- \*\*Fix commit:\*\* (.*)$/m,
  verified_by: /^- \*\*Verified by:\*\* (.*)$/m,
  opened: /^- \*\*Opened:\*\* (.*)$/m,
  closed: /^- \*\*Closed:\*\* (.*)$/m,
};

const FINDINGS_HEADER = `# Findings Ledger

Durable, machine readable record of every audit or reconciliation finding raised across the fleet:
its severity, the audit or reconciliation doc it came from, and whether it is still open, fixed, or
accepted as wontfix. Exists so a finding raised in one session cannot quietly vanish by the next one,
and so any future audit or "PR done" step can reconcile against what is still open instead of
re-discovering (or re-forgetting) the same gap.

Extends regression-ledger (REGRESSION-LEDGER.md, same skill, same GitHub Contents API write plus
independent reread verify pattern), kept as a separate file because a finding's status changes over
time (open, then fixed or wontfix), unlike a regression entry, which is an immutable historical
record once written.

**Before reporting an audit clean or a PR done, run \`node ledger.mjs finding check\`** (optionally
scoped to a finding id or a source audit doc substring). Any open critical or high severity finding
means the work is not actually done yet, say so plainly rather than reporting it clean. File a new
finding with \`node ledger.mjs finding add\`, close one with
\`node ledger.mjs finding close <id> --status fixed|wontfix\`.

`;

function assertSeverity(s) {
  if (!SEVERITIES.has(s)) throw new Error(`severity must be one of: ${[...SEVERITIES].join(", ")}`);
}
function assertFindingStatus(s) {
  if (!FINDING_STATUSES.has(s)) throw new Error(`status must be one of: ${[...FINDING_STATUSES].join(", ")}`);
}
function nullIfPlaceholder(v, placeholder) {
  return (!v || v === placeholder) ? null : v;
}
function grabField(bodyText, key) {
  const m = bodyText.match(FINDING_FIELD_RE[key]);
  return m ? m[1].trim() : "";
}
function genFindingId() {
  const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `FND-${ymd}-${crypto.randomBytes(2).toString("hex")}`;
}

// Scan raw markdown for `### finding:...` blocks. Pure, no I/O.
function scanFindingBlocks(content) {
  if (!content) return [];
  const lines = content.split("\n");
  const blocks = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(FINDING_HEADER_RE);
    if (m) { if (cur) blocks.push(cur); cur = { id: m[1], severity: m[2], status: m[3], title: m[4], body: [] }; }
    else if (cur) cur.body.push(line);
  }
  if (cur) blocks.push(cur);
  return blocks;
}
function blockToFinding(block) {
  const bodyText = block.body.join("\n");
  return {
    id: block.id,
    severity: block.severity,
    status: block.status,
    title: block.title,
    source_audit_doc: grabField(bodyText, "source_audit_doc") || null,
    fix_commit: nullIfPlaceholder(grabField(bodyText, "fix_commit"), "(none yet)"),
    verified_by: nullIfPlaceholder(grabField(bodyText, "verified_by"), "(not verified)"),
    opened: grabField(bodyText, "opened") || null,
    closed: nullIfPlaceholder(grabField(bodyText, "closed"), "(open)"),
  };
}

/** Parse every finding out of FINDINGS-LEDGER.md's content. Pure, no I/O; exported for tests and for
 *  any future caller that wants read-only access to the parsed set without going through the CLI. */
export function parseFindings(content) {
  return scanFindingBlocks(content).map(blockToFinding);
}

/** Render one finding to its canonical markdown block. Pure; the single source of truth for the
 *  on-disk shape, so add and close (an upsert) can never drift into two different formats. */
export function renderFinding(f) {
  const lines = [
    `### finding:${f.id} severity:${f.severity} status:${f.status} | ${f.title}`,
    "",
    `- **Source audit doc:** ${f.source_audit_doc || "(not stated)"}`,
    `- **Fix commit:** ${f.fix_commit || "(none yet)"}`,
    `- **Verified by:** ${f.verified_by || "(not verified)"}`,
    `- **Opened:** ${f.opened || "(unknown)"}`,
    `- **Closed:** ${f.closed || "(open)"}`,
  ];
  return lines.join("\n") + "\n";
}

function splitPreamble(content) {
  if (!content) return { preamble: FINDINGS_HEADER, findings: [] };
  const idx = content.search(/^### finding:/m);
  if (idx === -1) return { preamble: content, findings: [] };
  return { preamble: content.slice(0, idx), findings: parseFindings(content) };
}

/** Insert-or-replace one finding by id and re-render the whole findings section deterministically
 *  (rather than line-splicing in place), so the on-disk file can never end up with two blocks
 *  sharing one id no matter how add/close interleave. Pure; this is what BOTH add (a brand new id)
 *  and close (an existing id, mutated) call. Returns { content, created }. */
export function upsertFinding(content, finding) {
  const { preamble, findings } = splitPreamble(content);
  const idx = findings.findIndex((f) => f.id === finding.id);
  const created = idx === -1;
  const merged = created ? [...findings, finding] : findings.map((f, i) => (i === idx ? finding : f));
  const body = merged.map(renderFinding).join("\n");
  return { content: preamble.replace(/\n*$/, "\n\n") + body, created };
}

/** Filter a parsed findings array by id / source substring (case insensitive) / status / severity.
 *  Pure; backs both `finding list` and the id-or-source lookup `finding check` does. */
export function filterFindings(findings, { id, source, status, severity } = {}) {
  return findings.filter((f) => {
    if (id && f.id !== id) return false;
    if (source && !(f.source_audit_doc || "").toLowerCase().includes(String(source).toLowerCase())) return false;
    if (status && f.status !== status) return false;
    if (severity && f.severity !== severity) return false;
    return true;
  });
}

/** The reconcile summary: how many findings total, how many still open, an open list, and a per
 *  severity tally. `clean` is true only when nothing in the scoped set is open. Pure; this is the
 *  whole of what an audit / "PR done" gate needs to check. */
export function reconcileSummary(findings) {
  const open = findings.filter((f) => f.status === "open");
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of open) bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
  return { total: findings.length, openCount: open.length, open, bySeverity, clean: open.length === 0 };
}

/** File a new finding. Fail-open: never throws into a caller, always resolves to { ok, ... }.
 *  Returns { ok:false, error } on any validation or network failure, { ok:true, finding, commitSha,
 *  verified } once the write has landed AND been independently confirmed via a reread (same
 *  discipline as the bug ledger's add). Exported so a future caller (an audit script, a hook) can
 *  file findings as a side effect without risking its own primary task on this ledger being
 *  reachable. */
export async function addFinding(fields) {
  try {
    assertSeverity(fields.severity);
    const status = fields.status || "open";
    assertFindingStatus(status);
    if (!fields.source_audit_doc) throw new Error("source_audit_doc is required");
    if (!fields.title) throw new Error("title is required");
    const token = await pat();
    const { content, sha } = await fetchFile(token, FINDINGS_PATH);
    const existing = parseFindings(content);
    const id = fields.id || genFindingId();
    if (existing.some((f) => f.id === id)) {
      return { ok: false, error: `finding ${id} already exists, use "finding close" to update it (add refuses to overwrite)` };
    }
    const now = new Date().toISOString();
    const finding = {
      id,
      severity: fields.severity,
      status,
      title: fields.title,
      source_audit_doc: fields.source_audit_doc,
      fix_commit: fields.fix_commit || null,
      verified_by: fields.verified_by || null,
      opened: now,
      closed: status !== "open" ? now : null,
    };
    const { content: newContent } = upsertFinding(content, finding);
    const { commitSha } = await putFile(token, FINDINGS_PATH, newContent, sha, `findings-ledger: add ${id} severity=${finding.severity}: ${finding.title}`);
    const verified = await verifyCommitLanded(token, FINDINGS_PATH, commitSha);
    return { ok: true, finding, commitSha, verified };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Close (fixed or wontfix) an existing finding by id. Fail-open, same contract as addFinding. */
export async function closeFinding(id, fields = {}) {
  try {
    const status = fields.status || "fixed";
    assertFindingStatus(status);
    if (status === "open") throw new Error('status for close must be "fixed" or "wontfix", not "open"');
    const token = await pat();
    const { content, sha } = await fetchFile(token, FINDINGS_PATH);
    const existing = parseFindings(content);
    const found = existing.find((f) => f.id === id);
    if (!found) return { ok: false, error: `finding ${id} not found, run "finding list" to see valid ids` };
    const now = new Date().toISOString();
    const updated = {
      ...found,
      status,
      fix_commit: fields.fix_commit || found.fix_commit,
      verified_by: fields.verified_by || found.verified_by,
      closed: now,
    };
    const { content: newContent } = upsertFinding(content, updated);
    const { commitSha } = await putFile(token, FINDINGS_PATH, newContent, sha, `findings-ledger: ${status} ${id}: ${updated.title}`);
    const verified = await verifyCommitLanded(token, FINDINGS_PATH, commitSha);
    return { ok: true, finding: updated, wasStatus: found.status, commitSha, verified };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** THE RECONCILE GATE: fetch every finding (optionally scoped to one id, or filtered by a source
 *  audit doc substring) and summarize what is still open. Fail-open: on any failure (no working
 *  GitHub token, network down) returns { ok:false, clean:true, ... } rather than throwing or
 *  asserting a false blocking finding -- unreachable is reported plainly (ok:false) so a human is
 *  never told "clean" when the tool actually could not check, while a programmatic caller reading
 *  only `.clean` degrades to non-blocking, matching how the rest of this codebase treats an
 *  unreachable credential store (see kvSecret in azure-secret.mjs). */
export async function reconcileOpenFindings(tagOrSource) {
  try {
    const token = await pat();
    const { content } = await fetchFile(token, FINDINGS_PATH);
    const all = parseFindings(content);
    let scoped = all;
    let scopeLabel = "(all findings)";
    if (tagOrSource) {
      const byId = all.find((f) => f.id === tagOrSource);
      if (byId) { scoped = [byId]; scopeLabel = `id:${tagOrSource}`; }
      else { scoped = filterFindings(all, { source: tagOrSource }); scopeLabel = `source contains "${tagOrSource}"`; }
    }
    return { ok: true, scopeLabel, ...reconcileSummary(scoped) };
  } catch (e) {
    return { ok: false, error: e.message, scopeLabel: tagOrSource || "(all findings)", total: 0, openCount: 0, open: [], bySeverity: {}, clean: true };
  }
}

async function cmdFindingAdd() {
  const severity = val("--severity");
  const source = val("--source-audit-doc");
  const title = val("--title");
  const status = val("--status", "open");
  const idArg = val("--id", "");
  const fixCommit = val("--fix-commit", "");
  const verifiedBy = val("--verified-by", "");
  if (!severity || !source || !title) {
    console.error('usage: ledger.mjs finding add --severity <critical|high|medium|low> --source-audit-doc "<path>" --title "<one-line>" [--id <id>] [--status open|fixed|wontfix] [--fix-commit <sha>] [--verified-by "<how>"]');
    process.exit(2);
  }
  const res = await addFinding({ id: idArg || undefined, severity, source_audit_doc: source, title, status, fix_commit: fixCommit || null, verified_by: verifiedBy || null });
  if (!res.ok) { console.error(`[ledger] finding add ERROR: ${res.error}`); process.exitCode = 1; return; }
  console.log(`[ledger] finding ${res.finding.id} added (severity:${res.finding.severity} status:${res.finding.status}) source:${res.finding.source_audit_doc}`);
  console.log(`[ledger] commit ${res.commitSha} -- independently verified via commit-history read: ${res.verified ? "CONFIRMED" : "NOT CONFIRMED (check manually)"}`);
  if (!res.verified) process.exitCode = 1;
}

async function cmdFindingList() {
  const status = val("--status", "");
  const severity = val("--severity", "");
  const source = val("--source", "");
  const token = await pat();
  const { content } = await fetchFile(token, FINDINGS_PATH);
  const all = parseFindings(content);
  const filtered = filterFindings(all, { status: status || undefined, severity: severity || undefined, source: source || undefined });
  if (argv.includes("--json")) { console.log(JSON.stringify(filtered, null, 2)); return; }
  console.log(`[ledger] ${filtered.length} finding(s)${status ? ` status:${status}` : ""}${severity ? ` severity:${severity}` : ""}${source ? ` source~"${source}"` : ""}.`);
  for (const f of filtered) console.log(`  [${f.status.padEnd(7)}] [${f.severity.padEnd(8)}] ${f.id} : ${f.title} (source: ${f.source_audit_doc || "unstated"})`);
}

async function cmdFindingClose() {
  const id = argv[2];
  const status = val("--status", "fixed");
  const fixCommit = val("--fix-commit", "");
  const verifiedBy = val("--verified-by", "");
  if (!id) { console.error('usage: ledger.mjs finding close <id> [--status fixed|wontfix] [--fix-commit <sha>] [--verified-by "<how>"]'); process.exit(2); }
  const res = await closeFinding(id, { status, fix_commit: fixCommit || null, verified_by: verifiedBy || null });
  if (!res.ok) { console.error(`[ledger] finding close ERROR: ${res.error}`); process.exitCode = 1; return; }
  console.log(`[ledger] finding ${id}: ${res.wasStatus} -> ${res.finding.status}`);
  console.log(`[ledger] commit ${res.commitSha} -- independently verified via commit-history read: ${res.verified ? "CONFIRMED" : "NOT CONFIRMED (check manually)"}`);
  if (!res.verified) process.exitCode = 1;
}

async function cmdFindingCheck() {
  const arg = argv[2];
  const res = await reconcileOpenFindings(arg);
  if (!res.ok) {
    console.log(`[ledger] finding check: COULD NOT VERIFY (${res.error}). Ledger unreachable, fail-open (not treated as blocking).`);
    return;
  }
  console.log(`[ledger] finding check ${res.scopeLabel}: ${res.total} finding(s) total, ${res.openCount} OPEN.`);
  if (res.openCount) {
    for (const f of res.open) console.log(`  OPEN [${f.severity}] ${f.id} : ${f.title} (source: ${f.source_audit_doc || "unstated"})`);
    const blocking = res.open.filter((f) => f.severity === "critical" || f.severity === "high");
    if (blocking.length) {
      console.log(`[ledger] RECONCILE FAILED: ${blocking.length} critical/high finding(s) still open. Do not report this audit or PR clean.`);
      process.exitCode = 1;
    } else {
      console.log(`[ledger] ${res.openCount} open finding(s) remain but none are critical/high (visible backlog, not blocking).`);
    }
  } else {
    console.log(`[ledger] RECONCILE CLEAN: no open findings${res.scopeLabel !== "(all findings)" ? ` for ${res.scopeLabel}` : ""}.`);
  }
}

// Guard the CLI dispatch so importing this file for its exported functions (parseFindings,
// renderFinding, upsertFinding, filterFindings, reconcileSummary, addFinding, closeFinding,
// reconcileOpenFindings -- the finding tests do exactly this) never triggers a CLI run / process.exit.
// Mirrors decision-clock.mjs's isMain guard verbatim; behavior when run directly is unchanged (this
// file is still its own entry point in every existing invocation).
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  (async () => {
    try {
      if (cmd === "add") await cmdAdd();
      else if (cmd === "check") await cmdCheck();
      else if (cmd === "list") await cmdList();
      else if (cmd === "finding") {
        const sub = argv[1];
        if (sub === "add") await cmdFindingAdd();
        else if (sub === "list") await cmdFindingList();
        else if (sub === "close") await cmdFindingClose();
        else if (sub === "check") await cmdFindingCheck();
        else { console.error("usage: ledger.mjs finding add ... | list [...] | close <id> ... | check [id-or-source]"); process.exit(2); }
      } else { console.error("usage: ledger.mjs add ... | check <tag> | list [--json] | finding add|list|close|check ..."); process.exit(2); }
    } catch (e) { console.error("regression-ledger ERROR: " + e.message); process.exit(1); }
  })();
}
