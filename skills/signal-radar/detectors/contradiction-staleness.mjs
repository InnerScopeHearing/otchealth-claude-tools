// Detector 6: CONTRADICTION + STALENESS over the shared exec memory feed. SELF-IMPROVING-LOOP item #2.
//
// WHY (report-mode discipline): the fleet's kb-memory ledger is append-only and newest-wins, but a NEW
// row can silently CONTRADICT a still-active older row (a flip-flop the agent forgot to `correct`), or
// make an older status/decision STALE-with-material-drift. Nobody notices until the wrong belief bites.
// This detector reads the SHARED exec feed (the SAME Azure blob lanes company-brain / reflect read -
// otchealthcommons/company-journal/_MEMORY/_exec/<agent>.jsonl), computes a COARSE deterministic
// entity-key per row AT SCAN TIME (reusing mem.mjs's normKey over a lexical key extracted from the row),
// and for each RECENT row runs ONE bounded LLM entailment call against a same-entity-key candidate slice.
//
// HIGH PRECISION rationale (the levers that keep this from crying wolf):
//   1. GROUNDING GATE - the model MUST cite the exact prior row id, and the verdict is DISCARDED if that
//      id is not in the slice we handed it (kills hallucinated-contradiction false positives).
//   2. MATERIALITY FLOOR - only 'contradict' and 'stale-with-material-drift' fire. 'agree' / 'supersede'
//      / 'paraphrase' NEVER fire (normal supersession - a build bump, a status flip to done - is not a
//      contradiction, and this is the single biggest false-positive source if not explicitly modeled).
//   3. BOUNDED COST - only rows in a rolling recent window (default 7d) are examined; each same-entity
//      slice is capped at <=20 rows; total LLM calls per scan capped (default 40) with a NO-SILENT-
//      TRUNCATION note when the cap bites.
//
// REPORT-MODE / OBSERVE-ONLY: this detector NEVER writes or modifies the memory ledger. It ONLY EMITS a
// Signal (a report) whose suggested_action DRAFTS the exact `mem.mjs correct ...` command a human/agent
// may choose to run - mirroring the fleet's "self-repair drafts, never auto-merges" line.
//
// GUARDRAILS: PHI (isPhiExcluded) and MNPI (isMnpiSubject) are respected. radar.mjs applies the MNPI
// hard-route centrally AFTER a detector returns; this detector additionally REFUSES to send any
// MNPI/PHI-adjacent row text through the LLM prompt in the first place (defense in depth - the row is
// dropped from candidate slices before the entailment call ever sees it).
//
// FAIL-OPEN: run() matches runDetectorSafely's contract - on no-Cosmos / no-network / no-creds it
// returns { signals: [], notes: [...] } and NEVER throws.
import crypto from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { makeSignal, isMnpiSubject, isPhiExcluded } from "../schema.mjs";
import { TIERS, chatBody } from "../../../setup/model-routing.mjs";

export const NAME = "contradiction-staleness";
export const OWNER = "cto"; // memory-integrity is an infra/portfolio concern; MNPI rows still hard-route to cfo centrally.

// ------------------------------ tunables (all env-overridable, bounded) ------------------------------
const WINDOW_DAYS = Number(process.env.CONTRADICTION_WINDOW_DAYS) || 7; // only examine rows this recent
const MAX_CANDIDATES = 20;                                              // hard cap on the same-entity slice (design §1b)
const MAX_LLM_CALLS = Number(process.env.CONTRADICTION_MAX_LLM_CALLS) || 40; // total entailment calls per scan
const STALE_MIN_AGE_DAYS = Number(process.env.CONTRADICTION_STALE_MIN_DAYS) || 21; // a stale verdict needs the prior row to be at least this old

// Row types that make a TRUTH CLAIM worth comparing. pitfalls are excluded (they are meta-lessons, not
// current-state assertions); aliases/status-of-others are not truth claims about an entity's value.
const CLAIM_TYPES = new Set(["fact", "decision", "correction", "entity", "status"]);

// ---------------------------------- entity-key extraction (pure) ----------------------------------
// mirrors mem.mjs's normKey() so the keys line up with the deterministic entity layer.
const normKey = (s) => (s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

// Closed, fleet-specific vocabulary - cheap + precise BECAUSE it is a closed list, not open NER. This is
// the same ~universe RING_DENY / isMnpiSubject already hardcode (apps, vendors, infra pieces, secrets).
const KNOWN_ENTITIES = [
  "iheartest", "plantid", "flatstick", "fourvault", "aware", "innerease", "medreview", "companion",
  "fictionary", "otchealthmart", "innd",
  "azure ai search", "cosmos", "container apps job", "container apps jobs", "posthog", "sentry",
  "revenuecat", "depot", "codemagic", "xero", "quickbooks", "qbo", "plaid", "stripe", "n8n",
  "app store connect", "testflight", "cfbundleversion", "secret manager", "key vault", "cloudflare",
];

/**
 * Deterministic, LLM-free entity-key extraction over a row's text + tags. Returns a de-duped array of
 * coarse keys. Precision over recall: missing an entity means the row just is not scanned (safe); a
 * false-tag only slightly widens a bounded slice (still cheap) - never a false contradiction, because
 * the LLM entailment step is the real gate. Exported for hermetic unit testing.
 */
export function extractEntityKeys(text, tags = []) {
  const hay = `${text || ""} ${(tags || []).join(" ")}`.toLowerCase();
  const hits = new Set();
  for (const phrase of KNOWN_ENTITIES) {
    // word-boundary-ish match: the phrase must appear as a whole token run, not inside a bigger word.
    const re = new RegExp(`(?:^|[^a-z0-9])${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[^a-z0-9]|$)`, "i");
    if (re.test(hay)) hits.add(normKey(phrase));
  }
  // secret-manager-id-shaped tokens (e.g. "azure-search-admin-key", "revenuecat-secret-key"): kebab-case
  // with a credential-shaped suffix. These are the exact "which value is current" flip-flops we care about.
  for (const m of hay.matchAll(/\b[a-z][a-z0-9]*(?:-[a-z0-9]+){1,5}\b/g)) {
    if (/-(key|secret|token|id|url|endpoint|sa|p8|dsn)$/.test(m[0])) hits.add(m[0]);
  }
  return [...hits];
}

// -------------------------------- ring wall (defense in depth, pure) --------------------------------
// The same MNPI/PHI markers mem.mjs's RING_DENY uses. A row that trips this is NEVER put into a slice /
// sent through the LLM prompt (never leak INND securities or PHI-adjacent text to the entailment call).
const RING_DENY = /\b(innd|otcmkts|ticker|reg\s*[da]\b|rule\s*144|form\s*s-?1|8-?k|10-?[qk]|share\s*price|stock\s*price|materially?\s*non.?public|mnpi|reg\s*fd|dividend|patient|\bphi\b|diagnos|medication|prescrib|hipaa|audiogram|hearing\s*number)\b/i;
export function ringSafe(row) {
  if (!row) return false;
  const blob = `${row.text || ""} ${(row.tags || []).join(" ")} ${row.was || ""} ${row.evalue || ""} ${row.ekey || ""}`;
  if (RING_DENY.test(blob)) return false;
  if (isMnpiSubject(NAME, `${row.agent || ""} ${row.text || ""}`)) return false;
  if (isPhiExcluded(row.agent)) return false;
  return true;
}

// ------------------------------------- candidate slice (pure) -------------------------------------
/**
 * For a NEW row `r`, build the same-entity-key candidate prior-row slice from `allRows`:
 *   - strictly OLDER than r (by ts, then id)
 *   - a claim type
 *   - shares >= 1 entity key with r (keys taken from r.ekeys / computed lazily by the caller)
 *   - not itself already superseded (walk `supersedes` - only the ACTIVE row is a live truth claim)
 *   - ring-safe (no MNPI/PHI text goes into the prompt)
 *   - not r itself
 * Capped at maxCandidates, keeping the MOST RECENT (recency is what matters for staleness). Pure/testable.
 */
export function candidateSlice(allRows, r, opts = {}) {
  const maxCandidates = opts.maxCandidates ?? MAX_CANDIDATES;
  const rKeys = new Set(r.ekeys && r.ekeys.length ? r.ekeys : extractEntityKeys(r.text, r.tags));
  if (!rKeys.size) return [];
  // ids that have been superseded by SOME row -> not a live claim.
  const superseded = new Set();
  for (const x of allRows) if (x.supersedes) superseded.add(x.supersedes);
  const rTs = Date.parse(r.ts || "") || 0;
  const out = [];
  for (const p of allRows) {
    if (p === r) continue;
    if (p.id && r.id && p.id === r.id && (p.agent || "") === (r.agent || "")) continue;
    if (!CLAIM_TYPES.has(p.type)) continue;
    if (superseded.has(p.id)) continue;
    const pTs = Date.parse(p.ts || "") || 0;
    // strictly older: ts first, id as a deterministic tiebreaker within the same ts.
    if (pTs > rTs) continue;
    if (pTs === rTs && String(p.id || "") >= String(r.id || "")) continue;
    if (!ringSafe(p)) continue;
    const pKeys = new Set(p.ekeys && p.ekeys.length ? p.ekeys : extractEntityKeys(p.text, p.tags));
    let shares = false;
    for (const k of pKeys) if (rKeys.has(k)) { shares = true; break; }
    if (!shares) continue;
    out.push(p);
  }
  // newest-first, then keep the freshest maxCandidates (drop oldest first).
  out.sort((a, b) => (Date.parse(b.ts || "") || 0) - (Date.parse(a.ts || "") || 0) || String(b.id).localeCompare(String(a.id)));
  return out.slice(0, maxCandidates);
}

// ------------------------------------- window filter (pure) -------------------------------------
/** Rows that (a) are a claim type, (b) fall inside the recent window, (c) are ring-safe. Pure/testable. */
export function recentClaimRows(allRows, nowMs, windowDays = WINDOW_DAYS) {
  const cutoff = nowMs - windowDays * 86400000;
  return allRows.filter((r) => CLAIM_TYPES.has(r.type) && (Date.parse(r.ts || "") || 0) >= cutoff && ringSafe(r));
}

// --------------------------- grounding + materiality gate on a verdict (pure) ---------------------------
const FIRING_LABELS = new Set(["contradict", "stale-with-material-drift"]);
/**
 * Apply the GROUNDING GATE + MATERIALITY FLOOR to a raw LLM verdict against the slice it was judged on.
 * Returns a normalized verdict { fires, label, citedId, citedRow, reason } - fires is true ONLY when the
 * label is a firing label AND the citedId is a REAL row present in `slice`. Pure/testable.
 */
export function gateVerdict(verdict, slice) {
  const label = String((verdict && verdict.label) || "").toLowerCase().trim();
  const citedId = (verdict && verdict.citedId) || null;
  const reason = (verdict && verdict.reason) || "";
  if (!FIRING_LABELS.has(label)) return { fires: false, label: label || "agree", citedId: null, citedRow: null, reason };
  // GROUNDING GATE: the cited id MUST be a row we actually handed the model.
  const citedRow = slice.find((p) => p.id === citedId) || null;
  if (!citedRow) return { fires: false, label, citedId, citedRow: null, reason: "discarded: cited id not in slice (ungrounded)" };
  // STALE needs a genuinely OLD prior row (a fresh row is not "stale").
  if (label === "stale-with-material-drift") {
    const ageDays = citedRow.ts ? (Date.now() - Date.parse(citedRow.ts)) / 86400000 : 0;
    if (ageDays < STALE_MIN_AGE_DAYS) return { fires: false, label, citedId, citedRow, reason: `discarded: cited row only ${Math.round(ageDays)}d old (< ${STALE_MIN_AGE_DAYS}d stale floor)` };
  }
  return { fires: true, label, citedId, citedRow, reason };
}

// ------------------------------- the pure scan CORE (no I/O, injectable) -------------------------------
/**
 * The hermetic heart of the detector. Given a flat array of feed rows and an INJECTED async entailment
 * function, produces { signals, notes, llmCalls, truncated }. No network, no Cosmos, no clock coupling
 * beyond `nowMs`. `entail(newRow, slice)` MUST resolve to { label, citedId, reason } (see the prompt in
 * run()). This is what the unit test drives with a fake entail.
 *
 *   scanRows(rows, entail, { nowMs, windowDays, maxCandidates, maxLlmCalls })
 */
export async function scanRows(rows, entail, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const windowDays = opts.windowDays ?? WINDOW_DAYS;
  const maxCandidates = opts.maxCandidates ?? MAX_CANDIDATES;
  const maxLlmCalls = opts.maxLlmCalls ?? MAX_LLM_CALLS;
  const notes = [];
  const signals = [];
  let llmCalls = 0;
  let truncated = false;

  // annotate ekeys once (scan-time; NOT persisted to the ledger - purely additive, no write path touched).
  // Guard first: a stray non-object feed line (literal "null", a bare primitive) would otherwise throw in
  // the map and blank the WHOLE scan; drop just that line so fail-open is per-row, not per-scan.
  const annotated = rows
    .filter((r) => r && typeof r === "object")
    .map((r) => (r.ekeys ? r : { ...r, ekeys: extractEntityKeys(r.text, r.tags) }));

  const recent = recentClaimRows(annotated, nowMs, windowDays).sort(
    (a, b) => (Date.parse(a.ts || "") || 0) - (Date.parse(b.ts || "") || 0)
  );
  if (!recent.length) { notes.push(`no ring-safe claim rows in the last ${windowDays}d`); return { signals, notes, llmCalls, truncated }; }

  for (const r of recent) {
    if (llmCalls >= maxLlmCalls) { truncated = true; break; }
    const slice = candidateSlice(annotated, r, { maxCandidates });
    if (!slice.length) continue;               // no same-entity prior -> nothing to compare, no LLM call
    llmCalls++;
    let verdict;
    try { verdict = await entail(r, slice); }
    catch (e) { notes.push(`entail failed on ${r.agent || "?"}/${r.id}: ${e.message}`); continue; }
    const gated = gateVerdict(verdict, slice);
    if (!gated.fires) continue;

    const prior = gated.citedRow;
    const ageDays = prior.ts ? Math.round((nowMs - Date.parse(prior.ts)) / 86400000) : 0;
    const isContradict = gated.label === "contradict";
    const ek = (r.ekeys && r.ekeys[0]) || (prior.ekeys && prior.ekeys[0]) || "entity";
    signals.push(makeSignal({
      detector: NAME,
      owner: OWNER,
      subject: `${r.agent || "exec"}/${ek}`,
      severity: isContradict ? "high" : "medium",
      why: isContradict
        ? `${r.agent || "exec"} memory: new ${r.type} "${clip(r.text)}" CONTRADICTS still-active prior row ${prior.id} (${(prior.ts || "").slice(0, 10)}): "${clip(prior.text)}"${gated.reason ? ` [${clip(gated.reason, 120)}]` : ""}`
        : `${r.agent || "exec"} memory: prior ${prior.type} row ${prior.id} "${clip(prior.text)}" looks STALE (${ageDays}d old, material drift) given new ${r.type} "${clip(r.text)}"`,
      evidence_link: `node skills/kb-memory/mem.mjs recall "${ek.replace(/_/g, " ")}" --agent ${r.agent || "commons"}`,
      suggested_action: isContradict
        ? `Reconcile: verify which is true, then run  node skills/kb-memory/mem.mjs correct "<right belief>" --was "<wrong belief>" --agent ${r.agent || "commons"} --supersedes ${prior.id}   (a human/agent runs this; the detector never writes the ledger).`
        : `Confirm still true or supersede:  node skills/kb-memory/mem.mjs correct "<current state>" --was "${clip(prior.text, 80)}" --agent ${r.agent || "commons"} --supersedes ${prior.id}`,
    }));
  }

  if (truncated) notes.push(`LLM-call cap (${maxLlmCalls}) reached; scan TRUNCATED (not all recent rows examined this run - increase CONTRADICTION_MAX_LLM_CALLS or shorten the window).`);
  notes.push(`examined ${llmCalls} row(s) via entailment across ${recent.length} recent ring-safe claim(s).`);
  return { signals, notes, llmCalls, truncated };
}

function clip(s, n = 160) { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s; }

// ================================ I/O shell (fail-open, subprocess-safe) ================================
// Everything below is the impure edge: read the shared exec feed lanes (same blobs company-brain/reflect
// read) + resolve Azure OpenAI creds + make the real entailment call. All of it is wrapped so run()
// matches runDetectorSafely's contract (returns {signals,notes}; the top-level try/catch in run() means
// it never throws out of the detector).

const SM = "otchealth-shared-prod";
const encPath = (name) => name.split("/").map(encodeURIComponent).join("/");

function resolveSaRaw() {
  if (process.env.GCP_CLAUDE_DRIVER_SA_JSON) return process.env.GCP_CLAUDE_DRIVER_SA_JSON;
  try { const p = `${homedir()}/.gcp_claude_driver_sa.json`; if (existsSync(p)) return readFileSync(p, "utf8"); } catch {}
  return null;
}
async function smGet(id) {
  const raw = resolveSaRaw();
  if (!raw) return null;
  const sa = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);
  const e = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = `${e({ alg: "RS256", typ: "JWT" })}.${e({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  const jwt = head + "." + crypto.createSign("RSA-SHA256").update(head).sign(sa.private_key, "base64url");
  const tr = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(jwt)}` });
  const t = (await tr.json()).access_token;
  if (!t) return null;
  const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets/${id}/versions/latest:access`, { headers: { Authorization: "Bearer " + t } });
  if (!r.ok) return null;
  return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim();
}

// account SAS - identical math to mem.mjs/semantic.mjs (read-only 'r' + list 'l' is enough here).
function buildSas(acct, key) {
  const sv = "2021-12-02", sp = "rl", ss = "b", srt = "co";
  const st = new Date(Date.now() - 5 * 60000).toISOString().slice(0, 19) + "Z";
  const se = new Date(Date.now() + 2 * 3600 * 1000).toISOString().slice(0, 19) + "Z";
  const sts = [acct, sp, ss, srt, st, se, "", "https", sv, ""].join("\n") + "\n";
  const sig = crypto.createHmac("sha256", Buffer.from(key, "base64")).update(sts, "utf8").digest("base64");
  return new URLSearchParams({ sv, ss, srt, sp, st, se, spr: "https", sig }).toString();
}

/** Read every shared exec-feed lane (otchealthcommons/company-journal/_MEMORY/_exec/*.jsonl) into one
 * flat, ts-sorted array - the SAME lanes company-brain / reflect read. Returns [] on any failure. */
async function readSharedFeed() {
  const acct = process.env.KB_COMMONS_ACCOUNT || (await smGet("azure-commons-storage-account"));
  const key = await smGet("azure-commons-storage-key");
  if (!acct || !key) return { rows: [], note: "commons storage creds unavailable (azure-commons-storage-account/key) - detector idle" };
  const container = "company-journal";
  const sas = buildSas(acct, key);
  const prefix = "_MEMORY/_exec/";
  // list
  const files = [];
  let marker = "";
  do {
    let u = `https://${acct}.blob.core.windows.net/${container}?restype=container&comp=list&prefix=${encodeURIComponent(prefix)}&${sas}`;
    if (marker) u += `&marker=${encodeURIComponent(marker)}`;
    const r = await fetch(u);
    if (!r.ok) break;
    const xml = await r.text();
    for (const m of xml.matchAll(/<Name>([^<]+)<\/Name>/g)) if (m[1].endsWith(".jsonl")) files.push(m[1]);
    marker = (xml.match(/<NextMarker>([^<]+)<\/NextMarker>/) || [])[1] || "";
  } while (marker);
  const rows = [];
  for (const f of files) {
    const r = await fetch(`https://${acct}.blob.core.windows.net/${container}/${encPath(f)}?${sas}`);
    if (!r.ok) continue;
    const txt = await r.text();
    for (const ln of txt.split(/\r?\n/)) { if (!ln.trim()) continue; try { rows.push(JSON.parse(ln)); } catch {} }
  }
  rows.sort((a, b) => (a.ts || "").localeCompare(b.ts || ""));
  return { rows, note: `read ${rows.length} shared exec row(s) across ${files.length} lane(s)` };
}

// Azure OpenAI entailment call - primary then foundry-fallback, mirroring company-brain's routing so a
// transient throttle on one deployment does not silence the detector. Uses the shared model-routing
// body shape (quality tier = gpt-5.1; NOT gpt-4.1-mini - that is banned for judgment work).
async function makeEntailer() {
  const primEp = (await smGet("azure-openai-endpoint") || "").replace(/\/$/, "");
  const primKey = await smGet("azure-openai-key");
  const fbEp = (await smGet("azure-foundry-openai-endpoint") || "").replace(/\/$/, "");
  const fbKey = await smGet("azure-foundry-key");
  const providers = [];
  const primDep = process.env.CONTRADICTION_MODEL || TIERS.quality.deployment;
  if (primEp && primKey) providers.push({ ep: primEp, key: primKey, dep: primDep });
  if (fbEp && fbKey) providers.push({ ep: fbEp, key: fbKey, dep: process.env.CONTRADICTION_FALLBACK_MODEL || TIERS.quality.deployment });
  if (!providers.length) return null;

  const callOne = async (p, system, user, tries) => {
    const body = chatBody(p.dep, { messages: [{ role: "system", content: system }, { role: "user", content: user }], maxTokens: 400, jsonMode: true });
    for (let a = 0; a < tries; a++) {
      const r = await fetch(`${p.ep}/openai/deployments/${p.dep}/chat/completions?api-version=2024-06-01`, { method: "POST", headers: { "api-key": p.key, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (r.status === 429) { const ra = +(r.headers.get("retry-after") || 0); await new Promise((s) => setTimeout(s, ra ? ra * 1000 : 2000 * (a + 1))); continue; }
      if (!r.ok) throw new Error("chat " + r.status);
      return (await r.json()).choices[0].message.content;
    }
    throw Object.assign(new Error("429"), { throttled: true });
  };

  const SYS = `You are a precise fact-checker for an internal company memory ledger. You are given ONE NEW statement and a small numbered set of PRIOR statements about the same named entity. Decide, for the SINGLE prior statement (if any) that most clearly conflicts, whether the new statement:
- "agree": consistent, or merely restates/paraphrases, or adds no conflicting info.
- "supersede": a NORMAL expected update (a version/build number bump, a status flip from pending to done, a value that legitimately changed over time). NOT a contradiction.
- "contradict": the new and the prior statement cannot both be true - a real, unambiguous factual conflict.
- "stale-with-material-drift": the prior statement asserts an ongoing/current state that is implausible to still hold given the time elapsed and the new statement, though not in direct logical conflict.
Be CONSERVATIVE: prefer "supersede" or "agree" unless the conflict is unambiguous. This feeds an automated alert; false positives cost real attention. Respond with STRICT JSON only: {"label":"agree|supersede|contradict|stale-with-material-drift","citedId":"<exact prior row id, or null>","reason":"<one short sentence>"}. You MUST cite the exact prior row id you judged against when label is contradict or stale-with-material-drift.`;

  return async function entail(newRow, slice) {
    const user = `NEW (id ${newRow.id}, ${(newRow.ts || "").slice(0, 10)}, ${newRow.type}): "${clip(newRow.text, 400)}"\n\nPRIOR STATEMENTS (same entity keys: ${(newRow.ekeys || []).join(", ") || "n/a"}):\n` +
      slice.map((p) => `[${p.id}] (${(p.ts || "").slice(0, 10)}) ${p.type}: "${clip(p.text, 300)}"${p.was ? ` (was: "${clip(p.was, 120)}")` : ""}`).join("\n");
    let raw, lastErr;
    for (let i = 0; i < providers.length; i++) {
      // Fall through to the next provider on ANY failure (throttle OR e.g. a 404 when the quality-tier
      // deployment lives on foundry, not the primary endpoint), so the detector uses whichever provider
      // can serve gpt-5.1. Only if EVERY provider fails do we surface it (throttle -> fail-quiet 'agree'
      // so a busy fleet never fabricates a verdict; a hard error -> re-throw for scanRows's per-row catch).
      try { raw = await callOne(providers[i], SYS, user, i === 0 ? 3 : 5); lastErr = null; break; }
      catch (e) { lastErr = e; }
    }
    if (lastErr) { if (lastErr.throttled) return { label: "agree", citedId: null }; throw lastErr; }
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return { label: "agree", citedId: null }; } // fail-closed to silence on malformed output
    return { label: parsed.label, citedId: parsed.citedId || null, reason: parsed.reason || "" };
  };
}

export async function run() {
  const notes = [];
  try {
    const { rows, note } = await readSharedFeed();
    if (note) notes.push(note);
    if (!rows.length) return { signals: [], notes };
    const entail = await makeEntailer();
    if (!entail) { notes.push("Azure OpenAI creds unavailable (azure-openai-endpoint/key) - entailment skipped, detector idle."); return { signals: [], notes }; }
    const res = await scanRows(rows, entail, { nowMs: Date.now() });
    return { signals: res.signals, notes: notes.concat(res.notes) };
  } catch (e) {
    // FAIL-OPEN: never throw out of the detector (runDetectorSafely also catches, this is belt+braces).
    return { signals: [], notes: notes.concat([`contradiction-staleness idle (fail-open): ${e.message}`]) };
  }
}
