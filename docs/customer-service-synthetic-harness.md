# OTCHealth synthetic customer-service harness

This is a deterministic, simulation-first test program for the OTCHealth customer-service system. It covers email, phone, and SMS scenarios across identity, order lookup, WISMO, safety escalation, complaints, retries, terminal failures/DLQ, CSAT, verified resolution, and channel-specific safeguards.

## Safety contract

The harness is **synthetic offline only**:

- No real customer identity, customer roster, order, phone number, email address, or message body is used.
- No network call is made by the evaluator.
- No n8n workflow is activated, executed, published, or mutated.
- No Intercom, Customer.io, Twilio, ElevenLabs, Shopify, or Stripe action is performed.
- No email, SMS, phone call, refund, credit, order, shipment, inventory update, authorization consumption, or DNS change can occur.
- Every report keeps `launch_decision` at `HOLD_NO_GO_UNCHANGED`.

This is deliberately stronger than a conventional unit test: the matrix rejects destructive expected values, the evaluator exposes effect counters, and the report records the zero-effect counters explicitly.

## Files

- `tests/fixtures/customer-service-scenarios.json`: 59 machine-readable scenarios, 3 channels, 12 control families, authority floor, and expected outcomes.
- `scripts/customer-service-harness-lib.mjs`: dependency-free evaluator and matrix validator.
- `scripts/customer-service-harness.mjs`: CLI runner that writes a report and receipt with SHA-256 hashes.
- `tests/customer-service-harness.test.mjs`: Node built-in test suite, including repeat determinism and fail-closed negative cases.
- `docs/customer-service-harness-defects.json`: environment and coverage gaps observed while building the harness. These are not silently promoted to product defects.

## Run locally

```bash
node --check scripts/customer-service-harness-lib.mjs
node --test tests/customer-service-harness.test.mjs
node scripts/customer-service-harness.mjs --repeat=3 --out=tests/evidence/customer-service-harness-report.json
```

Exit code is nonzero only when the scenario matrix or evaluator mismatches its declared contract. A passing run means `PASS_SYNTHETIC_EVIDENCE_ONLY`, never production readiness.

## Current result

The verified local run on 2026-08-19 executed 59 scenarios three times:

- 177/177 scenario executions passed
- 531 expected-value assertions evaluated
- 0 defects reproduced by the evaluator
- 0 network calls, customer contacts, provider calls, refunds/credits, inventory mutations, shipments, orders, authorization consumptions, canonical writes, or production DNS changes
- Launch decision: `HOLD_NO_GO_UNCHANGED`

## Architecture anchors used for scope

The scenario families follow the current customer-service architecture and existing receipts:

- Intercom is the conversational inbox/data layer.
- Customer.io is marketing/newsletter/batch only, not conversational support.
- Twilio plus ElevenLabs handle SMS and voice.
- n8n self-host is the orchestration engine.
- Shopify and Stripe remain money truth.
- Identity proofing, subject-bound context gates, Twilio signature checks, canonical terminal-error routing, outcome polling, and verified-resolution reconciliation are the Wave 1 control surfaces.

Repository references used during design:

- `otchealth-cto/runbooks/customer-service-reliability-architecture.md`
- `otchealth-cto/runbooks/2026-08-07-customer-service-wave1-reliability.md`
- `otchealth-cto/recovery-receipts/n8n-required-cs-workflows.json`
- `voice-agent-evals/README.md` and its existing 3-agent x 5-persona synthetic simulator
- `otchealth-claude-tools/skills/voice-ops/SKILL.md`
- `otchealth-claude-tools/coo/warranty/synthetic-drills/`

## What remains unproven

This harness is not a live-channel certification. It does not prove:

- n8n execution receipts, active workflow state, webhook response codes, or downstream node execution
- Twilio signature verification against provider-generated callbacks
- ElevenLabs transcript behavior or tool invocation timing
- Intercom object creation, assignment, acknowledgment, resolution, or CSAT write ordering
- Shopify order data, Stripe payment state, or WISMO provider truth
- response-time SLOs, queue staffing, named backups, or human resolution
- live outage recovery, DLQ replay, restore, or two-run reconciliation
- any customer-facing or production launch gate

The next safe step is a separate staging adapter suite with pinned inputs and explicit receipts. It must remain inactive/no-send and use synthetic recipients only.
