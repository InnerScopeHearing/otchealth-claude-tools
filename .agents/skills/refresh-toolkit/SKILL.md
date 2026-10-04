---
name: refresh-toolkit
description: Diagnose stale tool, plugin and skill bindings, perform supported refreshes in the affected client, and verify the resulting version and invocation. Use after a missing action, loader error or published-versus-loaded mismatch.
---

# Refresh Toolkit

Run automatically when an actual task hits stale-binding evidence. Capture the affected client, session, seat, expected capability and exact sanitized error. Use its currently callable tools and reader, rather than a teammate's catalog. Refresh only the affected integration; “all tools” means inventory relevant differences, not reconnect every account or repeat every vendor operation.

Separate published, installed, discovered, loaded and exercised state. A source upload or refreshed backend catalog cannot replace a live client's binding. Resolve catalog-provided full skill package/resource identifiers before concluding a file is missing.

Classify the failure before acting:

| Evidence | Action |
| --- | --- |
| New release, older loaded source or missing expected action | Use the client's exposed supported update/Refresh control, then reread its catalog and exact skill resources. |
| Loader error in an active owned package | Repair its verified source, independently test, version/publish, then refresh and invoke in the affected client. |
| Retired package still enabled | Remove or disable the exact user-retired package through that product's supported control; verify effective configuration and loader results. Do not develop it as an active integration. |
| OAuth or provider authorization error | Preserve the exact error and use the existing intended account's supported authentication flow when authorized. |
| Approval required with policy `never` | Record a host execution-policy block. App “Allow all actions” does not prove permission in this task; do not replay the action through another route. |
| Unconfirmed write | Reconcile that intent before refresh/restart or retry; preserve ownership and its current handle. |

Perform a refresh automatically only when the actual control is exposed, authorized and safe for this session's pending work. Discover the control and its schema; never invent a reload action, call internal appserver endpoints, edit immutable caches, or modify security policy to force the operation. A refresh instruction skill cannot grant itself a host control. If the control is absent, finish the source repair and identify the one exact owner action; do not claim automatic refresh occurred. Before discretionary source repair, record the baseline, primary outcome, usage/spend budget and acceptance test; use a binary working test for a missing capability and preserve the best state when its bounded lane cannot proceed.

For OTCHealth ordinary Chat with a required missing/failed direct tool, use the matching app's Settings **Refresh once**, then rerun the catalog in that same Chat, as project instructions require. Do not reconnect or switch seats. Another agent or Work session can prepare a handoff but cannot accept that Chat. Read [client controls](references/client-controls.md) for Chat, Codex and cloud distinctions.

After the supported operation, compare before/after at the same target. Directly load the required skill and its references and perform one harmless invocation or permitted metadata read. Record the observed revision and outcome. A fresh conversation or restart is a successor with a preserved handoff, not an in-place refresh; use it only when requested or authorized and after reconciling writes. No blanket administrator proof follows.

Use [the metadata classifier](scripts/classify-toolkit.ps1) when a repeatable snapshot decision is useful. It accepts sanitized evidence JSON and returns diagnosis only; it performs no network request, reload or permission change. Keep one focused diagnosis and at most two bounded repair attempts per failure, preserve successful work, and return exact controls still missing.
