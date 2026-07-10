// Detector 6: a TestFlight build shipped with no Mark verdict after N days. HIGH PRECISION rationale:
// this reads the iHEARtest "Mark review ritual" convention directly (qa/RELEASE-LEDGER.md rows +
// qa/mark-reviews/<version>/mark-completed-<version>.pdf), which per iheartest/CLAUDE.md is explicitly
// "SACRED" and "stable across 5+ cycles" - so the parse target is a durable, human-governed convention,
// not a heuristic guess. It only fires for a row that (a) actually reached TestFlight (has an ASC
// upload date, i.e. is not PENDING/TBD) and (b) is not itself marked SUPERSEDED (a superseded build is
// reviewed via the superseding build's binary by design, per the ledger's own notes, so it must never
// fire), and only past a generous default window (7 days) so the normal same-day/next-day review
// turnaround never trips it.
//
// SCOPE: this convention exists ONLY in iHEARtest today (per its CLAUDE.md, "the Mark review ritual").
// The detector is written generically (takes a repoPath) so it can be pointed at any future app that
// adopts the same convention, but it is only WIRED to iheartest for now; do not assume other app repos
// have this file (most do not) - the runner below feature-detects and skips silently if absent.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeSignal } from "../schema.mjs";

export const NAME = "mark-review-overdue";
export const OWNER = "cto"; // release/QA-process domain

const OVERDUE_DAYS = 7;

/**
 * Parse the RELEASE-LEDGER.md markdown table into rows. Deliberately narrow: splits on the header
 * separator line, then each data row on unescaped `|`, trimming cells. Tolerant of bold/link markdown
 * inside a cell (does not try to strip it, just needs cell BOUNDARIES, which are reliable pipes since
 * the table itself is hand-maintained CSV-over-markdown). Exported for hermetic unit testing.
 */
export function parseLedger(md) {
  const lines = md.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => /^\s*\|\s*Marketing\s*\|/.test(l));
  if (headerIdx === -1) return [];
  const rows = [];
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith("|")) break; // table ended
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 5) continue;
    const [marketing, build, commit, ascUpload, status] = cells;
    rows.push({ marketing, build, commit, ascUpload, status: status || "" });
  }
  return rows;
}

/** Given a parsed ledger row, decide if it is a genuine "shipped, awaiting Mark" candidate. Excludes
 * SUPERSEDED rows and rows with no real ASC upload timestamp (PENDING/TBD/N/A). Pure, testable. */
export function isReviewCandidate(row) {
  if (/superseded/i.test(row.status)) return false;
  if (!row.ascUpload || /pending|tbd|n\/a/i.test(row.ascUpload)) return false;
  const parsed = Date.parse(row.ascUpload.replace(/\s+PT$/, ""));
  return Number.isFinite(parsed) ? { uploadedAtMs: parsed } : false;
}

export async function run({ repoPath = "/home/user/iheartest", overdueDays = OVERDUE_DAYS } = {}) {
  const notes = [];
  const ledgerPath = join(repoPath, "qa", "RELEASE-LEDGER.md");
  if (!existsSync(ledgerPath)) { notes.push(`no qa/RELEASE-LEDGER.md at ${repoPath} (convention not adopted here) - skipped`); return { signals: [], notes }; }

  const md = readFileSync(ledgerPath, "utf8");
  const rows = parseLedger(md);
  const now = Date.now();
  const signals = [];
  for (const row of rows) {
    const candidate = isReviewCandidate(row);
    if (!candidate) continue;
    const ageDays = (now - candidate.uploadedAtMs) / 86400000;
    if (ageDays < overdueDays) continue;
    const pdfPath = join(repoPath, "qa", "mark-reviews", row.marketing, `mark-completed-${row.marketing}.pdf`);
    if (existsSync(pdfPath)) continue; // Mark already reviewed it
    signals.push(makeSignal({
      detector: NAME, owner: OWNER, subject: `iheartest/${row.marketing}+${row.build}`,
      severity: ageDays >= 21 ? "high" : "medium",
      why: `iHEARtest ${row.marketing} (build ${row.build}) shipped to TestFlight ${Math.round(ageDays)} day(s) ago with no Mark review PDF at qa/mark-reviews/${row.marketing}/.`,
      evidence_link: null,
      suggested_action: `Confirm the qa/build-review-${row.marketing}.html packet reached Mark; nudge for the completed PDF before any external-tester rollout of this build.`,
    }));
  }
  return { signals, notes };
}
