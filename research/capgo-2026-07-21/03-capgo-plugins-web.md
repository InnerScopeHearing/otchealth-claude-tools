# Capgo Plugin Catalog — Full Research Report (Live Website)

**Date:** 2026-07-21
**Sources:**
- https://capgo.app/plugins/ (master catalog page, all 150 plugins enumerated)
- Individual plugin pages under https://capgo.app/plugins/<slug>/ and https://capgo.app/docs/plugins/<slug>/ (58 plugins deep-dived individually, listed inline below; each fetch pulled npm package name, description, platforms, install command, key API methods, and stated caveats)
- Fleet context: OTCHealth Inc. 8-app Capacitor fleet (iHEARtest, AWARE, OTCHealth Companion, FourVault, Flatstick, InnerEase, Fictionary, PlantID), all iOS-first on Depot macOS CI, all wired with signed Capgo OTA channels under the org "OTCHealth Inc." Existing plugin usage: `@capgo/capacitor-updater` fleet-wide; iHEARtest additionally uses `capacitor-in-app-review`, `keep-awake`, `privacy-screen`, `sheets`, `transitions`, `video-player`, `webview-crash`, `webview-guardian`.

No em dashes used anywhere in this report (periods/commas per house style).

---

## 1. Catalog overview

The Capgo plugin directory (https://capgo.app/plugins/) lists **150 plugins across 13 categories**. Per the catalog page itself: "All 150 plugins are open-source." No pricing badges or paid labels are shown on the catalog page itself (pricing/tier detail, where it exists, lives on Capgo's separate OTA-update pricing page, not on the plugin catalog, and is out of scope for plugin-level pricing since the plugins themselves are npm packages, not metered services, except where a plugin explicitly requires a Capgo backend service, noted below for Notifications). Monthly npm download counts shown on individual plugin pages range from 0/month (very new plugins with no adoption yet) up to ~562k/month (the busiest plugin in the catalog, not deep-dived individually here but visible in the aggregate stat on the catalog page).

Category breakdown (plugin count per category, from the catalog page):

| Category | Count |
|---|---|
| Commerce | 8 |
| UI & System | 11 |
| Auth & Security | 22 |
| Analytics | 13 |
| Media | 19 |
| Files & Storage | 14 |
| Device APIs | 30 |
| Location | 5 |
| Communication | 12 |
| Updates | 6 |
| Developer Tools | 6 |
| Integrations | 4 |
| **Total** | **150** (Firebase sub-suite of 9 plugins is split across several of the categories above: App, Analytics, App Check, Authentication, Crashlytics, Firestore, Functions, Messaging, Performance, Remote Config, Storage) |

All npm packages observed use the `@capgo/` scope except the RevenueCat plugin (`@revenuecat/purchases-capacitor`), which Capgo lists in its directory as a third-party integration rather than an in-house Capgo package. Package manager convention shown throughout Capgo's own docs is `bun add <pkg> && bunx cap sync`, though `npm install <pkg> && npx cap sync` works identically and several individual plugin pages show the npm form instead of bun.

None of the 58 individually-fetched plugin pages stated an explicit Capacitor major-version compatibility number in the fetched excerpt, with one exception: **Device Info explicitly requires `@capacitor/core >=8.0.0`** (Capacitor 8+). Given Capgo is itself the maker of `@capgo/capacitor-updater` (the fleet's own OTA engine) and actively promotes Capacitor 8 in its docs, the working assumption for the rest of this report is that the catalog targets **Capacitor 6, 7, and 8** generally, with newer plugins (Device Info, LLM, Live Activities, Widget Kit, Watch) most likely to be Capacitor-8-only given their recency and iOS-26-era feature surface (Live Activities/Widget Kit/on-device LLM). This is an inference, not a documented fact, flagged as such.

---

## 2. Full enumerated catalog (all 150 plugins, name / description / URL)

### Commerce (8)
1. **Native Market** — Deep link users directly to your app page on Google Play Store or Apple App Store. https://capgo.app/plugins/capacitor-native-market/
2. **Purchases** — Implement in-app subscriptions and purchases with RevenueCat SDK for cross-platform monetization. https://capgo.app/plugins/purchases-capacitor/
3. **Native Purchases** — Implement native in-app purchases, subscriptions, and iOS StoreKit commitment billing plans. https://capgo.app/plugins/capacitor-native-purchases/
4. **AdMob** — Monetize your app with Google AdMob banner, interstitial, and rewarded ads. https://capgo.app/plugins/capacitor-admob/
5. **Pay** — Accept payments with Apple Pay and Google Pay for seamless checkout experience. https://capgo.app/plugins/capacitor-pay/
6. **Stripe** — Capacitor plugin for Stripe Payment Sheet, Apple Pay, and Google Pay. https://capgo.app/plugins/capacitor-stripe-pay/
7. **Stripe Identity** — Capacitor plugin for Stripe Identity verification. https://capgo.app/plugins/capacitor-stripe-identity/
8. **Stripe Terminal** — Capacitor plugin for Stripe Terminal in-person payments. https://capgo.app/plugins/capacitor-stripe-terminal/

### UI & System (11)
9. **Native Navigation** — Render native navbars, tabbars, and transition shells over a full-screen Capacitor WebView. https://capgo.app/plugins/capacitor-native-navigation/
10. **Native Loader** — Show native animated loaders, transparent overlays, Lottie assets, and WebView-resizing states. https://capgo.app/plugins/capacitor-native-loader/
11. **Transitions** — Add Ionic-style page transitions and iOS edge swipe-back gestures without Ionic UI. https://capgo.app/plugins/capacitor-transitions/ *(already used, iHEARtest)*
12. **Sheets** — Framework-agnostic sheets, drawers, dialogs, and overlay primitives optimized for Capacitor apps. https://capgo.app/docs/plugins/sheets/ *(already used, iHEARtest)*
13. **In App Browser** — Open managed in-app WebViews with native UI layering, private sessions, downloads, proxying. https://capgo.app/plugins/capacitor-inappbrowser/
14. **Navigation Bar** — Customize Android navigation bar color and visibility for immersive UI experiences. https://capgo.app/plugins/capacitor-navigation-bar/
15. **Indicator** — Hide or show iOS home indicator for fullscreen and immersive app experiences. https://capgo.app/plugins/capacitor-home-indicator/
16. **Live Activities** — Manage iOS Live Activities and Dynamic Island layouts from Capacitor with JSON-driven templates. https://capgo.app/plugins/capacitor-live-activities/
17. **Text Interaction** — Enable advanced text selection, copy-paste, and interaction features in web views. https://capgo.app/plugins/capacitor-textinteraction/
18. **Pretty Toast** — Native-first pretty toast notifications for Capacitor and the web. https://capgo.app/docs/plugins/pretty-toast/
19. **Widget Kit** — Build WidgetKit and Live Activity surfaces from Capacitor with SVG frames, timers, action hotspots. https://capgo.app/plugins/capacitor-widget-kit/

### Auth & Security (22)
20. **Native Biometric** — Secure authentication using Face ID, Touch ID, and Android biometric APIs. https://capgo.app/plugins/capacitor-native-biometric/
21. **Mock Location Detector** — Detect simulated GPS locations and developer tooling that enables spoofing apps. https://capgo.app/plugins/capacitor-mock-location-detector/
22. **Autofill Save Password** — Prompt users to save passwords to device autofill for seamless login experience. https://capgo.app/plugins/capacitor-autofill-save-password/
23. **Social Login** — Authenticate users with Google, Facebook, and Apple Sign-In for easy social login. https://capgo.app/plugins/capacitor-social-login/
24. **Passkey** — Keep browser-style WebAuthn code in Capacitor while native passkey calls and host patching handled. https://capgo.app/plugins/capacitor-passkey/
25. **App Attest** — Capacitor plugin for cross-platform device attestation using Apple App Attest and Google Play. https://capgo.app/plugins/capacitor-app-attest/
26. **reCAPTCHA** — Generate Web reCAPTCHA or reCAPTCHA Enterprise tokens plus native Enterprise mobile tokens. https://capgo.app/plugins/capacitor-recaptcha/
27. **Verisoul** — Collect Verisoul native fraud-prevention sessions from Capacitor apps on iOS and Android. https://capgo.app/plugins/capacitor-verisoul/
28. **Is Root** — Detect rooted Android or jailbroken iOS devices to enhance app security. https://capgo.app/plugins/capacitor-is-root/
29. **Privacy Screen** — Protect app content in Android screenshots and obscure the iOS app switcher snapshot. https://capgo.app/plugins/capacitor-privacy-screen/ *(already used, iHEARtest)*
30. **Persistent Account** — Preserve user authentication and account data across app reinstalls and updates. https://capgo.app/plugins/capacitor-persistent-account/
31. **Persistent UUID** — Generate and persist one app-scoped UUID across reinstalls, app updates, and OS updates. https://capgo.app/plugins/capacitor-persistent-uuid/
32. **Age Range** — Cross-platform age range detection using Google Play Age Signals and Apple DeclaredAgeRange. https://capgo.app/plugins/capacitor-age-range/
33. **Persona** — Launch Persona identity verification inquiries with native iOS and Android SDKs. https://capgo.app/plugins/capacitor-persona/
34. **Intune** — Microsoft Intune MAM, app protection policy, app config, and MSAL authentication for Capacitor. https://capgo.app/plugins/capacitor-intune/
35. **Age Signals** — Google Play Age Signals API wrapper, detect supervised accounts and verified users. https://capgo.app/plugins/capacitor-android-age-signals/
36. **SSL Pinning** — Pin HTTPS connections to bundled certificates for CapacitorHttp on iOS and Android. https://capgo.app/plugins/capacitor-ssl-pinning/
37. **WebView Guardian** — Detect when the WebView was killed in the background and relaunch it on foreground. https://capgo.app/plugins/capacitor-webview-guardian/ *(already used, iHEARtest)*
38. **WebView Crash** — Restart crashed WebViews natively and recycle long-running WebViews on a fixed interval. https://capgo.app/plugins/capacitor-webview-crash/ *(already used, iHEARtest)*
39. **WebView Version Checker** — Capacitor plugin for checking Android WebView version freshness and guiding users. https://capgo.app/plugins/capacitor-webview-version-checker/
40. **Firebase App Check** — Capacitor plugin for Firebase App Check. https://capgo.app/plugins/app-check/
41. **Firebase Authentication** — Capacitor plugin for Firebase Authentication. https://capgo.app/plugins/authentication/

### Analytics (13)
42. **AppsFlyer** — Add AppsFlyer attribution, analytics, deferred deep links, and OneLink support to your app. https://capgo.app/plugins/capacitor-appsflyer/
43. **Contentsquare** — Integrate Contentsquare mobile analytics, consent gating, screen tracking, and session replay. https://capgo.app/plugins/capacitor-contentsquare/
44. **Facebook Analytics** — Meta/Facebook App Events analytics with standard events, purchase logging, and tracking controls. https://capgo.app/plugins/capacitor-facebook-analytics/
45. **Usage Stats Manager** — Access Android usage statistics to track app usage time and screen time analytics. https://capgo.app/plugins/capacitor-android-usagestatsmanager/
46. **GTM** — Google Tag Manager integration for analytics and tracking. https://capgo.app/plugins/capacitor-gtm/
47. **RudderStack** — RudderStack analytics, identity resolution, screen tracking, and delivery controls for Capacitor. https://capgo.app/plugins/capacitor-rudderstack/
48. **App Tracking Transparency** — Request and check iOS App Tracking Transparency permission for IDFA access. https://capgo.app/plugins/capacitor-app-tracking-transparency/
49. **AppInsights** — Track app usage, performance metrics, and user behavior with Apptopia AppInsights. https://capgo.app/plugins/capacitor-appinsights/
50. **Firebase Analytics** — Capacitor plugin for Firebase Analytics. https://capgo.app/plugins/analytics/
51. **Firebase Crashlytics** — Capacitor plugin for Firebase Crashlytics. https://capgo.app/plugins/crashlytics/
52. **Firebase Performance** — Capacitor plugin for Firebase Performance Monitoring. https://capgo.app/plugins/performance/
53. **In App Review** — Prompt users to submit app store ratings and reviews without leaving your app. https://capgo.app/plugins/capacitor-in-app-review/ *(already used, iHEARtest)*
54. **Install Referrer** — Read Google Play install referrer data and Apple AdServices attribution from Capacitor. https://capgo.app/plugins/capacitor-install-referrer/

### Media (19)
55. **Camera Preview** — Display live camera feed as overlay with customizable controls and capture capabilities. https://capgo.app/plugins/capacitor-camera-preview/
56. **Flash** — Control device flashlight and torch with simple on/off toggle functionality. https://capgo.app/plugins/capacitor-flash/
57. **Screen Recorder** — Capture screen recordings with audio for tutorials, demos, and bug reports. https://capgo.app/plugins/capacitor-screen-recorder/
58. **Native Audio** — Play short audio files with low latency using native audio engine for games and apps. https://capgo.app/plugins/capacitor-native-audio/
59. **IVS Player** — Stream ultra-low latency live video using Amazon Interactive Video Service (IVS). https://capgo.app/plugins/capacitor-ivs-player/
60. **JW Player** — Embed JW Player for professional video streaming with ads and analytics support. https://capgo.app/plugins/capacitor-jw-player/
61. **Ricoh360 Camera** — Control Ricoh Theta 360-degree cameras for immersive panoramic photography. https://capgo.app/plugins/capacitor-ricoh360-camera-plugin/
62. **Audio Session** — Configure iOS audio session for background playback, mixing, and routing control. https://capgo.app/plugins/capacitor-audiosession/
63. **FFmpeg** — Video encoding and processing powered by FFmpeg for compression and conversion. https://capgo.app/plugins/capacitor-ffmpeg/
64. **Media Session** — Control media playback from lock screen and notification center. https://capgo.app/plugins/capacitor-media-session/
65. **Mux Player** — Stream adaptive bitrate video with Mux player for optimized playback quality. https://capgo.app/plugins/capacitor-mux-player/
66. **Photo Library** — Browse, save, and manage photos and videos in device photo library with permissions. https://capgo.app/plugins/capacitor-photo-library/
67. **Speech Recognition** — Natural, low-latency speech recognition with streaming partial results and cross-platform parity. https://capgo.app/plugins/capacitor-speech-recognition/
68. **Video Player** — Native video playback with subtitles, fullscreen, and comprehensive controls. https://capgo.app/plugins/capacitor-video-player/ *(already used, iHEARtest)*
69. **YouTube Player** — Embed YouTube videos with full player API control and event handling. https://capgo.app/plugins/capacitor-youtube-player/
70. **Speech Synthesis** — Synthesize speech from text with full control over language, voice, pitch, rate, and volume. https://capgo.app/plugins/capacitor-speech-synthesis/
71. **Audio Recorder** — Record audio on iOS, Android, and Web with simple controls and formats. https://capgo.app/plugins/capacitor-audio-recorder/
72. **File Compressor** — Efficient image compression supporting PNG, JPEG, and WebP formats across platforms. https://capgo.app/plugins/capacitor-file-compressor/
73. **Video Thumbnails** — Generate thumbnail images from local and remote video files at specific timestamps. https://capgo.app/plugins/capacitor-video-thumbnails/

### Files & Storage (14)
74. **Asset Cache** — Cache CDN images and videos in persistent app storage and bind them as local media sources. https://capgo.app/plugins/capacitor-asset-cache/
75. **Uploader** — Upload large files reliably in background with progress tracking and retry support. https://capgo.app/plugins/capacitor-uploader/
76. **Data Storage** — Store data locally using SQLite database with simple key-value API and encryption support. https://capgo.app/plugins/capacitor-data-storage-sqlite/
77. **Document Scanner** — Scan documents with auto edge detection, perspective correction, and PDF export. https://capgo.app/plugins/capacitor-document-scanner/
78. **Downloader** — Download large files in background with progress tracking and pause/resume support. https://capgo.app/plugins/capacitor-downloader/
79. **PDF Generator** — Create PDF documents from HTML templates for invoices, reports, and receipts. https://capgo.app/plugins/capacitor-pdf-generator/
80. **Fast SQL** — High-performance native SQLite with custom protocol for efficient sync operations. https://capgo.app/plugins/capacitor-fast-sql/
81. **Printer** — Capacitor plugin for printing documents, HTML, PDFs, images and web views. https://capgo.app/plugins/capacitor-printer/
82. **Zip** — A free Capacitor plugin for zipping and unzipping files on iOS, Android, and Web. https://capgo.app/plugins/capacitor-zip/
83. **File** — Full-featured file system plugin for reading, writing, and managing files and directories. https://capgo.app/plugins/capacitor-file/
84. **File Sharer** — Share and save files from base64 data or local paths across Android, iOS, and Web. https://capgo.app/plugins/capacitor-file-sharer/
85. **File Picker** — Pick files, images, videos, and directories with full native support including HEIC conversion. https://capgo.app/plugins/capacitor-file-picker/
86. **Firebase Firestore** — Capacitor plugin for Firebase Cloud Firestore. https://capgo.app/plugins/firestore/
87. **Firebase Storage** — Capacitor plugin for Firebase Cloud Storage. https://capgo.app/plugins/storage/

### Device APIs (30)
88. **Auto** — Bridge Capacitor apps with CarPlay and Android Auto template surfaces for two-way car communication. https://capgo.app/plugins/capacitor-auto/
89. **Calendar** — Manage native calendar events on iOS and Android, with iOS Reminders support. https://capgo.app/plugins/capacitor-calendar/
90. **Date Picker** — Native date, time, date-time, year-month, and range picker for iOS, Android, and Web. https://capgo.app/plugins/capacitor-date-picker/
91. **Device Info** — Read CPU, memory, GPU, storage, thermal state, and onboard sensor metrics from apps. https://capgo.app/plugins/capacitor-device-info/
92. **Notifications** — Send native iOS and Android push notifications from Capgo with user lookup and badges. https://capgo.app/plugins/capacitor-notifications/
93. **UWB** — Ultra-Wideband ranging for peer distance and direction on iOS and Android. https://capgo.app/plugins/capacitor-uwb/
94. **Mute** — Detect device mute switch state for iOS devices to handle audio playback appropriately. https://capgo.app/plugins/capacitor-mute/
95. **Shake** — Detect shake gestures on device for triggering actions like undo or feedback. https://capgo.app/plugins/capacitor-shake/
96. **Alarm** — Schedule native alarms and notifications even when app is closed. https://capgo.app/plugins/capacitor-alarm/
97. **Android Kiosk** — Lock Android devices into kiosk mode with launcher functionality and hardware key control. https://capgo.app/plugins/capacitor-android-kiosk/
98. **Background Task** — Schedule periodic background fetch tasks on iOS and Android with Expo-style task registration. https://capgo.app/plugins/capacitor-background-task/
99. **Health** — Access health and fitness data from native health platforms. https://capgo.app/plugins/capacitor-health/
100. **LLM** — Run Large Language Models locally on-device with Apple Intelligence and MLX support. https://capgo.app/plugins/capacitor-llm/
101. **Proximity** — Enable native proximity monitoring so your app can react when device is near a face or surface. https://capgo.app/plugins/capacitor-proximity/
102. **SIM** — Retrieve SIM card information including carrier name, country code, and phone number. https://capgo.app/plugins/capacitor-sim/
103. **Volume Buttons** — Capture hardware volume button presses for custom app controls and shortcuts. https://capgo.app/plugins/capacitor-volume-buttons/
104. **NFC** — Native NFC tag discovery, reading and writing for Capacitor apps on iOS and Android. https://capgo.app/plugins/capacitor-nfc/
105. **Barometer** — Access device barometer for atmospheric pressure and altitude readings. https://capgo.app/plugins/capacitor-barometer/
106. **Accelerometer** — Read device accelerometer for motion detection and orientation tracking. https://capgo.app/plugins/capacitor-accelerometer/
107. **Contacts** — Access and manage device contacts with read and write capabilities. https://capgo.app/plugins/capacitor-contacts/
108. **Pedometer** — Track steps, distance, pace, cadence, and floors with device pedometer sensors. https://capgo.app/plugins/capacitor-pedometer/
109. **Zebra DataWedge** — Manage Zebra DataWedge profiles, notifications, queries, and scan triggers on Zebra devices. https://capgo.app/plugins/capacitor-zebra-datawedge/
110. **WiFi** — Manage WiFi connectivity for your Capacitor app. https://capgo.app/plugins/capacitor-wifi/
111. **Screen Orientation** — Screen orientation plugin with support for bypassing orientation lock. https://capgo.app/plugins/capacitor-screen-orientation/
112. **Bluetooth Low Energy** — Full-featured BLE plugin for scanning, connecting, reading, writing, and receiving notifications. https://capgo.app/plugins/capacitor-bluetooth-low-energy/
113. **Keep Awake** — Prevent device screen from dimming or sleeping for video players, navigation, presentations. https://capgo.app/plugins/capacitor-keep-awake/ *(already used, iHEARtest)*
114. **Watch** — Apple Watch communication with bidirectional messaging between iPhone and watchOS apps. https://capgo.app/plugins/capacitor-watch/
115. **Brightness** — Control device screen brightness programmatically with app-specific and system-wide control. https://capgo.app/plugins/capacitor-brightness/
116. **Light Sensor** — Access the ambient light sensor to measure illuminance levels in lux with real-time updates. https://capgo.app/plugins/capacitor-light-sensor/
117. **Intent Launcher** — Launch Android intents, open system settings, and interact with other apps using Intent system. https://capgo.app/plugins/capacitor-intent-launcher/

### Location (5)
118. **Native Geocoder** — Convert addresses to coordinates and coordinates to addresses using native geocoding. https://capgo.app/plugins/capacitor-nativegeocoder/
119. **Background Geolocation** — Accurate background location tracking with native iOS and Android geofencing. https://capgo.app/plugins/capacitor-background-geolocation/
120. **Launch Navigator** — Open navigation apps like Google Maps or Apple Maps with directions to destinations. https://capgo.app/plugins/capacitor-launch-navigator/
121. **Compass** — Read device compass heading in degrees with continuous updates and permission handling. https://capgo.app/plugins/capacitor-compass/
122. **iBeacon** — iBeacon plugin for Capacitor, proximity detection and beacon region monitoring. https://capgo.app/plugins/capacitor-ibeacon/

### Communication (12)
123. **Crisp** — Integrate Crisp live chat and customer support directly into your mobile app. https://capgo.app/plugins/capacitor-crisp/
124. **Intercom** — Integrate Intercom live chat, help center, and support workflows in your Capacitor app. https://capgo.app/plugins/capacitor-intercom/
125. **MQTT** — MQTT support for real-time messaging across iOS, Android, and Web. https://capgo.app/plugins/capacitor-mqtt/
126. **Android SMS Retriever** — Read one app-targeted verification SMS without SMS permissions and request SIM phone hints. https://capgo.app/plugins/capacitor-android-sms-retriever/
127. **Streamcall** — Integrate video calling and live streaming with Stream SDK for real-time communication. https://capgo.app/plugins/capacitor-streamcall/
128. **Twilio Video** — Join Twilio Video rooms from Capacitor with native audio, camera, and room lifecycle events. https://capgo.app/plugins/capacitor-twilio-video/
129. **Twilio Voice** — Make and receive VoIP calls with Twilio Voice for in-app calling functionality. https://capgo.app/plugins/capacitor-twilio-voice/
130. **WeChat** — WeChat SDK for Capacitor, enables authentication, sharing, payments, and mini-programs. https://capgo.app/plugins/capacitor-wechat/
131. **Share Target** — Receive shared content from other apps, text, images, and files. https://capgo.app/plugins/capacitor-share-target/
132. **RealtimeKit** — Cloudflare Calls integration with built-in UI for video meetings and real-time communication. https://capgo.app/plugins/capacitor-realtimekit/
133. **Incoming Call Kit** — Present native incoming-call UI with iOS CallKit and Android full-screen notifications. https://capgo.app/plugins/capacitor-incoming-call-kit/
134. **Firebase Messaging** — Capacitor plugin for Firebase Cloud Messaging (FCM). https://capgo.app/plugins/messaging/

### Updates (6)
135. **Updater** — Deploy Ionic and Capacitor live updates instantly to your users without app store review delays. https://capgo.app/plugins/capacitor-updater/ *(already used, fleet-wide)*
136. **Electron Updater** — OTA live updates for Electron apps with the same API surface as capacitor-updater. https://capgo.app/plugins/electron-updater/
137. **Cordova Updater** — OTA live updates for Cordova iOS and Android with the same API as capacitor-updater. https://capgo.app/plugins/cordova-updater/
138. **Android Inline Install** — Install app updates directly within the app without leaving to Play Store. https://capgo.app/plugins/capacitor-android-inline-install/
139. **Live Reload** — Connect to your dev server for instant hot reloading during development. https://capgo.app/plugins/capacitor-live-reload/
140. **Capacitor Patch** — Apply version-gated Capacitor core, CLI, plugin, and native project patches during cap sync. https://capgo.app/plugins/capacitor-patch/

### Developer Tools (6)
141. **Env** — Securely manage environment variables and configuration across different build environments. https://capgo.app/plugins/capacitor-env/
142. **Network Diagnostics** — Run native network diagnostics for URL reachability, TCP ports, WebSocket handshakes, speed. https://capgo.app/plugins/capacitor-network-diagnostics/
143. **Capacitor+ Core** — Capacitor+ is an automated, always-synced fork of Capacitor with merged community PRs. https://capgo.app/plugins/capacitor-plus/
144. **Capacitor+ CLI** — Capacitor+ CLI, same as official CLI but with community improvements merged faster. https://capgo.app/plugins/capacitor-plus/
145. **Capacitor+ Android** — Capacitor+ Android runtime, drop-in replacement with merged community fixes. https://capgo.app/plugins/capacitor-plus/
146. **Capacitor+ iOS** — Capacitor+ iOS runtime, drop-in replacement with merged community fixes. https://capgo.app/plugins/capacitor-plus/

### Integrations (4)
147. **Supabase** — Native Supabase authentication, JWT access, and basic database helpers for Capacitor. https://capgo.app/docs/plugins/supabase/
148. **Firebase App** — Capacitor plugin for Firebase App. https://capgo.app/plugins/app/
149. **Firebase Functions** — Capacitor plugin for Firebase Cloud Functions. https://capgo.app/plugins/functions/
150. **Firebase Remote Config** — Capacitor plugin for Firebase Remote Config. https://capgo.app/plugins/remote-config/

---

## 3. Deep-dive details (58 of 150 plugins fetched individually)

Below, each plugin fetched at its own page. Format: npm package, platforms, install, key methods, caveats, our-fleet relevance. Plugins not individually fetched retain only the catalog-level info in Section 2 (name, description, URL); given the 150-plugin catalog size, deep dives were prioritized on plugins with concrete relevance to the 8-app fleet's existing feature surfaces (audio/speech, camera/scanning, biometrics/security, family/social, background work, watch/widgets, IAP, storage) plus the Updates and comparison-relevant Commerce/Auth plugins. This is flagged explicitly as a completeness note, not silently omitted.

### 3.1 UI & System

**Live Activities** (`@capgo/capacitor-live-activities`)
- iOS only, requires iOS 16.1+. Android/Web unsupported.
- Install: `bun add @capgo/capacitor-live-activities && bunx cap sync`
- Methods: `areActivitiesSupported()`, `startActivity()`, `updateActivity()`, `endActivity()`.
- Caveats: requires native Widget Extension in Xcode with ActivityKit; ActivityKit caps combined static+dynamic Live Activity data at 4 KB; extensions cannot access the network directly (images must be pre-downloaded); push updates need APNs backend; Dynamic Island only renders on supported device models, others fall back to Lock Screen.
- **Fleet relevance:** Flatstick already ships a lock-screen Live Activity (money glance) per its CLAUDE.md/HANDOFF history, built as a hand-rolled native extension via `ios/integrate_native_targets.rb`. This plugin is a candidate to REPLACE that hand-rolled Swift target with a maintained Capacitor abstraction on the next major rework, or to bring the same capability to iHEARtest (a "test in progress" live activity) or InnerEase (an active relief-session countdown) without hand-writing ActivityKit Swift again. The 4 KB payload cap and no-network-in-extension constraint match exactly what Flatstick's own HANDOFF notes already learned the hard way (SKIP_INSTALL=YES gotcha, App Group requirement) so this plugin does not remove the App Group Developer-portal Matt-gate, but does remove the hand-rolled Swift.

**Widget Kit** (`@capgo/capacitor-widget-kit`)
- iOS and Android listed, though the SVG/timer/action-hotspot feature set described is iOS WidgetKit-flavored.
- Install: `bun add @capgo/capacitor-widget-kit && bunx cap sync`
- Methods: `startTemplateActivity()`, `listTemplateEvents()`/`acknowledgeTemplateEvents()`, `startWidgetSession()`/`updateWidgetSession()`, `sendWidgetMessage()`/`acknowledgeWidgetMessages()`/`completeWidgetMessage()`, `endTemplateActivity()`/`stopWidgetSession()`.
- Caveats: iOS requires App Group config plus `CapgoWidgetKitAppGroup` in Info.plist for BOTH the app and the widget extension target; interactive buttons need a native widget extension integrating the plugin's bridge/action intent.
- **Fleet relevance:** Directly overlaps Flatstick's shipped home-screen widget (built via the same `integrate_native_targets.rb` native-extension pattern noted in Flatstick's CLAUDE.md). Same App Group Developer-portal Matt-gate as Live Activities above (not avoided by using the plugin). Worth evaluating for AWARE (a "today's exercise streak" widget) or Companion (family feed glance widget, though PostHog ph-no-capture sensitive-surface rules would need to extend to any widget preview text).

**Sheets** (already used, iHEARtest) — https://capgo.app/docs/plugins/sheets/. Not re-fetched individually (already in production use); catalog description: "Framework-agnostic sheets, drawers, dialogs, and overlay primitives optimized for Capacitor apps." Candidate for reuse in Companion (paywall sheet), FourVault (parental gate modal), Flatstick (bet-entry sheet) to standardize on one sheet primitive fleet-wide instead of each app hand-rolling its own.

**In App Browser** (`capacitor-inappbrowser`, catalog-only) — relevant to InnerEase (external clinician-sign-off links), Companion (linking out to scam-report resources without leaving the app), otchealth-mcp / innd-website adjacent flows are N/A (web, not app).

### 3.2 Auth & Security

**Native Biometric** (`@capgo/capacitor-native-biometric`)
- iOS, Android. Install: `bun add @capgo/capacitor-native-biometric && bunx cap sync`.
- Methods: `isAvailable()`, `verifyIdentity()`, `getCredentials()`, `setCredentials()`.
- Open source, no pricing tier.
- **Fleet relevance:** Companion's non-negotiable rule #6 ("server-side enforcement of entitlements") and its senior/caregiver dual-user model could use Face ID/Touch ID gating for the "adult child" admin actions (e.g., editing the info notebook, revoking a voice clone) without adding a password flow, which is friction-appropriate for a 70+ primary user while still gating caregiver-sensitive actions. Also relevant to FourVault as a PARENT unlock gate (biometric parental gate instead of/alongside a PIN) if the parent's own phone/passcode is not sufficient assurance; note FourVault's COPPA rule is about VERIFIABLE parental consent methodology broadly, biometric alone is not a VPC method, so this would supplement not replace the existing gate.

**Persistent UUID** (`@capgo/capacitor-persistent-uuid`)
- iOS, Android, Web. Install: `npm install @capgo/capacitor-persistent-uuid && npx cap sync`.
- Methods: `getId()` (optional `scope` param), `resetId()`.
- Caveats: does not expose hardware IDs; does not survive factory reset/manual account removal/storage clear; Android stored in AccountManager (survives reinstall); iOS stored in Keychain (persists through app/OS updates if Keychain access unchanged); Web uses localStorage as a dev-only fallback.
- **Fleet relevance:** Useful fleet-wide as a privacy-safe device correlation id for PostHog/Sentry without IDFA/IDFV (which needs ATT consent). Companion's `analytics.ts` categorical-only event rule and MedReview's zero-PHI-in-analytics rule are both compatible with a scoped, resettable UUID as the device dimension, better than IDFV because it explicitly is NOT a hardware id and has a documented reset path (helps with Companion's clone-revocation privacy story and MedReview's Sentry PHI-scrub posture). NOT usable for MedReview PHI itself since MedReview's ring rules require BAA-covered infra only.

**App Attest** (`@capgo/capacitor-app-attest`)
- iOS, Android (Google Play Integrity). Install: `bun add @capgo/capacitor-app-attest && bunx cap sync`.
- Methods: `isSupported`, `prepare`, `createAttestation`, `createAssertion`.
- **Fleet relevance:** Strong fit for MedReview's backend (Fastify API on Cloud Run) to attest that API calls originate from the genuine MedReview app binary, not a scripted client, defense-in-depth for a PHI-adjacent surface (note: this is app integrity, not a PHI transport itself, so it does not change MedReview's BAA-ring rules but hardens the edge). Also fits Flatstick and FourVault (anti-cheat/anti-bot on bet entry and card-trade verdicts respectively) and Amazon/Shopify-adjacent commerce flows (not applicable here, those are server-side, not app-side).

**SSL Pinning** (`@capgo/capacitor-ssl-pinning`)
- iOS, Android. Install: `bun add @capgo/capacitor-ssl-pinning && bunx cap sync`.
- Only method surfaced in the fetched excerpt: `getConfiguration()`, described as "inspecting SSL pinning configuration" rather than a full pinning implementation (native config likely lives in a bundled cert/plist, this JS method reads it back).
- **Fleet relevance:** MedReview (PHI transport hardening, defense in depth on top of TLS) and Companion (backend proxies all third-party API calls per its non-negotiable rule 5, ephemeral-token architecture) are the two apps where pinning the API host cert would meaningfully raise the bar against MITM on public wifi, which matches Companion's senior-user threat model (scam-prone users on unfamiliar networks).

**Mock Location Detector** (`@capgo/capacitor-mock-location-detector`)
- iOS, Android. Install: `bun add @capgo/capacitor-mock-location-detector && bunx cap sync`.
- Methods: `analyze()`, `runCheck()`, `getCapabilities()`, `startMonitoring()`/`stopMonitoring()`, `openDeveloperSettings()`.
- Caveats: no monthly download data, only 3 GitHub stars (low adoption, treat as higher integration risk / less battle-tested than the rest of the catalog).
- **Fleet relevance:** Flatstick (golf course check-in / live scoring) is the one app in the fleet where GPS spoofing would directly enable betting fraud, a live-round score claimed from a fake location. Worth prototyping given Flatstick's explicit "never weaken the money math" posture extends naturally to "never trust an unverified location claim."

**Age Range** (`@capgo/capacitor-age-range`) / **Age Signals** (catalog-only, `capacitor-android-age-signals`)
- iOS + Android via Apple DeclaredAgeRange and Google Play Age Signals respectively. Install: `bun add @capgo/capacitor-age-range && bunx cap sync`. Method: `requestAgeRange` with configurable gates (e.g., [13,16,18]).
- Caveat noted explicitly in the fetch: the plugin leverages platform-native age-verification systems which ALIGN WITH parental-consent infrastructure but the plugin documentation does NOT itself address COPPA compliance specifics, data handling, or parental-verification workflow, so it is a signal input, not a COPPA solution by itself.
- **Fleet relevance:** FourVault is the one app with a hard COPPA/VPC (verifiable parental consent) requirement in its CLAUDE.md. This plugin could supplement, not replace, FourVault's existing VPC flow, as an additional friction-reducing platform-level age signal ahead of or alongside the app's own parental gate. Given the caveat above, this should NOT be treated as satisfying VPC alone; flag to the coppa-kidsafety-reviewer subagent per FourVault's own "ask reviewers" workflow rule before adopting.

**Persona** (`@capgo/capacitor-persona`) — identity-verification SDK wrapper. Page content was partially garbled in the fetch (mixed with Intune plugin docs on Capgo's own site, a real content bug on their side), so treat method names as unconfirmed; description confirmed as "Launch Persona identity verification inquiries with native iOS and Android SDKs." Not an immediate fleet fit (no app currently needs KYC-grade identity verification); would only become relevant if FourVault's parental consent needed a stronger identity-verification tier, or if a future finance-adjacent surface required KYC (note Matt-directive KYC/payment gates stay human per otchealth-cto/CLAUDE.md, this plugin would still need a human-gated flow around it).

**WebView Guardian / WebView Crash / WebView Version Checker / Privacy Screen / Keep Awake** (already used, iHEARtest, or catalog + one deep-dived: WebView Version Checker, Privacy Screen, Keep Awake)
- **WebView Version Checker** (`@capgo/capacitor-webview-version-checker`): Methods `check()`, `startMonitoring()`, `stopMonitoring()`, `getLastStatus()`. Primarily Android WebView freshness (Android's WebView is a separately-updated system component; iOS WKWebView ships with the OS so this check is far less meaningful on iOS despite both platforms being listed). Every fleet app that has an Android build path (all of them per their stacks, even though iOS is first) should carry this given stale Android WebView is a documented source of the exact "WebView killed in background" class of bug iHEARtest already fights with WebView Guardian/Crash.
- **Privacy Screen** (`@capgo/capacitor-privacy-screen`): confirmed methods `enable()`/`disable()`/`isEnabled()`, ~518 monthly downloads (low relative to catalog leaders, but it's a narrow-purpose plugin). Already in iHEARtest; strongly recommended for Companion (family photo feed and info-notebook screens are exactly the App-Switcher-snapshot-leak risk this plugin exists for, and Companion's own analytics.ts already tags those same surfaces `ph-no-capture` for PostHog, the SAME sensitive-surface list should drive where Privacy Screen is force-enabled) and for MedReview (PHI-adjacent screens, though MedReview's actual medication data lives behind auth first, still worth it for the app-switcher snapshot specifically) and FourVault (kid photos of cards, parental controls screens).
- **Keep Awake** (`@capgo/capacitor-keep-awake`): confirmed methods `keepAwake()`, `allowSleep()`, `isSupported()`, `isKeptAwake()`. Already in iHEARtest (hearing test in progress). Directly relevant to AWARE (training exercises), InnerEase (relief-sound sessions, background audio already required per its CLAUDE.md "native audio path, not pure Web Audio" rule, Keep Awake complements that so the screen does not sleep mid-session even though audio itself would survive lock via the native path), and Flatstick (live scoring during a round, phone screen dimming mid-shot-entry is a real annoyance).

### 3.3 Analytics

**App Tracking Transparency** (`@capgo/capacitor-app-tracking-transparency`)
- Listed iOS+Android but functionally iOS-only (ATT is an Apple framework; Android has no equivalent, the catalog's Android listing looks like a template artifact on Capgo's side).
- Methods: `getStatus`, `requestPermission`. Status values: authorized/denied/restricted/notDetermined.
- **Fleet relevance:** Any fleet app that wires AppsFlyer, Facebook Analytics, or ad-based attribution needs this ahead of IDFA access; currently the fleet's primary analytics is PostHog (project-based, first-party, IDFA-independent) so ATT is NOT currently required by policy, but would become required the moment any app adds AdMob (catalog item 4, relevant if a free-tier ad-supported model is ever explored for e.g. Fictionary) or AppsFlyer-style attribution.

**Firebase Analytics** (`@capgo/capacitor-firebase-analytics`) and **Firebase Crashlytics** (`@capgo/capacitor-firebase-crashlytics`)
- Both low-adoption per their own stats (844/mo and 633/mo downloads respectively, 6 GitHub stars each), i.e., thin wrappers, not the dominant choice in this catalog.
- Firebase Analytics methods: `getAppInstanceId`, `getSessionId`, `setConsent`, `setUserId`.
- Firebase Crashlytics methods: `crash()` (test-crash trigger), `setCustomKey()`, `setUserId()`, `log()`.
- **Fleet relevance:** Companion's stack already specifies Firebase Auth + Identity Platform, Firestore, and Cloud Storage for Firebase, so if Companion ever wants Crashlytics specifically (distinct from its current Sentry-secondary setup) this is the matching Capgo wrapper, same Firebase project, no new vendor. Given the fleet's stated direction ("lean PostHog long-term, Sentry secondary") adding a THIRD crash reporter (Crashlytics) is likely redundant, flagged as a "why would we" rather than a recommendation.

**In App Review** (already used, iHEARtest) — confirmed via direct fetch: `@capgo/capacitor-in-app-review`, single method `requestReview()`, 23.7k monthly downloads (one of the more popular plugins fetched), no explicit pricing. Recommended standard across ALL 8 apps for consistent review-prompt behavior (several apps' HANDOFF/CLAUDE files reference review-prompt gating work already, e.g. FourVault's Tier1 work "W1-5: Review-prompt gating" per the session's own task list), single shared plugin means one gating policy to maintain fleet-wide instead of eight bespoke StoreKit calls.

### 3.4 Media (the single most fleet-relevant category given voice/audio/camera across Companion, iHEARtest, AWARE, InnerEase, PlantID)

**Camera Preview** (`@capgo/camera-preview`, note: npm scope differs slightly, package is `@capgo/camera-preview` not `@capgo/capacitor-camera-preview` despite the URL slug)
- iOS, Android. Install: `bun add @capgo/camera-preview && bunx cap sync`.
- Methods: `start()`, `stop()`, `capture()`, `captureSample()` (single frame from live stream).
- 34.8k monthly downloads, 47 GitHub stars (one of the more adopted plugins in the whole catalog).
- **Fleet relevance:** DIRECT hit for Companion's Pillar 1 ("visual + voice AI assistant", point camera at plant/pill/mail/menu) and PlantID (plant identification via camera). `captureSample()` in particular (grab a frame from a live preview without a full photo-capture UX) matches Companion's "point and get an instant answer" flow better than the standard Capacitor Camera plugin's photo-taking UX, and matches PlantID's live-recognition loop (its backend uses AZURE_OPENAI Vertex Gemini vision per its architecture note; a live camera-preview frame-grab is the natural client-side capture primitive feeding that).

**Speech Recognition** (`@capgo/capacitor-speech-recognition`)
- iOS, Android. Methods: `available()`, `isOnDeviceRecognitionAvailable()` (locale-dependent), `start()`, `stop()`.
- Described as "natural, low-latency... with streaming partial results and cross-platform parity."
- **Fleet relevance:** Companion's voice assistant pillar and its "reachable by voice" accessibility requirement (non-negotiable rule 4: "every action must also be reachable by voice") are exactly this plugin's use case; also directly relevant to InnerEase (voice-driven exercise navigation for a senior-adjacent 50-75 audience) and AWARE (12-tile training grid could gain voice navigation for the same accessibility posture Companion already commits to). Note this is a DIFFERENT layer than Companion's Gemini Live (server-side conversational AI); this plugin is on-device wake/command recognition, a candidate for a lightweight "Hey, read this to me" trigger before handing off to the heavier cloud Live API session, potentially reducing Gemini Live minute consumption (a HARD-capped usage dimension per Companion's own pricing/usage-caps rules).

**Speech Synthesis** (`@capgo/capacitor-speech-synthesis`)
- iOS, Android, Web (Web notably supported here, unlike most Media plugins). Methods: `speak`, `synthesizeToFile` (iOS/Android only, no Web), `cancel`, `pause`. 2.6k monthly downloads.
- **Fleet relevance:** Companion's default TTS is Google Cloud TTS Chirp 3 HD (BAA-covered) for non-cloned narration, and ElevenLabs for the consented voice-clone pillar. This plugin is a THIRD, on-device/OS-native TTS option, most useful as a zero-latency, zero-cost FALLBACK when the cloud TTS call fails or before the ElevenLabs clone audio has finished generating (a "speaking placeholder" UX), not a replacement for either cloud path since neither BAA coverage nor voice-clone identity can come from the OS's generic system voice. Also fits AWARE (aural rehab coach narration) and InnerEase (exercise prompts) as a lightweight default narrator without a cloud round-trip, InnerEase's CLAUDE.md already flags PostHog as its only wired telemetry and no backend in V1, on-device TTS fits its "on-device-first" non-negotiable rule 5 far better than any cloud TTS would.

**Audio Session** (`@capgo/capacitor-audiosession`)
- iOS ONLY (explicitly, despite being framed generically). Methods: `currentOutputs()`, `overrideOutput()`.
- Scope: iOS AVAudioSession routing/output-only, does not itself handle playback.
- **Fleet relevance:** This is precisely the class of native AVAudioSession control that Companion's own "Known gotchas" section already hand-rolled a custom native plugin for (`AmplifyAudioPlugin.swift`, `.playAndRecord` / `.measurement` mode, before `getUserMedia`). This Capgo plugin does NOT appear to expose full category/mode configuration (only current-output query and output override per the fetched excerpt), so it likely CANNOT fully replace Companion's bespoke AmplifyAudio plugin as-is, but is worth a closer read of its full API surface as a potential base to extend rather than maintaining 100% bespoke Swift. Also relevant to iHEARtest and AWARE, both of which are hearing-focused apps highly likely to have their own AVAudioSession/AirPods routing pain (iHEARtest's CLAUDE.md explicitly lists "device-only classes of bugs (AVAudioSession, AirPods routing...)" as something only testable on a real device via TestFlight).

**Native Audio** (`@capgo/capacitor-native-audio`)
- iOS, Android. Methods: `configure()`, `preload()`, `playOnce()` (with `deleteAfterPlay`/`autoPlay` options), `isPreloaded()`, `stop()`. Framed for "short audio files... for games and apps," i.e., low-latency SFX, not long-form narration/streaming.
- **Fleet relevance:** Good fit for short UI/feedback sounds fleet-wide (success chimes, error tones), and for AWARE/InnerEase short training-exercise audio cues, distinct from the longer narration handled by Speech Synthesis/cloud TTS above.

**Photo Library** (`@capgo/capacitor-photo-library`)
- iOS, Android. Methods: `checkAuthorization`, `requestAuthorization`, `getAlbums`, `getLibrary` (returns displayable URLs for WebView use). Offers both a customizable web-gallery approach and a native no-authorization-required picker with fewer customization options.
- **Fleet relevance:** Companion's family photo/video feed (Pillar 2) is the clearest fit; note Companion's PostHog rule tags the family feed as an always-on `ph-no-capture` sensitive surface, so any screen built on this plugin's output must carry that class per Companion's own analytics.ts convention. Also relevant to FourVault (card photo capture into the vault) and PlantID (photo library browse alongside live camera capture).

**Document Scanner** (`@capgo/capacitor-document-scanner`)
- iOS, Android. Single method: `scanDocument()` (auto edge detection, perspective correction, PDF export). 44.8k monthly downloads, 22 GitHub stars, one of the higher-adoption Media plugins fetched.
- **Fleet relevance:** Strong fit for Companion's "confusing screen, suspicious letter" visual-assistant use case (Pillar 1) when the user wants a CLEAN scanned copy of a piece of mail rather than a raw photo, better OCR/Gemini-vision input than an unprocessed camera frame. Also fits MedReview if a future version adds prescription/insurance document capture (currently MedReview's V1 is Shopify-embedded web only per its CLAUDE.md phased-delivery section, this plugin would only become relevant at V1.1/V1.2 Capacitor-wrap time).

**File Compressor** (`@capgo/capacitor-file-compressor`)
- iOS, Android, Web. Method: `compressImage` (params: blob, quality, width, mimeType; formats PNG/JPEG/WebP).
- **Fleet relevance:** Bandwidth/storage optimization for Companion (family photo feed uploads to Cloud Storage for Firebase), FourVault (card photo uploads), PlantID (plant photo uploads before Vertex vision analysis, smaller upload = lower latency to first Gemini response).

### 3.5 Files & Storage

**File Picker** (`@capgo/capacitor-file-picker`)
- iOS, Android (no Web per the fetched excerpt, despite general expectation). Methods: `pickFiles()`, `pickImages()`, `pickVideos()`, `pickMedia()`. Notably supports HEIC conversion, a real pain point for any app accepting iPhone camera-roll images server-side (HEIC is not universally decodable server-side without conversion).
- **Fleet relevance:** Companion's info notebook (insurance card photos) and family feed, FourVault's card capture, PlantID's photo upload flow, all benefit from built-in HEIC handling instead of each app writing its own conversion step.

**Data Storage (SQLite)** (`@capgo/capacitor-data-storage-sqlite`)
- iOS, Android. Methods: `openStore`, `closeStore`, `isStoreOpen`, `isStoreExists`. Description explicitly claims "encryption support" but the fetched excerpt did not surface SQLCipher-specific configuration detail, flagged as unconfirmed.
- **Fleet relevance:** Companion's stack ALREADY specifies `@capacitor-community/sqlite` with SQLCipher for its on-device encrypted store (notebook + recent-feed cache), a different, more established plugin than this Capgo one. This Capgo plugin is a simpler key-value-over-SQLite abstraction, not a like-for-like replacement given Companion's spec explicitly names the community plugin and SQLCipher by name; worth a second look only if the community plugin proves troublesome, not a default swap.

**File Sharer** (`@capgo/capacitor-file-sharer`)
- iOS, Android, Web. Methods: `share()`, `save()`, `getPluginVersion()`. Accepts base64, data URLs, local paths, `file://`, Android `content://`, and Capacitor `_capacitor_file_` URIs; Android save uses MediaStore on Android 10+ / public dirs below; iOS share supports base64-backed temp files or direct local paths.
- **Fleet relevance:** Generic fleet-wide utility (export a PDF report, share a scanned document, save a generated image) usable by Companion (share a scam-alert summary), FourVault (share a card trade verdict), MedReview at V1.1+ (export a medication list PDF).

**PDF Generator** (`@capgo/capacitor-pdf-generator`)
- iOS, Android. Methods: `fromURL`, `fromData` (raw HTML string to PDF). Docs suggest pairing with the SQLite storage plugin for file management.
- **Fleet relevance:** MedReview's "invoices, reports, receipts" framing in the catalog description is close to MedReview's own domain (a medication report), though MedReview V1 is web-only per its phased-delivery plan, so this becomes relevant at V1.1/V1.2. Flatstick could also use this for a season/round settlement summary PDF (compatible with its "never holds money, just tracks and links out" rule, a PDF receipt of who-owes-whom is exactly in-scope).

### 3.6 Device APIs

**Health** (`@capgo/capacitor-health`)
- iOS, Android. Wraps Apple HealthKit and Android Health Connect. Methods: `isAvailable()`, `requestAuthorization()`, `checkAuthorization()`, `readSamples()`. 129.3k monthly downloads (one of the highest-adoption plugins fetched in this whole report). The fetched excerpt did NOT surface explicit PHI/privacy-compliance documentation; flagged as a gap to verify directly against Apple's HealthKit usage-string and data-minimization requirements before wiring into any BAA-relevant surface.
- **Fleet relevance, IMPORTANT COMPLIANCE FLAG:** iHEARtest's CLAUDE.md already floats "the HealthKit AirPods audiogram idea for iHEARtest" as a dogfood idea on the Apple-Intelligence test device. HealthKit data (including any audiogram-adjacent AirPods hearing data) is a PLAUSIBLE PHI-adjacent surface even though HealthKit itself is not automatically HIPAA-scoped by virtue of being HealthKit, the sensitivity is comparable. iHEARtest's own PHI ring rule (only `category_band` may leave the device, raw thresholds/Hearing Number never do) would need to apply with EQUAL force to anything this plugin reads from HealthKit, i.e., if iHEARtest ever reads AirPods audiogram data via this plugin, that data inherits the same "never leaves device beyond category_band" rule already enforced by iHEARtest's compliance grep. This is a genuine "flag and hold" per the fleet's own legal-wall posture (PHI/HIPAA ring), not a blocker on adopting the plugin itself, but a hard requirement on how any resulting data is subsequently handled.

**LLM** (`@capgo/capacitor-llm`)
- iOS, Android. Methods: `createChat`, `sendMessage`, `getReadiness`, `setModel`. iOS backend: Apple Intelligence (system model) OR MediaPipe model files; Android backend: MediaPipe model files from assets/files directory. 5.1k monthly downloads, 42 GitHub stars.
- **Fleet relevance:** DIRECT hit for two fleet items already in flight: (1) iHEARtest/claude-tools CLAUDE.md explicitly names the operator's iPhone 16 Pro as "the dogfood device for on-device LLM features (Apple Foundation Models / Companion assistant)", this plugin is literally the Capacitor bridge to Apple Intelligence's on-device Foundation Model. (2) InnerEase's non-negotiable rule 5 ("on-device-first, no backend, no PHI, no BAA in V1") makes an on-device LLM path structurally preferable to any cloud call for InnerEase's CBT/ACT content delivery, subject to InnerEase's separate non-negotiable rule 6 that clinical content requires sign-off (Matt-routed, no CMO currently) regardless of where the inference runs. Also a candidate to REDUCE Companion's Vertex/Gemini cloud spend for low-stakes classification tasks (e.g., a coarse "is this a scam-shaped mail piece" pre-filter) before escalating to the heavier cloud model, mirroring the fleet's own model-routing initiative (Fleet Intelligence #5, gpt-4o primary/gpt-4.1-mini fallback pattern already used in company-brain) but ON-DEVICE rather than cross-cloud.

**Background Task** (`@capgo/capacitor-background-task`)
- iOS, Android. Methods: `defineTask`, `registerTaskAsync`, `unregisterTaskAsync`, `isTaskRegisteredAsync`, `getRegisteredTasksAsync`, `getStatusAsync`, `triggerTaskWorkerForTestingAsync`, `addExpirationListener`. Expo-style task registration. Caveats: background schedules are opportunistic not guaranteed; Android requires a minimum 15-minute interval; iOS treats `minimumInterval` as an earliest-start time only (may run later or not at all); physical-device testing recommended for iOS.
- **Fleet relevance:** Companion's daily check-in (Pillar 2) needs exactly this class of periodic background work, and the "opportunistic, not guaranteed" caveat is important context for setting Companion's caregiver-facing expectations (a "check-in reminder" cannot be promised to fire at an exact time on iOS, matches the general iOS background-execution reality the fleet already has to design around).

**Background Geolocation** (`@capgo/capacitor-background-geolocation`)
- iOS, Android. Methods: `start`, `stop`, `openSettings`, `setupGeofencing`, `addGeofence`/`removeGeofence`, `getMonitoredGeofences`, plus `geofenceTransition`/`geofenceError` listeners. Notably zero monthly npm downloads at fetch time (brand new / unadopted, higher integration risk).
- **Fleet relevance:** Flatstick (auto-detect arrival at a golf course to start a round) and Companion (a caregiver-configured "left the house" or "arrived somewhere unexpected" safety signal, though this would need careful non-negotiable-rule review given Companion's senior-privacy posture and its explicit list of what the info notebook does NOT hold, location tracking of a senior user is a sensitive feature that would need its own consent design, not a silent add).

**Watch** (`@capgo/capacitor-watch`)
- iOS (Android listed but the described feature set, watchOS bidirectional messaging, is Apple Watch specific; treat the Android listing as likely a catalog template artifact, same pattern seen with App Tracking Transparency). Methods: `sendMessage` (requires watch reachability), `updateApplicationContext` (last-write-wins), `transferUserInfo` (queued/reliable), `replyToMessage`.
- **Fleet relevance:** DIRECT overlap with Flatstick's already-shipped Apple Watch app (money glance + Digital Crown score entry, per Flatstick's CLAUDE.md/HANDOFF). This plugin is a candidate to replace or extend the hand-rolled WatchConnectivity Swift Flatstick built via `integrate_native_targets.rb`, particularly for the reliable `transferUserInfo` queued-delivery semantics which Flatstick's own HANDOFF flagged as still needing a real `publishMoneyToWatch(...)` hook wired at the money-total source. Also a candidate for iHEARtest (a watch companion showing test progress) or AWARE (today's exercise streak on the wrist) as net-new features, not gap-fills.

### 3.7 Location

**Compass** (`@capgo/capacitor-compass`) — iOS, Android (Web unsupported for heading). Methods: `getCurrentHeading`, `startListening` (throttled, default 100ms/2 degree minimum), `stopListening`, `checkPermissions`. iOS requires location permission; Android does not. **Fleet relevance:** Flatstick (yardage/direction-to-pin overlays, a common golf-app feature) is the clear fit; no other fleet app has an obvious use.

**Barometer** (`@capgo/capacitor-barometer`) — iOS, Android. Methods: `getMeasurement`, `isAvailable`, `startMeasurementUpdates`, `stopMeasurementUpdates`. **Fleet relevance:** Flatstick again (elevation-change context for a hole, a genuine golf-scoring nuance some apps use for adjusted-yardage display), otherwise no fleet fit.

### 3.8 Communication

**Share Target** (`@capgo/capacitor-share-target`)
- iOS, Android. Methods: `addListener` (for `shareReceived` events with title/texts/files), `removeAllListeners`, `getPluginVersion`.
- **Fleet relevance, DIRECT match to a documented gotcha:** iHEARtest's CLAUDE.md "Known gotchas" section explicitly documents a fragile hand-built iOS Share Extension ("needs an App Group and 'Require Only App-Extension-Safe API = No'... can draw App Store review questions... if rejected, ship v1 without the share extension"). This Capgo plugin is exactly the abstraction that class of hand-rolled Share Extension code exists to avoid maintaining bespoke; worth evaluating as a direct replacement for iHEARtest's existing bespoke extension, and as the go-to for Companion (receiving a forwarded suspicious text/email/screenshot INTO the assistant for analysis, which maps precisely onto Companion's Pillar 1 "point at a confusing screen or suspicious letter" concept extended to "share a screenshot from Messages into the app").

**Bluetooth Low Energy** (`@capgo/capacitor-bluetooth-low-energy`)
- iOS, Android. Methods: `initialize()` (requires a mode param e.g. 'central'), `shimWebBluetooth()`, `isAvailable()`, `isEnabled()`.
- **Fleet relevance:** iHEARtest and AWARE are hearing-focused apps most likely to eventually want direct BLE communication with hearing aids/PSAPs (TReO) rather than relying solely on the iOS system Bluetooth audio route; also a general fit for any future OTCHealthMart hardware-adjacent companion feature (not currently in the 8-app fleet's stack list, flagged as a forward-looking note not a current gap).

**Social Login** (`@capgo/capacitor-social-login`)
- iOS, Android, Web. Methods: `initialize()`, `login()`, `logout()`, `isLoggedIn()`. Supports Google, Apple, Facebook, Twitter/X, and generic OAuth2/OIDC (GitHub, Microsoft Entra ID, Auth0, Okta, Keycloak).
- **Fleet relevance:** Companion's stack already specifies "email/Apple/Google for adult kids" auth via Firebase Auth directly; this plugin would be a Firebase-Auth-adjacent ALTERNATIVE, not obviously additive given Companion already names its auth stack explicitly. More relevant to Fictionary or PlantID if either wants a non-Firebase social-login path, currently unconfirmed since neither app's CLAUDE.md was in the fetched context for this report.

### 3.9 Updates (the category the fleet already lives in)

**Updater** (`@capgo/capacitor-updater`, already fleet-wide)
- iOS, Android. Methods confirmed via direct fetch: `notifyAppReady()`, `setUpdateUrl()`, `setStatsUrl()`, `setChannelUrl()`.
- Explicit, important caveat confirmed directly from Capgo's own docs: **the plugin only ships WEB-LAYER updates over the air.** "Native plugins, entitlements, Android manifest changes, iOS plist changes, and binary SDK updates" must still go through the normal App Store / Depot build pipeline. This is a hard, durable constraint worth restating fleet-wide: adding ANY of the native plugins recommended throughout this report (Watch, Widget Kit, Live Activities, Camera Preview's native camera layer, Bluetooth LE, NFC, Health, App Attest, etc.) requires a real binary release through Depot macOS CI and cannot ship silently through the existing Capgo OTA channel. Only JS/HTML/CSS/web-asset changes and config that lives purely in the web bundle qualify for OTA. This should be written explicitly into each app's CLAUDE.md OTA section if not already, since it directly bounds what "ship via Capgo channel" can mean for anything recommended in this report.
- License/pricing: open source core plugin; no explicit pricing surfaced on the plugin page itself (Capgo's metered OTA-update SERVICE pricing, distinct from the plugin's own license, lives on Capgo's separate pricing page, out of scope for this plugin-catalog fetch).

**Android Inline Install** (catalog-only, `capacitor-android-inline-install`) — "Install app updates directly within the app without leaving to Play Store." Android-only complement to the Updater plugin's web-only OTA scope; would let a full BINARY update install inline on Android without a Play Store redirect (Android's flexibility here has no iOS equivalent, Apple does not allow inline binary installs). No current fleet Android app is the primary release target (all 8 apps are iOS-first per their CLAUDE.md files), so this is a lower-priority item, flagged for completeness only.

### 3.10 Commerce

**Native Purchases** (`@capgo/native-purchases`, npm scope note: package name is `@capgo/native-purchases`, NOT `@capgo/capacitor-native-purchases` despite the URL slug, mirroring the Camera Preview naming quirk above)
- iOS, Android. Methods: `restorePurchases()`, `getAppTransaction()`, `isEntitledToOldBusinessModel()` (grandfathering by version history), `getProducts()`, `purchaseProduct()`. Notable feature: "iOS StoreKit support for monthly billing commitments on 12-month subscriptions," a StoreKit-specific commitment-plan feature. 70.1k monthly downloads, 45 GitHub stars (the most-adopted Commerce plugin fetched).
- **Fleet relevance and explicit comparison to RevenueCat (asked for directly):** This is Capgo's OWN direct StoreKit/Play Billing wrapper, a THIRD-PARTY-FREE alternative to RevenueCat. Every monetized app in the fleet (Companion, FourVault, Flatstick, AWARE pro tier, InnerEase Sprint-4+ B2B licensing, PlantID) currently standardizes on RevenueCat (`@revenuecat/purchases-capacitor`, confirmed via direct fetch below) specifically because RevenueCat centralizes entitlement/webhook logic server-side (e.g., Flatstick's `POST /webhooks/revenuecat` and its tiered chat-entitlement model, Companion's server-side entitlement enforcement rule). Switching to Capgo Native Purchases would mean re-implementing that server-side receipt-validation and entitlement layer per app, a real regression against the fleet's existing "never trust the client's reported subscription state" rule (Companion non-negotiable rule 6) unless a comparable backend were built. NOT recommended as a fleet-wide replacement; RevenueCat should stay standard. Narrow exception: a single-platform, no-backend-yet app validating pricing before RevenueCat integration lands (none currently fit that description in the 8-app fleet).

**Purchases** (`@revenuecat/purchases-capacitor`, the plugin the fleet already standardizes on, confirmed via direct fetch)
- iOS, Android. Methods confirmed: `configure()`, `getVirtualCurrencies()`, `invalidateVirtualCurrenciesCache()`, `getCachedVirtualCurrencies()` (the last one returns null until fetched at least once). 532.4k monthly downloads, 232 GitHub stars, by a wide margin the most-adopted plugin observed anywhere in this research pass, consistent with it being the fleet's own standard.
- Note the "Virtual Currencies" API surfaced here is a RevenueCat feature the fleet is NOT currently using per any of the 8 apps' CLAUDE.md files (no in-app virtual currency system described anywhere in the fleet); flagged as an available-but-unused RevenueCat capability, not a gap, just a "did you know" for the CFO/monetization agent if a points/credits system is ever considered (e.g., a Flatstick "coin" reward loop distinct from the already-shipped decorative Flatstick Coin branding asset, which is cosmetic not currency).

**AdMob** (`@capgo/capacitor-admob`) — iOS, Android. Methods: `start()`, `configure()`, `configRequest()` (content rating, child-directed treatment, test devices), `adCreate()`. **Fleet relevance:** The `configRequest()` "child treatment" parameter is directly COPPA-relevant (Google's child-directed-treatment ad-request flag), meaning if FourVault (the fleet's one kids' app) ever considered ads, this plugin is aware of that regulatory surface, but FourVault's own CLAUDE.md rule 2 is blunt: "No loot boxes, ever... NEVER put third-party analytics or ads on kid screens." So AdMob is explicitly EXCLUDED from FourVault by the app's own non-negotiable rules regardless of this plugin's COPPA-aware parameters. No other fleet app currently has an ad-supported model in its docs; flagged as available but currently out of scope fleet-wide.

**Native Market** (`@capgo/capacitor-native-market`) — iOS, Android. Methods: `openStoreListing` (country param iOS-only), plus three Android-only methods (`openDevPage`, `openCollection`, `openEditorChoicePage`). Renamed from `@capgo/native-market`. **Fleet relevance:** Generic "rate us" / "check out our other apps" cross-promotion utility, usable fleet-wide given all 8 apps ship from the same OTCHealth/InnerScope publisher identity, a natural cross-sell surface (e.g., an AWARE user prompted toward iHEARtest, or a Flatstick user toward Fictionary) that currently has no dedicated plugin in any app's stack.

---

## 4. Fleet relevance matrix (by app)

| App | Recommended new plugins (from this research) | Rationale |
|---|---|---|
| **iHEARtest** | Share Target (replace the fragile hand-rolled Share Extension), Watch (companion progress view), Widget Kit/Live Activities (test-in-progress glance), WebView Version Checker (Android WebView freshness), Health (flagged, PHI-adjacent, AirPods audiogram idea) | Directly closes a documented "Known gotchas" fragility and matches an already-floated dogfood idea |
| **AWARE** | Speech Recognition/Synthesis (voice nav for the 12-tile grid), Native Audio (exercise SFX), Keep Awake (training sessions), Watch/Widget Kit (streak glance) | Matches its aural-rehab, senior-adjacent (50-75) accessibility posture |
| **Companion** | Camera Preview (Pillar 1 wedge), Speech Recognition (on-device voice trigger ahead of Gemini Live), Speech Synthesis (fallback narrator), Document Scanner (clean mail/letter capture), Photo Library + File Compressor (family feed, Pillar 2), Native Biometric (caregiver-action gate), SSL Pinning (senior scam-threat-model hardening), Persistent UUID (privacy-safe analytics dimension), Share Target (receive a forwarded suspicious screenshot), Privacy Screen (force on for feed/notebook/consent screens), Background Task (daily check-in) | Directly serves all three pillars (visual/voice assistant, family layer, voice cloning) and its senior-accessibility + entitlement + PHI-adjacent posture |
| **FourVault** | Camera Preview + File Compressor (card capture), Age Range/Age Signals (supplemental COPPA signal, needs coppa-kidsafety-reviewer sign-off before adoption), Native Biometric (supplemental parent-gate), App Attest (anti-cheat on trade verdicts) | Matches its card-vault + COPPA-gated flows; explicitly EXCLUDES AdMob per its own no-ads-on-kid-screens rule |
| **Flatstick** | Watch (replace/extend the hand-rolled WatchConnectivity code), Widget Kit/Live Activities (replace/extend the hand-rolled native-extension money glance), Compass + Barometer (yardage/elevation), Mock Location Detector (anti-spoof on live scoring), PDF Generator (settlement receipts), App Attest (anti-cheat) | Directly overlaps its ALREADY-SHIPPED native watch/widget/Live-Activity work; several items are candidates to REPLACE hand-rolled Swift with a maintained plugin |
| **InnerEase** | LLM (on-device, matches its explicit "on-device-first, no backend, no PHI in V1" rule), Speech Synthesis (on-device narrator), Keep Awake (relief-sound sessions), Background Task | LLM plugin is an unusually strong architectural fit given InnerEase's stated on-device-first constraint |
| **Fictionary** | Speech Recognition/Synthesis (if voice gameplay), Social Login, In App Review | No CLAUDE.md detail was in context for this report; recommendations are generic/catalog-level only |
| **PlantID** | Camera Preview + `captureSample()` (live recognition loop feeding its Vertex Gemini vision backend), File Compressor (upload optimization), Photo Library, LLM (on-device pre-classification before a cloud call) | Matches its camera-first plant-identification product directly |
| **Fleet-wide (all 8)** | In App Review (standardize the review-prompt plugin fleet-wide instead of per-app bespoke StoreKit calls), Native Market (cross-promotion), WebView Version Checker (Android freshness), Persistent UUID (privacy-safe device dimension for PostHog), Sheets (standardize on one sheet primitive) | Reduces N-times-bespoke maintenance across the portfolio |

---

## 5. Overlap / supersession analysis vs. plugins already in use

| Already in use (iHEARtest + fleet-wide) | Catalog status | Overlap finding |
|---|---|---|
| `@capgo/capacitor-updater` (fleet-wide OTA) | Confirmed live, deep-dived | No supersession; this IS the Capgo catalog's own flagship plugin. Hard caveat reconfirmed: web-layer-only OTA, any native plugin from this report needs a real Depot binary release. |
| `capacitor-in-app-review` | Confirmed live, deep-dived (`@capgo/capacitor-in-app-review`) | No supersession, already the right choice; recommend fleet-wide standardization on this exact package. |
| `keep-awake` | Confirmed live, deep-dived (`@capgo/capacitor-keep-awake`) | No supersession; recommend extending to AWARE/InnerEase/Flatstick as noted above. |
| `privacy-screen` | Confirmed live, deep-dived (`@capgo/capacitor-privacy-screen`) | No supersession; recommend extending to Companion/MedReview/FourVault sensitive screens. |
| `sheets` | Confirmed live (catalog description only, not individually re-fetched since already in production) | No supersession; recommend fleet-wide standardization. |
| `transitions` | Confirmed live (catalog description only) | No supersession. |
| `video-player` | Confirmed live (catalog description only) | No supersession; note the catalog's Media category also lists IVS Player, JW Player, and Mux Player as alternative video-streaming-specific plugins (adaptive bitrate / ad support) if iHEARtest ever needs streamed rather than local video, currently not indicated as a need. |
| `webview-crash` | Confirmed live (catalog description only) | No supersession; **new complementary find:** WebView Version Checker (Section 3.2/3.6) is a DIFFERENT, ADDITIVE plugin (Android WebView freshness/update-nudge) not currently in iHEARtest's stack, recommended as a companion to the existing crash/guardian pair rather than a replacement. |
| `webview-guardian` | Confirmed live (catalog description only) | No supersession; see WebView Version Checker note above. |

**Overall supersession finding:** none of the 58 individually-researched plugins directly supersede or duplicate the 9 plugins already wired into the fleet (`capacitor-updater` fleet-wide plus iHEARtest's 8). The one true ADDITIVE recommendation to the existing WebView-resilience trio (Guardian + Crash + Version Checker) is real and cheap to adopt. Everything else in this report is NET-NEW capability, not a replacement decision, with the two notable exceptions flagged above where a Capgo plugin could replace HAND-ROLLED native Swift the fleet already wrote itself (Flatstick's Watch/Widget/Live-Activity native-extension code, and iHEARtest's bespoke iOS Share Extension), which is a maintenance-reduction opportunity worth a follow-up spike, not an immediate swap.

---

## 6. Gaps, unconfirmed items, and honest limitations of this research pass

- **92 of the 150 catalog plugins were NOT individually fetched** (catalog-level name/description/URL only, from Section 2). Deep dives were prioritized by concrete fleet relevance per the stated task; the un-dived plugins skew toward categories with weak fleet fit observed elsewhere in the same category (e.g., most of the remaining Communication plugins: MQTT, Streamcall, Twilio Video/Voice, WeChat, RealtimeKit, Incoming Call Kit; most remaining Auth & Security plugins: Passkey, Verisoul, Firebase App Check/Authentication, Intune, SIM; and the full Firebase sub-suite beyond Analytics/Crashlytics/Messaging: App, Firestore, Storage, Functions, Remote Config). If a follow-up pass is wanted on any specific un-dived plugin, its catalog URL is already captured in Section 2.
- **No plugin page fetched in this pass surfaced an explicit dollar-figure price or a "paid tier" label.** The catalog's own summary line states all 150 are open source. This report cannot confirm or deny whether Capgo's separate OTA-update SERVICE (the metered product `@capgo/capacitor-updater` talks to, which the fleet already pays for via its existing Capgo org) has usage-based pricing tiers that interact with plugin choice, that would require fetching Capgo's pricing page specifically, out of scope for "the plugin catalog" as tasked.
- **Capacitor major-version compatibility was essentially undocumented at the individual plugin-page level**, with the single exception of Device Info (`@capacitor/core >=8.0.0`). This is a real gap for planning purposes given Flatstick is mid-migration from Capacitor 6 to 8 (PR #114 per its CLAUDE.md) and AWARE/iHEARtest are already on Capacitor 8. Recommend checking each target plugin's own `peerDependencies` in its package.json (not surfaced by the fetched page content) before adoption, rather than assuming catalog-wide Capacitor-8 support.
- **Persona plugin's page content was demonstrably garbled on Capgo's own site** (mixed with unrelated Intune plugin documentation in the same fetch), a real content bug on their end, not a research-tool failure; flagged rather than silently reported as clean data.
- **Two plugins had a surprising npm-scope/URL-slug mismatch** worth remembering for anyone installing from this report: Camera Preview installs as `@capgo/camera-preview` (URL slug says `capacitor-camera-preview`), and Native Purchases installs as `@capgo/native-purchases` (URL slug says `capacitor-native-purchases`). Always verify the actual `bun add` / `npm install` line shown on the plugin's own page rather than assuming the package name mirrors the URL slug.
- **Health plugin's PHI/privacy documentation was not surfaced** in the fetched excerpt despite being asked for explicitly; this is flagged as a real gap requiring direct review of the plugin's full HealthKit/Health-Connect entitlement and data-minimization documentation before any fleet app wires it to a PHI-adjacent data type, not treated as "no PHI concern" by default.

---

**End of report.**
