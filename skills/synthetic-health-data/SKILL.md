---
name: synthetic-health-data
description: Generate realistic-but-100%-fabricated health data (hearing screenings, patient records, customers, orders) for dev/test/agent work with zero PHI exposure, and de-identify real extracts to HIPAA Safe Harbor before they leave a BAA-covered boundary. Use this instead of ever pointing a non-BAA runtime (including Hyperagent) at real PHI.
---

# synthetic-health-data

HIPAA has no dev or internal-use exemption. Real PHI must never flow through a runtime that is
not covered by a Business Associate Agreement (BAA), including agent sandboxes, CI, local dev,
or any non-BAA cloud tool. This skill gives the fleet two tools that solve that in complementary
ways:

1. **`gen.mjs`** fabricates data from scratch. No real person, no real record, ever. Use it for
   all day-to-day dev, testing, demos, and agent work.
2. **`deident.mjs`** takes a real extract and strips it to HIPAA Safe Harbor before it leaves the
   BAA boundary. Use it only when you actually need to move a real dataset (for example, a support
   engineer reproducing a bug against realistic distributions) and only by running it inside the
   BAA-covered environment.

**The guarantee: the output of either tool is non-PHI and is safe to use on any runtime,
including non-BAA agent sandboxes like Hyperagent.**

## When to use this

- You are building or testing a feature (hearing screening flow, MedReview clinical view,
  Customer.io segment, Shopify order pipeline) and need data that looks and behaves like
  production data, without touching production.
- You are an agent that was asked to "pull some real records to test with." Do not. Generate
  synthetic records instead, or ask a human running inside the BAA boundary to de-identify a
  real extract and hand you the de-identified output.
- You need to hand a support case, a bug repro, or a demo dataset to a non-BAA tool or a
  contractor. De-identify first.

## What this skill does NOT do

`deident.mjs` only **processes data it is handed** (stdin or a `--file` argument). It never
fetches, queries, or connects to any database, API, bucket, or production system. It has no
credentials and makes no network calls. If you need to de-identify a real production extract,
pull the extract from inside the BAA-covered environment (for example, on the MedReview
production side) and run `deident.mjs` there, before the data crosses into any non-BAA tool.
Never run it against real data from a non-BAA agent sandbox.

## Part 1: generate synthetic data (`gen.mjs`)

Dependency-free Node. Hand-rolled name, address, and email pools with a seeded PRNG
(`--seed`), so runs are reproducible. No lookup or network call is made anywhere in this file;
every value is fabricated at generation time.

```
node gen.mjs hearing-screening --count 20 --seed 42
node gen.mjs patient           --count 10 --seed 7
node gen.mjs customer          --count 50 --seed 1  --csv
node gen.mjs order             --count 30 --seed 1  --out orders.json
```

Flags: `--count N` (default 10), `--seed S` (any string or number; same seed plus same count
gives byte-identical output), `--csv` (flatten nested objects into CSV instead of JSON),
`--out FILE` (write to a file instead of stdout).

**Fleet default (one command):** `node seed-fixtures.mjs` generates the canonical, reproducible
fixture bundle for all common shapes (hearing-screening, patient, customer, order) at a fixed
seed, plus a `manifest.json` with per-file sha256. This is the portfolio standard for dev/test
data, see `app-kit/DEV-DATA-STANDARD.md`. Flags: `--out DIR`, `--seed S`, `--csv`.

Shapes:
- **hearing-screening** (iHEARtest-style): `age_band`, `ear`, per-frequency dB **category
  bands** (`250hz_band` ... `8000hz_band`, each one of `normal / mild / moderate /
  moderately-severe / severe / profound`), and a `result_category_tier`
  (`pass / refer-mild / refer-moderate / refer-urgent`). This mirrors the app's own telemetry
  privacy rule: never emit raw dB or frequency measurements as if real, only banded categoricals.
- **patient** (MedReview-style): fake name, fake `SYN-######` MRN, fake dob, sex, an
  ICD-10-shaped dx code with description, and a short synthetic clinical note. Emails use
  fabricated TLDs (`.test` / `.invalid`) so they can never collide with a real inbox.
- **customer** (Customer.io-style): fake name, email, phone, city/state, and a purchase history.
- **order** (Shopify-style): fake customer, line items drawn from a fake product catalog, and
  consistent subtotal/tax/total math.

Every record includes `"synthetic": true`.

## Part 2: de-identify a real extract (`deident.mjs`)

Implements HIPAA Safe Harbor (45 CFR 164.514(b)(2)): strips or transforms all 18 identifier
categories from every record it is handed, whatever the input shape, and emits both the cleaned
records and a report of which categories were found and redacted (the report lists category
names only, never identifier values).

```
node deident.mjs --file real_extract.json                       # de-identified JSON to stdout
node deident.mjs --file real_extract.csv --csv                  # CSV in, CSV out
cat real_extract.json | node deident.mjs --out clean.json --report report.json
```

### Fail-closed guarantee

`deident.mjs` is **default-deny, not default-allow**. Every key in an input record is checked
against an explicit SAFE allowlist of known non-identifying fields (age bands, ear side,
per-frequency dB categoricals, result tiers, sex, state, ICD-10 dx code fields, and order
totals/quantities/currency/line-item names). Any key that is not on that allowlist, and does not
match a known identifier category, is **dropped** rather than passed through, and shows up in the
strip report as `dropped (unclassified)`. There is no code path that returns an unrecognized
column's value unchanged, so an unknown or newly added column in a real extract is safe by
construction: it disappears from the output instead of leaking.

On top of the default-deny structure, `deident.mjs` also runs shape-based identifier detection
(belt-and-suspenders): a value that looks like an MRN, account number, VIN, device serial, or a
generic prefixed code is redacted even under a key name none of the lists above recognize
(covers variants such as `member_number`, `insurance_policy_no`, `claim_number`,
`vehicle_serial`, `hearing_aid_sn`, and similar).

**Known limitation - honorific heuristic, not full NER.** Names embedded in free-text note fields
are caught with a heuristic: an honorific (`Dr.`, `Mr.`, `Mrs.`, `Ms.`, `Pt`, `Patient`) followed
by one or more capitalized tokens is redacted. This is not full named-entity recognition and will
miss a name in prose with no preceding honorific (for example "his wife Maria" with no title).
The heuristic is a best-effort net on top of the default-deny structural guarantee; the
structural guarantee, not the heuristic, is what actually prevents leakage of unknown columns.

**Known limitation - street-address heuristic in prose.** Street addresses embedded in free-text
notes (a house number followed by street-type tokens like St, Ave, Rd, Blvd, plus an optional
trailing ", City ST ZIP") are redacted to `[ADDRESS-REDACTED]`. Structured geo/ZIP keys are handled
separately (state kept, ZIP reduced to a Safe-Harbor 3-digit ZCTA). A bare city or town name in
prose with no street suffix (for example "moved to Springfield last year") requires a gazetteer or
full NER and is not caught by this heuristic. State-level geography is permitted under Safe Harbor
and is intentionally retained. When a note field may carry uncaught free-text geography, drop the
note field itself or apply expert determination.

**DOB / age-over-89 coupling.** When a record's implied age exceeds 89 (derived from an explicit
age field OR computed from a DOB-shaped field's year), the DOB year itself is suppressed
(`REDACTED-90+`), not just any separate age field. Safe Harbor forbids retaining any date element,
including year, once the implied age is over 89.

### The 18 HIPAA Safe Harbor categories, and how this tool handles each

1. **Names** -> redacted, including names embedded in free-text notes via the honorific
   heuristic described above (see limitation note).
2. **Geographic subdivisions smaller than a state** (street, city, county, precinct) -> redacted;
   state is kept (Safe Harbor permits state-level geography). ZIP: kept as the 3-digit prefix only
   if that prefix is on a verified >20,000-population allowlist, otherwise zeroed to `000`
   (conservative default: every ZIP is zeroed unless explicitly allowlisted).
3. **All elements of dates** (except year) directly tied to an individual -> year only, including
   non-ISO date shapes embedded in prose (`MM/DD/YYYY`, `M/D/YY`, `MM-DD-YYYY`, `15-Mar-2024`,
   `Jan 3, 2024`). **Any age over 89 -> `90+`, and whenever a record's age exceeds 89, the DOB
   field's year is also suppressed** (Safe Harbor forbids retaining any date element, including
   year, once implied age exceeds 89 - keeping just the birth year would still narrow the subject
   to a small population).
4. **Telephone numbers** -> redacted.
5. **Fax numbers** -> redacted.
6. **Email addresses** -> redacted.
7. **Social Security numbers** -> redacted, including unanchored SSNs embedded in free text in
   dashed, dotted, spaced, or bare-digit form.
8. **Medical record numbers** -> redacted.
9. **Health plan beneficiary numbers** -> redacted.
10. **Account numbers** -> redacted.
11. **Certificate/license numbers** -> redacted.
12. **Vehicle identifiers and serial numbers** (including plates) -> redacted.
13. **Device identifiers and serial numbers** -> redacted.
14. **URLs** -> redacted.
15. **IP addresses** -> redacted.
16. **Biometric identifiers** -> redacted.
17. **Full-face photographs and comparable images** -> redacted.
18. **Any other unique identifying number, characteristic, or code** -> covered two ways: a
    generic-identifier key-name catch-all (any field named/suffixed `id`, `uuid`, `record_id`,
    `order_number`, etc.), and the **fail-closed default**: any key that is not on the SAFE
    allowlist and does not match a known category above is dropped outright, so an unrecognized
    identifying column can never leak silently.

Run it against nested JSON of any shape (arrays or single objects) or flat CSV. Known identifier
fields are transformed per the table above; note-like free-text fields (`note`, `notes`,
`comment`, `comments`, `description`, `summary`, `narrative`) are kept but scrubbed for embedded
identifiers; every other field is either on the SAFE allowlist (passed through, still scrubbed if
a string) or dropped as unclassified. Nothing unrecognized is ever passed through untouched.

## Rule: where each tool runs

- `gen.mjs`: anywhere, including non-BAA sandboxes. It touches no real data.
- `deident.mjs`: only where the **input** already is (inside the BAA-covered environment). It is
  a pure transform with no fetch capability, but the discipline that matters is upstream: never
  copy a real extract into a non-BAA sandbox "to run deident.mjs on it there." Bring the tool to
  the data's boundary, not the data to the tool.

## Tests

`tests/synthetic-health-data.test.mjs` (run via the toolkit's `run-tests.sh`) validates every
generator shape and asserts, for a synthetic "real-looking" record, that all 18 Safe Harbor
categories are detected and transformed, including identifiers embedded in free text. It also
carries fail-closed regression cases: an unclassified/unknown key is dropped rather than passed
through, a prose name following an honorific is redacted, an unanchored SSN in free text is
redacted, non-ISO dates in free text reduce to year only, an over-89 age suppresses the DOB
year, and identifier-shaped values under unfamiliar key names are still caught.
