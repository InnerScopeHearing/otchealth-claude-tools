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

### The 18 HIPAA Safe Harbor categories, and how this tool handles each

1. **Names** -> redacted.
2. **Geographic subdivisions smaller than a state** (street, city, county, precinct) -> redacted;
   state is kept (Safe Harbor permits state-level geography). ZIP: kept as the 3-digit prefix only
   if that prefix is on a verified >20,000-population allowlist, otherwise zeroed to `000`
   (conservative default: every ZIP is zeroed unless explicitly allowlisted).
3. **All elements of dates** (except year) directly tied to an individual -> year only.
   **Any age over 89 -> `90+`.**
4. **Telephone numbers** -> redacted.
5. **Fax numbers** -> redacted.
6. **Email addresses** -> redacted.
7. **Social Security numbers** -> redacted.
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
18. **Any other unique identifying number, characteristic, or code** -> a generic-identifier
    catch-all (any field named/suffixed `id`, `uuid`, `record_id`, `order_number`, etc.) is
    redacted, and free-text fields (notes, comments) are scanned for embedded emails, phones,
    SSNs, URLs, and IPs so identifiers hiding in prose are not missed.

Run it against nested JSON of any shape (arrays or single objects) or flat CSV; unknown fields are
passed through untouched, known identifier fields are transformed per the table above, and any
remaining string value is scrubbed for embedded identifiers regardless of field name.

## Rule: where each tool runs

- `gen.mjs`: anywhere, including non-BAA sandboxes. It touches no real data.
- `deident.mjs`: only where the **input** already is (inside the BAA-covered environment). It is
  a pure transform with no fetch capability, but the discipline that matters is upstream: never
  copy a real extract into a non-BAA sandbox "to run deident.mjs on it there." Bring the tool to
  the data's boundary, not the data to the tool.

## Tests

`tests/synthetic-health-data.test.mjs` (run via the toolkit's `run-tests.sh`) validates every
generator shape and asserts, for a synthetic "real-looking" record, that all 18 Safe Harbor
categories are detected and transformed, including identifiers embedded in free text.
