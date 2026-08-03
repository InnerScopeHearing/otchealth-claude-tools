# Mobile QA capability research, 2026-08-03

Raw research reports from a deep-swarm research pass on how a cloud-only
Claude Code Developer/CTO agent (no Mac, no physical iOS device) can
accurately QA Capacitor iOS apps before they reach a human's real device.
Triggered by a live gap found on iHEARtest: Build 53/54's HealthKit purpose-
string bug and every prior native/hardware bug in this fleet has only ever
been caught by Mark Moore's TestFlight device review, never by CI. Saved
here per the fleet SOP: raw research findings land in the repo under
`research/<topic>-<date>/` and are also mirrored to the Azure commons
`_DOCS` store for brain indexing (see the CTO Container Apps Jobs librarian
pattern in `otchealth-cto/CLAUDE.md`).

6 parallel researchers (Sonnet 5, WebSearch-equipped) + 1 synthesis pass.
~1.06M subagent tokens, 160 tool calls, ~18 minutes wall clock.

## Index

- `01-ios-simulator-ci.md`. Whether a GitHub Actions macOS runner (Depot's
  `depot-macos-26` specifically) can boot an iOS Simulator and drive it
  headlessly via `xcodebuild`/`xcrun simctl`, XCUITest, and Maestro
  (self-hosted CLI against a booted simulator, distinct from Maestro Cloud).
  Confirms this needs no code-signing at all (simulator builds are separate
  from the TestFlight archive/sign pipeline already proven on Depot). Covers
  what native capabilities do/don't work in Simulator, real open-source CI
  examples (Detox/React Native workflows), and the Depot-preinstalled-
  runtimes claim (plausible, not independently confirmed — verify with
  `xcrun simctl list runtimes` before relying on it).

- `02-real-device-cloud-farms.md`. BrowserStack App Automate, Sauce Labs
  Real Device Cloud, AWS Device Farm, Firebase Test Lab (iOS), LambdaTest,
  HeadSpin, Kobiton, Perfecto — API automation capability, pricing, and the
  critical catch found across all of them: none can run the actual
  TestFlight-signed IPA; all need a separate ad-hoc/dev export, and most
  re-sign and strip entitlements (HealthKit, Push, IAP, App Groups) on
  public device tiers. AWS Device Farm ($0.17/device-minute, no monthly
  floor, and the fleet already holds unused AWS Activate credit) and
  Firebase Test Lab (real-hardware-only, pay-per-device-hour) are the two
  credible low-commitment pilots.

- `03-capacitor-community-qa.md`. How other Capacitor/Ionic teams handle
  native-plugin QA without full device access — official Ionic/Capacitor
  docs, GitHub discussions, Capawesome/Capgo blog posts on the "no Mac"
  build problem, and the two-tier "Playwright for web layer + native smoke
  elsewhere" pattern other teams have converged on independently.

- `04-healthkit-native-limits.md`. Sourced from Apple's own developer docs
  and forums: HealthKit is unreliable/unavailable in Simulator across every
  recent Xcode version (confirmed, not folklore); the physical mute/silent
  switch has no public API on Simulator OR real device, ever (deliberate
  Apple policy, on the record); Bluetooth/CoreBluetooth is unsupported in
  Simulator (TN2295, the one historical workaround, is Apple-retired); and
  Apple's own WWDC-documented pattern (wrap hardware calls behind a thin
  protocol, `XCTSkipUnless`-gate the adapter) for keeping business logic
  testable without a device.

- `05-ai-qa-tooling.md`. The real vs. hyped landscape of AI/agentic mobile
  QA tools. Headline finding: `ios-simulator-mcp` and `mobile-mcp` (open
  source MCP servers wrapping `simctl`/accessibility trees) plus the Maestro
  MCP server are the one pattern that's both real and directly relevant —
  they let a Claude Code agent drive a live Simulator session during
  development. No vendor autonomously finds bugs in a compiled iOS build
  unattended today; Minitap's `mobile-use` is the most credible attempt and
  is Android-first, iOS-simulator-only, explicitly not real-device-ready per
  its own maintainers.

- `06-audio-calibration-testing.md`. The hardest category. Tone-generation
  correctness (did the app compute the right waveform) is fully unit-
  testable today via FFT assertion in Vitest, zero new infrastructure. Real
  acoustic output fidelity through actual speaker/headphone/AirPods hardware
  is NOT automatable by anyone in the industry — certified audiometers
  (SHOEBOX, hearX) rely on standardized hardware plus periodic human SPL-
  meter recalibration; consumer hearing-test apps use biological calibration
  (~7-11 dB standard deviation vs. clinical audiometry per the peer-reviewed
  literature cited). This is an industry-wide limitation, not an iHEARtest
  engineering gap.

## Synthesis

The full synthesized roadmap (executive summary, phased recommendations,
what genuinely cannot be automated, and a deduplicated source index across
all 6 reports) is in the sibling file
[`SYNTHESIS.md`](./SYNTHESIS.md) in this directory.

**Headline conclusion:** roughly two-thirds of what today only gets caught
at Mark's TestFlight device-review stage (native-plugin crashes, layout
bugs, navigation bugs, permission-dialog flow bugs, push-notification bugs)
is closeable with a 4-phase build (JS-layer tone-correctness unit tests,
a Simulator-based CI smoke pipeline on the existing Depot runner, a
protocol/adapter pattern around hardware-touching native code, and
agent-driven interactive Simulator QA via MCP during development) — all
cloud-compatible, most at zero or near-zero incremental cost. The remaining
third (HealthKit correctness, real Bluetooth/AirPods pairing, the physical
mute switch, real acoustic calibration fidelity) is permanently device-only
by Apple's platform design or the physics involved, not a tooling gap this
fleet can engineer around. Mark's real-device clinical review stays the
required final gate regardless of how far the above is built out — none of
this replaces it.
