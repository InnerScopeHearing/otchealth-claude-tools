# OpenAI cost visibility

## Why this exists

The fleet spends real money on OpenAI: chat via the gpt-4o/gpt-4.1/gpt-5.x families, embeddings
(`text-embedding-3-large`) for the company brain, and `gpt-image-*` for the designer skill. Until this
was built, there was **zero provider-side visibility** into any of it:

- The only credential is a project key (`sk-proj-...`).
- OpenAI's Admin/Usage APIs return `403` on a project key (no `api.usage.read` scope).
- The legacy `GET /v1/usage` endpoint returns empty data for project keys (verified live across 6
  dates, all empty).
- There is no admin key anywhere in the vault. Getting one is a Matt-gated account action (an org
  owner has to mint it), not something a code change can fix.

So this measures at the **source** instead of the provider: every OpenAI response carries a `usage`
object (chat: `prompt_tokens`/`completion_tokens`, plus `prompt_tokens_details.cached_tokens` when
prompt caching applied; embeddings: `prompt_tokens`/`total_tokens`). `setup/openai-usage.mjs`'s
`recordOpenAIUsage()` turns that into Datadog metrics plus a local JSONL ledger.

## What is measured

Every real OpenAI call this toolkit and the gateway make, at the point each one already has a parsed
response in hand:

- **Chat completions** (`setup/model-routing.mjs`'s `fetchOpenAIWithFlexRetry()`, and the individual
  `callChat*`/`ask`/`chatJson`/`openaiChat`/`callOpenAI`/`callVision` functions in `company-brain`,
  `critic-pass`, `agent-evals` (run + selfrepair), `focus-group-loop`, `shark-tank`, `signal-radar`'s two
  detectors, `kb-memory`'s `memory-librarian` and `reflect`, `doc-indexer/enrich.mjs`, `pdf/pdf.mjs`, and
  the designer skill's `art-director.mjs`/`review-asset.mjs`).
- **Embeddings** (`skills/kb-memory/opensearch-write.mjs`'s `embedOpenAI()` — the ONE shared function
  every embedder in the fleet ultimately calls: `company-brain`, `doc-indexer/indexer.mjs`,
  `kb-memory/index-one.mjs`, `kb-memory/semantic.mjs`, `ring-memory-index`, and
  `embedding-drift-monitor` all route through it, so instrumenting it once covers all of them; also
  `skills/cutover-preflight/preflight.mjs`'s one-off migration probe).
- **Images** (`gpt-image-1` via `skills/designer/scripts/_lib.mjs`'s `reportCost()`, which every
  image-generating designer script already calls with an exact, quality/size-aware dollar figure it
  computed itself — recorded via `costUsdOverride` rather than re-derived here, so the two numbers
  never disagree).
- **The gateway** (`otchealth-mcp-server`) emits the identical three metrics for its own OpenAI chat
  and embedding calls — see that repo's own doc/PR for its wiring; it reuses the same metric names and
  tag shape so a Datadog query does not need to special-case which repo produced a given point.

### Metrics (Datadog, `otc.fleet.openai.*`, all type `count`)

| Metric | Tags | What it is |
| --- | --- | --- |
| `otc.fleet.openai.tokens` | `model`, `kind`, `direction` (`input`\|`output`), `caller`, `repo`, `unknown` | Token counts, summed per flush batch |
| `otc.fleet.openai.requests` | `model`, `kind`, `caller`, `repo`, `unknown` | Count of real OpenAI calls |
| `otc.fleet.openai.cost_usd_est` | `model`, `kind`, `caller`, `repo`, `unknown` | Estimated USD, summed per flush batch |

`kind` is one of `chat` \| `embedding` \| `image` \| `other`. `unknown:true` means the model name did
not match a confidently-priced entry in the in-file price table (see below) — its cost is a
conservative estimate, not a reconciled figure.

### The local ledger (works even when Datadog is unreachable)

Every recorded event is also appended, synchronously, as one JSONL line to
`~/.otchealth/openai-usage/usage-<YYYY-MM-DD>.jsonl` (override the directory with
`OPENAI_USAGE_LEDGER_DIR`). This is the reconciliation path for a session where Datadog itself was
down, or where `datadog-api-key` had not yet resolved. There was no pre-existing "toolkit state
directory" convention to reuse for this (checked: the toolkit's other local-state touchpoints are ad
hoc credential-cache file paths, e.g. `~/.gcp_claude_driver_sa.json`); this establishes one, under the
same homedir-dotfile convention.

## What is NOT measured

- **Any OpenAI call made outside this fleet's own code** — a human testing a prompt directly in the
  OpenAI Playground, a different service on the same account, etc. This only sees what the
  instrumented code paths in this repo (and the gateway) actually call.
- **Provider-side rounding or billing adjustments.** The estimate is computed from the exact token
  counts OpenAI's own response reports, priced against this file's price table — it is not a second
  read of OpenAI's own billing ledger (which, per the "why this exists" section above, is not reachable
  with the credential this fleet has).
- **Any model this table does not confidently know the price of.** In particular, the fleet's own
  `OPENAI_TIERS` (`setup/model-routing.mjs`) moved to the `gpt-5.6-luna`/`-sol`/`-terra` family on
  2026-08-29, and no published per-token pricing was available for that family at the time this table
  was written. Rather than assert a guessed number with false confidence, those (and any other
  unrecognized model id) fall through to the **unknown_model bucket**: priced at the most expensive
  *known* family in the table (so real spend is never under-counted) and tagged `unknown:true` so a
  dashboard can tell "confident" apart from "conservative estimate" at a glance. **A large fraction of
  current chat spend is likely tagged `unknown:true` right now for exactly this reason** — this is
  expected, not a bug, until the price table is refreshed against confirmed published pricing for that
  family.
- **Per-call-site completeness within a single file.** The regression guard
  (`tests/openai-usage-coverage.test.mjs`) is a **file-level** text scan: it fails if a file references
  `api.openai.com` without also referencing `recordOpenAIUsage` anywhere in that same file (or being in
  its documented `ALLOWLIST`). It does not prove every individual `fetch()` call site within a file is
  instrumented — see that test's own header for why a full call-graph analysis was judged not worth the
  investment here.
- **Sora video and other non-token-billed products' exact cost**, beyond whatever dollar figure the
  calling script already computed for its own display (recorded via `costUsdOverride`).

## How to reconcile against the OpenAI dashboard

1. Pull the local JSONL ledger for the date range in question (`~/.otchealth/openai-usage/usage-*.jsonl`
   on whichever machine/session ran the calls — the ledger is per-session-sandbox, not centrally
   aggregated) or query the Datadog metrics for the same window.
2. Sum `costUsd` grouped by `model`/`kind` and compare against the OpenAI dashboard's own per-model
   breakdown for the same UTC window.
3. A material mismatch is most likely one of: (a) a model tagged `unknown:true` (check the price table
   version below against the current OpenAI pricing page and refresh the `CHAT_PRICES`/
   `EMBEDDING_PRICES` tables in `setup/openai-usage.mjs`), (b) prompt-cache discounting not reflected
   (only chat calls with a real `prompt_tokens_details.cached_tokens` in the response get the cached
   rate — verify the caller's request actually qualified for caching), or (c) a call site this repo does
   not yet instrument (grep the OpenAI dashboard's request logs, if available, for a path this doc's
   "what is measured" list does not cover).
4. **An OpenAI admin key would close this gap properly** (real usage-API reconciliation instead of a
   self-reported estimate) — that is a Matt-gated account action, not a code change. Until then, this
   system is the fleet's only visibility and should be treated as a well-informed estimate, not an
   invoice.

## Price table version

`setup/openai-usage.mjs`'s `PRICE_TABLE_VERSION` records the snapshot date. Re-verify the confidently-
priced model families (`gpt-4o`, `gpt-4o-mini`, `gpt-4.1`, `gpt-4.1-mini`, `gpt-4.1-nano`,
`gpt-3.5-turbo`, `text-embedding-3-large`, `text-embedding-3-small`, `text-embedding-ada-002`) against
<https://openai.com/api/pricing/> periodically — OpenAI revises pricing without notice.

## Safety notes for anyone extending this

`recordOpenAIUsage()` never throws and performs no network I/O of its own (see
`setup/openai-usage.mjs`'s own file header for the full contract) — it only buffers in memory and
appends to the local ledger. The only network calls this module makes are inside `flush()`, which is
either called explicitly or lazily scheduled via a `beforeExit` hook the first time a real (non-
disabled) `recordOpenAIUsage()` call happens. **`OPENAI_USAGE_DISABLE=1`** is a hard kill-switch (set
fleet-wide by `run-tests.sh`) that makes `recordOpenAIUsage()` a complete no-op — this exists
specifically so the toolkit's own test suite, which exercises many of these instrumented call sites
with a mocked `fetch`, can never accidentally send test-fixture-derived numbers to production Datadog.
Do not remove that kill-switch, and do not make a test file import `setup/openai-usage.mjs` for real
(clearing the disable flag) without also mocking `ddMetric` via `_setDdMetricForTests()` — see
`setup/openai-usage.test.mjs`'s own header for why.
