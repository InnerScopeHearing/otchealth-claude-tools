# Superbrain Working-Memory Program (the "stop forgetting" fix)

> Decision brief from the 21-agent architecture panel (2026-06-24), reconciled by the CTO.
> Living build record. Update as P0/P1/P2 land.

## Diagnosis (verified in code, not assumed)
The store works; the **read-back loop is open**. Memory is written outward correctly
(`PreCompact`/`Stop` -> `kb-journal capture` + `reflect --commit` -> Azure Blob ledger),
but it is read back into context **exactly once**, at `SessionStart`
(`kb-inject.sh session` -> `mem.mjs tail --n 30`).

- A mid-session **compaction never re-fires that read.** Claude Code does not raise a fresh
  `SessionStart` on auto-compaction; `PreCompact` only captures outward and echoes one line.
- The only **per-turn** hook, `UserPromptSubmit`, is spent entirely on `octools-sync` (toolkit
  refresh) and touches memory zero times.
- So recall is a **command the agent must choose to run**, and a just-compacted model has lost
  the cue that the fact exists. **Stored != in-context.** That single open edge IS "forgets what
  happened 20 minutes ago."

Compounding (and what makes it invisible): activation is a silent 3-of-3 AND-gate (fresh
checkout AND identity marker AND wired hooks); no glanceable "memory live?" signal; the one
injection that fires is an unranked, unbudgeted `tail --n 30` recency dump.

## North star
Memory becomes a continuous **push, not an opt-in pull**: on every prompt (and therefore on the
first prompt after any compaction) a small, **ranked, token-budgeted, ring-correct** slice of the
agent's durable ledger is auto-injected, fail-open and LLM-free on the hot path, with a one-line
health beacon, so a long-running agent cannot drift past one compaction and Matt can see at a
glance the brain is on.

## P0 (SHIP, single-session-validated first) -- `kb-recall` per-prompt auto-recall
A second `UserPromptSubmit` hook beside `octools-sync` that injects a budgeted memory block read
from the ledger every turn. Reuses the existing hook slot, ledger, and `matchq` rank. **The
critic's required mitigations are folded into P0 (not deferred):**

1. **`pack` verb in `mem.mjs`** -- emits `<<<WORKING-MEMORY>>> ... <<<END>>>` (replace-not-append),
   hard-capped (~1200 tokens). Composition: (1) ALWAYS pitfalls + open decisions/corrections +
   pinned, **but bounded with newest-wins eviction** (R4); (2) top-K (~6) `matchq`-ranked vs the
   prompt, recency tiebreak; (3) last ~4 recency lines. Dedupe; prefer newest `--was` supersedes.
2. **READ-SIDE RING FILTER (BLOCKER G1)** -- the inject path must hard-exclude `clo-personal` and
   deny-by-pattern MNPI (INND, ticker, raise, Reg D/A, share price, 8-K/10-Q) and PHI markers from
   the shared feed BEFORE injection, not just on `publishShared` (write). This is the load-bearing
   security fix; without it, continuous injection of the shared feed is an MNPI/PHI leak.
3. **Local-first hot path (G4/R1)** -- read a LOCAL ledger cache; refresh from Blob on a throttle.
   No per-prompt container LIST. Network failure -> stale-local, never a stalled prompt.
4. **Robust stdin + no shell injection (G2/G3)** -- parse the `UserPromptSubmit` JSON safely, pass
   the prompt to `mem.mjs` via stdin/`--query-stdin` (never interpolate raw prompt text into a
   shell command). If the prompt field is missing, degrade to recency but flag it.
5. **`kb-recall.sh`** -- same agent-resolution precedence as `kb-inject.sh`
   (`session marker > repo .kb-agent > KB_AGENT`). Identity self-heal is **non-persistent for
   guesses** (G6): resolve for this invocation; only persist `~/.claude/.kb-agent` for a strict
   exec-home-repo allowlist (otchealth-cto->cto, otchealth-ops->coo, ...); otherwise loud one-line
   OFF. `set +e`, always `exit 0`, fail-open.
6. **Health beacon** first line: `MEMORY: LIVE agent=cto | ledger=NN | last-write=4m | hooks=ON`
   or `MEMORY: OFF (no agent) -> echo cto > ~/.claude/.kb-agent`.
7. **Canary pulled into P0 (G5)** -- SessionStart writes `canary:<nonce>`; the next recall asserts
   it is in the pack. If absent, beacon goes **DARK** (the beacon proves function, not just wiring).
8. **PreCompact belt -- PID-namespaced (G7)** -- write the pack to `~/.claude/.kb-resume.<session>`
   (not a shared path); prepend once on the next prompt then delete. No cross-session `$HOME` race.
9. **Wire** as a 4th hook in `install-octools-hook.mjs` (additive; `match` guard idempotent).
10. **Rollout (critic GO/NO-GO)** -- build on a branch, install + validate on THIS session
    (remember -> compact -> recall with zero manual action), THEN merge to main + `bulletin.mjs add`
    so `octools-sync` live-pulls it fleet-wide. Single-session canary BEFORE the fleet bulletin.

## P1 (next)
- Continuous-proof: canary self-repair + `tests/memory-loop.test.mjs` (remember->compact->recall)
  in `run-tests.sh` + a `memory_beacon` PostHog event (Fleet Agents project 479484; no Log
  Analytics so PostHog is the alert lane) + a per-agent memory-health row in the COO morning brief.
- Semantic recall (embeddings-only, 2s timeout, local fallback) + hot-path write-through indexing
  into `memory-exec` (freshness hours -> seconds) + `is_current`/supersedes at index time + pin
  `reflect` distill to foundry gpt-4.1-mini (off the contended shared gpt-4o).

## P2 (ceiling-raiser, only after P0/P1 proven)
- Typed **entity/current-value** projection over the flat JSONL (`mem entity set/get`, provenance,
  supersedes) so "what is X now?" (CFBundleVersion, bundle id, which ASC key signs which app, n8n
  base URL) is deterministic. A thin keyed VIEW, NOT a knowledge-graph service. Alias map. Wire
  company-brain to read current-values.

## Killed (do not relitigate)
- A standalone knowledge-graph service / new memory backend (the store works; the bug is a loop).
- A new monorepo / app-manager repo (claude-tools IS the shared layer; per-app repos stay separate).
- An LLM call on the per-prompt hot path (latency + shared gpt-4o contention).
- Relying on `KB_AGENT` env to label agents (exec share one environment; identity self-claims).
- Upgrading Azure AI Search to S1 to "fix recall" (BASIC is sufficient; the bug was the loop).
- Any new paid infra (everything rides the existing credit stack).

## Critic blockers folded into P0 above
G1 read-side ring filter (BLOCKER), G2 stdin validation, G3 shell-quote the prompt, G5 canary so
the beacon proves function, G6 no sticky mis-homing on guessed identity, G7 PID-namespace
`.kb-resume`, R4 bound the never-truncated set. Critic verdict: NO-GO fleet-wide as originally
drafted; GO on a single-session canary with these in. This brief reflects the corrected P0.

## Execution log (newest first)
- **2026-06-25 -- Wave 2b shipped + memory write-durability hardening.**
  - **Wave 2b (PR #219, squash 906d5523):** write-through SEMANTIC indexing. `mem.mjs append()`
    spawns `index-one.mjs` DETACHED + unref'd after a SHARED publish; it embeds that one entry and
    upserts into the `memory-exec` AI Search index immediately (same `docId(agent,id)` as
    `semantic.mjs` -> `mergeOrUpload`, never a dup). So a fact stated this minute is recallable BY
    MEANING this minute, not after the 6h reindex. RING-SAFE: gated on `publishShared()` returning
    true (private / clo-personal never reach the shared brain). Fail-open. Proven live: a `--share`
    decision landed in `memory-exec` in seconds and ranked #1 on a meaning-only query.
    `tests/index-one.test.mjs` (hermetic: fail-open guards + doc-key parity with semantic.mjs).
  - **HOT-PATH semantic-in-pack: DEFERRED on purpose (task #19), not dropped.** Critic flagged
    per-prompt network; the write-through half already gives fresh `semantic.mjs recall` +
    company-brain, and `pack` already keyword-ranks the full local ledger. Prereq before building:
    a READ-ONLY Azure AI Search QUERY key (do NOT cache the admin key to every agent sandbox) +
    a hard latency budget (cred-cache + ~1.5s AbortController + ~60s throttle + local fallback).
  - **Write-durability fix (PR #220, squash 6851505a):** `mem.mjs` blob ops (`getText`/`putText` +
    commons `cGet`/`cPut`) now `fetchRetry` transient `{403,408,429,5xx}` with bounded backoff. They
    used to throw straight out, so a transient proxy/SAS 403 made a `mem.mjs remember` silently DROP
    the fact (hit live this session). 404 still = absent (not retried). A real 403 surfaces after the
    few tries. Gate 149/149.
- Gate was 149/149 here (added `index-one.test.mjs`). Prior P0/P1: identity auto-claim (#214),
  team-health + memory-loop CI (#215), PostHog beacon (#217), distill durability off gpt-4o (#218).
- **2026-06-25 -- Wave 3 (P2) typed entity/current-value layer SHIPPED.** `mem.mjs entity
  set/get/list/alias`: the deterministic "what is X NOW?" projection over the flat ledger (an entity is
  a normal row `type:"entity" {ekey,evalue}`, latest-per-key wins via supersedes, so it rides the same
  cache + share + write-through-index plumbing for free). `normKey` collapses casing/punctuation;
  `alias` points many phrasings at one canonical key; `get` prints the value + provenance + a "verify
  the live source" caveat. The pack now injects a `CURRENT VALUES (latest wins; deterministic)` section
  every prompt, and `renderMd` shows a CURRENT VALUES block. company-brain needs NO change: SHARED
  entities flow into `memory-exec` and are already brain-answerable. `tests/entity.test.mjs` (hermetic:
  surfaced, superseded-value-gone, always-on). Gate 152/152. Verified live (n8n_base_url, asc_team_id,
  asc_consumer_signing_key_id set + aliased + recalled). DEFERRED here: a typed `entity` FIELD in the
  memory-exec index (needs an additive schema change + reindex) so the brain can cite `entity=<key>`.
- **2026-06-25 -- Wave 4 the auto-dispatch FLEET MEDIC (the feature Matt asked for) SHIPPED (code).**
  `skills/fleet-medic/medic.mjs`: a standing monitor that classifies every exec agent's memory health
  from TWO signals -- the deterministic `team-health` shared-feed spine (all agents; catches
  NO-MEMORY/never-initialized) + the sharp PostHog `memory_beacon` (a FRESH beacon with
  DARK/hooks=false/ledger=0 = active-but-broken = the real fire). Staleness alone is only WATCH (never
  cries wolf on an idle agent). On `--dispatch` it writes a targeted self-heal directive to commons
  `_MEDIC/<agent>.md` + emits a `medic_dispatch` PostHog event + maintains per-agent cooldown +
  escalates persistent DARK to `_MEDIC/_ESCALATIONS.md`. The agent self-heals on wake: `kb-inject.sh`
  session mode runs `medic.mjs check --agent <self>`, which surfaces the directive ONCE then deletes it
  (needs SAS 'd' perm -- a bug found + fixed in test). Cron entrypoint
  `skills/doc-indexer/job/fleet-medic.sh` (Tier-1, zero Max draw). `tests/fleet-medic.test.mjs` (8
  hermetic classifier cases: active-broken dispatches, idle does NOT, cooldown, escalation). Gate
  161/161. Live dry-run found 4 NO-MEMORY agents (capital/compliance/growth/rainmaker) + 3 idle WATCH +
  3 healthy -- correct triage. STAGED follow-on (token-gated): auto-spawning an actual medic CLAUDE
  SESSION (Tier-2 `claude -p`) on escalation, blocked on `CLAUDE_CODE_OAUTH_TOKEN` like the other Tier-2
  runners. **DEPLOYED 2026-06-25 (headless ARM):** rebuilt the doc-indexer image (ACR run, now ships
  `skills/fleet-medic/` + `fleet-medic.sh` -- a Dockerfile COPY was missing, fixed in #223), then
  created the `fleet-medic` Container Apps Job on `otchealth-automation-rg` (image doc-indexer:latest,
  cron `*/30`, replicaTimeout 600, sab64 + ACR secrets cloned from brain-reindex). Manual run
  `fleet-medic-2tyuq61` Succeeded IN-CONTAINER (proves the image + entrypoint + SA-secret auth work).
  So the auto-medic is now LIVE on cron, not just merged.
- **The whole superbrain memory program (P0-P2 + the auto-medic) is SHIPPED + DEPLOYED.** Remaining
  options: task #19 (hot-path semantic-in-pack, needs a read-only AIS query key) + the Wave-4 Tier-2
  medic-session spawn (auto-spawn a real `claude -p` medic on escalation; needs CLAUDE_CODE_OAUTH_TOKEN).
