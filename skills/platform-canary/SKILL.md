---
name: platform-canary
description: The fleet's PER-LANE / PER-PLATFORM GATEWAY HEALTH CANARY. For every lane on the MCP gateway it asserts that a token mints, that the advertised tool count is ABOVE that lane's floor (catching the connector-surface misclassification whose signature is a privileged lane offered ~11 tools instead of ~1000), that connector_surface is false for privileged lanes, that the gateway resolves the credential to that lane's own identity, and that brain_search returns EXACTLY the expected room set, both that expected rooms are PRESENT and that forbidden rooms are ABSENT. The personal-legal assertion (legal-personal and legal-personal-memory visible to clo-personal and exec ONLY) is the load-bearing one and carries P0 severity, with clo-personal acting as the positive control so the allow path is proven too. It then asserts the shared exec ledger is readable AND non-trivial, a floor on entry count and on distinct agent lanes, because shared_entry_count=1 was the exact 2026-08-17/18 misrouted-bucket incident and a canary that would not have caught it is not worth writing. Finally it checks the credential-free platform surfaces, the gateway /health registry floor, the unauthenticated front door still refusing with a WWW-Authenticate pointer, a forged M365 static token still refused, and both OAuth discovery documents. It also asserts the ledger is FRESH and not merely large (a frozen-but-readable ledger passes every size floor forever), that a broad query against an open room returns results at all (a room that resolves with zero hits still appears in every lane's rooms_searched), that retrieval is still running in HYBRID and not silently degraded to keyword-only by a dead embeddings credential, and that the run itself COVERED enough lanes, rings and blocks to be worth believing. Strictly READ-ONLY (a runtime allowlist refuses any tool outside brain_search/catalog_probe/memory_team/kb_search) and it NEVER prints privileged content, room names, counts and allow/deny outcomes only. Exits 1 on a failed assertion, 2 when it is BLIND (a check could not run at all) and 3 when COVERAGE IS REDUCED (all healthy, but too little was checked), three distinct loud outcomes because they demand different responses; --report forces exit 0 for a safe manual run and --fixture evaluates a recorded observation set offline with no network, no credentials and no telemetry emit. Config-driven via expected-lanes.json, emits a platform_canary PostHog event, and is scheduled every 6h by .github/workflows/platform-canary.yml.
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
| `ring` | a forbidden room is present. **P0** when it is a personal-legal room. **UNCONDITIONAL** |
| `room_set_registry_drift` | the registry says `expects_brain_search:false` but the lane searched rooms anyway |

Then the shared ledger (`ledger_entry_floor`, `ledger_agent_floor`, `ledger_freshness`), retrieval
health (`room_results`, `retrieval_mode`), the credential-free platform surfaces (`gateway_health`,
`unauthenticated_mcp_refused`, `forged_m365_token_refused`, and both OAuth discovery documents), and
finally coverage (`coverage_lanes`, `coverage_ring`, `coverage_ledger`, `coverage_retrieval`).

**The forbidden-room half of the ring check is UNCONDITIONAL and no config can switch it off.** Round 1
branched around the whole room-set assertion when a lane declared `expects_brain_search:false` and
emitted a SKIP, and SKIPs do not affect the exit code -- so one config line (already set on `cro` and
`cpo`) silently deleted the P0 ring assertion for that lane, and an observation with `legal-personal` in
a `cro` room set PASSED. `expects_brain_search` now governs only the expected-PRESENT half. A locking
test iterates every non-ring lane in the shipped registry, forces the flag false, and requires a P0
every time, so the two halves can never be re-coupled.

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
                                                [--no-ledger] [--no-retrieval] [--no-platforms]
                                                [--fixture <file>]
```
- default: exits **1** on a failed assertion, **2** when BLIND, **3** when COVERAGE IS REDUCED, **0**
  when clean and sufficiently covered.
- `--report`: forces exit 0. Safe for a manual look; anomalies still print and still emit.
- `--fixture <file>`: evaluate a recorded observation set offline. No network, no credentials. This is
  how the incident reproduction is demonstrated:
  ```
  node platform-canary.mjs --fixture fixtures/incident-2026-08-17-shared-ledger.json   # exits 1
  node platform-canary.mjs --fixture fixtures/healthy.json                              # exits 0
  ```
- `--lanes`: restrict to named lanes. **A filter that matches nothing no longer produces a pass**: the
  coverage floors below turn such a run into exit 3. The workflow no longer narrows itself when lane
  credentials are missing, for exactly that reason.

## The governing rule
**There is no configuration, credential state, or environment under which this canary exits 0 while a
lane, a ring, or the ledger went unchecked.** Silence is impossible; reduced coverage is loud. The rule
is written at the top of `assertions.mjs` so the next person cannot quietly re-introduce a skip.

## Exit codes: "broken", "blind" and "only looked at a corner" are three different facts
`0` everything that ran passed AND coverage was sufficient. `1` an assertion FAILED, something is
provably broken. `2` the canary could not run a check at all, so it proved nothing about that check.
`3` everything checked was healthy but the run covered too little for the green to mean anything.
All three non-zero states are loud and carry different messages, because they say fix the system / fix
the sensor / distrust this result. A run that evaluates nothing exits 2, never 0. Precedence is
failure > blindness > reduced coverage, in order of how actionable each is.

### Why exit 3 exists
When the AWS secret-store credentials were absent, round 1's workflow appended `--lanes __unarmed__
--no-ledger`. No lane matched, the ledger block was dropped, and the run evaluated only the five
credential-free platform surfaces, found them healthy, and **exited 0**. Every six hours, forever, it
would have reported OK while checking neither a lane, nor a ring, nor the ledger -- the precise failure
class it was built to detect, wearing a green light. `assertCoverage()` makes that structurally
impossible: floors on lanes evaluated, on ring assertions actually EXECUTED, and on the ledger and
retrieval blocks having run at all.

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
  `connector-surface-misclassification.json`, plus the round-2 locks:
  `blocker1-probe-real-nested-shape.json` (the RAW catalog_probe payload copied from a live call, which
  pins the identity accessor to the wire shape rather than to anyone's description of it),
  `blocker2-cro-ring-violation-expects-brain-search-false.json` (the config line that used to delete the
  ring assertion), `blocker3-unarmed-platform-only.json` (the run that used to exit 0 having checked
  nothing), `gap1-ledger-frozen-but-large.json`, `gap2-3-retrieval-degraded.json`.

## Reused, not duplicated
The pure-classifier + pure-exit-code + config-registry + PostHog-emit + fail-loud shape mirrors
`skills/azure-canary/canary.mjs` (`assessFreshness`/`pageExitCode`/`probeLane`) and
`skills/continuity-canary/continuity-canary.mjs` (`assessDocFreshness`/`pageExitCode`) directly, and the
registry file follows the `setup/expected-indexes.json` / `setup/expected-streams.json` /
`expected-docs.json` convention. The ABSENCE-is-also-an-alarm principle those encode is carried here in
three ways: a check that could not run is an ERROR verdict rather than silence, the ledger is asserted
on content and on AGE rather than on the call succeeding, and a run that covered too little is its own
outcome class rather than a pass.

**This canary is NOT currently self-monitored, and round 1 said otherwise.** The claim was that the
workflow's heartbeat step feeds `setup/heartbeat-registry.json`'s `platform-canary` entry so
`skills/nightly-schedule-canary` pages if this canary's cron goes silent. The registry entry does exist,
but `setup/heartbeat.mjs` writes EXCLUSIVELY to Azure Blob using Key Vault credentials, and that
subscription is deleted -- so the beat exits 78 before writing, `schedule-canary.mjs` reads the same dead
store, and the workflow's `|| true` hides all of it. The step is kept (it arms itself the moment a
working backend exists) but the claim is withdrawn: an untrue statement that something is monitored is
worse than no monitoring, because it stops anyone from looking. **To close it: port `heartbeat.mjs`'s
storage layer to S3, then restore the claim, and not before.**

## Scheduling
`.github/workflows/platform-canary.yml`, every 6h (a ring widening is a live exposure; a 24h detection
window is too long for it). The workflow unit-tests the assertion core BEFORE trusting its verdict, so a
regressed classifier cannot report green from broken logic.

**Arming the lane half (one-time):** lane credentials resolve through `kvSecret()`, which since the
Azure subscription deletion reaches the store via its AWS SSM path. That needs `OTC_AWS_ACCESS_KEY_ID`
and `OTC_AWS_SECRET_ACCESS_KEY` as repo secrets. **Until they exist this workflow pages every 6 hours,
deliberately.** Round 1 avoided that by narrowing the run to the platform half, which made an unarmed
canary report OK -- a worse outcome than an alert storm, because an alert storm is annoying while a
monitor that manufactures confidence is dangerous. The narrowing is gone: required lanes without a
credential report ERROR (exit 2) and the coverage floor reports REDUCED (exit 3), each with its own
message. If the noise is genuinely unacceptable before the secrets land, DISABLE THE SCHEDULE -- an
absent canary is at least honestly absent -- but never re-introduce a filter that turns "checked
nothing" back into "OK". Provision the two secrets and the lane half arms itself with no code change.
