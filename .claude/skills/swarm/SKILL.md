---
name: swarm
description: Coordinate parallel research and development with GPT-6 Luna execution workers and GPT-6.1 Sol design and verification. Use automatically when independent work benefits from delegation, or when the user requests a swarm, parallel agents, or project-linked sessions.
---

# SWARM

Use this skill to coordinate parallel work that is faster without becoming opaque, redundant, unsafe, or unverifiable.

## 1. Establish the run contract

Before assigning work, write a compact run contract containing:

- one objective and a binary pass/fail outcome;
- the exact deliverables and authoritative evidence required for each;
- owner, deadline, model and reasoning setting, token/usage budget, and maximum worker count;
- source, identity, project, cloud-host, and data-boundary constraints;
- an operation intent ID for every mutation, the provider idempotency key where supported, and a rollback/reconciliation plan. If a tool has no idempotency input, record the exact target and pre-write state instead of inventing an unsupported argument.

Treat the parent agent as conductor. Every worker receives one bounded deliverable, its pass/fail test, its evidence format, and its stop condition. Do not create workers merely to produce status prose.

## 2. Capacity, models, and automatic delegation

Use SWARM automatically when independent research, implementation, review preparation, or reconciliation can materially improve completion time or quality. A direct SWARM invocation is sufficient task authority for the requested coordination; do not repeatedly ask to delegate already-authorized work. Skip needless fan-out for trivial, sequential, or shared-target work.

The role policy is GPT-6.1 Sol (`gpt-6.1-sol`) for the conductor, architecture/design, integration decisions, and final verification; GPT-6 Luna (`gpt-6-luna`) exclusively for SWARM execution workers. Workers can research, implement, and run focused tests; Sol owns acceptance. A separately needed independent verification agent uses Sol and counts against the same allocation. Select exact model IDs through the supported launch/configuration fields. Full-context forks may require inherited models: use a bounded clean handoff when necessary to select Luna explicitly. Record requested model, selection input, and returned model evidence separately. If the required model cannot be selected, report that blocked role; do not silently substitute GPT-5.6 Luna, another model, or a paid provider. These instructions cannot change the model of a turn already running.

Discover live delegation tools and actual capacity before dispatch. Choose the smallest applicable limit from useful independent work, the user's authorized count, platform capacity, the shared global allocation, and the remaining usage budget. Do not impose a universal two-worker default. A later explicit request for a larger fleet supersedes an earlier user-set worker preference within that request's scope, while platform and security limits still apply.

Record whether a reported limit includes the conductor or counts only children, the number already allocated, and the remaining capacity; never subtract the conductor twice. Queue excess work and reuse workers. A user-controlled Codex concurrency setting can be configured through its supported interface; it does not change a hosted Chat or Work allocation. Do not create sessions or recursive descendants to evade a product limit.

Use one mutation owner per exact shared target. Independent branches and worktrees may have separate writers; one owner integrates them and controls each deployment environment, vendor connection, project setting, or Brain write lane. Serialize conflicting writes.

Recursive delegation requires explicit conductor authorization, a stated sub-budget and deadline, and remaining global capacity. A child reports its child count before spawning. Flat delegation is the normal route.

Select and invoke relevant available plugins, skills, and tools proactively when they help the authorized task. Discover their actual callable surface cheaply, honor their required startup and provider approval gates, and avoid redundant discovery or invoking unrelated plugins. Missing tools confer no authority to guess action names or switch identities. No automatic paid fallback, permission expansion, credential creation, or new production deployment authority follows from this policy.

When configuring larger fleets, separate sessions, or cross-runtime execution, read [execution adapters](references/execution-adapters.md). The reference provides current Codex launch guidance, surface distinctions, a proposed cloud runner contract, and acceptance gates.

## 3. Assign useful workers

For each assignment, provide:

1. `worker_id`, parent, and one-line objective;
2. exact in-scope resources and explicit out-of-scope resources;
3. pass/fail criteria and required readbacks;
4. model and reasoning setting, preserved unless the parent changes it;
5. time and usage budget, maximum attempts, and stop condition;
6. mutation owner, idempotency key, rollback path, and secret/data rules;
7. return format: changed state, evidence IDs, blockers, and next action.

### Time limits and active supervision

Every assignment must record `started_at_utc`, `deadline_utc`, `next_check_at_utc`, a usage cap, and a named conductor. Use the parent-approved budget when supplied. Otherwise use these planning defaults, shortening them to fit the remaining parent window:

The assignment clock starts when the worker receives and begins the assigned stage, not when it later submits a provider job. Record provider request/start/end times separately. Setup, validation, approvals and waiting do not postpone or reset the assignment clock.

| Work package | Initial wall-clock cap | Required progress checkpoint |
| --- | --- | --- |
| Bounded inspection or reconciliation | 10 minutes | By minute 5 |
| One implementation plus its focused tests | 20 minutes | By minute 5, then at most every 5 minutes |
| External job, release or migration stage | 30 minutes | By minute 5, then provider-appropriate checks at most 5 minutes apart |

These are supervision deadlines, not invented provider timeouts or promises of completion. A known long-running provider job may need a different explicit cap. Count waiting, approvals and tool latency against the assignment's wall clock; record whether usage is observable rather than inventing a token limit. Save the last verified state before a cap expires. Do not silently extend the deadline or begin a second deliverable. An extension requires a conductor decision with one next action, a new exact deadline, remaining budget and reason; it does not restore exhausted attempt or permission limits.

If an active assignment lacks its original start or deadline, mark its cap unverified and reconstruct it once from authoritative assignment metadata. Do not reset its clock by assumption; the remaining parent window is still a hard supervisory ceiling. Distinguish a confirmed submission with a currently observed live job, which may be `in_progress`, from an unconfirmed submission or lost/conflicting outcome, which is `unknown`. Missing final readback alone does not make a normal acknowledged running job stalled. The live handle supports bounded supervision, never completion, retry or a second writer without reconciliation.

A worker must ask the conductor for help at the first applicable condition: missing authority or tool binding, an unknown write result, two bounded attempts exhausted, five minutes without a verifiable milestone and no authoritative live job, or its progress/deadline checkpoint cannot be met. A planned step or repeated status message is not a milestone. Return a compact `HELP_NEEDED` packet: objective, worker/job handle, last verified state and evidence ID, exact sanitized error, attempts/time/usage consumed, unchanged or unknown mutations, and the smallest requested help. Do not paste full transcripts, secrets or protected sources. If no messaging tool exists, return that packet in the worker's result; do not pretend an alert was delivered.

The conductor owns a task-list row for every worker: objective, owner, handle, deadline, next check, last milestone, state, attempts and usage, help needed, and next action. Use actual live status at the due check. Reply to help with a bounded diagnosis, authorized reassignment, a justified extension, or an explicit stop/blocker, not merely "keep trying." If the conductor cannot supervise before the deadline, do not dispatch the worker. Do not use the product's native goal-blocked threshold as permission to let an individual stalled worker loop indefinitely.

Coordinator failure does not cancel children or release the global worker slots. If the conductor stops, hits model capacity, or loses its connection, workers still honor their original deadlines. Save the last verified milestone and return HELP_NEEDED through an available supported channel; do not wait indefinitely for a reply, spawn a rescue worker, or extend your own clock. A recovering conductor reconciles existing child handles and external jobs before assigning replacements. Model capacity is a routing problem, not permission to buy capacity or switch to an unauthorized provider.

The task-list row must name the next decision and its due time, not just a poll interval. Close terminal assignments after preserving their evidence; do not repeatedly wake completed workers for unchanged status. A coordinator without a persistent supervisor must say so: these instructions are agent behavior, not an installed watchdog, timer service, or guarantee of background execution. When usage is observable, stop at the lower of the approved usage cap and deadline; otherwise record usage as unobservable and enforce the wall-clock and attempt limits.

At an expired cap, interrupt the worker through the supported control when safe, preserve its evidence, and reconcile any external operation before retrying or starting a replacement. Interrupting an agent is not proof its provider job stopped. Cancel an external job only when authorized and supported; if cancellation or current state cannot be confirmed, mark it `unknown`, freeze conflicting writes and escalate. Approval-waiting workers free no mutation ownership until reconciled. Never bypass a rejected action or assign a second writer as a rescue.

An expired stage is closed history, not a fresh clock. After its exact writes are reconciled, the conductor may authorize one new bounded stage within existing human authority only when changed evidence supports a concrete next action. Record the prior failure, new actual start/deadline, remaining parent budget and cumulative attempt counts. A new stage does not replenish exhausted attempts, override a provider rejection, or confer permission. A known pre-dispatch request-validation defect can support one scoped correction; an unknown submission cannot.

Follow up on actual progress, not intended work. Ask for the last authoritative state change, evidence, and next bounded action. Do not repeatedly request catalogues, wake calls, or unchanged status. Poll only a live handle, job, session, or operation, with increasing intervals and bounded waits that preserve user updates. An observation timeout is not completion or failure; reconcile state before retrying. A missing function proves a caller binding gap, not a gateway outage. Check tool availability on its actual exposed surface, not only a catalog from a different tool namespace.

## 4. Project-linked chats and cloud execution

Before a project mutation, resolve the named destination product/provider and exact project ID. Preserve the requested model and reasoning choice where the product exposes them. A prompt requesting a model is not proof of selection, and changing the setting does not change the model used by an earlier turn.

Distinguish these operations:

- A new project-linked chat is a new conversation created in an explicitly named project. It is allowed only when the user explicitly asks for a new task or chat. Record its project ID, chat ID, seat identity, and cloud host.
- Remote execution is an agent or Work task actually running on the cloud host. A project name, connected repository, model label, catalog listing, or renamed chat does not prove remote execution.
- Reassignment is valid only when the product exposes a supported move or continuity operation and the destination readback proves the original chat and files remain intact.

When the platform cannot move an existing chat, create a clearly labeled successor only after preserving the source. Carry forward only approved non-sensitive context and an opaque continuity ID. Never delete the source until destination continuity and restore are independently verified. Record whether the successor is Chat, Work/Codex, or another runtime; never conflate them.

For cloud Work, verify the actual host, operating system or runtime, working directory, seat identity, project/environment binding, and one harmless synthetic marker with an independent readback. For ordinary Chat, invoke the target seat directly and read back its identity, tools, memory boundary, and a scoped synthetic operation. A backend, gateway, Make scenario, or another seat's result proves none of these by itself.

Keep environment-setup acceptance separate from normal coding-task acceptance. A setup draft with clean repository paths and a marker proves that draft's cloud workspace, not a successfully submitted coding task or its own-seat bindings. Use authoritative host metadata rather than a local-looking browser URL. When a launch returns an error without a task handle, preserve its intent and sanitize the error, reconcile the exact task state, and stop new submissions until supported repair or changed evidence justifies another attempt. Do not change repositories or republish unchanged settings on speculation.

## 5. Tool access and writes

A tool catalogue is availability only. For every required integration, prove the exact target seat and operation with the narrowest safe test:

- read capability: a permitted metadata/read call and source or receipt ID;
- write capability: a synthetic, reversible, non-customer write followed by exact readback and cleanup when approved;
- production capability: provider scope, seat authorization, durable receipt, and monitoring.

Keep high-risk operations behind their provider approval and dry-run gates. Do not infer administrator scope from a successful synthetic test. Do not replay a rejected permission, test, release, or deployment through another route. Stop that path and report the concrete gate.

## 6. Security and protected rings

Keep PHI, attorney-privileged personal legal material, credentials, secret values, and material non-public information in their authorized rings. Never copy them into shared prompts, repositories, logs, public search, company Brain, or another seat. Secret names and opaque receipt IDs are acceptable; secret values are not.

Do not broaden permissions, change vendor security settings, mint credentials, redeem usage resets, buy capacity, use paid API fallback, send messages, place calls, or deploy production changes unless the user explicitly authorizes that exact action and the platform's own approval gates permit it. User authority does not bypass product, owner, legal, or safety controls.

Preserve protected CLO Personal isolation and its own storage, memory, identity, and restore gates. COO, CTO, and other company seats must not read or write Personal material. Preserve no-PHI requirements even when a user asks for every tool.

## 7. Grounding, memory, and checkpoints

Follow the active seat's startup and grounding protocol before company assertions. Use the matching seat's Brain, not another seat's recall. Save minimal, reusable, non-sensitive findings: objective, verified state, opaque IDs, evidence locations, and the next gate. Preserve full authorized source reports and test artifacts in their proper source-owned archive when required; a short checkpoint does not replace raw evidence. Confirm that a Brain write returned stored and indexed IDs and independently retrieve the record before calling persistence complete. If semantic recall is stale, use supported exact own-seat record retrieval and report the freshness gap. Never save PHI, privileged source text, secret values, or unsupported claims.

At phase boundaries, reconcile the ledger against live state. Record completed, incomplete, blocked, and unverified separately. A green CI check, scheduler event, deployment response, connector listing, or project rename is not end-to-end acceptance without runtime readback.

## 8. Bounded troubleshooting

For each hypothesis, allow one focused diagnosis and at most two bounded implementation or verification attempts. Classify a mutation with no confirmed result as `unknown`, freeze conflicting writes and cleanup, and reconcile the exact target before retrying. Check its status using the same provider idempotency key where supported; otherwise use the recorded intent ID, pre-write state, and supported current-state readback. After an error, preserve the best verified state and inspect the exact returned reason. Do not switch credentials, identities, repositories, or tool routes to evade a rejection.

Before a provider mutation, cheaply validate known request-schema limits and fixed-target fields against its supported contract. A validation error is not by itself proof that nothing ran; require a provider receipt or exact state reconciliation. If rejection before dispatch is confirmed, correct only the defective field under the remaining time and attempt budget. For example, AWS Systems Manager SendCommand's Comment is limited to 100 characters. Keep such descriptions short and source-free, not copied task histories.

Evaluate errors in the actual supported execution context. A restricted shell's missing home/configuration directory does not establish that the account is signed out. One authorized read-only check in the normal user context may distinguish that seam; never copy credentials or override system home variables as a speculative repair. For content-minimizing tools, verify both success and failure contracts: a missing provider collection is not a genuine empty result, and a numeric projector does not sanitize upstream errors. Test the actual provider/helper seam, fixed errors, caller restrictions and request bounds with synthetic data before claiming source acceptance.

If a worker stalls, reconcile its authoritative handle, then either follow up with one concrete next action or close it with a blocker. Do not leave duplicate workers running. If the same genuine blocker repeats across three goal turns and no safe in-scope action remains, escalate it as blocked while keeping unrelated work moving.

### Improve the skill from demonstrated use

Workers propose source-free learning notes to the conductor; they do not concurrently edit the shared skill. Each note needs the observed failure or gain, exact technical evidence, affected runtime, proposed narrow correction, and expected cost/quality effect. The conductor batches justified corrections, removes superseded duplication, tests the changed decision behavior, and publishes one versioned update through the supported owner workflow. Keep plugin identity, audience, default prompts and integrations unchanged unless separately authorized. Reconcile an uncertain or conflicting release before another publish. Save the note as pending if the source/update tool is unavailable; do not claim deployment or universal hot reload.

For relevant demonstrated migration/runtime cases, read [operating lessons](references/operating-lessons.md). Read this reference when maintaining SWARM or when a listed binding, cloud-isolation or UI-progress case recurs. General delegation does not require loading historical notes.

## 9. Distribute and verify the skill

For "all agents," enumerate the in-scope seats and each requested Chat, Work, Codex, and cloud surface. Record the skill version/hash, distribution mechanism, installed release ID, and per-target readback. Do not infer all-seat installation from a shared project, package upload, local file copy, or one successful invocation.

Choose the supported route for the target: local/repository skill discovery for that runtime, a skills-only private plugin for Chat and Work account distribution, or a repository-contained skill for a cloud environment. Do not assume laptop personal skills automatically sync to cloud environments. Preserve the selected package's identity, audience, current-release guard, and integrations. A coordination skill needs no new credentials or vendor grants.

Separate authored, validated, packaged, saved, installed, discoverable, and invoked. After installation, ask each target to directly load/invoke the expected skill, report its release or content evidence when exposed, perform a bounded harmless coordination exercise, and checkpoint its own authorized Brain. Record unavailable host observability as unverified rather than asking the agent to pretend it knows its installed version.

## 10. Completion and source cleanup

The conductor may claim completion only after independently checking every requirement against current authoritative evidence. The evidence must prove actual execution, identity, scope, continuity, read/write result, cloud location, and isolation at the same scope as the claim. Report remaining gates plainly. Do not convert “planned,” “connected,” “listed,” “green,” “started,” or “no error observed” into “complete.”

Keep tool exposure, successful read, synthetic write/readback, and provider administrator scope as separate acceptance levels. Before deleting a source, independently verify the complete destination inventory, original chat IDs or continuity mapping, file/source preservation, and accepted restore/runtime evidence. Resolve any `unknown` mutations first. Delete only exact user-authorized targets through a supported recoverable operation where available. Follow the host's confirmation policy for irreversible deletion, including action-time confirmation when required. Retain deletion receipts and post-action source listing plus destination continuity readback; an empty folder alone is not proof of preserved data.

End each phase with a compact receipt: run ID, workers used, state changes, evidence IDs, unresolved gates, and exact next action. Then checkpoint the parent seat using its required protocol.
