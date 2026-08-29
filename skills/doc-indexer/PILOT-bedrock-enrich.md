# Bounded pilot: enrich.mjs's Bedrock provider lane

Status: **code shipped, provider is opt-in, nothing scheduled.** `ENRICH_PROVIDER=openai` (or the
older `ENRICH_LLM_PROVIDER`) remains the default for every caller that does not explicitly pass
`--llm-provider bedrock` / set `ENRICH_PROVIDER=bedrock`. `job/librarian.sh`'s master `ENRICH=1`
per-room opt-in switch is untouched by this change and stays exactly as it already is today
(finance and legal-company are OFF per otchealth-cto/CLAUDE.md's 2026-08-19 "OPEN -- Matt's call
before the big backfill" note). **This document is the pilot the CTO runs before flipping either
room's schedule onto Bedrock, or onto ENRICH at all.** Nothing in this PR arms a schedule.

## Why this exists

The two privileged rooms this pipeline can reach -- `finance-cfo-source-docs` (~36K docs) and
`legal-company` (~9.9K docs, contains INND MNPI) -- currently send document TEXT to OpenAI-direct
for enrichment, a non-BAA third-party processor, where the retired Azure Foundry path sat inside
the enterprise agreement. AWS Bedrock in this fleet's OWN account (`900915535335`, `us-east-1` --
the SAME account the source documents already live in via the S3 storage mirror) introduces no new
data boundary at all. See `otchealth-cto/CLAUDE.md`'s 2026-08-19 entry and `FND-20260821-783d` for
the recorded decision this lane exists to make possible.

`legal-personal` is excluded from this pipeline categorically, for every provider, regardless of
this pilot -- see `pipeline-paths.mjs`'s `isLegalPersonalRoom()` and `enrich.mjs`'s `cmdRun()`,
which refuses before any storage/LLM call. Never target it with this pilot or any real run.

## What shipped (code only -- read `enrich-llm.mjs` and `enrich.mjs`'s "LLM chat" section for the
full rationale; this is the operational summary)

- `--llm-provider openai|azure|bedrock`, also `ENRICH_PROVIDER` / `ENRICH_LLM_PROVIDER` (either
  name works; `ENRICH_PROVIDER` is checked first). **Default remains `openai`, byte-identical to
  today's behavior when the flag/env is omitted.**
- `--model <id>` still wins over everything. Absent that, `ENRICH_MODEL` wins. Absent that, the
  Bedrock lane defaults to `ENRICH_BEDROCK_MODEL` env, or, absent that,
  `us.anthropic.claude-haiku-4-5-20251001-v1:0` -- **live-verified 2026-08-29** with a real forced
  tool-use Converse call from this fleet's AWS account/region (`{"word":"ping"}`, `stopReason:
  "tool_use"`, real token usage reported). Region defaults to `us-east-1`, overridable via
  `--bedrock-region` / `BEDROCK_REGION`.
- Reuses `bedrock-client.mjs`'s `converseJson()` (deep-pass.mjs's already-merged Bedrock Converse
  client, PR #472) unmodified -- no second Bedrock signer/transport was written. Converse has no
  `response_format: json_object`, so the Bedrock lane forces a tool call (`emit_metadata`, a
  loosely-typed `additionalProperties:true` schema -- see `enrich-llm.mjs`'s own comment on why the
  per-domain field schema is NOT duplicated here) instead; the result is re-serialized back through
  `JSON.stringify` so it flows through the EXACT SAME `extractJsonObject`/`_parseFailed`/
  `_callFailed` contract the OpenAI/Azure lanes already use. No downstream code (the patch/enriched-
  marker logic, the review queue, the cost line) has a Bedrock-specific branch.
- **The failure taxonomy this repo's own header calls "the most-taught lesson" is preserved and
  extended, not just for OpenAI/Azure:** a THROW from Bedrock (network error, a non-retryable HTTP
  status, retries exhausted, or missing AWS credentials) becomes `_callFailed` -- the row is NOT
  marked enriched, its `enriched_sha256` is blanked (retried next run), and if EVERY call in the run
  fails, the run prints `FATAL: all N LLM call(s) failed` and exits non-zero. A CONTENT failure (the
  model answered but produced no usable tool call -- a forced-tool refusal, or `max_tokens`
  truncation) is the OTHER, non-fatal case: the row IS marked enriched (so it is not retried forever
  on a model that keeps answering the same useless way) but flagged into
  `_REVIEW/metadata-review-queue.csv`. Both paths are integration-tested end to end against a
  stubbed Bedrock endpoint (`tests/enrich-llm.test.mjs`), not just asserted in isolation.
- Cost: `estCost()` now delegates to `enrich-llm.mjs`'s `ratesFor()`/`estCostFor()`, with a Bedrock
  default rate pair of $1.00/$5.00 per 1M tokens (in/out) -- matching deep-pass.mjs's own `RATES`
  table entry for the identical model id, so the two ports never quietly disagree on price.
  Env-overridable per provider: `ENRICH_BEDROCK_RATE_IN`/`ENRICH_BEDROCK_RATE_OUT` (and the
  `ENRICH_OPENAI_RATE_*` / `ENRICH_AZURE_RATE_*` equivalents). **Verify against
  `aws bedrock list-inference-profiles --region us-east-1` and the live Bedrock pricing page before
  trusting a cost estimate on a real backfill** -- this is training-data knowledge of the on-demand
  catalog, not a live pricing probe.
- The run summary line now prints `tokens_in=<N> tokens_out=<N> provider=<p> model=<id>` alongside
  the cost estimate for every provider, so a Bedrock run's honesty is directly checkable against
  AWS's own billing console, not only against this file's own RATES table.

## Pre-flight checklist (do this before touching a real room)

1. Confirm AWS credentials for Bedrock are available in the environment that will run the pilot
   (ECS task role, or `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, or `OTC_AWS_ACCESS_KEY_ID`/
   `OTC_AWS_SECRET_ACCESS_KEY` -- see `bedrock-client.mjs`'s header).
2. Confirm Anthropic model access is enabled for the chosen model id in this account/region (a
   separate, account-level Bedrock grant from merely being able to list models). A quick live
   1-token-class check, run from the same environment as the pilot:
   ```js
   node -e '
   import("./skills/doc-indexer/bedrock-client.mjs").then(async ({ converseJson }) => {
     const res = await converseJson({
       modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0", region: "us-east-1",
       system: "Reply with exactly one word.", userContent: [{ text: "Say the word: ping" }],
       toolName: "emit_reply", toolSchema: { type: "object", properties: { word: { type: "string" } }, required: ["word"] },
       maxTokens: 64, temperature: 0,
     });
     console.log(JSON.stringify(res));
   });'
   ```
   Expect `stopReason: "tool_use"` and `obj.word === "ping"`. If it instead throws, or returns
   `stopReason: "max_tokens"` with an empty `obj`, do not proceed -- diagnose credentials/model
   access/token budget first (a `max_tokens` truncation on a trivial call usually just means the
   budget was too small for the tool-call scaffolding overhead; enrich.mjs's real calls use
   `maxTokens: 1200`, comfortably above what this smoke test needs).
3. Re-verify pricing (see the RATES caveat above) if this pilot is being run more than a few weeks
   after 2026-08-29.

## The bounded pilot itself

Run this from a session with the fleet's normal AWS/OpenAI credentials hydrated, from
`skills/doc-indexer/`. All commands target `--profile finance` (`finance-cfo-source-docs`, the
account/container `otchealthcfodata/cfo-source-docs`), the larger and lower-sensitivity of the two
privileged rooms named in the "why this exists" section above; run the legal-company pilot
separately, afterward, only once the finance results look good.

**This pilot is NOT read-only.** Steps 1 and 3 below write real enriched metadata fields onto real
document chunk rows in the LIVE `finance-cfo-source-docs` OpenSearch room (via `--search-backend
opensearch`, matching what `job/librarian.sh` actually uses in production -- the CLI's own default,
`--search-backend azure`, would silently never reach the live brain at all, since Azure AI Search is
permanently gone). If a batch's quality looks wrong, the fix is a normal re-run with `--reindex`
against whichever provider produced the good result; nothing here is destructive beyond "the field
values on those rows change," which enrichment overwrites are already designed to tolerate.

### Step 1: a small OpenAI control batch (today's existing behavior, for comparison)

```bash
node enrich.mjs run --profile finance --search-backend opensearch --limit 20
```

This is the DEFAULT provider (`openai`, unchanged) against the first 20 eligible finance rows.
Capture what it produced for each of those 20 documents BEFORE step 2 overwrites them:

```bash
# repeat --path for however many of the 20 paths are worth spot-checking by hand, or script it by
# reading the freshly-enriched rows straight out of the catalog (path/doc_title/keywords/summary/
# entities/confidence are all plain fields on each row)
node enrich.mjs verify --profile finance --search-backend opensearch --path "<catalog path>"
```

### Step 2: re-enrich the SAME 20 rows via Bedrock, for a like-for-like comparison

```bash
node enrich.mjs run --profile finance --search-backend opensearch --llm-provider bedrock --limit 20 --reindex
```

`--reindex` forces re-enrichment even though these rows are already marked enriched at their
current sha256 -- without it, `needsEnrich()` would skip them entirely and this command would be a
no-op. `--limit 20` against a stable, unchanged catalog resolves to the SAME first 20 eligible rows
step 1 touched (catalog order is stable; nothing else has enriched anything in between), so this is
a genuine apples-to-apples re-run, not a different sample.

**Inspect now, before proceeding:**
- `verify` each of the 20 paths again and diff against what was captured in step 1: does
  `doc_title`/`keywords`/`entities`/`summary`/`confidence` look at least as good? Any obvious
  hallucination, missed entity, or wrong doc_type?
- The run's stdout summary line: `llm: N/N calls ok, tokens_in=... tokens_out=... provider=bedrock
  model=...` -- confirm `N/N` (no failures) and sanity-check the token counts against what a
  20-document batch should plausibly cost.
- `_REVIEW/metadata-review-queue.csv` in the room: did Bedrock flag any of these 20 for review that
  OpenAI did not (or vice versa -- diff against a copy saved before step 1, since the file is
  rewritten on every run)?

If this looks wrong, STOP here. Do not proceed to step 3. Re-run step 1's command with `--reindex`
to restore the OpenAI-enriched values on these 20 rows, and report back before trying again.

### Step 3: the real ~200-document bounded pilot

```bash
node enrich.mjs run --profile finance --search-backend opensearch --llm-provider bedrock --limit 200 --concurrency 2
```

Because the first 20 rows are now already enriched (by Bedrock, from step 2, at their current
sha256), this naturally targets the NEXT ~200 distinct eligible rows -- no overlap with the
comparison batch. `--concurrency 2` is a conservative starting point for a model/account combination
that has not carried real production traffic yet; `converseJson()` already retries a 429
(ThrottlingException) with exponential backoff, so this is a courtesy against unnecessary retries on
the very first real batch, not a hard requirement -- raise it on a later, larger run if no
throttling is observed.

**Inspect after this run:**
- The `_callFailed` count: the run's stdout prints `llm: (N-failed)/N calls ok`; if the FATAL
  all-failed message appears, STOP and diagnose (credentials, model access, region, or a genuine
  Bedrock outage) before running any larger batch.
- `~$` cost line + `tokens_in=.../tokens_out=...`: sanity-check against AWS Bedrock's own billing/
  usage console for the same time window, not only against this file's RATES table.
- `_REVIEW/metadata-review-queue.csv` growth: how many of the ~200 got flagged, and for what reason
  (`enrich_reasons` on each flagged row) -- compare the flag RATE against this room's typical
  OpenAI-lane flag rate (visible in the same file from prior runs) as a coarse quality signal.
- Spot-check several `verify`-ed documents by hand across the batch, not only the ones that got
  flagged -- a model can be confidently wrong without tripping the confidence gate.

## After the pilot

**Do not flip `ENRICH_PROVIDER=bedrock` (or arm `ENRICH=1`) on `otchealth-job-librarian-finance` or
`otchealth-job-librarian-legal-company`'s schedule until the CTO has reviewed this pilot's results
and made that call explicitly.** This PR does not touch `job/librarian.sh`, any ECS task
definition, or any EventBridge schedule -- that is a deliberate scope boundary (this PR is code +
tests + this runbook only), not an oversight. When the CTO is ready to arm it, the change is a
task-definition/job-env edit (`ENRICH=1` plus `ENRICH_PROVIDER=bedrock`, optionally
`ENRICH_BEDROCK_MODEL`/`ENRICH_BEDROCK_RATE_IN`/`ENRICH_BEDROCK_RATE_OUT` if the defaults above are
not what's wanted), not a code change.

`legal-company` carries INND MNPI; run its own bounded pilot (same steps, `--profile legal`, default
container `company` -- never `--container personal`, which is hard-refused regardless of provider,
see `pipeline-paths.mjs`) separately and do not assume the finance room's results transfer directly
-- legal documents may exercise the model differently (denser cross-references, more entities per
document, different document-type mix).
