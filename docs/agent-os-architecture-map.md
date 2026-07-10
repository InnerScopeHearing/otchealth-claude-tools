# Agent-OS Architecture Map (B9-AGENTOS-MAP)

Audit-grade map of the fleet's 5-layer mental model, grounded in the actual code as of
2026-07-05. Every component below is real and cited by file path; anything not yet built is
called out explicitly as **NOT BUILT** rather than described as if it exists. This is a living
ground-truth doc — when the cited files change materially, this doc is wrong until updated.

Two repos:
- `otchealth-mcp-server` (`/tmp/mcpsrv`) — the gateway. TypeScript, ~850 tools, deployed as an
  Azure Container App.
- `otchealth-claude-tools` (`/tmp/ct2`) — skills, setup jobs, and the fleet's operational scripts
  that call the gateway (or talk to Azure directly for infra-level jobs).

---

## The 5 layers at a glance

| # | Layer | Real component | Lives in |
|---|-------|-----------------|----------|
| 1 | Kernel / admission control | The gateway: `registerTool` wrapper, leases, fencing, idempotency, governance | `mcpsrv/src/tools/registry.ts`, `mcpsrv/src/agentstate/*` |
| 2 | Resource plane | Cosmos DB (`tasks`/`memory`/`events`), Blob (commons ledgers, `_STATE`, `_HEARTBEAT`, `_DISPATCH`), Azure AI Search (`memory-exec`, `otchealth-dataroom-search`), Key Vault | Azure, accessed via `mcpsrv/src/agentstate/cosmos.ts`, `ct2/skills/kb-memory/*` |
| 3 | Runtime / engines | Claude Code sessions vs. Hyperagent (hosted platform) — both swap freely behind the gateway contract | n/a (client-side; distinguished by env markers like `HOME` prefix `/agent`) |
| 4 | Orchestration plane | fleet-dispatch inbox, decision-clock sweep, ~20 scheduled Container Apps Jobs (the de facto scheduler). Durable Task Scheduler is **NOT BUILT** (Matt-gate pending) | `ct2/skills/fleet-dispatch/dispatch.mjs`, `ct2/skills/decision-clock/decision.mjs`, Azure Container Apps Jobs |
| 5 | Observability / control plane | heartbeat dead-man's-switch, image-drift, drift-recon, decision-clock metrics | `ct2/setup/heartbeat.mjs`, `ct2/setup/image-drift.mjs`, `ct2/setup/drift-recon.mjs` |

---

## Layer 1 — Kernel / admission control (the gateway)

The gateway is `otchealth-mcp-server`, a single Azure Container App (`otchealth-mcp-gateway`,
resource group `rg-otchealth-apps-prod`) exposing ~850 MCP tools (regression floor `MIN_TOOLS=800`
in `mcpsrv/.github/workflows/deploy.yml`; catalog is "~838"). Every tool call funnels through one
choke point: `registerTool()` in `mcpsrv/src/tools/registry.ts`. That function is the actual
kernel — it is where every cross-cutting admission-control concern is enforced, in this order,
for every single tool invocation:

1. **Strict input validation** — Zod `.strict()` schema rejects unexpected fields
   (`registry.ts` lines ~226–253).
2. **Governance / role gating** — `requiredRoleFor()` (`mcpsrv/src/catalog/governance.ts`) checks
   the caller's OAuth-derived agent identity (`currentCallerAgent()`,
   `mcpsrv/src/server/request-context.ts`) against a declarative rule table. Example real rules:
   `github_push_files`, `github_merge_pull_request`, `depot_*`, `cloudflare_create_dns_record`,
   `stripe_create_refund` are all CTO-only. Any `write_orchestrated` tool with no explicit rule
   defaults to CTO-only (registry.ts ~267). All agents can *see* every tool; execution is what's
   gated.
3. **Charter enforcement** — a coarser per-agent-lane/category layer
   (`mcpsrv/src/governance/charter-enforcer.ts`), currently a no-op unless `GOVERNANCE_MODE` is
   explicitly `report`/`enforce` (production has it `off` per deploy.yml — see Layer 3/4 honesty
   note below).
4. **Write-tool gating** — `gatedReject()`: `READ_ONLY_MODE` / `ENABLE_WRITE_TOOLS` /
   `ENABLE_HIGH_RISK_TOOLS` env flags, category-aware (`read` / `write_simple` /
   `write_orchestrated`).
5. **Inbound Prompt Shields** (`mcpsrv/src/safety/auto-guard.js` via `inboundShield()`) — jailbreak
   / injection detection on the args, before the handler runs.
6. Handler executes; **outbound groundedness** check (`outboundGroundedness()`) runs on
   model-generated answers that supply a `GroundingHint`.
7. **JIT result offload** (`shouldOffload`/`offloadResult`, `mcpsrv/src/tools/result-store.ts`) —
   oversized results get parked and the caller pulls them via `gateway_fetch_result` instead of
   blowing up context.
8. Every step is audit-logged with a correlation ID (`mcpsrv/src/audit/logger.ts`).

**Leases, fencing, idempotency — where they actually live**, all in
`mcpsrv/src/agentstate/ledger.ts`:

- `claimTask()` — optimistic-concurrency claim via Cosmos ETag (`If-Match`); a 412 means someone
  else won the race and the caller retries. A 45-minute lease (`LEASE_MINUTES = 45`) is set on
  claim.
- **Fencing token**: `lease_version`, a monotonic integer incremented on every successful claim.
  `updateTask()` / `completeTask()` / `heartbeatTask()` all accept an optional
  `expected_lease_version`; if it no longer matches the task's current `lease_version`, the call is
  rejected with `fenced: true` — this is what stops a "zombie worker" (a holder whose lease already
  expired and got reclaimed) from silently clobbering the new holder's work. Added 2026-07-05,
  P0-CLAIM-LEASE, per the file's own header comment.
- `heartbeatTask()` — lets a still-valid lease holder extend `lease_until` so a long task isn't
  reclaimed mid-execution.
- **Idempotency**: `createTask()` derives a deterministic task id from `idempotency_key` via
  `idFromIdempotencyKey()` (a simple string hash), so a retried `task_create` with the same key
  returns the original task (`deduped: true`) instead of creating a duplicate. Race-safe: if two
  callers race on the same key, the loser re-reads and returns the winner's doc rather than
  erroring.
- **Definition-of-done enforcement**: `completeTask()` calls `resolveArtifact()`
  (`mcpsrv/src/agentstate/resolver.ts`) and *rejects* the completion unless `artifact_uri` actually
  resolves — a live `blob:` HEAD 200, a `cosmos:coll/pk/id` doc that exists, an `https://` URL
  under 400 (with an SSRF guard blocking private/metadata IP ranges — `ipBlocked()`), or a real
  GitHub commit/PR (`gh:commit:...` / `gh:pr:...`). This is the literal code behind "done =
  artifact landed" — not a convention, a rejection path.

**Access control identity**: `normalizeAgent()` (`mcpsrv/src/agentstate/agents.ts`) is the
privilege wall — `clo-personal` is hard-blocked (`FORBIDDEN_AGENTS`) from ever crossing the
gateway, enforced at every agent-state entry point (tasks, memory, inbox queue names).

**Cosmos containers used by the kernel** (allowlisted in `mcpsrv/src/agentstate/cosmos.ts`,
`CONTAINERS = new Set(['tasks', 'memory', 'events', 'oauthcodes', 'cache'])`):
container/id values are validated against `ID_RE` before being interpolated into the REST
resourceLink — a path-injection guard so a caller-supplied id can't escape its container.

---

## Layer 2 — Resource plane

### Cosmos DB (`agent-state` account, referenced as `cosmos-otc-agentstate-55c84` in
`decision.mjs`'s header comment)

| Container | Partition key | What's in it | Written by |
|---|---|---|---|
| `tasks` | `/board` (default board `"fleet"`) | One doc per work item: `owner_agent`, `status` (open/claimed/in_progress/blocked/done/cancelled), `priority`, `artifact_uri`, `lease_until`, `lease_version`, `idempotency_key`, `notes[]` | `mcpsrv/src/agentstate/ledger.ts` |
| `events` | `/task_id` | Append-only, best-effort audit trail of every task state transition (`created`, `claimed`, `heartbeat`, `updated`, `completed`, `complete_rejected`) | `appendEvent()` in `ledger.ts` |
| `memory` | `/agent` | The deterministic, byte-exact memory-of-record: `kind` (`fact`/`decision`/`correction`/`pitfall`/`status`), queried by keyword/field filter (`CONTAINS(LOWER(...))`) — explicitly NOT the LLM-consolidated semantic store | `mcpsrv/src/agentstate/memory.ts` |
| `decisions_pending` | `/owner` | One doc per open decision-clock gate: `category`, `expected_by`, `status`, `terminal_policy` (`block`/`escalate`/`proceed`), `innd` flag | `ct2/skills/decision-clock/decision.mjs` |
| `oauthcodes`, `cache` | — | OAuth auth-code store (moved to Cosmos so blue-green cutovers don't drop live sessions, per `deploy.yml` comment) and a generic cache container (also used for vector search via `vectorSearchDocs()`) | `mcpsrv/src/auth/oauth-tokens.ts`, various |

Cosmos access is a dependency-free master-key HMAC REST client (`cosmos.ts`) — no vendor SDK, so
the gateway stays the single portable front door regardless of runtime. Cross-partition queries
fan out per physical partition-key-range (`pkRanges()`) because the REST data-plane can't itself
serve cross-partition `CONTAINS`/aggregate queries the way the SDK's query-plan negotiation would.

### Blob Storage (multiple storage accounts, all SAS-token auth, no SDK)

- **`otchealthcommons` / container `company-journal`** — the shared, non-PHI fleet commons:
  - `_MEMORY/_exec/<agent>.jsonl` — the shared EXEC team feed (one file per agent, no clobber);
    populated by `publishShared()` in `ct2/skills/kb-memory/mem.mjs` whenever an entry is written
    with `--share` or is a `status` entry (status is *always* shared).
  - `_STATE/<agent>.json` — the **typed current-state snapshot doc** (P0-DURABLE-HANDOFF,
    2026-07-05): `{ goal, constraints[], open_decisions[], last_state, updated_at, updated_by,
    version }`. Distinct from the JSONL ledger (a history) — this is the single always-current
    doc a fresh cold instance should read first. Read/write via `mem.mjs state --get/--set`
    (`mem.mjs` lines 713–748), ETag-guarded read-modify-write with retry on 412 conflict.
  - `_HEARTBEAT/<job>.json` — one doc per scheduled job: `last_event`, `last_start`, `last_ok`,
    `last_fail`, `consecutive_fail`. Written by `ct2/setup/heartbeat.mjs beat`.
  - `_DISPATCH/<agent>.jsonl` — the fleet-dispatch inbox per agent (see Layer 4).
- **Per-agent private ledger accounts** (`ct2/skills/kb-memory/mem.mjs`, `AGENTS` map):
  `otchealthcfodata/cfo-source-docs`, `otchealthlegalstore/company` (clo),
  `otchealthlegalstore/personal` (clo-personal — hard-excluded from sharing, attorney privilege),
  `otchealthlegalstore/exec` (the unified executive identity's ledger). Each agent's private ledger
  is `_MEMORY/<agent>.jsonl` (append-only NDJSON) plus a derived, best-effort `_MEMORY/<agent>.md`
  rendered view and a `_MEMORY/<agent>.reconcile` marker (last-seen timestamp for cross-agent
  inbound notes).
- **Ledger write path**: `commitAppend()` in `mem.mjs` — read current blob + ETag, build the new
  entry from the *fresh* rows (so a concurrent writer never gets clobbered), conditional PUT,
  retry with backoff on conflict (up to 6 attempts). Same ETag-optimistic-concurrency discipline as
  the Cosmos ledger, just on Blob instead.
- **`agent inbox` queues** — Azure Storage *Queue* (not Blob), one queue per agent
  (`inbox-<agent>`), used by the gateway's `agent_dispatch`/`inbox_read` tools
  (`mcpsrv/src/agentstate/queue.ts`). This is a **separate inbox mechanism from the ct2
  fleet-dispatch Blob-based inbox** below — the gateway's queue-based inbox pairs with the Cosmos
  task ledger ("ledger = queryable state, inbox = delivery"); ct2's `dispatch.mjs` inbox is a
  Blob-JSONL mechanism used directly by skills/jobs outside the gateway. Both exist; they are not
  unified today.

### Azure AI Search

- **`memory-exec`** index — the shared exec-brain semantic index. Populated write-through
  (fire-and-forget child process `index-one.mjs`, or synchronously under Hyperagent where detached
  children get killed on return — see `maybeIndex()` in `mem.mjs`) whenever a `kb-memory` entry is
  *shared*. Read via `semanticHits()` using a read-only query key + `queryType: "semantic"` with
  `semanticConfiguration: "sem"` — no embedding key, no admin key on the hot path. Has a retry queue
  (`INDEX_RETRY_FILE`) for entries that failed to sync-index, drained by `index-catchup`.
- **`otchealth-dataroom-search`** — the fleet knowledge-RAG index behind the gateway's `kb_search`
  tools, hybrid BM25 + vector (`text-embedding-3-large` via `embed()`) + semantic ranker
  (`mcpsrv/src/azure/search.ts`, `hybridSearch()`), with graceful degrade to keyword-only if vector
  embedding fails.
- Both indexes are populated/refreshed by scheduled jobs (`brain-reindex`,
  `librarian-*` — see the Container Apps Jobs list surfaced in `ct2/setup/drift-recon.mjs`'s
  `DEFAULT_JOBS`), not by the gateway itself at request time (aside from the write-through path
  above).

### Key Vault

- **Vault**: `kv-otc-55c84f6bef` (default; overridable via `AZURE_KEYVAULT_NAME`).
- **Two auth paths**, tried in order, in `ct2/skills/kb-memory/azure-secret.mjs`:
  1. **Managed identity** (preferred) — `identityToken()` mints a vault token from the Container
     Apps platform-injected sidecar endpoint (`IDENTITY_ENDPOINT` + `IDENTITY_HEADER`, present
     automatically when a user/system-assigned identity is attached). No secret client_secret to
     leak or rotate; the identity's Key Vault Secrets User RBAC grant *is* the credential.
  2. **Service Principal client_credentials** (legacy fallback) — `AZURE_SP_CLIENT_ID/SECRET/TENANT_ID`,
     still required on jobs not yet migrated to managed identity.
- Secret names are a 1:1 mirror of the retired GCP Secret Manager ids (e.g.
  `azure-legal-storage-key`, `azure-cfo-storage-key`, `azure-commons-storage-account`), so callers
  didn't need to change call sites during the GCP→Azure migration.
- `kvSecret()` never throws (fail-open, returns `null`); `requireSecrets()` is the fail-*loud*
  variant — exits `78` (EX_CONFIG) with a clear message if any required secret is genuinely
  missing everywhere, so a total-creds failure can't run silently.
- `kvSecretSet()` supports the reverse direction (writing secrets), used for OAuth token-rotation
  persistence (Xero/Gmail/OneDrive/QBO).

---

## Layer 3 — Runtime / engines (swappable)

Two engines run against the same gateway today:

1. **Claude Code sessions** — long-lived local/CI processes. Fire-and-forget child processes
   (detached + `.unref()`) actually complete in the background, e.g. the async semantic-index spawn
   in `mem.mjs`'s default `maybeIndex()` branch.
2. **Hyperagent** — the hosted Claude agent platform. `mem.mjs` explicitly special-cases it: a
   comment dated 2026-06-26 (`HYPERAGENT FIX`) notes that under `RunWithCredentials` a
   detached/unref'd child is *killed on return*, so the normal fire-and-forget indexing pattern
   silently drops shared facts for up to 6 hours (until the next scheduled reindex). The code
   detects this runtime via `(process.env.HOME || "").startsWith("/agent")` or
   `NODE_USE_ENV_PROXY === "1"` and switches to synchronous, bounded indexing with a fail-open
   retry queue instead. The same detection also tags Datadog telemetry with `engine=hyperagent` vs
   `engine=claude` (`emitFleet()`).

**What's actually swappable**: which process is issuing the tool calls, and its process lifecycle
model (long-lived vs. short-lived-with-hostile-child-process-reaping). **What stays constant across
both**: the gateway contract itself — the ~850 MCP tools, their input/output schemas, the
governance/lease/idempotency semantics in Layer 1, and the Cosmos/Blob/Search resource plane in
Layer 2. Neither engine talks to Cosmos, Blob, or Search directly for gateway-mediated state (task
ledger, structured memory) — they both go through the same MCP tool surface. (Some ct2 setup jobs
and skill scripts — heartbeat, image-drift, drift-recon, kb-memory's own commons/private ledgers —
talk to Azure directly via SAS/ARM tokens rather than through the gateway; that's an existing
architectural seam, not an engine difference — both engines run the same scripts.)

The gateway's own connector-surface logic (`CONNECTOR_TOOLSET` in `registry.ts`) is a third
consumer distinct from either fleet engine: Claude Chat's Dynamic Client Registration (DCR)
connectors get a curated ~25-tool subset (because Claude truncates a raw 850-tool list, hiding
things like `brain_search`), while every other caller — including both fleet engines — sees the
full catalog unchanged.

---

## Layer 4 — Orchestration plane

**What exists today** (all real, all cited):

- **fleet-dispatch inbox** (`ct2/skills/fleet-dispatch/dispatch.mjs`) — directed agent-to-agent
  hand-off. `dispatch.mjs send <to> "<msg>"` appends to `_DISPATCH/<to>.jsonl` in the commons Blob
  account; the target agent's session-start hook calls `check --agent <self>`, which reads-and-acks
  (deletes) the inbox in one shot. Two delivery modes:
  - **async** (default): message just queues, read on the target's next natural session.
  - **`--spawn`** (opt-in, draws the shared Max weekly plan limit): additionally fires a GitHub
    Actions `workflow_dispatch` against `autonomous-run.yml` to spin up a headless target session
    *now*.
  - Consults `compute-allocator` (advisory, fail-open dynamic import) to recommend agent fan-out /
    model tier / whether to require a critic-pass, informed by `signal-radar` signals for that
    owner lane.
- **decision-clock sweep** (`ct2/skills/decision-clock/decision.mjs sweep`) — the daily Tier-1 job
  that classifies every open `decisions_pending` row (`classifyRow()`: open / near-due / overdue /
  ack / closed, plus a `terminal` flag once a row has been open+unacknowledged past
  `nearDueDays * SEVERE_OVERDUE_MULTIPLE` days *and* carries a `terminal_policy`), batches nudges
  **one message per owner** (never one-per-item spam — `batchNudges()`), and dispatches via the
  fleet-dispatch inbox above. `terminal_policy: "block"` rows make the sweep process exit non-zero
  (a CI/heartbeat consumer can treat a blown terminal timeout as a real failure);
  `terminal_policy: "proceed"` rows are auto-closed by the sweep itself, right there, with a logged
  note; `terminal_policy: "escalate"` rows just get a CRITICAL-tagged line in the same nudge.
- **Scheduled Azure Container Apps Jobs are the de facto scheduler.** There is no dedicated
  orchestration service; cron-like Container Apps Jobs (`otchealth-automation-rg`) are what
  actually trigger `decision.mjs sweep`, the doc-indexer/librarian reindex jobs, heartbeat checks,
  and drift scans. `drift-recon.mjs`'s own comments confirm the live topology as of 2026-07-05: 9+
  jobs share the `doc-indexer` image family (`daily-digest`, `librarian-finance`,
  `librarian-commerce`, `librarian-legal-company`, `librarian-legal-personal`, `brain-reindex`,
  `deep-finance`, `deep-legal-company`, `deep-legal-personal`), plus others discovered live via ARM
  pagination (`ring-memory-index-daily`, `signal-radar`, `decision-clock`, `memory-librarian` — the
  drift-recon.mjs header notes these were *missed* by an earlier single-page ARM call bug, now
  fixed by following `nextLink`). Roughly ~20 scheduled jobs total per the roadmap framing.

**What the roadmap envisions but has NOT been built**:

- **Durable Task Scheduler (DTS)** as a real orchestration engine (durable workflows, retries,
  fan-out/fan-in as first-class primitives) — **NOT BUILT**. This remains a Matt-gate pending
  decision. Nothing in either repo instantiates a DTS client, worker, or orchestration function;
  the "orchestration" that exists today is entirely: (a) Container Apps Jobs' own cron scheduling,
  (b) the Cosmos task ledger as a claim/lease queue that *agents* poll, and (c) the fleet-dispatch
  inbox as a push notification. There is no durable-workflow engine coordinating multi-step,
  fan-out/fan-in orchestration across those primitives — each script above is independently
  scheduled and independently idempotent, not part of a single DTS-orchestrated graph.
- Do not describe DTS in any diagram or table as a present component; it belongs only in a
  "not yet built" callout, as here.

---

## Layer 5 — Observability / control plane

All of the following are report-only / fail-open by design — none of them mutate fleet state
except decision-clock's own `terminal_policy: "proceed"` auto-close, which is a self-contained,
narrowly-scoped exception.

- **heartbeat.mjs** (`ct2/setup/heartbeat.mjs`) — the fleet dead-man's-switch. Every scheduled
  job/agent emits `beat <job> start|ok|fail` to `_HEARTBEAT/<job>.json` in the commons Blob.
  `heartbeat.mjs check` cross-references a static `heartbeat-registry.json` (`{ job: {
  interval_min, owner, rg } }`) against both the self-reported beats *and*, for jobs that can't
  self-beat (public base images the fleet can't wrap), a **direct ARM read of the last Container
  Apps Job execution** (`armLastExec()`) — a stronger check because it catches a job that can't
  even *start*. Status buckets: `LIVE` / `LATE` (>1x interval) / `DEAD` (>3x interval, or expected
  but never succeeded) / `NO-DATA` / `NO-ARM` (ARM unreachable — fails open to "unknown," never a
  false DEAD).
- **image-drift.mjs** (`ct2/setup/image-drift.mjs`) — scans every Container App / Container Apps
  Job in `otchealth-automation-rg` and `rg-otchealth-apps-prod` via ARM, flags any image reference
  *without* an `@sha256:` digest (i.e. still on a mutable tag like `:latest`/`:main`) as drift risk.
  Report-only; `--strict` exits 3 on any drift so it can gate CI.
- **drift-recon.mjs** (`ct2/setup/drift-recon.mjs`) — the complement image-drift can't see: a job
  *can* be pinned to an immutable `@sha256` digest and still be **stale** (someone hand-rebuilt and
  re-pinned weeks ago; everything merged to main since is silently missing from what's actually
  running). Finds the *true* latest digest via the ACR `runs` API (the most recent `Succeeded` run
  that tagged `doc-indexer:latest`), compares it against every tracked job's pinned digest, reports
  `CURRENT` / `STALE` / `UNPINNED` / `NO-JOB`. Also fixed a real production bug in its own header
  comment: the Container Apps Jobs list API is paginated (`nextLink`) once a resource group has 20+
  jobs, and an earlier single-page version silently missed everything on page 2.
- **decision-clock metrics** (`decision.mjs metrics`) — fleet-wide queue-depth monitoring:
  `computeMetrics()` aggregates every open/near-due/overdue/ack row across *all* owners (never
  filtered to one), reporting `totalOpen`, `byStatus`, `byOwner`, `oldestWaitDays`, and
  `blockingCount`. Exits non-zero if any `blockingCount > 0`.
- **kb-memory's own health surfaces**: `mem.mjs whoami` (per-session identity + ledger
  reachability proof), `mem.mjs team-health` (per-exec-agent staleness of shared memory — feeds the
  COO daily brief), and the **cold-resume acceptance test**
  (`ct2/skills/kb-memory/cold-resume-test.mjs`) — deliberately reads *only* the typed `_STATE`
  snapshot doc (no JSONL history, no chat) and renders exactly what a brand-new cold instance would
  know; fails `MARGINAL`/`FAIL` if `goal`, `updated_at`, or `last_state` are missing or the doc is
  stale beyond `--max-age-hours` (default 48h). This is the acceptance test proving the memory
  system (Layer 2) actually delivers durable hand-off, not just durable storage.
- **The gateway's own deploy-time gates** (`mcpsrv/.github/workflows/deploy.yml`) also belong to
  this layer even though they run at CI/CD time, not continuously: `/health` (`tool_count` vs.
  `MIN_TOOLS=800` regression floor) and `/health/deep` (real reachability probes against Cosmos /
  Azure AI Search / Foundry, distinct from a superficial "process is up" 200). A P0-EVAL-CI
  golden-case eval step runs last, `continue-on-error: true` and explicitly placed after the
  traffic cutover so it can never trigger a rollback — currently report-only, and the workflow's
  own comment says it exits 2 ("not configured") every run until a `GATEWAY_BEARER` secret is
  added; treat it as **not yet a real gate today**, only wired for one.

---

## CI/CD: the golden-path pipeline (mentioned throughout, detailed here once)

- **`ci.yml`** — the green-main gate: typecheck, build, test on every PR + push to main. Required
  status check.
- **`deploy.yml`** — the blue-green release pipeline, OIDC-authenticated (no stored SP secret; a
  user-assigned managed identity `id-gateway-deployer` trusts only
  `repo:InnerScopeHearing/otchealth-mcp-server:environment:production`):
  1. Build once, tag by git SHA, resolve the immutable `@sha256` digest.
  2. Deploy a **GREEN** revision at **0% traffic** (`az containerapp revision set-mode ... multiple`).
  3. Assert GREEN health (`/health`, `tool_count >= 800`) — the regression guard against the
     2026-07-01 "838→subset" tool-catalog regression referenced directly in the workflow's own
     header comment.
  4. Assert GREEN `/health/deep` — real Cosmos / Search / Foundry reachability, not just "process
     up."
  5. **Only then** shift 100% traffic to GREEN.
  6. On any failure after GREEN comes up, deactivate the bad GREEN — traffic never left the
     last-good (blue) revision, so rollback is automatic and requires no action.
  7. Prune stale inactive revisions, keeping one warm rollback target.
  8. Run the (currently inert, pending a secret) golden-case eval as a non-blocking last step.

---

## Request-flow diagram

A representative end-to-end flow: an agent claims a task, does the work, lands the artifact, and
completes it — showing which layer each hop belongs to.

```
┌─────────────────────┐
│ Claude Code session │  or  Hyperagent session         (Layer 3 — engine, swappable)
└──────────┬───────────┘
           │  MCP tool call: task_claim(id, agent)
           ▼
┌───────────────────────────────────────────────────────────┐
│ Gateway kernel  (mcpsrv/src/tools/registry.ts)             │  (Layer 1 — admission control)
│  1. Zod strict input validation                            │
│  2. governance.ts requiredRoleFor() role check              │
│  3. charter-enforcer.ts (no-op unless GOVERNANCE_MODE set)  │
│  4. gatedReject() READ_ONLY_MODE/ENABLE_WRITE_TOOLS check    │
│  5. inboundShield() prompt-injection scan                   │
└──────────┬───────────────────────────────────────────────┘
           │  ledger.ts claimTask(id, agent)
           ▼
┌───────────────────────────────────────────────────────────┐
│ Cosmos DB  agent-state / tasks container                   │  (Layer 2 — resource plane)
│  optimistic-concurrency ETag write; on success:             │
│  status -> claimed, lease_until = now+45m, lease_version++  │
│  -> appendEvent() writes to `events` container (audit)       │
└──────────┬───────────────────────────────────────────────┘
           │  task claimed; agent does the work
           ▼
┌───────────────────────────────────────────────────────────┐
│ Agent lands the artifact:                                  │
│  - Blob commons  (blob:<path>)   e.g. company-journal        │  (Layer 2)
│  - GitHub commit/PR             (gh:commit:... / gh:pr:...)  │
│  - Cosmos doc                   (cosmos:coll/pk/id)          │
└──────────┬───────────────────────────────────────────────┘
           │  MCP tool call: task_complete(id, artifact_uri)
           ▼
┌───────────────────────────────────────────────────────────┐
│ Gateway kernel again (same registerTool() pipeline)         │  (Layer 1)
│  -> resolver.ts resolveArtifact(artifact_uri)                │
│     HEAD/GET/commit-exists check; SSRF-guarded for https://   │
│  -> REJECTED if it doesn't resolve ("done = artifact landed") │
└──────────┬───────────────────────────────────────────────┘
           │  resolved=true
           ▼
┌───────────────────────────────────────────────────────────┐
│ Cosmos: task.status -> done, done_ts set, ETag write          │  (Layer 2)
│ appendEvent('completed')                                     │
└──────────┬───────────────────────────────────────────────┘
           │  meanwhile, independently:
           ▼
┌───────────────────────────────────────────────────────────┐
│ Orchestration plane (Layer 4, out-of-band from the above):   │
│  - Container Apps Job (cron) runs decision.mjs sweep daily     │
│    -> classifies decisions_pending, dispatch.mjs sends one     │
│       batched nudge per owner to _DISPATCH/<owner>.jsonl        │
│  - target agent's session-start hook runs dispatch.mjs check    │
│    -> reads + acks its inbox                                    │
└──────────┬───────────────────────────────────────────────┘
           │  continuously, independently:
           ▼
┌───────────────────────────────────────────────────────────┐
│ Observability plane (Layer 5, out-of-band):                   │
│  heartbeat.mjs beat / check   -> _HEARTBEAT/<job>.json          │
│  image-drift.mjs / drift-recon.mjs  -> ARM + ACR reachability   │
│  decision.mjs metrics          -> queue-depth / oldest-wait      │
└───────────────────────────────────────────────────────────┘
```

Note what's conspicuously absent from this diagram: there is no orchestration-plane node that
*drives* the claim → work → complete sequence end-to-end as a durable workflow. Each hop is
independently triggered — a human or agent decides to call `task_claim`, a cron job independently
decides to sweep `decisions_pending`. That gap is exactly what DTS would fill if/when it's built.

---

## Honesty checklist (what this doc is careful NOT to overstate)

- **Durable Task Scheduler**: not built. No client, no worker, no orchestration function exists in
  either repo. Pending a Matt-gate decision.
- **Charter enforcement / `GOVERNANCE_MODE`**: the code path exists
  (`mcpsrv/src/governance/charter-enforcer.ts`) but production currently runs with
  `GOVERNANCE_MODE=off` and `COMPLIANCE_MODE=off` per `deploy.yml`'s green-revision env vars (Matt
  directive 2026-07-02, "self-imposed guardrails DOWN") — the mechanism is wired but intentionally
  disabled in prod today. Don't describe it as an active gate.
- **Golden-case eval-CI gate**: wired into `deploy.yml` as the last step, but per the workflow's
  own comment it exits 2 ("not configured") every run until a `GATEWAY_BEARER` repo secret is
  added — treat as scaffolded, not yet live.
- **Gateway inbox (Storage Queue) vs. fleet-dispatch inbox (Blob JSONL)**: these are two separate
  mechanisms serving a similar purpose from two different code paths
  (`mcpsrv/src/agentstate/queue.ts` vs. `ct2/skills/fleet-dispatch/dispatch.mjs`). Not yet unified;
  don't conflate them as one system.
- **Deep-health gate in CI**: only runs if the `ADMIN_REVOKE_TOKEN` repo secret is set; otherwise
  it's skipped with a visible warning, not silently passed.

---

## File index (for future updates to this doc)

- Kernel: `mcpsrv/src/tools/registry.ts`, `mcpsrv/src/catalog/governance.ts`,
  `mcpsrv/src/catalog/catalog.ts`, `mcpsrv/src/agentstate/{ledger,cosmos,resolver,agents,memory,queue}.ts`
- Resource plane: `ct2/skills/kb-memory/{mem,azure-secret}.mjs`, `mcpsrv/src/azure/search.ts`
- Runtime engines: engine-detection logic inline in `ct2/skills/kb-memory/mem.mjs`
  (`maybeIndex()`, `emitFleet()`)
- Orchestration: `ct2/skills/fleet-dispatch/dispatch.mjs`, `ct2/skills/decision-clock/decision.mjs`
- Observability: `ct2/setup/{heartbeat,image-drift,drift-recon}.mjs`
- CI/CD: `mcpsrv/.github/workflows/{ci,deploy}.yml`
- Acceptance test: `ct2/skills/kb-memory/cold-resume-test.mjs`
