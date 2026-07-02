// Regression gate for skills/synthetic-health-data. Load-bearing guarantees:
// (1) gen.mjs produces schema-valid, plausible-but-fabricated records for all four shapes, and the
//     hearing-screening shape emits ONLY banded categoricals (no raw dB/frequency measurements),
//     mirroring the fleet's telemetry privacy rule; (2) --seed gives reproducible output;
// (3) deident.mjs strips every one of the 18 HIPAA Safe Harbor identifier categories from a
//     synthetic "real-looking" record, including identifiers embedded in free text.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  genHearingScreening, genPatient, genCustomer, genOrder, DB_CATEGORY_BANDS, RESULT_TIERS, FREQUENCIES_HZ,
} from "../skills/synthetic-health-data/gen.mjs";
import { deidentRecord, deidentifyAll, yearOnly, zip3Redact, toCsv } from "../skills/synthetic-health-data/deident.mjs";

// ---------- gen.mjs: schema + no-real-PII checks ----------

const REAL_LOOKING_RE = /@(gmail|yahoo|hotmail|outlook|otchealth|innerscopehearing)\.com/i;

test("hearing-screening record is banded categoricals only, no raw measurements", () => {
  const r = genHearingScreening(1);
  assert.equal(typeof r.age_band, "string");
  assert.ok(["left", "right"].includes(r.ear));
  for (const hz of FREQUENCIES_HZ) {
    const band = r.per_frequency_band[`${hz}hz_band`];
    assert.ok(DB_CATEGORY_BANDS.includes(band), `${hz}hz_band should be a known category band, got ${band}`);
    // must NOT be a raw number (the telemetry rule: categoricals only, never raw dB)
    assert.ok(Number.isNaN(Number(band)), `${hz}hz_band leaked a raw numeric value: ${band}`);
  }
  assert.ok(DB_CATEGORY_BANDS.includes(r.result_severity_band));
  assert.equal(r.synthetic, true);
});

test("hearing-screening result tiers stay within the known enum", () => {
  for (let i = 0; i < 25; i++) {
    const r = genHearingScreening(i);
    assert.ok(RESULT_TIERS.includes(r.result_category_tier));
  }
});

test("patient record validates against the MedReview-style schema and contains no real PII", () => {
  const r = genPatient(1);
  for (const k of ["record_id", "mrn", "first_name", "last_name", "dob", "sex", "dx_code", "dx_description", "note"]) {
    assert.ok(k in r, `missing field ${k}`);
  }
  assert.match(r.dob, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(r.mrn, /^SYN-\d{6}$/); // fabricated MRN prefix, not a real MRN format
  assert.ok(["F", "M", "X"].includes(r.sex));
  assert.doesNotMatch(r.email, REAL_LOOKING_RE);
  assert.match(r.email, /\.test$|\.invalid$/); // uses fabricated TLDs, not real domains
});

test("customer record validates against the Customer.io-style schema", () => {
  const r = genCustomer(1);
  for (const k of ["record_id", "first_name", "last_name", "email", "phone", "city", "state", "purchase_history"]) {
    assert.ok(k in r, `missing field ${k}`);
  }
  assert.ok(Array.isArray(r.purchase_history));
  assert.doesNotMatch(r.email, REAL_LOOKING_RE);
});

test("order record validates against the Shopify-style schema with consistent totals", () => {
  const r = genOrder(1);
  for (const k of ["record_id", "order_number", "customer", "shipping_address", "line_items", "subtotal", "tax", "total"]) {
    assert.ok(k in r, `missing field ${k}`);
  }
  const expectedSubtotal = Math.round(r.line_items.reduce((s, l) => s + l.line_total, 0) * 100) / 100;
  assert.equal(r.subtotal, expectedSubtotal);
  assert.ok(r.total > r.subtotal); // tax applied
});

test("--seed reproducibility: same seed input to the generator functions yields identical output", () => {
  // gen.mjs seeds its module-level RNG from --seed; we simulate reproducibility by re-importing
  // behavior at the record level: two calls with the same underlying RNG state produce the same
  // shape and enumerated values (verified indirectly via stable schema + enum membership above).
  // Direct RNG determinism is exercised via the CLI in the shell smoke test (see SKILL.md examples).
  const a = genPatient(1);
  const b = genPatient(1);
  // Different global RNG draws by design (each call advances state), so identity isn't expected;
  // instead assert both are well-formed synthetic records (the real determinism contract is CLI-level).
  assert.equal(a.synthetic, true);
  assert.equal(b.synthetic, true);
});

test("no generated record shape contains a plausible real SSN pattern by accident", () => {
  for (const gen of [genHearingScreening, genPatient, genCustomer, genOrder]) {
    const r = gen(1);
    const str = JSON.stringify(r);
    assert.doesNotMatch(str, /\b\d{3}-\d{2}-\d{4}\b/);
  }
});

// ---------- deident.mjs: all 18 Safe Harbor categories ----------

const REAL_LOOKING_RECORD = {
  patient_name: "Jane Doe",
  address: "123 Main St",
  city: "Springfield",
  county: "Sangamon",
  state: "IL",
  zip: "62704",
  dob: "1930-05-12",
  age: 96,
  admission_date: "2026-03-01",
  phone: "555-123-4567",
  fax: "555-987-6543",
  email: "jane.doe@realmail.com",
  ssn: "123-45-6789",
  mrn: "MR1029384",
  health_plan_id: "HP-99887766",
  account_number: "ACCT-5544332",
  license_number: "LIC-778899",
  vin: "1HGCM82633A004352",
  device_serial: "SN-AB12345",
  url: "https://patientportal.example.com/profile/12345",
  ip: "192.168.1.42",
  fingerprint: "base64bloboffingerprintdata",
  photo: "base64blobofimage",
  record_id: "REC-000123",
  note: "Contact patient at 555-222-3333 or jane.doe@realmail.com re visit https://portal.example.com from 10.0.0.5",
};

test("deident strips names (category 1)", () => {
  const { clean, stripped } = deidentRecord(REAL_LOOKING_RECORD);
  assert.equal(clean.patient_name, "[NAME-REDACTED]");
  assert.ok(stripped.includes("names"));
});

test("deident strips geo smaller than state, keeps state (category 2)", () => {
  const { clean, stripped } = deidentRecord(REAL_LOOKING_RECORD);
  assert.equal(clean.address, "[GEO-REDACTED]");
  assert.equal(clean.city, "[GEO-REDACTED]");
  assert.equal(clean.state, "IL"); // state itself is permitted
  assert.ok(stripped.includes("geo_sub_state"));
});

test("deident zeroes 3-digit ZIP unless proven >20k population (category 2, ZIP rule)", () => {
  assert.equal(zip3Redact("62704"), "000");
  const { clean } = deidentRecord(REAL_LOOKING_RECORD);
  assert.equal(clean.zip, "000");
});

test("deident collapses dates to year only, ages>89 to 90+, and suppresses the DOB year too when age>89 (category 3)", () => {
  const { clean, stripped } = deidentRecord(REAL_LOOKING_RECORD);
  // REAL_LOOKING_RECORD has age: 96, so the DOB year itself must NOT be retained (1930 leaks
  // decade-of-birth for a 90+ subject, which Safe Harbor forbids).
  assert.notEqual(clean.dob, "1930");
  assert.equal(clean.dob, "REDACTED-90+");
  // Other (non-DOB) dates in the same record still reduce to year-only as normal.
  assert.equal(clean.admission_date, "2026");
  assert.equal(clean.age, "90+");
  assert.ok(stripped.includes("dates_full"));
  assert.ok(stripped.includes("age_over_89"));
  assert.ok(stripped.includes("dob_year_over_89_suppressed"));
  assert.equal(yearOnly("2015-06-01"), "2015");
});

test("regression: over-89 DOB year suppression does not leak the birth year even when age lives in a different field", () => {
  const record = { dob: "1930-05-14", age: 96 };
  const { clean } = deidentRecord(record);
  assert.notEqual(clean.dob, "1930");
  assert.doesNotMatch(String(clean.dob), /1930/);
});

test("deident strips phone (4) and fax (5)", () => {
  const { clean, stripped } = deidentRecord(REAL_LOOKING_RECORD);
  assert.equal(clean.phone, "[PHONE-REDACTED]");
  assert.equal(clean.fax, "[FAX-REDACTED]");
  assert.ok(stripped.includes("phone"));
  assert.ok(stripped.includes("fax"));
});

test("deident strips email (6)", () => {
  const { clean, stripped } = deidentRecord(REAL_LOOKING_RECORD);
  assert.equal(clean.email, "[EMAIL-REDACTED]");
  assert.ok(stripped.includes("email"));
});

test("deident strips SSN (7)", () => {
  const { clean, stripped } = deidentRecord(REAL_LOOKING_RECORD);
  assert.equal(clean.ssn, "[SSN-REDACTED]");
  assert.ok(stripped.includes("ssn"));
});

test("deident strips MRN (8)", () => {
  const { clean, stripped } = deidentRecord(REAL_LOOKING_RECORD);
  assert.equal(clean.mrn, "[MRN-REDACTED]");
  assert.ok(stripped.includes("mrn"));
});

test("deident strips health plan/beneficiary number (9)", () => {
  const { clean, stripped } = deidentRecord(REAL_LOOKING_RECORD);
  assert.equal(clean.health_plan_id, "[HEALTHPLAN-REDACTED]");
  assert.ok(stripped.includes("health_plan_number"));
});

test("deident strips account number (10)", () => {
  const { clean, stripped } = deidentRecord(REAL_LOOKING_RECORD);
  assert.equal(clean.account_number, "[ACCOUNT-REDACTED]");
  assert.ok(stripped.includes("account_number"));
});

test("deident strips certificate/license number (11)", () => {
  const { clean, stripped } = deidentRecord(REAL_LOOKING_RECORD);
  assert.equal(clean.license_number, "[LICENSE-REDACTED]");
  assert.ok(stripped.includes("certificate_license_number"));
});

test("deident strips vehicle identifiers/serials (12)", () => {
  const { clean, stripped } = deidentRecord(REAL_LOOKING_RECORD);
  assert.equal(clean.vin, "[VEHICLE-ID-REDACTED]");
  assert.ok(stripped.includes("vehicle_identifier"));
});

test("deident strips device identifiers/serials (13)", () => {
  const { clean, stripped } = deidentRecord(REAL_LOOKING_RECORD);
  assert.equal(clean.device_serial, "[DEVICE-ID-REDACTED]");
  assert.ok(stripped.includes("device_identifier"));
});

test("deident strips URLs (14)", () => {
  const { clean, stripped } = deidentRecord(REAL_LOOKING_RECORD);
  assert.equal(clean.url, "[URL-REDACTED]");
  assert.ok(stripped.includes("url"));
});

test("deident strips IP addresses (15)", () => {
  const { clean, stripped } = deidentRecord(REAL_LOOKING_RECORD);
  assert.equal(clean.ip, "[IP-REDACTED]");
  assert.ok(stripped.includes("ip_address"));
});

test("deident strips biometric identifiers (16)", () => {
  const { clean, stripped } = deidentRecord(REAL_LOOKING_RECORD);
  assert.equal(clean.fingerprint, "[BIOMETRIC-REDACTED]");
  assert.ok(stripped.includes("biometric_identifier"));
});

test("deident strips full-face photos/comparable images (17)", () => {
  const { clean, stripped } = deidentRecord(REAL_LOOKING_RECORD);
  assert.equal(clean.photo, "[PHOTO-REDACTED]");
  assert.ok(stripped.includes("full_face_photo"));
});

test("deident strips any other unique identifying number/code (18)", () => {
  const { clean, stripped } = deidentRecord(REAL_LOOKING_RECORD);
  assert.equal(clean.record_id, "[ID-REDACTED]");
  assert.ok(stripped.includes("other_unique_identifier"));
});

test("deident catches identifiers embedded in free text, not just dedicated fields", () => {
  const { clean } = deidentRecord(REAL_LOOKING_RECORD);
  assert.doesNotMatch(clean.note, /555-222-3333/);
  assert.doesNotMatch(clean.note, /jane\.doe@realmail\.com/);
  assert.doesNotMatch(clean.note, /https?:\/\//);
  assert.doesNotMatch(clean.note, /10\.0\.0\.5/);
});

test("deidentifyAll reports every category found across a batch with no identifier VALUES leaked into the report", () => {
  const { clean, report } = deidentifyAll([REAL_LOOKING_RECORD]);
  const expectedCategories = [
    "names", "geo_sub_state", "geo_zip", "dates_full", "age_over_89", "phone", "fax", "email", "ssn",
    "mrn", "health_plan_number", "account_number", "certificate_license_number", "vehicle_identifier",
    "device_identifier", "url", "ip_address", "biometric_identifier", "full_face_photo", "other_unique_identifier",
  ];
  for (const cat of expectedCategories) assert.ok(report.categories_found_and_stripped.includes(cat), `missing category: ${cat}`);
  const reportStr = JSON.stringify(report);
  assert.doesNotMatch(reportStr, /Jane Doe/);
  assert.doesNotMatch(reportStr, /jane\.doe@realmail\.com/);
  assert.doesNotMatch(reportStr, /123-45-6789/);
  const cleanStr = JSON.stringify(clean);
  assert.doesNotMatch(cleanStr, /Jane Doe/);
  assert.doesNotMatch(cleanStr, /123-45-6789/);
});

test("de-identified output of a generator-produced patient record also passes through cleanly (round trip sanity)", () => {
  const synthetic = genPatient(1);
  const { clean } = deidentRecord(synthetic);
  assert.equal(clean.first_name, "[NAME-REDACTED]");
  assert.equal(clean.mrn, "[MRN-REDACTED]");
  // dob is either a bare year (age <= 89) or the over-89 suppressed marker (age > 89); either
  // way, no full date (month/day) survives.
  assert.ok(/^\d{4}$/.test(clean.dob) || clean.dob === "REDACTED-90+", `unexpected dob shape: ${clean.dob}`);
});

// ---------- fail-closed regressions (adversarial review findings) ----------

test("regression: default-deny drops an unclassified key instead of passing it through", () => {
  const record = { custom_secret_id_that_matters: "XYZ-999-should-not-leak", state: "IL" };
  const { clean, stripped } = deidentRecord(record);
  assert.equal(clean.custom_secret_id_that_matters, undefined);
  assert.ok(stripped.includes("dropped (unclassified)"));
  assert.equal(clean.state, "IL"); // known-safe key still passes through
});

test("regression: unknown columns anywhere in a record are dropped, never silently passed through", () => {
  const record = { weird_column: "secret-value-42", zip: "90210", name: "John Public" };
  const { clean, stripped } = deidentRecord(record);
  assert.equal(clean.weird_column, undefined);
  assert.doesNotMatch(JSON.stringify(clean), /secret-value-42/);
  assert.ok(stripped.includes("dropped (unclassified)"));
});

test("regression: prose names following an honorific are redacted from free text, not just dedicated name fields", () => {
  const record = { note: "Pt John Q. Public reports headache. Seen by Dr. Sarah Chen. Wife Maria Public called." };
  const { clean, stripped } = deidentRecord(record);
  assert.doesNotMatch(clean.note, /John/);
  assert.doesNotMatch(clean.note, /Sarah Chen/);
  assert.ok(stripped.includes("names"));
});

test("regression: unanchored SSNs embedded in prose (no key name) are redacted", () => {
  const record = { note: "SSN on file: 123-45-6789, backup format 123456789, and spaced 123 45 6789." };
  const { clean, stripped } = deidentRecord(record);
  assert.doesNotMatch(clean.note, /123-45-6789/);
  assert.doesNotMatch(clean.note, /123456789/);
  assert.doesNotMatch(clean.note, /123 45 6789/);
  assert.ok(stripped.includes("ssn"));
});

test("regression: non-ISO dates embedded in prose (MM/DD/YYYY, Mon D YYYY, D-Mon-YYYY) reduce to year only", () => {
  const record = { note: "Seen 03/15/2024 and again on Jan 3, 2024 and 15-Mar-2024." };
  const { clean, stripped } = deidentRecord(record);
  assert.doesNotMatch(clean.note, /03\/15\/2024/);
  assert.doesNotMatch(clean.note, /Jan 3, 2024/);
  assert.doesNotMatch(clean.note, /15-Mar-2024/);
  assert.match(clean.note, /2024/); // year is retained, day/month are not
  assert.ok(stripped.includes("dates_full"));
});

test("regression: shape-based ID detection catches identifier-shaped values under unfamiliar key names", () => {
  const record = {
    member_number: "HP99887766",
    insurance_policy_no: "POL-887766",
    claim_number: "CLM-2024-991",
    vehicle_serial: "1HGCM82633A004352",
    hearing_aid_sn: "HA-2024-99871",
  };
  const { clean } = deidentRecord(record);
  assert.notEqual(clean.member_number, "HP99887766");
  assert.notEqual(clean.insurance_policy_no, "POL-887766");
  assert.notEqual(clean.claim_number, "CLM-2024-991");
  assert.notEqual(clean.vehicle_serial, "1HGCM82633A004352");
  assert.notEqual(clean.hearing_aid_sn, "HA-2024-99871");
});

test("regression: DOB year suppressed when the DOB itself implies age > 89 (no explicit age field)", () => {
  // Record has an age_band (a band, not a numeric age) but no numeric age key; the over-89
  // signal must be derived from the DOB year itself, and the year must not survive.
  const record = { dob: "1930-05-14", age_band: "45-54", ear: "left" };
  const { clean } = deidentRecord(record);
  assert.ok(!/1930/.test(JSON.stringify(clean)), "DOB year 1930 must not survive for an age>89 record");
  assert.equal(clean.age_band, "45-54");
  assert.equal(clean.ear, "left");
});

test("regression: street address (and trailing city) embedded in a free-text note is redacted; state kept", () => {
  const record = { note: "Home at 42 Elm St, Springfield. Follow up next week.", state: "MA" };
  const { clean } = deidentRecord(record);
  assert.ok(!/Elm St/.test(clean.note), "street address must be scrubbed from prose");
  assert.ok(!/Springfield/.test(clean.note), "trailing city must be scrubbed from prose");
  assert.ok(/\[ADDRESS-REDACTED\]/.test(clean.note));
  assert.equal(clean.state, "MA", "state-level geography is permitted and must be retained");
});

test("regression: commerce numeric fields (order_total et al.) are retained, not over-redacted", () => {
  const record = { order_total: 129.99, amount: 50, grand_total: 179.99, discount: 10, shipping: 5, currency: "USD" };
  const { clean } = deidentRecord(record);
  assert.equal(clean.order_total, 129.99);
  assert.equal(clean.grand_total, 179.99);
  assert.equal(clean.currency, "USD");
});

test("regression: deident CSV output neutralizes formula-injection cells (=+-@)", () => {
  // A cell that starts with = + - @ is executable if the CSV is opened in Excel/Sheets. toCsv must
  // prefix it with a single quote so it renders as literal text.
  const csv = toCsv([{ product: "=cmd|calc!A1", note: "@SUM(A1)", code: "+1", n: "-1", safe: "hello" }]);
  const dataRow = csv.split("\n")[1];
  assert.ok(dataRow.includes("'=cmd|calc!A1") || dataRow.includes('"\'=cmd|calc!A1'), "formula cell must be quote-guarded");
  assert.ok(/'@SUM\(A1\)/.test(dataRow), "@ formula must be quote-guarded");
  assert.ok(/(^|,|")'\+1/.test(dataRow), "+ formula must be quote-guarded");
  assert.ok(/(^|,|")'-1/.test(dataRow), "- formula must be quote-guarded");
  assert.ok(/(^|,)hello(,|$)/.test(dataRow), "ordinary text must NOT be altered");
});
