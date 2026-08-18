---
name: platform-canary
description: The fleet's PER-LANE / PER-PLATFORM GATEWAY HEALTH CANARY. For every lane on the MCP gateway it asserts that a token mints, that the advertised tool count is ABOVE that lane's floor (catching the connector-surface misclassification whose signature is a privileged lane offered ~11 tools instead of ~1000), that connector_surface is false for privileged lanes, that the gateway resolves the credential to that lane's own identity, and that brain_search returns EXACTLY the expected room set, both that expected rooms are PRESENT and that forbidden rooms are ABSENT. The personal-legal assertion (legal-personal and legal-personal-memory visible to clo-personal and exec ONLY) is the load-bearing one and carries P0 severity, with clo-personal acting as the positive control so the allow path is proven too. It then asserts the shared exec ledger is readable AND non-trivial, a floor on entry count and on distinct agent lanes, because shared_entry_count=1 was the exact 2026-08-17/18 misrouted-bucket incident and a canary that would not have caught it is not worth writing. Finally it checks the credential-free platform surfaces, the gateway /health registry floor, the unauthenticated front door still refusing with a WWW-Authenticate pointer, a forged M365 static token still refused, and both OAuth discovery documents. Strictly READ-ONLY (a runtime allowlist refuses any tool outside brain_search/catalog_probe/memory_team) and it NEVER prints privileged content, room names, counts and allow/deny outcomes only. Exits 1 on a failed assertion and 2 when it is BLIND (a check could not run at all), two distinct loud outcomes because they demand different responses; --report forces exit 0 for a safe manual run and --fixture evaluates a recorded observation set offline with no network and no credentials. Config-driven via expected-lanes.json, emits a platform_canary PostHog event, and is scheduled every 6h by .github/workflows/platform-canary.yml.
---

# platform-canary -- make a silent gateway break impossible to miss

## Why this exists
The fleet already watches search-index freshness, scheduled-job liveness, telemetry streams and
continuity docs. It has never watched the thing every AI seat actually runs on: the gateway's per-lane
behaviour. A one-time sweep proves that for one minute and is worthless the next day.

Four real failure shapes drove the design. None is hypothetical.

1. **Connector-surface misclassification.** A privileged lane whose credential is bound to a
   connector-style client is handed the 11-tool `EXTERNAL_READONLY_TOOLSET` instead of its ~1000-tool
   catalog. Nothing errors. Every call the seat can still make succeeds. The seat is simply, drastically
   less capable and nobody notices, which is what happened to the CRO seat via `occ_cro_*`.
2. **Ring widening.** `legal-personal` and `legal-personal-memory` hold attorney-privileged personal
   legal material including a live California family-law matter involving minors. The ring is
   `clo-personal` and `exec` only. This was a live P0 leak on the cfo lane until 2026-07-16 and has had
   no continuous sensor since.
3. **A silently empty shared ledger.** On 2026-08-17/18 gateway commit `c72dd3b` read the commons brain
   from bucket `otchealth-finance-legal-dr` instead of `otchealth-brain-dr` and found one stray 725-byte
   `cto.jsonl`, so every lane on every platform saw `shared_entry_count=1` while the real ~29-lane
   history sat intact and untouched at the correct bucket. HTTP 200. Well-formed JSON. No error anywhere.
4. **A front door that stops refusing.** The unauthenticated path and the M365 query-parameter static
   token path must keep answering 401.

Shapes 1 and 3 share the property that makes them dangerous: **the system reports success while
producing the wrong answer.** Neither is visible to any check that asks only "did the call work". That
is why this canary asserts floors on the CONTENT of a successful response, not merely on its status.

## What it asserts

Per lane, from `expected-lanes.json`:

| Check | Fails when |
|---|---|
| `token_mint` | creds exist but the mint fails. Absent creds are SKIP for an optional lane, ERROR (blind) for a required one |
| `tool_floor` | the advertised `tools/list` count is below that lane's floor |
| `connector_surface` | a client_credentials lane is classified as a connector surface |
| `caller_agent` | the gateway resolves the credential to a different lane (P0: a cross-wired credential makes both lanes' ring assertions meaningless) |
| `room_set` | an expected room is absent from `rooms_searched` |
| `ring` | a forbidden room is present. **P0** when it is a personal-legal room |

Then the shared ledger (`ledger_entry_floor`, `ledger_agent_floor`) and the credential-free platform
surfaces (`gateway_health`, `unauthenticated_mcp_refused`, `forged_m365_token_refused`, and both OAuth
discovery documents).

**The forbidden-room set is derived from policy, not declared per lane.** `forbiddenRoomsFor()` adds
`personal_legal_rooms` to every lane automatically unless that lane is named in `personal_legal_ring`,
so a newly added lane is born forbidden and must be explicitly admitted. Forgetting to write a
`forbidden_rooms` entry can never silently create an unwatched lane.

**`clo-personal` is the positive control.** A ring check that only asserts absence would still go green
if the personal rooms vanished from the estate entirely, a different outage wearing the same green
light. `clo-personal` asserts they are PRESENT, so the allow path is proven on every run.

## Run
```
node skills/platform-canary/platform-canary.mjs [--report] [--json] [--lanes a,b]
                                                [--no-ledger] [--no-platforms] [--fixture <file>]
```
- default: exits **1** on a failed assertion, **2** when BLIND, **0** when clean.
- `--report`: forces exit 0. Safe for a manual look; anomalies still print and still emit.
- `--fixture <file>`: evaluate a recorded observation set offline. No network, no credentials. This is
  how the incident reproduction is demonstrated:
  ```
  node platform-canary.mjs --fixture fixtures/incident-2026-08-17-shared-ledger.json   # exits 1
  node platform-canary.mjs --fixture fixtures/healthy.json                              # exits 0
  ```
- `--lanes`: restrict to named lanes. Passing a name that matches nothing runs the credential-free
  platform half alone, which is what the workflow does when lane credentials are not provisioned.

## Exit codes: "broken" and "blind" are different facts
`0` everything that ran, passed. `1` an assertion FAILED, something is provably broken. `2` the canary
could not run a check at all, so it has proven nothing. Both non-zero states are loud and carry
different messages, because one says fix the system and the other says fix the sensor. A run that
evaluates nothing exits 2, never 0: an empty run must never look like a pass. A proven failure outranks
blindness (exit 1 wins) because there is something concrete to act on.

## Safety properties
- **Read-only by construction.** `ALLOWED_TOOLS` is enforced inside `callTool()` at runtime, so a later
  edit cannot casually introduce a mutating call. It never writes a memory, checkpoints, or dispatches.
- **No privileged content ever leaves it.** Only response ENVELOPES are read: room NAMES, counts,
  identity echoes, HTTP status codes. `brain_search` results and `memory_team` entry text are never read
  into a variable that is printed, logged, or emitted. Verdicts land in CI logs and PostHog, and a canary
  that leaks attorney-privileged text into a build log is worse than no canary.
- **Secrets by name only.** Credentials are resolved through the shared `kvSecret()` chain and are never
  printed, never written to a file, and never appear in a verdict message.

## Files
- `assertions.mjs` -- the PURE classifier. Zero imports, zero I/O, so the whole thing is testable
  against fixtures with no network. This is what `tests/platform-canary.test.mjs` imports.
- `platform-canary.mjs` -- the runner. Does all the talking to the world, decides nothing.
- `expected-lanes.json` -- the registry: lanes, floors, expected/forbidden rooms, ring policy, ledger
  floors, platform surfaces. Add a lane row to start watching a lane.
- `fixtures/` -- `healthy.json` (control), `incident-2026-08-17-shared-ledger.json` (the regression
  lock; every lane block in it is byte-identical to the control, which is exactly why a lane-only canary
  would have gone green through the incident), `ring-violation-cfo-personal-legal.json`,
  `connector-surface-misclassification.json`.

## Reused, not duplicated
The pure-classifier + pure-exit-code + config-registry + PostHog-emit + fail-loud shape mirrors
`skills/azure-canary/canary.mjs` (`assessFreshness`/`pageExitCode`/`probeLane`) and
`skills/continuity-canary/continuity-canary.mjs` (`assessDocFreshness`/`pageExitCode`) directly, and the
registry file follows the `setup/expected-indexes.json` / `setup/expected-streams.json` /
`expected-docs.json` convention. The ABSENCE-is-also-an-alarm principle those encode is carried here in
three ways: a check that could not run is an ERROR verdict rather than silence, the ledger is asserted
on content rather than on the call succeeding, and the workflow beats
`setup/heartbeat-registry.json`'s `platform-canary` entry unconditionally so
`skills/nightly-schedule-canary` pages if this canary's own cron ever goes quiet. The monitor is itself
monitored.

## Scheduling
`.github/workflows/platform-canary.yml`, every 6h (a ring widening is a live exposure; a 24h detection
window is too long for it). The workflow unit-tests the assertion core BEFORE trusting its verdict, so a
regressed classifier cannot report green from broken logic.

**Arming the lane half (one-time):** lane credentials resolve through `kvSecret()`, which since the
Azure subscription deletion reaches the store via its AWS SSM path. That needs `OTC_AWS_ACCESS_KEY_ID`
and `OTC_AWS_SECRET_ACCESS_KEY` as repo secrets. Until they exist the workflow deliberately runs the
credential-free platform half only and says so loudly, rather than paging every 6 hours with an
identical unactionable "cannot reach the secret store" -- the `azure-watchdog.yml` lesson that a monitor
which always fails is an alert storm, not a detection. Provision the two secrets and the lane half arms
itself on the next run with no code change.
