# AIOS B04 bounded reliability fixes

This source release fixes two reproduced issues without changing credentials, retry counts, schedules, workload ownership, or business data.

The schedule classifier excludes only the exact `_autorestart_state` control key from workload classification. Raw heartbeat rows are unchanged. `p0-selftest` and other unknown names, including underscore-prefixed workload names, still appear as findings. The focused regression was red before the change, and the schedule-canary suite passed 35/35 afterward. Applying this classifier to the previous sentinel facts would reduce 19 attention rows to 18; that is an offline classification comparison, not a fresh live-monitor result.

The Developer cloud OAuth client supplies the missing safe label to the existing token-exchange transport error. Synthetic tests cover revoked and missing refresh credentials, wrong-seat responses, lost refresh responses, and a fresh module reading the durable session. The focused suite passed 18/18; independent refusal/lost-response controls passed. There is no automatic replay of an uncertain protected tool call or fallback to another identity.

Independent review accepted both narrow source changes. Required remote CI and exact-head merge are separate release receipts. An enrolled Developer client must use this source revision through its own supported route; this package does not refresh the native app cache or sign into the separate interactive AWS Core connection. No live enrollment, provider rerun, backup restore or token rotation was used as a test.

Rollback: revert these additive source changes through the normal reviewed release path. Preserve heartbeat objects and durable session records; do not erase unknown workload evidence or delete unrelated caches.
