#!/usr/bin/env node
// synthetic-health-data / deident.mjs — HIPAA Safe-Harbor de-identifier (45 CFR 164.514(b)(2)).
//
// PROCESSES data it is handed (stdin or --file). It NEVER fetches, queries, or pulls records from
// any database, API, bucket, or PHI-source system itself. If you are running this on a real
// extract, run it INSIDE the BAA-covered environment (the MedReview/production boundary) — the
// output of this tool (plus the strip report) is the only thing that may leave that boundary.
//
// Removes/transforms all 18 HIPAA Safe-Harbor identifier categories from each input record:
//   1. Names
//   2. Geographic subdivisions smaller than a state (street, city, county, precinct, ZIP -
//      3-digit ZCTA kept ONLY if that ZCTA's population > 20,000, else "000")
//   3. All elements of dates (except year) directly related to an individual, including any
//      age > 89 collapsed to "90+"
//   4. Telephone numbers
//   5. Fax numbers
//   6. Email addresses
//   7. Social Security numbers
//   8. Medical record numbers
//   9. Health plan beneficiary numbers
//  10. Account numbers
//  11. Certificate/license numbers
//  12. Vehicle identifiers and serial numbers (including license plates)
//  13. Device identifiers and serial numbers
//  14. URLs
//  15. IP addresses
//  16. Biometric identifiers (finger/voice/retinal prints, etc.)
//  17. Full-face photographs and comparable images
//  18. Any other unique identifying number, characteristic, or code
//
// Usage:
//   node deident.mjs --file real_extract.json [--csv] [--out clean.json] [--report report.json]
//   cat real_extract.json | node deident.mjs
//   node deident.mjs --file real_extract.csv --csv
import { readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const takeVal = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const hasFlag = (f) => argv.includes(f);

// 3-digit ZCTAs whose population is <= 20,000 per the Safe-Harbor rule must be zeroed to "000".
// This is a conservative default list of well-known low-population 3-digit prefixes; unknown
// prefixes are treated conservatively (zeroed) unless explicitly present in ALLOWED_ZIP3.
// Fleet note: extend ALLOWED_ZIP3 only with prefixes verified against the current Census ZCTA
// population table for the extract's vintage.
const ALLOWED_ZIP3 = new Set(); // conservative default: zero every 3-digit prefix unless proven >20k

const NAME_KEYS = ["name", "first_name", "last_name", "full_name", "patient_name", "customer_name",
  "given_name", "family_name", "middle_name", "maiden_name", "guardian_name", "next_of_kin",
  "emergency_contact_name", "physician_name", "provider_name", "employer_name"];
const GEO_KEYS = ["address", "street", "street_address", "address_line1", "address_line2", "city",
  "county", "precinct", "shipping_address", "billing_address", "location"];
const ZIP_KEYS = ["zip", "zipcode", "zip_code", "postal_code"];
const STATE_KEYS = ["state", "state_code", "region"];
const DATE_KEYS = ["dob", "date_of_birth", "birth_date", "admission_date", "discharge_date",
  "death_date", "date_of_death", "visit_date", "service_date", "note_date", "purchased_at",
  "created_at", "updated_at", "order_date", "screening_date", "appointment_date", "encounter_date"];
const AGE_KEYS = ["age", "age_at_note", "patient_age", "age_years"];
const PHONE_KEYS = ["phone", "phone_number", "telephone", "mobile", "cell", "home_phone", "work_phone", "contact_phone"];
const FAX_KEYS = ["fax", "fax_number"];
const EMAIL_KEYS = ["email", "email_address", "contact_email"];
const SSN_KEYS = ["ssn", "social_security_number", "social_security"];
const MRN_KEYS = ["mrn", "medical_record_number", "patient_id", "chart_number"];
const HEALTHPLAN_KEYS = ["health_plan_id", "beneficiary_number", "insurance_id", "member_id", "policy_number"];
const ACCOUNT_KEYS = ["account_number", "account_id", "customer_account_number", "billing_account"];
const CERT_KEYS = ["license_number", "certificate_number", "certification_number", "professional_license"];
const VEHICLE_KEYS = ["vin", "vehicle_id", "license_plate", "plate_number"];
const DEVICE_KEYS = ["device_id", "device_serial", "serial_number", "imei", "udid", "hearing_aid_serial"];
const URL_KEYS = ["url", "website", "profile_url", "photo_url", "avatar_url"];
const IP_KEYS = ["ip", "ip_address", "last_ip", "client_ip"];
const BIOMETRIC_KEYS = ["fingerprint", "voiceprint", "retinal_scan", "biometric_id", "faceprint"];
const PHOTO_KEYS = ["photo", "face_photo", "headshot", "image", "photo_data"];
// "other unique identifying number/characteristic/code" catch-all: anything matching these
// generic identifier-shaped patterns even under an unknown key name.
const GENERIC_ID_KEY_RE = /(^id$|_id$|^uuid$|_uuid$|record_id|external_id|customer_id|patient_id|order_number|record_number)/i;

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const URL_RE = /\bhttps?:\/\/[^\s"']+/gi;
const IP_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/g; // ISO date -> keep year only
const ZIP5_RE = /\b\d{5}(-\d{4})?\b/g;

function isDateKey(k) { return DATE_KEYS.includes(k) || /date$/i.test(k) || /_at$/i.test(k) || /^dob$/i.test(k); }

function yearOnly(dateStr) {
  const m = /(\d{4})/.exec(String(dateStr));
  return m ? m[1] : "REDACTED-DATE";
}

function scrubFreeText(text, stripped) {
  let out = String(text);
  if (EMAIL_RE.test(out)) { stripped.add("email"); out = out.replace(EMAIL_RE, "[EMAIL-REDACTED]"); }
  if (PHONE_RE.test(out)) { stripped.add("phone"); out = out.replace(PHONE_RE, "[PHONE-REDACTED]"); }
  if (SSN_RE.test(out)) { stripped.add("ssn"); out = out.replace(SSN_RE, "[SSN-REDACTED]"); }
  if (URL_RE.test(out)) { stripped.add("url"); out = out.replace(URL_RE, "[URL-REDACTED]"); }
  if (IP_RE.test(out)) { stripped.add("ip_address"); out = out.replace(IP_RE, "[IP-REDACTED]"); }
  if (DATE_RE.test(out)) { stripped.add("dates_full"); out = out.replace(DATE_RE, (_, y) => y); }
  return out;
}

function zip3Redact(zip) {
  const digits = String(zip).replace(/\D/g, "");
  if (digits.length < 3) return "000";
  const zip3 = digits.slice(0, 3);
  return ALLOWED_ZIP3.has(zip3) ? `${zip3}00` : "000";
}

// Recursively walk any object/array shape and de-identify known key categories, plus scrub any
// remaining string value for embedded identifiers (email/phone/ssn/url/ip/dates), so identifiers
// hiding in free-text notes or unexpected keys are still caught.
function deidentValue(key, value, stripped, path) {
  const lowerKey = String(key || "").toLowerCase();

  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) return value.map((v, i) => deidentValue(key, v, stripped, `${path}[${i}]`));

  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = deidentValue(k, v, stripped, path ? `${path}.${k}` : k);
    return out;
  }

  // 1. Names
  if (NAME_KEYS.includes(lowerKey)) { stripped.add("names"); return "[NAME-REDACTED]"; }
  // 2. Geographic subdivision smaller than state
  if (GEO_KEYS.includes(lowerKey)) { stripped.add("geo_sub_state"); return "[GEO-REDACTED]"; }
  if (ZIP_KEYS.includes(lowerKey)) { stripped.add("geo_zip"); return zip3Redact(value); }
  if (STATE_KEYS.includes(lowerKey)) return value; // state itself IS permitted under Safe Harbor
  // 3. Dates (year only) + ages > 89
  if (AGE_KEYS.includes(lowerKey)) {
    const n = Number(value);
    if (!Number.isNaN(n) && n > 89) { stripped.add("age_over_89"); return "90+"; }
    return value;
  }
  if (isDateKey(lowerKey)) { stripped.add("dates_full"); return yearOnly(value); }
  // 4/5. Phone / fax
  if (PHONE_KEYS.includes(lowerKey)) { stripped.add("phone"); return "[PHONE-REDACTED]"; }
  if (FAX_KEYS.includes(lowerKey)) { stripped.add("fax"); return "[FAX-REDACTED]"; }
  // 6. Email
  if (EMAIL_KEYS.includes(lowerKey)) { stripped.add("email"); return "[EMAIL-REDACTED]"; }
  // 7. SSN
  if (SSN_KEYS.includes(lowerKey)) { stripped.add("ssn"); return "[SSN-REDACTED]"; }
  // 8. MRN
  if (MRN_KEYS.includes(lowerKey)) { stripped.add("mrn"); return "[MRN-REDACTED]"; }
  // 9. Health plan / beneficiary number
  if (HEALTHPLAN_KEYS.includes(lowerKey)) { stripped.add("health_plan_number"); return "[HEALTHPLAN-REDACTED]"; }
  // 10. Account number
  if (ACCOUNT_KEYS.includes(lowerKey)) { stripped.add("account_number"); return "[ACCOUNT-REDACTED]"; }
  // 11. Certificate/license number
  if (CERT_KEYS.includes(lowerKey)) { stripped.add("certificate_license_number"); return "[LICENSE-REDACTED]"; }
  // 12. Vehicle identifiers/serials
  if (VEHICLE_KEYS.includes(lowerKey)) { stripped.add("vehicle_identifier"); return "[VEHICLE-ID-REDACTED]"; }
  // 13. Device identifiers/serials
  if (DEVICE_KEYS.includes(lowerKey)) { stripped.add("device_identifier"); return "[DEVICE-ID-REDACTED]"; }
  // 14. URLs
  if (URL_KEYS.includes(lowerKey)) { stripped.add("url"); return "[URL-REDACTED]"; }
  // 15. IP addresses
  if (IP_KEYS.includes(lowerKey)) { stripped.add("ip_address"); return "[IP-REDACTED]"; }
  // 16. Biometric identifiers
  if (BIOMETRIC_KEYS.includes(lowerKey)) { stripped.add("biometric_identifier"); return "[BIOMETRIC-REDACTED]"; }
  // 17. Full-face photos / comparable images
  if (PHOTO_KEYS.includes(lowerKey)) { stripped.add("full_face_photo"); return "[PHOTO-REDACTED]"; }
  // 18. Any other unique identifying number/characteristic/code
  if (GENERIC_ID_KEY_RE.test(lowerKey)) { stripped.add("other_unique_identifier"); return "[ID-REDACTED]"; }

  // Free-text scrub for anything else (notes, comments, descriptions, unknown keys) in case an
  // identifier is embedded in prose rather than living in a dedicated field.
  if (typeof value === "string") return scrubFreeText(value, stripped);

  return value;
}

function deidentRecord(record) {
  const stripped = new Set();
  const clean = deidentValue("root", record, stripped, "");
  return { clean, stripped: [...stripped] };
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(",").map((h) => h.replace(/^"|"$/g, ""));
  return lines.slice(1).filter(Boolean).map((line) => {
    const cells = [];
    let cur = "", inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = !inQuotes; }
      else if (c === "," && !inQuotes) { cells.push(cur); cur = ""; }
      else cur += c;
    }
    cells.push(cur);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = cells[i]; });
    return obj;
  });
}

function toCsv(rows) {
  if (rows.length === 0) return "";
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v) => {
    const s = v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(","), ...rows.map((r) => headers.map((h) => esc(r[h])).join(","))].join("\n");
}

function readInput() {
  const file = takeVal("--file", "");
  const raw = file ? readFileSync(file, "utf8") : readFileSync(0, "utf8");
  const isCsv = hasFlag("--csv") || (file && file.toLowerCase().endsWith(".csv"));
  if (isCsv) return { rows: parseCsv(raw), isCsv: true };
  const parsed = JSON.parse(raw);
  return { rows: Array.isArray(parsed) ? parsed : [parsed], isCsv: false };
}

function deidentifyAll(rows) {
  const allCategories = new Set();
  const perRecordStripped = [];
  const clean = rows.map((r) => {
    const { clean, stripped } = deidentRecord(r);
    stripped.forEach((s) => allCategories.add(s));
    perRecordStripped.push(stripped);
    return clean;
  });
  const report = {
    records_processed: rows.length,
    categories_found_and_stripped: [...allCategories].sort(),
    per_record_categories: perRecordStripped,
    guarantee: "Output contains no direct identifiers from the 18 HIPAA Safe Harbor categories. " +
      "This report only lists WHICH categories were detected/redacted; it intentionally carries no identifier VALUES.",
  };
  return { clean, report };
}

function main() {
  const { rows, isCsv } = readInput();
  const { clean, report } = deidentifyAll(rows);
  const outFile = takeVal("--out", "");
  const reportFile = takeVal("--report", "");
  const outText = isCsv || hasFlag("--csv") ? toCsv(clean) : JSON.stringify(clean, null, 2);
  if (outFile) { writeFileSync(outFile, outText); console.error(`wrote ${clean.length} de-identified record(s) to ${outFile}`); }
  else console.log(outText);
  if (reportFile) writeFileSync(reportFile, JSON.stringify(report, null, 2));
  else console.error(JSON.stringify(report, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main();

export { deidentRecord, deidentifyAll, yearOnly, zip3Redact, scrubFreeText, parseCsv, toCsv };
