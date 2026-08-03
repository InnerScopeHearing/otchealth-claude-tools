# HealthKit + native plugin Simulator/CI limitations

# iOS Simulator Capabilities Report: HealthKit, Silent Switch, AVAudioSession, and Bluetooth

## Executive Summary

For iHEARtest's four hardware-dependent surfaces, the Simulator boundary is unambiguous and consistent across Apple's own documentation, sample code, and Developer Technical Support (DTS) engineer replies on the forums:

| Capability | Simulator-testable? | Source authority |
|---|---|---|
| **HealthKit** (general quantity samples, e.g. writing audiogram data) | **No.** `isHealthDataAvailable()` is unreliable/false in Simulator across every Xcode version checked (including a 2025 report on Xcode 16.4 / iOS 18.5). The Simulator's one documented "sample data" feature is scoped narrowly to Health *Records* (FHIR/clinical), a different HealthKit subsystem, not general quantity samples. | Apple docs + multiple forum threads |
| **Silent/mute switch state** | **No, fundamentally.** There is no public API at all, on Simulator or device. Apple staff have said on the record that this is deliberate. | Apple staff forum replies |
| **AVAudioSession category logic / that audio plays at all** | **Partially.** The API surface (category/mode setting, routing calls) works and Simulator does emit audio through the host Mac's output. Real frequency/level accuracy, real speaker/headphone/AirPods response, and real silent-switch interaction are device-only. | Official Apple doc (exact bullet list below) |
| **Bluetooth / CoreBluetooth / AirPods** | **No.** Explicitly, officially unsupported. No sanctioned mocking exists either. | Official Apple doc + DTS engineer quotes |

Apple's closest thing to an official "testing pyramid" for this class of problem is not one unified WWDC session, but a consistent pattern DTS engineers repeat: **wrap the non-mockable system API behind your own protocol/adapter, unit-test everything above that seam with a fake, and validate the thin adapter itself only on real hardware** (an approach they state explicitly for CoreBluetooth and implicitly for HealthKit and audio).

---

## 1. HealthKit in the Simulator

**`HKHealthStore.isHealthDataAvailable()`** — per Apple's own reference doc, this returns whether HealthKit is available on *this device*, and if it returns `false`, every other HealthKit call fails with `HKError.errorHealthDataUnavailable`. Apple's documented reason `isHealthDataAvailable()` can be `false` is platform-based (e.g., HealthKit is not available on iPad / Mac Catalyst), but empirically it is also unreliable in Simulator. [isHealthDataAvailable()](https://developer.apple.com/documentation/healthkit/hkhealthstore/ishealthdataavailable()) · [errorHealthDataUnavailable](https://developer.apple.com/documentation/healthkit/hkerror/errorhealthdataunavailable)

Forum evidence spans years and Xcode versions, so this isn't a stale, long-fixed issue:
- ["iOS Simulator Cannot Read the Health…"](https://developer.apple.com/forums/thread/692302) — read queries return zero samples even after data is written/visible in the Simulator's Health app UI. (Apple's accepted answer in that thread actually turned out to be an app bug, not a Simulator limitation — worth noting HealthKit bugs and Simulator limitations get conflated in the wild, so read carefully before citing a thread as "Simulator can't do X.")
- ["Extremely persistent HealthKit rea…"](https://developer.apple.com/forums/thread/799086) — as recently as **Xcode 16.4 / macOS 15.5 / iOS 18.5 (2025)**, a developer tested identically on both Simulator and a personal device and hit the same read-authorization confusion on both. The Apple Frameworks Engineer's accepted-answer reply is separately important for iHEARtest regardless of Simulator/device: **"To help maintain the privacy of sensitive health data, HealthKit does not tell you when the user denies your app permission to query data. Instead, it simply appears as if HealthKit does not have any data matching your query."** `sharingDenied` only describes *write* permission; for *read* permission there is no distinguishable denied state, ever, on device or Simulator. Any HealthKit test strategy (device or Simulator) has to treat "empty result set" as ambiguous between "no data" and "denied," by design.
- ["XCode + HealthKit on a simulator"](https://developer.apple.com/forums/thread/12407) — an old but illustrative thread where a developer explicitly asks whether the capability requires a real device to even explore, because Xcode wouldn't enable it without one connected.

**The one Simulator-side HealthKit feature Apple does document is narrower than it looks.** ["Accessing Sample Data in the Simulator"](https://developer.apple.com/documentation/healthkit/accessing-sample-data-in-the-simulator) is filed under Apple's **Health Records** documentation set (alongside ["Accessing Health Records"](https://developer.apple.com/documentation/healthkit/accessing-health-records) and ["Accessing a User's Clinical Records"](https://developer.apple.com/documentation/HealthKit/accessing-a-user-s-clinical-records)), which is the FHIR/clinical-records subsystem (`HKClinicalRecord`, hospital/health-system data), **not** the general quantity-sample surface (`HKQuantitySample`, `HKCategorySample`) that an app like iHEARtest would use to write audiogram-derived data. Forum corroboration: ["Simulate Health Clinical records"](https://developer.apple.com/forums/thread/652290) confirms the feature is specifically about enabling "Health Records" sample accounts (Browse tab → Add Account, three sample accounts, requires the simulated device's region be set to US/CA/GB) — a clinical-records UI feature, not a general HealthKit data store. **Do not read this feature as evidence that general HealthKit read/write works reliably in Simulator; it addresses a different, narrower part of the framework.**

**Apple's recommended testing strategy is inferred, not published as a single "HealthKit + testing" guide.** No official Apple doc says "here is how to unit-test HealthKit in Simulator." The pattern Apple *does* publish (see §5) is to keep `HKHealthStore` calls behind your own thin protocol/adapter type, inject a fake implementing that protocol for unit tests of your business logic, and only exercise the real `HKHealthStore` on a physical device. This is consistent with the general framework-mocking guidance Apple gives for other non-mockable system types (see the CoreLocation example in §5) and with the `HKHealthStore` API itself being a `final class` that cannot be subclassed.

**Bottom line for iHEARtest:** treat HealthKit read/write as device-only for verification purposes. Simulator can be used to smoke-test that your app *doesn't crash* when `isHealthDataAvailable()` returns `false` (which is close to guaranteed in Simulator), but not to validate that a write actually lands or that a read actually retrieves it.

---

## 2. The physical mute/ring switch

There is **no public API, full stop** — this is fundamental, not a Simulator gap that XCUITest or any flag can paper over.

- ["How can I detect when the mute switch has been toggled?"](https://developer.apple.com/forums/thread/649638) — an Apple staff member's reply is the clearest statement of intent found: **"...you are working against the physical mute switch, which will mute your audio automatically if your category is .ambient. Back in the day (maybe still now) we specifically didn't let apps see the mute switch state, to avoid them trying to do for themselves what should be common behavior throughout the system (driven by the app's declared AVAudioSession category)."** This frames it as deliberate policy, not an oversight.
- ["Is it possible to listen physical mute/unmute ring state?"](https://developer.apple.com/forums/thread/760503) — a DTS Engineer's reply is explicit that the private Darwin-notify workaround some third-party plugins use (`com.apple.springboard.ringerstate`) is **not sanctioned**: **"Unless otherwise documented, Darwin notify keys are not considered API."** Volume-button changes (`AVAudioSession.sharedInstance().observe(\.outputVolume)`) are a documented, working substitute for detecting *volume* button presses, but that is a different signal from ringer/silent-switch position and does not reveal switch state.
- [`secondaryAudioShouldBeSilencedHint`](https://developer.apple.com/documentation/avfaudio/avaudiosession/secondaryaudioshouldbesilencedhint) is a real, documented API, but it answers a different question ("should my secondary/non-essential audio duck because something else, e.g. another app or a phone call, needs the audio focus"), not "is the physical switch in the silent position." It should not be used as a mute-switch proxy.

**Implication for `@capgo/capacitor-mute`:** whatever private mechanism that plugin reads (Darwin notification, `AVAudioSession` heuristics, or similar), it is inherently using an undocumented signal Apple has stated it deliberately does not expose. Because there's no API, there's also nothing for the Simulator to simulate, and nothing XCUITest can toggle — this is unconditionally device-only, and testing it means physically flipping the switch on Mark's/Matt's iPhone 16 Pro.

**One documented, useful escape hatch:** Apple's docs on the [`.playback` category](https://developer.apple.com/documentation/avfaudio/avaudiosession/category-swift.struct/playback) confirm official behavior that **audio set to the `.playback` category continues to play even when the Ring/Silent switch is set to silent** — the switch is documented to *not* silence `.playback`-category audio, only `.ambient`/`.soloAmbient`. This is directly relevant to iHEARtest's calibrated-tone playback: if the test-tone playback session is `.playback` category (as it should be for a clinical-grade instrument, so a user's silent switch can never accidentally suppress a test tone), the switch's position is provably irrelevant to whether tones play, which somewhat de-risks the "silent switch" concern for the tone-playback path itself, even though the *detector* (the UI feature that presumably warns the user "turn off silent mode") remains untestable outside real hardware.

---

## 3. AVAudioSession / audio playback in Simulator

Apple's own comparison document is the primary authority here: **["Testing in Simulator versus testing on hardware devices"](https://developer.apple.com/documentation/xcode/testing-in-simulator-versus-testing-on-hardware-devices)**. Its "Unsupported Hardware" list (confirmed via two independent fetches of the same content) is:

> Ambient light sensor, **audio input (except Siri)**, barometer, Bluetooth, camera, motion support (accelerometer/gyroscope), proximity sensor.

Two things to note precisely:
- **Audio *input* is unsupported except for Siri.** Audio *output/playback* is not on this unsupported list at all — Simulator does route app audio output through the host Mac's audio output device (speakers/headphones connected to the Mac), which is why setting `AVAudioSessionCategory`/mode and calling play APIs "works" in Simulator in the sense that you'll hear sound and no error is thrown.
- **What "works" does not mean "is representative."** The category/mode/route *API surface* (e.g., `setCategory(.playAndRecord, mode: .measurement, options: [...])`) can be called successfully in Simulator, but the actual acoustic chain (iPhone/AirPods DAC, speaker frequency response, real dB SPL calibration, real headphone impedance, real Bluetooth audio routing) is entirely a Mac's audio hardware standing in for the device's — meaningless for verifying calibrated-tone frequency/level accuracy. This is the same conclusion Apple's document draws generally for the Simulator: **"Use hardware devices to do performance testing for processing, graphics, and networking to ensure accurate results,"** and by clear extension, for anything acoustically precise.
- Community-reported quality bugs reinforce not trusting Simulator audio even qualitatively: a forum thread (["Simulator causing Mac audio distor…"](https://developer.apple.com/forums/thread/668170)) describes crackling/distortion specific to certain macOS/Xcode combinations — a further reason Simulator playback shouldn't be used even as a rough proxy for tone fidelity.
- Route/output-device switching (Bluetooth/AirPods specifically) is unavailable, per §4 below — Simulator can't exercise "does my session correctly hand off to AirPods," only "does my session code run without throwing."

**Bottom line:** Simulator is useful for confirming your AVAudioSession *code path* executes (category set succeeds, playback starts/stops, no exceptions, correct duration/timing logic) but cannot validate anything about real frequency accuracy, real playback level/dB SPL, real headphone/AirPods routing, or real interaction with the silent switch's acoustic effect — those require the physical iPhone 16 Pro test devices.

---

## 4. Bluetooth (CoreBluetooth / AirPods)

**Explicitly and officially unsupported.** The same Apple document above lists **"Bluetooth"** directly under Simulator's unsupported hardware, alongside camera and motion sensors.

- The historical workaround, **Technical Note TN2295 "Testing Core Bluetooth Applications in the iOS Simulator"** (proposing a direct USB Bluetooth LE HCI adapter connection), is now an Apple-labeled **["Retired Document"](https://developer.apple.com/library/archive/technotes/tn2295/_index.html)** — Apple no longer endorses this path, and it dates to 2012-era Simulator internals that no longer apply.
- Current official guidance is thin (no dedicated modern doc), but DTS engineer replies on the forums are unambiguous and recent:
  - **Argun Tekant, DTS Engineer (Apple Core Technologies):** *"There is no officially supported way of mocking BLE devices. CoreBluetooth works with a lot of back and forth between the app, the Bluetooth stack, and the devices, and if you need to mock a proprietary device, you would need to implement the complete GATT protocol, and you would still be missing HCI level issues that might pop. So, you may find it more useful to conduct your tests with actual peripherals."* ([thread](https://developer.apple.com/forums/thread/764024))
  - **Quinn "The Eskimo!", DTS Engineer**, on attempting to instantiate `CBPeripheral` via a private initializer for test purposes: *"This is not supported. By heading down this path you open yourself up to all sorts of weird compatibility issues in the future."* (same thread) — reinforcing that subclassing/private-init tricks around CoreBluetooth types are a dead end, not a sanctioned test seam.
  - **edorphy (Apple forum contributor)** on architecture: *"If your goal is to test your logic, this is the way to do it [separate logic from radio]. If your goal is to exercise radio functionality and transmit and receive packets, you should use UI Tests and have your physical device in proximity to your CI machine."* (same thread) — this is the closest thing to an official "here's the split" statement Apple staff have given.
- A **July 2025** forum thread specifically titled ["Best Practices for Unit Testing CoreBluetooth Applications - Seeking Official Guidance"](https://developer.apple.com/forums/thread/794138) confirms the same four structural problems still stand today (no subclassing CoreBluetooth types, no simulator support, only the retired TN2295, community mocking libraries like Nordic's `CoreBluetoothMock` filling the gap) — as of this capture the thread had **zero replies**, i.e., Apple still has not shipped updated, current official guidance on this topic as a standalone document.

**Bottom line:** Bluetooth/AirPods audio routing is 100% device-only. There is no Apple-sanctioned simulator path, no sanctioned mock of `CBCentralManager`/`CBPeripheral`, and the only retired workaround (TN2295) is explicitly deprecated by Apple itself.

---

## 5. Apple's general guidance on structuring tests for hardware-dependent code

Apple has no single canonical "hardware testing pyramid" document, but three WWDC sessions plus the DTS forum quotes above converge on one consistent recommended architecture:

1. **["Testing Tips & Tricks" — WWDC 2018, session 417](https://developer.apple.com/videos/play/wwdc2018/417/).** The most directly relevant session. Core technique demonstrated: for an external/system class you don't control and can't subclass (the example used is `CLLocationManager`, structurally identical to `HKHealthStore` or `CBCentralManager` for this purpose), **define your own protocol matching the interface you actually use, inject that protocol as a dependency, and provide a mock/fake implementing it in tests** — explicitly *not* subclassing the real system type. The session states plainly that tests which "rely on device state... makes them harder to maintain and, ultimately, more likely to fail," i.e., Apple's own testing guidance actively discourages device-state-dependent tests wherever a fake can substitute, and reserves device-state dependence for the thin adapter layer only.
2. **["Testing in Xcode" — WWDC 2019, session 413](https://developer.apple.com/videos/play/wwdc2019/413/)**. Introduces **Test Plans**, which let you group and run the same test target under different configurations — a mechanism for maintaining a "Simulator plan" vs. a "device plan" so hardware-only suites don't run (and don't need to pass) where they can't.
3. **["XCTSkip your tests" — WWDC 2020, session 10164](https://developer.apple.com/videos/play/wwdc2020/10164/)**. Introduces `XCTSkip`/`XCTSkipIf`/`XCTSkipUnless`, described by Apple as intended precisely for **"integration tests that have requirements or dependencies that cannot easily be mocked out"** — the official, sanctioned way to write a test that only runs (and only needs to pass) on a real device, auto-skipping cleanly in Simulator (e.g., guard on `HKHealthStore.isHealthDataAvailable()`, on Bluetooth availability, or on a custom "is this running on Simulator" check) rather than failing or being manually excluded from the target.
4. **The CoreBluetooth DTS quotes in §4** are the most concrete instance of Apple staff actually stating the split explicitly: pure logic → ordinary `XCTest` unit tests against your protocol/fake; radio/hardware "exercise" → `XCUITest` UI tests with a physical device in CI proximity, not Simulator.

**Synthesized recommendation matching Apple's own stated pattern**, applicable to all four iHEARtest surfaces:
- Wrap `HKHealthStore`, the mute-switch signal, and `AVAudioSession`/Bluetooth-routing calls each behind a small app-owned protocol.
- Unit-test all business logic above that seam in Simulator/CI against fakes (this is where iHEARtest's existing Vitest-style discipline already fits, just ported to the native/Swift layer for these three plugin surfaces).
- Treat the thin adapter implementations themselves, plus anything acoustic (frequency/level accuracy) or radio-based (Bluetooth pairing/routing) or switch-based (silent switch), as **device-only verification**, gated with `XCTSkipUnless`/a Simulator check so CI doesn't fail on Simulator runners, and validated for real only on Mark's and Matt's iPhone 16 Pro devices via TestFlight — consistent with iHEARtest's CLAUDE.md rule that "Device-only classes of bugs (AVAudioSession, AirPods routing, Web Audio unlock, silent switch) can only be verified there."

---

## Sources

- [isHealthDataAvailable() — Apple Developer Documentation](https://developer.apple.com/documentation/healthkit/hkhealthstore/ishealthdataavailable())
- [errorHealthDataUnavailable — Apple Developer Documentation](https://developer.apple.com/documentation/healthkit/hkerror/errorhealthdataunavailable)
- [HKHealthStore — Apple Developer Documentation](https://developer.apple.com/documentation/HealthKit/HKHealthStore)
- [Accessing Sample Data in the Simulator — Apple Developer Documentation](https://developer.apple.com/documentation/healthkit/accessing-sample-data-in-the-simulator)
- [Accessing Health Records — Apple Developer Documentation](https://developer.apple.com/documentation/healthkit/accessing-health-records)
- [Accessing a User's Clinical Records — Apple Developer Documentation](https://developer.apple.com/documentation/HealthKit/accessing-a-user-s-clinical-records)
- ["iOS Simulator Cannot Read the Heal…" — Apple Developer Forums](https://developer.apple.com/forums/thread/692302)
- ["Extremely persistent HealthKit rea…" — Apple Developer Forums](https://developer.apple.com/forums/thread/799086)
- ["XCode + HealthKit on a simulator" — Apple Developer Forums](https://developer.apple.com/forums/thread/12407)
- ["Simulate Health Clinical records" — Apple Developer Forums](https://developer.apple.com/forums/thread/652290)
- [secondaryAudioShouldBeSilencedHint — Apple Developer Documentation](https://developer.apple.com/documentation/avfaudio/avaudiosession/secondaryaudioshouldbesilencedhint)
- ["How can I detect when the mute switch has been toggled?" — Apple Developer Forums](https://developer.apple.com/forums/thread/649638)
- ["Is it possible to listen physical mute/unmute ring state?" — Apple Developer Forums](https://developer.apple.com/forums/thread/760503)
- [playback (AVAudioSession.Category) — Apple Developer Documentation](https://developer.apple.com/documentation/avfaudio/avaudiosession/category-swift.struct/playback)
- [Testing in Simulator versus testing on hardware devices — Apple Developer Documentation](https://developer.apple.com/documentation/xcode/testing-in-simulator-versus-testing-on-hardware-devices)
- [Testing complex hardware device scenarios in Simulator — Apple Developer Documentation](https://developer.apple.com/tutorials/data/documentation/xcode/testing-complex-hardware-device-scenarios-in-simulator.md)
- ["Simulator causing Mac audio distor…" — Apple Developer Forums](https://developer.apple.com/forums/thread/668170)
- [Technical Note TN2295 (Retired) — Testing Core Bluetooth Applications in the iOS Simulator](https://developer.apple.com/library/archive/technotes/tn2295/_index.html)
- ["Mocking or simulating CBPeripheral…" — Apple Developer Forums](https://developer.apple.com/forums/thread/764024)
- ["Best Practices for Unit Testing CoreBluetooth Applications - Seeking Official Guidance" — Apple Developer Forums](https://developer.apple.com/forums/thread/794138)
- [Testing Tips & Tricks — WWDC 2018, session 417](https://developer.apple.com/videos/play/wwdc2018/417/)
- [Testing in Xcode — WWDC 2019, session 413](https://developer.apple.com/videos/play/wwdc2019/413/)
- [XCTSkip your tests — WWDC 2020, session 10164](https://developer.apple.com/videos/play/wwdc2020/10164/)

**Note on sourcing method:** direct `WebFetch` of several `developer.apple.com/documentation/...` pages returned only page titles (no renderable body, likely JS-rendered/paywalled-to-scrapers), so those specific claims are corroborated via (a) a community GitHub mirror of Apple's own doc markdown (`livingston/apple-docs`, fetched twice independently with consistent results for the "unsupported hardware" list) and (b) multiple independent search-engine-summarized excerpts of the live Apple pages, cross-checked against each other and against forum discussion for consistency. Everything attributed to a named DTS/Apple engineer is a direct quote pulled from the linked forum thread.