#!/usr/bin/env node
// synthetic-health-data / gen.mjs — fabricates realistic-but-fake records for the fleet's real
// data shapes, so dev/test/agent work never needs real PHI. Zero external deps: hand-rolled
// name/address/email pools + a seeded PRNG for reproducibility.
//
// Every value below is INVENTED. Name pools are common-first-name x common-surname combinations
// with no lookup against any real customer/patient roster; MRNs, emails, phones, addresses, dx
// codes, and notes are all generated from templates + the seeded RNG. There is no code path here
// that reads a file, hits a network endpoint, or otherwise pulls real records — this tool only
// fabricates.
//
// Usage:
//   node gen.mjs hearing-screening --count 20 --seed 42 [--csv]
//   node gen.mjs patient            --count 10 --seed 7
//   node gen.mjs customer           --count 50 --seed 1
//   node gen.mjs order              --count 30 --seed 1
import { writeFileSync } from "node:fs";

// ---------- seeded PRNG (mulberry32) so --seed gives reproducible output ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashSeed(s) {
  let h = 1779033703 ^ String(s).length;
  for (let i = 0; i < String(s).length; i++) {
    h = Math.imul(h ^ String(s).charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const takeVal = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const hasFlag = (f) => argv.includes(f);

const COUNT = parseInt(takeVal("--count", "10"), 10);
const SEED = hashSeed(takeVal("--seed", String(Date.now())));
const AS_CSV = hasFlag("--csv");
const rng = mulberry32(SEED);

const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const pickWeighted = (pairs) => {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [v, w] of pairs) { r -= w; if (r <= 0) return v; }
  return pairs[pairs.length - 1][0];
};
const randInt = (min, max) => Math.floor(rng() * (max - min + 1)) + min;

// ---------- fabricated name / place / domain pools (invented, not sourced from any real roster) ----------
const FIRST_NAMES = ["Avery", "Jordan", "Riley", "Casey", "Morgan", "Quinn", "Rowan", "Skyler", "Emerson", "Finley",
  "Hayden", "Reese", "Sawyer", "Dakota", "Elliot", "Marlowe", "Peyton", "Sage", "Tatum", "Wren",
  "Blair", "Cameron", "Drew", "Ellis", "Frankie", "Greer", "Harper", "Indigo", "Jules", "Kit"];
const LAST_NAMES = ["Fenwick", "Marsh", "Colter", "Hartley", "Quill", "Brennan", "Sorrel", "Whitlock", "Pemberton", "Ashcombe",
  "Tavarez", "Okafor", "Lindqvist", "Bianchi", "Delacroix", "Nakamura", "Vasquez", "Hollow", "Petrov", "Sundberg",
  "Castellano", "Iwu", "Marchetti", "Osei", "Renwick", "Solheim", "Trudeau", "Vance", "Wexler", "Ziegler"];
const STREETS = ["Maple", "Cedar", "Birch", "Aspen", "Willow", "Harbor", "Meadow", "Ridge", "Orchard", "Foxglove"];
const STREET_SUFFIX = ["St", "Ave", "Dr", "Ln", "Ct", "Way", "Blvd"];
const CITY_STATE = [
  ["Rivergate", "OH"], ["Millhaven", "TX"], ["Cedar Falls", "IA"], ["Brookport", "GA"], ["Ashford", "CO"],
  ["Fairview Heights", "IL"], ["Larchmont", "NY"], ["Bellmoor", "PA"], ["Stonebridge", "NC"], ["Thistlewood", "WA"],
];
const EMAIL_DOMAINS = ["exampleinbox.test", "fakemail.test", "notreal-mail.test", "sample.invalid"];
const DX_CODES = [
  ["H90.3", "Sensorineural hearing loss, bilateral"],
  ["H90.41", "Conductive hearing loss, unilateral, right"],
  ["H93.11", "Tinnitus, right ear"],
  ["H61.20", "Impacted cerumen, unspecified ear"],
  ["H91.90", "Unspecified hearing loss, unspecified ear"],
  ["Z01.10", "Encounter for hearing exam, no abnormal findings"],
];
const NOTE_TEMPLATES = [
  "Patient reports gradual difficulty following conversation in noisy settings. Otoscopy unremarkable. Recommend follow-up audiogram.",
  "Follow-up visit; patient tolerating hearing aid trial well. No new complaints. Continue current fitting.",
  "New patient intake. Reports occasional tinnitus, left ear, intermittent over past 3 months. No vertigo.",
  "Routine screening completed. Results within expected range for age band. No referral needed at this time.",
  "Patient reports improved clarity after cerumen removal. Advised to return in 6 months for recheck.",
];
const PRODUCTS = [
  ["Comfort-Fit Ear Tips (3-pack)", 12.99], ["Rechargeable Hearing Aid Battery Kit", 34.5],
  ["Hearing Aid Cleaning Kit", 18.0], ["Premium Domes (assorted sizes)", 15.75],
  ["Wax Guard Refill Pack", 9.99], ["Portable Charging Case", 49.0],
  ["Bluetooth Streaming Clip", 59.0], ["Extended Warranty Plan", 79.0],
];

function fakeName() { return { first: pick(FIRST_NAMES), last: pick(LAST_NAMES) }; }
function fakeEmail(first, last, idx) { return `${first.toLowerCase()}.${last.toLowerCase()}${idx}@${pick(EMAIL_DOMAINS)}`; }
function fakePhone() { return `555-${String(randInt(200, 899)).padStart(3, "0")}-${String(randInt(1000, 9999)).padStart(4, "0")}`; }
function fakeAddress() {
  const [city, state] = pick(CITY_STATE);
  return { street: `${randInt(100, 9899)} ${pick(STREETS)} ${pick(STREET_SUFFIX)}`, city, state, zip: `${randInt(10000, 99999)}` };
}
function fakeDob(minAge, maxAge, refYear = 2026) {
  const age = randInt(minAge, maxAge);
  const year = refYear - age;
  const month = String(randInt(1, 12)).padStart(2, "0");
  const day = String(randInt(1, 28)).padStart(2, "0");
  return { dob: `${year}-${month}-${day}`, age };
}
function ageBand(age) {
  if (age < 18) return "0-17";
  if (age < 30) return "18-29";
  if (age < 45) return "30-44";
  if (age < 60) return "45-59";
  if (age < 75) return "60-74";
  return "75+";
}
function fakeMRN(prefix = "SYN") { return `${prefix}-${randInt(100000, 999999)}`; }

// ---------- generators ----------

// hearing-screening: iHEARtest-style. NON-measurement categoricals only (mirrors the telemetry
// rule: never emit raw dB/frequency measurements as if they were real clinical data; emit banded
// categoricals instead, same as the app's own privacy-preserving telemetry contract).
const DB_CATEGORY_BANDS = ["normal(<=25dB)", "mild(26-40dB)", "moderate(41-55dB)", "moderately-severe(56-70dB)", "severe(71-90dB)", "profound(>90dB)"];
const FREQUENCIES_HZ = [250, 500, 1000, 2000, 4000, 8000];
const RESULT_TIERS = ["pass", "refer-mild", "refer-moderate", "refer-urgent"];

function genHearingScreening(i) {
  const { age } = fakeDob(5, 89);
  const band = ageBand(age);
  const ear = pick(["left", "right"]);
  const perFrequency = {};
  for (const hz of FREQUENCIES_HZ) perFrequency[`${hz}hz_band`] = pick(DB_CATEGORY_BANDS);
  const worstBandIdx = Math.max(...Object.values(perFrequency).map((b) => DB_CATEGORY_BANDS.indexOf(b)));
  const resultTier = pickWeighted([["pass", 55], ["refer-mild", 25], ["refer-moderate", 12], ["refer-urgent", 8]]);
  return {
    record_id: `HS-${SEED}-${i}`,
    age_band: band,
    ear,
    per_frequency_band: perFrequency,
    result_category_tier: resultTier,
    result_severity_band: DB_CATEGORY_BANDS[worstBandIdx],
    device: pick(["ios-app", "android-app", "web"]),
    synthetic: true,
  };
}

function genPatient(i) {
  const { first, last } = fakeName();
  const { dob, age } = fakeDob(1, 95);
  const [code, desc] = pick(DX_CODES);
  return {
    record_id: `PT-${SEED}-${i}`,
    mrn: fakeMRN(),
    first_name: first,
    last_name: last,
    dob,
    sex: pick(["F", "M", "X"]),
    address: fakeAddress(),
    phone: fakePhone(),
    email: fakeEmail(first, last, i),
    dx_code: code,
    dx_description: desc,
    note: pick(NOTE_TEMPLATES),
    age_at_note: age,
    synthetic: true,
  };
}

function genCustomer(i) {
  const { first, last } = fakeName();
  const address = fakeAddress();
  const purchaseCount = randInt(0, 6);
  const purchaseHistory = Array.from({ length: purchaseCount }, () => {
    const [name, price] = pick(PRODUCTS);
    return { product: name, price, purchased_at: `2026-0${randInt(1, 6)}-${String(randInt(1, 28)).padStart(2, "0")}` };
  });
  return {
    record_id: `CU-${SEED}-${i}`,
    first_name: first,
    last_name: last,
    email: fakeEmail(first, last, i),
    phone: fakePhone(),
    city: address.city,
    state: address.state,
    purchase_history: purchaseHistory,
    synthetic: true,
  };
}

function genOrder(i) {
  const { first, last } = fakeName();
  const address = fakeAddress();
  const lineCount = randInt(1, 4);
  const lineItems = Array.from({ length: lineCount }, () => {
    const [name, price] = pick(PRODUCTS);
    const qty = randInt(1, 3);
    return { title: name, quantity: qty, unit_price: price, line_total: Math.round(price * qty * 100) / 100 };
  });
  const subtotal = Math.round(lineItems.reduce((s, l) => s + l.line_total, 0) * 100) / 100;
  const tax = Math.round(subtotal * 0.07 * 100) / 100;
  return {
    record_id: `ORD-${SEED}-${i}`,
    order_number: `#${1000 + i}`,
    customer: { first_name: first, last_name: last, email: fakeEmail(first, last, i) },
    shipping_address: address,
    line_items: lineItems,
    subtotal,
    tax,
    total: Math.round((subtotal + tax) * 100) / 100,
    financial_status: pick(["paid", "pending", "refunded"]),
    fulfillment_status: pick(["fulfilled", "unfulfilled", "partial"]),
    synthetic: true,
  };
}

const GENERATORS = {
  "hearing-screening": genHearingScreening,
  patient: genPatient,
  customer: genCustomer,
  order: genOrder,
};

function toCsv(rows) {
  if (rows.length === 0) return "";
  const flatten = (obj, prefix = "") => Object.entries(obj).reduce((acc, [k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) Object.assign(acc, flatten(v, key));
    else acc[key] = Array.isArray(v) ? JSON.stringify(v) : v;
    return acc;
  }, {});
  const flatRows = rows.map((r) => flatten(r));
  const headers = [...new Set(flatRows.flatMap((r) => Object.keys(r)))];
  const esc = (v) => {
    const s = v === undefined || v === null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(","), ...flatRows.map((r) => headers.map((h) => esc(r[h])).join(","))].join("\n");
}

function main() {
  const gen = GENERATORS[cmd];
  if (!gen) {
    console.error(`Usage: node gen.mjs <${Object.keys(GENERATORS).join("|")}> --count N --seed S [--csv]`);
    process.exit(1);
  }
  const rows = Array.from({ length: COUNT }, (_, i) => gen(i + 1));
  const out = AS_CSV ? toCsv(rows) : JSON.stringify(rows, null, 2);
  const outFile = takeVal("--out", "");
  if (outFile) { writeFileSync(outFile, out); console.error(`wrote ${rows.length} synthetic ${cmd} record(s) to ${outFile}`); }
  else console.log(out);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

export { GENERATORS, genHearingScreening, genPatient, genCustomer, genOrder, toCsv, DB_CATEGORY_BANDS, RESULT_TIERS, FREQUENCIES_HZ, ageBand };
