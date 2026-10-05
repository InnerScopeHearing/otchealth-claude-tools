# Business contract draft checks

Source-free, deterministic validators for **synthetic/internal metadata fixtures only**. This package supports draft validation for N08 entitlement and N10 supplier-handoff records. Every result is labeled `draft_validation` with `live_authorization: false`; `ready` means the supplied synthetic fixture satisfies the draft contract only. It does not establish customer eligibility, authorize purchases, submit supplier commitments, create orders/refunds, contact people, or adopt a medical/legal/commercial policy.

Run `node cli.mjs < fixture.json` from this directory. The CLI reads one JSON object from stdin, accepts only synthetic marker strings, timestamps, enumerated metadata and numeric/boolean values, rejects free-text/customer-identifying fields, emits diagnostics only, and performs no network or filesystem writes. Top-level input must include `draft_validation: true`, `live_authorization: false`, and `workflow: "N08"` or `"N10"`. N08 fields: `purchase`, `packs`, optional `follow_up`, `context`, `now`. N10 fields: `handoff`, `context`, `now`.

Tests: `node --test *.test.mjs`. Tests use synthetic fixtures and no provider or service calls.
