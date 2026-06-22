# Fleet model-routing policy (Fleet Intelligence #5)

How the fleet picks LLM deployments: the right model for each task, with a resilience fallback so a
transient throttle never stalls an agent. Azure-credit-funded (no metered spend); the secret store
holds both deployments.

## The two chat deployments
- **Capable tier, `gpt-4o`** on `azure-openai-endpoint` (secret `azure-openai-key`). For reasoning,
  synthesis, citation, vision, persona simulation, and LLM-as-judge.
- **Cheap / fallback tier, `gpt-4.1-mini`** on `azure-foundry-openai-endpoint` (secret
  `azure-foundry-key`) — a SEPARATE Azure quota. For bulk extraction + document understanding, AND as
  the failover for the capable tier when it throttles.
- **Embeddings, `text-embedding-3-large`** (foundry). Used by `kb-memory/semantic.mjs`,
  `company-brain`, and `doc-indexer` (3072-dim, the AI Search vector fields).

## Routing by task
| Task | Skill | Model |
|---|---|---|
| Company-brain synthesis (cited answers) | `company-brain` | gpt-4o -> gpt-4.1-mini |
| Self-improving lesson extraction | `kb-memory/reflect` | gpt-4o -> gpt-4.1-mini |
| Focus-group personas (vision on screenshots) | `focus-group-loop/fgl` | gpt-4o -> gpt-4.1-mini |
| Eval persona run + LLM-judge | `agent-evals` | gpt-4o -> gpt-4.1-mini |
| Document understanding (CU pass, bulk) | `doc-indexer` | gpt-4.1-mini (cheap tier, native) |
| Embeddings (memory + data rooms) | `semantic` / `doc-indexer` | text-embedding-3-large |

## The resilience fallback (implemented fleet-wide)
The shared `gpt-4o` deployment is a **contention point** (this session hit sustained 429s during
brain + reflect + fgl runs). So every capable-tier caller now routes **primary gpt-4o -> fallback
foundry gpt-4.1-mini** (separate quota) on a sustained throttle, with Retry-After backoff:
- `company-brain/brain.mjs`, `kb-memory/reflect.mjs`, `focus-group-loop/fgl.mjs`,
  `agent-evals/run-evals.mjs` all use a `callChat(ep,key,dep,...)` helper: try primary (4-5 tries,
  honoring Retry-After), and on a throttled exhaustion fall through to the foundry deployment.
- `unset`/override per skill via `*_MODEL` (primary) and `*_FALLBACK_MODEL` env vars.
- A failed fallback throws the same as before (no behavior change on success; pure resilience add).

## Claude-agent routing (the overnight / timed runner)
Agent *work* (the `claude -p` runners) is the Max 20x SUBSCRIPTION, not the metered API or Azure
OpenAI. Per-task Claude model selection (Opus for hard reasoning, Haiku for cheap bulk) is set in the
runner prompt / `--model`; the runner draws the shared weekly Max pool, so push deterministic work to
Tier-1 scripts (Azure credits) and spend the Max pool only where agentic judgment is required.

## Cost / throughput levers (documented follow-ons, do when volume justifies)
- **Prompt caching** (Azure OpenAI): cache the long, stable system prompts (the brain synthesis prompt,
  the persona briefs) to cut input cost on repeated calls.
- **Batch API** for the librarian embeddings + CU understand pass (async, ~50% cheaper) when a room is
  a large one-shot backfill rather than incremental.
- **Telemetry-driven** (Fleet Intelligence #1): the `fleet-telemetry` cost-per-agent data identifies
  which skill/agent to optimize first; optimize by measurement, not guess.

## Why this is "done enough"
The resilience fallback is the piece that was actively biting (agents silently degrading on the gpt-4o
throttle). It is now fleet-wide and proven (company-brain answered through a live throttle via the
fallback). The cheap-tier routing already exists where it matters (doc-indexer CU on gpt-4.1-mini). The
cost levers above are real but volume-gated; wire them when the telemetry shows the spend, not before.
