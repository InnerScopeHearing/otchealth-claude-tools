# REVENUE-TRACKER-PATCH.md
## Fix the $25K gate so it counts NEW reignition revenue only

**Owner:** CFO  
**Target file:** `otchealth-cto/docs/medvi/revenue-tracker.mjs`  
**Produced:** 2026-06-30  
**Grounded in:** EXECUTION-PROGRAM.md (CFO row, gap #6, Phase-0 row 1), CASH-PLAYBOOK SOP-7  
**Ring:** Non-PHI.

---

## 1. The bug (why this is a P0 instrument fix)

As written, `revenue-tracker.mjs` sums **all-time** paid orders (`totalPaid`) and measures that total against the `$25,000` OTC gate:

```js
const pct = Math.min(100, (totalPaid / GATE) * 100);
```

The store has done **$227,290 all-time**. So on its very first run the tracker prints **~100% of the $25K gate already cleared** and `Remaining to unlock OTC line: $0.00`. **The single instrument that is supposed to authorize FDA / OTC-line spend would green-light it on phantom (pre-reignition) revenue.** (EXECUTION-PROGRAM gap #6.)

The mission is **REIGNITION**: the gate must measure NEW revenue generated from the reignition forward, not the dormant store's history. The all-time figure stays visible on its own line for context; it just stops counting toward the gate.

---

## 2. The change (minimal, surgical)

Add a `REIGNITION_START_DATE` (env-overridable, defaults to the reignition kickoff date). Accumulate a NEW counter, `reignitionPaid`, for paid orders **on or after** that date. Measure the `$25K` gate against `reignitionPaid`. Keep `totalPaid` reported all-time on its own line.

This reuses the loop's existing per-order `paid` flag and `day` (the `o.created_at` slice already computed for the today/90-day logic), so it adds one comparison and one accumulator, no new API calls.

---

## 3. BEFORE / AFTER snippets

### 3a. Constants and counters

**BEFORE**
```js
const version = process.env.SHOPIFY_API_VERSION || '2026-04';
const H = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
const GATE = 25000;
```

**AFTER**
```js
const version = process.env.SHOPIFY_API_VERSION || '2026-04';
const H = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
const GATE = 25000;
// The $25K OTC gate measures NEW reignition revenue only, NOT the dormant store's
// $227,290 all-time history. Orders before this date are reported for context but do
// NOT count toward the gate. Override with REIGNITION_START_DATE=YYYY-MM-DD.
const REIGNITION_START_DATE = process.env.REIGNITION_START_DATE || '2026-06-30';
```

### 3b. The accumulators

**BEFORE**
```js
let totalPaid = 0, paidCount = 0, todayRevenue = 0, todayCount = 0, treoUnits = 0, treoRevenue = 0, pages = 0;
const since = new Date(Date.now() - 90*864e5).toISOString().slice(0,10);
let recent90 = 0;
```

**AFTER**
```js
let totalPaid = 0, paidCount = 0, todayRevenue = 0, todayCount = 0, treoUnits = 0, treoRevenue = 0, pages = 0;
const since = new Date(Date.now() - 90*864e5).toISOString().slice(0,10);
let recent90 = 0;
// NEW: revenue + order count since the reignition started (this is what the gate measures)
let reignitionPaid = 0, reignitionCount = 0;
```

### 3c. Inside the per-order loop

**BEFORE**
```js
    if (paid) { totalPaid += amt; paidCount++; }
    const day = (o.created_at || '').slice(0,10);
    if (day === today && paid) { todayRevenue += amt; todayCount++; }
    if (day >= since && paid) recent90 += amt;
```

**AFTER**
```js
    if (paid) { totalPaid += amt; paidCount++; }
    const day = (o.created_at || '').slice(0,10);
    if (day === today && paid) { todayRevenue += amt; todayCount++; }
    if (day >= since && paid) recent90 += amt;
    // NEW: only orders on/after the reignition start date count toward the $25K gate
    if (day >= REIGNITION_START_DATE && paid) { reignitionPaid += amt; reignitionCount++; }
```

### 3d. The gate computation and the printout

**BEFORE**
```js
const pct = Math.min(100, (totalPaid / GATE) * 100);
const bar = '█'.repeat(Math.round(pct/5)) + '░'.repeat(20 - Math.round(pct/5));
console.log(`OTCHEALTH DAILY HEARTBEAT — ${today}`);
console.log(`================================================`);
console.log(`Today:        $${todayRevenue.toFixed(2)} across ${todayCount} paid order(s)`);
console.log(`Last 90 days: $${recent90.toFixed(2)}`);
console.log(`All-time paid: $${totalPaid.toFixed(2)} across ${paidCount} orders${pages>=20?' (capped at 20 pages — true total higher)':''}`);
console.log(`iHEAR TReO:   ${treoUnits} unit(s), ~$${treoRevenue.toFixed(2)} line revenue`);
console.log(`------------------------------------------------`);
console.log(`$25K OTC GATE: [${bar}] ${pct.toFixed(1)}%  ($${totalPaid.toFixed(0)} / $${GATE})`);
console.log(`Remaining to unlock OTC line: $${Math.max(0, GATE-totalPaid).toFixed(2)}`);
console.log(`TRACKER_DONE`);
```

**AFTER**
```js
// The gate measures REIGNITION revenue, not all-time (the dormant store's $227,290
// would otherwise print a false ~100% on the first run and green-light OTC/FDA spend).
const pct = Math.min(100, (reignitionPaid / GATE) * 100);
const bar = '█'.repeat(Math.round(pct/5)) + '░'.repeat(20 - Math.round(pct/5));
console.log(`OTCHEALTH DAILY HEARTBEAT — ${today}`);
console.log(`================================================`);
console.log(`Today:        $${todayRevenue.toFixed(2)} across ${todayCount} paid order(s)`);
console.log(`Last 90 days: $${recent90.toFixed(2)}`);
console.log(`All-time paid: $${totalPaid.toFixed(2)} across ${paidCount} orders (context only — does NOT count toward the gate)${pages>=6?' (page cap hit — true total higher)':''}`);
console.log(`Reignition (since ${REIGNITION_START_DATE}): $${reignitionPaid.toFixed(2)} across ${reignitionCount} paid order(s)`);
console.log(`iHEAR TReO:   ${treoUnits} unit(s), ~$${treoRevenue.toFixed(2)} line revenue`);
console.log(`------------------------------------------------`);
console.log(`$25K OTC GATE (reignition revenue): [${bar}] ${pct.toFixed(1)}%  ($${reignitionPaid.toFixed(0)} / $${GATE})`);
console.log(`Remaining to unlock OTC line: $${Math.max(0, GATE-reignitionPaid).toFixed(2)}`);
console.log(`TRACKER_DONE`);
```

---

## 4. Behavior before vs after the patch

| | BEFORE (buggy) | AFTER (fixed) |
|---|---|---|
| First run, $0 new revenue | `$25K GATE: 100.0% ($227290 / $25000)` -> falsely cleared | `$25K GATE (reignition revenue): 0.0% ($0 / $25000)` -> correctly empty |
| All-time figure | counts toward gate | shown on its own line, context only |
| After a $9,801 reignition wave | still ~100% (noise) | `39.2% ($9801 / $25000)`, `Remaining: $15,199.00` |
| OTC/FDA spend trigger (SOP-7) | fires on phantom history | fires only on real NEW reignition cash |

---

## 5. Notes for the CTO who lands this

- **One-line override** keeps it operable per the copy-paste-first preference: `REIGNITION_START_DATE=2026-07-01 node revenue-tracker.mjs` to roll the basis forward if the official send date differs from 2026-06-30.
- **No new Shopify calls, no new scopes**: the patch reuses the already-fetched `o.created_at` and the existing `paid` flag, so it is read-only and cost-neutral.
- **Page-cap note corrected**: the original printed a `pages>=20` caption but the loop caps at `pages < 6`; the AFTER snippet fixes that to `pages>=6` so the "true total higher" warning actually fires when the cap is hit. (Minor truthfulness fix to the same line we were already editing.)
- This is the instrument that the daily contribution heartbeat (EXECUTION-PROGRAM step) and the SOP-7 $25K alert both read. Landing it BEFORE the send means the very first reignition dollar is measured against an honest gate.

---

*Non-PHI ring. Read-only tracker. TReO = PSAP. Land on a `claude/*` feature branch, draft PR.*
