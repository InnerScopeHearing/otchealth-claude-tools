---
name: safety-monitor
description: Detects customer safety escalations in Intercom conversations (physical injury, adverse/allergic reaction, emergency medical care, or an explicit device hazard) and, on a match, tags the conversation with the existing "safety-escalation" tag and publishes ONE alert to a human via AWS SNS. It never contacts a customer under any condition -- no reply, no message, no note, by any channel. Detection-only, alert-a-human-only. Use this to rebuild real-time safety-escalation detection after the n8n workflow that used to do this (D8NH3ITNIhvPyjfP) died with the Azure loss and has no recoverable source. Dry-run by default; --commit required for any write.
---

# safety-monitor -- customer-safety escalation detection, tag, and alert (never a customer reply)

## Why this exists

Real-time safety-escalation tagging ran on n8n workflow `D8NH3ITNIhvPyjfP`. It died with the Azure
loss on 2026-08-13 and has no recoverable JSON anywhere in the fleet's recovery archives -- **this is
a rebuild, not a restore** (finding `FND-20260902-81bc`, severity CRITICAL).

Evidence of the gap, verified live 2026-09-02: the Intercom tag `safety-escalation` (id `15837481`)
was applied to 5 conversations in the 30 days *before* the loss and to exactly 1 conversation *since*
(created 2026-08-14, right at the boundary), while 77 customer conversations were created in that same
post-loss window. Detection has been effectively off for three weeks.

## The hard rule this design starts from

The predecessor workflow did real damage, not just a missed detection: a bare keyword-**stem** match
on the single word "physician" fired on marketing spam mentioning the brand **"Physician's Choice"**,
and the workflow auto-replied to that sender with a real message telling them to stop wearing a device
they never owned.

Two separate lessons follow, and this build treats them as separate:

1. **It must never contact a customer, structurally.** This monitor makes exactly two kinds of writes:
   applying the existing `safety-escalation` Intercom tag, and publishing one SNS message to a human.
   There is no import, no helper, and no endpoint call anywhere in `monitor.mjs` shaped like a
   customer-facing Intercom write (`POST /conversations/{id}/reply`, `POST /messages`, a
   `reply_conversation`/`create_conversation`/`send_message`-named helper, or the equivalent gateway
   tools `intercom_reply_conversation` / `intercom_create_conversation`). This is pinned by
   `tests/no-customer-writes.test.mjs`, which greps `monitor.mjs`'s own source for exactly these
   shapes and fails the build if any appear -- and separately proves the scanner itself is not vacuous
   by confirming each pattern really does fire on a synthetic snippet built to trip it.
2. **Word-boundary regex alone does not fix the classifier bug.** `\bphysician\b` genuinely matches
   the standalone word "Physician" inside "Physician's Choice" (there is a real word boundary between
   "n" and the apostrophe) -- so a naive "just add `\b`" patch would not have stopped the original
   incident. The actual fix is that `classify.mjs`'s rule table never contains a bare common noun or
   role word as a trigger at all; every rule is a specific phrase that describes an actual harm outcome
   (an injury, a reaction, emergency care, a device hazard). A small brand-context suppression table
   masks a few known confusable phrases (currently just "Physician's Choice") as defense in depth on
   top of that, not a substitute for it. See `classify.mjs`'s own header comment for the full
   reasoning, and `tests/classify.test.mjs` for the exact documented-false-positive test case plus a
   test proving suppression does not blind the classifier to a real hazard mentioned in the same
   message.

## Design

- **Idiom-hardened, not just brand-suppressed.** A precision pass against the FIRST draft of
  `classify.mjs`'s rule table found the same class of bug the "Physician's Choice" incident
  illustrates, hiding in three more rules: a bare "shocked me" also matches "the price shocked me"
  (sticker shock), a bare "cut me" also matches "cut me some slack", and a bare "bleeding" also matches
  "bleeding money/cash" (a real risk in an inbox this monitor's own live testing confirmed receives
  marketing and cost-complaint email). All three verbs now require an explicit body part
  (`harmed-bodypart`, e.g. "burned my hand") or an unambiguous phrase ("electric(al) shock") before
  they fire; see `tests/classify.test.mjs`'s "idiom false positive (regression)" cases, each paired
  with a counterpart test proving the narrower rule still catches a genuine report using the same verb.
- **Detection scope: customer-authored text only.** The initial message and every conversation part
  whose `author.type` is `user`, `lead`, or `contact` are classified; admin/teammate/bot content never
  is. This is deliberate: admin apology boilerplate ("sorry you were hurt", "we take safety hazards
  seriously") would otherwise be a rich false-positive source on these exact rules.
  **Known limitation, not an oversight:** a staff phone-call note that paraphrases what a customer
  reported verbally is therefore *not* scanned by this version. If that gap matters in practice,
  extending detection to admin `note`-type parts would need its own, separately-tuned rule set (notes
  are staff-authored by construction, so the existing customer-phrase rules would false-positive on
  them constantly) -- a follow-on, not part of this build.
- **Discovery is two independent paths, reconciled -- never search alone.** `FND-20260817-64f5` (see
  `../../FINDINGS-LEDGER.md`) documents `/conversations/search` **missing** real safety-tagged
  conversations inside the exact window a daily check queried, and separately returning an empty
  result set for one specific conversation despite a nonzero `total_count` on the same query --
  **direct GET by conversation id always worked.** So this monitor unions ids found by the direct list
  endpoint (`GET /conversations`, paginated, filtered client-side by `created_at`) with ids found by
  `/conversations/search` over the same window, logs any id one path found that the other did not (a
  live signal the gap is still present, or has moved), and always re-fetches full detail for every id
  in the union via the one path that has proven reliable: direct `GET /conversations/{id}`.
  List ordering was live-verified 2026-09-02 to come back newest-first by `created_at`; the discovery
  code still verifies that as it pages rather than assuming it, and only takes an early-stop shortcut
  while descending order has actually held for every item seen so far in that run.
- **Idempotent by construction, no separate state store.** A conversation already carrying the
  `safety-escalation` tag is skipped outright. This makes a generous, overlapping lookback window
  (default 72h, `--hours=N`) cheap and safe on every run: re-scanning an already-handled conversation
  costs a few extra reads, never a duplicate tag or alert.
- **Fail loud, always.** A classifier error, an Intercom failure, a tag-write failure, or an SNS
  failure is caught, recorded as a distinct message naming what failed, and makes the run exit
  non-zero. No branch of this script can report success while something actually failed. Verified by
  `tests/monitor-sweep.test.mjs`'s dedicated tests for each failure class, including proof that one
  bad conversation never silently swallows the rest of the run.
- **Privacy.** Conversation ids, matched rule ids/categories, and the action taken are logged to
  stdout. A truncated (<=120 char) quote of the matched customer text exists ONLY inside the one SNS
  message a real match produces -- it is never placed on the run's returned/printed summary and never
  written to stdout. Pinned by `tests/monitor-sweep.test.mjs`'s privacy test, which asserts the
  serialized summary contains no `snippet` field and none of the verbatim matched text.
- **SNS topic verified live before wiring this up**, not just asserted: `arn:aws:sns:us-east-1:
  900915535335:otchealth-alerts` returned a real `GetTopicAttributesResponse` (owner `900915535335`,
  1 confirmed subscriber) when queried with the new shared signer below. The code does not re-verify
  the topic's existence on every run beyond simply publishing to it -- a missing/renamed topic would
  fail the Publish call itself with a clear SNS error, which the existing fail-loud path already
  surfaces; a separate preflight `GetTopicAttributes` call on every commit run was judged redundant
  complexity for no added safety.

## The shared SigV4 extraction (`../kb-memory/sigv4.mjs`)

`FND-20260828-5ca1` (open, medium) found five independent hand-rolled AWS SigV4 signers already in
this repo with two contradictory canonical-header conventions between them, and asked for a shared
extraction point before the next SigV4-shaped caller lands. `../kb-memory/sigv4.mjs` is that point;
this skill's SNS publish call is its first consumer. **The existing five are deliberately NOT
refactored here** -- each is load-bearing production code with its own test coverage, and collapsing
them onto a shared signer is a real, separately-reviewable change, not a rider on this feature. See
`sigv4.mjs`'s own header for the full reasoning, and `../kb-memory/tests/sigv4.test.mjs` for how its
core HMAC-chain algorithm is checked: by differential testing against a second, independently-written
implementation of AWS's own documented 4-step formula (an earlier draft tried pinning a single
memorized "known-good" hex constant instead; that constant, and a web search that seemed to confirm
it, were both wrong -- see the test file's own comment for why a magic constant nobody can verify is
worse than no such test).

## Run

```
node monitor.mjs [sweep] [--commit] [--json] [--hours=N] [--max-pages=N]
node monitor.mjs verify [--json]        # auth + tag-id sanity check only, no conversation scan
```

`--commit` is required for BOTH the Intercom tag write and the SNS publish. Without it, every
conversation that would be tagged and alerted is reported as `WOULD TAG+ALERT (dry run)` and nothing
is written or published -- discovery, classification, and reconciliation still run for real against
live Intercom, only the two write actions are held back.

`--hours` (default 72) is the lookback window for discovery; `--max-pages` (default 20, at 50
conversations/page) is a pagination safety cap for both discovery paths.

## Credentials

Intercom token: SSM `/otchealth/intercom-access-token`, read via `kvSecret("intercom-access-token")`
from `../kb-memory/azure-secret.mjs` (which now defaults to the AWS SSM backend). `Intercom-Version:
2.11` is sent on every call. AWS credentials for the SNS publish resolve via the same `awsCreds()`
chain (`../kb-memory/aws-secret.mjs`) every other AWS-touching skill in this repo already shares.

## What this skill deliberately does NOT do

- It never scheduled itself as a job. Scheduling this (and choosing a production cadence + lookback
  overlap) is a separate, deliberate follow-on decision, not bundled into this build.
- It never contacts a customer, by any channel, under any condition -- see "The hard rule" above.
- It does not widen detection to admin/teammate-authored content (the known limitation above).
- It does not re-implement or replace the dead `D8NH3ITNIhvPyjfP` workflow's other behavior (routing
  to the Safety Escalations team, etc.) -- see the separately tracked, still-open finding
  `safety-escalation-rota-gap-2026-08-06` (that team has no human on rota; this monitor's SNS alert is
  designed to reach a person directly, precisely because that rota gap exists and is not this skill's
  to fix).
