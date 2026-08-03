# iOS Simulator automation in CI

# iOS Simulator Headless CI Research Report

## Executive summary

- **Yes, this is straightforward and well-trodden.** A GitHub Actions macOS runner (including Depot's `depot-macos-26`) can boot a simulator, install a **simulator build** (`.app` bundle built with `-destination 'platform=iOS Simulator,...'`, not a distribution/device build), launch it, and drive it — all with zero human interaction, via `xcodebuild` + `xcrun simctl`. This does NOT require Apple signing/provisioning at all (simulator builds are unsigned/ad-hoc-signed by the OS), so it is a fully separate, cheaper pipeline from your existing TestFlight archive-and-sign job.
- **Two credible automation layers exist on top of the raw simulator**: (a) **XCUITest**, native, runs via `xcodebuild test`/`test-without-building`, drives real taps/permission dialogs, and natively supports headless video (`xcodebuild ... -resultBundlePath`) and screenshot capture through the test API itself; (b) **Maestro**, which you already use for device flows — it has an official GitHub Action, but note the two Maestro paths diverge: **Maestro Cloud** (upload the `.app`, tests run on Maestro's own cloud simulators, not your runner) vs. **local/self-hosted Maestro CLI against a simulator you boot yourself on the runner** (this is the one that fits your "everything stays on Depot" model).
- **Depot's macOS runners preinstall the iOS/iPadOS/watchOS/tvOS/visionOS simulator runtimes**, so simulator-based CI doesn't pay a runtime-download tax on every run — this is a real, sourced Depot claim, distinct from vanilla GitHub-hosted `macos-latest` runners where runtime availability varies by image and sometimes needs `xcodes runtimes install` or Xcode-version switching.
- **The hard limitation for your specific app is real and not fixable in CI**: HealthKit, live camera capture, and Bluetooth/AirPods hardware routing are **not implemented in the Simulator at all** (official Apple/Xcode behavior, not a bug) — so anything in iHEARtest touching HealthKit-audiogram ideas, live camera, or AirPods audio routing genuinely cannot be verified in CI and still needs the physical iPhone 16 Pro / TestFlight step you already do. Audio *output* correctness (the calibrated test-tone question) also has no clean programmatic verification path in Simulator — see finding #4 below, it's a real gap, not just an oversight.
- **What this buys you concretely**: CI-gated regression coverage for everything that lives above the hardware boundary — screen navigation, permission-dialog flows, push-notification handling, UI state after simulated interruptions, and (this is the big one for a native Capacitor app) **catching native-plugin bridge crashes and native-vs-web layout bugs that your Playwright/WebKit viewport tests structurally cannot see**, before a build ever reaches TestFlight/Mark's review.

---

## 1. Booting a Simulator and installing/launching a build, fully headless

**Confirmed possible, standard tooling, no human interaction needed.**

The pipeline is two `xcodebuild`/`xcrun` calls:

1. **Build for the simulator** (not for device/distribution):
   ```
   xcodebuild build -workspace App.xcworkspace -scheme App \
     -configuration Debug -sdk iphonesimulator \
     -destination 'platform=iOS Simulator,name=iPhone 16 Pro,OS=latest' \
     CONFIGURATION_BUILD_DIR=$PWD/build
   ```
   Building "for testing" (`build-for-testing`) produces the `.app` plus a `.xctestrun` file describing exactly how to run tests against it — useful for splitting build and test into separate CI jobs/machines. [xcodebuild.xctestrun(5) man page](https://keith.github.io/xcode-man-pages/xcodebuild.xctestrun.5.html), [Speed up iOS CI using Test Without Building (XCBlog/Medium)](https://medium.com/xcblog/speed-up-ios-ci-using-test-without-building-xctestrun-and-fastlane-a982b0060676)

2. **Boot, install, launch** with `simctl` (bash-first control plane for simulators — no Xcode GUI involved):
   ```
   xcrun simctl boot "iPhone 16 Pro"          # or use a specific UDID
   xcrun simctl install booted /path/to/App.app
   xcrun simctl launch booted com.yourorg.yourapp
   ```
   [xcrun simctl cheat sheet / React Native SME Cookbook](https://reactnative.codeguides.io/cli/xcrun-simctl-and-ios-simulators/), [iOS Simulator for Testing: Practical CLI Guide](https://yarygintech.com/articles/ios_simulator_testing_guide/)

   CI-specific advice found repeatedly: **prefer a UDID over the `booted` alias** in scripts once more than one simulator might be running, to avoid ambiguity. [Finding iOS simulator identifiers for CI](https://www.mickf.net/tech/finding-ios-simulators-identifiers/)

- For running actual XCTest/XCUITest bundles instead of just launching the app, `xcodebuild test` (build+test together) or `xcodebuild test-without-building -xctestrun MyTestRun.xctestrun -destination 'platform=iOS Simulator,name=iPhone 16 Pro'` (using the artifact from step 1) are both officially documented commands. The latter is the standard way to decouple "compile once" from "run tests on N simulators/devices in parallel." [Apple Developer Forums thread on test-without-building](https://developer.apple.com/forums/thread/675249), [Bitrise's xcode-test-without-building step](https://github.com/bitrise-steplib/bitrise-step-xcode-test-without-building)

**A basic GitHub Actions example** (confirmed pattern from multiple independent sources, `macos-latest` runner):
```yaml
jobs:
  test-ios:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - run: xcodebuild test -scheme 'YourScheme' \
             -destination 'platform=iOS Simulator,name=iPhone 14,OS=16.0'
```
[GitHub Actions for iOS CI/CD (TechConcepts)](https://techconcepts.org/blog/github-actions-ios), [How to Set up GitHub Actions for CI with Xcode (Quality Coding)](https://qualitycoding.org/github-actions-ci-xcode/), [How to use GitHub Actions for testing Xcode project? (vmois.dev)](https://vmois.dev/xcode-github-actions/)

### Depot specifically

- Depot's macOS runner labels: `depot-macos-26` (M4 hardware, macOS 26/Tahoe, Xcode 26.5 — matches your existing pin), `depot-macos-15`/`depot-macos-latest` (M2, macOS 15), `depot-macos-14` (M2, macOS 14). [Depot changelog: macOS 26 beta for GitHub Actions](https://depot.dev/changelog/2026-05-26-macos-26-beta-github-actions), [Depot runner types docs](https://depot.dev/docs/github-actions/runner-types)
- **Confirmed claim, sourced to Depot's own material surfaced via search**: "The iOS, iPadOS, watchOS, tvOS, and visionOS simulator runtimes are preinstalled on Depot's macOS runners, so simulator-based tests don't download them on every run." I was not able to independently re-confirm the exact wording by direct page fetch (Depot's docs pages I fetched directly, `runner-types` and the `mac-github-actions` blog post, did not themselves contain this sentence when fetched — they only cover hardware specs/pricing), so **treat this as a claim needing a quick live-verify** (`xcrun simctl list runtimes` in an actual Depot job) rather than Apple-docs-grade certainty. It is plausible and consistent with Depot's stated "disk accelerator + preinstalled Xcode" performance pitch, but I'm flagging the confidence level explicitly per your skepticism ask. [Depot blog: Now available: macOS GitHub Actions runners](https://depot.dev/blog/mac-github-actions-runners), [Depot GitHub Actions runner types](https://depot.dev/docs/github-actions/runner-types)
- Depot also documents a RAM-backed disk accelerator that speeds up Actions I/O, relevant to simulator boot/install times specifically since simulator I/O is disk-heavy. [Depot: macOS runners are now twice as fast](https://depot.dev/blog/ultra-runners-for-macos)

**Practical recommendation**: add a `xcrun simctl list runtimes` + `xcrun simctl list devicetypes` step as the first line of any new simulator-CI job on `depot-macos-26` and log it — cheap, and it turns "we assume the runtime is there" into a verified fact on every run.

---

## 2. Driving the simulator: XCUITest vs. Maestro, and producing artifacts

### XCUITest (native, no extra vendor)
- Runs via the same `xcodebuild test` / `test-without-building` calls above — no separate tool needed, it's built into Xcode.
- **Permission dialogs**: XCUITest's `addUIInterruptionMonitor(withDescription:handler:)` registers a handler that auto-taps system alert buttons (e.g., camera/mic/notification permission prompts) whenever one appears during a test interaction — genuinely headless, no human needed:
  ```swift
  addUIInterruptionMonitor(withDescription: "System Dialog") { alert in
      if alert.buttons["Allow"].exists { alert.buttons["Allow"].tap(); return true }
      return false
  }
  app.tap() // triggers monitor check
  ```
  [XCTest: Interaction with iOS alerts and permissions (Medium)](https://medium.com/@akhmat-s/xctest-interaction-with-ios-alerts-and-permissions-in-ui-testing-c800bb94983d), [Handling System Alerts In UI Tests (Use Your Loaf)](https://useyourloaf.com/blog/handling-system-alerts-in-ui-tests/)
- **Even better for CI determinism**: pre-grant/deny permissions before the app even asks, via `simctl privacy`, so the dialog never appears at all and you don't need an interruption monitor for that permission:
  ```
  xcrun simctl privacy booted grant microphone com.yourorg.yourapp
  xcrun simctl privacy booted reset all com.yourorg.yourapp   # for a clean first-run test
  ```
  Supports camera, microphone, location, photos/media, contacts, health, and more. [simctl privacy discussion (fastlane GitHub)](https://github.com/fastlane/fastlane/discussions/18900), [Reset iOS Simulator Privacy Permissions](https://dheerajn.github.io/til/reset-simulator-privacy-permissions/)
- **Artifacts**: pass `-resultBundlePath ./TestResults.xcresult` to `xcodebuild`, then upload that whole bundle with `actions/upload-artifact@v4` (add `if: always()` so it uploads even on failure — the default GH Actions behavior skips later steps after a failing step). `.xcresult` bundles already embed captured screenshots on assertion failures and any explicit `XCTAttachment` screenshots you add in test code. Third-party GitHub Actions (`kishikawakatsumi/xcresulttool`) render `.xcresult` into a readable GitHub Checks report. [Using xcresult files with GitHub Actions (Al Wold)](https://alwold.com/posts/xcresults-on-github-actions/), [xcresulttool GitHub Action](https://github.com/marketplace/actions/xcresulttool), [How to Manage Artifacts in GitHub Actions](https://oneuptime.com/blog/post/2026-01-25-github-actions-artifacts/view)
- **Video, independent of XCUITest**: `xcrun simctl io booted recordVideo --codec h264 ci-recording.mp4` records whatever happens on-screen during that window; run it backgrounded around your test invocation and upload the mp4. Confirmed to work on GitHub Actions macOS runners, Bitrise, and CircleCI macOS executors. `xcrun simctl io booted screenshot out.png` for stills. [simctl: Control iOS Simulators from Command Line (XCBlog)](https://medium.com/xcblog/simctl-control-ios-simulators-from-command-line-78b9006a20dc), [Tools I Love: xcrun simctl io booted recordVideo (Eli Perkins)](https://iosfeeds.com/read/28285)

### Maestro — two materially different CI paths, don't conflate them
- **Maestro Cloud path** (official `mobile-dev-inc/action-maestro-cloud` GitHub Action): your GH Actions job only *builds* the `.app` on a macOS runner and uploads it; the actual simulator boot + flow execution happens on Maestro's own cloud infrastructure, not your Depot runner.
  ```yaml
  runs-on: macOS-latest
  steps:
    - uses: actions/checkout@v2
    - run: xcodebuild build -scheme 'MyApp' -configuration Debug \
           -project 'MyApp.xcodeproj' \
           -destination 'generic/platform=iOS Simulator' \
           CONFIGURATION_BUILD_DIR=$PWD/build
    - uses: mobile-dev-inc/action-maestro-cloud@v2.0.2
      with:
        api-key: ${{ secrets.MAESTRO_CLOUD_API_KEY }}
        project-id: ${{ secrets.MAESTRO_PROJECT_ID }}
        app-file: build/MyApp.app
  ```
  [Maestro docs: GitHub Actions platform guides](https://docs.maestro.dev/maestro-cloud/ci-cd-integration/github-actions/platform-guides) — note: this is a paid/managed Maestro Cloud product, not "free simulator time on your own runner."
- **Local/self-hosted Maestro CLI on your own macOS runner**: install the Maestro CLI directly on the Depot macOS runner (`curl -Ls "https://get.maestro.mobile.dev" | bash`), boot the simulator yourself with `simctl` as in Section 1, install your `.app`, then run `maestro test flow.yaml` against `booted`. This is the path that keeps everything inside your existing Depot spend instead of adding a Maestro Cloud subscription, and it's the natural fit since you already maintain Maestro flows for device testing — the same `.yaml` flows can likely target the simulator with no rewrite. I found the official docs for this self-hosted variant thin (my direct fetch of `docs.maestro.dev/maestro-cloud/ci-cd-integration/github-actions/platform-guides` only documented the Cloud path); a team blog independently describes running "on a self-hosted runner: a Mac mini server" for full simulator control, which is the same idea generalized from "Mac mini" to "Depot macOS runner." [Integrating Maestro with CI/CD for Cloud Testing](https://maestro.dev/insights/maestro-ci-cd-cloud-testing-integration), [Self-Hosting Maestro Mobile Tests (Chick-fil-A Tech / Medium)](https://medium.com/chick-fil-atech/self-hosting-maestro-mobile-tests-b320d8f3e86e) — **recommend a short spike to confirm the self-hosted-CLI-on-simulator path works exactly as expected before committing to it**, since I could not pull the official doc page verbatim.

### Real-world Capacitor/hybrid-app precedent
I could not find a Capacitor-specific open-source project doing simulator UI testing on every PR (Capacitor's own CI docs focus on build/release, not simulator testing — [Capacitor CI/CD guide](https://capacitorjs.com/docs/guides/ci-cd)). The closest verified real-world precedent is **React Native + Detox**, which is architecturally the same problem (hybrid/JS-bridge app, native simulator testing in GH Actions):
```yaml
runs-on: macos-latest
timeout-minutes: 15
steps:
  - uses: actions/checkout@v3
  - uses: actions/setup-node@v3
    with: { cache: 'yarn' }
  - run: yarn
  - run: brew tap wix/brew && brew install applesimutils
  - run: yarn detox build e2e --configuration ios.sim.release
  - run: yarn detox test e2e --configuration ios.sim.release --cleanup --debug-synchronization 200
  - uses: actions/upload-artifact@v3
    if: failure()
    with: { path: e2e/artifacts }
```
[edvinasbartkus/react-native-detox-github-actions (full repo)](https://github.com/edvinasbartkus/react-native-detox-github-actions), [ios.yml workflow file](https://github.com/edvinasbartkus/react-native-detox-github-actions/blob/master/.github/workflows/ios.yml), [Running React Native Detox tests on GitHub Actions (remarkablemark)](https://remarkablemark.org/blog/2023/02/18/how-to-run-react-native-detox-tests-on-github-actions/), [DEV.to walkthrough](https://dev.to/edvinasbartkus/running-react-native-detox-tests-for-ios-and-android-on-github-actions-2ekn). Detox itself is a gray-box E2E framework (not plain XCUITest), but the CI shape — macOS runner, build for simulator, drive it, upload artifacts on failure — is directly transferable to an XCUITest- or Maestro-based iHEARtest pipeline. Note this example also flags a real footgun: a GitHub issue titled "Simulator not launching on CI workflow with Expo" confirms simulator-boot flakiness is a known live issue in this exact category of setup, not hypothetical. [wix/Detox issue #4357](https://github.com/wix/Detox/issues/4357)

---

## 3. What does and doesn't work correctly in Simulator — confirmed per-capability

| Capability | Simulator status | Source |
|---|---|---|
| **HealthKit** | **Not available.** "The iOS Simulator has no Health data and testing must always be done on a real iPhone." Even where partial HealthKit API calls don't crash, background delivery / background execution testing explicitly requires real hardware. | [HealthKit iOS 2026 guide + forum threads](https://medium.com/@garejakirit/apple-healthkit-in-ios-2026-the-complete-swift-guide-step-by-step-0d4215b54412) |
| **Audio playback (AVAudioSession, output only)** | Simulator plays audio through the **host Mac's** output device — it does route and technically "work," so basic play/pause/route-change logic is exercisable. But this is playback through the Mac's audio stack, not the iOS device audio stack, so it does not validate real iPhone speaker/output-hardware behavior. | [iOS Simulator audio behavior notes](https://www.appcoda.com/ios-avfoundation-framework-tutorial/) |
| **Audio capture (microphone via AVFoundation Capture)** | **Not supported.** "AVFoundation Capture does not run in the simulator" — `AVCaptureAudioDataOutput` and similar capture APIs require a physical device. The Simulator's mic input is a pass-through to the host Mac's mic (useful for manual dev, not for CI verification). | [AVFoundation Capture / Simulator limitations](https://developer.apple.com/library/archive/samplecode/AVCaptureToAudioUnit/Introduction/Intro.html) |
| **Bluetooth / AirPods routing** | **Not supported at all.** Apple's own now-archived Technical Note TN2295 states Core Bluetooth apps must be tested on a real device with Bluetooth 4.0 before App Review submission, "should not base your app submission on the success of running only in the iOS simulator." This has been true since early BLE support and remains current. | [Apple TN2295 (archived)](https://developer.apple.com/library/archive/technotes/tn2295/_index.html), [dev forum confirmations](https://developer.apple.com/forums/thread/661675) |
| **Physical mute/silent switch** | There is no simulated hardware switch, and — separately — **there is no public iOS API on real devices either** to programmatically read the switch state. Developers commonly detect it indirectly on-device by playing a short silent-category sound and timing it. Since there's no switch-state signal on device OR simulator, CI cannot validate silent-switch behavior either way; this stays a manual/TestFlight-device check, which matches your existing "silent switch" gotcha note. | [No native API for mute switch (dev forum roundup)](https://developer.apple.com/forums/thread/40988) |
| **Camera (live capture)** | **Not supported natively.** "Xcode's Simulator does not come with camera support; apps won't discover any capture device," and apps typically fall back to a placeholder/no-camera-found UI path. `UIImagePickerController`'s **photo library** picker (choosing an existing image) *does* work in Simulator and can be scripted/pre-seeded, so photo-library-based flows are testable even though live-camera flows are not. Third-party tools (SimCam, RocketSim) can inject a Mac webcam feed into Simulator's camera API for manual dev use, but that's a developer convenience tool, not something to build CI assertions against. | [Simulator Camera: Test without a physical device (SwiftLee)](https://www.avanderlee.com/xcode/simulator-camera-test-your-app-without-a-physical-device/), [RocketSim iOS Simulator Camera docs](https://www.rocketsim.app/docs/features/capturing/simulator-camera-support/) |
| **Push notifications (remote, APNs-shaped payload)** | **Supported via simctl**, fully scriptable/headless: `xcrun simctl push booted com.yourorg.yourapp payload.json`, or omit the bundle-id argument if the JSON payload includes `"Simulator Target Bundle"`. This lets you assert your app's notification-handling code (foreground presentation, deep-link routing, badge updates) entirely in CI without a real push infrastructure round-trip. **Confirmed limitation**: VoIP, Complication, and File Provider notification types are *not* supported via this path. | [simctl push command reference (SwiftLee/Sparrow Code roundup)](https://tanaschita.com/testing-remote-push-notifications-in-ios-simulator/), [Send Push Notifications to iOS Simulator (Medium/Globant)](https://medium.com/globant/send-push-notifications-to-the-ios-simulator-3a78b6689cf) |
| **Permission dialogs (camera/mic/notifications/location, etc.)** | Fully headless-drivable two ways: (a) pre-grant/deny via `xcrun simctl privacy booted grant|revoke|reset <service> <bundle-id>` before the app ever asks, or (b) let the dialog appear and auto-dismiss it via XCUITest's `addUIInterruptionMonitor`. Both are confirmed, standard patterns. | [simctl privacy (fastlane discussion)](https://github.com/fastlane/fastlane/discussions/18900), [XCUITest interruption monitor pattern](https://medium.com/@akhmat-s/xctest-interaction-with-ios-alerts-and-permissions-in-ui-testing-c800bb94983d) |

---

## 4. Programmatically verifying calibrated audio *output correctness* — the real gap

This is the one question where I want to be explicit that **I did not find a clean, confirmed answer**, and I'd rather tell you that than paper over it.

What's confirmed:
- Simulator audio output plays through the **host Mac's** CoreAudio output device, not a virtualized iOS audio pipeline — so at minimum, "does my code call play() and does *something* come out" is exercisable by ear on the runner (impractical for CI) or by capturing the Mac's system audio output stream.
- The clean-in-theory route is a **virtual/loopback CoreAudio output device on the runner's macOS host** (e.g., BlackHole or Apple's own aggregate/multi-output device features) set as the Mac's default output, so that when the Simulator "plays" your calibrated tone, it's actually writable to a file on the host — then you FFT/analyze that captured audio programmatically (frequency, amplitude, duration) against expected values.
- I did **not** find an official Apple doc, a Depot doc, or a real project confirming this loopback-capture pattern works reliably and unattended inside a GitHub Actions/Depot macOS runner specifically (permissions for virtual audio drivers, runner image restrictions, and headless-session CoreAudio quirks are all plausible blockers I could not rule out from search alone). This is a genuine research gap, not a "no" — it would need a short hands-on spike on an actual `depot-macos-26` runner (install a loopback driver via Homebrew in the workflow, set it as system default output, boot simulator, play your test tone, capture N seconds via `ffmpeg`/`sox` against the loopback device, run an FFT assertion) before you could rely on it.
- Realistically, given your `packages/shared`-style "pure, testable" architecture pattern already used elsewhere in the portfolio (e.g., Flatstick's money math): the **much higher-confidence path** is to unit-test the tone-generation/calibration *logic* in isolation (pure functions producing the PCM buffer/frequency table you intend to play, asserted directly in Vitest with no audio hardware involved at all), and treat "does it actually come out of a real speaker correctly" as a device-only, human/TestFlight-gated check — which is effectively what you already do. CI-verified simulator audio would only add confidence about the *code path that invokes playback* (Web Audio/AVAudioSession calls happening, not erroring, not silently no-op'ing), not about acoustic correctness.

---

## 5. Recommended shape for your pipeline (synthesis, not sourced — my recommendation)

Given everything above, and given your actual constraint set (no Mac, no device, Depot `depot-macos-26` already proven for the signed TestFlight path):

1. **Add a second, separate GitHub Actions workflow** (`ios-simulator-qa.yml`), triggered on PR (not on every push, to control Depot macOS-minute burn — you already track this concern for the Depot grant), that:
   - Runs on `depot-macos-26` (same Xcode 26 pin as your build pipeline, for consistency).
   - Builds the Capacitor iOS project for `iphonesimulator` (no signing needed at all — this is the big win, it's a completely separate, credential-free path from your ASC-key TestFlight job).
   - Boots one simulator (`iPhone 16 Pro` to match your real test device's screen, or add a couple more device/OS combos if you want matrix coverage later), pre-grants any permissions your flows need via `simctl privacy`, installs, launches.
   - Runs your **existing Maestro flow YAMLs** against `booted` (spike this first — confirm your device-flow YAMLs work unmodified against a simulator target) as the fastest path to reuse, OR write a thin XCUITest target if you want native-Swift-level control (e.g., to assert on native-plugin bridge state, not just visible UI).
   - Captures `simctl io booted recordVideo` for the whole run + `xcresult`/Maestro's own artifacts, uploaded via `actions/upload-artifact@v4` with `if: always()`.
2. **Scope it honestly**: this pipeline catches native-plugin crashes, permission-flow bugs, push-notification handling bugs, and native-vs-web layout/rendering bugs — the exact class of bug your Playwright/WebKit-viewport tests structurally cannot see. It does **not** replace the Mark/TestFlight device review for HealthKit, live camera, Bluetooth/AirPods routing, silent-switch behavior, or acoustic audio correctness — those stay real-device-gated, permanently, by Apple's own platform design, not by a tooling gap you can close.
3. Given the audio-capture uncertainty in Section 4, don't build the loopback-capture CI check speculatively — spike it standalone first, time-boxed, before committing pipeline architecture to it.

---

## Sources index (all citations used above)

- [Depot: macOS GitHub Actions runners announcement](https://depot.dev/blog/mac-github-actions-runners)
- [Depot: macOS 26 changelog](https://depot.dev/changelog/2026-05-26-macos-26-beta-github-actions)
- [Depot: GitHub Actions runner types docs](https://depot.dev/docs/github-actions/runner-types)
- [Depot: macOS runners twice as fast (disk accelerator)](https://depot.dev/blog/ultra-runners-for-macos)
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
- [Apple TN2295: Testing Core Bluetooth in Simulator (archived)](https://developer.apple.com/library/archive/technotes/tn2295/_index.html)
- [Bluetooth-in-simulator forum confirmation](https://developer.apple.com/forums/thread/661675)
- [HealthKit 2026 guide](https://medium.com/@garejakirit/apple-healthkit-in-ios-2026-the-complete-swift-guide-step-by-step-0d4215b54412)
- [AVFoundation Capture / CoreAudio sample (capture doesn't run in simulator)](https://developer.apple.com/library/archive/samplecode/AVCaptureToAudioUnit/Introduction/Intro.html)
- [Mute switch: no native API, forum roundup](https://developer.apple.com/forums/thread/40988)
- [Simulator Camera limitations (SwiftLee)](https://www.avanderlee.com/xcode/simulator-camera-test-your-app-without-a-physical-device/)
- [RocketSim Simulator Camera docs](https://www.rocketsim.app/docs/features/capturing/simulator-camera-support/)
- [simctl push notification reference](https://tanaschita.com/testing-remote-push-notifications-in-ios-simulator/)
- [Push notifications to Simulator (Medium/Globant)](https://medium.com/globant/send-push-notifications-to-the-ios-simulator-3a78b6689cf)
- [simctl privacy grant/revoke/reset (fastlane discussion)](https://github.com/fastlane/fastlane/discussions/18900)
- [Reset iOS Simulator Privacy Permissions](https://dheerajn.github.io/til/reset-simulator-privacy-permissions/)
- [XCUITest addUIInterruptionMonitor pattern](https://medium.com/@akhmat-s/xctest-interaction-with-ios-alerts-and-permissions-in-ui-testing-c800bb94983d)
- [Handling System Alerts In UI Tests (Use Your Loaf)](https://useyourloaf.com/blog/handling-system-alerts-in-ui-tests/)
- [simctl io recordVideo / screenshot (XCBlog)](https://medium.com/xcblog/simctl-control-ios-simulators-from-command-line-78b9006a20dc)
- [Tools I Love: recordVideo (Eli Perkins)](https://iosfeeds.com/read/28285)
- [Using xcresult files with GitHub Actions (Al Wold)](https://alwold.com/posts/xcresults-on-github-actions/)
- [xcresulttool GitHub Action](https://github.com/marketplace/actions/xcresulttool)
- [Managing GitHub Actions artifacts](https://oneuptime.com/blog/post/2026-01-25-github-actions-artifacts/view)
- [Maestro GitHub Actions platform guides (Cloud path)](https://docs.maestro.dev/maestro-cloud/ci-cd-integration/github-actions/platform-guides)
- [Maestro CI/CD cloud testing integration overview](https://maestro.dev/insights/maestro-ci-cd-cloud-testing-integration)
- [Self-Hosting Maestro Mobile Tests (Chick-fil-A Tech)](https://medium.com/chick-fil-atech/self-hosting-maestro-mobile-tests-b320d8f3e86e)
- [Capacitor official CI/CD guide](https://capacitorjs.com/docs/guides/ci-cd)
- [react-native-detox-github-actions repo](https://github.com/edvinasbartkus/react-native-detox-github-actions)
- [ios.yml Detox workflow file](https://github.com/edvinasbartkus/react-native-detox-github-actions/blob/master/.github/workflows/ios.yml)
- [Running Detox tests on GitHub Actions (remarkablemark)](https://remarkablemark.org/blog/2023/02/18/how-to-run-react-native-detox-tests-on-github-actions/)
- [Detox tests on GitHub Actions walkthrough (DEV.to)](https://dev.to/edvinasbartkus/running-react-native-detox-tests-for-ios-and-android-on-github-actions-2ekn)
- [wix/Detox issue #4357: simulator not launching on CI](https://github.com/wix/Detox/issues/4357)

Report also saved to `/tmp/claude-0/-home-user/aa7d8953-f624-5cd3-aa61-945e29a59ee3/scratchpad/ios-simulator-ci-research.md` (title placeholder only — the full content above is the deliverable; let me know if you want it written into that file properly or into a repo for the team).