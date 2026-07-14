#!/usr/bin/env node
// daily-digest — the company's end-of-day knowledge digest, the closing piece of the fleet
// learning loop. Gathers the day's shipped work (merged PRs across every org repo) + slots for
// decisions/learnings/blockers, and writes a structured Markdown file. Run nightly (23:59); the
// digest is then staged to the commons store and indexed (index -> understand -> push-search) so
// every agent can `cloud-search` what happened + what we learned on any day. The company journals
// itself and the knowledge compounds daily.
//
// FAIL-LOUD (2026-07-14): a FAILED GitHub query (bad/absent App JWT, network) is NOT the same as a
// genuinely quiet day. Before this fix, gh-app.mjs failing ("Missing JWT issuer") made ghGraphql
// return null -> 0 PRs -> the digest wrote "No merged PRs" and exited 0, journaling "nothing shipped"
// on a day 5 PRs merged. Now: the query is retried, and a SUSTAINED failure exits 4 (fail-loud, the
// nightly run goes red and pages) unless --allow-degraded is passed. A successful query that returns
// 0 PRs is still a legitimate quiet day and exits 0.
//
// Usage:
//   node skills/daily-digest/digest.mjs [--date YYYY-MM-DD] [--org InnerScopeHearing] [--out path] [--days 1] [--allow-degraded]
// Mints nothing directly: shells out to the github-app skill's `request` (installation token,
// never echoed). Pair with the orchestration in the SKILL.md to stage + index it.

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const argv = process.argv.slice(2);
const val = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const ORG = val("--org", "InnerScopeHearing");
const DATE = val("--date", new Date().toISOString().slice(0, 10));
const DAYS = parseInt(val("--days", "0"), 10) || 0; // 0 = single day (--date); >0 = trailing window
const OUT = val("--out", `journal/${DATE}.md`);
const ALLOW_DEGRADED = argv.includes("--allow-degraded");
const GH = new URL("../github-app/gh-app.mjs", import.meta.url).pathname;

function ghGraphqlOnce(query) { // gh-app.mjs `graphql` reads the query from STDIN; lean fields keep the response small
  try {
    const o = execFileSync("node", [GH, "graphql"], { input: query, maxBuffer: 32 * 1024 * 1024 }).toString("utf8");
    return JSON.parse(o);
  } catch (e) { console.error("gh graphql failed: " + e.message.slice(0, 160)); return null; }
}

// A digest query "succeeded" only if it returned the expected search->nodes structure. A null (the
// gh-app shell-out threw, e.g. Missing JWT issuer) or a GraphQL error payload (no data.search) is a
// FAILURE, distinct from a valid response with zero nodes (a genuinely quiet day). Exported for tests.
export function digestQueryOk(j) {
  return !!(j && j.data && j.data.search && Array.isArray(j.data.search.nodes));
}

async function ghGraphqlRetry(query, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    const j = ghGraphqlOnce(query);
    if (digestQueryOk(j)) return j;
    if (i < attempts - 1) {
      console.error(`[digest] GitHub query attempt ${i + 1}/${attempts} failed; retrying...`);
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  return null; // sustained failure across all attempts
}

async function main() {
  const sinceDay = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);
  const mergedQ = DAYS > 0 ? `merged:>=${sinceDay}` : `merged:${DATE}`;
  const windowLabel = DAYS > 0 ? `last ${DAYS} days (since ${sinceDay})` : DATE;
  // the day's shipped work: merged PRs across the org (only number/title/repo -> small payload)
  const query = `query{ search(query:${JSON.stringify(`org:${ORG} is:pr is:merged ${mergedQ}`)}, type:ISSUE, first:100){ nodes{ ... on PullRequest { number title repository{ name } } } } }`;
  const j = await ghGraphqlRetry(query);
  if (!digestQueryOk(j)) {
    if (ALLOW_DEGRADED) {
      console.error(`[digest] WARNING: GitHub query failed after retries; --allow-degraded set, writing a digest with NO shipped-work data.`);
    } else {
      console.error(`[digest] FATAL: GitHub query failed after retries (auth/network). Refusing to write a silently-empty digest that would journal "nothing shipped" on a day work may have shipped. Check github-app-id / github-app-private-key / github-app-installation-id in Key Vault and the App JWT path (skills/github-app/gh-app.mjs). Pass --allow-degraded to write the digest anyway.`);
      process.exit(4);
    }
  }
  const nodes = (j && j.data && j.data.search && j.data.search.nodes) || [];
  const prs = nodes.filter((n) => n && n.number).map((n) => ({ number: n.number, title: (n.title || "").replace(/\n/g, " "), repo: (n.repository && n.repository.name) || "?" }));
  const byRepo = {};
  for (const p of prs) { (byRepo[p.repo] ||= []).push(p); }

  let md = `# Company Daily Digest — ${DATE}\n\n`;
  md += `> End-of-day knowledge digest for the fleet knowledge base. Window: ${windowLabel}. `;
  md += `Generated ${new Date().toISOString()}.\n\n`;
  if (ALLOW_DEGRADED && !digestQueryOk(j)) md += `> WARNING: GitHub was unavailable when this ran. The shipped-work section is INCOMPLETE (degraded run).\n\n`;
  md += `## Shipped (${prs.length} merged PRs across ${Object.keys(byRepo).length} repos)\n`;
  if (!prs.length) md += `\n_No merged PRs in the window._\n`;
  for (const [repo, list] of Object.entries(byRepo).sort()) {
    md += `\n### ${repo} (${list.length})\n`;
    for (const p of list.sort((a, b) => a.number - b.number)) md += `- #${p.number} ${p.title.replace(/\n/g, " ")}\n`;
  }
  md += `\n## Decisions & notes\n`;
  md += `- (Key decisions + durable-state changes from CLAUDE.md / runbooks / Notion briefings for ${DATE}.)\n`;
  md += `\n## Learnings (fleet memory)\n`;
  md += `- (Promoted \`kb_remember\` entries for ${DATE} — what agents learned, so tomorrow's agents inherit it.)\n`;
  md += `\n## Open / blockers\n`;
  md += `- (Carried from the day's status; what's still gated or in flight.)\n`;
  md += `\n## Next\n`;
  md += `- (Priorities for tomorrow.)\n`;

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, md);
  console.log(`wrote ${OUT} (${prs.length} merged PRs across ${Object.keys(byRepo).length} repos)`);
}

// Standard ESM main-module guard so a test can import digestQueryOk() without shelling out to GitHub.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) main();
