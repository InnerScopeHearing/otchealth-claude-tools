// Detector 4: a grant/credit that is ACTIVE and expiring soon with no re-evaluation. HIGH PRECISION
// rationale: this is a pure date-arithmetic read of grants.json (the existing grant-tracker skill's own
// data file), so there is zero measurement noise, zero false data source; the only tunable is the
// "how soon is soon" window (mirrors grant-tracker's own <=60d "use or lose" flag exactly, so Radar
// never disagrees with the tool of record). Also flags a HARD floor case: an 'active' grant whose term
// already lapsed (dleft < 0) but status was never updated, which is a "we might be paying without
// knowing" miss the plain tracker table does not shout about on its own.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { makeSignal } from "../schema.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const NAME = "grant-burn-expiry";
export const OWNER = "cfo"; // burn/finance domain

const EXPIRING_SOON_DAYS = 60; // matches grant-tracker's own "use or lose" flag

/** Pure core: given the grants array + "now", classify each ACTIVE grant. Exported for hermetic tests. */
export function classifyGrants(grants, now = new Date()) {
  const out = [];
  for (const g of grants || []) {
    if (g.status !== "active") continue;
    if (!g.added || !g.termMonths) { out.push({ name: g.name, condition: "no-term-data" }); continue; }
    const exp = new Date(g.added);
    exp.setMonth(exp.getMonth() + g.termMonths);
    const daysLeft = Math.round((exp - now) / 86400000);
    if (daysLeft < 0) out.push({ name: g.name, condition: "lapsed-but-still-active", daysLeft, lane: g.lane });
    else if (daysLeft <= EXPIRING_SOON_DAYS) out.push({ name: g.name, condition: "expiring-soon", daysLeft, lane: g.lane });
    else out.push({ name: g.name, condition: "healthy", daysLeft, lane: g.lane });
  }
  return out;
}

export async function run() {
  const notes = [];
  let grantsPath = join(HERE, "..", "..", "grant-tracker", "grants.json");
  let data;
  try { data = JSON.parse(readFileSync(grantsPath, "utf8")); }
  catch (e) { notes.push(`could not read grant-tracker/grants.json: ${e.message}`); return { signals: [], notes }; }

  const classified = classifyGrants(data.grants, new Date());
  const signals = [];
  for (const g of classified) {
    if (g.condition === "expiring-soon") {
      signals.push(makeSignal({
        detector: NAME, owner: OWNER, subject: g.name, severity: g.daysLeft <= 14 ? "high" : "medium",
        why: `Grant "${g.name}" (${g.lane}) expires in ${g.daysLeft} day(s) - use it or lose the remaining credit.`,
        evidence_link: null,
        suggested_action: `Check actual burn on the ${g.name} vendor dashboard; spend down or renegotiate the term before it lapses.`,
      }));
    } else if (g.condition === "lapsed-but-still-active") {
      signals.push(makeSignal({
        detector: NAME, owner: OWNER, subject: g.name, severity: "high",
        why: `Grant "${g.name}" (${g.lane}) shows status=active but its term lapsed ${Math.abs(g.daysLeft)} day(s) ago in grants.json - it may now be billing at full cash rate.`,
        evidence_link: null,
        suggested_action: `Verify on the vendor billing page whether the grant/credit actually renewed or converted to paid; update grants.json status either way.`,
      }));
    }
  }
  return { signals, notes };
}
