#!/usr/bin/env node
// digest-section.mjs — C8-BATCH-DIGEST: batch Tier-2/3 decision-clock items into the daily digest
// with a visible SLA, instead of only ever nudging owners one-off via the sweep.
//
// WHY: decision.mjs's `sweep` already dispatches near-due/overdue items to each owner's fleet-dispatch
// inbox (see decision.mjs sweep()/batchNudges()) — that is the Tier-1, "someone needs to act TODAY"
// channel. But category=matt-gate rows already get a dedicated, high-visibility lane (Matt-only gates
// are the whole reason decision-clock exists). Everything else — Tier 2/3 decisions like `review`,
// `security-finding`, `rotate-secret`, or any other non-matt-gate category — has no passive, "catch me
// up" surface: an owner who was on cooldown, or who ignored a nudge, has no second place to see it.
// The daily digest (skills/daily-digest/digest.mjs) is exactly that second surface: a nightly, no-nag,
// scan-once artifact everyone already reads. This module produces ONE markdown section for it.
//
// SCOPE (Tier 2/3 = "NOT category=matt-gate"): matt-gate rows are Tier-1/human-gate-only by design and
// are deliberately EXCLUDED here — they already get the sweep's direct nudge + terminal_policy
// escalation path (see decision.mjs). Including them again in the digest would just be noise for the
// one channel (sweep -> Matt) that already owns them.
//
// PURE: buildDigestSection() takes already-classified rows (decision.mjs's classifyRow output) and a
// `now` and returns a markdown string + a small summary object. No I/O in this file at all — the caller
// (a future digest.mjs integration, or an ad-hoc script) is responsible for fetching rows via
// decision.mjs's queryAllRows()-equivalent (or just requiring decision.mjs and calling its Cosmos I/O)
// and calling classifyRow() per row before handing them here. That keeps this file hermetically
// testable (node --check + a plain unit test) without ever needing live Cosmos/dispatch credentials,
// matching decision.mjs's own PURE CORE / I/O split.
//
// Usage as a library:
//   import { buildDigestSection, SLA_DAYS_BY_CATEGORY } from "./digest-section.mjs";
//   const rows = allDecisionRows.map(r => ({ ...r, _class: classifyRow(r, nowIso) }));
//   const { markdown, summary } = buildDigestSection(rows, nowIso);
//
// Usage as a standalone CLI (for manual inspection / smoke-testing without wiring into digest.mjs yet):
//   node skills/decision-clock/digest-section.mjs [--json]
//     - Loads rows itself via decision.mjs's own Cosmos client. Cosmos-unreachable (sandbox / no
//       creds) degrades to an explicit "(dry-run)" section rather than throwing, mirroring every other
//       decision-clock verb.
//
// ---------------------------------------------------------------------------------------------------
// ONE-LINE INTEGRATION digest.mjs WOULD NEED (do not edit digest.mjs — this is the exact diff sketch):
//
//   import { buildDigestSectionFromCosmos } from "../decision-clock/digest-section.mjs";
//   ...
//   md += await buildDigestSectionFromCosmos();   // insert after the "## Open / blockers" block
//
// That's it: buildDigestSectionFromCosmos() (below) does its own Cosmos fetch + classification and
// returns a ready-to-append markdown string (never throws; degrades to a one-line "no data" note).
// ---------------------------------------------------------------------------------------------------

import { classifyRow, computeMetrics } from "./decision.mjs";

const NON_MATT_GATE = (r) => (r.category || "").toLowerCase() !== "matt-gate";

/**
 * buildDigestSection(rowsWithClassification, nowIso) -> { markdown, summary }
 * rowsWithClassification: [{ ...decisionRow, _class: classifyRow(row, now) }]
 * Filters to Tier 2/3 (non-matt-gate) rows that are near-due, overdue, or ack'd-but-still-open (ack
 * does not close a row — it just means a human has seen it — so an ack'd row can still be worth a
 * digest mention if it's lingering). Closed rows and plain "open, plenty of runway left" rows are
 * excluded: the digest section is for "needs attention", not a full inventory (list --json is that).
 */
export function buildDigestSection(rowsWithClassification, nowIso) {
  const now = nowIso || new Date().toISOString();
  const scoped = (rowsWithClassification || []).filter(NON_MATT_GATE);
  const attention = scoped.filter((r) => ["overdue", "near-due", "ack"].includes(r._class.status));

  const byCategory = {};
  for (const r of attention) (byCategory[r.category || "uncategorized"] ||= []).push(r);

  const overdueCount = attention.filter((r) => r._class.status === "overdue").length;
  const nearDueCount = attention.filter((r) => r._class.status === "near-due").length;
  const ackCount = attention.filter((r) => r._class.status === "ack").length;

  const summary = {
    scoped_total: scoped.length,
    attention_total: attention.length,
    overdue: overdueCount,
    near_due: nearDueCount,
    ack_lingering: ackCount,
    by_category: Object.fromEntries(Object.entries(byCategory).map(([k, v]) => [k, v.length])),
  };

  let md = `## Decisions Needing Attention (Tier 2/3, non-matt-gate)\n\n`;
  md += `> Batched from decision-clock. Tier-1 matt-gate items are excluded here — they already get a `;
  md += `direct sweep nudge to Matt; this section is the passive catch-up surface for everything else. `;
  md += `SLA: ${overdueCount} overdue, ${nearDueCount} due within the near-due window, ${ackCount} `;
  md += `acknowledged but still open.\n\n`;

  if (!attention.length) {
    md += `_No Tier 2/3 decisions currently overdue, near-due, or lingering in ack. `;
    md += `(${scoped.length} non-matt-gate row(s) tracked total.)_\n`;
    return { markdown: md, summary };
  }

  for (const [category, rows] of Object.entries(byCategory).sort()) {
    rows.sort((a, b) => (b._class.daysOverdue || 0) - (a._class.daysOverdue || 0));
    md += `### ${category} (${rows.length})\n`;
    for (const r of rows) {
      const tag = r._class.status === "overdue" ? `OVERDUE ${Math.round(r._class.daysOverdue)}d past SLA`
        : r._class.status === "near-due" ? `due in ${Math.ceil(r._class.daysUntilDue)}d`
        : `acknowledged, still open`;
      const terminalNote = r._class.terminal ? ` [terminal_policy=${r.terminal_policy}]` : "";
      md += `- **${r.id}** (owner: ${r.owner}) — ${tag}${terminalNote}: ${r.text || "(no description)"}`;
      md += `${r.evidence_link ? ` -> ${r.evidence_link}` : ""}\n`;
    }
    md += `\n`;
  }
  return { markdown: md.trimEnd() + "\n", summary };
}

/**
 * Convenience wrapper for the digest.mjs integration point: does the Cosmos fetch + classification
 * itself so the one-line call site in digest.mjs needs no other imports. Fails open — Cosmos
 * unreachable (e.g. this sandbox, or a job image without creds) returns a one-line markdown note
 * instead of throwing, exactly like decision.mjs's own list()/metrics()/sweep() degrade.
 */
export async function buildDigestSectionFromCosmos() {
  let cosmos;
  try {
    cosmos = await import("./cosmos-client.mjs");
  } catch (e) {
    return `## Decisions Needing Attention (Tier 2/3, non-matt-gate)\n\n_decision-clock unavailable (${e.message}); skipped._\n`;
  }
  try {
    if (!(await cosmos.isConfigured())) {
      return `## Decisions Needing Attention (Tier 2/3, non-matt-gate)\n\n_Cosmos not reachable in this environment (dry-run; nothing to batch)._\n`;
    }
    const rows = await cosmos.queryDocs("decisions_pending", "SELECT * FROM c", [], { max: 2000 });
    const now = new Date().toISOString();
    const withClass = rows.map((r) => ({ ...r, _class: classifyRow(r, now) }));
    const { markdown } = buildDigestSection(withClass, now);
    return markdown;
  } catch (e) {
    return `## Decisions Needing Attention (Tier 2/3, non-matt-gate)\n\n_decision-clock digest section failed to build (${e.message}); skipped, not fatal._\n`;
  }
}

// ---- CLI (manual inspection only; digest.mjs integration uses buildDigestSectionFromCosmos()) ----
import { fileURLToPath, pathToFileURL } from "node:url";
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const asJson = process.argv.includes("--json");
  (async () => {
    let cosmos;
    try { cosmos = await import("./cosmos-client.mjs"); } catch (e) {
      console.error(`[digest-section] cannot load cosmos-client.mjs: ${e.message}`);
      process.exit(1);
    }
    if (!(await cosmos.isConfigured())) {
      console.log("[digest-section] Cosmos not reachable in this sandbox (dry-run; nothing to batch).");
      return;
    }
    const rows = await cosmos.queryDocs("decisions_pending", "SELECT * FROM c", [], { max: 2000 });
    const now = new Date().toISOString();
    const withClass = rows.map((r) => ({ ...r, _class: classifyRow(r, now) }));
    const { markdown, summary } = buildDigestSection(withClass, now);
    if (asJson) console.log(JSON.stringify(summary, null, 2));
    else console.log(markdown);
  })();
}
