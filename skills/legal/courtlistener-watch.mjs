#!/usr/bin/env node
// courtlistener-watch.mjs — polls a CourtListener docket for entries filed since the matter's
// last check, and stages any new ones into the matter's docket as CANDIDATES
// (source:'courtlistener', verified:false). Confirm-before-page: a staged entry is real court
// activity, but is NOT treated as an actionable, page-worthy deadline until a human (the CLO)
// confirms it, via `node legal.mjs docket verify <id> <date> "<what>"`. That reuses legal.mjs's
// shared docket-mutation path (see that file's header for the full row schema); this script never
// re-implements Azure Blob access itself.
//
// Uses legal.mjs's SAME CourtListener REST v4 pattern as `cite`/`caselaw`: free without a token,
// `LEGAL_COURTLISTENER_TOKEN` (Matt's/the CLO's own account) raises rate limits and is required
// for reliable production polling -- live polling is effectively Matt-auth-gated.
//
// FIXTURE-TESTABLE: fetchDocketEntries() takes an injectable `fetchFn` (defaults to global
// fetch), so tests drive it with a canned response and never touch the real network.
//
// Usage:
//   node courtlistener-watch.mjs poll <matter-id> --docket <courtlistener-docket-id> [--personal]
//   node courtlistener-watch.mjs poll <matter-id> [--personal]              # reuses the docket id
//                                                                            # saved on a prior poll
//   node courtlistener-watch.mjs poll <matter-id> --docket <id> --dry-run [--json]  # preview only

import { pathToFileURL } from "node:url";
import { getMatter, putMatter, docketAddMany, ensureStore } from "./legal.mjs";

const CL_BASE = "https://www.courtlistener.com/api/rest/v4";
const collapseWs = (s) => String(s || "").replace(/\s+/g, " ").trim();

// One raw CourtListener docket-entry object (fields per the DocketEntry REST v4 shape:
// date_filed, entry_number, description) -> {date, what}, or null if it carries no usable date.
// Defensively falls back to alternate field names in case the live schema varies slightly.
export function normalizeEntry(raw) {
  if (!raw) return null;
  const dateRaw = raw.date_filed || raw.date_created || raw.date || null;
  if (!dateRaw) return null;
  const date = String(dateRaw).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const desc = collapseWs(raw.description || raw.short_description || raw.plain_text || "(no description)");
  const label = raw.entry_number != null ? `Docket Entry #${raw.entry_number}: ${desc}` : desc;
  return { date, what: label.slice(0, 500) };
}

// Normalized {date, what}[] -> only the entries strictly newer than `since` (a YYYY-MM-DD
// string, or falsy for "first ever poll", which returns everything). Pure; no I/O.
export function selectNewEntries(entries, since) {
  const list = (entries || []).filter(Boolean);
  if (!since) return list;
  return list.filter((e) => e.date > since);
}

// Normalized {date, what}[] -> docket-row-shaped CANDIDATES. Deliberately does NOT call
// legal.mjs's docketAdd/docketAddMany here -- staging shape stays a pure, offline-testable
// function; the CLI (`poll`) is the only place that performs the actual write.
export function stageRows(entries, source = "courtlistener") {
  return (entries || []).map((e) => ({ date: e.date, what: e.what, source, verified: false }));
}

// Fetch every docket-entries page for `docketId` (DRF pagination via `next`), bounded to
// `maxPages` so a runaway/misconfigured docket id can never loop unbounded. `fetchFn` is
// injectable (tests pass a stub that returns canned JSON; production defaults to global fetch,
// mirroring legal.mjs's cite/caselaw header + auth pattern).
export async function fetchDocketEntries(docketId, { fetchFn = fetch, token, maxPages = 10 } = {}) {
  if (!docketId) throw new Error("fetchDocketEntries requires a docketId");
  const headers = { "User-Agent": "otchealth-clo/1.0" };
  if (token) headers.Authorization = `Token ${token}`;
  let url = `${CL_BASE}/docket-entries/?docket=${encodeURIComponent(docketId)}&order_by=date_filed`;
  const out = [];
  for (let page = 0; url && page < maxPages; page++) {
    const r = await fetchFn(url, { headers });
    if (!r.ok) throw new Error(`CourtListener HTTP ${r.status} fetching docket entries (try again, or set LEGAL_COURTLISTENER_TOKEN)`);
    const j = await r.json();
    out.push(...(j.results || []));
    url = j.next || null;
  }
  return out;
}

// ---- CLI ----
async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const personal = argv.includes("--personal");
  const NS = personal ? "personal" : "company";
  const flagVal = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  const usage = 'usage: courtlistener-watch.mjs poll <matter-id> [--docket <courtlistener-docket-id>] [--personal] [--dry-run] [--json]';
  try {
    if (cmd !== "poll") { console.error(usage); process.exit(2); }
    const id = argv[1];
    if (!id) { console.error(usage); process.exit(2); }

    ensureStore();
    const m = await getMatter(NS, id);
    if (!m) { console.error("no such matter " + id); process.exit(1); }

    const docketId = flagVal("docket") || m.courtlistener?.docket_id;
    if (!docketId) { console.error("no CourtListener docket id on file: pass --docket <id> (it is saved on the matter for future polls)"); process.exit(2); }
    const since = m.courtlistener?.last_checked || null;

    const raw = await fetchDocketEntries(docketId, { token: process.env.LEGAL_COURTLISTENER_TOKEN });
    const fresh = selectNewEntries(raw.map(normalizeEntry).filter(Boolean), since);
    const staged = stageRows(fresh);

    if (argv.includes("--dry-run")) {
      if (argv.includes("--json")) { console.log(JSON.stringify(staged, null, 2)); }
      else {
        console.log(`${staged.length} new entr${staged.length === 1 ? "y" : "ies"} since ${since || "(first poll)"} on docket ${docketId} (dry-run, nothing written):`);
        for (const s of staged) console.log(`  ${s.date}  ${s.what}`);
      }
      return;
    }

    const added = staged.length ? await docketAddMany(NS, id, staged) : [];
    // Bump last_checked on a FRESHLY-reloaded matter (docketAddMany already wrote the new docket
    // rows above); avoids clobbering that write with a stale in-memory copy of `m`.
    const m2 = await getMatter(NS, id);
    m2.courtlistener = { docket_id: docketId, last_checked: new Date().toISOString().slice(0, 10) };
    await putMatter(NS, id, m2);

    console.log(`staged ${added.length} new docket entr${added.length === 1 ? "y" : "ies"} on ${NS}/${id} from CourtListener docket ${docketId} [courtlistener, UNVERIFIED]`);
    if (added.length) console.log(`confirm one: node legal.mjs docket verify ${id} <date> "<what-substring>"${personal ? " --personal" : ""}`);
  } catch (e) { console.error("ERROR: " + e.message); process.exit(1); }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) { await main(); }
