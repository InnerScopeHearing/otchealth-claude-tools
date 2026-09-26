---
name: device-walkthrough
description: Runs a fleet app's real-iPhone XCUITest walkthrough end to end, from building the test runner on Depot macOS through scheduling it on AWS Device Farm, fetching and classifying the results, and archiving them to app-media. AWARE, iHEARtest, and Hey Millie (otchealth-companion) each ship a qa/device-walkthrough/ XCUITest runner (a scripted "tour" through every screen plus a breadth-first crawl that presses every reachable control) and a device-walkthrough.yml GitHub Actions workflow that builds it on Depot macOS. This skill is the one command that drives the rest, the piece that has so far been done with throwaway scratch scripts. Use it whenever a session needs to build the runner, schedule it against a real device, pull the screenshots/video/coverage report back, or archive a completed run. Wielded by the CTO / App Lead agents. Non-PHI ring (screenshots of consumer-app UI only, no PHI/PII involved).
---

# device-walkthrough

Real-iPhone walkthrough testing for the fleet: AWS Device Farm's own `BUILTIN_FUZZ` test type taps
random screen coordinates and captures no screenshots, so it proves only "the app did not crash
under random taps" -- it never proves any specific button works, and it never produces a usable
screenshot set. The `qa/device-walkthrough/` XCUITest runner in each app repo is the real thing: a
scripted **tour** through every screen (a numbered screenshot per step, suitable for a presentation
or a tutorial video) plus a breadth-first **crawl** that presses every reachable control it can find,
screenshotting each step and attaching a `crawl-coverage.json` report of what it visited, skipped
(destructive/purchase/leave-app labels), and could not reach.

This skill is the one command that runs the whole pipeline: build the runner on Depot macOS, fetch
the shipped app IPA from an `ios-depot.yml` run, schedule the pairing on AWS Device Farm, pull every
result artifact back and sort it into `tour/` `crawl/` `video/`, and archive the lot through
`skills/app-media`.

## CLI

```
node skills/device-walkthrough/walkthrough.mjs <command> [--flag value ...]
```

Credentials: AWS Device Farm calls use the fleet's shared SigV4 signer
(`setup/aws-sigv4.mjs` -> `skills/kb-memory/aws-secret.mjs`'s `awsCreds()`), so
`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN` in the environment (or the ECS task
role, or the `OTC_AWS_*` sandbox-safe fallback) is picked up automatically -- the same "the way other
skills do" resolution every AWS-touching skill in this toolkit shares; there is no separate
device-walkthrough credential to provision. GitHub calls use the org GitHub App identity
(`skills/github-app/gh-app.mjs`, imported directly, 15k req/hr).

### `apps`

Prints the built-in app registry (repo, bundle id, Device Farm project/pool ARN, ios-depot IPA
artifact-name prefix) for every app this skill knows about. Currently `AWARE`, `iHEARtest`, and `HeyMillie`.

### `build-runner --app <AWARE|iHEARtest|HeyMillie> [--ref main] [--out <dir>]`

Dispatches that app's `device-walkthrough.yml` (`workflow_dispatch`, no other inputs) on `--ref`,
waits for it to complete on Depot macOS (the build job has its own 40-minute timeout), downloads the
resulting `walkthrough-runner-<sha>` artifact, and unzips it. Prints (and returns)
`{ runId, htmlUrl, runnerZip, specYml }` -- `runnerZip` is the path to `WalkthroughUITests.zip` (the
XCTest UI test package: the compiled runner `.ipa` plus `devicefarm-post-test.sh`, ready to hand to
`run --runner`), `specYml` is the path to `devicefarm-testspec.yml` (ready to hand to `run --spec`).

If the app's `device-walkthrough.yml` is not yet merged to `main`, pass `--ref <branch>` (the
workflow file only needs to exist on the ref being dispatched).

### `fetch-ipa --app <AWARE|iHEARtest|HeyMillie> --run <ios-depot GitHub Actions run id> [--out <dir>]`

Downloads that `ios-depot.yml` run's shipped-IPA artifact (`<slug>-ios-ipa-<sha>`), unzips it, unzips
the `.ipa` inside (an IPA is itself a zip), reads `Payload/*.app/Info.plist` (a binary plist -- shelled
out to python3's `plistlib`, the only bplist00 reader available in this toolchain; `plutil` is
macOS-only), and **refuses** (throws) if the IPA's `CFBundleIdentifier` does not match the app's
registered bundle id. Prints/returns `{ ipaPath, bundleId, marketingVersion, buildNumber }`.

### `run --app <AWARE|iHEARtest|HeyMillie> --ipa <path> --runner <WalkthroughUITests.zip> --spec <devicefarm-testspec.yml> [--label L] [--timeout 145] [--device-arn A] [--no-wait]`

Uploads all three (`IOS_APP` / `XCTEST_UI_TEST_PACKAGE` / `XCTEST_UI_TEST_SPEC`, each polled to
`SUCCEEDED`), schedules an `XCTEST_UI` run against the app's device pool (or, with `--device-arn`, a
single pinned device via `deviceSelectionConfiguration`), prints the run ARN, then -- unless
`--no-wait` -- polls `GetRun` every 90s until `status` reaches `COMPLETED` and prints the final run.
`--timeout` is `executionConfiguration.jobTimeoutMinutes`, default 145 (matches the fleet's proven
crawl+tour timing: a real run's crawl phase alone took ~23 minutes).

**A run reporting `deviceMinutes: 0` and every suite `PENDING` for most of its duration is NORMAL,
not stuck** -- Device Farm only starts accounting device-minutes once the job finishes. Never
`StopRun` on that basis; only the `stop` command stops a run, and only on purpose.

### `fetch --run <run ARN> --out <dir>`

Lists every job on the run (per-device; nests output under `<out>/job-N-<device>/` only when there is
more than one, otherwise writes straight into `<out>/`), lists its suites, downloads every `FILE` and
`LOG` artifact (including `Customer_Artifacts.zip` and `Video.mp4`), unzips the customer artifacts,
and sorts everything into:

- `<out>/tour/` -- the scripted-tour screenshots, cleaned of xcresulttool's `_<index>_<UUID>` suffix.
- `<out>/crawl/` -- the crawl screenshots, `crawl-coverage.json`, and `test_results.json` (renamed
  `device-test-results.json`).
- `<out>/video/Video.mp4` -- the Device Farm session recording.
- `<out>/other/` -- anything the naming convention does not recognize (e.g.
  `attachment-index.tsv`, post-test.sh's own manifest index) -- kept, never silently dropped.

Then prints a summary: the `Test Case '...' passed|failed` / `: error:` / `kept N files` lines out of
`Test_spec_output.txt`, a `crawl-coverage.json` digest (visit count, distinct screens visited,
skipped-as-denied labels, paths that left the app, unreachable count, queued-but-not-visited count),
and a syslog app-lifetime check: how many distinct process IDs the app (`App[NNNN]`, the shared
Capacitor Xcode-scheme name on every fleet app) ran under, its first/last mention, and every
CrashReporter "creating type N as .../<process>-<date>.ips" line, split into ones naming the app's own
process vs. system daemons. **A diagnostic report naming the app process is not proof of a crash by
itself** -- CrashReporter files these for spins/hangs/resource diagnostics too, not only true
crashes; treat it as a lead to investigate (cross-reference the app's last log line against the
report's timestamp), not a verdict.

Final structured summary prints to stdout as JSON; progress/log lines print to stderr.

### `archive --app <AWARE|iHEARtest|HeyMillie> --version <V> --build <B> --dir <dir from fetch> [--run-label L]`

Calls `skills/app-media/archive.mjs add` three times against the app's display name (`AWARE` /
`iHEARtest` / `Hey Millie`, matching that skill's own existing catalog naming):

| source dir | app-media `--kind` |
|---|---|
| `<dir>/tour` | `iphone-screenshots` |
| `<dir>/crawl` | `coverage-report` |
| `<dir>/video` | `iphone-video` |

with `--source` set to `--run-label` (or a generic default). A missing or empty subdirectory is
skipped, not an error. See `skills/app-media/SKILL.md` for where the files land (both Matt's OneDrive
and the fleet S3 commons store, deduped by sha256).

### `stop --run <run ARN>`

`StopRun`. Prints the resulting run object.

### `all --app <AWARE|iHEARtest|HeyMillie> --ios-run <ios-depot run id> [--ref main] [--out <dir>] [--label L] [--timeout 145] [--device-arn A]`

`build-runner` -> `fetch-ipa` -> `run` -> `fetch` -> `archive`, in order, using the fetched IPA's own
`marketingVersion`/`buildNumber` for the archive step (so the version/build in the media catalog
always matches the exact build that was actually walked, never a hand-typed guess).

## How the pieces fit together

```
device-walkthrough.yml (Depot macOS, dispatch-only)     ios-depot.yml (already ran)
        |  builds qa/device-walkthrough/                        |  built + shipped the app IPA
        v                                                        v
  walkthrough-runner-<sha> artifact                    <slug>-ios-ipa-<sha> artifact
  (WalkthroughUITests.{ipa,zip}, devicefarm-testspec.yml)  (App.ipa)
        \_______________________  build-runner / fetch-ipa  ___________________/
                                 \                          /
                                  v                        v
                              run --runner ... --spec ... --ipa ...
                                          |
                                          v
                          AWS Device Farm XCTEST_UI run (a real iPhone)
                                          |
                                          v
                                  fetch --run <arn> --out <dir>
                              tour/  crawl/  video/  other/  (+ a summary)
                                          |
                                          v
                          archive --dir <dir>  ->  skills/app-media (OneDrive + S3)
```

## Pitfalls (all verified against a real run; do not relearn these)

- **`BUILTIN_FUZZ` proves only "no crash under random taps".** It has no screenshots, no
  human-readable coverage report, and no way to prove any specific control was pressed. Do not
  substitute a fuzz run for this skill's XCTEST_UI walkthrough when the goal is screenshot capture
  or button coverage.
- **A mid-flight run reports `deviceMinutes: 0` and every suite `PENDING` for most of its
  duration.** This is Device Farm's normal behavior (it only accounts device-minutes once the job
  finishes), not a stall. `run`'s polling loop (and `df-client.mjs`'s `waitForRunCompletion`) only
  ever looks at `status === "COMPLETED"`; never add a device-minutes-based stall detector.
- **Two DIFFERENT numbering systems look similar and are not.** A syslog "creating type N as
  .../<process>.ips" line's `N` is CrashReporter's own report-bucket number, not Apple's `bug_type`
  field from inside the `.ips` content (which this skill never reads). Do not treat a hit here as an
  automatic crash verdict -- see the `fetch` section above.
- **Device Farm's `ListArtifacts` can return several artifacts with the identical `name`** (a large
  device syslog gets split into numbered parts, all named `"Syslog"`). The download naming
  convention is `<name with spaces -> underscores>.<extension>`, with `-1`, `-2`, ... inserted before
  the extension on a collision, in encounter order -- verified against a real 3-part syslog
  (`Syslog.syslog`, `Syslog-1.syslog`, `Syslog-2.syslog`). `lib.mjs`'s `uniqueFilename` implements
  this exactly; do not reimplement it differently per caller.
- **A crawl screenshot's attachment name also matches the generic "numbered tour screenshot"
  pattern** (`"045 crawl Program > ..."` starts with three digits and a space, same as a tour
  screenshot). Classification MUST check for the `" crawl "` substring before falling back to the
  generic numbered-tour rule, or every crawl screenshot silently lands in `tour/`.
- **`Info.plist` inside a shipped IPA is Apple's BINARY plist format**, which Node has no built-in
  reader for. `plutil` is macOS-only and unavailable on this Linux toolchain; python3's `plistlib`
  (verified present in every session) reads it natively. Do not attempt to parse the binary format
  by hand.
- **A GitHub Actions artifact-download bearer must NOT be resent to the redirected blob URL.**
  `GET /repos/.../actions/artifacts/{id}/zip` returns a 302 to a pre-signed, unauthenticated
  storage URL; re-sending the `Authorization` header there is rejected. Fetch the redirect target
  with `redirect: "manual"`, read the `Location` header, and issue a second, bearer-free request.
- **Both apps' on-device process name is literally `"App"`** (the Capacitor default Xcode scheme
  name), not the bundle id or the app's marketing name. The syslog app-lifetime check greps for
  `" App[NNNN]"` for exactly this reason; a bundle-id-based match would find nothing.

## Files

- `walkthrough.mjs` -- the CLI (command dispatch + all the IO orchestration).
- `lib.mjs` -- every pure decision (registry lookup, attachment naming/classification, the
  `crawl-coverage.json` digest, `Test_spec_output.txt` parsing, syslog line matchers, the
  ScheduleRun request-body builder, the "0 device-minutes is not stuck" run-completion rule,
  GitHub artifact/run selection). Zero network/filesystem access -- this is what `tests/` exercises.
- `df-client.mjs` -- AWS Device Farm SigV4 calls (CreateUpload/GetUpload, ScheduleRun/GetRun/StopRun,
  ListJobs/ListSuites/ListArtifacts, all paginated).
- `gh-client.mjs` -- GitHub REST calls (workflow dispatch, run polling, artifact list/download).
- `plist.mjs` -- reads `CFBundleIdentifier`/`CFBundleShortVersionString`/`CFBundleVersion` out of a
  binary or XML `Info.plist` via python3.
- `syslog-scan.mjs` -- streams a (potentially 500MB+) syslog file through `lib.mjs`'s line matchers
  without buffering it in memory.
- `fsio.mjs` -- small filesystem/download/unzip helpers (`unzip` CLI, no zip-parsing dependency).
- `tests/device-walkthrough.test.mjs` -- `lib.mjs` regression tests, fixtures taken verbatim from a
  real Device Farm run.

## Rules

- Never print or persist an AWS credential or a GitHub token.
- Non-PHI ring: these are consumer-app UI screenshots only.
- `stop` only ever fires on an explicit `stop` command; nothing in this skill auto-stops a run.
