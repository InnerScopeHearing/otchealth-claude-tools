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
// Requires: GITHUB_TOKEN env or the github-user-pat Key Vault secret (same PAT pattern used by
// fleet-search's GitHub search and every other authenticated push this session).
import { kvSecret } from "../kb-memory/azure-secret.mjs";

const OWNER = "InnerScopeHearing";
const REPO = "otchealth-claude-tools";
const PATH = "REGRESSION-LEDGER.md";
const ENTRY_START = /^### \[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z)\] tag:([a-z0-9\-]+) — (.+)$/;

const argv = process.argv.slice(2);
const cmd = argv[0];
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

async function pat() {
  const p = process.env.GITHUB_TOKEN || (await kvSecret("github-user-pat"));
  if (!p) throw new Error("no GitHub token available (GITHUB_TOKEN env or github-user-pat secret)");
  return p;
}
const ghHeaders = (token) => ({ Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json", "X-GitHub-Api-Version": "2022-11-28" });

async function fetchLedger(token) {
  const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}?ref=main`, { headers: ghHeaders(token) });
  if (r.status === 404) return { content: null, sha: null };
  if (!r.ok) throw new Error(`fetch ledger ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return { content: Buffer.from(j.content, "base64").toString("utf8"), sha: j.sha };
}

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

  const putRes = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}`, {
    method: "PUT",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `regression-ledger: ${priorHits.length ? "REGRESSION" : "new"} tag:${tag} — ${bug}`,
      content: Buffer.from(newContent, "utf8").toString("base64"),
      sha: sha || undefined,
      branch: "main",
    }),
  });
  if (!putRes.ok) throw new Error(`push ${putRes.status}: ${(await putRes.text()).slice(0, 300)}`);
  const putJson = await putRes.json();
  const commitSha = putJson.commit?.sha;

  // Verify via an independent read before reporting success -- never trust the push response alone.
  const verifyRes = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/commits?path=${PATH}&per_page=1`, { headers: ghHeaders(token) });
  const verifyJson = verifyRes.ok ? await verifyRes.json() : [];
  const verifiedLanded = verifyJson[0]?.sha === commitSha;

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

(async () => {
  try {
    if (cmd === "add") await cmdAdd();
    else if (cmd === "check") await cmdCheck();
    else if (cmd === "list") await cmdList();
    else { console.error("usage: ledger.mjs add ... | check <tag> | list [--json]"); process.exit(2); }
  } catch (e) { console.error("regression-ledger ERROR: " + e.message); process.exit(1); }
})();
