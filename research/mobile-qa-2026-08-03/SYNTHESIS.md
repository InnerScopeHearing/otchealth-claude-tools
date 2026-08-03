# Mobile QA Capability Research — Synthesis & Roadmap

# iHEARtest Native/Hardware QA Gap — Synthesized Roadmap

*Synthesizing 6 independent research reports on iOS Simulator CI, real-device cloud farms, Capacitor/Ionic community QA practice, HealthKit/hardware Simulator limits, AI-driven mobile QA tooling, and calibrated-audio testing.*

---

## 1. Executive Summary

Ranked by real, implementable-today value. Honest about what is not worth building.

1. **The single highest-value, lowest-cost move is agent-driven interactive Simulator QA via MCP** (`ios-simulator-mcp` or `mobile-mcp`, plus the Maestro MCP server bundled in the Maestro CLI iHEARtest already uses). This is open-source, zero new vendor spend, and `ios-simulator-mcp` is the one pattern with a direct Anthropic endorsement (cited in Claude Code's own best-practices docs). It closes the actual gap named in the brief: today *nothing* looks at the running native shell before Mark does; this lets the Developer/App Lead agent screenshot-walk the real Simulator during normal development, catching layout, navigation, and obvious-crash bugs before a build ever reaches TestFlight.
2. **A second, CI-gated Simulator smoke/regression pipeline is real and buildable on the existing Depot macOS runners, with zero new signing infrastructure.** Simulator builds are unsigned — this is a genuinely separate, cheaper pipeline from the TestFlight archive/sign job already proven on `depot-macos-26`. It can run Maestro's existing flow YAMLs (self-hosted CLI, not Maestro Cloud) or a thin XCUITest target against a booted simulator, headless, with `simctl` driving permission dialogs, push-notification payloads, and video/screenshot capture.
3. **This pipeline catches a real, distinct class of bug that the current Playwright/WebKit viewport suite structurally cannot see**: native-plugin bridge crashes, native-vs-web layout bugs, permission-dialog flow bugs, and push-notification handling — because WKWebView exposes no remote-debugging protocol the way Android WebViews do, so this asymmetry is fundamental, not a tooling oversight.
4. **Tone/audio-generation correctness can be fully unit-tested today with zero new infrastructure** by generating the test tone into a buffer and FFT-asserting the dominant frequency and gain in Vitest (the JS-layer equivalent of Apple's own `AVAudioEngine.installTap` + `vDSP` pattern). This proves the app computed the correct waveform. It does **not** and cannot prove the physical speaker/headphone/AirPods output was correct — that distinction must be documented, not blurred.
5. **Real physical acoustic calibration verification does not exist as an automatable product anywhere in the industry, clinical or consumer.** Certified audiometer makers (SHOEBOX, hearX) solve it with standardized hardware bundles plus periodic human-in-the-loop SPL-meter recalibration; consumer apps solve it with biological calibration (a presumed-normal-hearing human sets the 0 dB reference), which the peer-reviewed literature reports as accurate to ~1 dB at calibration points but 7–11 dB standard deviation overall versus clinical audiometry. This is not a gap iHEARtest is uniquely failing to close with better tooling — nobody has closed it. It should be documented as an industry-wide limitation, not treated as an engineering backlog item.
6. **The physical mute/silent switch has no public API at all, on Simulator or on a real device.** This is not a testing gap to be closed by better CI — Apple staff have stated on the record it is deliberate policy. There is nothing to assert against programmatically, ever. One genuinely useful, low-effort mitigation: if the calibrated test-tone playback session uses the `.playback` AVAudioSession category (as it should for a clinical-grade instrument), Apple's own docs confirm `.playback`-category audio is *not* silenced by the switch — meaning the switch's position becomes provably irrelevant to whether the tone plays at all, de-risking (not eliminating) the concern.
7. **HealthKit, live camera capture, and Bluetooth/CoreBluetooth/AirPods routing are officially, permanently unsupported in Simulator** — not partially, not "usually," but as documented Apple platform behavior. No sanctioned mock exists for any of them (CoreBluetooth's one historical workaround, TN2295, is Apple-retired). These stay device-only, forever, regardless of tooling investment.
8. **Apple's own recommended architecture for this exact problem class is documented and should be adopted as house style**: wrap `HKHealthStore`, `AVAudioSession` route state, and `CBCentralManager`/BLE calls each behind a thin app-owned protocol; unit-test all business logic above that seam against fakes (fully Simulator/CI-safe); mark the thin adapter itself `XCTSkipUnless`-gated so it auto-skips cleanly on Simulator/CI and only runs (and is only required to pass) on Mark's/Matt's real iPhone 16 Pro devices.
9. **Real-device cloud farms (BrowserStack, Sauce Labs, LambdaTest, AWS Device Farm) are all genuinely CI-callable and headless**, but none of them let you test the actual TestFlight-signed `.ipa` — all require an ad-hoc/enterprise/dev-signed export — and all except paid "private device" tiers **re-sign and strip entitlements** (HealthKit, Push, IAP, App Groups). This makes them usable only for a narrow slice: UI/audio-routing/screen-navigation checks that don't depend on entitlements. AWS Device Farm's metered $0.17/device-minute, no-monthly-floor pricing is the one credible pay-as-you-go option, and the fleet already holds $5,000 of AWS Activate credit (per CTO ledger, previously unused for this purpose) that materially lowers the cost of piloting it.
10. **Firebase Test Lab for iOS is real, current, and the one provider that forces genuine physical hardware with no simulator fallback**, at pay-per-device-hour pricing (no subscription floor). Its catch: XCUITest only (no Appium/Maestro), a 45-minute run cap, and a much smaller device catalog. Worth a cheap, zero-commitment pilot as a native-hardware XCUITest smoke pass, not a primary pipeline.
11. **Do not build audio-capture-via-virtual-device (Soundflower/BlackHole/ffmpeg loopback) CI tooling.** It is real and technically possible on Simulator, but it is 2019-era desktop-audio-routing tooling that does not fit a headless Depot macOS runner cleanly, is brittle, and — critically — even if built, it would only validate the Simulator's virtual audio path, not real acoustic output. Not worth the engineering time for what it buys.
12. **No AI/agentic QA vendor autonomously explores and finds bugs in a compiled iOS build unattended today**, on iOS specifically. Minitap `mobile-use` (the most technically credible "true autonomous agent") is Android-first; iOS support is simulator-only and explicitly described by its own maintainers as far from real-device-ready. BrowserStack's and Sauce Labs' AI features assist test authoring/maintenance, they don't autonomously test end-to-end. Treat this whole category as "watch, don't build on" for now, except for the MCP-server pattern in item 1, which is different (agent-driven tool-calling, not autonomous vision-loop exploration) and already proven.
13. **Depot's claim that simulator runtimes are preinstalled on its macOS runners is plausible but not independently confirmed by direct doc fetch in this research.** Verify with a one-line `xcrun simctl list runtimes` step on `depot-macos-26` before designing pipeline timing/cost assumptions around it — cheap to check, don't assume.
14. **Mark's real-device clinical review does not go away and should not be treated as replaceable by any of the above** — every report converges on this independently: the Capacitor/Ionic community's own de facto standard for small teams is TestFlight + a human, Apple's own tooling guidance treats device-state-dependent tests as something to minimize not eliminate, and the entire calibrated-audiometry industry's answer to "verify real acoustic output" is still a human with a reference instrument. The goal of everything above is narrowing what reaches Mark, not replacing what he does.
15. **Net honest assessment**: roughly two-thirds of what currently only gets caught at Mark's device-review stage (native crashes, layout bugs, navigation bugs, permission-flow bugs, push-notification bugs) is closeable with Phases 1–4 below, all cloud/no-Mac-compatible, most at zero or near-zero incremental cost. The remaining third (HealthKit correctness, real Bluetooth/AirPods pairing and routing, physical mute-switch behavior, real acoustic/calibrated audio fidelity) is permanently device-only by Apple's platform design or by the nature of the physics involved, not by a tooling gap this fleet can engineer its way out of.

---

## 2. Recommended Roadmap

Ordered by effort/cost and dependency. Every phase assumes the cloud-only, no-Mac, no-physical-device operating model and builds on the existing Depot macOS (`depot-macos-26`, Xcode 26) pipeline. **Every phase leaves Mark's real-device TestFlight review in place as the final gate — none of them are a substitute.**

### Phase 1 — Tone/audio-generation correctness unit tests (JS layer, Vitest)
**Adds:** A `qa/unit/` spec that generates the calibrated test tone into a buffer at the Web Audio layer (mirroring `AVAudioEngine.installTap` + `vDSP` FFT verification on the native side) and asserts the dominant FFT frequency and RMS/gain match the requested test-tone parameters within tolerance. Applies the same pattern to any other precisely-timed or precisely-leveled audio iHEARtest generates.
**Effort/cost:** Low. Days, one engineer, no new infrastructure, no CI changes beyond adding the spec file to the existing `npm test` gate.
**Does NOT solve:** Whether the physical speaker, headphones, or AirPods actually reproduce that buffer at the correct real-world frequency/level. Proves app-layer correctness only. Mark's device review remains the only check on actual acoustic output.

### Phase 2 — iOS Simulator smoke/regression CI on Depot
**Adds:** A second, separate GitHub Actions workflow (e.g. `ios-simulator-qa.yml`) on `depot-macos-26`, PR-triggered (not on every push, to control Depot macOS-minute burn): builds the Capacitor app for `iphonesimulator` (no signing needed — this is the structural win, a fully credential-free path distinct from the TestFlight archive job), boots a simulator matched to the iPhone 16 Pro test devices, pre-grants needed permissions via `simctl privacy`, installs and launches the app, then drives it via the **existing Maestro flow YAMLs run self-hosted against the booted simulator** (spike first to confirm the existing device-flow YAMLs work unmodified against a simulator target) or a thin XCUITest target for native-bridge-level assertions. Captures `simctl io booted recordVideo` + Maestro/`.xcresult` artifacts on every run, uploaded via `actions/upload-artifact` with `if: always()`. Add a `simctl push booted <bundle-id> payload.json` step to exercise push-notification handling headlessly.
**Effort/cost:** Medium. Roughly 1–2 weeks of initial build plus ongoing flow maintenance as screens change. Before committing, spend a cheap spike verifying (a) the existing Maestro flows run unmodified against a simulator target, and (b) Depot's claim that simulator runtimes are preinstalled (`xcrun simctl list runtimes` as the workflow's first step) — both are plausible but unconfirmed by direct source in this research.
**Does NOT solve:** HealthKit, live camera capture, Bluetooth/AirPods hardware routing, the physical mute switch, or real acoustic audio fidelity — all officially unsupported in Simulator, not a configuration gap. Also does not solve audio-output *quality* verification (Simulator plays through the host Mac's audio stack, not a virtualized iOS audio pipeline) — do not build loopback/BlackHole capture on top of this pipeline; it isn't worth the engineering cost (see Executive Summary item 11).

### Phase 3 — Protocol/adapter wrapping for hardware-touching native code
**Adds:** Apply Apple's own documented testing pattern (WWDC 2018 session 417, reinforced by DTS engineer guidance on CoreBluetooth) fleet-wide: wrap `HKHealthStore` calls, `AVAudioSession` route/category state, and any BLE (`CBCentralManager`/`CBPeripheral`) calls behind a thin, app-owned protocol. Business logic above that seam gets ordinary Vitest/XCTest coverage against fakes, fully Simulator/CI-safe. The thin adapter implementation itself is marked with `XCTSkip`/`XCTSkipUnless` (or an equivalent JS-layer guard) so it auto-skips cleanly on Simulator/CI and is only required to pass on a real device.
**Effort/cost:** Medium-to-high, ongoing. This is an architectural discipline more than a one-time build — it pays off specifically as new hardware-touching features land (e.g., the HealthKit-AirPods-audiogram idea already noted in the CTO's standing facts). Retrofitting existing native code that isn't already structured this way is the bulk of the cost.
**Does NOT solve:** Acoustic correctness, real Bluetooth pairing/routing, or replace Mark. It does make the *business logic* around those surfaces (e.g., "if HealthKit write fails, show this message") reliably testable without a device, which today it likely isn't.

### Phase 4 — Agent-driven interactive Simulator QA via MCP
**Adds:** Connect `ios-simulator-mcp` (macOS-native, wraps `simctl`/`idb`, cited in Anthropic's own Claude Code best-practices docs) and/or `mobile-mcp` (cross-platform, accessibility-tree-native, no Appium dependency) as MCP servers available to Developer/App Lead Claude Code sessions, alongside the Maestro MCP server already bundled in the Maestro CLI. This lets the agent building a feature actually launch, tap through, and screenshot the running Simulator app in the same session that's writing the code — turning "implement -> screenshot -> verify" into a routine step rather than something only Mark ever does. Make a pre-dispatch screenshot walkthrough of new/changed screens a standing step before any `ios-depot.yml` build is sent toward Mark's review (this mirrors the fleet's existing `persona-focus-group`/screenshot-walkthrough pattern used elsewhere in the portfolio).
**Effort/cost:** Low. Installing open-source MCP servers, no new vendor, no new spend. The main cost is discipline — actually using the tool as a standing pre-dispatch step, not building new infrastructure.
**Does NOT solve:** Anything requiring real hardware (see Phase 5/6 boundaries below). This is exploratory/development-time QA, not a CI gate, and it does not autonomously "find bugs" the way a human tester would — it's an agent tool-calling loop the Developer agent has to actually drive and reason about, not a fire-and-forget autonomous scan.

### Phase 5 (optional, cost-gated) — Narrow real-device cloud checks for non-entitlement flows
**Adds:** For the specific slice of behavior that Simulator cannot represent at all but that also does *not* require HealthKit/IAP/App-Group entitlements to be preserved (AirPods/Bluetooth pairing UI flow, output-device routing UI, general on-real-hardware smoke), pilot **AWS Device Farm**, metered at $0.17/device-minute with no monthly subscription floor — a genuine pay-as-you-go fit for "a few runs per release," and the fleet already holds unused AWS Activate credit that lowers the cost of a pilot near zero. Export a second ad-hoc-signed IPA from the same existing archive step (not a rebuild) for this path. Consider a zero-commitment **Firebase Test Lab** pilot (real hardware only, XCUITest, pay-per-device-hour) as a second, independent real-hardware smoke check.
**Effort/cost:** Low-to-medium, and largely funded by existing credit. Real cost is engineering time to build and maintain a second export target and XCUITest/Maestro-Cloud-compatible flow subset.
**Does NOT solve:** Anything needing HealthKit, Push, IAP, or App Group entitlements intact — AWS Device Farm's automatic re-signing strips all of these on public devices with no documented opt-out; BrowserStack/Sauce Labs only preserve entitlements on paid "private device" tiers ($199+/mo floor, worth it only if this becomes a recurring, entitlement-dependent need). Does not replace Mark for clinical judgment calls, real acoustic assessment, or edge-case device behavior.

### Phase 6 (do not build) — Virtual-audio-device output capture
Explicitly **not recommended.** BlackHole/Soundflower + ffmpeg loopback capture of Simulator audio, then FFT/fingerprint analysis, is real and has been demonstrated (Appium's audio-capture feature, the Appium Pro two-part tutorial series), but it is brittle desktop-audio-routing tooling that doesn't fit a headless Depot runner cleanly, and even fully working it would only validate the Simulator's software audio path — not the acoustic result that actually matters for a hearing-screening instrument. Skip this line of investment entirely.

**What stays permanently, unconditionally on Mark's real-device review, regardless of how far the above phases are built out:** HealthKit read/write correctness, live camera behavior, real Bluetooth/AirPods pairing and audio routing, physical mute-switch interaction, real calibrated audio frequency/level fidelity through actual speaker/headphone/AirPods hardware, and any judgment call requiring Mark's clinical expertise.

---

## 3. What Genuinely Cannot Be Automated

Stated plainly, so no automated pass is ever mistaken for equivalent to Mark's review.

- **Real calibrated audio output fidelity.** No consumer or clinical product in the industry automates this. Clinical audiometers (SHOEBOX, hearX) solve it with standardized, pre-characterized hardware bundles plus periodic *physical* SPL-meter recalibration by a human, governed by IEC 60645/ANSI S3.6. Consumer apps on arbitrary hardware (iHEARtest's actual deployment model) use *biological calibration* — a human with presumed-normal hearing sets the reference point by ear — which the peer-reviewed literature places at ~7–11 dB standard deviation versus clinical audiometry even when working correctly. There is no CI check, virtual device, or FFT assertion that substitutes for this. It is not solvable by better tooling; it is solvable only by device-specific calibration and human verification, which is what Mark's review already is.
- **The physical mute/silent switch.** No public API exists on Simulator *or* real device — this is deliberate Apple policy, stated on the record by Apple staff, not a gap. There is nothing to assert against programmatically, ever, on any platform version. The only mitigation is architectural (using the `.playback` category so the switch is provably irrelevant to tone playback) plus manual device verification of any UI that claims to detect or warn about the switch state.
- **Real Bluetooth/AirPods pairing and audio routing.** CoreBluetooth and Bluetooth generally are explicitly, officially unsupported in Simulator. Apple's own DTS engineers have stated on record there is no officially sanctioned way to mock BLE devices, and the one historical workaround (TN2295) is Apple-retired. This must be verified on real hardware every time it matters.
- **HealthKit read/write correctness.** `isHealthDataAvailable()` is unreliable/false in Simulator across every Xcode version checked, including recent (2025) reports. The one Simulator-side HealthKit feature Apple documents (sample-data accounts) is scoped to Health *Records*/FHIR data, a different subsystem from the general quantity-sample store an audiogram feature would use. Additionally, HealthKit deliberately gives no distinguishable "permission denied" signal for reads (by privacy design) — "no data" and "denied" look identical, on device or Simulator, which any test strategy has to treat as inherently ambiguous.
- **Live camera capture.** Not supported natively in Simulator; apps typically fall back to a no-camera-found UI path there. Only the photo-library picker (choosing an existing image, not live capture) is Simulator-testable.
- **Real per-device-model audio hardware variance** (speaker frequency response, DAC behavior, headphone impedance interaction, real dB SPL output). This is a known, industry-wide, categorically unsolved-by-software limitation across every hearing-related consumer app reviewed in this research, not an iHEARtest-specific gap — worth stating explicitly in compliance/QA docs so a future reviewer doesn't mistake it for an oversight.
- **Anything requiring Mark's clinical judgment** — no tooling in any of the six reports claims or should be read as claiming to replace a licensed hearing-care professional's assessment of whether a build is clinically sound to expose to real users. Every phase above is scoped to narrowing what reaches him with fewer avoidable, non-clinical bugs already caught — never to replacing the review itself.

---

## 4. Source Index

Deduplicated, grouped by topic, across all six source reports.

### iOS Simulator CI fundamentals (xcodebuild / simctl / XCUITest)
- [xcodebuild.xctestrun man page](https://keith.github.io/xcode-man-pages/xcodebuild.xctestrun.5.html)
- [Speed up iOS CI using Test Without Building, xctestrun, Fastlane](https://medium.com/xcblog/speed-up-ios-ci-using-test-without-building-xctestrun-and-fastlane-a982b0060676)
- [Apple Developer Forums: test-without-building](https://developer.apple.com/forums/thread/675249)
- [Bitrise xcode-test-without-building step](https://github.com/bitrise-steplib/bitrise-step-xcode-test-without-building)
- [xcrun simctl & iOS Simulators reference](https://reactnative.codeguides.io/cli/xcrun-simctl-and-ios-simulators/)
- [iOS Simulator for Testing: CLI Guide](https://yarygintech.com/articles/ios_simulator_testing_guide/)
- [Finding iOS simulator identifiers for CI](https://www.mickf.net/tech/finding-ios-simulators-identifiers/)
- [GitHub Actions for iOS CI/CD (TechConcepts)](https://techconcepts.org/blog/github-actions-ios)
- [GitHub Actions + Xcode setup (Quality Coding)](https://qualitycoding.org/github-actions-ci-xcode/)
- [GitHub Actions for Xcode project (vmois.dev)](https://vmois.dev/xcode-github-actions/)
- [simctl privacy grant/revoke/reset (fastlane discussion)](https://github.com/fastlane/fastlane/discussions/18900)
- [Reset iOS Simulator Privacy Permissions](https://dheerajn.github.io/til/reset-simulator-privacy-permissions/)
- [XCUITest addUIInterruptionMonitor pattern](https://medium.com/@akhmat-s/xctest-interaction-with-ios-alerts-and-permissions-in-ui-testing-c800bb94983d)
- [Handling System Alerts In UI Tests (Use Your Loaf)](https://useyourloaf.com/blog/handling-system-alerts-in-ui-tests/)
- [simctl io recordVideo / screenshot (XCBlog)](https://medium.com/xcblog/simctl-control-ios-simulators-from-command-line-78b9006a20dc)
- [Tools I Love: recordVideo (Eli Perkins)](https://iosfeeds.com/read/28285)
- [Using xcresult files with GitHub Actions (Al Wold)](https://alwold.com/posts/xcresults-on-github-actions/)
- [xcresulttool GitHub Action](https://github.com/marketplace/actions/xcresulttool)
- [Managing GitHub Actions artifacts](https://oneuptime.com/blog/post/2026-01-25-github-actions-artifacts/view)
- [simctl push notification reference](https://tanaschita.com/testing-remote-push-notifications-in-ios-simulator/)
- [Push notifications to Simulator (Medium/Globant)](https://medium.com/globant/send-push-notifications-to-the-ios-simulator-3a78b6689cf)
- [react-native-detox-github-actions repo](https://github.com/edvinasbartkus/react-native-detox-github-actions)
- [ios.yml Detox workflow file](https://github.com/edvinasbartkus/react-native-detox-github-actions/blob/master/.github/workflows/ios.yml)
- [Running Detox tests on GitHub Actions (remarkablemark)](https://remarkablemark.org/blog/2023/02/18/how-to-run-react-native-detox-tests-on-github-actions/)
- [Detox tests on GitHub Actions walkthrough (DEV.to)](https://dev.to/edvinasbartkus/running-react-native-detox-tests-for-ios-and-android-on-github-actions-2ekn)
- [wix/Detox issue #4357: simulator not launching on CI](https://github.com/wix/Detox/issues/4357)

### Depot macOS runners
- [Depot: macOS GitHub Actions runners announcement](https://depot.dev/blog/mac-github-actions-runners)
- [Depot: macOS 26 changelog](https://depot.dev/changelog/2026-05-26-macos-26-beta-github-actions)
- [Depot: GitHub Actions runner types docs](https://depot.dev/docs/github-actions/runner-types)
- [Depot: macOS runners twice as fast (disk accelerator)](https://depot.dev/blog/ultra-runners-for-macos)

### Maestro (CLI, MCP, CI)
- [Self-Healing Tests: Fixing Flaky UI Automation (Maestro)](https://maestro.dev/insights/self-healing-tests-fixing-flaky-ui-automation)
- [Maestro Docs](https://maestro.dev/)
- [Maestro MCP Server | Maestro Docs](https://docs.maestro.dev/get-started/maestro-mcp)
- [Maestro MCP for AI Coding Agents](https://maestro.dev/blog/maestro-mcp-for-ai-coding-agents)
- [Maestro MCP | Agentic UI Testing for Mobile Apps](https://maestro.dev/mcp)
- [Maestro MCP: An introduction](https://maestro.dev/blog/maestro-mcp-an-introduction)
- [Maestro docs: GitHub Actions platform guides](https://docs.maestro.dev/maestro-cloud/ci-cd-integration/github-actions/platform-guides)
- [Integrating Maestro with CI/CD for Cloud Testing](https://maestro.dev/insights/maestro-ci-cd-cloud-testing-integration)
- [Self-Hosting Maestro Mobile Tests (Chick-fil-A Tech / Medium)](https://medium.com/chick-fil-atech/self-hosting-maestro-mobile-tests-b320d8f3e86e)
- [Maestro GitHub Actions marketplace listing](https://github.com/marketplace/actions/maestro-github-actions)
- [Running your Maestro Flows on GitHub Actions](https://maestro.dev/blog/running-your-maestro-flows-on-github-actions)
- [Maestro vs Appium 2026](https://maestro.dev/insights/appium-vs-maestro-react-native-testing-tools)
- [Best Mobile Testing Frameworks 2026 (Maestro)](https://maestro.dev/insights/best-mobile-app-testing-frameworks)

### Capacitor/Ionic official docs and CI
- [Capacitor CI/CD docs](https://capacitorjs.com/docs/guides/ci-cd) / [legacy v2](https://capacitorjs.com/docs/v2/guides/ci-cd)
- [Capacitor Environment Setup](https://capacitorjs.com/docs/getting-started/environment-setup)
- [Capacitor FAQs](https://capacitorjs.com/docs/getting-started/faqs)
- [Deploying to App Store (Capacitor docs)](https://capacitorjs.com/docs/ios/deploying-to-app-store)
- [iOS Troubleshooting Guide (Capacitor)](https://capacitorjs.com/docs/ios/troubleshooting)
- [Ionic E2E docs](https://ionic.io/docs/e2e) / [Writing Tests](https://ionic.io/docs/e2e/writing-tests) / [Introducing the Ionic E2E reference example](https://ionic.io/blog/introducing-the-ionic-end-to-end-testing-reference-example)
- [Angular Testing (Ionic Framework docs)](https://ionicframework.com/docs/angular/testing)
- [Using TestFlight for User Testing with Ionic (blog)](https://ionic.io/blog/using-testflight-for-user-testing-with-ionic) / [(support article)](https://ionic.zendesk.com/hc/en-us/articles/360004620274-Using-TestFlight-for-User-Testing-on-iOS)
- [Building and Releasing Your Capacitor iOS App](https://ionic.io/blog/building-and-releasing-your-capacitor-ios-app)
- [Deploying to the App Stores (Appflow)](https://ionic.io/docs/appflow/tutorial/dtas)
- [ionic-team/ionic-unit-testing-example](https://github.com/ionic-team/ionic-unit-testing-example)
- [ionic-team/cap-plugin-mock-jest](https://github.com/ionic-team/cap-plugin-mock-jest) / [cap-plugin-mock-jasmine](https://github.com/ionic-team/cap-plugin-mock-jasmine)
- [GitHub discussion #4252: mocking pattern](https://github.com/ionic-team/capacitor/discussions/4252) / [#5222: stubbing geolocation](https://github.com/ionic-team/capacitor/discussions/5222) / [#5348: iOS builds in cloud](https://github.com/ionic-team/capacitor/discussions/5348) / [#3734: camera simulator bug](https://github.com/ionic-team/capacitor/discussions/3734)
- [capacitor-plugins #615: proxied-plugin mocking](https://github.com/ionic-team/capacitor-plugins/issues/615)
- [capacitor #4350: camera not working iOS](https://github.com/ionic-team/capacitor/issues/4350)

### Capacitor community, simulator-vs-device parity, hardware plugins
- [capacitor-community/bluetooth-le #250](https://github.com/capacitor-community/bluetooth-le/issues/250) / [#552](https://github.com/capacitor-community/bluetooth-le/issues/552)
- [Teaching Claude to QA a Mobile App (Christopher Meiklejohn)](https://christophermeiklejohn.com/ai/zabriskie/development/android/ios/2026/03/22/teaching-claude-to-qa-a-mobile-app.html)
- [How to Build and Deploy iOS Apps Without Owning a Mac (Capawesome)](https://capawesome.io/blog/how-to-build-and-deploy-ios-apps-without-a-mac/)
- [The iOS Troubleshooting Guide for Capacitor (Capawesome)](https://capawesome.io/blog/troubleshooting-capacitor-ios-issues/)
- [Top Tools for Debugging Platform-Specific Code in Capacitor (Capgo)](https://capgo.app/blog/top-tools-for-debugging-platform-specific-code-in-capacitor/)
- [Setting Up CI/CD for Capacitor Apps (Capgo)](https://capgo.app/blog/setting-up-cicd-for-capacitor-apps/)
- [Capacitor.js Experience Report (Manaknight Digital)](https://manaknightdigital.com/blog/capacitor-js-experience-report-react)
- [How To Test Hybrid React Native Apps With Playwright (getpanto.ai)](https://www.getpanto.ai/blog/playwright-react-native-hybrid-testing)
- [Playwright WebView Testing: Android & Electron Guide (TestMu AI/LambdaTest)](https://www.testmuai.com/blog/playwright-webview-testing/)
- [A Tiered Playwright E2E Strategy (dev.to)](https://dev.to/demi_jiang_3bfb65a7d28774/a-tiered-playwright-e2e-strategy-from-pr-smoke-to-production-validation-4o01)
- [10 Best Real Device Cloud Testing Tools 2026 (getpanto.ai)](https://www.getpanto.ai/blog/best-real-device-cloud-testing-tools)
- [BrowserStack vs Sauce Labs (bug0.com)](https://bug0.com/knowledge-base/browserstack-vs-saucelabs)
- [Cloud Testing Platforms guide (yrkan.com)](https://yrkan.com/blog/cloud-testing-platforms/)

### HealthKit
- [isHealthDataAvailable() — Apple docs](https://developer.apple.com/documentation/healthkit/hkhealthstore/ishealthdataavailable())
- [errorHealthDataUnavailable — Apple docs](https://developer.apple.com/documentation/healthkit/hkerror/errorhealthdataunavailable)
- [HKHealthStore — Apple docs](https://developer.apple.com/documentation/HealthKit/HKHealthStore)
- [Accessing Sample Data in the Simulator — Apple docs](https://developer.apple.com/documentation/healthkit/accessing-sample-data-in-the-simulator)
- [Accessing Health Records — Apple docs](https://developer.apple.com/documentation/healthkit/accessing-health-records)
- [Accessing a User's Clinical Records — Apple docs](https://developer.apple.com/documentation/HealthKit/accessing-a-user-s-clinical-records)
- ["iOS Simulator Cannot Read the Health…" — Apple forums](https://developer.apple.com/forums/thread/692302)
- ["Extremely persistent HealthKit rea…" — Apple forums](https://developer.apple.com/forums/thread/799086)
- ["XCode + HealthKit on a simulator" — Apple forums](https://developer.apple.com/forums/thread/12407)
- ["Simulate Health Clinical records" — Apple forums](https://developer.apple.com/forums/thread/652290)
- [HealthKit iOS 2026 guide](https://medium.com/@garejakirit/apple-healthkit-in-ios-2026-the-complete-swift-guide-step-by-step-0d4215b54412)

### Mute/silent switch
- ["How can I detect when the mute switch has been toggled?" — Apple forums](https://developer.apple.com/forums/thread/649638)
- ["Is it possible to listen physical mute/unmute ring state?" — Apple forums](https://developer.apple.com/forums/thread/760503)
- [secondaryAudioShouldBeSilencedHint — Apple docs](https://developer.apple.com/documentation/avfaudio/avaudiosession/secondaryaudioshouldbesilencedhint)
- [playback (AVAudioSession.Category) — Apple docs](https://developer.apple.com/documentation/avfaudio/avaudiosession/category-swift.struct/playback)
- [No native API for mute switch (dev forum roundup)](https://developer.apple.com/forums/thread/40988)

### AVAudioSession / audio playback in Simulator
- [Testing in Simulator versus testing on hardware devices — Apple docs](https://developer.apple.com/documentation/xcode/testing-in-simulator-versus-testing-on-hardware-devices)
- [Testing complex hardware device scenarios in Simulator — Apple docs](https://developer.apple.com/tutorials/data/documentation/xcode/testing-complex-hardware-device-scenarios-in-simulator.md)
- ["Simulator causing Mac audio distor…" — Apple forums](https://developer.apple.com/forums/thread/668170)
- [Responding to Audio Session Route Changes — Apple docs](https://developer.apple.com/documentation/avfaudio/avaudiosession/responding_to_audio_session_route_changes)
- [Simform Engineering — Audio Input Device Switch Management in AVAudioSession](https://medium.com/simform-engineering/audio-input-device-switch-management-in-avaudiosession-4a7c4dd78eb5)
- [Apple — Configuring Device Hardware (Audio Session Programming Guide)](https://developer.apple.com/library/archive/documentation/Audio/Conceptual/AudioSessionProgrammingGuide/OptimizingForDeviceHardware/OptimizingForDeviceHardware.html)
- [BrowserStack — Appium iOS: Simulator vs Real Devices](https://www.browserstack.com/guide/appium-ios-simulator-vs-real-device-testing)
- [Why AVSpeechSynthesizer Sounds Different on Real iPhones vs Simulator](https://medium.com/@info_4533/why-avspeechsynthesizer-sounds-terrible-on-real-iphones-eb4565862ea8)
- [AVFoundation Capture / CoreAudio sample (capture doesn't run in simulator)](https://developer.apple.com/library/archive/samplecode/AVCaptureToAudioUnit/Introduction/Intro.html)

### Bluetooth / CoreBluetooth
- [Apple TN2295 (Retired)](https://developer.apple.com/library/archive/technotes/tn2295/_index.html)
- [Bluetooth-in-simulator forum confirmation](https://developer.apple.com/forums/thread/661675)
- ["Mocking or simulating CBPeripheral…" — Apple forums](https://developer.apple.com/forums/thread/764024)
- ["Best Practices for Unit Testing CoreBluetooth Applications" — Apple forums](https://developer.apple.com/forums/thread/794138)

### Camera in Simulator
- [Simulator Camera: Test without a physical device (SwiftLee)](https://www.avanderlee.com/xcode/simulator-camera-test-your-app-without-a-physical-device/)
- [RocketSim iOS Simulator Camera docs](https://www.rocketsim.app/docs/features/capturing/simulator-camera-support/)

### Apple testing-architecture guidance (WWDC / official)
- [Testing Tips & Tricks — WWDC 2018, session 417](https://developer.apple.com/videos/play/wwdc2018/417/)
- [Testing in Xcode — WWDC 2019, session 413](https://developer.apple.com/videos/play/wwdc2019/413/)
- [XCTSkip your tests — WWDC 2020, session 10164](https://developer.apple.com/videos/play/wwdc2020/10164/)

### Real-device cloud farms
- [App Automate REST API overview (BrowserStack)](https://www.browserstack.com/docs/app-automate/api-reference/introduction) / [XCUITest via API](https://www.browserstack.com/docs/app-automate/api-reference/xcuitest/overview) / [IPA creation docs](https://www.browserstack.com/docs/app-automate/appium/references/ipa-creation) / [Entitlements troubleshooting](https://www.browserstack.com/docs/app-automate/appium/troubleshooting/entitlements-error) / [Re-sign iOS apps](https://www.browserstack.com/docs/app-automate/appium/resign-ios-apps) / [Disable resigning](https://www.browserstack.com/docs/app-automate/appium/advanced-features/disable-resigning-of-apps) / [Media injection](https://www.browserstack.com/real-device-features/media-injection-and-audio-streaming) / [Audio/video testing guide](https://www.browserstack.com/guide/audio-video-testing-on-real-devices) / [pricing](https://www.trustradius.com/products/browserstack/pricing) / [Bug0 pricing guide](https://bug0.com/knowledge-base/browserstack-pricing)
- [Sauce Labs Real Device Cloud](https://saucelabs.com/products/mobile-testing/real-device-cloud) / [Creating real device .ipa files](https://docs.saucelabs.com/mobile-apps/automated-testing/ipa-files/) / [Exporting ad hoc IPA](https://docs.saucelabs.com/testfairy/sdk/ios/ad-hoc-ipa/) / [iOS App Resigning docs](https://docs.saucelabs.com/mobile-apps/features/ios-app-resigning/) / [Private Devices](https://saucelabs.com/products/private-devices-real-device-cloud) / [Entitlements GitHub issue](https://github.com/saucelabs/sauce-docs/issues/840) / [Audio Capture docs](https://docs.saucelabs.com/mobile-apps/features/audio-capture/) / [Audio capture changelog](https://changelog.saucelabs.com/en/audio-capture-available-on-rdc) / [pricing](https://saucelabs.com/pricing)
- [AWS Device Farm: schedule-run CLI](https://docs.aws.amazon.com/cli/latest/reference/devicefarm/schedule-run.html) / [aws-devicefarm GitHub Action](https://github.com/realm/aws-devicefarm) / [official docs](https://docs.aws.amazon.com/devicefarm/latest/developerguide/api-ref.html) / [What is AWS Device Farm](https://docs.aws.amazon.com/devicefarm/latest/developerguide/welcome.html) / [Test environment for iOS](https://docs.aws.amazon.com/devicefarm/latest/developerguide/custom-test-environments-hosts-ios.html) / [Limits](https://docs.aws.amazon.com/devicefarm/latest/developerguide/limits.html) / [FAQs/pricing](https://aws.amazon.com/device-farm/faqs/) / [pricing walkthrough](https://getautonoma.com/blog/aws-device-farm-pricing) / [remote access docs](https://docs.aws.amazon.com/devicefarm/latest/developerguide/remote-access.html)
- [Firebase Test Lab for iOS: Get started](https://firebase.google.com/docs/test-lab/ios/get-started) / [Available testing devices](https://firebase.google.com/docs/test-lab/ios/available-testing-devices) / [Run an XCTest](https://firebase.google.com/docs/test-lab/ios/run-xctest) / [Command-line docs](https://firebase.google.com/docs/test-lab/ios/command-line) / [Flutter + gcloud + Test Lab + GitHub Actions example](https://medium.com/@matheusdeveloper.henrique/flutter-integration-test-with-gcloud-firebase-testlab-and-github-actions-31ba1f2c173c)
- [LambdaTest Real Device Cloud](https://www.lambdatest.com/intl/en-de/real-device-cloud) / [pricing](https://www.lambdatest.com/pricing)
- [HeadSpin AV testing platform](https://www.headspin.io/solutions/av-testing) / [AV Box overview](https://digitalrishabh01.medium.com/how-to-transform-audio-video-testing-with-headspin-av-box-0457dbedc5bb)
- [Kobiton pricing overview](https://g2.com/products/kobiton/pricing)
- [Perfecto Mobile Device Cloud](https://www.perfecto.io/product/mobile-device-cloud)
- [ServerCore Mobile Device Farm](https://servercore.com/services/mobile-device-farm/)

### AI/agentic mobile QA tooling
- [GitHub - mobile-next/mobile-mcp](https://github.com/mobile-next/mobile-mcp)
- [GitHub - joshuayoes/ios-simulator-mcp](https://github.com/joshuayoes/ios-simulator-mcp)
- [Best practices for Claude Code - Claude Code Docs](https://code.claude.com/docs/en/best-practices)
- [GitHub - AlexGladkov/claude-in-mobile](https://github.com/AlexGladkov/claude-in-mobile)
- [GitHub - appium/appium-mcp](https://github.com/appium/appium-mcp)
- [GitHub - headspinio/appium-llm-plugin](https://github.com/headspinio/appium-llm-plugin)
- [GitHub - AppiumTestDistribution/stark-vision](https://github.com/AppiumTestDistribution/stark-vision)
- [Percy: Best Mobile Visual Testing Tools for 2026](https://percy.io/blog/best-mobile-visual-testing-tools) / [Percy: App Visual Testing Tools](https://percy.io/blog/app-visual-testing)
- [Sauce Labs: Best AI Automation Testing Tools of 2026](https://saucelabs.com/resources/blog/comparing-the-best-ai-automation-testing-tools-in-2026)
- [InfoQ: Sauce Labs AI Agent for Test Creation](https://www.infoq.com/news/2026/04/sauce-labs-ai-test-creation/)
- [Drizz Review](https://blog.automatedsalesmachine.com/drizz-review/) / [Drizz.dev](https://www.drizz.dev/discover/ai-driven-autonomous-mobile-testing)
- [clip.qa: Agentic QA for Mobile Apps](https://clip.qa/blog/agentic-qa-mobile/)
- [Unite.AI: Minitap Raises $4.1M](https://www.unite.ai/minitap-raises-4-1m-to-make-mobile-development-10x-faster-with-ai/) / [EU-Startups: Minitap](https://www.eu-startups.com/2025/12/following-its-top-performance-on-androidworld-frances-minitap-secures-e3-5-million-for-its-mobile-development-platform/) / [GitHub - minitap-ai/mobile-use](https://github.com/minitap-ai/mobile-use) / [minitap.ai](https://www.minitap.ai/) / [iOS support issue](https://github.com/minitap-ai/mobile-use/issues/65)
- [AutonomIQ market share (6sense)](https://6sense.com/tech/test-automation/autonomiq-market-share) / [AutonomIQ TestIQ reviews (PeerSpot)](https://www.peerspot.com/products/autonomiq-testiq-reviews)
- [Best Mobile App Testing Tools 2026: The Agentic AI Shift](https://www.testriq.com/blog/post/mobile-app-testing-tools-2026-guide)
- [App Store Connect Expert - Claude Code Skill](https://mcpmarket.com/tools/skills/app-store-connect-expert)
- [GitHub - JustinPerea/app-store-review-skill](https://github.com/JustinPerea/app-store-review-skill) / [GitHub - cruisediary/apple-app-review-skills](https://github.com/cruisediary/apple-app-review-skills)

### Audio capture / FFT / calibration research
- [Appium Pro: Capturing Audio Output During Testing: Part 1](https://appiumpro.com/editions/69-capturing-audio-output-during-testing-part-1) / [Part 2 (HeadSpin)](https://www.headspin.io/blog/capturing-audio-output-during-testing-part-2)
- [Appium XCUITest Driver — Audio Capture guide](https://appium.github.io/appium-xcuitest-driver/11.0/guides/audio-capture/)
- [BlackHole (macOS virtual audio loopback driver)](https://github.com/ExistentialAudio/BlackHole)
- [xcrun simctl recordVideo — Sarunw walkthrough](https://sarunw.com/posts/take-screenshot-and-record-video-in-ios-simulator/) / [Screenify Studio](https://www.screenify.studio/blog/2026-04-19-record-xcode-simulator) / [Apple dev forum on early recordVideo audio gap](https://developer.apple.com/forums/thread/109407)
- [Apple dev forum — testing installTap for AVAudioEngine](https://developer.apple.com/forums/thread/649693) / [tap format-mismatch](https://developer.apple.com/forums/thread/689452) / [minimum buffer size](https://developer.apple.com/forums/thread/797033)
- [Visualizing audio frequency spectrum via Accelerate/vDSP FFT](https://www.myuiviews.com/2016/03/04/visualizing-audio-frequency-spectrum-on-ios-via-accelerate-vdsp-fast-fourier-transform.html)
- [tomer8007/real-time-audio-fft](https://github.com/tomer8007/real-time-audio-fft)
- [aubio command-line tools manual](https://aubio.org/manual/latest/cli.html)
- [Renée Desporte — Detecting Frequencies in Audio Signals with Python](https://www.reneedesporte.com/2024/08/02/detecting-frequencies-in-audio-signals-with-python/)
- [endolith — Frequency estimation methods (gist)](https://gist.github.com/endolith/255291)
- [SHOEBOX PureTest](https://www.shoebox.md/products/shoebox-puretest/)
- [hearX Group hearScreen](https://hearxgroup.com/products/hearscreen) / [Portable Audiometric Screening PDF](https://www.hearxgroup.com/assets/documents/PortableAudiometricScreening.pdf)
- [PMC: Hearing Tests on Mobile Devices, Biological Calibration](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4906240/)
- [PMC: Biologically Calibrated Mobile Devices vs Pure-Tone Audiometry](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5784183/)
- [PMC: Android free-app hearing-loss assessment reliability](https://pmc.ncbi.nlm.nih.gov/articles/PMC11306450/)
- [Dove Press: Hearing Test App for Android — Distinctive Features](https://www.dovepress.com/the-hearing-test-app-for-android-devices-distinctive-features-of-pure--peer-reviewed-fulltext-article-MDER)
- [PMC: Evaluation of Accuracy/Reliability of a Mobile Screening Audiometer](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7201107/)
- [Room EQ Wizard SPL calibration docs](https://www.roomeqwizard.com/help/help_en-GB/html/inputcal.html)
- [Apple TN2204 — Audio Unit Validation Using auval](https://developer.apple.com/library/archive/technotes/tn2204/_index.html) / [Moonbase auval walkthrough](https://moonbase.sh/articles/debugging-your-audio-unit-plugin-with-auval-aka-auvaltool/)

---

**Repo/file context (not modified, referenced for scope only):** `/home/user/iheartest/CLAUDE.md` (the standing device-only-bug policy and Mark-review ritual this roadmap builds on), `/home/user/iheartest/qa/unit/` (target location for the Phase 1 tone-correctness spec), `/home/user/iheartest/.github/workflows/ios-depot.yml` (the existing proven Depot signing/upload pipeline the Phase 2 simulator workflow runs alongside, not inside).