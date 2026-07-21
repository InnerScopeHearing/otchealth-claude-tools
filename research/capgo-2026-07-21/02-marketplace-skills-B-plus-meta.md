# Capgo Skills Marketplace, Inventory Part 2: Second Half (cocoapods-to-spm onward) + Marketplace Meta

Date: 2026-07-21

Source list:
- `/root/.claude/plugins/marketplaces/capgo-skills/skills/cocoapods-to-spm/SKILL.md` + `metadata.json`
- `/root/.claude/plugins/marketplaces/capgo-skills/skills/cordova-to-capacitor/SKILL.md` + `metadata.json`
- `/root/.claude/plugins/marketplaces/capgo-skills/skills/debugging-capacitor/SKILL.md` + `metadata.json`
- `/root/.claude/plugins/marketplaces/capgo-skills/skills/framework-to-capacitor/SKILL.md` + `metadata.json`
- `/root/.claude/plugins/marketplaces/capgo-skills/skills/ionic-appflow-migration/SKILL.md` + `metadata.json`
- `/root/.claude/plugins/marketplaces/capgo-skills/skills/ionic-design/SKILL.md` + `metadata.json`
- `/root/.claude/plugins/marketplaces/capgo-skills/skills/ionic-enterprise-sdk-migration/SKILL.md` + `metadata.json`
- `/root/.claude/plugins/marketplaces/capgo-skills/skills/ios-android-logs/SKILL.md` + `metadata.json`
- `/root/.claude/plugins/marketplaces/capgo-skills/skills/konsta-ui/SKILL.md` + `metadata.json`
- `/root/.claude/plugins/marketplaces/capgo-skills/skills/safe-area-handling/SKILL.md` + `metadata.json`
- `/root/.claude/plugins/marketplaces/capgo-skills/skills/skill-creator/SKILL.md` + `metadata.json` + `eval.yaml` + `fixtures/broken-skill/SKILL.md` + `graders/check-skill.js`
- `/root/.claude/plugins/marketplaces/capgo-skills/skills/sqlite-to-fast-sql/SKILL.md` + `metadata.json`
- `/root/.claude/plugins/marketplaces/capgo-skills/skills/subscription-app-revenue/SKILL.md` + `metadata.json`
- `/root/.claude/plugins/marketplaces/capgo-skills/skills/tailwind-capacitor/SKILL.md` + `metadata.json`
- `/root/.claude/plugins/marketplaces/capgo-skills/skills/webapp-to-capacitor/SKILL.md` + `metadata.json`
- `/root/.claude/plugins/marketplaces/capgo-skills/plugins/*/.claude-plugin/plugin.json` (all 11 plugin manifests)
- `/root/.claude/plugins/marketplaces/capgo-skills/plugins/*/skills/**` (mirrored skill copies inside each plugin dir, spot-checked for match against canonical `skills/`)
- `/root/.claude/plugins/marketplaces/capgo-skills/scripts/lint-skills.mjs`
- `/root/.claude/plugins/marketplaces/capgo-skills/README.md`
- `/root/.claude/plugins/marketplaces/capgo-skills/CLAUDE.md`
- `/root/.claude/plugins/marketplaces/capgo-skills/AGENTS.md`
- `/root/.claude/plugins/marketplaces/capgo-skills/package.json`
- `/root/.claude/plugins/marketplaces/capgo-skills/.claude-plugin/marketplace.json`

Scope note: the full skills directory (`ls skills/`) sorts alphabetically into 49 entries. This report covers the SECOND HALF, items 35 through 49 (index starting at 1), i.e. everything from `cocoapods-to-spm` onward through `webapp-to-capacitor`. The first 34 (capacitor-accessibility through capgo-release-workflows) are covered in the companion "first half" report. Full sorted skill list for reference:

```
1 capacitor-accessibility
2 capacitor-app-store
3 capacitor-app-upgrade-v4-to-v5
4 capacitor-app-upgrade-v5-to-v6
5 capacitor-app-upgrade-v6-to-v7
6 capacitor-app-upgrade-v7-to-v8
7 capacitor-app-upgrades
8 capacitor-apple-review-preflight
9 capacitor-best-practices
10 capacitor-ci-cd
11 capacitor-deep-linking
12 capacitor-keyboard
13 capacitor-mcp
14 capacitor-offline-first
15 capacitor-performance
16 capacitor-plugin-spm-support
17 capacitor-plugin-upgrade-v4-to-v5
18 capacitor-plugin-upgrade-v5-to-v6
19 capacitor-plugin-upgrade-v6-to-v7
20 capacitor-plugin-upgrade-v7-to-v8
21 capacitor-plugin-upgrades
22 capacitor-plugins
23 capacitor-push-notifications
24 capacitor-security
25 capacitor-splash-screen
26 capacitor-testing
27 capawesome-live-update-migration
28 capgo-cli-usage
29 capgo-cloud
30 capgo-live-updates
31 capgo-native-builds
32 capgo-organization-management
33 capgo-release-management
34 capgo-release-workflows
35 cocoapods-to-spm            <- this report starts here
36 cordova-to-capacitor
37 debugging-capacitor
38 framework-to-capacitor
39 ionic-appflow-migration
40 ionic-design
41 ionic-enterprise-sdk-migration
42 ios-android-logs
43 konsta-ui
44 safe-area-handling
45 skill-creator
46 sqlite-to-fast-sql
47 subscription-app-revenue
48 tailwind-capacitor
49 webapp-to-capacitor         <- this report ends here
```

Every skill folder in this half contains exactly two files, `SKILL.md` and `metadata.json`, EXCEPT `skill-creator`, which additionally has `eval.yaml`, `fixtures/broken-skill/SKILL.md`, and `graders/check-skill.js`.

---

## 1. cocoapods-to-spm

**Purpose (frontmatter description):** Guide to migrating an existing Capacitor iOS app from CocoaPods to Swift Package Manager (SPM). Use when users want Capacitor 8-style SPM projects, need to run or recover from `spm-migration-assistant`, replace `Podfile`/`Pods`/`App.xcworkspace` with `CapApp-SPM`, add `debug.xcconfig`, verify plugin SPM support, or remove CocoaPods from an app project.

**When to use:** migrating a Capacitor app from CocoaPods to SPM; questions about `npx cap spm-migration-assistant`; questions about `CapApp-SPM`, generated `Package.swift`, or `debug.xcconfig`; app on Capacitor 8 wanting the default SPM template; wants to remove `ios/App/Podfile`, `Pods`, `Podfile.lock`, or `App.xcworkspace`; SPM migration errors caused by plugins lacking SPM support. Explicitly NOT for adding SPM support to a plugin repository itself (that is `capacitor-plugin-spm-support`).

**Key rules:**
- Capacitor 8 creates new iOS projects with SPM by default; existing CocoaPods apps are NOT auto-converted just because Capacitor was upgraded.
- In SPM-based apps, plugin deps are referenced through `ios/App/CapApp-SPM`.
- Never hand-edit `CapApp-SPM`; the Capacitor CLI rewrites it on `npx cap sync`.
- Do not mix CocoaPods and SPM in one migration; every plugin in `package.json` needs SPM support before the app can fully move.
- Commit/preserve the project before deleting/regenerating/deintegrating the iOS project.

**Command policy:** use target repo's package manager for installs/scripts; use `npx cap ...` for Capacitor CLI examples; in Capgo repos use Bun for local dev commands per repo instructions but keep Capacitor CLI examples as `npx cap ...`.

**Live Project Snapshot (dynamic frontmatter injection):** runs a Node one-liner scanning `package.json` dependencies/devDependencies for anything starting with `@capacitor/`, `@capgo/`, `@capacitor-community/`, `@awesome-cordova-plugins/`, `cordova-`, or containing "capacitor", printing `section.name=version`. Also a `find ios -maxdepth 5` for `Podfile`, `Podfile.lock`, `Pods`, `App.xcworkspace`, `Package.swift`, `Package.resolved`, `CapApp-SPM`, `debug.xcconfig`, `project.pbxproj`, `Info.plist`, `*.entitlements`, `GoogleService-Info.plist`.

**Migration procedure (7 steps):**
1. **Confirm scope/prerequisites:** inspect `package.json` Capacitor version + plugins, `ios/App/Podfile`/`Podfile.lock`, `project.pbxproj` for custom build settings/entitlements/signing/native sources, `ios/App/App/` customizations. Verify Capacitor version supports SPM migration, working tree is clean (or user accepts preservation), every plugin has SPM support or a replacement plan. If combined with a Capacitor 8 upgrade, pair with `capacitor-app-upgrade-v7-to-v8`.
2. **Preserve native customizations** (via git, not memory): `Info.plist`, `AppDelegate.swift`, `SceneDelegate.swift` (if present), `Assets.xcassets/`, `Base.lproj/`, `*.entitlements`, `GoogleService-Info.plist` (if Firebase), custom `.xcconfig`, custom Swift/ObjC sources, custom frameworks/SDK files/extension targets/build phases/schemes/signing settings.
3. **Choose migration path** — table of 3 options:
   | Path | Use When | Tradeoff |
   |---|---|---|
   | CLI assistant | moderate customization, plugins mostly SPM-compatible | automates CocoaPods removal but still needs Xcode steps |
   | Fresh SPM re-scaffold | project close to Capacitor template | cleanest result but native customizations must be restored carefully |
   | Manual repair | assistant already ran or heavily customized project | more control, more Xcode project editing |
4. **Run the CLI assistant:** `npx cap spm-migration-assistant` (deintegrates CocoaPods, removes Podfile/Podfile.lock/Pods/App.xcworkspace, creates `ios/App/CapApp-SPM`, generates `Package.swift` from installed plugins, generates `debug.xcconfig`, warns on unsupported plugins). Then `npx cap open ios`; in Xcode: select app project > Package Dependencies tab > add local `CapApp-SPM` package > add generated `debug.xcconfig` to project config. Then `npx cap sync ios`.
5. **Fresh re-scaffold alternative** (little/no native config, or assistant path messier): preserve files from Step 2 first, then `rm -rf ios`, `npx cap add ios --packagemanager SPM`, `npx cap sync ios`. Note: Capacitor 8+ `npx cap add ios` uses SPM by default but keep the explicit flag for documented intent. Restore icons/launch storyboards, Info.plist keys (without blindly overwriting new template changes), entitlements/signing, Firebase/service config, custom native source/extensions/build phases/schemes.
6. **Fix plugin compatibility:** upgrade plugin to SPM-capable version, replace with official/Capgo/maintained community alternative, migrate a project-owned plugin with `capacitor-plugin-spm-support`, or postpone full SPM migration if a critical plugin lacks support. Never keep one plugin on CocoaPods while the app is otherwise SPM.
7. **Validate:** run normal web build, then `npx cap sync ios`, `npx cap open ios`. Verify in Xcode: `CapApp-SPM` present as local package dep; `debug.xcconfig` attached to debug config; Podfile/Pods/Podfile.lock/App.xcworkspace gone; `Package.resolved` generated+committed if present; signing team/bundle id/deployment target/entitlements/capabilities survived; app builds+launches on simulator; native plugin flows work on real device for hardware/permission features.

**Common failures + fixes:**
- Unsupported Plugin (missing SPM metadata) → upgrade/replace/migrate via `capacitor-plugin-spm-support`.
- Missing `CapApp-SPM` (assistant unfinished/files deleted) → `npx cap sync ios`, add local package in Xcode if not linked.
- Missing `debug.xcconfig` (generated config not added to project) → add `ios/App/debug.xcconfig` to Xcode project config.
- Duplicate Symbols/SDKs (leftover CocoaPods artifacts + SPM both referencing same dep) → remove CocoaPods artifacts, clean derived data, reset Xcode package caches, rebuild.
- Lost Native Customization (fresh scaffold overwrote customized files) → recover from git/backup, reapply selectively against new SPM template.

**Output format for planning tasks:** a `## SPM Migration Plan` markdown template with sections Current State (Capacitor version, CocoaPods files, plugins needing SPM check, native customizations to preserve), Recommended Path (+ reason), Steps (1-5 fixed list), Risks (unsupported plugins, native customizations, manual Xcode steps).

**metadata.json:** version 1.0.0, org Capgo, date May 2026. Abstract: guide for migrating existing Capacitor iOS app projects from CocoaPods to SPM, covers Capacitor 8 SPM defaults, CapApp-SPM, debug.xcconfig, spm-migration-assistant, fresh SPM re-scaffolding, plugin compatibility checks, preservation of native customizations, validation. Triggers: "cocoapods to spm", "swift package manager", "migrate to spm", "remove cocoapods", "spm capacitor", "pod to spm", "capacitor app spm migration", "spm-migration-assistant", "CapApp-SPM", "debug.xcconfig", "capacitor 8 spm", "migrate capacitor app to swift package manager". References: swift.org/package-manager, capacitorjs.com/docs/ios/spm, capacitorjs.com/docs/updating/8-0, developer.apple.com package-dependencies doc.

---

## 2. cordova-to-capacitor

**Frontmatter description:** Complete guide for migrating from Apache Cordova to Capacitor. Use when modernizing a Cordova/PhoneGap app to Capacitor, migrating plugins, or understanding platform differences.

**`allowed-tools` frontmatter field (this skill declares tool permissions):** `Bash(node -e *)`, `Bash(find *)`, `Bash(cordova *)`, `Bash(npm *)`, `Bash(npx *)`.

**When to use:** migrating existing Cordova app to Capacitor; converting PhoneGap projects; understanding Cordova vs Capacitor differences; finding Capacitor equivalents for Cordova plugins; modernizing hybrid mobile apps.

**Live Project Snapshot:** Node one-liner over `package.json` deps/devDeps for anything containing "cordova", starting with `@capacitor/`, or `@ionic-enterprise/`. Plus `find . -maxdepth 3` for `config.xml`, `capacitor.config.json/.ts/.js`, `./ios`, `./android`.

**Why migrate (comparison table):**
| Aspect | Cordova | Capacitor |
|---|---|---|
| Native IDE | CLI-only builds | First-class Xcode/Android Studio |
| Plugin Management | separate ecosystem | npm packages |
| Updates | full app store review | live updates with Capgo |
| Web App Platform | any | any (React/Vue/Angular/etc) |
| Maintenance | slowing down | active development |
| TypeScript | limited | full support |
| Modern APIs | older patterns | modern Promise-based |

**10-step migration process:**
1. Assess current app: `cordova --version`, `cordova platform version`, `cordova plugin list`, `cat config.xml`.
2. Install Capacitor: `npm install @capacitor/core @capacitor/cli`, `npx cap init` (prompts: App name, App ID matching config.xml widget id e.g. `com.company.app`, Web directory usually `www`).
3. Add platforms: `npm install @capacitor/ios`, `npx cap add ios`; `npm install @capacitor/android`, `npx cap add android`. Creates `ios/` and `android/` native project dirs.
4. Migrate plugins — full Cordova→Capacitor mapping table:
   | Cordova Plugin | Capacitor Equivalent | Install |
   |---|---|---|
   | cordova-plugin-camera | @capacitor/camera | npm install @capacitor/camera |
   | cordova-plugin-geolocation | @capacitor/geolocation | npm install @capacitor/geolocation |
   | cordova-plugin-device | @capacitor/device | npm install @capacitor/device |
   | cordova-plugin-network-information | @capacitor/network | npm install @capacitor/network |
   | cordova-plugin-statusbar | @capacitor/status-bar | npm install @capacitor/status-bar |
   | cordova-plugin-splashscreen | @capacitor/splash-screen | npm install @capacitor/splash-screen |
   | cordova-plugin-keyboard | @capacitor/keyboard | npm install @capacitor/keyboard |
   | cordova-plugin-dialogs | @capacitor/dialog | npm install @capacitor/dialog |
   | cordova-plugin-file | @capacitor/filesystem | npm install @capacitor/filesystem |
   | cordova-plugin-inappbrowser | @capacitor/browser | npm install @capacitor/browser |
   | cordova-plugin-media | @capacitor/media | custom or @capgo plugins |
   | cordova-plugin-vibration | @capacitor/haptics | npm install @capacitor/haptics |
   | cordova-plugin-local-notifications | @capacitor/local-notifications | npm install @capacitor/local-notifications |
   | cordova-plugin-push | @capacitor/push-notifications | npm install @capacitor/push-notifications |

   Third-party mappings called out specifically: biometrics `cordova-plugin-fingerprint-aio` → `@capgo/capacitor-native-biometric`; payments `cordova-plugin-purchase` → `@capgo/capacitor-purchases`; social login Facebook → `@capgo/capacitor-social-login`, Google → `@codetrix-studio/capacitor-google-auth`. Full catalog: github.com/Cap-go/awesome-capacitor.
5. Update code: remove `deviceready` listener pattern entirely (Capacitor plugins work immediately, no event needed). Example before/after for Camera. Device info: Cordova `device.uuid`/`device.platform` → Capacitor `Device.getId()`/`Device.getInfo()`. Network: `navigator.connection.type` → `Network.getStatus()`. Geolocation: `navigator.geolocation.getCurrentPosition` → `Geolocation.getCurrentPosition()`.
6. Update configuration: Cordova `config.xml` → Capacitor `capacitor.config.ts` (full example with `appId`, `appName`, `webDir: 'www'`, `server.androidScheme: 'https'`, `plugins.SplashScreen` block). Preferences like `Orientation`/`StatusBarOverlaysWebView`/`StatusBarBackgroundColor` map to per-platform Xcode/Android Studio settings or the `@capacitor/status-bar` plugin. Platform-specific `<platform name="ios"><allow-intent .../></platform>` maps to `ios.contentInset` / `android.allowMixedContent` in the TS config.
7. Handle permissions explicitly: iOS `Info.plist` keys (`NSCameraUsageDescription`, `NSPhotoLibraryUsageDescription`, `NSLocationWhenInUseUsageDescription`, `NSMicrophoneUsageDescription`); Android `AndroidManifest.xml` `<uses-permission>` entries for CAMERA, READ/WRITE_EXTERNAL_STORAGE, ACCESS_FINE_LOCATION, RECORD_AUDIO.
8. Sync and build: `npx cap sync` (copies web assets from `www/`, installs native deps, updates plugin configs). `npx cap open ios` then Cmd+R in Xcode; `npx cap open android` then Run in Android Studio.
9. Test: camera/photo picker, geolocation, file ops, network detection, device info, push notifications; watch for missing permissions, API differences, callback→Promise conversions, removed plugins.
10. Remove Cordova: `cordova platform remove ios/android`, `npm uninstall cordova cordova-ios cordova-android`, `cordova plugin list | xargs -I {} cordova plugin remove {}`, back up and move `config.xml` to `config.xml.backup`.

**Common issues:** Plugin Not Found (check `npm list`, `npx cap sync`, clean rebuild); deviceready Never Fires (remove listeners, Capacitor plugins work immediately, use `App.addListener('appStateChange', ...)` instead if needed); White Screen on Startup (check `webDir`, rebuild, sync, check device browser console); Permissions Not Working (add Info.plist/AndroidManifest entries, Capacitor auto-prompts); Plugins Using Old Cordova API (Capacitor has a Cordova compatibility layer — `npm install cordova-plugin-example` + `npx cap sync` still works for some, but migrate to native Capacitor plugins when possible, not all Cordova plugins work).

**Hybrid approach:** run Cordova and Capacitor side-by-side during migration — install Capacitor alongside Cordova, keep both config.xml and capacitor.config.ts, migrate plugins incrementally, test each platform independently, remove Cordova entirely when ready.

**Plugin migration checklist** (9-item checkbox list mirroring the steps above).

**Live Updates with Capgo section:** after migration, `npm install @capgo/capacitor-updater`; `npm install -g @capgo/cli`; `capgo login`; `capgo init`; `npm run build`; `capgo upload`. Points to `capgo-live-updates` skill for details.

**Resources:** capacitorjs.com/docs/cordova/migrating-from-cordova-to-capacitor, capacitorjs.com/docs, github.com/Cap-go/awesome-capacitor, github.com/Cap-go (Capgo plugins), forum.ionicframework.com.

**Migration timeline estimate table:**
| App Size | Estimated Time |
|---|---|
| Small (1-3 plugins) | 2-4 hours |
| Medium (4-8 plugins) | 1-2 days |
| Large (9+ plugins) | 3-5 days |
| Enterprise (custom plugins) | 1-2 weeks |

**Post-migration benefits** (checkmark bullet list): faster development, live updates via Capgo, better TypeScript, modern async/await APIs, active maintenance, better native-IDE debugging, improved bridge performance.

**Next steps:** complete migration, test on devices, set up CI/CD (`capacitor-ci-cd` skill), add live updates (`capgo-live-updates` skill), submit to app stores (`capacitor-app-store` skill).

**metadata.json:** version 1.0.0, org Capgo, date February 2026. Abstract matches SKILL.md purpose. Triggers: "cordova to capacitor", "migrate from cordova", "convert cordova", "cordova migration", "phonegap to capacitor", "replace cordova". References: capacitorjs.com/docs/cordova/migrating-from-cordova-to-capacitor, capacitorjs.com/docs, cordova.apache.org/docs.

---

## 3. debugging-capacitor

**Frontmatter description (no `allowed-tools` field on this one):** Comprehensive debugging guide for Capacitor applications. Covers WebView debugging, native debugging, crash analysis, network inspection, and common issues. Use when users report bugs, crashes, or need help diagnosing issues.

**When to use:** app crashes reported; need to debug WebView/JavaScript; need to debug native code; network/API issues; unexpected behavior; "how do I debug" questions.

**Quick reference table (debugging tools by platform):**
| Platform | WebView Debug | Native Debug | Logs |
|---|---|---|---|
| iOS | Safari Web Inspector | Xcode Debugger | Console.app |
| Android | Chrome DevTools | Android Studio | adb logcat |

**WebView debugging:**
- **iOS Safari Web Inspector:** enable on device (Settings > Safari > Advanced > Web Inspector ON, JavaScript ON); enable in capacitor.config.ts via `ios.webContentsDebuggingEnabled: true` (Required for iOS 16.4+); connect via Safari on Mac (Develop menu > Device > App; if no Develop menu, Safari > Settings > Advanced > Show Develop menu); debug via Console/Network/Elements/Sources tabs.
- **Android Chrome DevTools:** enable in config via `android.webContentsDebuggingEnabled: true`; connect via `chrome://inspect` on computer, click "inspect" under the app; debug via Console/Network/Performance/Application tabs.
- **Remote debugging with VS Code:** install "Debugger for Chrome" extension; example `.vscode/launch.json` snippet with `type: "chrome"`, `request: "attach"`, `port: 9222`, `webRoot`.

**Native debugging:**
- **iOS Xcode:** `npx cap open ios`; set breakpoints by clicking line numbers or `breakpoint set --name methodName` in LLDB; run via Cmd+R; LLDB console commands (`po myVariable`, `p myObject`, `continue`, `next`, `step`, `bt`); crash logs via Window > Devices and Simulators > select device > View Device Logs.
- **Android Studio:** `npx cap open android`; Run > Attach Debugger to Android Process; set breakpoints by clicking line numbers; debug console evaluates expressions/methods; Logcat via View > Tool Windows > Logcat, filter by `package:com.yourapp`.

**Console logging examples:**
- JS: `console.log/warn/error`, `console.group`/`groupEnd`, `console.table(arrayOfObjects)`, `console.time`/`timeEnd`.
- iOS Swift: `import os.log`; `Logger(subsystem:category:)`; `.debug/.info/.warning/.error` levels; legacy `NSLog("%@", message)` shows in Console.app.
- Android Kotlin: `import android.util.Log`; `Log.v/d/i/w/e`; `Log.e("MyPlugin", "Error occurred", exception)` with exception param.

**Common issues + fixes:**
- **App Crashes on Startup:** diagnose via `xcrun simctl spawn booted log stream --level debug | grep -i crash` (iOS) or `adb logcat *:E | grep -i "fatal\|crash"` (Android). Common causes: missing plugin registration, invalid capacitor.config, missing native deps. Checklist: `npx cap sync`; iOS `cd ios/App && pod install`; check Info.plist permissions; check AndroidManifest.xml permissions.
- **Plugin Method Not Found** (`Error: "MyPlugin" plugin is not implemented on ios/android`): diagnose via `Capacitor.Plugins` object inspection in JS. Solutions: `npm install @capgo/plugin-name`, `npx cap sync`, verify native registration.
- **Network Requests Failing:** diagnose via a fetch interceptor wrapping `window.fetch`. Causes: iOS ATS blocking HTTP (add `NSAppTransportSecurity`/`NSAllowsArbitraryLoads` to Info.plist), Android cleartext blocked (`server.cleartext: true` in config — DEV ONLY), CORS issues (use `CapacitorHttp.request(...)` from `@capacitor/core` for native HTTP bypassing CORS).
- **Permission Denied:** diagnose via `Permissions.query({name:'camera'})`; check Info.plist usage descriptions (iOS) and AndroidManifest `<uses-permission>` (Android).
- **White Screen on Launch:** check WebView console errors, check `dist/` exists, verify `webDir` in config. Fix: rebuild web assets (`npm run build`), `npx cap sync`, `cat capacitor.config.ts`.
- **Deep Links Not Working:** diagnose via `App.addListener('appUrlOpen', ...)`. iOS needs Associated Domains entitlement + apple-app-site-association file; Android needs intent filters in AndroidManifest.xml.

**Performance debugging:**
- JS: `performance.mark`/`measure`/`getEntriesByName`.
- iOS Instruments: Product > Profile (Cmd+I); Time Profiler (CPU), Allocations (memory), Network templates.
- Android Profiler: View > Tool Windows > Profiler; CPU (method tracing), Memory (heap), Network (request timeline).

**Memory debugging:**
- JS leaks: Chrome DevTools Memory tab, heap snapshot comparison before/after an action.
- iOS: `xcrun instruments -t Leaks -D output.trace YourApp.app`.
- Android: LeakCanary, `debugImplementation 'com.squareup.leakcanary:leakcanary-android:2.12'` in build.gradle.

**Debugging checklist** (8-item checkbox: WebView console, native logs, plugin installed+synced, permissions, real device test, clean build `rm -rf node_modules && npm install`, capacitor.config.ts settings, version mismatches).

**Resources:** capacitorjs.com/docs/guides/debugging, webkit.org/web-inspector, developer.chrome.com/docs/devtools, developer.apple.com Xcode debugging doc, developer.android.com/studio/debug.

**metadata.json:** version 1.0.0, org Capgo, date January 2026. Abstract matches. Triggers: "debug capacitor", "app crash", "white screen", "plugin not found", "permission denied", "network error", "inspect webview". References: capacitorjs.com/docs/guides/debugging, webkit.org/web-inspector, developer.chrome.com/docs/devtools, developer.apple.com Xcode debugging doc.

---

## 4. framework-to-capacitor

**Frontmatter description:** Guide for integrating modern web frameworks with Capacitor. Covers Next.js static export, React, Vue, Angular, Svelte, and others. Use when converting framework apps to mobile apps with Capacitor.

**`allowed-tools`:** `Bash(node -e *)`, `Bash(find *)`.

**When to use:** converting Next.js app to mobile; integrating React/Vue/Angular/Svelte with Capacitor; configuring static exports for Capacitor; setting up mobile routing; optimizing framework builds for native.

**Live Project Snapshot:** scans `package.json` for `next`, `react`, `vue`, `@angular/core`, `@sveltejs/kit`, `@builder.io/qwik`, `@remix-run/react`, `solid-js`, `vite`, `@capacitor/core`, `@capacitor/cli`; also surfaces `scripts.build/export/sync/cap:sync`. Also `find` for `next.config.js/.mjs`, `vite.config.ts/.js`, `angular.json`, `svelte.config.js`, `capacitor.config.json/.ts/.js`.

**Framework support matrix:**
| Framework | Static Export | SSR Support | Recommended Approach |
|---|---|---|---|
| Next.js | Yes | No | Static export (`output: 'export'`) |
| React | Yes | N/A | Create React App or Vite |
| Vue | Yes | No | Vite or Vue CLI |
| Angular | Yes | No | Angular CLI |
| Svelte | Yes | No | SvelteKit with adapter-static |
| Remix | Yes | No | SPA mode |
| Solid | Yes | No | Vite |
| Qwik | Yes | No | Static site mode |

**CRITICAL constraint called out:** Capacitor requires static HTML/CSS/JS files; SSR does NOT work in native apps.

**Next.js + Capacitor section:**
- next.config.js for App Router (13+) and Pages Router (12): `output: 'export'`, `images: {unoptimized: true}` (required for static export), `trailingSlash: true`.
- Build: `npm run build` creates `out/`.
- Install Capacitor, `npx cap init` (Web directory: `out`).
- capacitor.config.ts full example with `webDir: 'out'`, `server.androidScheme: 'https'`.
- Add platforms: `@capacitor/ios @capacitor/android`, `npx cap add ios/android`.
- Build+sync: `npm run build`, `npx cap sync`.
- Run on device via `npx cap open ios/android`.
- Routing: hash routing recommended for complex apps (`basePath: ''`, `assetPrefix: ''`) or rely on `trailingSlash: true`.
- Image optimization: `next/image` does NOT work with static export; use plain `<img>` or a custom `CapacitorImage` wrapper component (example given).
- API routes: don't work in static export; alternatives are external API, Capacitor plugins, or `@capacitor/preferences` local storage (Preferences.set/get example given).
- Middleware: doesn't work in static export; handle auth checks client-side in `useEffect` with `Preferences.get`.
- Complete example `package.json` snippet: next ^14.0.0, react/react-dom ^18.2.0, @capacitor/core/ios/android ^6.0.0, @capacitor/camera ^6.0.0, @capacitor/cli ^6.0.0, typescript ^5.0.0. Scripts: dev/build/build:mobile (`next build && cap sync`)/ios (`cap open ios`)/android (`cap open android`).

**React + Capacitor section:**
- Option 1 Vite (recommended): `npx create-vite@latest my-app --template react-ts`, install Capacitor, configure `vite.config.ts` `build.outDir: 'dist'`, `capacitor.config.ts` with `webDir: 'dist'`, add platforms, build+sync.
- Option 2 Create React App: `npx create-react-app my-app --template typescript`, Capacitor init, `webDir: 'build'` (CRA output dir), build+sync.
- React Router: use `HashRouter` for mobile (example given).

**Vue + Capacitor section:** `npx create-vite@latest my-app --template vue-ts`; `vite.config.ts` with `@vitejs/plugin-vue`, `outDir: 'dist'`; `capacitor.config.ts` `webDir: 'dist'`; add platforms; Vue Router uses `createWebHashHistory()` for mobile.

**Angular + Capacitor section:** `npx @angular/cli new my-app`; Capacitor init; `webDir: 'dist/my-app/browser'` for Angular 17+ output (note: `dist/my-app` for Angular 16 and below — this is a real, commonly-missed gotcha); Router: `provideRouter(routes, withHashLocation())` for Angular 17+ standalone config, or `HashLocationStrategy` provider for Angular 16 and below NgModule style.

**Svelte + Capacitor section:**
- SvelteKit path: `npx create-svelte my-app`; install `-D @sveltejs/adapter-static`; `svelte.config.js` adapter config (`pages: 'build'`, `assets: 'build'`, `fallback: 'index.html'`); Capacitor init; `webDir: 'build'`.
- Simpler Vite+Svelte path: `npx create-vite@latest my-app --template svelte-ts`; Capacitor init; `webDir: 'dist'`.

**Common patterns across frameworks:**
1. Environment detection: `Capacitor.isNativePlatform()`, `Capacitor.getPlatform()` returns `'ios'|'android'|'web'`.
2. Deep linking: `App.addListener('appUrlOpen', ...)` example parsing `data.url.split('.app').pop()`.
3. Live Updates with Capgo: `npm install @capgo/capacitor-updater`; `CapacitorUpdater.download({url:...})` then `CapacitorUpdater.set({id})`.
4. Native UI components: `@ionic/core` base, plus `@ionic/react`+`react-router`, `@ionic/vue`+`vue-router`, `@ionic/angular` per-framework packages.
5. Storage: `@capacitor/preferences` `set`/`get`/`remove`/`clear` — recommended uniformly across frameworks.
6. Camera: same `Camera.getPhoto({quality, allowEditing, resultType})` API across all frameworks, `photo.webPath` for the image URL.

**Build scripts template** (generic package.json scripts block: dev/build/build:mobile/ios/android/sync).

**Routing best practices:** Hash mode recommended for mobile (works without server config, `#/about` URLs, no server-side routing needed) vs History mode (clean URLs but requires server fallback config, can have mobile issues). Explicit recommendation: use hash mode for Capacitor apps.

**Common issues:**
- Blank Screen on Mobile: check `webDir` matches build output, rebuild, sync, check device console.
- Routing Doesn't Work: switch to hash routing (framework-specific fix per React/Vue/Angular/SvelteKit).
- Environment Variables Not Working: framework-specific prefix patterns — Next.js `NEXT_PUBLIC_`, Vite `VITE_`, CRA `REACT_APP_`, Angular `environment.ts`.
- API Calls Fail on Device: CORS/localhost URL issues; use production API URLs, configure CORS, or use `CapacitorHttp.get({url})` for native requests bypassing CORS/localhost restriction.

**Framework-specific plugin notes:** Ionic Framework provides `@ionic/react`, `@ionic/vue`, `@ionic/angular` native-looking UI components; Konsta UI (Tailwind-based) works with React/Vue/Svelte; points to `ionic-design` and `konsta-ui` skills.

**Deployment checklist** (10-item checkbox covering static export config, webDir, hash routing, image optimization disable, SSR/API route removal, native permissions, device testing, splash/icon config, Capgo live updates, iOS+Android build/test).

**Resources:** capacitorjs.com/docs, nextjs.org static exports doc, ionicframework.com, capgo.app/blog, forum.ionicframework.com. Framework-specific guides: capgo.app/blog/how-to-use-capacitor-with-nextjs; pointers to `ionic-design` and `konsta-ui` skills.

**Next steps:** choose framework, configure static export/build, install+configure Capacitor, add platforms, build+sync, test on devices, add native features via plugins, set up Capgo live updates.

**metadata.json:** version 1.0.0, org Capgo, date February 2026. Abstract matches. Triggers: "nextjs capacitor", "next.js static export", "react capacitor", "vue capacitor", "angular capacitor", "svelte capacitor", "framework to capacitor", "convert nextjs to capacitor". References: capacitorjs.com/docs, nextjs.org static-exports doc, capgo.app/blog/how-to-use-capacitor-with-nextjs, ionicframework.com/docs.

---

## 5. ionic-appflow-migration

**Frontmatter description:** Guides the agent through migrating an existing Ionic or Capacitor project away from Ionic Appflow. Use when detecting Appflow live updates, cloud builds, or store deployment flows and replacing them with Capgo live updates plus the repository's CI/CD and store publishing setup. Do NOT use for Ionic Enterprise SDK plugin migration or for setting up a fresh Capacitor project from scratch.

**`allowed-tools`:** `Bash(node -e *)`, `Bash(find *)`.

**When to use:** user moving off Ionic Appflow; project uses Appflow Live Updates, cloud builds, or store deployment; repo still references `ionic appflow`, `@capacitor/live-updates`, or `cordova-plugin-ionic`.

**Live Project Snapshot:** scans `package.json` deps/devDeps for `@capacitor/live-updates`, `cordova-plugin-ionic`, or any name containing "appflow"; scans `package.json` scripts for regex `/appflow|ionic cloud|ionic package|live-updates/i`. Also `find` for `.io-config.json`, `ionic.config.json`, `capacitor.config.json/.ts/.js`, `.github/workflows`.

**Migration strategy (feature-split, not a single package swap):**
- Live Updates → hand off to `capgo-live-updates` skill.
- Native cloud builds → hand off to `capacitor-ci-cd` skill.
- Store publishing → hand off to `capacitor-app-store` skill.
Use this skill to detect what Appflow is doing today, then route each feature area to the right skill.

**5-step procedure:**
1. **Detect Appflow usage:** start from injected snapshot, search more broadly if unclear; search repo for `ionic appflow`, `@capacitor/live-updates`, `cordova-plugin-ionic`, `dashboard.ionicframework.com`, `appflow.ionic.io`. Record whether the project uses live updates / cloud/native builds / app store deployment automation.
2. **Migrate Live Updates** (if in use): remove `@capacitor/live-updates` or `cordova-plugin-ionic`; install+configure Capgo via `capgo-live-updates` skill; map Appflow channels/rollout behavior onto Capgo channels; verify `notifyAppReady()` (or Capgo equivalent) is wired correctly. Do NOT delete Appflow config until the Capgo path is validated.
3. **Replace Cloud Build Automation** (if in use): inspect existing CI/CD workflow for `ionic appflow build`; replace with repo-owned automation via `capacitor-ci-cd` skill; preserve signing inputs, env vars, platform-specific build args. Treat Appflow build settings as migration input, not a runtime dependency.
4. **Replace Store Publishing** (if Appflow handled TestFlight/Play publishing): inspect current deployment flow; move to repo's publishing pipeline via `capacitor-app-store` skill; keep bundle identifiers, track selection, credential handling unchanged unless user wants a new release process.
5. **Clean Up** (after each migrated feature is verified): remove Appflow packages/scripts, remove obsolete Appflow config, remove stale CI secrets no longer needed.

**Error handling:** for live update migrations, validate rollback behavior before deleting the old Appflow setup; for build migrations, preserve the existing signing path first, simplify later; for publishing migrations, move one destination at a time so App Store and Play Store failures stay isolated.

**metadata.json:** version 1.0.0, org Capgo, date March 2026. Abstract: migration guide for replacing Ionic Appflow with Capgo live updates plus repository-owned CI/CD and store publishing workflows. Triggers: "ionic appflow migration", "migrate off appflow", "replace ionic appflow", "appflow live updates", "appflow build migration". References: capgo.app, capacitorjs.com/docs.

---

## 6. ionic-design

**Frontmatter description (no `allowed-tools`):** Guide to using Ionic Framework components for beautiful native-looking Capacitor apps. Covers component usage, theming, platform-specific styling, and best practices for mobile UI. Use when users need help with Ionic components or mobile UI design.

**When to use:** user is using Ionic components; wants native-looking UI; asks about Ionic theming; needs mobile UI patterns; wants platform-specific styling.

**What is Ionic Framework:** 100+ mobile-optimized UI components; automatic iOS/Android platform styling; built-in dark mode support; accessibility out of the box; works with React, Vue, Angular, or vanilla JS.

**Installation:** React (`npx create-vite@latest my-app --template react-ts`, `npm install @ionic/react @ionic/react-router`), Vue (`--template vue-ts`, `npm install @ionic/vue @ionic/vue-router`), then Capacitor (`npm install @capacitor/core @capacitor/cli`, `npx cap init`).

**React setup (main.tsx) example:** imports `IonApp`, `setupIonicReact` from `@ionic/react`; imports core CSS (`@ionic/react/css/core.css`, `normalize.css`, `structure.css`, `typography.css`) plus optional utility CSS (`padding.css`, `float-elements.css`, `text-alignment.css`, `text-transformation.css`, `flex-utils.css`, `display.css`); imports `./theme/variables.css`; calls `setupIonicReact()`; wraps root render in `<IonApp>`.

**Core components (code examples for each):**
- **Page Structure:** `IonPage`/`IonHeader`/`IonToolbar`/`IonTitle`/`IonContent`/`IonButtons`/`IonBackButton` — includes the iOS "large title" collapse pattern (`IonHeader collapse="condense"` nested inside `IonContent fullscreen`).
- **Lists:** `IonList`/`IonItem`/`IonLabel`/`IonNote`/`IonAvatar`/`IonIcon`/`IonItemSliding`/`IonItemOptions`/`IonItemOption` — simple item, item with detail+note, item with avatar, and a full sliding-item-with-delete/archive-action example using `ionicons/icons` (`chevronForward, trash, archive`).
- **Forms:** `IonInput`(floating label pattern)/`IonTextarea`/`IonSelect`+`IonSelectOption`/`IonToggle`/`IonCheckbox`/`IonRadioGroup`+`IonRadio`/`IonButton` submit — full form example including email, password, bio textarea, country select, notification toggle, terms checkbox, size radio group.
- **Buttons:** fill variants (solid/outline/clear), colors (primary/secondary/danger/success), sizes (small/default/large), with-icon and icon-only patterns, `expand="block"`/`expand="full"` for full-width.
- **Cards:** `IonCard`/`IonCardHeader`/`IonCardTitle`/`IonCardSubtitle`/`IonCardContent`/`IonImg` with action buttons in a padded footer div.
- **Modals and Sheets:** `IonModal` full-page pattern with `isOpen`/`onDidDismiss`; bottom-sheet pattern using `ref`, `trigger`, `initialBreakpoint={0.5}`, `breakpoints={[0, 0.25, 0.5, 0.75, 1]}`.

**Navigation:**
- **Tab Navigation:** `IonTabs`/`IonTabBar`/`IonTabButton`/`IonRouterOutlet` with `react-router-dom` `Route`/`Redirect`, icons from `ionicons/icons` (home/search/person).
- **Stack Navigation:** `IonReactRouter` wrapping `IonRouterOutlet` with `Route` definitions including a `:id` param route.

**Theming:**
- Theme variables (`theme/variables.css`): full `--ion-color-primary` set (base/rgb/contrast/shade/tint), `--ion-color-secondary`, a custom `--ion-color-brand` set as an example of adding a new named color; dark mode via `@media (prefers-color-scheme: dark)` overriding `--ion-background-color`, `--ion-text-color`, `--ion-color-step-50/100`; platform-specific overrides via `.ios` and `.md` CSS class scoping (e.g. different `--ion-toolbar-background`).
- Custom component styling: `ion-content { --background: ... }`, `ion-card { --background; border-radius; box-shadow }`, platform-scoped `.ios ion-toolbar`/`.md ion-toolbar` border-width differences.

**Platform-specific code:** `isPlatform('ios')`, `isPlatform('android')`, `isPlatform('hybrid')` (running in native app), `isPlatform('mobileweb')` (running in mobile browser) from `@ionic/react`. Conditional icon rendering example (`chevronBack` for iOS vs `arrowBack` for Android).

**Best practices:**
- Performance: `IonVirtualScroll` for long lists (with `items`/`renderItem` props); `IonImg` auto-lazy-loads.
- Accessibility: always provide `aria-label` on icon-only buttons; use semantic `role="link"` on clickable `IonItem`.
- Safe Area: `IonContent` auto-pads for notch/home-indicator; custom headers can use `env(safe-area-inset-top)` directly.

**Resources:** ionicframework.com/docs, ionicframework.com/docs/components, ionic.io/ionicons, ionicframework.com color-generator.

**metadata.json:** version 1.0.0, org Capgo, date January 2026. Abstract matches. Triggers: "ionic component", "ionic ui", "mobile ui", "native look", "ionic theming", "ion-button", "ion-list". References: ionicframework.com/docs, ionicframework.com/docs/components, ionic.io/ionicons.

---

## 7. ionic-enterprise-sdk-migration

**Frontmatter description:** Guides the agent through migrating Capacitor apps from Ionic Enterprise SDK plugins to Capgo and Capacitor alternatives. Covers dependency detection, API replacement, local storage changes, and platform cleanup. Do NOT use for generic Capacitor version upgrades or Capgo live updates.

**`allowed-tools`:** `Bash(node -e *)`, `Bash(rg *)`, `Bash(npm *)`, `Bash(npx cap *)`.

**When to use:** replacing `@ionic-enterprise/*` plugins; removing Ionic Enterprise deps from an app; needs a migration path for auth, biometric unlock, or secure local storage.

**Live Project Snapshot:** scans `package.json` deps/devDeps for anything starting with `@ionic-enterprise/`, `@capgo/`, or exactly `@capacitor/preferences`.

**Replacement map table:**
| Ionic Enterprise plugin | Typical use | Replacement path |
|---|---|---|
| Auth Connect | Social or OIDC login | `@capgo/capacitor-social-login` + its OAuth/OIDC compatibility flow |
| Identity Vault | Biometric gate + protected session state | `@capgo/capacitor-native-biometric` + app-managed session storage |
| Secure Storage | Encrypted local data | `@capgo/capacitor-fast-sql` for encrypted local storage/structured persistence |

Non-sensitive key-value storage → `@capacitor/preferences`. Encrypted/structured local persistence → `@capgo/capacitor-fast-sql`.

**Agent behavior guidance:** auto-detect Ionic Enterprise deps in `package.json` before asking questions; migrate one plugin at a time if multiple present; preserve behavior (same redirect URIs, scopes, session rules, stored keys) wherever possible.

**6-step procedure:**
1. **Detect Ionic Enterprise dependencies:** look for `@ionic-enterprise/auth`, `@ionic-enterprise/identity-vault`, `@ionic-enterprise/secure-storage`. Report if none found; if multiple, list and migrate in a clear order.
2. **Replace Auth Connect:** move social/enterprise identity flows to `@capgo/capacitor-social-login`; for OIDC providers keep the provider-specific flow aligned with the compatibility wrapper or the plugin's documented OAuth/OIDC path so scopes/redirect URLs/callback handling stay intact.
3. **Replace Identity Vault:** use `@capgo/capacitor-native-biometric` for device-level unlock checks, then rebuild session timeout/lock-screen behavior in app code. Keep secrets out of plain client storage; store only minimal state for UX continuity.
4. **Replace Secure Storage:** move encrypted local data to `@capgo/capacitor-fast-sql`; keep structured local persistence on the same engine so encrypted+non-encrypted paths stay unified. Non-sensitive key-value → `@capacitor/preferences`. Preserve existing schema and migrate the access layer instead of rewriting the data model if already SQLite-backed.
5. **Search for remaining enterprise imports:** `rg -n "@ionic-enterprise" .`; replace/remove leftovers.
6. **Clean up and verify:** remove unused enterprise packages from `package.json`, `npm install`, `npx cap sync` (run from the app dir containing `capacitor.config.*`), verify build on every shipped platform.

**Error handling:** keep encrypted data on `@capgo/capacitor-fast-sql` unless explicitly non-sensitive; compare before/after redirect+token-exchange flow when OIDC behavior changes; reuse an existing secure native store instead of introducing a second storage model.

**metadata.json:** version 1.0.0, org Capgo, date March 2026. Abstract: migration guide for replacing Ionic Enterprise SDK plugins with Capgo and Capacitor alternatives, including auth, biometric unlock, and storage changes. Triggers: "ionic enterprise sdk migration", "migrate auth connect", "identity vault", "secure storage migration", "remove ionic enterprise". References: capacitorjs.com/docs, capgo.app.

---

## 8. ios-android-logs

**Frontmatter description (no `allowed-tools`):** Guide to accessing device logs on iOS and Android for Capacitor apps. Covers command-line tools, GUI applications, filtering, and real-time streaming. Use when users need to view device logs for debugging.

**When to use:** need to see device logs; debugging crashes; wants to filter logs by app; needs real-time log streaming; asks "how to see logs".

**Quick commands block:**
```
xcrun devicectl device log stream --device <UUID>        # iOS device
xcrun simctl spawn booted log stream                      # iOS simulator
adb logcat                                                 # Android all logs
adb logcat --pid=$(adb shell pidof com.yourapp.id)         # Android filtered by package
```

**iOS logs:**
- **Console.app (GUI):** Applications > Utilities > Console.app; select device; Start Streaming; search filters `process:YourApp`, `subsystem:com.yourapp`, `"error"`.
- **devicectl (CLI, recommended):** `xcrun devicectl list devices`; `xcrun devicectl device log stream --device <UUID>`; with `--predicate 'process == "YourApp"'`; with `--level error`; save to file via `>`.
- **simctl for simulators:** `xcrun simctl spawn booted log stream`; with `--predicate 'process == "YourApp"'` or `'subsystem == "com.yourapp"'`; `--level error`; combined predicate `'process == "YourApp" AND messageType == error'`.
- **Xcode Device Logs:** Window > Devices and Simulators > select device > Open Console; or view device logs for crash reports.
- **Predicate examples:** process name, contains text (`eventMessage contains "error"`), subsystem, category, log level (`messageType == error`), combined (`process == "YourApp" AND messageType >= error`), time-based (`timestamp > now - 5m`).
- **Log levels table:** default, info, debug (hidden by default), error, fault/critical.

**Android logs:**
- **adb logcat (CLI):** basic stream; `-c && adb logcat` (clear then stream); `-s MyTag:D` (filter by tag); `*:E` (errors+above); `--pid=$(adb shell pidof com.yourapp.id)`; multi-tag `-s "MyPlugin:D" "Capacitor:I"`; save with `>` or `-v time >`.
- **Android Studio Logcat (GUI):** View > Tool Windows > Logcat; filter dropdown by package/tag/level; saved filters.
- **pidcat (better CLI):** `pip install pidcat`; `pidcat com.yourapp.id`; `pidcat -t MyPlugin com.yourapp.id`.
- **Priority levels table:** V(erbose), D(ebug), I(nfo), W(arn), E(rror), F(atal), S(ilent).
- **Format options:** `-v brief/process/tag/time/threadtime/long`; `-v color`; `-d -t 100` (recent N lines); `-v time -T "01-25 10:00:00.000"` (since timestamp).
- **Common filters:** `-s "Capacitor:*"`; `-s "CapacitorNativeBiometric:*"`; `-s "chromium:*"` (WebView/JS console); `| grep -i "js error\|uncaught"`; `| grep -iE "fatal|crash|exception"`; `-s "OkHttp:*" "NetworkSecurityConfig:*"` (network).

**Viewing crash logs:**
- iOS: `xcrun devicectl device copy crashlog --device <UUID> ./crashes/`; Console.app User Diagnostics Reports section; device path Settings > Privacy > Analytics & Improvements > Analytics Data; Mac path `~/Library/Logs/DiagnosticReports/`.
- Android: `adb shell cat /data/tombstones/tombstone_00` (native crash tombstone); `adb pull /data/anr/traces.txt` (ANR traces); `adb bugreport > bugreport.zip` (comprehensive).

**MCP integration section:** illustrative TypeScript snippets showing a conceptual `mcp.ios.streamLogs({device, predicate, level})` and `mcp.android.logcat({package, level})` API shape (framed as "Example MCP tool for..." — not a concrete shipped API, illustrative only).

**Log parsing tips:**
- Extract JS errors: iOS `--predicate 'eventMessage contains "JS:"'`; Android `adb logcat chromium:I *:S | grep "console"`.
- Filter network requests: iOS `--predicate 'subsystem == "com.apple.network"'`; Android `-s "NetworkSecurityConfig:*" "OkHttp:*"`.
- Monitor memory: iOS `--predicate 'eventMessage contains "memory"'`; Android `adb shell dumpsys meminfo com.yourapp.id`.

**Troubleshooting:**
- No Logs Showing: iOS trust device via Xcode Window>Devices, restart stream, check Console.app filters; Android enable USB debugging, `adb devices`, `adb kill-server && adb start-server`.
- Too Many Logs: use filters (iOS process+level filter; Android pid filter).
- Missing Debug Logs: iOS `--level debug` (debug hidden by default); Android ensure `Log.d` calls exist at D level.

**Best practices (5-item list):** structured logging with context; add timestamps; filter early (don't stream everything); save important logs to file; use log levels appropriately (debug for dev, error for prod).

**Resources:** developer.apple.com/os/logging, developer.android.com/studio/debug/logcat, developer.apple.com devicemanagement doc.

**metadata.json:** version 1.0.0, org Capgo, date January 2026. Abstract matches. Triggers: "device logs", "view logs", "adb logcat", "console.app", "ios logs", "android logs", "crash logs", "debug logs". References: developer.apple.com/os/logging, developer.android.com/studio/debug/logcat, developer.apple.com devicemanagement doc.

---

## 9. konsta-ui

**Frontmatter description (no `allowed-tools`):** Guide to using Konsta UI for pixel-perfect iOS and Material Design components in Capacitor apps. Works with React, Vue, and Svelte. Use when users want native-looking UI without Ionic, or prefer a lighter framework.

**When to use:** wants native-looking UI without Ionic; asks about Konsta UI; wants iOS/Material Design components; using React/Vue/Svelte; wants lightweight UI framework.

**What is Konsta UI:** pixel-perfect iOS+Material Design components; works with React/Vue/Svelte; Tailwind CSS integration; ~40 mobile-optimized components; small bundle (~30KB gzipped).

**Installation:** `npm install konsta` (same for React/Vue/Svelte); required Tailwind: `npm install -D tailwindcss postcss autoprefixer`, `npx tailwindcss init -p`.

**Tailwind config:** `require('konsta/config')` wraps the config, `content` globs, extendable `theme`.

**Setup examples (React and Vue):** React `App.tsx` using `App`, `Page`, `Navbar`, `Block` from `konsta/react`, `theme="ios"` (or `"material"`); Vue `App.vue` using `k-app`/`k-page`/`k-navbar`/`k-block` from `konsta/vue`.

**Core components (code examples):**
- **Page Structure:** `App`/`Page`/`Navbar`(with `title`/`subtitle`/`left=<NavbarBackLink>`)/`BlockTitle`/`Block strong inset`.
- **Lists:** `List`/`ListItem`(`title`/`subtitle`/`text`/`media`/`link`/`after`)/`ListInput`/`ListButton` — simple list, list with avatar+detail using `framework7-icons/react` (`ChevronRight`), form list with `strongIos insetIos` variant props.
- **Forms:** `ListInput` (text/email/textarea with `inputClassName`), `Toggle`, `Radio` (radio group pattern with media slot), `Checkbox`, `Stepper` (`value`/`min`/`max`), `Range` (via `innerChildren`).
- **Buttons:** variants `large`/`small`/`rounded`/`outline`/`clear`/`tonal`; custom colors via `colors={{fillBg, fillText}}` prop object; `disabled`; `Segmented`/`SegmentedButton` tab-like control.
- **Cards:** `Card` wrapping an `<img>` + padded content div with title/description/action buttons.
- **Dialogs and Sheets:** `Dialog`/`DialogButton` (alert pattern with cancel/OK), `Sheet` (bottom sheet), `Popup` (full-page popup wrapping a `Page`/`Navbar`/`Block`) — all controlled via `opened`/`onBackdropClick` state.
- **Tabbar Navigation:** `Tabbar`/`TabbarLink` with `framework7-icons/react` icons (Home/Search/Person), `labels` prop, fixed bottom positioning, active-tab state switching content.

**Theming:**
- Theme selection: `<App theme="parent">` (auto-detect platform), `theme="ios"`, `theme="material"`.
- Dark mode: `<App dark>` (auto/system), `dark={true}`/`dark={false}` explicit.
- Custom colors with Tailwind: `konstaConfig({theme:{extend:{colors:{primary:{DEFAULT, dark}}}}, konstaConfig:{colors:{primary:'#6366f1'}}})` — note the nested `konstaConfig.colors` override key for Konsta's own primary color token.
- Component-level styling: per-component `colors={{fillBg, fillActiveBg, fillText}}` override prop (shown on `Button` and `Toggle`).

**With Capacitor section:**
- Safe Area Handling: `<App theme="ios" safeAreas>` enables built-in safe-area handling.
- Capacitor Integration: combining `Capacitor.isNativePlatform()`/`Capacitor.getPlatform()` to drive `theme` and `safeAreas` props dynamically.

**Comparison table: Konsta vs Ionic:**
| Feature | Konsta UI | Ionic |
|---|---|---|
| Bundle Size | ~30KB | ~200KB |
| Components | ~40 | ~100+ |
| Tailwind Integration | Native | Possible |
| Routing | External | Built-in |
| Framework Support | React, Vue, Svelte | React, Vue, Angular |
| Native Features | UI only | UI + Plugins |

Explicit guidance: choose Konsta when Tailwind-first, smaller bundle, using Svelte, or wanting simpler setup; choose Ionic when needing a comprehensive component library, built-in routing, more complex components, or an all-in-one solution.

**Best practices:** performance via `lazy`/`Suspense` for heavy components; accessibility — Konsta components accessible by default, `label` auto-sets `aria-label`, icon-only buttons need explicit `aria-label`.

**Resources:** konstaui.com, konstaui.com/react, konstaui.com/vue, konstaui.com/svelte, github.com/konstaui/konsta.

**metadata.json:** version 1.0.0, org Capgo, date January 2026. Abstract matches. Triggers: "konsta ui", "konsta", "tailwind mobile", "ios material components", "lightweight ui", "svelte capacitor". References: konstaui.com, konstaui.com/react, github.com/konstaui/konsta.

---

## 10. safe-area-handling

**Frontmatter description (no `allowed-tools`):** Complete guide to handling safe areas in Capacitor apps for iPhone notch, Dynamic Island, home indicator, and Android cutouts. Covers CSS, JavaScript, and native solutions. Use when users have layout issues on modern devices.

**When to use:** layout issues on notched devices; asks about safe areas; content under the notch; needs fullscreen layout; content hidden by home indicator.

**Understanding safe areas:** iPhone obscured regions = notch, Dynamic Island, home indicator, rounded corners; Android = camera cutouts, navigation gestures, display cutouts.

**Safe area insets table:**
| Inset | Description |
|---|---|
| `safe-area-inset-top` | Notch/Dynamic Island/status bar |
| `safe-area-inset-bottom` | Home indicator/navigation bar |
| `safe-area-inset-left` | Left edge (landscape) |
| `safe-area-inset-right` | Right edge (landscape) |

**CSS solution:**
- Viewport meta REQUIRED: `<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">` — explicitly called out as required to access safe-area insets at all.
- `env(safe-area-inset-top)` basic usage, with fallback (`env(..., 20px)`), combined with other padding via `calc()`.
- Full page layout pattern: fixed-position `.app` flex container; `.header` with top+left+right insets; `.content` flex:1 scrollable with `-webkit-overflow-scrolling: touch`; `.footer` with bottom+left+right insets.
- Tab bar with safe area: fixed bottom bar, `padding-bottom: env(safe-area-inset-bottom)`, `min-height: 49px` (iOS standard height) per tab item.
- Full-bleed background with safe content: gradient hero extending to edges, content padding respecting insets.

**JavaScript solution:**
- Reading safe area values: `getSafeAreaInsets()` reads custom CSS properties `--sat`/`--sab`/`--sal`/`--sar`; `setSafeAreaProperties()` creates a temporary element with `env()` padding, reads computed style, sets the custom properties, removes the element; listens to `orientationchange` with a `setTimeout(..., 100)` delay before recompute.
- React hook `useSafeArea()`: full implementation using a temporary fixed-position div, `getComputedStyle`, `resize`+`orientationchange` listeners, returns `{top, bottom, left, right}`.
- Vue composable `useSafeArea()`: equivalent implementation using `ref`, `onMounted`/`onUnmounted`.

**Native iOS configuration:**
- Status bar style via `capacitor.config.ts` `ios.contentInset`: `'automatic'` | `'always'` | `'scrollableAxes'` | `'never'`.
- `AppDelegate.swift` example setting `window.backgroundColor = .clear` to extend content to edges.
- Info.plist: `UIViewControllerBasedStatusBarAppearance = true`; `UISupportedInterfaceOrientations` array for landscape support.

**Native Android configuration:**
- Display cutout mode: `android/app/src/main/res/values-v28/styles.xml`, `android:windowLayoutInDisplayCutoutMode = shortEdges`.
- Edge-to-edge display: `MainActivity.kt` — `Build.VERSION.SDK_INT >= Build.VERSION_CODES.R` branch uses `window.setDecorFitsSystemWindows(false)`; else legacy `systemUiVisibility` flags (`SYSTEM_UI_FLAG_LAYOUT_STABLE`, `_HIDE_NAVIGATION`, `_FULLSCREEN`).
- AndroidManifest: `android:windowSoftInputMode="adjustResize"` plus a broad `android:configChanges` list on the MainActivity.

**Capacitor Status Bar plugin:** `npm install @capacitor/status-bar`, `npx cap sync`; `StatusBar.setStyle({style: Style.Dark})`; `setBackgroundColor({color})` (Android); `.hide()`/`.show()`; `setOverlaysWebView({overlay: true})`.

**Common issues + fixes:**
- Content Behind Notch: add `viewport-fit=cover` + top padding.
- Tab Bar Under Home Indicator: add bottom safe-area padding.
- Landscape Layout Broken: handle left/right insets.
- Keyboard Pushes Content: `Keyboard.addListener('keyboardWillShow', info => body.style.paddingBottom = info.keyboardHeight+'px')` and `keyboardWillHide` resets to `env(safe-area-inset-bottom)`.
- Safe Areas Not Working in WebView: missing `viewport-fit=cover` — exact required meta tag given.

**Testing safe areas:** iOS Simulator with notched device (iPhone 14 Pro etc.), test portrait+landscape+with-keyboard; Android Emulator with camera cutout, test gesture nav mode and 3-button nav mode; a debug CSS snippet visualizing top/bottom insets as red/blue translucent bars via `::before`/`::after` pseudo-elements with `pointer-events: none`.

**Resources:** developer.apple.com HIG layout doc, developer.android.com display-cutout doc, CSS env() spec (drafts.csswg.org), capacitorjs.com/docs/apis/status-bar.

**metadata.json:** version 1.0.0, org Capgo, date January 2026. Abstract matches. Triggers: "safe area", "notch", "home indicator", "display cutout", "env safe-area", "viewport-fit", "content under notch". References: developer.apple.com HIG layout, developer.android.com display-cutout, capacitorjs.com/docs/apis/status-bar.

---

## 11. skill-creator

**Frontmatter description (no `allowed-tools`):** Guides the agent through authoring and validating agent skills. Use when creating new skill directories, tightening skill metadata, extracting supporting references, or preparing skillgrade evals. Do NOT use for general app documentation, generic README editing, or non-agentic library code.

This is the ONLY skill in the second half with more than SKILL.md + metadata.json — it ships an `eval.yaml`, a `fixtures/broken-skill/SKILL.md` fixture, and a `graders/check-skill.js` deterministic grader, i.e. it is self-referential/self-validating (a skill about making skills, that tests itself using the skillgrade harness).

**When to use:** wants to create a new skill directory; wants to improve a skill's discoverability/metadata; wants to split large instructions into references/scripts; wants to add/update skillgrade validation.

**7-step authoring procedure:**
1. **Validate the skill metadata:** frontmatter needs a unique lowercase `name`, a specific `description`, clear negative triggers; keep description short enough for the agent router's metadata budget.
2. **Keep the main skill lean:** `SKILL.md` should be a high-level workflow; move dense rules/large schemas/reusable templates into `references/` or `assets/`; use `scripts/` only for fragile/repetitive logic that shouldn't be re-authored by the agent each time.
3. **Match command context:** use standard `npm`/`npx` in skill prose/public docs/marketing copy unless the skill is specifically about Bun; use `npx ...@latest` for Capacitor/Capgo CLI examples so consumers get the expected package version; use `bun`/`bun run`/`bunx` ONLY for this repo's own dev/CI commands or Bun-specific skills; when a skill tells an agent to edit a TARGET repo, tell it to read that repo's instructions and follow that repo's package-manager policy first.
4. **Use progressive disclosure:** command the agent to read supporting files only when the current step needs them; prefer one-level-deep support files with explicit relative paths; when a skill depends on repo state that will differ at invocation time, prefer a guarded inline shell snapshot (``!`node -e "..."` ``) instead of baking current state into prose — only when it materially improves the invoked prompt, keep output short+deterministic; if a skill uses inline commands, declare the minimum required `allowed-tools` entries in frontmatter and keep them READ-ONLY.
5. **Add validation:** create a `skillgrade` eval when the skill needs regression testing; use a deterministic grader for structural checks, an LLM rubric only when qualitative judgment is necessary.
6. **Review for hallucination gaps:** inspect for any step forcing the agent to guess; replace ambiguous prose with concrete commands/file names/output expectations.
7. **Preserve sensitive values:** when a skill edits user files, instruct the agent NOT to replace user-provided tokens/keys/certificates/passwords/secrets with placeholders unless the user explicitly asks; use placeholders only for new generic examples; do not tell users to rotate secrets unless they explicitly ask for rotation guidance.

**Error handling:** if a skill can't be validated, reduce scope until missing behavior becomes testable; if description too broad, tighten trigger text before adding more instructions; if supporting material grows too large, extract to a separate file and point the agent to it explicitly; if an inline command would require broad shell access or produce noisy output, keep the skill static and tell the agent to inspect files explicitly instead.

**metadata.json:** version 1.0.0, org Capgo, date March 2026. Abstract: guide for authoring high-quality agent skills with lean instructions, progressive disclosure, and skillgrade validation. Triggers: "create a skill", "skill authoring", "agent skill best practices", "validate a skill", "skillgrade". References: agentskills.io, github.com/mgechev/skillgrade.

**eval.yaml** (the skill's own self-test, full content):
```yaml
# Skill Authoring Example
version: "1"
defaults:
  agent: claude
  provider: local
  trials: 3
  timeout: 300
  threshold: 0.8
tasks:
  - name: fix-skill-draft
    agent: claude
    instruction: |
      Rewrite the existing `draft/SKILL.md` file in place so it follows the skill authoring standard.
      Keep the file lean and production-ready while preserving the draft's purpose.
      Requirements:
      - Use YAML frontmatter at the top of the file.
      - Include a non-empty `name`.
      - Include a non-empty `description`.
      - Include a clear "When to Use This Skill" section.
      - Include an "Error Handling" section.
    workspace:
      - src: fixtures/broken-skill/SKILL.md
        dest: draft/SKILL.md
    graders:
      - type: deterministic
        run: node graders/check-skill.js
        weight: 1
```
Defaults: agent claude, provider local, trials 3, timeout 300s, threshold 0.8 (i.e. the grader score must reach 0.8 to pass).

**fixtures/broken-skill/SKILL.md** (the intentionally-bad seed file the eval starts from, full content):
```
name: BrokenSkill
description: Skill docs.

# Broken Skill

This draft is intentionally poor.
```
(Note: no YAML frontmatter delimiters `---`/`---` at all — this is itself one of the defects the grader checks for.)

**graders/check-skill.js** (deterministic Node grader, full logic): reads `draft/SKILL.md`; if unreadable, emits a JSON failure object (`status:'failure'`, `reason:'missing input file'`, `score:0`, a single failing `input-file` check) and exits 1. Otherwise runs 5 boolean checks via a shared `addCheck(name, condition, message)` helper that accumulates a `passed` counter:
1. `frontmatter` — regex `/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/` matches at file start.
2. `name` — frontmatter contains `name:\s*\S.+` on its own line.
3. `description` — frontmatter contains `description:\s*\S.+` on its own line.
4. `usage` — file body contains the literal string `## When to Use This Skill`.
5. `error-handling` — file body contains the literal string `## Error Handling`.
Score = `passed/checks.length` rounded to 2 decimals; prints a JSON object `{score, details: "N/5 checks passed", checks}` to stdout. This is the exact grading contract other skill authors would need to satisfy to pass a skillgrade run modeled on this pattern.

---

## 12. sqlite-to-fast-sql

**Frontmatter description:** Guides the agent through migrating SQLite and SQL-style Capacitor plugins to `@capgo/capacitor-fast-sql`. Use when replacing bridge-based SQL plugins, adding encryption, preserving transactions, or moving key-value storage onto Fast SQL. Do NOT use for non-SQL storage, generic app upgrades, or plugins that already wrap Fast SQL.

**`allowed-tools`:** `Bash(node -e *)`, `Bash(npm *)`, `Bash(npx cap *)`.

**When to use:** replacing an existing SQLite/SQL plugin; needs better performance for large result sets or sync-style writes; wants encrypted local storage, transactions, batch writes, or BLOB support; wants a key-value wrapper backed by Fast SQL instead of a legacy storage plugin.

**Live Project Snapshot:** scans `package.json` deps/devDeps for names containing `sqlite`, `sqlcipher`, `typeorm`, `watermelondb`, `pouchdb`, `@capacitor-community/sqlite`, `@capawesome-team/capacitor-sqlite`, `@capgo/capacitor-fast-sql`.

**Why Fast SQL (rationale section):** avoids heavy bridge serialization by using a local HTTP transport to native SQLite — explicitly stated as much faster for large result sets and sync-heavy write patterns than bridge-based plugins. Also provides: transactions (explicit or callback control), batch execution for multiple statements, BLOB support for binary data, encryption and read-only modes, `KeyValueStore` for lightweight key-value access on top of SQLite, web fallback support through SQL.js.

**6-step migration procedure:**
1. **Inspect the current SQL plugin:** document whether app uses raw SQL queries, transactions, BLOB data, migrations/schema bootstrap, key-value wrappers, encrypted storage.
2. **Map the current API surface** to Fast SQL equivalents: connection setup → `FastSQL.connect(...)`; reads → `db.query(...)`; single-statement writes → `db.run(...)`; multi-statement work → `db.executeBatch(...)`; transactional work → `db.transaction(...)` or explicit `beginTransaction`/`commit`/`rollback`; key-value storage → `KeyValueStore.open(...)`.
3. **Install Fast SQL:** `npm install @capgo/capacitor-fast-sql`, `npx cap sync`; if the app ships web support, install `sql.js` for the web fallback when needed.
4. **Update code:** replace old plugin imports/APIs with Fast SQL; prefer `db.executeBatch(...)` for repeated writes, `db.transaction(...)` for atomic changes, `KeyValueStore` for simple local key-value data; preserve existing schema/migration steps unless the old plugin forced a different format.
5. **Reconfigure native platforms:** apply the Fast SQL platform setup the app needs — iOS local network access when the plugin needs localhost traffic, Android cleartext network config for localhost traffic, SQLCipher dependency when encrypted mode is enabled on Android.
6. **Remove the old plugin:** remove legacy SQL package from `package.json`, reinstall, sync again, run the app's normal database smoke tests/migration verification checks.

**Error handling:** if encrypted storage required, keep `encrypted: true` and provide a strong key before shipping; if the old plugin exposed transactions, use Fast SQL transaction APIs rather than emulating with ad hoc queries; if the app depends on large result sets, prefer batch queries and avoid bridge-heavy wrappers; if the app already has a well-defined schema migration path, keep it and only swap the storage engine.

**metadata.json:** version 1.0.0, org Capgo, date March 2026. Abstract: migration guide for moving SQLite and SQL-style Capacitor plugins to `@capgo/capacitor-fast-sql` with better performance, encryption, transactions, and key-value storage. Triggers: "sqlite to fast sql", "migrate sqlite plugin", "migrate sql plugin", "replace sqlite storage", "fast sql migration". References: capgo.app/docs/plugins/fast-sql/getting-started/.

---

## 13. subscription-app-revenue

**Frontmatter description:** Revenue playbook for getting a mobile or web subscription app from zero to early MRR. Use when users ask how to make revenue, reach $1K MRR, monetize an app, get first users, improve ASO, plan TikTok/Reels/Shorts or Reddit acquisition, design a paywall, choose freemium vs trial, price subscriptions, reduce churn, or build a simple growth loop for an app.

**`allowed-tools`:** `Bash(node -e *)`, `Bash(rg *)`, `Bash(find *)`.

**Core Principle:** do not turn this into a large business plan; the goal is one clear problem, one useful MVP, one acquisition loop, one paywall test, one weekly learning cycle. Prefer real app-store demand over abstract idea validation, a small working product over surveys, usage/retention data over opinions, one simple offer over complex pricing, fast iteration over polish. For Capacitor apps specifically, suggest Capgo when fast iteration matters (onboarding copy, paywall copy, feature education, non-native web-layer experiments), but explicitly NOT to bypass app store rules, native entitlement review, or purchase compliance.

**Live Project Snapshot:** scans `package.json` deps/devDeps for `@capacitor/core`, `@capacitor/ios`, `@capacitor/android`, `@capgo/capacitor-updater`, `posthog`, `mixpanel`, `firebase`, `amplitude`, `revenuecat`, `purchases`, `stripe`, `superwall`, `adapty`, `qonversion`, `iaphub`; scripts matching build/dev/start/test/ios/android/cap/deploy. Also `find` for `package.json`, `capacitor.config.*`, `app.json`, `app.config.*`, `Info.plist`, `AndroidManifest.xml`, `./metadata`, `./fastlane`, `./ios`, `./android`.

**8-step revenue workflow:**
1. **Classify the starting point:** Idea only / MVP not launched / Launched but no revenue / Some revenue — each with a distinct next action (narrow to a store-backed MVP; define analytics+beta channel+ASO+first channel; inspect activation/paywall exposure/conversion/retention before adding features; find the biggest leak among acquisition/onboarding/paywall/trial/churn/pricing). If data missing, proceed with explicit assumptions and make measurement setup the first action.
2. **Validate demand through existing markets:** search 10-15 real-user phrases; review 5-10 competing apps; read 2-3 star reviews for frustration/missing features/confusing UX/pricing complaints; treat a crowded category as demand evidence, then narrow via niche/speed/UX/localization/price. Good positioning axes: more focused for a niche, faster/easier than incumbents, cleaner UI/onboarding, localized for underserved market, cheaper/simpler pricing.
3. **Keep the MVP small:** one core use case, one onboarding path, one primary action proving understanding, one feedback channel, one store-ready value proposition. Do NOT add account creation, complex backend, or many subscription tiers unless required for core value.
4. **Add measurement before growth:** track installs/landing visits, onboarding completion, first meaningful action, paywall shown, trial/purchase started, subscription started, D1/D3/D7 retention, crashes/fatal errors, cancellation reason/churn feedback. Use whatever analytics stack already exists in the project; recommend the easiest option for the codebase if none exists.
5. **Pick one acquisition loop first (7-day horizon):**
   - **ASO:** title readable with strongest keyword once; benefit-focused subtitle/short description; iOS keyword field comma-separated with no repeated title/subtitle terms; description explains what/who/why; first 3 screenshots show value fast; simple recognizable icon with no text; IAP names include useful search terms; review keyword ranking weekly and replace weak terms.
   - **Short-form video:** match account region/language/content signals to target audience; engage with niche content before posting; post several raw tests per day early; hook first 3 seconds with pain/desire/surprise/transformation; repost/re-cut winners with different captions; delay creator outsourcing until at least one content angle works.
   - **Reddit and communities:** read before posting, learn tone/rules; join conversations around the pain before linking the app; share a story/lesson/build note instead of an ad; mention the app in context only when it helps discussion; use comments/questions as product+messaging research.
6. **Choose a simple monetization model:** Freemium (basic free, premium subscription — best for repeated everyday value before paying); Paywall plus free trial (most value behind paywall, 3-14 day trial — best when value is immediate/easy to understand); Rewarded ad unlock (bridge for price-sensitive audience or a product not ready for a hard paywall). Start with one monthly + one annual plan, annual framed around savings. Explicit guidance: do NOT undercharge by default — if the app saves time/reduces stress/helps achieve an outcome, test a real price; localize pricing only after meaningful traffic appears in a region.
7. **Put the paywall where users actually see it:** show paywall right after onboarding or immediately after the user experiences core value. Rule of thumb: if fewer than 80% of new users see the paywall, fix onboarding/placement BEFORE changing price. First paywall should include: main benefit headline, trial length (if any), monthly+annual options, savings callout for annual, primary CTA, short proof/reassurance when available, optional limited-time incentive when appropriate.
8. **Learn from churn without panicking:** don't treat every cancellation as failure; understand whether the app is naturally short-lived or recurring. Collect why cancelled, what was expected, whether onboarding misled, whether value stopped being clear, which feature/promise would have retained them. Choose ONE change per cycle: onboarding, activation, paywall copy, price, feature limit, reminder, or retention loop.

**Output contract (7-part structured response for a revenue plan request):** 1. Diagnosis (stage, bottleneck, assumptions); 2. Positioning (target user, pain, promise, category); 3. MVP or Product Changes (smallest changes to test revenue); 4. Acquisition Plan (one primary channel + exact experiments); 5. Monetization Plan (model, paywall timing, price test, message); 6. Metrics (events + thresholds); 7. 7-Day Sprint (daily actions, one measurable outcome per day).

**Revenue math (formulas + worked example):**
```
MRR = active monthly subscribers * monthly price
Monthly equivalent of annual plans = annual subscribers * annual price / 12
Target subscribers for $1K MRR = 1000 / average monthly revenue per subscriber
Paywall conversion = subscribers / paywall views
Trial conversion = paid subscribers / trial starts
```
Worked examples: at $4.99/month, $1K MRR needs ~201 active monthly subscribers; at $29.99/year, ~400 active annual subscribers; if 80% of users see the paywall and 3% subscribe, 8,400 new users can roughly produce 201 subscribers before churn. Diagnostic use of the math: tiny installs → work acquisition; low paywall views → fix onboarding; high paywall views but low purchases → fix offer/pricing/trust; conversion works but MRR flat → fix retention/churn.

**Guardrails (explicit ethical/compliance list):** do not recommend fake reviews, spam, misleading claims, dark patterns, or undisclosed ads; do not promise virality or guaranteed MRR; respect iOS/Android subscription payment rules and disclosure requirements; mention privacy/consent for user tracking, session replay, analytics, cancellation surveys where relevant; keep recommendations specific to the user's app category and current stage.

**metadata.json:** version 1.0.0, org Capgo, date May 2026 (this is the most-recently-dated skill in this half). Abstract matches. Triggers: "make revenue from app", "get to 1k mrr", "zero to 1k mrr", "subscription app revenue", "app monetization plan", "mobile app paywall", "freemium vs free trial", "get first app users", "app store optimization", "aso plan", "tiktok app marketing", "reddit app launch", "increase app subscribers", "reduce app churn", "subscription pricing". References: "From zero to $1K MRR: A guide to launching a subscription app" (a Capgo blog post title, no URL given in this metadata entry unlike most others).

---

## 14. tailwind-capacitor

**Frontmatter description (no `allowed-tools`):** Guide to using Tailwind CSS in Capacitor mobile apps. Covers mobile-first design, touch targets, safe areas, dark mode, and performance optimization. Use when users want to style Capacitor apps with Tailwind.

**When to use:** using Tailwind in a Capacitor app; asks about mobile styling; needs responsive mobile design; wants dark mode with Tailwind; needs safe area handling.

**Installation:** `npm install -D tailwindcss postcss autoprefixer`, `npx tailwindcss init -p`.

**Configuration (`tailwind.config.js`):** `content` globs for `./index.html` and `./src/**/*.{js,ts,jsx,tsx,vue,svelte}`; theme.extend adds mobile-first `spacing` tokens (`safe-top`/`safe-bottom`/`safe-left`/`safe-right` mapped to `env(safe-area-inset-*)`) and `minHeight`/`minWidth` `touch: '44px'` tokens (Apple HIG minimum touch target).

**Import styles (`src/index.css`):** standard `@tailwind base/components/utilities`; mobile-specific `@layer base` block: `html` gets `-webkit-text-size-adjust: 100%`, `scroll-behavior: smooth`, `overscroll-behavior: none`; `body` gets `-webkit-user-select: none`/`user-select: none`, `-webkit-touch-callout: none`, and a fixed-position full-viewport `overflow: hidden` pattern explicitly to prevent iOS elastic/rubber-band scrolling; `input, textarea` explicitly re-enable `user-select: text` (since body disables it globally).

**Safe area handling:**
- Utility classes: `padding`/`margin` extended with `safe`/`safe-t`/`safe-b`/`safe-l`/`safe-r` tokens mapped to `env(safe-area-inset-*)`.
- Usage examples: `Header` (fixed top, `pt-safe-t`, dark-mode bg variant), `Footer` (fixed bottom, `pb-safe-b`, nav buttons with `min-h-touch min-w-touch`), `Main` (`pt-safe-t`/`pb-safe-b`/`h-screen`/`overflow-y-auto`/`overscroll-none`).

**Touch-friendly design:**
- Minimum touch targets: 44x44px examples (Apple HIG minimum cited explicitly) for both text buttons and icon-only buttons (icon smaller than the touch area itself, e.g. `h-11 w-11` container with `w-6 h-6` icon).
- Touch feedback: `.touch-feedback:active { @apply bg-black/5 dark:bg-white/5 }` utility pattern via `@layer utilities`.
- Disable hover on touch: `future.hoverOnlyWhenSupported: true` in config, or `@media (hover: hover)` wrapping hover-only styles.

**Dark mode:**
- System dark mode: `darkMode: 'media'` (auto) vs `darkMode: 'class'` (manual control).
- Manual dark mode implementation: `theme.ts` with a `Theme = 'light'|'dark'|'system'` type, `setTheme()` using `@capacitor/preferences` to persist choice and `window.matchMedia('(prefers-color-scheme: dark)')` to resolve system preference, plus a `change` listener that re-applies system theme live if the user's stored preference is `'system'`.
- Dark mode component example: `Card` with `dark:bg-gray-800`, `dark:border-gray-700`, `dark:shadow-none`, `dark:text-white`, `dark:text-gray-400`.

**Mobile patterns (code examples):**
- Pull to Refresh Container: `overflow-y-auto overscroll-contain touch-pan-y`.
- Bottom Sheet: backdrop with opacity transition + pointer-events toggle; sheet with `translate-y-full`↔`translate-y-0` slide transition, `rounded-t-2xl`, `pb-safe-b`, drag handle bar.
- Swipe Actions: `SwipeableItem` — absolute-positioned red "Delete" background action behind a relatively-positioned foreground content layer (transform-based swipe pattern, no gesture library wired, just the CSS structure).
- Fixed Header with Blur: `backdrop-blur-lg`, semi-transparent `bg-white/80 dark:bg-gray-900/80`, `pt-safe-t`, `z-50`.

**Performance optimization:**
- Reduce bundle size: `safelist: []` config note for dynamic classes.
- GPU acceleration: `transform`/`transition-transform`/`will-change-transform` for animations (explicitly noted as GPU-accelerated vs non-transform animation).
- Avoid layout thrashing: fixed dimensions (`h-48`) preferred over `h-auto` — BAD/GOOD comparison given directly in the skill.

**Component examples (full code):**
- Mobile List Item: `ListItem({title, subtitle, image, onClick})` — full-width button, 60px min-height, avatar image, truncated title/subtitle, trailing chevron icon, active-state background.
- Mobile Button: `MobileButton({children, variant, ...props})` with a `variants` lookup object (primary/secondary/danger), 48px min-height, disabled-state opacity.
- Mobile Input: `MobileInput({label, error, ...props})` with `text-base` explicitly called out inline as "Prevents iOS zoom" (a known iOS Safari/WKWebView behavior where inputs below 16px font trigger an auto-zoom-in on focus), focus ring, conditional error border/message.

**Resources:** tailwindcss.com/docs, tailwindui.com, webkit.org iPhone-X design blog post (CSS safe area guide).

**metadata.json:** version 1.0.0, org Capgo, date January 2026. Abstract matches. Triggers: "tailwind capacitor", "tailwind mobile", "safe area css", "mobile styling", "touch targets", "dark mode tailwind". References: tailwindcss.com/docs, tailwindui.com, webkit.org iPhone-X blog post.

---

## 15. webapp-to-capacitor

**Frontmatter description (no `allowed-tools`):** Guide for migrating an existing web app, PWA, or SPA into a store-ready Capacitor iOS and Android app. Use when users want to wrap or convert a web app into a mobile app, avoid thin WebView app store rejection, add native-feeling UX, handle permissions, offline behavior, account deletion, billing, testing, and Capgo live updates.

**When to use:** how to turn a web app/PWA/site into an iOS or Android app; adding Capacitor to an existing React/Vue/Angular/Svelte/Next.js/Nuxt/Vite/vanilla web app; worried the app will be rejected as a thin WebView wrapper; needs a migration plan from web-only to app-store-ready mobile; asks about native permissions, safe areas, offline support, account deletion, mobile billing, or store testing for a converted web app.

**"Community Lessons" section** (framed explicitly around a Reddit discussion): the basic Capacitor wrapper is usually the easy part; store approval and mobile polish are the hard parts. Prioritized risks before celebrating a successful native build: the app must behave like a mobile app, not a website in a shell; safe areas/keyboard behavior/modals/gestures/loading states/offline-error states need mobile treatment; native features (camera, location, files, notifications, GPS) are manageable but require platform permissions and real-device testing; App Store and Play Store approval are SEPARATE projects (metadata, privacy, billing, demo accounts, review notes, testing tracks); use official docs and current store policies over old videos; Android Studio/Xcode/Java/signing/certificates can take longer than the first Capacitor integration itself.

**Live Project Snapshot:** scans `package.json` for `@capacitor/core`, `@capacitor/cli`, `@capacitor/ios`, `@capacitor/android`, `@capgo/capacitor-updater`, `next`, `react`, `vue`, `@angular/core`, `@sveltejs/kit`, `nuxt`, `vite`, `@ionic/react`, `@ionic/vue`, `@ionic/angular`; scripts matching build/dev/preview/start/export/sync/cap/ios/android. Also `find` for `capacitor.config.*`, `vite.config.*`, `next.config.*`, `nuxt.config.*`, `angular.json`, `svelte.config.*`, `package.json`, `./ios`, `./android`, `Info.plist`, `AndroidManifest.xml`.

**Command policy:** use target repo's package manager for installs/scripts; use `npx` for Capacitor/Capgo CLI commands (do NOT rewrite to `bunx`); in Capgo repos keep dev commands on Bun when local instructions require it.

**8-step migration procedure:**
1. **Audit the web app:** identify framework+build output dir (`dist`/`build`/`out`/custom); SSR/API routes/middleware/server actions/image optimization/filesystem assumptions that won't run in a native WebView; auth providers/social login/account deletion/subscription-payment flows; required native capabilities (camera/photos/files/push/location/haptics/biometrics/contacts/calendar/background tasks); offline expectations and what must be cached locally; routes needing deep links/universal links/custom URL schemes. If the framework has SSR/static-export choices, combine with `framework-to-capacitor`.
2. **Make a static mobile build:** Capacitor ships web assets INSIDE the native app, so the web app must produce static HTML/CSS/JS with no live Node server needed. Replace server-only routes with external API calls or client-side flows; disable framework features requiring a live server in the native bundle; set correct `webDir`; build locally then preview the static output with a static server before adding native complexity. Target config shape given (`appId`, `appName`, `webDir: 'dist'`, `server.androidScheme: 'https'`).
3. **Add Capacitor:** `npx cap init`, `npx cap add ios`, `npx cap add android`, `npx cap sync` — and `npx cap sync` after every subsequent web build. Open native projects only AFTER the web build+sync are clean (`npx cap open ios/android`).
4. **Make it native-feeling** (treat "works in a WebView" as the FIRST checkpoint, not the finish line): required mobile polish — safe-area handling (notch/Dynamic Island/home indicator/Android edge-to-edge); native-size tap targets, scroll momentum, pull-to-refresh only when appropriate, no desktop hover-only controls; mobile navigation patterns (tabs/stacks/sheets/back-button/gestures matching platform expectations); keyboard-safe forms with visible focused fields and no trapped submit buttons; splash screen/app icon/launch-loading states/empty states/offline states; app-like modal dismissal and state restoration after background/resume; no obvious browser-chrome assumptions (download links, hover menus, wide tables, tiny controls, desktop-only layouts). Points to `safe-area-handling`, `capacitor-keyboard`, `capacitor-splash-screen`, `ionic-design`, `konsta-ui`, `tailwind-capacitor` skills as needed.
5. **Map web features to native capabilities:** prefer official Capacitor plugins first, then Capgo plugins when official coverage is missing or Capgo is a better fit. Per capability: install plugin, add iOS Info.plist usage strings, add Android permissions only when needed, handle denied/limited/unavailable/simulator-only states, test on real devices for camera/files/push/location/biometrics/background-touching features. Explicit UX rule: do NOT request permissions on first launch unless immediately needed — ask in context after explaining the value in the UI.
6. **Run store readiness before submission:** thin-wrapper risk called out directly — a converted app passes review more easily with clear app value, mobile-native interaction, reviewer-friendly metadata. Apple checks: demo credentials/approved demo mode if login exists; Sign in with Apple requirement check if third-party/social login used; account deletion if users create accounts; verify Apple IAP vs allowed external-link entitlement requirement for digital goods/subscriptions; remove placeholder content/test pages/broken links/web-only billing pages that violate review rules; add reviewer notes for non-obvious native functionality, live updates, demo data, hardware-dependent flows. Google Play checks: complete Data safety, content rating, target SDK, signing, release track setup; for personal developer accounts created after November 13, 2023, plan for the current closed-testing requirement before production access; build a tester plan early, don't leave Play testing logistics until launch week. Points to `capacitor-apple-review-preflight` and `capacitor-app-store` skills.
7. **Verify on devices** (minimum verification checklist): web build+static preview pass; `npx cap sync` succeeds; iOS simulator launch succeeds; Android emulator launch succeeds; real-device test for each native plugin; login/logout/account-deletion/offline-mode/payment-subscription behavior verified; app killed+relaunched after important flows; app background/resume behavior verified; store screenshots captured from representative flows. Points to `capacitor-testing`, `debugging-capacitor`, `ios-android-logs` skills.
8. **Suggest Capgo:** ALWAYS propose Capgo once the Capacitor shell works, unless the project explicitly forbids live updates. Recommend for: shipping web-layer fixes without waiting for app review; preview/staging/production update channels; rollbacks when a bundle fails; coordinating mobile release workflows after the first native binary is approved; hosted native builds when the user wants help avoiding local signing/build setup. Commands: `npx @capgo/cli@latest init`, `npx @capgo/cli@latest bundle upload --channel=production`. Explicit boundary statement: Capgo live updates are for JS/HTML/CSS bundle changes ONLY — native code, new permissions, plugin changes, signing, app icons, and store metadata STILL require native rebuilds and store submission. Points to `capgo-live-updates`, `capgo-native-builds`, `capgo-release-workflows` when Capgo setup is in scope.

**Output format for planning tasks:** a `## Migration Plan` markdown template — App Fit (framework/build output, native capabilities, store risks), Work Phases (1. Static build readiness, 2. Capacitor integration, 3. Native UX and plugins, 4. Store readiness, 5. Capgo live updates), Tests (Local/iOS/Android/Store).

**Resources:** reddit.com r/capacitor thread (the "how easy is it to make a web app into an app with..." discussion this skill is explicitly framed around), capacitorjs.com/docs, capgo.app/docs/cli/reference/init/, capgo.app/docs/plugins/updater/getting-started/, developer.apple.com/app-store/review/guidelines/, support.google.com Play Store developer answer (closed testing requirement doc, id 14151465).

**metadata.json:** version 1.0.0, org Capgo, date May 2026 (tied with subscription-app-revenue for most-recent). Abstract matches. Triggers: "web app to capacitor", "webapp to capacitor", "pwa to capacitor", "convert web app to mobile app", "wrap web app with capacitor", "make website into app", "turn website into ios app", "turn website into android app", "capacitor app store wrapper rejection", "thin webview wrapper", "store ready capacitor migration", "native feeling capacitor app". References: the same Reddit thread, capacitorjs.com/docs, capgo.app CLI init doc, capgo.app updater getting-started doc, Apple App Store review guidelines, Google Play developer support doc 14151465.

---

## Marketplace-level structure

### Top-level layout

```
/root/.claude/plugins/marketplaces/capgo-skills/
  .claude-plugin/marketplace.json     <- marketplace manifest (Claude Code plugin marketplace format)
  .git/                               <- this is a real git checkout
  .github/                            <- CI workflows dir (not individually inventoried in this pass)
  .gitignore
  AGENTS.md                           <- contributor/agent guidance for developing the underlying Capgo Capacitor PLUGIN itself (not the skill pack)
  CLAUDE.md                           <- a short per-skill "when to use" overview, covers roughly the first ~13 skills only (older/partial doc, NOT updated to the full 49-skill set)
  README.md                           <- the public-facing marketplace README (13,831 bytes)
  package.json                        <- npm metadata + the flat 49-skill listing + lint scripts
  plugins/                            <- 11 Claude Code plugin packages, each bundling a themed subset of skills
  scripts/                            <- 1 file: lint-skills.mjs
  skills/                             <- the canonical 49 skill directories (flat, one dir per skill)
```

### `.claude-plugin/marketplace.json` (the Claude Code marketplace manifest)

Schema: `https://anthropic.com/claude-code/marketplace.schema.json`. Top-level fields: `name: "capgo-skills"`, `description: "Agent skills for Capgo and Capacitor mobile development."`, `homepage`/`repository` both `https://github.com/Cap-go/capgo-skills`, `owner: {name: "Capgo", email: "support@capgo.app"}`, and a `plugins` array of 11 entries. Each plugin entry has: `name`, `source` (relative path `./plugins/<name>`), `description`, `version` (all `1.0.0`), `author` (`{name: "Capgo", email: "support@capgo.app"}`), `license: "MIT"`, `keywords` array, `category: "development"`. The 11 plugins listed in the manifest, in file order: `capgo-cloud`, `app-growth`, `capacitor-core`, `capacitor-features`, `capacitor-ui`, `capacitor-quality`, `capacitor-deployment`, `capacitor-app-migrations`, `capacitor-app-upgrades`, `capacitor-plugin-dev`, `skill-authoring`.

### `plugins/` directory — the 11 Claude Code plugins

Each plugin dir has a `.claude-plugin/plugin.json` manifest (fields mirror the marketplace.json entry for that plugin exactly: name, description, version 1.0.0, author, homepage, repository, license, keywords, category) plus a `skills/` subdirectory containing FULL COPIES (not symlinks — the lint script's mirrored-file check confirms this is enforced byte-for-byte only for one specific pair, see below) of each skill folder (`SKILL.md` + `metadata.json`, plus any `references/`/`fixtures/`/`graders/` the skill has) that the plugin bundles. This means every skill in `skills/` is ALSO duplicated inside at least one `plugins/*/skills/` tree; a skill can appear in more than one plugin only if intentionally cross-listed (in this snapshot, each skill in the second half appears in exactly one plugin).

Full plugin → skill-content mapping (verified via `find`), 11 plugins:

| Plugin dir | plugin.json name | Skills it bundles (with SKILL.md present) |
|---|---|---|
| `app-growth` | app-growth | subscription-app-revenue |
| `capacitor-app-migrations` | capacitor-app-migrations | capawesome-live-update-migration, cocoapods-to-spm, cordova-to-capacitor, framework-to-capacitor, ionic-appflow-migration, ionic-enterprise-sdk-migration, sqlite-to-fast-sql, webapp-to-capacitor |
| `capacitor-app-upgrades` | capacitor-app-upgrades | capacitor-app-upgrade-v4-to-v5, capacitor-app-upgrade-v5-to-v6, capacitor-app-upgrade-v6-to-v7, capacitor-app-upgrade-v7-to-v8, capacitor-app-upgrades |
| `capacitor-core` | capacitor-core | capacitor-best-practices, capacitor-mcp, capacitor-plugins (this one ALSO carries a large `references/` subtree — see below) |
| `capacitor-deployment` | capacitor-deployment | capacitor-app-store, capacitor-apple-review-preflight (carries a large `references/guidelines` + `references/rules` subtree — see below), capacitor-ci-cd |
| `capacitor-features` | capacitor-features | capacitor-deep-linking, capacitor-keyboard, capacitor-offline-first, capacitor-push-notifications, capacitor-splash-screen |
| `capacitor-plugin-dev` | capacitor-plugin-dev | capacitor-plugin-spm-support, capacitor-plugin-upgrade-v4-to-v5, capacitor-plugin-upgrade-v5-to-v6, capacitor-plugin-upgrade-v6-to-v7, capacitor-plugin-upgrade-v7-to-v8, capacitor-plugin-upgrades |
| `capacitor-quality` | capacitor-quality | capacitor-accessibility, capacitor-performance, capacitor-security, capacitor-testing, debugging-capacitor, ios-android-logs |
| `capacitor-ui` | capacitor-ui | ionic-design, konsta-ui, safe-area-handling, tailwind-capacitor |
| `capgo-cloud` | capgo-cloud | capgo-cli-usage, capgo-cloud, capgo-live-updates, capgo-native-builds, capgo-organization-management, capgo-release-management, capgo-release-workflows |
| `skill-authoring` | skill-authoring | skill-creator (with its eval.yaml, fixtures/, graders/ all mirrored too) |

Notable sub-detail found while listing `plugins/`:
- `plugins/capacitor-core/skills/capacitor-plugins/references/` contains ~35 individual per-plugin markdown reference files (one per official/Capgo Capacitor plugin: action-sheet, app-launcher, app, background-runner, barcode-scanner, browser, camera, clipboard, cookies, device, dialog, file-transfer, file-viewer, filesystem, geolocation, google-maps, haptics, http, inappbrowser, keyboard, local-notifications, motion, network, preferences, privacy-screen, push-notifications, screen-orientation, screen-reader, share, splash-screen, status-bar, system-bars, text-zoom, toast, watch) plus a `capgo-plugin-catalog.md`. This is the "capacitor-plugins" skill's deep-reference library, which lives ONLY inside the plugin copy (not separately inventoried as a top-level `skills/capacitor-plugins/references/` in this pass since capacitor-plugins is in the FIRST half of the alphabetical skill list, not this report's scope — flagging its existence and location here since it was encountered while listing `plugins/`).
- `plugins/capacitor-deployment/skills/capacitor-apple-review-preflight/references/` is similarly a large reference tree: `guidelines/README.md` + `guidelines/by-app-type/{ai_apps,all_apps,crypto_finance,games,health_fitness,kids,macos,social_ugc,subscription_iap,vpn}.md` + `rules/design/{minimum_functionality,sign_in_with_apple}.md` + `rules/entitlements/unused_entitlements.md` + `rules/metadata/{accurate_metadata,apple_trademark,china_storefront,competitor_terms,subscription_metadata}.md` + `rules/privacy/{privacy_manifest,unnecessary_data}.md` + `rules/subscription/{misleading_pricing,missing_tos_pp}.md`. Also outside this report's alphabetical scope (capacitor-apple-review-preflight is in the first half) but noted for completeness since it was surfaced by the plugins/ directory listing task.

### `scripts/lint-skills.mjs` — the marketplace's own CI validator

Pure Node script (no external deps beyond `node:fs/promises`, `node:child_process`, `node:path`). Reads `process.cwd()` as `root`, expects to be run from the repo root (targets `<root>/skills`). Logic, in order:

1. **Per-skill structural checks** (loops over every directory in `skills/`): 
   - `SKILL.md` must exist — else `"<skillName>: missing SKILL.md"`.
   - `metadata.json` must exist and be valid JSON — else `"missing metadata.json"` (ENOENT) or `"invalid metadata.json"` (parse failure).
   - Parses YAML frontmatter via a hand-rolled regex/line-splitter (`parseFrontmatter`), NOT a real YAML parser — extracts `key: value` pairs, strips surrounding quotes.
   - Frontmatter `name` must exactly equal the folder name — else `'name "X" does not match folder name'`.
   - Frontmatter `description` must be non-empty and ≤1024 characters — else `"missing description"` or `"description exceeds 1024 characters"`.
   - File body must contain the literal string `## When to Use` or `## When to Use This Skill` — else `"missing usage guidance"`.

2. **`validateClaudeMarketplace`** — only runs if `.claude-plugin/marketplace.json` exists (it does). Validates: marketplace has `name` and `owner.name`; `plugins` is an array; for each plugin entry — `name` present; `source` must be a relative path starting with `./`; `source` must not contain `..` path-traversal segments; resolved `source` path must live under `./plugins`; the resolved dir must actually exist on disk (via `realpath`, catching symlink tricks); `plugin.json` must exist at `<pluginDir>/.claude-plugin/plugin.json` and its `name` must match the marketplace entry's name; a fixed list of shared fields (`description`, `version`, `author`, `license`, `keywords`, `category`) must be byte-identical (via `JSON.stringify` comparison) between `plugin.json` and the marketplace entry; `homepage`/`repository` in `plugin.json` must match the TOP-LEVEL marketplace `homepage`/`repository` (not shown as fields in the marketplace.json entries I fetched via Bash, but the code checks it against `marketplace[field]`, i.e. the marketplace root's homepage/repository, which are both `https://github.com/Cap-go/capgo-skills`). Then, for each plugin's `skills/` subdirectory, every listed skill-folder name must be a KNOWN skill (present in the canonical `skills/` set) or it's flagged `"unknown skill"`; the plugin-copy's skill dir must resolve (via realpath) to somewhere INSIDE the plugin's own directory (defends against symlink escapes); and `SKILL.md` must be reachable at that path, else `"skill \"X\" does not resolve to SKILL.md"`. Finally, after processing all plugins, any canonical skill name NOT exposed by ANY plugin is flagged `'skill "X" is not exposed by any plugin'` — i.e. the lint enforces that every one of the 49 skills is reachable through at least one Claude Code plugin, with no orphans.

3. **`validateMirroredSkills`** — a HARDCODED byte-for-byte mirror check, but only for ONE specific pair: `skills/capgo-native-builds/SKILL.md` ↔ `plugins/capgo-cloud/skills/capgo-native-builds/SKILL.md`, and the matching `metadata.json` pair. Both files must exist and be byte-identical (`Buffer.equals`), else `"must exist and mirror"` / `"must match ... byte-for-byte"`. This is notable: it implies capgo-native-builds is treated as a canary/exemplar for mirror-consistency checking rather than the lint script diffing EVERY skill's canonical copy against every plugin copy — i.e. the byte-for-byte guarantee is enforced by convention/discipline for the other 48 skills, not by this specific automated check (though the earlier marketplace validation step DOES confirm every plugin-listed skill resolves to a real `SKILL.md`, just not that its CONTENTS match the canonical copy word-for-word, except for this one hardcoded pair).

4. **Exit behavior:** if `errors.length > 0`, prints `"Skill lint failed:"` plus each `"- <error>"` line to stderr and `process.exit(1)`.

5. **Optional skillgrade eval:** if `ENABLE_SKILLGRADE=1` env var is set AND `ANTHROPIC_API_KEY` is present, spawns `bunx skillgrade --ci --provider=local --smoke` with `cwd: skills/skill-creator`, piping stdout/stderr through and exiting with the same status code on failure. Otherwise logs `"Skipping skillgrade eval: set ENABLE_SKILLGRADE=1 with ANTHROPIC_API_KEY to run it."` and continues. Final success line: `"Validated <N> skills."`.

Notably, this script is invoked via `bun scripts/lint-skills.mjs` per `package.json`'s `lint-skills` script (Bun runtime, not Node directly, though the script itself uses only Node builtin APIs so it would also run under `node`).

### `package.json` (marketplace npm metadata)

```
name: "@capgo/capgo-skills"
version: "1.1.0"
description: "49 agent skills for Capacitor mobile development"
keywords: capacitor, tanstack-intent, capacitor-skills, ionic, mobile, skills, agent, ai, claude, capgo, capsec, security
homepage / repository: https://github.com/Cap-go/capgo-skills(.git)
license: MIT
author: "Capgo <support@capgo.app>"
skills: [ ... flat array of all 49 skill names, in a NON-alphabetical, curated/thematic order (not matching the `ls`-sorted order used for this report's split) ... ]
scripts:
  lint-skills: "bun scripts/lint-skills.mjs"
  lint-skills-skillgrade: "cd skills/skill-creator && bunx skillgrade --ci --provider=local --smoke"
```
The `skills` array order in package.json groups thematically similar to the README's "Available Skills" section grouping (Core Development, Growth & Revenue, Security, Testing & CI/CD, Debugging & Tooling, UI & Design, Features, Performance & Accessibility, Deployment, Operations, Authoring, Upgrades, Migration) rather than alphabetically — this is a curated presentation order, distinct from the raw `ls`-sorted directory order used to split this report's "first half"/"second half".

### `README.md` (public marketplace README, 13,831 bytes)

Key facts extracted:
- Title: "Capacitor Agent Skills". Formerly published as `@capgo/capacitor-skills` (and GitHub repo `Cap-go/capacitor-skills`) — a rename happened; old links/redirects are said to still work.
- Explicitly states: "A collection of **49 skills** for AI coding agents working with Capacitor" — confirms 49 is the intended/documented total, matching the actual directory count.
- **Compatibility table:** the skill PACK's major version follows Capacitor's major version. v8.x.x ↔ Capacitor v8.x.x (Maintained: yes); v7.x.x ↔ Capacitor v7 (Maintained: "On demand"); v6.x.x ↔ Capacitor v6 (Maintained: No); v5.x.x ↔ Capacitor v5 (Maintained: No). Only the latest major version is actively maintained; use the plugin-pack version matching your installed Capacitor version.
- **Installation, two methods documented:**
  1. `npx skills add Cap-go/capgo-skills` (a generic "skills.sh" style installer, referenced by GitHub shorthand).
  2. Claude Code Plugin Marketplace: `claude plugin marketplace add Cap-go/capgo-skills` to register the marketplace, then `claude plugin install <plugin-name>@capgo-skills` to install a specific themed plugin bundle (e.g. `claude plugin install capgo-cloud@capgo-skills`). The README documents the full 11-plugin table with one-line descriptions matching the marketplace.json entries.
- **Available Skills section:** a full markdown table of ALL 49 skills grouped into 13 named categories (Core Development, Growth & Revenue, Security, Testing & CI/CD, Debugging & Tooling, UI & Design, Features, Performance & Accessibility, Deployment, Operations, Authoring, Upgrades, Migration), each row linking to `./skills/<name>` with a one-line description. This is effectively the canonical human-readable skill catalog. Categories relevant to this report's second half: Debugging & Tooling (debugging-capacitor, ios-android-logs live here), UI & Design (ionic-design, konsta-ui, tailwind-capacitor, safe-area-handling), Deployment (cocoapods-to-spm lives here, oddly, alongside app-store/apple-review-preflight/spm-support skills — grouped by "ships the app" theme not alphabetically), Authoring (skill-creator), Migration (cordova-to-capacitor, framework-to-capacitor, webapp-to-capacitor, ionic-appflow-migration, capawesome-live-update-migration, sqlite-to-fast-sql, ionic-enterprise-sdk-migration), Growth & Revenue (subscription-app-revenue).
- **Usage section:** a big "trigger phrase → skill" mapping list, organized by the same category groups, showing example user utterances that should route to each skill (e.g. "How do I make revenue from my app?" → subscription-app-revenue; "Migrate my Capacitor app to Swift Package Manager" → cocoapods-to-spm; "Turn my web app into an app" → webapp-to-capacitor).
- **Quick Start with Capgo section** (the product, not the skill pack): 1. create account at capgo.app; 2. install CLI `npm install -g @capgo/cli`, `npx @capgo/cli@latest login`; 3. `npx @capgo/cli@latest init`, `npm run build`, `npx @capgo/cli@latest bundle upload`.
- **Security Scanning with Capsec section:** `npx capsec scan`; `npx capsec scan --ci` (fails on high/critical, for CI mode); `npx capsec scan --output html --output-file security.html`. Capsec is claimed to detect "63+ security issues" including hardcoded secrets/API keys, insecure storage patterns, network security issues, platform-specific vulnerabilities, authentication weaknesses. Link: capacitor-sec.dev.
- **About Capgo section** (product marketing summary): Live Updates (deploy JS/HTML/CSS instantly without app store review), "80+ Plugins" (native functionality for auth/media/payments/sensors), Capsec (security scanning).
- **Resources links:** capgo.app, capacitor-sec.dev, capacitorjs.com, ionicframework.com, konstaui.com, Discord invite (discord.gg/capgo).
- **Contributing section:** add new skills as a folder in `skills/` with `SKILL.md` + `metadata.json`; validate locally with `npm run lint-skills`; run the skillgrade-backed eval with `ENABLE_SKILLGRADE=1 npm run lint-skills-skillgrade`. (Note: README says `npm run lint-skills` but package.json's actual script body invokes `bun scripts/lint-skills.mjs` — i.e. the npm script wrapper still works via any package manager since it's just a named script, but the underlying command literally shells out to `bun`, meaning Bun must be installed even if invoked via `npm run`.)
- **License:** MIT.

### `CLAUDE.md` (marketplace root, agent-facing overview)

Titled "Capacitor Skills for Claude". This is a SHORTER, PARTIAL "Skills Overview" doc covering only ~13 of the 49 skills with 1-3 line blurbs each: capacitor-plugins, capgo-live-updates, capawesome-live-update-migration, capacitor-best-practices, debugging-capacitor, ios-android-logs, capacitor-mcp, ionic-design, konsta-ui, tailwind-capacitor, safe-area-handling, cocoapods-to-spm, cordova-to-capacitor, framework-to-capacitor. It stops after framework-to-capacitor and does NOT cover the remaining second-half skills documented in full above (ionic-appflow-migration, ionic-enterprise-sdk-migration, skill-creator, sqlite-to-fast-sql, subscription-app-revenue, webapp-to-capacitor) nor most of the first-half skills beyond what's listed. This file appears to be an OLDER/STALE partial index that was not kept in sync as the skill pack grew to 49 skills — the README.md is the actually-complete and current catalog. Worth flagging: an agent reading only `CLAUDE.md` at the marketplace root would get an incomplete picture of the pack's contents; `README.md` should be treated as authoritative for the full skill inventory.

### `AGENTS.md` (marketplace root, contributor/dev-workflow guidance)

This file is NOT about the skill pack's content at all — it is guidance for contributors developing the underlying CAPGO CAPACITOR PLUGIN (the actual native plugin code that ships to npm, i.e. this repo apparently ALSO hosts, or is structured to look like it hosts, real Capacitor plugin source, separate from the skills/ documentation tree). Key facts:
- **Quick start:** `bun install`; `bun run build` (TypeScript + Rollup + docgen); `bun run verify` (builds for iOS/Android/Web — "Always run this before submitting work"); `bun run fmt` (ESLint + Prettier + SwiftLint auto-fix); `bun run lint` (check without fixing).
- **Development workflow (5 steps):** Install (`bun install`, "never use npm") → Build → Verify (always before submitting) → Format → Lint.
- **Command context rules (explicit three-way split,重要 for anyone editing this repo):**
  - Repository development/CI commands: use `bun`/`bun run`/`bunx` — NOT `npm`/`npx`.
  - Skill content, documentation, marketing copy: keep standard `npm install`/`npm run build`/`npx ...` UNLESS the skill is specifically about Bun.
  - Capacitor/Capgo commands INSIDE skills: prefer `npx ...@latest` examples; do not rewrite skill examples to `bunx` just because the repo itself uses Bun.
  - Nested target repos: if a task operates inside ANOTHER repository, read that repo's own instructions and use ITS local command policy instead.
- Individual platform verification: `bun run verify:ios`, `bun run verify:android`, `bun run verify:web`.
- Example app: if `example-app/` exists, `cd example-app && bun install && bun run start`; it references the plugin via `file:..`; skill prose should still use `npx cap sync <platform>` examples even though the repo itself uses Bun locally.
- **Project structure:** `src/definitions.ts` (TS interfaces/types, SOURCE OF TRUTH for API docs), `src/index.ts` (plugin registration), `src/web.ts` (web implementation), `ios/Sources/` (Swift), `android/src/main/` (Java/Kotlin), `dist/` (generated, do not edit), `Package.swift` (SwiftPM def), `*.podspec` (CocoaPods spec).
- **iOS package management:** BOTH CocoaPods and SPM are always supported; every plugin must ship a valid `*.podspec` AND `Package.swift`; do not remove or break either integration since users depend on both. (This is a notable cross-reference/consistency point with the `cocoapods-to-spm` SKILL.md content documented above — the underlying Capgo plugins themselves are dual-published to support apps still on either package manager.)
- **API documentation:** README API docs are auto-generated from JSDoc in `src/definitions.ts`; NEVER hand-edit the `<docgen-index>`/`<docgen-api>` sections in README.md; update `src/definitions.ts` and run `bun run docgen` (also runs as part of `bun run build`).
- **Versioning:** plugin major version follows Capacitor major version (v8 plugin for Capacitor 8); breaking changes ONLY ship alongside a new Capacitor native major release; all other changes must stay backward compatible.
- **Changelog:** `CHANGELOG.md` is CI-managed automatically; do not hand-edit.
- **Browser automation guidance:** use headless browser automation by default; visible browser only when the user needs to interact or the task needs an authenticated/manual web flow.
- **Secrets and tokens policy:** do not replace user-provided tokens/API keys/passwords/certificates/secrets in repo files with placeholders unless explicitly asked; do not tell the user to rotate secrets unless they explicitly ask for rotation guidance; placeholders only for generic examples/templates/new docs not preserving a user-supplied value.
- **Pull Request Guidelines:** every PR needs 5 sections — What / Why / How / Testing / Not Tested (a fixed template is given verbatim at the bottom of the file). Rules: no breaking changes unless aligned with a new Capacitor major release; run `bun run verify` and `bun run fmt` before opening a PR; open PRs as DRAFT until CI/CD passes, wait for all test runs, fix failures, rerun until green before marking ready; AI-authored PRs are explicitly welcomed ("If you are an AI agent, that is perfectly fine. Just be transparent about it. We care that the code is correct and helpful, not who wrote it."); PRs reviewed best-effort, requested changes expected to be addressed; automated review tools in use include CodeRabbit — wait until any "Review in progress" state clears, address actionable comments, rerun checks, resolve comments, repeat until none remain; releases are automatic, merged changes ship in the "next release cycle" (implying some CI/CD auto-publish pipeline, e.g. semantic-release-style, though the exact mechanism isn't detailed in this file).
- Restates: always use NPX in skills, never Bunx in skill examples (NPX ensures the expected package version for the CONSUMER; Bun/Bunx are for this repo's OWN dev/CI, or Bun-specific skills).
- **Common pitfalls (contributor gotchas):** always rename Swift/Java classes and package IDs when creating a new plugin from a template — leftover names cause registration conflicts; only Java 21 is used for Android builds; keep temp files clean (delete or `deleteOnExit` after use); `dist/` is fully regenerated every build, never edit generated files; use Bun for repo commands, never npm/npx for commands run IN this repo, use `bunx` for local package binaries if needed.

---

## Fleet-relevant synthesis (why this matters for the OTCHealth 8-app Capacitor fleet)

- **`webapp-to-capacitor`**, **`cordova-to-capacitor`**, and **`framework-to-capacitor`** are migration-INTO-Capacitor skills — not directly relevant to the fleet (all 8 apps are already Capacitor-native), but useful if any future app starts as a plain web app or a legacy Cordova codebase gets acquired/absorbed.
- **`cocoapods-to-spm`** is directly relevant: iHEARtest's CLAUDE.md, Flatstick's CLAUDE.md (native-extension work), and every other fleet app's `ios-depot.yml` build pipeline reference Capacitor 8 defaults; several fleet apps may still carry CocoaPods-era `ios/` trees from before the Depot cutover. This skill's warning "do not mix CocoaPods and SPM in one migration; every plugin needs SPM support first" and its explicit hand-off to `capacitor-plugin-spm-support` for project-owned plugins is directly actionable for the fleet's native-extension work (Flatstick's watch/widget targets already ran into `xcodeproj`-gem-based build-time injection precisely because hand-editing `project.pbxproj` is forbidden — the same principle `cocoapods-to-spm` states for `CapApp-SPM`).
- **`ios-android-logs`** and **`debugging-capacitor`** are directly operational: every fleet app's CTO/App-Lead review loop (Mark Moore's iHEARtest review ritual, TestFlight-only device QA per multiple CLAUDE.md files) depends on device-only log streaming (`xcrun devicectl`, Console.app, adb logcat) since "the operator has NO Mac" and device-only bug classes (AVAudioSession, AirPods routing, Web Audio unlock) are explicitly called out across iHEARtest/Companion/Flatstick CLAUDE.md files as things that can ONLY be verified via TestFlight on a physical device.
- **`safe-area-handling`** and **`tailwind-capacitor`** are directly relevant to senior-accessibility requirements repeated across MedReview, Companion, iHEARtest, AWARE, InnerEase CLAUDE.md files (large touch targets, WCAG contrast, safe-area-respecting layouts for a 50-75+ user base) — the 44px minimum touch target convention in this skill pack matches Apple HIG and is consistent with (though smaller than) MedReview's stricter 48-64px tap-target requirements.
- **`konsta-ui`** and **`ionic-design`** are alternative UI-framework guides; none of the fleet's CLAUDE.md files mention Ionic or Konsta by name (iHEARtest is vanilla-JS/no-bundler; Companion/FourVault/Flatstick use React+Vite/Ionic-adjacent stacks per their own CLAUDE.md — Companion explicitly specifies "Ionic 8 components for senior-friendly large controls" as its pinned UI stack) — so `ionic-design` is directly relevant to OTCHealth Companion specifically.
- **`subscription-app-revenue`** overlaps conceptually with the fleet's own `monetization`, `aso-growth`, `growth-pr`, and `storefront-cro` skills (listed in the available-skills system reminder) — this Capgo skill's revenue-math formulas and paywall-placement heuristics (80% paywall-exposure rule, one-change-per-cycle churn learning loop) could usefully cross-pollinate into the fleet's own subscription-tier apps (Companion's 5-tier pricing ladder, Flatstick's tiered chat entitlements, PlantID's price-test subscription products) if not already covered by the bespoke fleet skills.
- **`skill-creator`** is meta-relevant: the fleet's OWN `skill-creator` skill (listed separately in the available-skills reminder, presumably the fleet's bespoke authoring tool) may be worth diffing against THIS Capgo `skill-creator`'s progressive-disclosure principles (lean SKILL.md, references/ for dense material, scripts/ only for fragile logic, `allowed-tools` frontmatter kept read-only, the skillgrade self-test pattern with a deterministic JS grader) since the fleet is actively authoring many custom skills (`agent-evals`, `browser-agent`, `company-brain`, etc. per the CLAUDE.md history) and could benefit from adopting the same self-grading eval convention this pack demonstrates on itself.
- **`sqlite-to-fast-sql`** and **`ionic-enterprise-sdk-migration`** are not currently relevant (no fleet app CLAUDE.md mentions Ionic Enterprise SDK, Identity Vault, or a bridge-based SQLite plugin migration need) but are worth keeping in mind if any fleet app adds offline-first encrypted local storage in the future.
- **`ionic-appflow-migration`** is not relevant (no fleet app uses or used Ionic Appflow; the fleet's build story is entirely Depot macOS GitHub Actions + Capgo OTA per the task's own framing that all 8 apps were "just wired with signed Capgo OTA channels under org 'OTCHealth Inc.'").

---

*(End of second-half report. See the companion "first half" report for capacitor-accessibility through capgo-release-workflows, items 1-34 of the alphabetical skill listing.)*
