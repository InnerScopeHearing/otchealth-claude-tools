#!/usr/bin/env node
// Fleet PR Sweep -> the queryable source of truth for "what is open and why".
// Exists so the developer NEVER asserts open-PR state from memory again. Every
// open PR is enumerated with its real CI/mergeable state and binned into a
// disposition bucket. Done-but-open PRs (green + mergeable + not draft, or a
// green draft that is just sitting) are flagged ACTION REQUIRED.
//
// Auth: reuses the org GitHub App identity via the sibling github-app skill
// (15k req/hr). No new creds. Read-only (GraphQL queries only).
//
// Usage:
//   node sweep.mjs                       # sweep the default app fleet
//   node sweep.mjs repoA repoB ...       # sweep a specific repo list (owner defaults to InnerScopeHearing)
//   node sweep.mjs --owner X repoA ...    # override owner
//   node sweep.mjs --json                # machine-readable output
//   node sweep.mjs --stale-days 14       # age threshold for STALE (default 14)
//   node sweep.mjs --gate                # exit 1 if any ACTION-REQUIRED PRs exist (for CI/hooks)
//
// Exit codes: 0 = clean (or informational), 1 = --gate and action-required PRs found, 2 = hard error.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GHAPP = path.resolve(HERE, "../github-app/gh-app.mjs");
const DEFAULT_OWNER = "InnerScopeHearing";

// The dev-owned consumer app fleet. medreview is PHI/CTO-owned: counted read-only,
// never dev-actionable (see DISPOSITION note). Keep this list in sync with the portfolio.
const DEFAULT_REPOS = [
  "iheartest", "aware-aural-rehab", "flatstick", "fourvault",
  "otchealth-companion", "innerease", "fictionary", "plantid-app",
];
const PHI_OWNED = new Set(["medreview"]);

function parseArgs(argv) {
  const o = { owner: DEFAULT_OWNER, repos: [], json: false, staleDays: 14, gate: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--owner") o.owner = argv[++i];
    else if (a === "--json") o.json = true;
    else if (a === "--gate") o.gate = true;
    else if (a === "--stale-days") o.staleDays = parseInt(argv[++i], 10) || 14;
    else o.repos.push(a);
  }
  if (!o.repos.length) o.repos = DEFAULT_REPOS;
  return o;
}

let _token = null;
function token() {
  if (_token) return _token;
  // gh-app prints the bare installation token on stdout.
  _token = execFileSync("node", [GHAPP, "token"], { encoding: "utf8" }).trim();
  return _token;
}

async function gql(query, variables) {
  const r = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json().catch(() => ({}));
  if (j.errors) throw new Error("GraphQL: " + JSON.stringify(j.errors).slice(0, 300));
  return j.data;
}

const Q = `query($owner:String!,$name:String!){
  repository(owner:$owner,name:$name){
    pullRequests(states:OPEN, first:100, orderBy:{field:UPDATED_AT,direction:DESC}){
      nodes{
        number title isDraft mergeable createdAt updatedAt baseRefName headRefName
        author{login}
        labels(first:20){nodes{name}}
        commits(last:1){nodes{commit{statusCheckRollup{state}}}}
      }
    }
  }
}`;

function daysSince(iso) {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

// The disposition engine. Every open PR resolves to exactly one bucket.
// ACTION-REQUIRED buckets are the ones that must not silently persist.
function classify(pr, staleDays) {
  // An explicit `hold` label is a recorded disposition (the standard requires a
  // written reason + owner in the PR comment alongside it). It is NOT action-required:
  // a held PR is being deliberately parked, not rotting. This keeps the ACTION list
  // honest so it never gets trained-ignored.
  const labels = (pr.labels?.nodes || []).map((l) => l.name.toLowerCase());
  if (labels.some((n) => /^hold\b/.test(n) || n === "hold"))
    return { bucket: "HOLD", action: false, why: `on HOLD (label) -> see PR comment for owner + reason` };

  const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state || "NONE"; // SUCCESS|FAILURE|PENDING|ERROR|EXPECTED|NONE
  const age = daysSince(pr.updatedAt);
  const green = rollup === "SUCCESS" || rollup === "NONE" || rollup === "EXPECTED";
  const failing = rollup === "FAILURE" || rollup === "ERROR";
  const conflicting = pr.mergeable === "CONFLICTING";

  if (conflicting) return { bucket: "REBASE", action: true, why: `mergeable=CONFLICTING (rebase onto base, re-run CI)` };
  if (failing) return { bucket: "FIX-OR-CLOSE", action: true, why: `checks ${rollup} (fix the failure or close the PR)` };
  if (!pr.isDraft && green && pr.mergeable === "MERGEABLE")
    return { bucket: "READY-MERGE", action: true, why: `not draft, MERGEABLE, checks ${rollup} -> merge it or record why not` };
  if (pr.isDraft && green && pr.mergeable === "MERGEABLE")
    return { bucket: "DRAFT-GREEN", action: true, why: `green + mergeable but still DRAFT -> promote+merge or record a HOLD reason` };
  if (age > staleDays)
    return { bucket: "STALE", action: true, why: `no update in ${age}d -> revive or close (no zombies)` };
  return { bucket: "IN-FLIGHT", action: false, why: `recent, checks=${rollup}, mergeable=${pr.mergeable}` };
}

async function sweepRepo(owner, name, staleDays) {
  const data = await gql(Q, { owner, name });
  const prs = data?.repository?.pullRequests?.nodes || [];
  return prs.map((pr) => {
    const c = classify(pr, staleDays);
    return {
      repo: name, number: pr.number, title: pr.title, draft: pr.isDraft,
      author: pr.author?.login, base: pr.baseRefName, head: pr.headRefName,
      mergeable: pr.mergeable, ageDays: daysSince(pr.updatedAt), ...c,
    };
  });
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const all = [];
  const errors = [];
  for (const repo of o.repos) {
    try {
      const rows = await sweepRepo(o.owner, repo, o.staleDays);
      all.push(...rows.map((r) => ({ ...r, phiOwned: PHI_OWNED.has(repo) })));
    } catch (e) {
      errors.push({ repo, error: String(e.message || e) });
    }
  }

  if (o.json) {
    console.log(JSON.stringify({ generated: new Date().toISOString(), owner: o.owner, prs: all, errors }, null, 2));
  } else {
    const byRepo = {};
    for (const r of all) (byRepo[r.repo] ||= []).push(r);
    console.log(`\n=== FLEET PR SWEEP  (${o.owner})  ${new Date().toISOString()} ===`);
    for (const repo of o.repos) {
      const rows = byRepo[repo] || [];
      const phi = PHI_OWNED.has(repo) ? "  [PHI/CTO-owned: read-only]" : "";
      if (!rows.length) { console.log(`\n${repo}: 0 open  OK${phi}`); continue; }
      console.log(`\n${repo}: ${rows.length} open${phi}`);
      for (const r of rows.sort((a, b) => Number(b.action) - Number(a.action))) {
        const tag = r.action ? "ACTION" : "  ----";
        console.log(`  ${tag}  #${r.number} [${r.bucket}] ${r.draft ? "(draft) " : ""}${r.title.slice(0, 64)}`);
        console.log(`          ${r.why}  | age ${r.ageDays}d | base ${r.base}`);
      }
    }
    const action = all.filter((r) => r.action && !r.phiOwned);
    console.log(`\n--- SUMMARY ---`);
    console.log(`open PRs: ${all.length} across ${o.repos.length} repos | ACTION REQUIRED (dev-owned): ${action.length}`);
    if (action.length) {
      console.log(`\nACTION REQUIRED (a PR here is done-but-open or rotting; dispose of it):`);
      for (const r of action) console.log(`  ${r.repo}#${r.number}  [${r.bucket}]  ${r.title.slice(0, 60)}`);
    } else {
      console.log(`No dev-owned PR is done-but-open or stale. Fleet PR hygiene: CLEAN.`);
    }
    if (errors.length) { console.log(`\nERRORS:`); for (const e of errors) console.log(`  ${e.repo}: ${e.error}`); }
  }

  if (errors.length && all.length === 0) process.exit(2);
  if (o.gate && all.some((r) => r.action && !r.phiOwned)) process.exit(1);
  process.exit(0);
}

main().catch((e) => { console.error("pr-sweep fatal:", e.message || e); process.exit(2); });
