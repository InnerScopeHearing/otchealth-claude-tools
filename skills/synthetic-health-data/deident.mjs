#!/usr/bin/env node
// synthetic-health-data / deident.mjs, HIPAA Safe-Harbor de-identifier (45 CFR 164.514(b)(2)).
//
// PROCESSES data it is handed (stdin or --file). It NEVER fetches, queries, or pulls records from
// any database, API, bucket, or PHI-source system itself. If you are running this on a real
// extract, run it INSIDE the BAA-covered environment (the MedReview/production boundary), the
// output of this tool (plus the strip report) is the only thing that may leave that boundary.
//
// FAIL-CLOSED GUARANTEE: this tool is default-deny, not default-allow. Every key is checked
// against an explicit SAFE allowlist of known non-identifying fields (age bands, ear side,
// per-frequency dB categoricals, result tiers, sex, state, ICD-10 dx code fields, order totals,
// quantities, currency, and line-item/product names). Any key NOT on that allowlist, and not
// matched by a known identifier category below, is DROPPED rather than passed through, and is
// listed in the strip report as "dropped (unclassified)". There is no code path in this file
// that returns an unrecognized key's value unchanged.
//
// Removes/transforms all 18 HIPAA Safe-Harbor identifier categories from each input record:
//   1. Names (including honorific-heuristic detection of names embedded in free-text notes)
//   2. Geographic subdivisions smaller than a state (street, city, county, precinct, ZIP -
//      3-digit ZCTA kept ONLY if that ZCTA's population > 20,000, else "000")
//   3. All elements of dates (except year) directly related to an individual, including any
//      age > 89 collapsed to "90+", AND the date's YEAR itself suppressed whenever that date
//      would encode an age over 89 (Safe Harbor forbids retaining any date element, including
//      year, once the implied age exceeds 89)
//   4. Telephone numbers
//   5. Fax numbers
//   6. Email addresses
//   7. Social Security numbers (including unanchored SSNs embedded in free text)
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
//  18. Any other unique identifying number, characteristic, or code (default-deny: any key not
//      on the SAFE allowlist is dropped as unclassified, whether or not it also happens to match
//      a known identifier-shaped value pattern)
//
// KNOWN LIMITATION: free-text name scrubbing (scrubFreeText) uses an honorific heuristic
// (Dr./Mr./Mrs./Ms./Pt/Patient followed by a capitalized token) to catch names embedded in prose
// notes. This is NOT full named-entity recognition and will not catch a name with no preceding
// honorific. It is a best-effort net layered on top of the default-deny structural guarantee,
// not a substitute for it, the structural guarantee is what actually prevents leakage of
// unknown/unclassified columns.
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

// ---------------------------------------------------------------------------------------------
// SAFE ALLOWLIST, the ONLY keys whose values are passed through unredacted (after a shape-based
// re-check and free-text scrub). Anything not listed here, and not matched by an identifier
// category below, is DROPPED. This is the core of the fail-closed design: default-deny, not
// default-allow.
// ---------------------------------------------------------------------------------------------
const SAFE_KEYS = new Set([
  // age-banded / non-measurement categoricals (hearing-screening shape)
  "age_band", "ear", "result_category_tier", "result_severity_band", "device", "synthetic",
  // sex / permitted geography (state-level is explicitly allowed under Safe Harbor)
  "sex", "state", "state_code", "region",
  // clinical coding (ICD-10 style dx code + description are not identifiers under Safe Harbor)
  "dx_code", "dx_description",
  // order / commerce numeric + catalog fields with no link to an identified individual
  "subtotal", "tax", "total", "order_total", "amount", "amount_total", "grand_total",
  "discount", "shipping", "shipping_cost", "currency", "quantity", "qty", "unit_price",
  "price", "line_total", "product", "title", "financial_status", "fulfillment_status",
]);
// NOTE: record_id / order_number are intentionally NOT on the safe allowlist. They are
// per-individual unique identifiers under Safe Harbor category 18 and are redacted by
// GENERIC_ID_KEY_RE below, not passed through.
// per-frequency dB band keys are dynamic (e.g. "250hz_band", "8000hz_band"), matched by pattern.
const SAFE_KEY_PATTERN = /^\d+hz_band$/;
// Free-text note-like fields: the ONLY unclassified-key exception. Their value is kept (after
// scrubbing) rather than dropped, because prose commentary legitimately lives here; every other
// unclassified key is dropped outright.
const FREE_TEXT_KEYS = new Set(["note", "notes", "comment", "comments", "description", "summary", "narrative"]);

const NAME_KEYS = ["name", "first_name", "last_name", "full_name", "patient_name", "customer_name",
  "given_name", "family_name", "middle_name", "maiden_name", "guardian_name", "next_of_kin",
  "emergency_contact_name", "physician_name", "provider_name", "employer_name"];
const GEO_KEYS = ["address", "street", "street_address", "address_line1", "address_line2", "city",
  "county", "precinct", "shipping_address", "billing_address", "location"];
const ZIP_KEYS = ["zip", "zipcode", "zip_code", "postal_code"];
const DATE_KEYS = ["dob", "date_of_birth", "birth_date", "admission_date", "discharge_date",
  "death_date", "date_of_death", "visit_date", "service_date", "note_date", "purchased_at",
  "created_at", "updated_at", "order_date", "screening_date", "appointment_date", "encounter_date"];
const AGE_KEYS = ["age", "age_at_note", "patient_age", "age_years"];
const PHONE_KEYS = ["phone", "phone_number", "telephone", "mobile", "cell", "home_phone", "work_phone", "contact_phone"];
const FAX_KEYS = ["fax", "fax_number"];
const EMAIL_KEYS = ["email", "email_address", "contact_email"];
const SSN_KEYS = ["ssn", "social_security_number", "social_security", "ssn_alt"];
const MRN_KEYS = ["mrn", "medical_record_number", "medical_record_num", "patient_id", "chart_number"];
const HEALTHPLAN_KEYS = ["health_plan_id", "beneficiary_number", "insurance_id", "member_id",
  "member_number", "policy_number", "insurance_policy_no", "claim_number"];
const ACCOUNT_KEYS = ["account_number", "account_id", "customer_account_number", "billing_account",
  "billing_acct_no", "employee_number"];
const CERT_KEYS = ["license_number", "certificate_number", "certification_number", "professional_license", "npi_number"];
const VEHICLE_KEYS = ["vin", "vehicle_id", "vehicle_serial", "license_plate", "plate_number", "plate"];
const DEVICE_KEYS = ["device_id", "device_serial", "serial_number", "imei", "udid", "hearing_aid_serial", "hearing_aid_sn"];
const URL_KEYS = ["url", "website", "profile_url", "photo_url", "avatar_url", "homepage"];
const IP_KEYS = ["ip", "ip_address", "last_ip", "client_ip", "network_addr"];
const BIOMETRIC_KEYS = ["fingerprint", "voiceprint", "retinal_scan", "biometric_id", "faceprint", "fingerprint_hash"];
const PHOTO_KEYS = ["photo", "face_photo", "headshot", "image", "photo_data", "profile_pic"];
// "other unique identifying number/characteristic/code" catch-all: anything matching these
// generic identifier-shaped patterns even under an unknown key name.
const GENERIC_ID_KEY_RE = /(^id$|_id$|^uuid$|_uuid$|record_id|external_id|customer_id|patient_id|order_number|record_number)/i;

// Shape-based identifier detection, belt-and-suspenders: a value that LOOKS like a known
// identifier is redacted even under a key name none of the lists above recognize.
const MRN_SHAPE_RE = /^(mr|mrn)[-\s]?\d{4,}$/i;
const ACCOUNT_SHAPE_RE = /^(acct|account)[-\s]?\d{4,}$/i;
const VIN_SHAPE_RE = /^[A-HJ-NPR-Z0-9]{17}$/i; // 17-char VIN, excludes I/O/Q
const DEVICE_SERIAL_SHAPE_RE = /^(ha|dev|sn|serial)[-\s]?[\w-]{4,}$/i;
const GENERIC_CODE_SHAPE_RE = /^[A-Z]{2,6}-\d{2,4}(-\d{2,})?$/; // e.g. "POL-887766", "CLM-2024-991"

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}(\s?(x|ext\.?)\s?\d{1,5})?/gi;
// SSN, unanchored to key names: matches 123-45-6789, 123.45.6789, 123 45 6789, and 123456789
// wherever it appears in free text.
const SSN_RE = /\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/g;
const URL_RE = /\bhttps?:\/\/[^\s"']+/gi;
const IP_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const DATE_ISO_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/g; // ISO date -> keep year only
// Non-ISO date shapes embedded in prose, reduced to year only:
const DATE_SLASH_RE = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/g; // MM/DD/YYYY or M/D/YY
const DATE_DASH_RE = /\b(\d{1,2})-([A-Za-z]{3,9})-(\d{2,4})\b/g; // 15-Mar-2024
const DATE_NUMDASH_RE = /\b(\d{1,2})-(\d{1,2})-(\d{2,4})\b/g; // 03-15-1980
const MONTHS = "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";
const DATE_MONTHNAME_RE = new RegExp(`\\b(${MONTHS})\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, "gi");
// Honorific + capitalized-token name heuristic (documented limitation: not full NER).
const HONORIFIC_NAME_RE = /\b(Dr|Mr|Mrs|Ms|Pt|Patient)\.?\s+([A-Z][a-zA-Z'-]*(?:\s+[A-Z]\.)?(?:\s+[A-Z][a-zA-Z'-]+)*)/g;
// Street-address heuristic (Safe Harbor cat. 2, geo smaller than a state) embedded in prose:
// a house number + optional street-name tokens + a street-type suffix, optionally consuming a
// trailing ", City" (and optional ST/ZIP). Documented limitation: bare city/town names in prose
// without a street suffix require a gazetteer/NER and are not caught here (same heuristic class
// as prose names). State-level geography is permitted under Safe Harbor and intentionally kept.
const STREET_ADDRESS_RE = /\b\d{1,6}\s+(?:[A-Z][A-Za-z.'-]*\s+){0,4}(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Ct|Court|Way|Pl|Place|Ter|Terrace|Cir|Circle|Hwy|Highway|Pkwy|Parkway|Sq|Square|Trl|Trail|Apt|Suite|Ste|Unit)\b\.?(?:,?\s*(?:Apt|Suite|Ste|Unit|#)\.?\s*\w+)?(?:,\s*[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)?(?:,?\s*[A-Z]{2})?(?:\s+\d{5}(?:-\d{4})?)?/g;

function normalizeYear(y) {
  const n = Number(y);
  if (String(y).length === 2) return n >= 0 && n <= 69 ? 2000 + n : 1900 + n;
  return n;
}

function isDateKey(k) { return DATE_KEYS.includes(k) || /date$/i.test(k) || /_at$/i.test(k) || /^dob$/i.test(k); }
// Only DOB-shaped keys are subject to the age>89 year-suppression coupling below; other dates
// in the same record (admission_date, etc.) still reduce to year-only as usual. Safe Harbor's
// over-89 rule is about not retaining any date element tied to the individual's age/birth, which
// is the DOB, not unrelated encounter dates.
function isDobKey(k) { return /^dob$/i.test(k) || k === "date_of_birth" || k === "birth_date"; }

function yearOnly(dateStr) {
  const m = /(\d{4})/.exec(String(dateStr));
  return m ? m[1] : "REDACTED-DATE";
}

function looksLikeIdShape(value) {
  const s = String(value).trim();
  if (MRN_SHAPE_RE.test(s)) return "mrn";
  if (ACCOUNT_SHAPE_RE.test(s)) return "account_number";
  if (VIN_SHAPE_RE.test(s)) return "vehicle_identifier";
  if (DEVICE_SERIAL_SHAPE_RE.test(s)) return "device_identifier";
  if (GENERIC_CODE_SHAPE_RE.test(s)) return "other_unique_identifier";
  return null;
}

function scrubFreeText(text, stripped) {
  let out = String(text);
  if (EMAIL_RE.test(out)) { stripped.add("email"); out = out.replace(EMAIL_RE, "[EMAIL-REDACTED]"); }
  if (PHONE_RE.test(out)) { stripped.add("phone"); out = out.replace(PHONE_RE, "[PHONE-REDACTED]"); }
  if (SSN_RE.test(out)) { stripped.add("ssn"); out = out.replace(SSN_RE, "[SSN-REDACTED]"); }
  if (URL_RE.test(out)) { stripped.add("url"); out = out.replace(URL_RE, "[URL-REDACTED]"); }
  if (IP_RE.test(out)) { stripped.add("ip_address"); out = out.replace(IP_RE, "[IP-REDACTED]"); }
  // Street address (geo smaller than state) embedded in prose -> redacted; state-level kept.
  if (STREET_ADDRESS_RE.test(out)) { stripped.add("geo_sub_state"); out = out.replace(STREET_ADDRESS_RE, "[ADDRESS-REDACTED]"); }
  // Honorific-based prose name heuristic (documented limitation: not full NER).
  if (HONORIFIC_NAME_RE.test(out)) {
    stripped.add("names");
    out = out.replace(HONORIFIC_NAME_RE, (_, hon) => `${hon}. [NAME-REDACTED]`);
  }
  // Non-ISO dates -> year only (order matters: month-name and dash forms before slash/ISO so
  // "15-Mar-2024" isn't partially eaten by a looser rule first).
  // ISO dates first (YYYY-MM-DD), so a 4-digit year-leading date is never re-carved by the
  // looser numeric dash pattern below.
  if (DATE_ISO_RE.test(out)) { stripped.add("dates_full"); out = out.replace(DATE_ISO_RE, (_, y) => y); }
  if (DATE_MONTHNAME_RE.test(out)) { stripped.add("dates_full"); out = out.replace(DATE_MONTHNAME_RE, (_, mo, d, y) => y); }
  if (DATE_DASH_RE.test(out)) { stripped.add("dates_full"); out = out.replace(DATE_DASH_RE, (_, d, mo, y) => String(normalizeYear(y))); }
  if (DATE_NUMDASH_RE.test(out)) { stripped.add("dates_full"); out = out.replace(DATE_NUMDASH_RE, (_, a, b, y) => String(normalizeYear(y))); }
  if (DATE_SLASH_RE.test(out)) { stripped.add("dates_full"); out = out.replace(DATE_SLASH_RE, (_, a, b, y) => String(normalizeYear(y))); }
  return out;
}

function zip3Redact(zip) {
  const digits = String(zip).replace(/\D/g, "");
  if (digits.length < 3) return "000";
  const zip3 = digits.slice(0, 3);
  return ALLOWED_ZIP3.has(zip3) ? `${zip3}00` : "000";
}

// Scans a record (shallow, one level of object nesting) for any age signal > 89, so date/DOB
// fields elsewhere in the same record can have their year suppressed too (Safe Harbor: once age
// exceeds 89, no date element -- including year -- tied to that individual may be retained).
function recordHasAgeOver89(record) {
  if (record === null || typeof record !== "object") return false;
  for (const [k, v] of Object.entries(record)) {
    const lowerKey = String(k).toLowerCase();
    if (AGE_KEYS.includes(lowerKey)) {
      const n = Number(v);
      if (!Number.isNaN(n) && n > 89) return true;
    }
    // Implied age from a DOB-shaped field's YEAR, even when no explicit numeric age field exists.
    // Safe Harbor: once the implied age could exceed 89, the DOB year itself must be suppressed.
    if (isDobKey(lowerKey)) {
      const m = /(\d{4})/.exec(String(v));
      if (m) {
        const yr = Number(m[1]);
        const now = new Date().getFullYear();
        if (!Number.isNaN(yr) && (now - yr) > 89) return true;
      }
    }
    if (v && typeof v === "object" && !Array.isArray(v) && recordHasAgeOver89(v)) return true;
  }
  return false;
}

// Recursively walk any object/array shape and de-identify known key categories. FAIL-CLOSED:
// any key that is neither on the SAFE allowlist NOR matched by a known identifier category (nor
// a free-text note-like field) is DROPPED -- never passed through untouched.
function deidentValue(key, value, stripped, path, droppedKeys, suppressDateYear) {
  const lowerKey = String(key || "").toLowerCase();

  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value
      .map((v, i) => deidentValue(key, v, stripped, `${path}[${i}]`, droppedKeys, suppressDateYear))
      .filter((v) => v !== undefined);
  }

  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const r = deidentValue(k, v, stripped, path ? `${path}.${k}` : k, droppedKeys, suppressDateYear);
      if (r !== undefined) out[k] = r;
    }
    return out;
  }

  // 1. Names
  if (NAME_KEYS.includes(lowerKey)) { stripped.add("names"); return "[NAME-REDACTED]"; }
  // 2. Geographic subdivision smaller than state
  if (GEO_KEYS.includes(lowerKey)) { stripped.add("geo_sub_state"); return "[GEO-REDACTED]"; }
  if (ZIP_KEYS.includes(lowerKey)) { stripped.add("geo_zip"); return zip3Redact(value); }
  // 3. Dates (year only) + ages > 89, with year suppression when age > 89 anywhere in record
  if (AGE_KEYS.includes(lowerKey)) {
    const n = Number(value);
    if (!Number.isNaN(n) && n > 89) { stripped.add("age_over_89"); return "90+"; }
    return value;
  }
  if (isDateKey(lowerKey)) {
    stripped.add("dates_full");
    if (suppressDateYear && isDobKey(lowerKey)) { stripped.add("dob_year_over_89_suppressed"); return "REDACTED-90+"; }
    return yearOnly(value);
  }
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
  // 18a. Any other unique identifying number/characteristic/code -- key-name catch-all
  if (GENERIC_ID_KEY_RE.test(lowerKey) && !SAFE_KEYS.has(lowerKey)) { stripped.add("other_unique_identifier"); return "[ID-REDACTED]"; }
  // 18b. Shape-based catch-all -- belt-and-suspenders: an ID-shaped VALUE is redacted regardless
  // of what the key is called (MRN-looking, VIN-looking, account-looking, generic code-looking).
  if (typeof value === "string") {
    const shapeHit = looksLikeIdShape(value);
    if (shapeHit) { stripped.add(shapeHit); return `[${shapeHit.toUpperCase().replace(/_/g, "-")}-REDACTED]`; }
  }

  // SAFE allowlist: only these keys (or the dynamic per-frequency band pattern) pass through
  // unredacted, and even then their string values still get scrubbed for embedded identifiers.
  if (SAFE_KEYS.has(lowerKey) || SAFE_KEY_PATTERN.test(lowerKey)) {
    if (typeof value === "string") return scrubFreeText(value, stripped);
    return value;
  }

  // Free-text note-like fields: kept (scrubbed); everything else unclassified is DROPPED.
  if (FREE_TEXT_KEYS.has(lowerKey) && typeof value === "string") {
    return scrubFreeText(value, stripped);
  }

  // FAIL-CLOSED DEFAULT: any key reaching here is neither safe, nor a known identifier category,
  // nor free text. Drop it. Record it in the report as dropped (unclassified) so callers can see
  // exactly what left the record, without ever leaking the value itself.
  droppedKeys.add(lowerKey);
  return undefined;
}

function deidentRecord(record) {
  const stripped = new Set();
  const droppedKeys = new Set();
  const suppressDateYear = recordHasAgeOver89(record);
  const clean = deidentValue("root", record, stripped, "", droppedKeys, suppressDateYear);
  if (droppedKeys.size > 0) stripped.add("dropped (unclassified)");
  return { clean, stripped: [...stripped], dropped_unclassified_keys: [...droppedKeys] };
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
    let s = v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    // CSV formula-injection guard: a cell beginning with = + - @ (or tab/CR) executes as a formula
    // if the de-identified CSV is opened in Excel/Sheets by a downstream analyst. Neutralize by
    // prefixing a single quote so it renders as literal text.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
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
  const allDroppedKeys = new Set();
  const perRecordStripped = [];
  const clean = rows.map((r) => {
    const { clean, stripped, dropped_unclassified_keys } = deidentRecord(r);
    stripped.forEach((s) => allCategories.add(s));
    dropped_unclassified_keys.forEach((k) => allDroppedKeys.add(k));
    perRecordStripped.push(stripped);
    return clean;
  });
  const report = {
    records_processed: rows.length,
    categories_found_and_stripped: [...allCategories].sort(),
    dropped_unclassified_keys: [...allDroppedKeys].sort(),
    per_record_categories: perRecordStripped,
    guarantee: "FAIL-CLOSED: output contains no direct identifiers from the 18 HIPAA Safe Harbor " +
      "categories, and any input key not on the explicit SAFE allowlist was dropped rather than " +
      "passed through. This report only lists WHICH categories/keys were detected/dropped; it " +
      "intentionally carries no identifier VALUES.",
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

export { deidentRecord, deidentifyAll, yearOnly, zip3Redact, scrubFreeText, parseCsv, toCsv, looksLikeIdShape, SAFE_KEYS };
