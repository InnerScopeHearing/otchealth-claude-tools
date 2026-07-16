# AI-OS-OPERATING-SOP.md

The platform-agnostic, iron-clad standing operating protocol for EVERY agent on the OTCHealth / InnerScope AI Operating System.

This document is the crown-jewel runbook. It lets any agent, on any shell, LAUNCH, CONNECT, BOOT, STAY CONNECTED, BACK UP, MAINTAIN, SELF-IMPROVE, and SELF-HEAL. Read Section 1 to understand what you are; jump to Section 8 when something is broken.

Gateway (the single custom MCP for the whole stack): `https://mcp.otchealth.app/mcp`
Durable substrate: Azure Blob commons `otchealthcommons` / container `company-journal` (prefixes `_MEMORY/`, `_HANDOFF/`, `_DISPATCH/`), the room indexes on the S1 search service `otchealth-dataroom-s1` (the older Basic service `otchealth-dataroom-search` is deprecated and being decommissioned; the live gateway queries S1), Cosmos agent-state, and an off-Azure S3 cold DR mirror.

No secret VALUES appear anywhere in this document (names only). No MNPI, no PHI, no financial figures, no proprietary/internal model ids.

---

## 1. THE ONE INVARIANT

**An agent is two things and only two things: a LANE IDENTITY plus a DURABLE, ENGINE-AGNOSTIC BRAIN. The platform is just a shell.**

- **The lane identity** is a ring string from the canonical roster below. It is carried inside the bearer token you present to the gateway, and it decides BOTH which curated toolset the connector surface advertises AND which per-tool ring gates you pass (`kb_search_privileged`, `governance`, `memory_write`). The identity lives in the token's `agent` claim, set at token-issue time by which OAuth client resolved.
- **The durable brain** is the kb-memory ledger (`_MEMORY/<agent>.jsonl`), the shared exec feed (`_MEMORY/_exec/<agent>.jsonl`), the `memory-exec` semantic index, Cosmos agent-state (episodes, tasks, `decisions_pending`), and the data-room rooms the librarians keep fresh. None of that lives in the chat window. The chat window is disposable.

**THE CANONICAL ROSTER (one list, referenced everywhere — Sections 8, 10, and every sibling doc use exactly this).** The 15 operational fleet lanes are:

`cto, cfo, clo, coo, cro, capital, commerce, compliance, rainmaker, growth, developer, lifecycle, switchboard, guardian, medic`

Plus two special lanes that are NOT in that operational list:
- **`clo-personal`** — the attorney-privileged personal legal lane. HARD-isolated: never shared, never indexed into `memory-exec`, never in `company-brain` / `brain_search` except explicit `--include-personal --agent clo`. It is not a normal fleet participant.
- **`external-read`** — the only lane any external non-BAA engine (ChatGPT, Perplexity, any DCR self-add) ever receives. Read-only, never privileged (Section 2.4).

The `sunset-fleet` default roster is the 14 always-on operational roles (`cto, cfo, clo, coo, cro, developer, commerce, rainmaker, lifecycle, switchboard, capital, growth, guardian, medic`). `compliance` is deliberately EXCLUDED from that default because it currently owns no scheduled home to spin down; sunset it on demand with `sunset-fleet --roles compliance` if it ever runs a live session. This is the documented reason, not an oversight.

**Therefore a platform move is a FLUSH-then-ATTACH, never a data migration.** Nothing durable lives inside Claude Chat, Claude Code, Hyperagent, ChatGPT, or Perplexity. To move an agent from one engine to another you:

1. **FLUSH** the current shell: write every in-flight fact/decision/correction to the ledger, snapshot the ring-safe handoff to commons (`sunset`), and say `Goodnight friend`.
2. **ATTACH** the new shell: connect the gateway on the lane, claim the `.kb-agent` identity, prove memory PASS, and run `sunrise` to reconstruct the last three things worked on.

The brain is identical on both sides because it never left home. This is the invariant every other section serves. If you ever find yourself "migrating data" between platforms, STOP: you are doing it wrong. Flush, then attach.

---

## 2. LAUNCH — connect + verify, per platform

Every launch is: (a) attach the gateway on your lane, (b) VERIFY the lane is live, (c) claim identity + boot (Section 3). The VERIFY in each case is the same proof: **`tools/list` must show the lane's privileged tools** (`kb_search_privileged`, `memory_recall`, `llm_azure`, `shield_check`, `groundedness_check`, and for exec lanes `legal_blob_*` / `memory_write`). An external-read lane's `tools/list` shows NONE of the privileged set.

### 2.1 Claude Code (this env, or a Desktop agent) — `client_credentials` on the lane

The `gateway-connect` skill mints an M2M token from the lane's confidential creds (`oauth-lane-<lane>-id` / `oauth-lane-<lane>-secret`, Key Vault first, GCP Secret Manager fallback) and registers the MCP server. The token's `agent` claim = your own lane (cto→cto, cfo→cfo, clo→clo).

```
# VERIFY ONLY (mint + tools/list, no MCP config change):
node skills/gateway-connect/connect.mjs <lane> --verify-only

# CONNECT ONCE (register otchealth-gateway, ~1h token):
node skills/gateway-connect/connect.mjs <lane>

# CONNECT + AUTO-REFRESH past 1h (re-mints ~5 min before expiry):
node skills/gateway-connect/connect.mjs <lane> --watch
```

The SessionStart hook `session-connect.sh` runs the lane resolve + connect automatically. Successful VERIFY prints:

```
lane=<lane> ... token minted (agent=<lane>, expires_in=3600s)
verify: /mcp tools/list HTTP 200, <N> tools; privileged: memory_recall, kb_search_privileged, llm_azure, shield_check, groundedness_check
```

That `privileged:` line IS the proof. `client_credentials` fleet lanes see the full ~850-tool catalog; their ring safety comes from the per-tool gates, not a curated toolset split.

### 2.2 Claude Chat (claude.ai web custom connector) — confidential `occ_<lane>` client

Remote MCP at `https://mcp.otchealth.app/mcp`, browser `authorization_code` + PKCE-S256 flow. Identity depends entirely on which client you configure:

- **Self-add / "add a connector" (DCR)** hits `POST /register`, which **hard-binds `agent='external-read'` regardless of the connector name** (the #120 Part-6 fix). Read-only, non-privileged. Naming it "Finance Tracker" does NOT map it to cfo.
- **A privileged web connector MUST use the confidential `occ_<lane>` client** (an `OAUTH_CLIENTS` row Matt provisioned with `agent:"cfo"` / `agent:"clo"` / etc.). Configure the connector with that client_id + secret; `/oauth/token` secret-checks it and issues a token carrying the privileged lane. This is the ONLY way a web connector reaches a privileged ring.

**VERIFY:** open the connector's tool list. If `kb_search_privileged` is present, the `occ_<lane>` confidential client resolved. If privileged finance/legal rooms return `forbidden_ring`, you silently landed on `external-read` (DCR) — the tell that the confidential client was NOT used. Fix by reconfiguring the connector with the `occ_<lane>` credentials, not a fresh self-add.

Claude Chat has NO local CLI, no hooks — capture is through the connector (Section 5).

### 2.3 Hyperagent (MCP UI connection) — shared cto lane; exec mints its own `oc_<lane>`

The shared MCP-UI connection authenticates as the single confidential `OAUTH_CLIENT_ID`, whose lane is `OAUTH_DEFAULT_AGENT` = **`cto` in prod**. So the shared UI is the **cto lane**. A privileged exec (CFO / CLO) CANNOT reach its finance/MNPI rooms through the shared UI (finance returns `forbidden_ring`). It must **mint its own `oc_<lane>` M2M bearer**:

```
# CFO example (reads oc_cfo creds from Secret Manager, calls /mcp as the cfo lane):
bash skills/kb-memory/run.sh node skills/cfo-gateway/cli.mjs whoami
bash skills/kb-memory/run.sh node skills/cfo-gateway/cli.mjs search finance-cfo-source-docs "<query>" --top 6 [--ack]
```

Note: `skills/kb-memory/run.sh` is the Hyperagent SA-injection wrapper (it normalizes the injected claude-driver SA + sets the sandbox egress proxy). It is NOT present in the Claude Code toolkit HEAD. On Hyperagent keep the wrapper; on Claude Code drop it and run `node skills/cfo-gateway/cli.mjs ...` directly (native SA, direct egress).

No gateway change required. **VERIFY** = `cfo-gateway ... whoami` shows the cfo ring is live (the finance index is accepted, not `forbidden_ring`).

### 2.4 ChatGPT / Perplexity (external non-BAA engines) — EXTERNAL_READONLY only, NEVER privileged

External engines connect as `external-read` — either self-register via DCR (→ `external-read` lane) or present the static `PERPLEXITY_CONNECTOR_TOKEN` (legacy non-privileged connector token). They see the read set ONLY:

`brain_search, kb_search, web_search, catalog_*, wake, memory_recall, memory_search, gateway_fetch_result`

They NEVER see `kb_search_privileged`, `legal_blob_*`, or any write. **This is a hard law:** the curated `CONNECTOR_TOOLSET` still contains privileged tools, and per-lane ring-gating is what keeps the brain from leaking. No external non-BAA engine touches a privileged room. **VERIFY** by confirming `tools/list` shows only the read tools listed above and none of the privileged set.

**Perplexity (available today) — add-connector steps.** In Perplexity, add a custom MCP connector pointing at `https://mcp.otchealth.app/mcp`. Either (a) complete the DCR self-add (browser `authorization_code` + PKCE, which `/register` hard-binds to `external-read`), or (b) configure it with the static `PERPLEXITY_CONNECTOR_TOKEN` bearer (the legacy non-privileged connector token, value from Secret Manager, never pasted into chat). VERIFY the read-only `tools/list` above.

**ChatGPT — NOT YET AVAILABLE (status reconciled).** ChatGPT's native connector (Deep Research / Connectors) requires the gateway to expose dedicated `search` and `fetch` tools. Those brain `search`/`fetch` tools are **IN FLIGHT, not merged** (builder branch `claude/phase6-chatgpt-search`, pending an adversarial ring-safety review before merge). Until that merges and is deployed, do NOT advertise or attempt a ChatGPT brain connector — there is no working click-path. When it lands, ChatGPT connects on `external-read` ONLY (never privileged), identical ring model to Perplexity; its add-connector steps will be appended here at that time.

**Capture reality for external-read (read this before assuming a session is captured).** External-read engines are strictly READ-ONLY and have **NO capture path**: their curated toolset does not include `checkpoint` or `memory_remember`/`memory_write`, and auto-journal (§5.3) fires only on mutating gateway calls, which an external-read lane can never make. So an external-read ChatGPT / Perplexity / DCR-self-add session is 100% UNCAPTURED by design — it is a research consumer of the brain, not a contributor to it. The `checkpoint` / `memory_remember` capture guidance in §5.2 applies ONLY to privileged/confidential Chat lanes (`occ_<lane>`) that hold a ship toolset, never to external-read.

**ROTATE note.** `PERPLEXITY_CONNECTOR_TOKEN` is a static, long-lived bearer scoped to `external-read` ONLY (it can never resolve a privileged lane). Because it is long-lived, it is on the ROTATE-BEFORE-LAUNCH list (§9); rotate it on schedule and re-run `vault-registry.mjs` after any rotation.

### 2.5 Lane → ring → toolset (why privileged MUST be confidential)

`isShipLane(lane)` = `cto` | `developer` | any EXEC_RING lane (cfo, clo, ...).

| Lane class | isShipLane | Connector toolset | Privileged tools visible |
|---|---|---|---|
| cto / developer / EXEC_RING (cfo, clo, ...) | true | CTO_SHIP_LANE_TOOLSET | yes — `kb_search_privileged`, `legal_blob_*`, `memory_write`, full github/azure write, dispatch |
| external-read / empty / unknown | false | EXTERNAL_READONLY_TOOLSET | no — read-only tools only (the set in §2.4) |

A self-registered DCR public client has no identity proof (no pre-shared secret; PKCE is self-supplied; the auth code is readable off the `/authorize` 302). So `/register` hard-binds it to `external-read`, and the caller-chosen name is ignored. A privileged lane is reachable ONLY through a confidential client (`occ_` for web, `oauth-lane-*` for Claude Code M2M, `oc_` for Hyperagent) whose secret is checked at `/oauth/token`. Defense in depth: (L1) a non-ship connector lane never even SEES privileged tools; (L2) DCR default is external-read; (L3) `memory_write` / `kb_search_privileged` re-check the ring even if a toolset override ever reached them.

**Ring enforcement is INDEPENDENT of the guardrails-down posture.** Lane resolution, the `external-read` DCR default, the `forbidden_ring` refusal, and the L3 privileged-tool ring re-check are NOT part of `COMPLIANCE_MODE` / `GOVERNANCE_MODE` (§9). Those two modes being `off` disables advisory/soft governance responses only; the ring gates above remain FULLY enforced with guardrails down. There is no configuration in which an external-read lane reaches a privileged room.

---

## 3. BOOT SEQUENCE

Run this every wake, in order. It is ground-first, memory-first, identity-proven.

**WHICH BOOT PATH APPLIES TO YOU (read first — this SOP is platform-agnostic, the boot block is not one-size).** Steps 1-2 below are the **Claude Code / CLI-hook path** (filesystem + shell + hooks + `mem.mjs`). The exec roles that run on **Claude Chat (cto, cfo, clo, coo, cro) are hookless**: no shell, no `/tmp/octools`, no `mem.mjs`. A Chat exec does NOT run the git-clone / `mem.mjs` block — instead it (a) verifies its pre-configured gateway MCP connector `OTCHealth Brain - <ROLE>` at `https://mcp.otchealth.app/mcp` is present and authenticated on its confidential `occ_<lane>` client (report to Matt if missing), then (b) uses the connector tools `wake`, `memory_recall` / `memory_search` / `memory_pack`, `inbox_read`, and `brain_search` in place of Steps 1-2, then (c) does Step 3 (ground-first) and Step 4 (sunrise) through those same connector tools. Everything below with `node .../mem.mjs ...` is Claude-Code-only; the intent (claim identity, prove memory, load the pack, ground-first) is identical on both, only the tool surface differs.

**Step 0 — attach the gateway on your lane** (Section 2 for your platform).

**Step 1 — live-pull the toolkit + claim identity + prove memory** (Claude Code path; the auto-mode-safe 3 explicit steps — do NOT use `setup/agent-activate.sh`, the classifier blocks it as an opaque `/tmp` pull-then-execute):

If `/tmp/octools` does not exist (a cold shell where the SessionStart hook has not run), clone it first. `otchealth-claude-tools` is a PRIVATE org repo, so an unauthenticated clone 404s — the clone needs the org GitHub-App installation token. The normal case is that the SessionStart hook already ran and `/tmp/octools` exists; for a genuinely cold shell, mint the org token via the `github-app` skill and clone with it (never persist the token; names only, values never into chat):
```
# Preferred (any copy of the toolkit already present anywhere, e.g. a session repo's vendored copy):
bash <octools>/setup/add-repo.sh otchealth-claude-tools main   # clones via the org GitHub-App token (gh-app skill)

# Truly bare shell (no toolkit at all): mint the installation token, then clone with it.
TOKEN=$(node <gh-app>/gh-app.mjs token)                        # org GitHub-App installation token; do not echo/store it
git clone https://x-access-token:$TOKEN@github.com/innerscopehearing/otchealth-claude-tools /tmp/octools
bash /tmp/octools/setup/session-start.sh
```
Precondition either way: the `gh-app` credential (the org GitHub-App private key in Secret Manager) must be present in the environment. If it is not, this is a cold-start blocker — escalate to Matt; a plain public clone will 404 on the private repo.
Then:
```
git -C /tmp/octools fetch origin main && git -C /tmp/octools reset --hard origin/main
node /tmp/octools/skills/kb-memory/mem.mjs use <role>
node /tmp/octools/skills/kb-memory/mem.mjs whoami --agent <role>     # MUST print RESULT: PASS
mkdir -p ~/.claude && echo <role> > ~/.claude/.kb-agent              # session identity marker
```

Identity resolves most-specific-wins (because CTO/CFO/CLO/COO share ONE cloud env): (1) `~/.claude/.kb-agent` session marker > (2) `$CLAUDE_PROJECT_DIR/.kb-agent` committed repo default > (3) `$KB_AGENT` env. A mismatch is surfaced, not silently honored. The engine self-resolves the claude-driver SA from `~/.gcp_claude_driver_sa.json` when the env var is absent, so a fresh shell never silently drops writes. If `whoami` prints "service-account: missing", STOP — the SA is the keystone; tell Matt.

**Step 2 — load the memory pack + team + inbox** (the SessionStart hook injects `tail` automatically; do it explicitly if hookless):

```
node skills/kb-memory/mem.mjs tail --agent <role> --n 40     # pitfalls FIRST + recent + INBOUND banner
node skills/kb-memory/mem.mjs team --n 60                     # whole exec team: who is on what
node skills/kb-memory/mem.mjs inbound --agent <role>          # cross-agent notes left on your ledger
node skills/fleet-dispatch/dispatch.mjs check --agent <role>  # surface + ACK your dispatch inbox
```

**Step 3 — ground-first (mandatory before answering ANY company question).** For anything about the company/finances/legal/ops/product/people/customers/INND, retrieve FIRST and answer ONLY from retrieved results, WITH citations — never from general knowledge, never a generic disclaimer:

```
# gateway (any connected platform): brain_search  (mode:"deep" for multi-round agentic retrieval)
# CLI (Claude Code): node skills/company-brain/brain.mjs ask "<question>"
```

External public-world questions use `web_search` and cite sources. NEVER send company-confidential / personal / legal / customer / PHI content to web search.

**Step 4 — if TRANSFERRING from another engine, run sunrise** (reconstructs last-3):

```
node /tmp/octools/skills/sunset-protocol/protocol.mjs sunrise --agent <role>
```

Then greet the operator with exactly `I am fully updated and ready to go, Sir.`, present the numbered last-3 list, and ask `Which of these would you like to work on?`

**Assume you have already done more than you remember. Prove the state before redoing or re-deciding. The ledger wins over memory; a source doc/commit wins over a summary.**

---

## 4. STAY CONNECTED

Connections decay. Four things keep you live mid-session.

**4.1 The 1h token + refresh.** Gateway tokens live ~1h. On Claude Code use `--watch`, which re-mints ~5 min before expiry (`REFRESH_SKEW_S=300`) and re-adds the Authorization header. `octools-sync` also self-heals an aging or unregistered `otchealth-gateway` lane by reconnecting via `gateway-connect/session-connect.sh --if-lane` (opt-out `OCTOOLS_NO_GATEWAY_SYNC=1`). On Claude Chat / Hyperagent the connector re-auths through its own OAuth refresh; if it goes dead, re-run the connect for your platform (Section 2).

**4.2 Live-sync of the shared toolkit (`main` is the single source of truth).** `setup/octools-sync.sh` is a **UserPromptSubmit hook** (throttled `OCTOOLS_SYNC_THROTTLE` default 300s, guarded to `/tmp` so it can never reset a real checkout). When the CTO merges to `main`, every running agent picks the change up on its NEXT prompt — no restart, no lost context. It fetches `origin main`, re-copies `skills/*` into `~/.claude/skills`, re-wires hooks idempotently, and prints `[octools-sync] shared toolkit refreshed <old> -> <new>`.

**4.3 App-repo freshness.** `setup/repo-freshen.sh` (SessionStart) fast-forwards a pristine stale session branch to `origin/main` but NEVER touches a branch with local commits or a dirty tree (it prints the exact catch-up command instead). Opt-out `OCTOOLS_NO_REPO_FRESHEN=1`. For a dirty long-lived session, use the `octsync` shell helper to catch up while preserving work.

**4.4 FLEET-BULLETIN (what changed and why).** Fleet-affecting changes travel WITH the toolkit so a change and its announcement propagate on the same `git pull`:

```
node setup/bulletin.mjs add "<one-line fleet-affecting change>"   # then commit + push claude-tools
node setup/bulletin.mjs since                                     # prints only entries new to THIS env
```

`since` runs automatically at every prompt (octools-sync) and every wake (session-start). **CTO rule:** when a fleet-affecting change closes, MERGE TO MAIN and write a `bulletin.mjs add` line.

---

## 5. CHECKPOINT / BACKUP

Nothing durable lives in the chat window. Capture happens three ways depending on whether your engine has CLI hooks.

### 5.1 CLI-hook engines (Claude Code, Hyperagent shell) — write-through the ledger

The ledger is the source of truth; the chat is disposable. **Write-through the instant a fact/decision/correction happens — BEFORE continuing** (never batch to session end; compaction is mid-session):

```
node skills/kb-memory/mem.mjs remember "<fact>"                  --agent <role> [--tags a,b] [--source "Matt 2026-07-15"] [--share]
node skills/kb-memory/mem.mjs decision "<decision + why>"        --agent <role> [--share]
node skills/kb-memory/mem.mjs correct  "<CORRECT fact>"          --agent <role> --was "<wrong belief>" [--supersedes <id>] [--share]
node skills/kb-memory/mem.mjs pitfall  "<mistake + truth + rule>" --agent <role> [--share]
node skills/kb-memory/mem.mjs status   "<what I'm working on>"   --agent <role>    # ALWAYS shared to exec team
node skills/kb-memory/mem.mjs entity   set|get|list|alias|link|graph ...            # deterministic "what is X now"
```

The hooks back this up: **SessionStart** injects the resolved agent's `tail`; **PreCompact** fires right before the window compacts and reminds you to persist unsaved facts NOW; **Stop** reminds you to flush and runs `reflect.mjs` (Section 7). If no agent resolves, SessionStart warns LOUDLY (`KB_MEMORY_OPTOUT=1` silences a deliberately memory-less session).

**Hyperagent is dual-natured — capture via the SHELL, not the MCP-UI.** Hyperagent has BOTH a shell with hooks (so it belongs here in §5.1: use the CLI capture path, `mem.mjs` write-through, wrapped by `skills/kb-memory/run.sh` for SA injection) AND a gateway MCP-UI connection that resolves the shared `cto` lane (which is why §5.2 lists "Hyperagent-MCP"). These are the SAME engine seen two ways. The rule: on Hyperagent, capture through the shell + `mem.mjs` (the reliable, hooked path); do not rely on the MCP-UI for capture. The MCP-UI is for reaching the gateway tools on the cto lane, not for durable write-through.

### 5.2 Hookless engines (Claude Chat, ChatGPT, Copilot, Hyperagent-MCP) — the gateway tools

These have no Stop/PreCompact/SessionStart hook and no `mem.mjs`. Capture is server-side through the gateway connector:

- **`checkpoint`** (the substitute for the Stop hook). Call it at every natural stopping point. It writes explicit `memories[]` verbatim, optionally distills a freeform `summary` server-side into 0-3 atomic durable memories, ALWAYS writes an episode marker, and ALWAYS resets capture-pressure:
  ```
  checkpoint(agent:"<role>", summary:"<what happened>", memories:[{kind:"decision", text:"..."}], dry_run:false)
  ```
- **`memory_remember` / `memory_write`** — the connector equivalents of `remember` / `correct`. Set `supersedes` when a new entry makes a prior one FALSE, so the retracted belief drops from wake/`memory_pack`. Read companions: `memory_recall`, `memory_search`, `memory_pack`, `memory_team`, `memory_inbound` / `memory_reconcile`.

**Claude Chat specifically:** its ONLY durable-capture path is `checkpoint` + `memory_remember`/`memory_write`, backstopped by auto-journal below. Nothing on its side fires those for it, so it must call them itself. This applies to a Claude Chat exec on a **confidential `occ_<lane>` (ship) connector** — the lane that actually HOLDS `checkpoint` / `memory_remember` in its toolset.

**External-read has NO capture path (do not expect one).** `checkpoint` and `memory_remember`/`memory_write` are NOT in the `external-read` toolset (§2.4), and auto-journal fires only on mutating calls an external-read lane cannot make. So a pure external-read engine (ChatGPT / Perplexity / any DCR self-add) captures nothing — it is a read-only research consumer, by design. The capture guidance in this section is for privileged/confidential Chat lanes (`occ_`) only, never external-read.

### 5.3 Auto-journal (fully automatic, zero agent action)

Every SUCCESSFUL, MUTATING, non-dry-run gateway tool call fire-and-forget writes an `episode` memory (un-awaited = zero added latency, one big try/catch = never throws, Cosmos-inert when unconfigured). **Secret-value LAW (unwaivable):** `redactArgs` masks any key matching the secret pattern AND any value that LOOKS like a secret blob (PEM/JWT/long base64); privileged/legal tools get `{tool, outcome}` only. Excluded from `brain_search` by room-hygiene. Kill-switch `AUTO_JOURNAL_MODE=off`. **So a session that voluntarily writes nothing still journals.**

### 5.4 What durable stores hold the brain, and the off-Azure cold copy

| Store | Holds | Home |
|---|---|---|
| kb-memory ledger | per-agent facts/decisions/corrections/pitfalls/entities (append-only, temporal supersession) | commons `_MEMORY/<agent>.jsonl` + the agent's ring-correct store |
| shared exec feed | each agent's `status` + `--share` entries (rings hold; `clo-personal` excluded) | commons `_MEMORY/_exec/<agent>.jsonl` |
| memory-exec | semantic index over the shared feed (recall by meaning) | `otchealth-dataroom-s1` |
| Cosmos agent-state | episodes (auto-journal), tasks, `decisions_pending` gates | cosmos-otc-agentstate |
| data-room rooms | finance / legal-company / legal-personal / commerce / journal document rooms | `otchealthcfodata`, `otchealthlegalstore`, `otchealthcommons`, indexed on S1 |
| S3-DR cold mirror | off-Azure cold copy (ring-segregated) | AWS S3, INERT until an AWS IAM key lands (Matt gate) |

The S3-DR mirror (#356) is built and ring-segregated but INERT pending one AWS IAM key. It is the off-Azure disaster-recovery cold copy; arming it is a Matt external unblock.

---

## 6. MAINTAIN — the self-maintaining Container Apps Jobs

Freshness and self-heal run with NO human and ZERO Max-plan draw: Tier-1 Azure Container Apps Jobs on `otchealth-automation-rg` / env `otchealth-jobs-env`, off the `doc-indexer` image, one self-resolving secret (claude-driver SA → Secret Manager). Jobs pin doc-indexer DIGESTS, not `:latest`.

| Job | Cadence | Keeps healthy |
|---|---|---|
| librarian-finance | every 6h (`:00`) | CFO finance data room (index → understand → push-search) |
| librarian-commerce | hourly (`:15`) | Commerce data room (small, hourly OK) |
| librarian-legal-company | every 6h (`:20`) | Company legal room (~5k+ docs) enriched + searchable |
| librarian-legal-personal | every 6h (`:40`) | Privileged personal legal room (own index, CLO-only, never co-mingled) |
| brain-reindex | `0 */6 * * *` | Re-embeds `memory-exec` so semantic recall stays fresh; resumable |
| daily-digest | `59 23 * * *` | End-of-day journal: merged PRs org-wide + decisions + learnings → staged to commons → indexed → searchable (the closing piece of the learning loop) |
| decision-clock | daily | Sweeps every OPEN gate in `decisions_pending`, classifies overdue/near-due, sends ONE batched per-owner nudge via fleet-dispatch |
| signal-radar | ~`*/30` | 5 high-precision detectors (Sentry spike, eval-regression, grant-burn-expiry, rotate-secret-age, mark-review-overdue) + contradiction/groundedness; report-only, routes Signals to the owning lane's inbox |
| azure-canary | nightly (`--strict`) | The freshness + dead-job canary (Section 8 backbone) |
| fleet-medic | ~every 30 min | Watches every exec agent's memory health; auto-dispatches a self-heal directive to any agent running with memory OFF |

Hardening baked in (learned the hard way): `MAX_INDEX_MB` guard prevents OOM on huge files; `CU_MAX_MINUTES` soft-budget lets a big room exit Succeeded (flushed) instead of killed; the env has NO Log Analytics, so diagnose by reproducing the script in-sandbox.

Nightly cross-session self-maintenance (also Tier-1): `nightly-reflection.mjs` clusters the day's Cosmos episodes and distills genuinely RECURRING patterns into the agent's ledger; `contradiction-scan.mjs` groups assertions across both stores and opens exactly ONE `decision-clock` proposal per contested claim (it NEVER auto-resolves — a human/agent reconciles). Both read a read-only Cosmos client, dry-run by default, exit 0.

---

## 7. SELF-IMPROVE — the loop that makes every agent better each input/output

- **`reflect.mjs` (Stop-hook / nightly lessons).** At session end, condenses the transcript to signal (tool noise dropped, ~16k cap), significance-gated (`--min-tools 12`), then an LLM extracts 0-3 genuinely durable, NON-duplicate lessons (pitfall/decision/remember), deduped against the agent's recent `tail`, written via `mem.mjs` (ring + sharing correct). Always exits 0; dry-run unless `--commit`. If the LLM is 429/unavailable it falls back to high-signal verbatim statements so a throttle never costs a fact. (PreCompact passes `--prefer-fallback` so the cheap fallback classifier is primary for that path.)
- **Capture-pressure.** Per-bearer counter of mutating calls since the last `checkpoint`; at threshold (`CAPTURE_PRESSURE_THRESHOLD`, default 10) it attaches an advisory nudge ("N mutations, 0 checkpoints, call checkpoint() or this context dies at compaction"). Always advisory, fail-open. It is what makes hookless engines checkpoint before they lose the session.
- **JIT doctrine.** Binds ~12 real ledgered pitfalls to the exact tool where they bite and surfaces the pitfall at the moment of USE, attaching `structured.doctrine` to that call's response. Evaluated for reads AND writes. Throttled once per (caller, tool) per process; advisory-only; kill-switch `JIT_DOCTRINE_MODE=off`. Examples: `azure_containerapp_set_env`→oauth-clients-outage, `azure_job_execute`→skew-proof-image, `llm_azure`→gpt-4.1-mini-ban, `depot_trigger_build`→depot-macos-26, `memory_write`→set-supersedes. A new pitfall is a one-line add.
- **Pitfalls are first-class.** Knowing the recurring WRONG belief matters as much as the fact. Capture every recurring mistake as `mem.mjs pitfall`; it is surfaced FIRST on every wake.
- **agent-evals.** Golden-task harness: runs a role persona, scores it with an LLM-judge against an explicit rubric, prints a scorecard, and with `--emit` sends `eval_result` events to the PostHog Fleet Agents project (479484). CI-gateable; catches per-role quality regressions. Companion drift monitors: `recall-evals` / `embedding-drift-monitor` measure whether memory recall is silently degrading (baseline hit@5 = 0.333).

**How it compounds:** every mutating call auto-journals an episode → nightly-reflection distills recurring episodes into ledger lessons → `reflect` distills each session → shared entries index into `memory-exec` within the minute → librarians keep the doc rooms fresh → `brain_search` / `company-brain` federate all of it into cited answers → JIT doctrine binds the sharpest pitfalls to the tools → agent-evals / recall-evals measure whether quality and recall are holding. Every shipped fix, focus-group review, and decision becomes retrievable by every agent and by Matt, and the brain gets measurably smarter each day.

---

## 8. FAILURE-MODE → RECOVERY TABLE (the iron-clad heart)

This table is exhaustive by design. Find your symptom, apply the recovery. Every row is fail-open somewhere upstream, so a single failure never cascades.

| # | SYMPTOM | AUTO-DETECT | RECOVERY STEP | Who / what |
|---|---|---|---|---|
| 1 | **Connector token expired** (gateway calls 401 after ~1h) | `--watch` refresh log stops; octools-sync gateway self-heal; a 401 on any gateway tool | Claude Code: re-run `node skills/gateway-connect/connect.mjs <lane> --watch`. Chat/Hyperagent: re-auth the connector via its OAuth refresh, or re-run the Section-2 connect. | agent (self) |
| 2 | **Wrong / limited lane surface** (privileged tools missing from `tools/list`; you self-added instead of using the confidential client) | `tools/list` shows only the read tools (§2.4); `--verify-only` prints no `privileged:` line | Reconfigure with the correct confidential client: web → `occ_<lane>`; Hyperagent exec → mint `oc_<lane>` via `cfo-gateway`/lane skill; Claude Code → `connect.mjs <lane>`. Re-VERIFY the `privileged:` line appears. | agent (self); Matt provisions the `occ_<lane>` row if absent |
| 3 | **`forbidden_ring` on a privileged read** (finance/legal room refused) | Tool returns `forbidden_ring`; this is THE TELL you landed on `external-read` / the shared cto lane | If you are the ring owner: mint your own lane bearer (row 2). If you are NOT the owner (e.g. cto asking for cfo finance): this is CORRECT — route through the owning lane, do not try to widen. `clo-personal` is never reachable except `--include-personal --agent clo`. | ring owner mints; others route via owner |
| 4 | **Brain / index frozen or stale** (retrieval returns old truth; a room stopped updating) | `azure-canary --strict` per-index freshness: newest doc timestamp older than the index `max_age_h` SLO → STALE / NO_DATE → RED page (AGE, not doc-count floor — a frozen index never drops below a floor) | Restart the owning librarian: ARM `POST .../jobs/<librarian>/start` (runs are resumable/idempotent). Confirm the index newest-timestamp advances. Never re-point any tool at the retired `otchealth-brain` snapshot index. | CTO / azure-canary → human |
| 5 | **A scheduled job failing** (a Container Apps Job stops succeeding silently) | `azure-canary` dead-job pager: every scheduled job's latest execution must be `Succeeded` (via `azure_jobs_list` / `azure_job_executions` on the cto lane) → non-`Succeeded` = RED page (the exact family that let daily-digest fail silently for 9 days) | Read the failure by reproducing the script in-sandbox (no Log Analytics in the env). Fix, then restart via ARM `POST .../jobs/<name>/start`. Verify next run Succeeds. | CTO / azure-canary → human |
| 6 | **A rotated secret breaks auth** (`invalid_client` / 401 at `/oauth/token`; a lane will not mint) | connect fails `invalid_client`; a job's SM read fails; signal-radar rotate-secret-age detector | Re-fetch the current value from Secret Manager (`get-secret.mjs`), re-run the connect/skill. If the secret itself rotated, re-run `skills/vault-sync/vault-registry.mjs` so the brain registry reflects it. Never paste the value into chat. | agent (self); CTO for the vault reconcile |
| 7 | **Capture going silent** (no checkpoints landing; context dying at compaction unnoticed) | Gateway SLO monitor: `gw_checkpoint` daily count < 1 fires the PostHog alert → pages matthew@otchealth.app; capture-pressure nudge attaches at the threshold | Call `checkpoint(...)` now (hookless) or `mem.mjs` write-through (CLI). Confirm the auto-journal episode is landing (it fires on every mutating call regardless). Verify the SLO insight recovers. | agent (self); SLO alert → Matt |
| 8 | **Compaction / context loss mid-session** (the window compacted, exact facts dropped) | PreCompact hook fired the persist-now reminder; on wake the `tail` shows a gap vs what you remember | Do NOT act from chat memory. Reconstruct: `mem.mjs tail`, `company-brain ask "<recent work>"`, the newest `runbooks/DAY-<date>-*-RECOVERY.md`, `git log` + open PRs, commons `_RECOVERY/`. The ledger wins; a commit wins over a summary. | agent (self) |
| 9 | **Platform outage** (Claude Chat/Code/Hyperagent/ChatGPT down or unreachable) | connect fails to reach `mcp.otchealth.app`; the shell is unavailable | The brain is untouched (it never lived in the shell). FLUSH is already durable via write-through/auto-journal. ATTACH on any other platform per Section 2 and run the Section-3 boot; the last-3 + ledger reconstruct full context. A platform move is flush-then-attach, never a data migration. | agent (self) on any working shell |
| 10 | **Memory OFF / `whoami` FAIL** ("service-account: missing"; writes silently dropped) | `mem.mjs whoami` prints FAIL not PASS; fleet-medic detects an agent running memory-off and auto-dispatches a self-heal directive | If SA missing from the environment: STOP, tell Matt (the claude-driver SA is the keystone). Else re-run `mem.mjs use <role>` + set `~/.claude/.kb-agent`, re-verify PASS. Pick up the fleet-medic self-heal directive at next SessionStart. | agent (self); Matt if SA absent |
| 11 | **DCR landed external-read when you needed privileged** (a "Finance Tracker" connector reads nothing sensitive) | Privileged rooms return `forbidden_ring`; `tools/list` lacks `kb_search_privileged` | By design — the #120 fix ignores the connector name. Re-add as a confidential `occ_<lane>` connector (Matt provisions the row). Never treat a self-add as privileged. | agent + Matt |
| 12 | **Stale toolkit** (a skill/command is missing or behaves like an old version) | octools-sync prints no refresh; `/tmp/octools` HEAD behind `origin/main` | Force it: `git -C /tmp/octools fetch origin main && git -C /tmp/octools reset --hard origin/main`, then re-copy skills (session-start) or wait one prompt for octools-sync. | agent (self) |
| 13 | **Stale app-repo base** ("my branch is 50 commits behind main") | repo-freshen printed the catch-up command instead of ff-merging (branch has local commits / dirty tree) | Run the exact `git -C <dir> merge/rebase origin/main` command repo-freshen printed (it never auto-touches unclean trees). Use the `octsync` helper for a dirty long-lived session. | agent (self) |
| 14 | **A dispatch never delivered** (agent-to-agent hand-off did not land) | Target's SessionStart `dispatch.mjs check` deletes-after-read; if the target had not woken, or you needed it now, nothing happened | Re-dispatch (`dispatch.mjs send <to> "<msg>"`). For an immediate run use `--spawn` (draws the shared Max weekly limit) to fire the Tier-2 runner. Async is the default (zero Max draw). | sender (self) |
| 15 | **LLM 429 / throttle on a reflect/company-brain call** | The call returns 429 / unavailable | reflect falls back to verbatim high-signal extraction (a throttle never costs a fact); company-brain routes primary → fallback foundry deployment on a throttle. Retry honors Retry-After. No manual action usually needed. | automatic; agent retries if needed |
| 16 | **`oauth-clients` outage after an env change** (lanes stop resolving right after `azure_containerapp_set_env`) | JIT doctrine warned on `azure_containerapp_set_env`→oauth-clients-outage at call time; lanes 401 | Revert/repair the env var; the oauth-clients registry backs every lane resolution. Verify a known-good lane mints again before proceeding. | CTO |
| 17 | **Depot iOS build rejected** (altool 409, iOS 26 SDK mandate) | JIT doctrine on `depot_trigger_build`→depot-macos-26; the workflow's Xcode-26 guard hard-fails | Build on runner `depot-macos-26` (Xcode 26). `depot-macos-latest` = macOS 15 / Xcode 16.4 which Apple rejects. Re-dispatch the corrected workflow. | CTO |
| 18 | **Groundedness / citation failure** (an answer asserted an ungrounded claim) | signal-radar groundedness detector; `groundedness_check` / `shield_check` flag it | Re-run the query through `brain_search` (or `mode:"deep"`) and answer ONLY from retrieved, cited results. If the brain has no record, say so and retrieve — never fill from general knowledge. | agent (self) |
| 19 | **Contradiction across agents** (two agents assert conflicting facts) | `contradiction-scan` opens exactly ONE `decision-clock` proposal per contested claim (never auto-resolves) | A human/agent reconciles the gate and writes the resolving `correct ... --was ... --supersedes <id>`. Do not let both beliefs persist. | owning agent + human |
| 20 | **An open gate aging past SLA** (a rotate-secret / Matt-gate / review overdue) | `decision-clock` daily sweep sends ONE batched per-owner nudge via fleet-dispatch | Act on the gate or re-set its expected-by; ack/close it (`decision.mjs`) once resolved. | gate owner |
| 21 | **Gateway down — the durable SUBSTRATE, not the client** (`mcp.otchealth.app` returns 5xx / times out / unreachable while your client platform is UP; ALL lanes lose the brain at once — the true single point of failure) | Every gateway tool 5xx/timeout at once; connect fails to REACH `mcp.otchealth.app` (distinct from a 401 lane-downgrade, row 1); the Front Door / APIM health probe fails | Health-check the gateway (`GET https://mcp.otchealth.app` liveness); page the CTO + Matt — a Container App / Front Door / APIM incident is a CTO/human recovery, not an agent self-heal. The brain itself is untouched (Blob + S1 + Cosmos are separate from the gateway compute), so nothing durable is lost; you are read-blocked until the gateway is healthy. LAST-RESORT READ: the off-Azure S3-DR cold copy (§5.4) — but it is INERT until an AWS IAM key lands (Matt gate), so today the recovery is restore-the-gateway, not read-around-it. | CTO / Front Door + APIM health probe → human |
| 22 | **Cosmos agent-state or Blob commons WRITE failure** (a `memory_write` / `decisions_pending` / dispatch / handoff write fails at the store; not a ring refusal) | The tool returns a store error, not `forbidden_ring`; auto-journal is designed Cosmos-inert-when-unconfigured so it will NOT throw, but an explicit write surfaces the error; azure-canary / signal-radar flag store-health | Capture is fail-open by contract (auto-journal never throws; explicit writes surface the error to you). Retry the write; if the store is hard-down, hold the fact in the CURRENT session and re-flush once the store recovers (do NOT declare it captured until a write succeeds). Escalate a persistent Cosmos/Blob outage to the CTO. Never treat a store-write failure as "captured." | agent (self) retries; CTO for a store outage |
| 23 | **S1 search hard-down (5xx), not merely stale** (retrieval calls error out, distinct from row 4's frozen/stale index) | `brain_search` / `kb_search` / `company-brain` return 5xx or connection errors (row 4 = returns OLD-but-valid results; this = returns NO results / errors); azure-canary freshness probe cannot query at all (dark-sensor RED) | This is a search-SERVICE incident on `otchealth-dataroom-s1`, not a librarian problem — do NOT restart librarians (they write, they are not the reader). Health-check the S1 service, page the CTO. Ground-first still holds: if you cannot retrieve, SAY you cannot retrieve and wait — never fill the gap from general knowledge. The deprecated Basic service is NOT a fallback (it is stale by design and being decommissioned). | CTO / azure-canary dark-sensor → human |

**The rule behind the table:** every sensor's SILENCE must page (azure-canary `--strict` goes RED when it cannot even run — the dark-sensor case), and every recovery is a restart/re-attach/re-flush, never a data rebuild, because the durable brain is the invariant. The substrate-down rows (21-23) are the exception that PROVES it: when the gateway compute or a store or the search service is the thing that is down, the durable brain is still intact behind it — the recovery is to restore that component (a CTO/human action), never to rebuild the brain, and the agent's obligation is to stay ground-first (retrieve or say you cannot; never confabulate) and to not declare a fact captured until a write actually lands.

---

## 9. RING SAFETY

**Two hard laws (unwaivable; they cost zero velocity and are the ONLY lines that survive the guardrails-down posture):**

1. **Never commit a secret VALUE into any repo, chat, or Notion.** Names are fine; values live in Secret Manager / Key Vault and hydrate per session. Auto-journal enforces this server-side (`redactArgs`), but it is your responsibility too.
2. **Never expose real PHI to a non-BAA runtime, and never make an autonomous external INND MNPI disclosure.** PHI/BAA-scoped data (MedReview, Companion PHI) never touches a non-BAA path or a non-BAA engine. INND/securities MNPI never leaves the cfo/capital lane and never reaches a fleet-wide digest, a non-privileged destination, or `web_search`. Any IR-facing output routes through capital + counsel + Matt (Reg FD firewall). Revisit only with Matt + counsel.

**Per-lane rules.** `isShipLane` (cto / developer / EXEC_RING) lanes get the ship toolset incl. privileged read + write; external-read lanes get the read-only tools only (§2.4). Curation applies on the connector surface (DCR/occ_); `client_credentials` fleet lanes see the full catalog but are held by the per-tool gates (`kb_search_privileged`, `memory_write`, governance). Finance MNPI rooms resolve ONLY for the cfo lane; legal privileged rooms only for clo. A privileged connector MUST be a confidential client — a self-registered DCR client is always `external-read`.

**Ring enforcement survives the guardrails-down posture.** The guardrails-down directive sets `COMPLIANCE_MODE=off` + `GOVERNANCE_MODE=off`, which disables the SOFT/advisory governance responses only. It does NOT touch lane resolution, the `external-read` DCR default, `forbidden_ring`, or the L3 privileged-tool ring re-check (§2.5). Those ring gates are INDEPENDENT of both modes and remain fully enforced with guardrails down. Guardrails-down means "no friction on reversible non-PHI internal work," never "rings are off."

**ROTATE-BEFORE-LAUNCH (identity/token hygiene).** The long-lived credentials that reach this system are on the rotation list and re-registered via `vault-registry.mjs` after any rotation. Notably: `PERPLEXITY_CONNECTOR_TOKEN` (static long-lived external-read bearer, §2.4 — scoped to `external-read` only, can never resolve a privileged lane), the per-lane confidential client secrets (`occ_<lane>`, `oauth-lane-<lane>-*`, `oc_<lane>`), the `gh-app` private key, the ASC `.p8`, `azure-sp`, and the claude-driver SA. Values live in Secret Manager / Key Vault; names only ever appear here.

**Connected memory holds the rings.** Each agent keeps a PRIVATE, ring-correct lane co-located in its own store. ONLY `status` (always) and entries written `--share` ever leave the lane, and those must be NON-sensitive (no MNPI specifics, no privilege). Cross-lane notes (`remember "..." --agent <owner> --on <target>`) are append-only, tagged by sender, and cannot supersede the owner's entries.

**`clo-personal` isolation (attorney privilege, unwaivable).** `clo-personal` is HARD-EXCLUDED from all sharing: its `status`/`--share` is a no-op that stays private; it is excluded from cross-lane writes, from `memory-exec` semantic indexing, and from `company-brain` / `brain_search` unless explicitly `--include-personal --agent clo`. Its handoff snapshots embed NO ledger text — counts + a "read your OWN ledger in-session" pointer only. Sensitive roles for handoff redaction = `cfo, clo, clo-personal, capital`. Procedure travels; sensitive content stays home.

---

## 10. THE STANDING CADENCE

### Per-agent DAILY checklist

1. **Attach + boot** (Sections 2-3): gateway connected on your lane, `mem.mjs whoami` = PASS, `.kb-agent` set, `tail` + `team` + `inbound` + `dispatch check` read.
2. **Ground-first everything.** Any company question → `brain_search` (or `company-brain ask`) FIRST, answer only from cited results.
3. **Write-through as you go.** `remember`/`decision`/`correct`/`pitfall` the instant it happens; hookless engines `checkpoint` at each natural stop. Never batch to session end.
4. **Publish `status`** whenever project state changes (started X / shipped Y / blocked on Z) so the exec team sees it.
5. **Check your FLEET-BULLETIN** (`bulletin.mjs since` runs automatically; read it) and let octools-sync live-pull mid-session.
6. **Ack your gates.** Anything you own in `decision-clock` that resolved — close it.
7. **Sunset at end of session** (Section on demand): flush live state, `protocol.mjs sunset --agent <role>`, tests green if code touched, then `Goodnight friend`.

### Per-agent WEEKLY checklist

1. **Confirm the maintenance layer is green.** azure-canary is not paging (no stale index, no failed job); fleet-medic shows no memory-off agent on your lane.
2. **Run / review your role eval.** `agent-evals` scorecard for your role; check recall-evals / embedding-drift hit@5 has not regressed below the 0.333 baseline.
3. **Reconcile contradictions.** Clear any `decision-clock` contradiction proposal touching your lane with a proper `correct --supersedes`.
4. **Rotation hygiene.** Address any signal-radar rotate-secret-age / grant-burn-expiry signal on your lane; re-run `vault-registry.mjs` after any rotation.
5. **Verify your durable copy.** Spot-check that your last week's key decisions are retrievable via `company-brain ask` / `brain_search` — if a decision is not retrievable, it was not captured; write it now.
6. **CTO only:** confirm the S3-DR arm status and any Matt external unblocks (AWS IAM key, Entra agent licenses) are tracked as open gates.

The cadence exists so the invariant stays true: at any moment, any agent can be flushed on one platform and attached on another with zero loss, because the lane identity is provisioned and the durable brain is current, cited, fresh, and backed up.