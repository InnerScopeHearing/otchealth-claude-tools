# Real-device cloud farms for iOS

# Cloud-Hosted Real iOS Device Farms for Headless CI (GitHub Actions) — Research Report

## Executive summary

- **No provider lets you test the literal TestFlight-signed `.ipa`.** BrowserStack, Sauce Labs, LambdaTest, and AWS Device Farm all require **ad-hoc, enterprise, or development** code signing — App Store/TestFlight distribution profiles are explicitly rejected. This means adding one extra `xcodebuild -exportArchive` step to `ios-depot.yml` (same archive, different `exportOptionsPlist`) to produce a device-farm-specific IPA alongside the TestFlight one — not a rebuild, just a second export.
- **All four mainstream players are genuinely headless/CI-native** (REST API or Appium/XCUITest WebDriver endpoint) — this is not a differentiator between them. The real differentiators are **billing floor** and **entitlement handling**.
- **Entitlement stripping is the sleeper blocker.** BrowserStack, Sauce Labs, and LambdaTest all **re-sign your app with their own wildcard/enterprise profile by default**, which drops entitlements. AWS Device Farm is explicit and hard about it: re-signing strips **HealthKit, HomeKit, Push Notifications, In-App Purchase, App Groups, Apple Pay, and more** — a real problem if you ever want to exercise HealthKit (the AirPods-audiogram idea) or RevenueCat/IAP flows on-device via a farm.
- **Best fit for "occasional, small-team, pay-as-you-go":** **AWS Device Farm**, metered at **$0.17/device-minute with no monthly floor** (you already hold AWS credit), for pure audio-routing/UI/mute-switch/AirPods-Bluetooth checks that don't need HealthKit/IAP entitlements intact. For runs that *must* preserve entitlements, **Sauce Labs Real Device Cloud** (private devices, `resigningEnabled=false`) is the more capable but subscription-floored (~$199–249/mo) option.
- **Firebase Test Lab for iOS is alive, not deprecated**, and is the one platform that *forces* real physical hardware (no simulator fallback for iOS) — worth a low-cost pilot for a native XCUITest smoke pass, but it's XCTest/XCUITest-only (no generic Appium), has a much smaller device catalog, and a 45-minute-per-run cap.

---

## 1. BrowserStack App Automate

**Headless/CI-triggered:** Yes. App Automate is the automation product (distinct from App Live, which is the interactive click-a-device product). It exposes a full REST API to upload an `.ipa`, trigger XCUITest/Appium runs, and poll results — this is exactly what a GitHub Actions job would call. ([App Automate REST API overview](https://www.browserstack.com/docs/app-automate/api-reference/introduction), [XCUITest via API](https://www.browserstack.com/docs/app-automate/api-reference/xcuitest/overview), [BrowserStack + GitHub Actions writeup](https://medium.com/identity-intelligence/automating-mobile-app-beta-testing-on-browserstack-with-github-actions-53c62100a34b))

**IPA compatibility:** Must be exported **Ad Hoc, Enterprise, or Development** — "for iOS, you can use any of the currently available distribution techniques, **except App Store kind**." A separate export step is required; the same TestFlight archive cannot be uploaded as-is. ([IPA creation docs](https://www.browserstack.com/docs/app-automate/appium/references/ipa-creation))

**Resigning/entitlements:** BrowserStack **re-signs your app with its own wildcard provisioning profile by default**, which **removes App Groups, Push Notifications, Associated Domains, and other entitlements**. You can disable resigning (`resigningEnabled=false` / `resignApp=false`) only if you already have an **Enterprise-signed** app, and only on **Custom Device Lab / Private Devices** (an add-on tier) — and disabling it also breaks WebView automation (`get-task-allow` isn't present in enterprise profiles). ([Entitlements troubleshooting](https://www.browserstack.com/docs/app-automate/appium/troubleshooting/entitlements-error), [Re-sign iOS apps](https://www.browserstack.com/docs/app-automate/appium/resign-ios-apps), [Disable resigning](https://www.browserstack.com/docs/app-automate/appium/advanced-features/disable-resigning-of-apps))

**Audio:** Audio *input* injection (upload a file to feed the mic) is documented, but explicitly **Android-only** in the docs found. Audio *output* is captured as part of the session's recorded video, which you can pull down after the run and analyze offline (ffmpeg/spectral analysis) for playback verification. No dedicated iOS-side "verify speaker output" API was found. ([Media injection overview](https://www.browserstack.com/real-device-features/media-injection-and-audio-streaming), [Audio/video testing guide](https://www.browserstack.com/guide/audio-video-testing-on-real-devices))

**Pricing:** App Automate is **$249/mo month-to-month or $199/mo annual, for 1 parallel session**, "unlimited" minutes/users at that concurrency. Each *additional* parallel session costs another full plan fee. There is **no metered/pay-per-run tier** — it's a flat monthly subscription regardless of how many runs/month you actually use. ([BrowserStack pricing summary](https://www.trustradius.com/products/browserstack/pricing), [Bug0 pricing guide](https://bug0.com/knowledge-base/browserstack-pricing))

---

## 2. Sauce Labs Real Device Cloud (RDC)

**Headless/CI-triggered:** Yes. RDC integrates natively with CI (Jenkins, GitHub Actions, etc.) via Appium/XCUITest against Sauce's WebDriver endpoint, and via API for run orchestration. ([Real Device Cloud product page](https://saucelabs.com/products/mobile-testing/real-device-cloud))

**IPA compatibility:** Needs an **ad-hoc or enterprise-signed** `.ipa` (their cookbook literally has a "Creating an ipa File" doc); App Store/TestFlight profiles are not the supported path. ([Creating real device .ipa files](https://docs.saucelabs.com/mobile-apps/automated-testing/ipa-files/), [Exporting ad hoc IPA](https://docs.saucelabs.com/testfairy/sdk/ios/ad-hoc-ipa/))

**Resigning/entitlements:** Sauce **re-signs by default on public devices** ("Sauce Labs has taken care of all that by re-provisioning your apps for our devices, on the fly"). You can disable resigning **only on Private Devices** (a paid add-on where you dedicate real hardware and sign it yourself with your own ad-hoc profile or enterprise cert). Their public GitHub issue tracker literally has an open question ("What iOS entitlements does Sauce automatic resigning support?") — treat entitlement preservation as something to verify empirically before relying on it. ([iOS App Resigning docs](https://docs.saucelabs.com/mobile-apps/features/ios-app-resigning/), [Private Devices](https://saucelabs.com/products/private-devices-real-device-cloud), [Entitlements GitHub issue](https://github.com/saucelabs/sauce-docs/issues/840))

**Audio:** Sauce has a dedicated **Audio Capture** feature on RDC — audio is captured as part of the session video and you can play it back on the Test Results page after the run; there's also live audio streaming for interactive sessions. This is the most explicit audio-verification story among the "big four." ([Audio Capture docs](https://docs.saucelabs.com/mobile-apps/features/audio-capture/), [Audio capture changelog](https://changelog.saucelabs.com/en/audio-capture-available-on-rdc))

**Pricing:** Subscription, **$199/mo annual ($249/mo month-to-month), 1 parallel session, "unlimited" automated + live minutes**. Same shape as BrowserStack — a flat monthly floor, not true pay-per-run. Real-device add-ons for teams needing broader private-device coverage run higher (reported $3,000–$8,000/yr range in third-party pricing writeups). ([Sauce Labs pricing page](https://saucelabs.com/pricing))

---

## 3. AWS Device Farm

**Headless/CI-triggered:** Yes, and this is AWS's most mature story for "occasional, no-standing-infra" use. `aws devicefarm schedule-run` (CLI/SDK/API) is a first-class fire-and-forget call — schedule, then poll `get-run`. Community GitHub Actions exist (`realm/aws-devicefarm`, `aws-actions/aws-devicefarm-mobile-device-testing`) and it composes trivially with a plain `aws-cli` step in any workflow. ([schedule-run CLI reference](https://docs.aws.amazon.com/cli/latest/reference/devicefarm/schedule-run.html), [aws-devicefarm GitHub Action](https://github.com/realm/aws-devicefarm), [official Automating Device Farm docs](https://docs.aws.amazon.com/devicefarm/latest/developerguide/api-ref.html))

**iOS status (2026):** Live and current — AWS updated the iOS test-environment experience October 31, 2025 to bring it in line with Android's setup. Runs on Amazon-managed macOS hosts that connect to the physical iOS device for the duration of the run; supports XCUITest and Appium. ([What is AWS Device Farm](https://docs.aws.amazon.com/devicefarm/latest/developerguide/welcome.html), [Test environment for iOS](https://docs.aws.amazon.com/devicefarm/latest/developerguide/custom-test-environments-hosts-ios.html))

**IPA compatibility:** Needs a non-App-Store `.ipa`; the service **replaces the embedded provisioning profile with a wildcard profile and re-signs the app automatically** on upload — you don't hand-manage ad-hoc device UUIDs, but you also can't opt out.

**Resigning/entitlements — the hard blocker:** AWS is explicit that re-signing **strips App Group, Associated Domains, Game Center, HealthKit, HomeKit, Wireless Accessory Configuration, In-App Purchase, Inter-App Audio, Apple Pay, Push Notifications, and VPN Configuration & Control.** There is no documented opt-out for public devices. For iHEARtest specifically: fine for pure UI/audio-hardware/AirPods-routing/mute-switch QA; **not usable** for any run that needs to exercise HealthKit or RevenueCat/IAP end-to-end.

**Other real limits:** 150-minute hard cap per automated run, default 5 concurrent devices (raisable by request), 250-minute in-flight job soft cap, 4 GB app size, 1 GB video/log truncation. ([Limits in AWS Device Farm](https://docs.aws.amazon.com/devicefarm/latest/developerguide/limits.html))

**Pricing — the one true pay-as-you-go option:** **$0.17/device-minute metered, with a one-time 1,000-minute free trial and no monthly subscription floor.** A handful of runs per release (the stated use case) could realistically cost single-digit-to-low-double-digit dollars per release cycle. There's also an **unmetered device-slot plan at $250/device-slot/month** (concurrency-based) if usage ever crosses ~1,470 min/device/month, but for "a few runs per release" the metered path is the economically correct one and is genuinely usage-based, unlike BrowserStack/Sauce/LambdaTest's flat monthly minimums. ([AWS Device Farm FAQs / pricing](https://aws.amazon.com/device-farm/faqs/), [pricing walkthrough](https://getautonoma.com/blog/aws-device-farm-pricing))

---

## 4. Firebase Test Lab (iOS)

**Current status:** **Still live for iOS, not deprecated** — the official docs (`firebase.google.com/docs/test-lab/ios/*`) were current as of this research and show no deprecation notice. It is narrower than the "big three," not dead. ([Get started with Test Lab for iOS](https://firebase.google.com/docs/test-lab/ios/get-started), [Available testing devices](https://firebase.google.com/docs/test-lab/ios/available-testing-devices))

**Framework:** **XCTest/XCUITest only — no Appium, no generic WebDriver.** You build an `.xctestrun` bundle via `xcodebuild build-for-testing`, zip it, and hand it to `gcloud firebase test ios run`. For a Capacitor app whose test suite is Vitest/JS (like iHEARtest's `qa/unit`), this means writing a **thin native XCUITest smoke wrapper** (tap through onboarding, run a hearing test, verify state) rather than reusing existing JS specs. ([Run an XCTest](https://firebase.google.com/docs/test-lab/ios/run-xctest), [Command-line docs](https://firebase.google.com/docs/test-lab/ios/command-line))

**Real-device guarantee — the one genuine positive:** iOS Test Lab has **no simulator option; it runs XCUITest exclusively on real physical hardware**, which is actually a stronger real-hardware guarantee than the other providers' default "resigned app on a shared real device" model gives you (no entitlement-stripping resign step was found documented for Test Lab specifically, though device selection and time budget are the tradeoff).

**Headless/CI:** Straightforward — `google-github-actions/setup-gcloud` + `gcloud firebase test ios run` from any GitHub Actions job; multiple public writeups do exactly this. ([Flutter + gcloud + Test Lab + GitHub Actions example](https://medium.com/@matheusdeveloper.henrique/flutter-integration-test-with-gcloud-firebase-testlab-and-github-actions-31ba1f2c173c))

**Limits:** 45-minute max per physical-device test, a materially smaller device/OS-version catalog than BrowserStack/Sauce/LambdaTest, and — per multiple third-party guides — no built-in test sharding or retry mechanism (you'd own that in the workflow).

**Pricing:** Pay-per-device-hour on the Blaze plan (roughly comparable in shape to AWS Device Farm's metered model — no flat monthly subscription), plus a small free daily quota. Worth a cheap pilot precisely because there's no subscription commitment.

---

## 5. LambdaTest (TestMu AI) Real Device Cloud

**Headless/CI-triggered:** Yes — point Appium/XCUITest capabilities at `mobile-hub.lambdatest.com/wd/hub` with an access key; documented integrations for GitHub Actions, GitLab, CircleCI, Jenkins, Azure DevOps. ([Real Device Cloud product page](https://www.lambdatest.com/intl/en-de/real-device-cloud))

**Pricing:** Real-device automation tiers step from **$139/mo (virtual devices)** to **$199/mo (real devices)**, in the same "flat monthly subscription, not metered" family as BrowserStack/Sauce. ([LambdaTest pricing](https://www.lambdatest.com/pricing))

**Signing/entitlements:** Not independently verified in this pass beyond general industry pattern (device farms universally require ad-hoc/enterprise/dev signing and most auto-resign); treat as **needs direct confirmation with LambdaTest support/docs** before committing — it was not dug into as deeply as the top three given time budget, and its device catalog/API maturity for iOS specifically is less battle-tested in what was found than BrowserStack/Sauce.

---

## 6. HeadSpin

**What it actually offers that's different:** HeadSpin's **AV Box** is real dedicated hardware (a patent-pending appliance) that captures true analog audio/video output off the device and computes audio-loudness/MOS-style quality scores and audio-video sync analysis — this is a materially deeper audio-hardware verification story than "audio track embedded in a screen recording," which is what BrowserStack/Sauce offer. ([HeadSpin AV testing platform](https://www.headspin.io/solutions/av-testing), [AV Box overview](https://digitalrishabh01.medium.com/how-to-transform-audio-video-testing-with-headspin-av-box-0457dbedc5bb))

**Pricing:** Reported enterprise contracts in the **$50,000–$100,000+/year** range — not a realistic fit for "a few runs per release" from a small team. Flagged for completeness and because it's the only provider found with genuine hardware-level audio measurement, worth revisiting if/when a dedicated audio-QA budget exists, not now.

---

## 7. Kobiton, Perfecto, Bitbar/Testdroid

- **Kobiton**: minute-based pricing, **$83/mo entry for 1,000 minutes**, scaling to $417–$833/mo for 5,000–10,000 minutes — notably cheaper entry point than BrowserStack/Sauce/LambdaTest and worth a closer look if the "flat $199+/mo" floor of the majors is unattractive, but signing/entitlement behavior for iOS was not independently verified here. ([Kobiton pricing overview](https://g2.com/products/kobiton/pricing))
- **Perfecto**: REST-API-capable device cloud, but pricing is effectively custom/enterprise (reported **$30K+/yr**) beyond its cheap manual-testing entry tier — not a fit for occasional small-team automated use. ([Perfecto Mobile Device Cloud](https://www.perfecto.io/product/mobile-device-cloud))
- **Bitbar (formerly Testdroid)**: usage-based/enterprise pricing, dedicated device pools; no clear cheap self-serve API tier was found in this pass.

---

## 8. Cheap "single real device, API-controlled" alternatives

- **AWS Device Farm's metered per-minute billing ($0.17/min, no monthly floor)** is, in practice, the closest thing to genuine pay-as-you-go among the credible options, and you already have AWS credit — this is the strongest "just a few runs per release" fit if entitlement stripping is acceptable for that run's purpose.
- **Firebase Test Lab** is the other real no-subscription option (Blaze pay-per-device-hour + a small free daily allotment), at the cost of XCUITest-only tooling and a narrower device list.
- **ServerCore Mobile Device Farm** advertises literal per-minute device rental ("from one minute to several hours") — smaller/less-established vendor, not independently vetted for iOS-specific automation depth or CI-API maturity here; worth a spike if AWS/Firebase don't pan out. ([ServerCore product page](https://servercore.com/services/mobile-device-farm/))
- **TestingBot Private Device Cloud** and Sauce/BrowserStack "Private Devices" tiers exist ("we buy the specific devices you want, dedicate them to you") but they're priced as ongoing dedicated-hardware contracts, not pay-per-run, and are overkill for "a few runs per release."

---

## Bottom line / recommendation

For iHEARtest's actual failure modes — AVAudioSession/AirPods routing, Web Audio unlock, physical mute-switch state — none of which need HealthKit or IAP entitlements intact:

1. **Pilot AWS Device Farm first.** It's the only option with genuinely usage-based pricing matching "a few runs per release," you already hold AWS credit, and the CLI (`schedule-run`/`get-run`) drops cleanly into a step after `ios-depot.yml`'s existing archive/export. Export a second ad-hoc-signed IPA from the same archive; accept that HealthKit/Push/IAP-dependent flows can't be exercised there.
2. **Reserve Sauce Labs RDC (private devices, resigning disabled)** for the smaller set of runs that specifically need entitlements preserved (e.g., a RevenueCat/IAP smoke flow) — it has the best-documented entitlement-preservation and audio-capture story of the subscription-tier providers, at a real ~$199+/mo floor, so use it selectively rather than for every build.
3. **Prototype Firebase Test Lab** as a zero-commitment, forced-real-hardware XCUITest smoke check (boot + first-screen + hearing-test-happy-path) — cheap to try, and its "no simulator, real device only" guarantee for iOS is a genuine positive even with the narrower tooling.
4. **Skip BrowserStack App Automate and LambdaTest** for this specific need — they land in the same $199–249/mo subscription-floor + default-resigning bucket as Sauce Labs without a clearer entitlement or audio-verification advantage over it.
5. **Skip HeadSpin for now** (best-in-class audio-hardware measurement, but $50K+/yr — revisit only if a dedicated audio-QA budget appears) and **treat Kobiton as a to-verify cheaper alternative** if the $199+/mo floor of the majors becomes a blocker.