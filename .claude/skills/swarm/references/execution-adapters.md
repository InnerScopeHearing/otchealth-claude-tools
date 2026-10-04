# Execution adapters and larger fleets

Use this reference when configuring capacity, creating separate coding sessions, or designing a shared cloud runner. Product facts below were checked on 2026-10-03; reverify changed clients. This reference describes supported interfaces and a proposed runner, not an installed twenty-worker service.

## Choose the actual execution surface

| Surface | Execution route | Capacity and session truth |
| --- | --- | --- |
| Work with native delegation | Actually exposed native spawn/control tools | Use live hosted allocation; local config does not enlarge it. |
| User-controlled Codex app/CLI | Native subagents and supported configuration | Current concurrency key counts child threads, excluding the conductor. Verify effective configuration and available models. |
| Ordinary Chat | An installed, authorized remote MCP runner when available | A skills-only plugin supplies instructions; native child spawning is unavailable unless this Chat actually exposes it. |
| Codex folder conversations | App-server thread/start with cwd; then turn/start | Creates Codex threads, not ordinary ChatGPT Project chats. App-server is experimental and is not supported for production workloads. |
| Codex Cloud tasks | Supported task-launch surface and exact environment | A named project or setup workspace is not a launched task. |
| ChatGPT Project chats | A separately exposed supported conversation-creation operation | No public automation route was established in this research. Report unavailable rather than guess private endpoints or imitate this with Codex threads. |

Do not expand a fixed allocation by recursively opening sessions around its restriction. User-controlled Codex configuration or a separately authorized runner is a distinct execution capability; it still shares account throughput and usage limits.

## Codex model and concurrency configuration

Current supported base settings:

```toml
[agents]
enabled = true
max_concurrent_threads_per_session = 20
default_subagent_model = "gpt-6-luna"
default_subagent_reasoning_effort = "medium"
```

The value 20 is an intended ceiling for a capable user-controlled host, not proof that twenty workers can execute. The current key excludes the primary. The older agents.max_threads is a legacy alias; do not configure contradictory values. Do not add undocumented depth settings. Select gpt-6.1-sol for the conductor through the actual model selector or launch flag. Available-model discovery and execution receipts establish availability and selection.

The provided [PowerShell launcher](../scripts/start-swarm-codex.ps1) starts one Codex conductor with these per-launch role settings and a configurable child ceiling. Its default ceiling is six; pass MaxWorkers=20 when that host and budget support it. Preview prints the exact executable and argument array without launching a model, changing user config, installing the plugin, or creating workers. The launcher does not change a running Work session.

Example in a PowerShell terminal, after this plugin is available in that Codex runtime:

```powershell
& '<installed-skill-path>\scripts\start-swarm-codex.ps1' -ProjectFolder '<authorized-repository>' -MaxWorkers 20 -Preview
& '<installed-skill-path>\scripts\start-swarm-codex.ps1' -ProjectFolder '<authorized-repository>' -MaxWorkers 20
```

Start from the authorized repository. For parallel coding writers, allocate separate Git branches/worktrees and track each as a separate target. Shared source mirrors are reference material. Keep one integrator and one release owner per environment. Cap expensive builds, browsers, and test processes separately from model-agent count.

## Proposed shared cloud runner

For one callable interface across Chat, Work, Codex, PC and cloud, add an authenticated MCP runner only when the supported native route cannot satisfy the task. These are proposed tool names, not currently exposed functions:

| Proposed interface | Required behavior |
| --- | --- |
| swarm_capabilities | Report runtime, identity, available models, allocation scope, native/session/project-chat support and verification status. |
| swarm_plan | Return an immutable bounded task graph and required resource locks. |
| swarm_run_start | Idempotently start one approved plan within global capacity and budget. |
| swarm_run_get / swarm_worker_get | Return exact current run, worker, thread, turn and artifact identifiers. |
| swarm_run_cancel | Request underlying cancellation, reconcile terminal state and keep unknown target locks. |
| swarm_artifact_get | Retrieve an authorized artifact and digest without forwarding another seat's protected material. |

The minimum service needs a transactional run ledger, queue, global concurrency allocation, fenced resource ownership, worker deadlines, and persistent supervision. Record role, client, project kind and ID, repository, host, worker/thread/turn IDs, requested and observed models, intent ID, attempts, usage, state, artifact location/hash, and the next decision. Distinguish queued, running, awaiting approval, completed, failed, blocked and unknown.

Begin with a single user-owned cloud host and a durable transactional store. Add distributed queues or additional hosts only after throughput measurements justify them. Model-agent ceiling and CPU/RAM job ceiling are different controls. A twenty-agent target should not automatically launch twenty compilers or browsers on a laptop.

Codex app-server documents thread/start, thread/resume, thread/fork, turn/start, turn/steer, turn/interrupt, model/list and approval events. Use it only in an appropriately bounded experimental client; its current production limitation blocks treating it as the production release controller. Production releases should remain with the existing accepted CI/CD gate or use another supported production runner.

A subscription-backed self-hosted route requires the documented Sign in with ChatGPT eligibility and protected credential handling; a generic hosted service cannot reuse local Codex authentication by assumption. Multiple hosts share plan usage. This route grants no ChatGPT conversation history or account context and its preview lacks certain hosted tools. Paid API runners are a separate budgeted option, disabled unless specifically authorized. Do not copy another Chat's seat tools, tokens or protected context into worker sessions.

## Automatic use and distribution

The policy is automatic, relevant use: Sol identifies independent work and invokes SWARM without another delegation permission round; Luna executes bounded packages; Sol verifies and integrates. Tools and plugins are selected for task value and actual availability. The instruction is not to execute every installed plugin.

Use the same private plugin in supported Chat/Work/Codex surfaces. Where plugins are unsupported, use a versioned repository skill at the runtime's supported skill-discovery path. Current docs say the Codex IDE extension does not support plugins. Laptop installation is not cloud installation.

Track each in-scope target separately: expected version/hash, installed release, direct load, model-selection capability, live allocation, harmless exercise and result. A release save does not hot-reload every active agent. Protected seats keep their own identities and memory boundaries; a coordination policy gives no access to their sources.

## Acceptance

1. Prove the required model roles using supported selection inputs and execution metadata when available.
2. Prove the chosen worker count with actual overlapping execution handles. A configured ceiling or simulated scheduler is not AI-worker execution.
3. For separate project chats, require exact product/project/chat IDs and independent membership readback.
4. Run the same bounded workload at two, six and, where supported, twelve/twenty workers. Retain the smallest useful fleet delivering accepted output in at most 80% of baseline time with equivalent correctness and provenance.
5. Include queueing, integration and verification in timing; record total observed usage and label unobservable usage.
6. Verify workspace isolation, global count accounting, approval-denial propagation, cancellation reconciliation and recovery after conductor loss.

Stop a lane after one focused diagnosis and two bounded repair attempts without significant progress. Preserve its best verified state and apply the user's Rule #1; keep unrelated viable lanes moving.

Primary documentation:
- https://learn.chatgpt.com/docs/agent-configuration/subagents
- https://learn.chatgpt.com/docs/config-file/config-reference
- https://learn.chatgpt.com/docs/environments/git-worktrees
- https://learn.chatgpt.com/docs/app-server
- https://learn.chatgpt.com/docs/projects
- https://learn.chatgpt.com/docs/plugins
- https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
