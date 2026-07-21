#!/usr/bin/env node
// governed-skills-audit.mjs -- catches "shadow-doctrine" skills: directories living under
// ~/.claude/skills that do NOT exist in the git-tracked skills/ tree.
//
// WHY THIS EXISTS: session-start.sh and octools-sync.sh both install skills the SAME way -- copy
// every `skills/<name>/` dir FROM the git tree INTO ~/.claude/skills/<name>. Neither script ever
// enumerates ~/.claude/skills, and neither ever removes a destination dir that has no source
// counterpart. So any skill directory that lands there by some OTHER path (an agent authoring one ad
// hoc mid-session, a one-off manual experiment, a stale leftover) is never touched again by either
// sync mechanism -- it persists forever, silently, fully outside code review, PR history, and the
// live-sync-from-main guarantee every OTHER skill gets. It still loads and steers every session that
// starts on that machine, same as a governed skill would.
//
// This is NOT hypothetical. A live audit (2026-07-21) found exactly this: 5 company-specific "custom"
// skills (one-brain-ground-first-protocol, otchealth-gateway-toolkit, otchealth-cost-speed-routing,
// otchealth-stability-playbook, cross-engine-memory-protocol), all authored the same day (2026-07-05)
// and never committed anywhere, quietly asserting doctrine as fact -- including "Single Azure AI Search
// index `otchealth-brain` ... don't re-fragment it" and "brain_search is not ring-gated ... do NOT
// re-raise unprompted", BOTH of which the git-tracked record (otchealth-cto/CLAUDE.md) shows are now
// FALSE: otchealth-brain was retired/archived/deleted 2026-07-14, and the ring-gating gap was found to
// be a real cross-ring leak and CLOSED 2026-07-16. A frozen, ungoverned skill is exactly as dangerous
// as the frozen `otchealth-brain` index itself (see setup/index-writer-gate.mjs) -- it just steers
// agent BEHAVIOR instead of retrieval results, so nothing else catches it.
//
// NOT every orphan is a problem. session-start.sh legitimately installs Anthropic's official
// document-skills / example-skills marketplace plugins into this SAME ~/.claude/skills directory via
// `claude plugin install`, a completely different (and fully governed, Anthropic-authored) mechanism.
// Those are EXPECTED orphans relative to the git skills/ tree and must never be assumed dangerous just
// for being dest-only. This tool tells the two apart using Claude Code's own on-disk provenance record
// (~/.claude/skills/manifest.json, `source: anthropic | anthropic-example | custom`) when it is present,
// and says "review, provenance unknown" rather than guessing when it is not.
//
// DESIGN: pure diff (diffOrphans) and pure classifier (classifyOrphan) are dependency-free and unit
// tested in tests/governed-skills-audit.test.mjs with zero real filesystem I/O. The CLI wrapper is
// fail-open end to end: any read/parse error on any one orphan is caught locally and never aborts the
// run, so this is always safe to pipe into `... || true` from a session hook. Report mode NEVER deletes
// anything, by construction (the delete codepath is a separate, opt-in flag tree entirely -- see below).
//
// Usage:
//   node setup/governed-skills-audit.mjs                  # --report (default): fast name-only list, exit 0 always
//   node setup/governed-skills-audit.mjs --report
//   node setup/governed-skills-audit.mjs --report --json
//   node setup/governed-skills-audit.mjs --detail          # + read each orphan's SKILL.md + manifest provenance,
//                                                           #   print a delete-vs-PR-in recommendation per orphan
//   node setup/governed-skills-audit.mjs --prune           # DRY RUN only -- prints what WOULD be removed, deletes nothing
//   node setup/governed-skills-audit.mjs --prune --yes     # LIVE -- removes non-marketplace orphans (see below)
//   node setup/governed-skills-audit.mjs --prune --yes --only name-a,name-b   # scope to exactly these names
//   node setup/governed-skills-audit.mjs --report --if-changed   # silent unless the orphan set changed
//                                                                 #   since the last --if-changed call
//                                                                 #   (for a hook that fires every prompt,
//                                                                 #   e.g. octools-sync.sh; mirrors the
//                                                                 #   "seen" idea in setup/bulletin.mjs)
//
// PRUNE SAFETY (defense in depth, each layer independent):
//   1. Never mutates without BOTH --prune AND --yes; --prune alone is always a dry run.
//   2. Never touches the git skills/ tree -- only ever resolves paths under ~/.claude/skills.
//   3. isSafeSkillTarget() realpath-resolves the target and REQUIRES it to be a real child of the real
//      ~/.claude/skills directory, so a symlink escape (or a name of "." / ".." / containing "/") is
//      refused even under --yes.
//   4. Default scope (no --only) is orphans classified NOT "marketplace" only -- i.e. it will not casually
//      wipe out a legitimately-installed Anthropic skill just for being dest-only. Naming a marketplace
//      skill explicitly via --only is honored (explicit intent overrides the default), still gated on --yes.
//   5. --only is intersected with the CURRENT orphan set -- it can never be used to remove a skill that
//      is actually tracked in the git tree.
import { readdirSync, statSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, sep } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_SKILLS = join(ROOT, "skills");
const HOME = process.env.HOME || "/tmp";
const DEST_SKILLS = join(HOME, ".claude", "skills");
const MANIFEST_PATH = join(DEST_SKILLS, "manifest.json");
const SEEN_STAMP = join(HOME, ".claude", ".governed-skills-audit-seen");

// ───────────────────────── pure functions (no I/O; unit-tested directly) ─────────────────────────

/**
 * PURE: directory names present in `destNames` but absent from `srcNames`. Dedupes and sorts so the
 * result is stable and diffable. This is the headline function: "what's live under ~/.claude/skills
 * that the git skills/ tree has no idea about."
 */
export function diffOrphans(destNames, srcNames) {
  const src = new Set(srcNames || []);
  return [...new Set(destNames || [])].filter((n) => !src.has(n)).sort();
}

/**
 * PURE: best-effort parse of a SKILL.md's leading YAML frontmatter for `name:`/`description:` only.
 * No YAML dependency (this repo is dependency-free Node); mirrors tests/frontmatter.test.mjs's own
 * parser. Returns null if there is no leading `---` frontmatter block at all.
 */
export function parseFrontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md || "");
  if (!m) return null;
  const body = m[1];
  const grab = (k) => {
    const mm = new RegExp(`^${k}:\\s*(.+)$`, "m").exec(body);
    return mm ? mm[1].trim() : "";
  };
  return { name: grab("name"), description: grab("description") };
}

/**
 * PURE: classify one orphan using Claude Code's own manifest.json provenance entry for it, if any.
 * `manifestEntry` is the `{ name, source, updatedAt, ... }` object from manifest.json's `skills[]`
 * array, or undefined/null if this orphan has no record there at all.
 *   source "anthropic" | "anthropic-example"  -> installed by the official marketplace mechanism in
 *                                                 session-start.sh (`claude plugin install ...`).
 *                                                 EXPECTED to be dest-only; not shadow doctrine.
 *   source "custom"                            -> authored directly as a skill, outside git, outside
 *                                                 the marketplace. This is the shadow-doctrine risk
 *                                                 category: a human/agent must decide delete vs PR-in.
 *   no entry at all                             -> unknown provenance; never assume, ask for review.
 */
export function classifyOrphan(name, manifestEntry) {
  const source = manifestEntry && manifestEntry.source;
  if (source === "anthropic" || source === "anthropic-example") {
    return {
      verdict: "marketplace",
      recommend: `no action needed -- Anthropic ${source} marketplace-installed; expected to be absent from skills/`,
    };
  }
  if (source === "custom") {
    return {
      verdict: "shadow-custom",
      recommend: "CTO DECIDE: delete (stale/superseded/duplicates governed doctrine) vs PR-in (still correct, make it governed and live-synced)",
    };
  }
  return {
    verdict: "untracked",
    recommend: "CTO REVIEW: no manifest.json provenance record found for this name -- confirm origin before deciding delete vs PR-in",
  };
}

/**
 * PURE: true when the sorted orphan-name list actually differs from a previous run's list. `prev` is
 * null/undefined when there is no recorded prior run (always counts as changed, so a first-ever
 * invocation reports once); otherwise compared element-wise against `current`. Backs `--if-changed`,
 * which lets a HIGH-FREQUENCY hook (e.g. a UserPromptSubmit hook that fires every prompt) surface a
 * new/changed orphan set exactly once instead of reprinting an unchanged report on every single prompt
 * -- the same "seen" idea setup/bulletin.mjs already uses for the fleet bulletin.
 */
export function orphanSetChanged(prev, current) {
  if (prev === null || prev === undefined) return true;
  if (prev.length !== current.length) return true;
  for (let i = 0; i < current.length; i++) if (prev[i] !== current[i]) return true;
  return false;
}

/**
 * Guard for --prune: true only when `name` resolves to a REAL child of the REAL `destSkillsDir`
 * (realpath-checked both sides, so a symlink escape is refused). Rejects empty/"."/".."/path-separator
 * names outright without touching the filesystem. Refuses (returns false) on any I/O error, including
 * "does not exist" -- prune only ever operates on something it can independently prove is there and is
 * really inside the skills directory, never on a claim.
 */
export function isSafeSkillTarget(destSkillsDir, name) {
  if (!name || typeof name !== "string") return false;
  if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) return false;
  let realBase, real;
  try {
    realBase = realpathSync(destSkillsDir);
    real = realpathSync(join(destSkillsDir, name));
  } catch {
    return false; // missing or unresolvable -> refuse rather than guess
  }
  if (real === realBase) return false; // never allow collapsing onto the skills dir itself
  return (real + sep).startsWith(realBase + sep);
}

// ───────────────────────── fs-backed helpers (thin; the logic above stays pure) ─────────────────────────

function listSkillDirNames(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => {
    try {
      return statSync(join(dir, n)).isDirectory();
    } catch {
      return false; // race/broken-symlink -> just skip it, never throw
    }
  });
}

/** Fail-open: a missing or corrupt manifest.json yields {} (every orphan then classifies "untracked"). */
function loadManifestMap(manifestPath) {
  if (!existsSync(manifestPath)) return {};
  try {
    const j = JSON.parse(readFileSync(manifestPath, "utf8"));
    const out = {};
    for (const s of j.skills || []) if (s && s.name) out[s.name] = s;
    return out;
  } catch {
    return {};
  }
}

function computeOrphans() {
  return diffOrphans(listSkillDirNames(DEST_SKILLS), listSkillDirNames(SRC_SKILLS));
}

/** null = no prior recorded run; [] = a prior run that saw zero orphans. Fail-open on any read error. */
function readSeenList(stampPath) {
  if (!existsSync(stampPath)) return null;
  try {
    const raw = readFileSync(stampPath, "utf8").trim();
    return raw === "" ? [] : raw.split("\n");
  } catch {
    return null;
  }
}

function writeSeenList(stampPath, orphans) {
  try {
    mkdirSync(dirname(stampPath), { recursive: true });
    writeFileSync(stampPath, orphans.length ? orphans.join("\n") + "\n" : "");
  } catch {
    /* best-effort; a stamp-write failure must never break the report itself */
  }
}

// ───────────────────────── CLI ─────────────────────────

function main() {
  const args = process.argv.slice(2);
  const has = (f) => args.includes(f);
  const val = (f) => {
    const i = args.indexOf(f);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };

  const orphans = computeOrphans();
  const manifest = loadManifestMap(MANIFEST_PATH);

  if (has("--prune")) {
    const yes = has("--yes");
    const onlyArg = val("--only");
    const explicitOnly = onlyArg ? onlyArg.split(",").map((s) => s.trim()).filter(Boolean) : null;
    // Default scope (no --only): everything EXCEPT marketplace-classified orphans, so a bare --prune
    // --yes can never casually wipe out a legitimately-installed Anthropic skill. Naming one explicitly
    // via --only overrides this default (explicit intent wins), still gated on --yes either way.
    const defaultScope = orphans.filter((n) => classifyOrphan(n, manifest[n]).verdict !== "marketplace");
    const requested = explicitOnly || defaultScope;
    const targets = requested.filter((n) => orphans.includes(n)); // can never touch a non-current-orphan name

    console.log(
      `[governed-skills-audit] prune ${yes ? "(LIVE)" : "(DRY RUN -- pass --yes to actually remove anything)"}: ` +
        `${targets.length} target(s)${explicitOnly ? " (--only scope)" : " (default scope: non-marketplace orphans)"}`,
    );
    for (const name of targets) {
      const safe = isSafeSkillTarget(DEST_SKILLS, name);
      if (!safe) {
        console.log(`  SKIP (unsafe or missing path): ${name}`);
        continue;
      }
      const target = join(DEST_SKILLS, name);
      if (!yes) {
        console.log(`  would remove: ${target}`);
        continue;
      }
      try {
        rmSync(target, { recursive: true, force: true });
        console.log(`  removed: ${target}`);
      } catch (e) {
        console.log(`  FAILED to remove ${name}: ${e.message}`);
      }
    }
    process.exit(0);
  }

  // --if-changed: for a hook that fires on every prompt (not just once per session), suppress output
  // entirely unless the orphan set actually changed since the last check. Always exits 0, never blocks.
  if (has("--if-changed")) {
    const prev = readSeenList(SEEN_STAMP);
    writeSeenList(SEEN_STAMP, orphans);
    if (!orphanSetChanged(prev, orphans)) process.exit(0);
  }

  const asJson = has("--json");
  if (asJson) {
    const detail = has("--detail")
      ? orphans.map((name) => {
          const skillMdPath = join(DEST_SKILLS, name, "SKILL.md");
          let fm = null;
          if (existsSync(skillMdPath)) {
            try {
              fm = parseFrontmatter(readFileSync(skillMdPath, "utf8"));
            } catch {
              /* fail-open: unreadable SKILL.md just yields no frontmatter, never aborts the run */
            }
          }
          const entry = manifest[name];
          return { name, ...classifyOrphan(name, entry), description: fm && fm.description, manifest_source: entry && entry.source, manifest_updated_at: entry && entry.updatedAt };
        })
      : undefined;
    console.log(JSON.stringify({ orphan_count: orphans.length, orphans, detail }, null, 2));
    process.exit(0);
  }

  // --report (default) and --detail both start from the same list; --report alone is deliberately fast
  // and name-only so it is cheap enough to run at every session start with no perceptible delay.
  if (!orphans.length) {
    console.log("[governed-skills-audit] clean: 0 orphan skill dir(s) in ~/.claude/skills (every installed dir traces to skills/).");
    process.exit(0);
  }
  console.log(`[governed-skills-audit] ${orphans.length} orphan skill dir(s) in ~/.claude/skills not present in the git skills/ tree:`);
  for (const n of orphans) console.log(`  - ${n}`);

  if (has("--detail")) {
    console.log("");
    console.log("[governed-skills-audit] detail (SKILL.md + manifest.json provenance):");
    for (const name of orphans) {
      const skillMdPath = join(DEST_SKILLS, name, "SKILL.md");
      let fm = null;
      if (existsSync(skillMdPath)) {
        try {
          fm = parseFrontmatter(readFileSync(skillMdPath, "utf8"));
        } catch {
          /* fail-open */
        }
      }
      const entry = manifest[name];
      const { verdict, recommend } = classifyOrphan(name, entry);
      console.log(`  - ${name}  [${verdict}]`);
      if (fm && fm.description) console.log(`      desc: ${fm.description}`);
      if (entry && entry.source) console.log(`      manifest source: ${entry.source}${entry.updatedAt ? " (updated " + entry.updatedAt + ")" : ""}`);
      console.log(`      recommend: ${recommend}`);
    }
  } else {
    console.log("");
    console.log("[governed-skills-audit] run with --detail for SKILL.md + provenance-based delete-vs-PR-in guidance (or --json for machine-readable output).");
  }
  process.exit(0); // report mode never blocks a caller, regardless of what it found
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
