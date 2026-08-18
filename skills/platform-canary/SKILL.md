---
name: platform-canary
description: The fleet's PER-LANE / PER-PLATFORM GATEWAY HEALTH CANARY. For every lane declared in expected-lanes.json -- and that registry is asserted COMPLETE against the gateway's own KNOWN_INTERNAL_LANES, so a lane cannot be missing without an ERROR -- it asserts that a token mints, that the advertised tool count is ABOVE that lane's floor (catching the connector-surface misclassification whose signature is a privileged lane offered ~11 tools instead of ~1000), that connector_surface is false for privileged lanes, that the gateway resolves the credential to that lane's own identity, that the expected rooms are PRESENT, and that the personal-legal RING holds (legal-personal and legal-personal-memory reachable from clo-personal and exec ONLY). The ring check is the load-bearing one, carries P0 severity, is derived from lane identity rather than from any config key, and produces a verdict for every lane on every run: for a non-member it asserts the rooms are ABSENT, for a member it asserts they are PRESENT, so the allow path is proven too. It then asserts the shared exec ledger is readable, non-trivial (a floor on entry count and on distinct agent lanes, because shared_entry_count=1 was the exact 2026-08-17/18 misrouted-bucket incident) and FRESH rather than merely large, that a broad query against an open room returns results at all, and that retrieval still runs in HYBRID and has not silently degraded to keyword-only behind a dead embeddings credential. Finally it checks the credential-free platform surfaces: the gateway /health registry floor, the unauthenticated front door still refusing with a WWW-Authenticate pointer, a forged M365 static token still refused, and both OAuth discovery documents. THE STRUCTURAL PROPERTY: the set of checks is DERIVED from lane identity and registry structure before any observation exists, so config supplies values but can never decide whether a check EXISTS; a missing required value is an ERROR rather than a comparison that quietly passes, an absent observation is a named ERROR rather than a skip, and coverage is the derived plan minus the verdicts actually produced rather than a floor anyone can edit downward. Strictly READ-ONLY (a runtime allowlist refuses any tool outside brain_search/catalog_probe/memory_team/kb_search) and it NEVER prints privileged content, room names, counts and allow/deny outcomes only. Exits 1 on a failed assertion, 2 when it is BLIND and 3 when COVERAGE IS REDUCED; --report forces exit 0 for a safe manual run and --fixture evaluates a recorded observation set offline with no network, no credentials and no telemetry emit. Config-driven via expected-lanes.json, emits a platform_canary PostHog event, and is scheduled every 6h by .github/workflows/platform-canary.yml.
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

Per lane, from `expected-lanes.json`. **All six run for every lane, every run** -- there is no
observation, config key, or command-line switch under which one of them ceases to exist.

| Check | Fails when |
|---|---|
| `token_mint` | creds exist but the mint fails (a hard FAIL on optional lanes too). Absent creds are SKIP for an optional lane, ERROR (blind) for a required one |
| `tool_floor` | the advertised `tools/list` count is below that lane's floor. An ABSENT floor is an ERROR, never a comparison |
| `connector_surface` | a client_credentials lane is classified as a connector surface. An ABSENT expectation is an ERROR, never a deleted check |
| `caller_agent` | the gateway resolves the credential to a different lane (P0: a cross-wired credential makes both lanes' ring assertions meaningless) |
| `room_set` | an expected room is absent from `rooms_searched` |
| `ring` | **P0.** For a non-member: a forbidden room is present. For a ring member: a personal-legal room is missing (the positive control) |

Then the shared ledger (`ledger_entry_floor`, `ledger_agent_floor`, `ledger_freshness`), retrieval
health (`room_results`, `retrieval_mode`), the credential-free platform surfaces (`gateway_health`,
`unauthenticated_mcp_refused`, `forged_m365_token_refused`, and both OAuth discovery documents), and
finally `coverage_plan`.

## The structural property: the check set is DERIVED, not configured

Three rounds of this canary each fixed individual silent-pass holes and each regenerated more of the
same shape. The recurring class, stated once:

> **The existence of a check was determined by data, and absent data rendered as a benign outcome.**

Four proven instances, all of which produced a green light over a real break:

- `--no-platforms` dropped all five platform observations. `evaluateRun()` continued past each absent
  one and coverage had no platform term at all, so the **P0 unauthenticated-front-door check silently
  vanished** and the run printed OK and exited 0.
- `expects_brain_search:false` made the **collector** skip `brain_search`, so the room list was never
  gathered and the classifier took a vacuous-SKIP branch. Round 2 made the forbidden half unconditional
  in the pure function and locked it with a test -- but that test supplied `roomsSearched` **populated**,
  a state the live collector could not produce with the flag set. The test blessed a fiction while a live
  P0 leak stayed invisible.
- Omitting `min_tool_count` made the floor comparison `11 < undefined` -> false, printing
  `PASS ... tool_count 11 >= floor undefined` for a lane degraded to the exact 11-tool connector
  signature this canary exists to catch. Omitting `expect_connector_surface` deleted that assertion with
  no record at all.
- The `cco` lane -- a full `EXEC_RING` member carrying finance-MNPI and company-legal privileged read --
  simply had **no row**, while this document claimed coverage of every lane on the gateway.

So the architecture is inverted on three properties rather than patched a fourth time.

**1. Checks are derived and mandatory.** `planChecks()` computes, from lane IDENTITY and the registry's
STRUCTURE alone and before any observation exists, the complete set of check ids that must produce a
verdict. Config supplies VALUES; it can never decide whether a check EXISTS. A missing required value is
an ERROR (`validateRegistry()`), and every numeric comparison in `assertions.mjs` **refuses** a
non-number outright, so `11 < undefined` can never be evaluated again. A locking test strips every
per-lane value from the registry and asserts the plan is byte-identical.

**2. An absent observation is an ERROR by construction.** `evaluateLane()` emits all six lane checks for
every lane whatever happened; when the mint fails, the downstream checks are emitted as explicit blocked
verdicts naming the cause, never omitted and never synthesised as passes. The same rule applies to the
ledger, retrieval and platform blocks. **The collector consults no config flag to decide what to
collect** -- `expects_brain_search` is deleted from the code and the registry, and `validateRegistry()`
ERRORs if anyone re-adds it. A lane that genuinely has no brain-read tool yields an honest ERROR
carrying the real reason, never a skip.

**3. Coverage is the derived plan minus what was produced.** `assertCoverage()` diffs the two sets and
names every gap individually. There is no `min_lanes_evaluated` number left for config to edit downward,
and the plan covers platform checks. The old lock test compared config to config
(`min_lanes_evaluated === required.length`), so flipping a lane to optional and lowering the floor in
one edit stayed green while removing real coverage.

**The lane roster is asserted complete.** `known_internal_lanes` mirrors the gateway's
`KNOWN_INTERNAL_LANES` (`src/config/lane-toolsets.ts`); any lane named there without a row is an ERROR.
A lane with no row is not passing, it is invisible.

**The forbidden-room set is derived from policy, not declared per lane.** `forbiddenRoomsFor()` adds
`personal_legal_rooms` to every lane automatically unless that lane is named in `personal_legal_ring`,
so a newly added lane is born forbidden and must be explicitly admitted.

**The positive control is derived from ring membership.** A ring check that only asserted absence would
still go green if the personal rooms vanished from the estate entirely -- a different outage wearing the
same green light. Ring members assert the rooms are PRESENT, so every future ring member inherits the
control automatically rather than depending on someone listing the rooms in `expected_rooms`.

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
  A fixture carries `_now`, the instant it was recorded, and fixture mode pins the clock to it. Without
  that the control fixture rots: its `newestTs` is frozen, so the same unchanged file would start failing
  the 72h ledger-freshness SLO days after it was written.
- `--lanes`: restrict which lanes are **collected**. It never narrows the PLAN, so the lanes you filtered
  out report as named blind ERRORs and the run exits non-zero -- pair it with `--report` for a targeted
  manual look. It now also works in `--fixture` mode, where it was silently ignored despite being
  documented here as a filter.

## The governing rule
**There is no configuration, credential state, command-line switch, or environment under which this
canary exits 0 while a lane, a ring, the ledger, retrieval, or a platform surface went unchecked.**
Silence is impossible. Every planned check produces a verdict; a check that could not be answered is a
named ERROR, and a planned check that somehow produced nothing at all is a named REDUCED. The rule and
the three properties that enforce it are written at the top of `assertions.mjs` so the next person
cannot quietly re-introduce a branch that returns early.

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
class it was built to detect, wearing a green light.

In practice an unarmed or narrowed run now exits **2**, because every uncollected subject emits a named
blind ERROR for each check it blocked. Exit 3 remains as the **structural backstop**: it fires when a
planned check produces no verdict at all, which is precisely how the whole class began -- a branch that
returned early, emitted nothing, and was noticed by nobody. It is the check on the checker.

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
- `expected-lanes.json` -- the registry: the gateway lane roster, lanes, floors, expected/forbidden
  rooms, ring policy, ledger floors, retrieval, platform surfaces. It supplies VALUES ONLY -- it cannot
  decide whether a check exists, and every lane row must carry `optional`, `min_tool_count`,
  `expect_connector_surface`, `expected_rooms` and `forbidden_rooms` or the run ERRORs. Adding a lane to
  the gateway means adding both a row here and an entry in `known_internal_lanes`, in the same commit.
- `fixtures/` -- `healthy.json` (control), `incident-2026-08-17-shared-ledger.json` (the regression
  lock; every lane block in it is byte-identical to the control, which is exactly why a lane-only canary
  would have gone green through the incident), `ring-violation-cfo-personal-legal.json`,
  `connector-surface-misclassification.json`, plus the round-2 locks:
  `blocker1-probe-real-nested-shape.json` (the RAW catalog_probe payload copied from a live call, which
  pins the identity accessor to the wire shape rather than to anyone's description of it),
  `blocker2-cro-ring-violation-expects-brain-search-false.json` (the config line that used to delete the
  ring assertion), `blocker3-unarmed-platform-only.json` (the run that used to exit 0 having checked
  nothing), `gap1-ledger-frozen-but-large.json`, `gap2-3-retrieval-degraded.json`. `healthy.json` and the
  incident fixture carry an observation for EVERY registry lane, including the five whose credentials are
  not provisioned (recorded honestly as `credsPresent:false`, not omitted), because the derived plan
  covers every lane and a fixture that omits lanes proves less than it appears to.

## Reused, not duplicated
The pure-classifier + pure-exit-code + config-registry + PostHog-emit + fail-loud shape mirrors
`skills/azure-canary/canary.mjs` (`assessFreshness`/`pageExitCode`/`probeLane`) and
`skills/continuity-canary/continuity-canary.mjs` (`assessDocFreshness`/`pageExitCode`) directly, and the
registry file follows the `setup/expected-indexes.json` / `setup/expected-streams.json` /
`expected-docs.json` convention. The ABSENCE-is-also-an-alarm principle those encode is carried here in
four ways: a check that could not run is an ERROR verdict rather than silence, the ledger is asserted on
content and on AGE rather than on the call succeeding, a run that covered too little is its own outcome
class rather than a pass, and the set of checks itself is derived rather than configured so a check
cannot fail to exist -- only to be answered.

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
