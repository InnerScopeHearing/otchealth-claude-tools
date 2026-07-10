#!/usr/bin/env node
// charter-lint.mjs — DESIGN SKETCH, not wired into any CI workflow yet.
//
// Generalizes the PROVEN per-app compliance-grep pattern (iHEARtest
// .github/workflows/web-ci.yml "Compliance guard" step: grep -RE
// 'hearing_number|threshold_db_hl' www/js/ --exclude=i18n.js
// --exclude=sentry-config.js) into a charter-DRIVEN lint that:
//   (a) validates every charters/*.json file against
//       schemas/agent-charter.schema.json (structural + the two invariants
//       no schema `enum`/`required` can express: write subset of read, and
//       no self-approval in commit_approvers -- ajv's `not`/`contains`
//       COULD express these but a plain JS check is more readable and this
//       file doubles as executable documentation of the invariants), and
//   (b) for a PR that touches a repo/lane with an associated charter, scans
//       the DIFF for every prohibited_actions[].type === 'regex_content'
//       pattern (both the charter's own additions AND, always, the fleet-
//       wide ADR-001 baseline already enforced in guardrail.ts) and fails
//       the build on a match outside that charter's declared exception
//       files -- this is exactly the iHEARtest --exclude=i18n.js /
//       --exclude=sentry-config.js convention, generalized so it is DATA
//       (the charter) not a hand-maintained grep line duplicated in every
//       repo's workflow file.
//
// Per the AZURE-AI-OPERATING-SYSTEM.md verifier correction: "PORT THE
// PHI/MNPI COMPLIANCE-GREP AS A HARD CI GATE into the gateway repo... Make
// the ring boundary machine-enforced, not comment-enforced." This is that
// port, plus the fleet-wide generalization so any repo can adopt it by
// pointing REPO_CHARTER_LANE at the right charter.
//
// Usage (as a GitHub Actions step, required status check):
//   node ci-sketch/charter-lint.mjs --charter-dir charters/ --repo-lane cto --diff-base origin/main
//
// Exit codes: 0 = clean. 1 = a charter is structurally invalid (schema
// violation or an invariant failure). 2 = the diff trips a prohibited
// regex_content pattern outside its declared exceptions.

import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

function loadJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function fail(code, msg) {
  console.error(`::error::${msg}`);
  process.exitCode = code;
}

// ---------------------------------------------------------------------------
// Part 1: structural + invariant validation of every charter file.
// (A real implementation uses ajv against
// schemas/agent-charter.schema.json for the JSON-Schema-expressible parts;
// this sketch inlines the checks so it is readable standalone and mirrors
// exactly the same checks the example-charter validation script ran during
// Phase 5 drafting.)
// ---------------------------------------------------------------------------

function validateCharter(file, doc) {
  const errors = [];

  const required = ['charter_id', 'version', 'agent_role', 'identity', 'business_objectives', 'rings', 'gateway_scopes', 'prohibited_actions', 'physical_gates', 'spend_authority', 'escalation', 'updated_at', 'updated_by'];
  for (const k of required) if (!(k in doc)) errors.push(`missing required key '${k}'`);
  if (errors.length) return errors; // don't cascade into undefined-access below

  // Invariant 1: write rings are a subset of read rings.
  for (const r of doc.rings.allowed_write) {
    if (!doc.rings.allowed_read.includes(r)) {
      errors.push(`rings.allowed_write includes '${r}' which is not in rings.allowed_read (write must be a subset of read)`);
    }
  }

  // Invariant 2: no self-approval. A charter's own agent_role must never
  // appear in its own spend_authority.commit_approvers -- this is the
  // static-time twin of propose-commit-ledger.ts's runtime
  // committerAgent !== proposal.proposer_agent check; catching it here
  // means a misconfigured charter is a build failure, not a runtime
  // surprise the first time someone tries to exploit it.
  if (doc.spend_authority.commit_approvers.includes(doc.agent_role)) {
    errors.push(`spend_authority.commit_approvers includes this charter's own agent_role '${doc.agent_role}' (self-approval is not permitted)`);
  }

  // Invariant 3: hard-limit coverage. Every charter (except a role explicitly
  // authorized to hold PHI, none exist in the fleet today -- MedReview is
  // code-only per the CTO CLAUDE.md 'medreview = code yes, patient data
  // never' rule, so even a hypothetical medreview-app-lead charter would
  // still carry this gate) must have an explicit ring_gate prohibiting phi,
  // AND every ring_gate / regex_content prohibited_action must list at
  // least one machine enforcement_point (gateway or ci) -- a hard limit
  // that ONLY lists human_review is a gap, not a control.
  const hasPhiRingGate = doc.prohibited_actions.some((pa) => pa.type === 'ring_gate' && pa.classifier.ring === 'phi');
  if (!hasPhiRingGate) errors.push(`no prohibited_actions entry with type=ring_gate classifier.ring=phi (every non-PHI-role charter must explicitly restate the PHI wall)`);

  for (const pa of doc.prohibited_actions) {
    if ((pa.type === 'ring_gate' || pa.type === 'regex_content') && !pa.enforcement_point.some((e) => e === 'gateway' || e === 'ci')) {
      errors.push(`prohibited_actions['${pa.id}'] (type=${pa.type}) has no machine enforcement_point (gateway/ci); a hard-limit prohibition enforced only by human_review is a documented gap, not a control -- add gateway and/or ci, or downgrade its type if it is genuinely process-only (see the clo charter's no_unverified_legal_citation for a documented, deliberate exception)`);
    }
  }

  // Invariant 4: bare '*' in gateway_scopes is reserved for cto/coach.
  if (doc.gateway_scopes.includes('*') && !['cto', 'coach'].includes(doc.agent_role)) {
    errors.push(`gateway_scopes contains bare '*' but agent_role '${doc.agent_role}' is not cto/coach (bare '*' is reserved for the two roles with legitimate fleet-wide operational need)`);
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Part 2: diff scan against the applicable charter's regex_content
// prohibitions, generalizing the iHEARtest grep step. Exceptions come from
// the charter itself (a new field, `exceptions`, not yet in the v1 schema --
// noted below as a Phase-5.1 schema addition) rather than being hardcoded
// per-repo the way iHEARtest's --exclude=i18n.js/--exclude=sentry-config.js
// are today; until that schema addition lands, this sketch reads exceptions
// from a sibling `charters/<lane>.exceptions.json` file (a simple
// { "path_globs": ["**/i18n.js", "**/sentry-config.js"] } shape) so the
// port is incremental and does not block on a schema version bump.
// ---------------------------------------------------------------------------

function diffAgainstBase(base) {
  // Unified diff of added lines only (mirrors what a compliance grep cares
  // about: NEW forbidden content, not pre-existing content the repo
  // already carries and has presumably been reviewed).
  // execFileSync with an argument array (no shell), so --diff-base can
  // never be used to inject a second command even though it is CI-config
  // input rather than untrusted user input in practice.
  const raw = execFileSync('git', ['diff', '--unified=0', `${base}...HEAD`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const files = [];
  let current = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('+++ b/')) {
      current = { path: line.slice(6), addedLines: [] };
      files.push(current);
    } else if (current && line.startsWith('+') && !line.startsWith('+++')) {
      current.addedLines.push(line.slice(1));
    }
  }
  return files;
}

function isExcepted(filePath, exceptionGlobs) {
  return exceptionGlobs.some((g) => {
    const re = new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '$');
    return re.test(filePath);
  });
}

function scanDiffForCharter(charter, exceptions, diffFiles) {
  const patterns = charter.prohibited_actions
    .filter((pa) => pa.type === 'regex_content' && pa.classifier.pattern)
    .map((pa) => ({ id: pa.id, re: new RegExp(pa.classifier.pattern, 'i'), reason: pa.reason }));
  if (patterns.length === 0) return [];

  const hits = [];
  for (const f of diffFiles) {
    if (isExcepted(f.path, exceptions.path_globs || [])) continue;
    for (const line of f.addedLines) {
      for (const p of patterns) {
        const m = line.match(p.re);
        if (m) hits.push({ file: f.path, prohibition: p.id, reason: p.reason, excerpt: line.trim().slice(0, 160) });
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { charterDir: 'charters', repoLane: null, diffBase: 'origin/main' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--charter-dir') out.charterDir = argv[++i];
    else if (argv[i] === '--repo-lane') out.repoLane = argv[++i];
    else if (argv[i] === '--diff-base') out.diffBase = argv[++i];
    else if (!argv[i].startsWith('--')) out.charterDir = argv[i]; // positional charter-dir, e.g. `charter-lint.mjs charters/`
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  // Part 1: validate every charter file structurally, regardless of which
  // lane this repo is. A broken charter anywhere in the fleet is a fleet-
  // wide risk (the gateway loads all of them at boot), so every repo that
  // carries the charters/ directory (today: the gateway repo is the source
  // of truth; other repos symlink or fetch it read-only) lints all of them.
  let charterFiles = [];
  try {
    charterFiles = readdirSync(args.charterDir).filter((f) => f.endsWith('.json') && !f.endsWith('.exceptions.json'));
  } catch {
    console.log(`No charter directory at ${args.charterDir}; skipping charter validation (this repo does not carry charters).`);
  }

  let structuralErrors = 0;
  for (const f of charterFiles) {
    const full = path.join(args.charterDir, f);
    const doc = loadJson(full);
    const errors = validateCharter(full, doc);
    if (errors.length) {
      structuralErrors += errors.length;
      for (const e of errors) fail(1, `${full}: ${e}`);
    } else {
      console.log(`OK: ${full} (${doc.charter_id} v${doc.version})`);
    }
  }
  if (structuralErrors > 0) {
    console.error(`${structuralErrors} charter validation error(s). Failing.`);
    process.exit(1);
  }

  // Part 2: diff scan, only if this repo declares a lane (a repo not tied
  // to a single agent charter, e.g. a shared toolkit repo, skips this part
  // and relies on the per-role gateway_scopes/ring gate at call time
  // instead of a repo-level content scan).
  if (!args.repoLane) {
    console.log('No --repo-lane given; skipping diff content scan (structural charter validation above still ran).');
    process.exit(0);
  }

  const charterFile = path.join(args.charterDir, `charter-${args.repoLane}.json`);
  let charter;
  try {
    charter = loadJson(charterFile);
  } catch {
    fail(1, `--repo-lane '${args.repoLane}' given but ${charterFile} does not exist.`);
    process.exit(1);
  }

  let exceptions = { path_globs: [] };
  try {
    exceptions = loadJson(path.join(args.charterDir, `charter-${args.repoLane}.exceptions.json`));
  } catch {
    /* no exceptions file is fine; means zero exceptions for this lane */
  }

  const diffFiles = diffAgainstBase(args.diffBase);
  const hits = scanDiffForCharter(charter, exceptions, diffFiles);
  if (hits.length === 0) {
    console.log(`OK: diff against ${args.diffBase} contains no ${charter.charter_id} regex_content violations.`);
    process.exit(0);
  }

  for (const h of hits) {
    fail(2, `${h.file}: matched prohibited_actions['${h.prohibition}'] -- ${h.reason}\n  added line: ${h.excerpt}`);
  }
  console.error(`${hits.length} compliance violation(s) in the diff. Failing (per ${charter.charter_id}).`);
  process.exit(2);
}

main();
