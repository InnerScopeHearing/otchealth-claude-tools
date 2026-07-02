#!/usr/bin/env node
// ledger-compaction / compact.mjs - pure, dependency-free ndjson ledger summarizer for kb-memory.
//
// WHY: kb-memory's ledger (skills/kb-memory/mem.mjs) is append-only ndjson, one row per fact,
// decision, correction, pitfall, status, or entity write. It grows forever by design (never
// deleted), so after months of daily use it becomes slow to read in full and expensive to inject
// into a per-prompt working-memory pack. Compaction produces a SEPARATE, smaller artifact that a
// human or an agent can read instead of the raw ledger, without ever touching the source.
//
// THE NON-DESTRUCTIVE GUARANTEE: every function in this file is pure. Given ledger rows in, it
// returns a new result object out. It never writes to disk, never mutates the input array or any
// row object, and never deletes anything. The CLI wrapper at the bottom is the only part that
// writes, and it always writes to a new path (<ledger>.compacted.md / .compacted.jsonl), never
// back to the source file.
//
// Row shape (matches skills/kb-memory/mem.mjs): { id, ts, type, text, tags, source, was,
// supersedes, ekey, evalue, agent }. Known types: fact, decision, pitfall, status, correction,
// entity, alias.

import { readFileSync, writeFileSync } from "node:fs";

// Try to reuse kb-memory's own tokenize/jaccard so the near-duplicate heuristic here matches the
// one kb-memory already uses at write time. Fall back to a local implementation if the sibling
// skill ever moves or renames its exports, so this module has zero hard dependency failures.
let tokenize, jaccard;
try {
  const dedupe = await import("../kb-memory/dedupe.mjs");
  tokenize = dedupe.tokenize;
  jaccard = dedupe.jaccard;
  if (typeof tokenize !== "function" || typeof jaccard !== "function") throw new Error("missing exports");
} catch {
  const STOP = new Set([
    "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "for", "is", "are", "was",
    "were", "be", "been", "being", "it", "its", "this", "that", "these", "those", "with", "as", "by",
    "we", "our", "us", "i", "you", "he", "she", "they", "them", "has", "have", "had", "do", "does",
    "did", "will", "now", "not", "no", "yes", "from", "into", "per", "via", "so", "if", "then",
  ]);
  tokenize = (s) => {
    const out = new Set();
    for (const t of String(s || "").toLowerCase().split(/[^a-z0-9]+/)) {
      if (t.length > 1 && !STOP.has(t)) out.add(t);
    }
    return out;
  };
  jaccard = (a, b) => {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const t of a) if (b.has(t)) inter++;
    return inter / (a.size + b.size - inter);
  };
}

// Types that must be preserved verbatim, never dropped, never summarized away. Matches the real
// kb-memory type vocabulary (fact, decision, pitfall, status, correction, entity, alias). If a
// ledger ever carries a type outside this vocabulary, it falls through to the "other" bucket and
// is treated as a low-signal consolidation candidate, same as fact/status rows.
const ALWAYS_KEEP_TYPES = new Set(["decision", "correction", "pitfall"]);
// The lowest-signal, highest-frequency type in the real schema (see mem.mjs: status is written on
// every "what am I working on" update and is the row type that grows fastest and matters least
// once it has aged out of the recency window).
const LOW_SIGNAL_TYPE = "status";

// ---- ndjson parsing ----------------------------------------------------------------------------

// Parse ndjson text into row objects. Tolerates a trailing newline, skips blank lines, and never
// throws on a corrupt line: unparseable lines are reported (not silently dropped, not fatal).
// Returns { rows, errors } where errors is [{ line, raw }] for lines that failed to parse.
export function parseLedgerText(text) {
  const rows = [];
  const errors = [];
  const lines = String(text || "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue; // blank line, including the usual trailing newline - not an error
    try {
      const row = JSON.parse(raw);
      if (row && typeof row === "object") rows.push(row);
      else errors.push({ line: i + 1, raw });
    } catch {
      errors.push({ line: i + 1, raw });
    }
  }
  return { rows, errors };
}

// ---- pure helpers -------------------------------------------------------------------------------

const byTsAsc = (a, b) => String(a.ts || "").localeCompare(String(b.ts || ""));
const byTsDesc = (a, b) => String(b.ts || "").localeCompare(String(a.ts || ""));

// Walk a supersedes chain backward from a "head" row (the row nothing else supersedes) to collect
// every row in the chain, oldest first. Pure: reads rows, builds new arrays, never mutates rows.
function supersededChain(headRow, rows) {
  const byId = new Map(rows.filter((r) => r && r.id != null).map((r) => [r.id, r]));
  const chain = [headRow];
  let cur = headRow;
  const seen = new Set([headRow.id]);
  while (cur && cur.supersedes && byId.has(cur.supersedes) && !seen.has(cur.supersedes)) {
    const prev = byId.get(cur.supersedes);
    chain.push(prev);
    seen.add(prev.id);
    cur = prev;
  }
  return chain.reverse(); // oldest first, head last
}

// Group rows into near-duplicate clusters using Jaccard token overlap (threshold configurable,
// default ~0.8 to match kb-memory's own dedupe.mjs advisory threshold). Greedy single-link
// clustering: pure, order-stable, does not mutate the input array.
function clusterNearDuplicates(rows, threshold) {
  const items = rows.map((r) => ({ row: r, tokens: tokenize(r.text || "") }));
  const clusters = [];
  const assigned = new Array(items.length).fill(false);
  for (let i = 0; i < items.length; i++) {
    if (assigned[i]) continue;
    const cluster = [items[i].row];
    assigned[i] = true;
    for (let j = i + 1; j < items.length; j++) {
      if (assigned[j]) continue;
      if (jaccard(items[i].tokens, items[j].tokens) >= threshold) {
        cluster.push(items[j].row);
        assigned[j] = true;
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

// ---- the pure compaction function ---------------------------------------------------------------

// compactLedger(rows, options) -> result. NEVER mutates rows or any row within it. Always builds
// new arrays/objects for its output.
//
// options:
//   dupThreshold      Jaccard threshold for near-duplicate clustering (default 0.8)
//   statusKeepRecent  how many of the most-recent low-signal rows to keep in full (default 5)
//   statusKeepDays    additionally keep any low-signal row newer than this many days (default 7)
//   now               injectable clock for statusKeepDays, defaults to Date.now()
export function compactLedger(rows, options = {}) {
  const dupThreshold = options.dupThreshold ?? 0.8;
  const statusKeepRecent = options.statusKeepRecent ?? 5;
  const statusKeepDays = options.statusKeepDays ?? 7;
  const now = options.now ?? Date.now();

  const before = rows.length;
  const safeRows = rows.filter((r) => r && typeof r === "object"); // defensive; never mutates input

  const supersededIds = new Set(safeRows.map((r) => r.supersedes).filter((id) => id != null));
  const isSuperseded = (r) => r.id != null && supersededIds.has(r.id);

  // 1) ALWAYS-KEEP verbatim: decisions, corrections, pitfalls. Every one of these rows, superseded
  //    or not, is preserved in full (a correction's history is meaningful on its own, so corrections
  //    are never collapsed even if one supersedes another).
  const alwaysKeep = safeRows.filter((r) => ALWAYS_KEEP_TYPES.has(r.type));

  // 2) CURRENT ENTITY VALUES: for every distinct ekey among type "entity" rows, keep the latest
  //    (by ts) row in full, verbatim. Build a one-line history note for any chain behind it.
  const entityRows = safeRows.filter((r) => r.type === "entity" && r.ekey != null);
  const ekeys = [...new Set(entityRows.map((r) => r.ekey))];
  const currentEntities = [];
  for (const ekey of ekeys) {
    const forKey = entityRows.filter((r) => r.ekey === ekey);
    const head = forKey.filter((r) => !isSuperseded(r)).sort(byTsDesc)[0] || forKey.slice().sort(byTsDesc)[0];
    if (!head) continue;
    const chain = supersededChain(head, forKey); // oldest..head
    const priorValues = chain.slice(0, -1).map((r) => r.evalue ?? r.text ?? "");
    let historyNote = null;
    if (priorValues.length) {
      const oldestId = chain[0].id;
      const oldestTs = chain[0].ts;
      historyNote = `${ekey}: superseded ${priorValues.length} earlier value(s) (from ${oldestTs || "?"} id=${oldestId || "?"}): ${priorValues.join(" -> ")} -> ${head.evalue ?? head.text ?? ""}`;
    }
    currentEntities.push({ ekey, row: head, historyNote, chainLength: chain.length });
  }

  // 3) SUPERSEDED CHAINS for non-entity, non-always-keep types (e.g. a fact whose value changed via
  //    supersedes without going through the typed entity layer). Collapse each chain to: the latest
  //    row in full, plus a one-line history note. Chains of length 1 (nothing superseded) pass
  //    through untouched to the near-duplicate step below.
  const chainEligible = safeRows.filter((r) => !ALWAYS_KEEP_TYPES.has(r.type) && r.type !== "entity");
  const chainHeads = chainEligible.filter((r) => !isSuperseded(r));
  const genericChains = [];
  const rowsAlreadyInAChain = new Set();
  for (const head of chainHeads) {
    const chain = supersededChain(head, chainEligible);
    if (chain.length <= 1) continue; // not actually a chain, leave for dedupe/status handling
    for (const r of chain) rowsAlreadyInAChain.add(r.id);
    const priorValues = chain.slice(0, -1).map((r) => r.text || "");
    const historyNote = `${head.type} ${head.id || "?"}: superseded ${priorValues.length} earlier value(s) (from ${chain[0].ts || "?"} id=${chain[0].id || "?"}): ${priorValues.join(" -> ")} -> ${head.text || ""}`;
    genericChains.push({ row: head, historyNote, chainLength: chain.length });
  }

  // 4) Everything else: candidates for near-duplicate clustering and low-signal digesting.
  const remaining = chainEligible.filter((r) => !rowsAlreadyInAChain.has(r.id));
  const lowSignal = remaining.filter((r) => r.type === LOW_SIGNAL_TYPE);
  const otherRemaining = remaining.filter((r) => r.type !== LOW_SIGNAL_TYPE);

  // 4a) Near-duplicate clustering on the non-low-signal remainder (facts and anything else that is
  //     not a decision/correction/pitfall/entity/status). Each cluster collapses to one representative
  //     row (the most recent in the cluster) plus a count annotation.
  const clusters = clusterNearDuplicates(otherRemaining, dupThreshold);
  const consolidatedFacts = clusters.map((cluster) => {
    const sorted = cluster.slice().sort(byTsDesc);
    return { row: sorted[0], count: cluster.length, isDuplicateCluster: cluster.length > 1 };
  });

  // 4b) Low-signal (status) digesting: keep the most recent N in full AND anything newer than the
  //     recency window, roll the rest into one digest row.
  const lowSignalSorted = lowSignal.slice().sort(byTsDesc);
  const cutoffMs = now - statusKeepDays * 24 * 3600 * 1000;
  const keptLowSignal = [];
  const digestedLowSignal = [];
  lowSignalSorted.forEach((r, i) => {
    const tsMs = r.ts ? Date.parse(r.ts) : NaN;
    const withinRecentWindow = i < statusKeepRecent || (!Number.isNaN(tsMs) && tsMs >= cutoffMs);
    if (withinRecentWindow) keptLowSignal.push(r);
    else digestedLowSignal.push(r);
  });
  let statusDigest = null;
  if (digestedLowSignal.length) {
    const sortedAsc = digestedLowSignal.slice().sort(byTsAsc);
    const startDate = (sortedAsc[0].ts || "").slice(0, 10) || "?";
    const endDate = (sortedAsc[sortedAsc.length - 1].ts || "").slice(0, 10) || "?";
    statusDigest = {
      count: digestedLowSignal.length,
      startDate,
      endDate,
      text: `${digestedLowSignal.length} additional ${LOW_SIGNAL_TYPE} updates between ${startDate} and ${endDate} (collapsed)`,
    };
  }

  // ---- assemble stats -----------------------------------------------------------------------
  const preservedVerbatimCount =
    alwaysKeep.length +
    currentEntities.length +
    genericChains.length + // the latest row of each chain is preserved verbatim
    consolidatedFacts.length + // the representative row of each cluster is preserved verbatim
    keptLowSignal.length;

  const collapsedCount =
    genericChains.reduce((n, c) => n + (c.chainLength - 1), 0) +
    currentEntities.reduce((n, c) => n + Math.max(0, (c.chainLength || 1) - 1), 0) +
    consolidatedFacts.reduce((n, c) => n + Math.max(0, c.count - 1), 0) +
    digestedLowSignal.length;

  const after =
    alwaysKeep.length +
    currentEntities.length +
    genericChains.length +
    consolidatedFacts.length +
    keptLowSignal.length +
    (statusDigest ? 1 : 0);

  return {
    decisions: alwaysKeep.filter((r) => r.type === "decision").sort(byTsDesc),
    corrections: alwaysKeep.filter((r) => r.type === "correction").sort(byTsDesc),
    pitfalls: alwaysKeep.filter((r) => r.type === "pitfall").sort(byTsDesc),
    currentEntities: currentEntities.sort((a, b) => String(a.ekey).localeCompare(String(b.ekey))),
    supersededChains: genericChains.sort((a, b) => byTsDesc(a.row, b.row)),
    consolidatedFacts: consolidatedFacts.sort((a, b) => byTsDesc(a.row, b.row)),
    lowSignalKept: keptLowSignal,
    statusDigest,
    stats: {
      before,
      after,
      preserved: preservedVerbatimCount,
      collapsed: collapsedCount,
    },
  };
}

// ---- markdown rendering ---------------------------------------------------------------------

function fmtRow(r) {
  const ts = (r.ts || "").slice(0, 10) || "?";
  const id = r.id || "?";
  const was = r.was ? ` (was: ${r.was})` : "";
  return `- [${ts}] ${r.text}${was}  \`${id}\``;
}

// Render the compaction result to a markdown artifact. Pure: builds and returns a string, never
// writes to disk (the CLI wrapper is responsible for that).
export function renderMarkdown(result, sourceLabel = "ledger") {
  const s = result.stats;
  let md = `# Compacted Ledger Summary (${sourceLabel})\n\n`;
  md += `Source rows: ${s.before}. Compacted rows: ${s.after}. Preserved verbatim: ${s.preserved}. Collapsed: ${s.collapsed}.\n\n`;
  md += `This is a derived, read-only summary. The source ledger is unchanged and remains the system of record.\n\n`;

  md += `## Decisions\n\n`;
  md += result.decisions.length ? result.decisions.map(fmtRow).join("\n") + "\n\n" : "- (none)\n\n";

  md += `## Corrections\n\n`;
  md += result.corrections.length
    ? result.corrections.map((r) => `- [${(r.ts || "").slice(0, 10)}] WAS: ${r.was || "?"} -> NOW: ${r.text}  \`${r.id || "?"}\``).join("\n") + "\n\n"
    : "- (none)\n\n";

  md += `## Pitfalls\n\n`;
  md += result.pitfalls.length ? result.pitfalls.map(fmtRow).join("\n") + "\n\n" : "- (none)\n\n";

  md += `## Current Entity Values\n\n`;
  if (result.currentEntities.length) {
    for (const e of result.currentEntities) {
      md += `- \`${e.ekey}\` = ${e.row.evalue ?? e.row.text ?? ""}  \`${e.row.id || "?"}\`\n`;
      if (e.historyNote) md += `  - history: ${e.historyNote}\n`;
    }
    md += "\n";
  } else {
    md += "- (none)\n\n";
  }

  md += `## Superseded Chains (non-entity)\n\n`;
  if (result.supersededChains.length) {
    for (const c of result.supersededChains) {
      md += `${fmtRow(c.row)}\n`;
      md += `  - history: ${c.historyNote}\n`;
    }
    md += "\n";
  } else {
    md += "- (none)\n\n";
  }

  md += `## Consolidated Facts\n\n`;
  if (result.consolidatedFacts.length) {
    for (const c of result.consolidatedFacts) {
      const suffix = c.isDuplicateCluster ? ` (x${c.count}, near-duplicate cluster collapsed)` : "";
      md += `${fmtRow(c.row)}${suffix}\n`;
    }
    md += "\n";
  } else {
    md += "- (none)\n\n";
  }

  md += `## Status Digest\n\n`;
  if (result.lowSignalKept.length) {
    md += `Recent (kept in full):\n` + result.lowSignalKept.slice().sort(byTsDesc).map(fmtRow).join("\n") + "\n\n";
  }
  md += result.statusDigest ? `- ${result.statusDigest.text}\n` : "- (no older status rows to digest)\n";

  return md;
}

// Render the compaction result as ndjson (same row shape as the source ledger), for tooling that
// wants to keep reading a flat list of rows rather than the markdown sections. Pure; the CLI writes
// this to a separate file.
export function renderNdjson(result) {
  const rows = [];
  for (const r of result.decisions) rows.push(r);
  for (const r of result.corrections) rows.push(r);
  for (const r of result.pitfalls) rows.push(r);
  for (const e of result.currentEntities) {
    rows.push(e.row);
    if (e.historyNote) rows.push({ type: "compaction-note", text: e.historyNote, ekey: e.ekey });
  }
  for (const c of result.supersededChains) {
    rows.push(c.row);
    rows.push({ type: "compaction-note", text: c.historyNote });
  }
  for (const c of result.consolidatedFacts) {
    rows.push(c.isDuplicateCluster ? { ...c.row, compactionCount: c.count } : c.row);
  }
  for (const r of result.lowSignalKept) rows.push(r);
  if (result.statusDigest) rows.push({ type: "compaction-digest", text: result.statusDigest.text });
  return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

// ---- CLI ------------------------------------------------------------------------------------

function isMain() {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
}

function runCli() {
  const argv = process.argv.slice(2);
  const ledgerPath = argv.find((a) => !a.startsWith("--"));
  if (!ledgerPath) {
    console.error("usage: node compact.mjs <ledger-path> [--out <path>] [--ndjson]");
    process.exit(2);
  }
  const outIdx = argv.indexOf("--out");
  const outPath = outIdx >= 0 && argv[outIdx + 1] ? argv[outIdx + 1] : `${ledgerPath}.compacted.md`;
  const emitNdjson = argv.includes("--ndjson");

  let text;
  try {
    text = readFileSync(ledgerPath, "utf8");
  } catch (e) {
    console.error(`ledger-compaction: could not read ${ledgerPath}: ${e.message}`);
    process.exit(1);
  }

  const { rows, errors } = parseLedgerText(text);
  if (errors.length) {
    console.error(`ledger-compaction: skipped ${errors.length} unparseable line(s), e.g. line ${errors[0].line}`);
  }

  const result = compactLedger(rows);
  const md = renderMarkdown(result, ledgerPath);

  // Write only to the separate output path. Never write back to ledgerPath.
  writeFileSync(outPath, md, "utf8");
  let ndjsonPath = null;
  if (emitNdjson) {
    ndjsonPath = outPath.replace(/\.md$/, "") + ".compacted.ndjson";
    if (ndjsonPath === ledgerPath) ndjsonPath = `${ledgerPath}.compacted.ndjson`; // never touch the source
    writeFileSync(ndjsonPath, renderNdjson(result), "utf8");
  }

  console.log(JSON.stringify({ ...result.stats, outPath, ndjsonPath, parseErrors: errors.length }));
}

if (isMain()) runCli();
