# Capgo slice review: camera / media / vision / document-scan / photo-library / image+video / file-compressor

Reviewer slice hint: Camera-heavy apps (Companion scam-letter/pill/mail capture, PlantID, FourVault card scan, MedReview OCR, iHEARtest). Think NEW premium capture UX and B2B doc-intake.

Mission frame: turn the fleet into billion-dollar apps and an app-producing factory. Every call below names the target surface and the concrete win.

No em dashes or en dashes used anywhere in this file.

---

## 1. Camera Preview (`@capgo/camera-preview`)

Live camera feed overlay, `start()`/`stop()`/`capture()`/`captureSample()` (grab a single frame from the live stream without a full photo-capture UX). 34.8k monthly downloads, one of the most-adopted plugins in the whole catalog.

- **Companion (Pillar 1, visual assistant, direct hit).** Companion's entire wedge is "point the camera at a plant, pill, mail, screen, menu, get a spoken answer." The stock Capacitor Camera plugin is a photo-taking UX (shutter, review, confirm); `captureSample()` is a live-preview frame grab, which is the correct primitive for "point and get an instant answer" rather than "take a photo, then wait." This is a GAP: Companion's stack list (CLAUDE.md) does not name a camera plugin at all yet. Adopt-now, S effort, direct product fit.
- **PlantID (direct hit).** PlantID's whole product is camera-first plant identification feeding Vertex Gemini vision. `captureSample()` is the natural client capture primitive for a live-recognition loop (point at a plant, see a running best-guess before committing a full capture), materially better perceived latency than a snap-then-upload flow. Adopt-now, S effort.
- **FourVault (card scan, direct hit).** Kid vault of trading cards; card recognition quality feeds `RecognitionProvider` (Ximilar/AI-vision). A live-preview capture with on-screen alignment guides (card edges within a bounding box) measurably improves crop/recognition accuracy versus a plain photo. Adopt-now, S effort. Must confirm the plugin ships zero third-party telemetry before it touches a kid screen (FourVault's hard no-analytics-on-kid-screens rule); nothing in the fetched docs suggests telemetry, but this is a check-before-ship item, not a full block.
- **MedReview (OCR wedge, gated by phasing).** MedReview's stack already lists "Cloud Vision (medication photo OCR)" under the GCP BAA. MedReview V1 is web-only (Shopify embed); V1.1 is the Capacitor wrap (Day 22-30). Camera Preview becomes directly relevant at V1.1: a live-preview capture with an "align the pill/label" guide overlay beats a static photo picker for OCR input quality, which is the whole premium-capture-UX angle the slice hint calls out. Adopt-later (V1.1 gate), S effort once unblocked.
- **iHEARtest / AWARE.** No direct camera-based product surface today (hearing tests are audio-first). One forward-looking idea: a "scan your hearing aid box or receipt" warranty-registration flow for TReO/iHEARtest cross-sell, feeding the commerce side (Amazon/Shopify). Spike only, not a current gap.
- **Flatstick.** Not a capture-primitive fit on its own; see Document Scanner below for the real Flatstick opportunity (scorecard scan).

Overall: Camera Preview is the single highest-leverage item in this slice. It is a GAP for Companion and PlantID specifically (both name camera-first product pillars but neither app's stack currently names this or an equivalent live-preview plugin).

---

## 2. Document Scanner (`@capgo/capacitor-document-scanner`)

Single method `scanDocument()`: auto edge detection, perspective correction, PDF export. 44.8k monthly downloads, 22 stars, one of the higher-adoption Media-adjacent plugins in the whole catalog.

- **MedReview (the standout fit, GAP, high leverage).** MedReview already runs Cloud Vision OCR under the GCP BAA for medication photos. OCR accuracy is dominated by input quality: a raw handheld photo of a pill bottle or a prescription label, at an angle, with glare, produces materially worse OCR than a perspective-corrected, edge-cropped scan. Document Scanner does exactly that correction ON-DEVICE before any network call, so it does not touch the BAA boundary or add a new vendor, it just makes the existing Cloud Vision call work better. This is a clean, compliance-safe accuracy win, gated on MedReview reaching its V1.1 Capacitor wrap (per its own phased-delivery plan). Flag for the MedReview roadmap now so it lands with V1.1 rather than being rediscovered later. Adopt-later, M effort (worth planning ahead since it changes the capture screen design).
- **FourVault (card scan, direct hit).** Trading-card recognition wants the same edge-detection + perspective-correction treatment as a document, cards are effectively small rigid documents. This is arguably a better fit for FourVault than plain Camera Preview alone: `scanDocument()` gives a clean, correctly-cropped card image straight into `RecognitionProvider`, likely raising match confidence on the free AI-vision tier where clean input matters most (no Ximilar-grade preprocessing to compensate). Adopt-now, S-M effort.
- **Companion (mail/scam-letter capture, direct hit, closes a real product gap).** Companion's Pillar 1 explicitly names "a piece of mail, confusing screen, suspicious letter." A raw photo of a letter on a kitchen table (glare, skew, partial frame) is a worse OCR/vision input than a scanned, corrected version, and a corrected scan is also a better artifact to show back to the user or forward to an adult child ("here is what I found, here is the letter"). This is a genuine gap: Companion's current stack list does not include a scan-quality capture path, only implied "point camera" language. Adopt-now, M effort.
- **B2B / Medvi-style opportunity, AWARE audiologist licensing (missed opportunity, biggest swing in this section).** AWARE's B2B plan (Stripe, Sprint 4+, audiologist licensing) implies clinics onboarding, and clinic onboarding always drags on paperwork: intake forms, insurance cards, hearing-history questionnaires, consent forms. A mobile document-intake flow built on Document Scanner (scan a form, get a clean PDF/crop, attach to a patient or clinic record) is a genuinely NEW, sellable capability, not just a feature inside AWARE. It is the kind of "productized, repeatable acquisition + onboarding engine" the fleet's own Medvi-style playbook language calls for: low build cost (one plugin, a scan-to-PDF flow, a storage bucket), high perceived value to a clinic evaluating whether to adopt AWARE for their patients (less admin friction than a paper process). Worth a real spike: scope a "clinic document intake" feature as part of the AWARE B2B package, potentially licensable standalone to other InnerScope/OTCHealth-adjacent partners later. Spike, L effort (new surface, new data-handling review, but high strategic upside).
- **MedReview RTM/CPT billing angle.** The fleet context flags RTM medication-adherence billing (CPT 98975-98981) as a B2B revenue line. A scan-based adherence log capture (photograph a pill organizer or paper log, auto-crop/clean it) is a plausible input primitive for that billing workflow, but this is speculative until the RTM product itself is scoped. Flag only, not a call.
- **iHEARtest.** No natural document-scan surface today (audio-first test flow), skip.

---

## 3. Photo Library (`@capgo/capacitor-photo-library`)

`checkAuthorization`, `requestAuthorization`, `getAlbums`, `getLibrary` (returns displayable URLs for WebView use); offers both a customizable web-gallery approach and a native no-auth-required picker.

- **Companion (family photo/video feed, Pillar 2, direct hit).** This is the single clearest match in the whole catalog: Companion's second pillar IS a private family photo/video feed. `getAlbums`/`getLibrary` give a structured, WebView-renderable browse surface for both uploading into the feed and (if ever needed) browsing device photos for the info notebook (insurance card photos). Hard compliance note carried over correctly from the earlier research pass: Companion's own `analytics.ts` convention tags the family feed as an always-on `ph-no-capture` sensitive surface for PostHog replay; any screen built on this plugin's output inherits that tag. Adopt-now, S effort, this is a gap (no photo-library plugin currently named in Companion's stack).
- **FourVault (card photo history, gap).** Browsing a kid's previously-captured card photos (their own vault) is a natural Photo Library use, separate from the live capture flow. Adopt-now, S effort.
- **PlantID (plant photo history, gap).** A "my identified plants" gallery pulling from device photo library alongside live capture rounds out the product; currently PlantID's flow is capture-only per its shipped v1. Adopt-later, S effort.
- **MedReview (V1.1+, medication photo history).** Once the Capacitor wrap lands, letting a user re-browse previously scanned medication photos (rather than re-photograph) is a real convenience win, gated on the same V1.1 timing as Document Scanner above. Adopt-later.

---

## 4. File Compressor (`@capgo/capacitor-file-compressor`)

`compressImage` (blob, quality, width, mimeType; PNG/JPEG/WebP).

- **Fleet-wide bandwidth/cost lever (gap, cheap, high ROI).** Every app in this slice's focus uploads photos to a backend: Companion (family feed to Cloud Storage for Firebase), FourVault (card photos to Backblaze B2 + Bunny CDN), PlantID (plant photos to its Azure backend before Vertex vision inference). None of their CLAUDE.md files name an image-compression step before upload. Compressing client-side before upload cuts storage cost, cuts bandwidth cost, and cuts time-to-first-response for PlantID's vision call (smaller upload, faster round trip to the first Gemini/Vertex answer, directly improves perceived app quality on the exact "point and get an answer" wedge Companion and PlantID both sell). Adopt-now across Companion, FourVault, PlantID, S effort each, this is close to a free win.
- **MedReview.** Same logic applies at V1.1+ for medication photos, gated the same way as items above.

---

## 5. File Picker (`@capgo/capacitor-file-picker`), image/HEIC angle only

`pickFiles()`, `pickImages()`, `pickVideos()`, `pickMedia()`, notably including HEIC conversion (iPhone's default photo format, not universally decodable server-side without conversion).

- **Fleet-wide gap: HEIC is a silent failure mode waiting to happen.** Every fleet app is iOS-first, meaning every user's camera roll defaults to HEIC. Any app that lets a user pick FROM their library (Companion's info notebook insurance-card photos, FourVault card capture from an existing photo, PlantID's library-browse path) will eventually hit a HEIC file that a naive fetch/upload path mishandles server-side. File Picker's built-in HEIC conversion removes this class of bug fleet-wide rather than each app writing its own conversion step (or worse, discovering the bug in production via a support ticket). Adopt-now, S effort, genuinely a gap nobody has flagged yet in any per-app CLAUDE.md.

---

## 6. Video Player (`@capgo/capacitor-video-player`), already in use (iHEARtest)

Confirmed live in iHEARtest already. Catalog description: native video playback with subtitles, fullscreen, comprehensive controls.

- **Expansion opportunity, not a gap.** iHEARtest already uses this for onboarding/tutorial video (George's ElevenLabs voiceovers per claude-tools CLAUDE.md). The same plugin should standardize onboarding video across AWARE (aural rehab tutorial), Companion (family-layer walkthrough for the adult-child buyer persona), and any B2B clinician training content for AWARE's licensing product, instead of each app re-solving video playback. Adopt-now for fleet standardization, S effort (mostly a "reuse this, do not reinvent" call).

---

## 7. Video Thumbnails (`@capgo/capacitor-video-thumbnails`)

Generate thumbnail images from local/remote video files at specific timestamps.

- **Internal factory-throughput win (missed opportunity, not app-facing).** The fleet already runs a `designer` skill and `content-engine`/`aso-growth` skills for App Store screenshot/preview generation across 8+ apps. App Store video previews need a representative poster-frame thumbnail per locale/device size; doing this by hand per app, per build, does not scale as the factory adds apps. A small internal tool (or a scaffolder step) that runs Video Thumbnails over each app's tutorial/demo video to auto-generate poster frames for ASO assets is a genuine throughput multiplier for the "app-producing factory" goal, cheap to build, reusable across every current and future app. Adopt-later, S effort, worth a ticket for the ASO/growth workstream rather than the app repos themselves.
- **App-facing angle.** Companion's family feed and any future "family story" video content could use auto-generated thumbnails for a feed grid view instead of loading full video for a preview tile, a real performance win on a senior-first, low-bandwidth-tolerant app. Adopt-later, S effort.

---

## 8. Screen Recorder (`@capgo/capacitor-screen-recorder`)

Capture screen recordings with audio, for tutorials, demos, bug reports.

- **Companion (missed opportunity, strong product/brand fit).** Companion's Pillar 1 explicitly includes "a confusing screen" as a target the senior points their camera at. A more elegant version of that exact interaction is letting the senior SCREEN-RECORD the confusing app or website (with voice narration: "I don't understand this part") and send that recording either to the AI assistant for an explanation or directly to the adult-child caregiver via the family layer. This turns "one less call to the adult child" from a slogan into a literal mechanism: instead of a phone call where the senior tries to describe what's on screen, they record it once and share it. This is a genuinely new, non-obvious surface nobody has written down in Companion's docs yet. Spike, M effort (needs a share/send UX and a privacy review since screen recordings could capture sensitive on-screen content, e.g. banking apps, so this needs the same non-negotiable-rule discipline as the rest of Companion, likely a redaction/consent prompt before any recording leaves the device).
- **Internal QA angle (fleet-wide, all apps).** Screen Recorder is also a natural fit for the fleet's own QA loop (`persona-focus-group`, `live-walkthrough`, tester bug reports): a tester or focus-group persona capturing a repro video directly on-device rather than describing a bug in text. This is adjacent to the `browser-agent` skill's screenshot-audit-log pattern but for real devices. Adopt-later as an internal QA tool, S-M effort, not app-shipped.

---

## 9. YouTube Player (`@capgo/capacitor-youtube-player`)

Embed YouTube videos with full player API control and event handling.

- **AWARE B2B clinician training (gap).** If AWARE's audiologist licensing product needs clinician-facing training or onboarding video, hosting on YouTube (unlisted) and embedding via this plugin avoids building/paying for a video CDN just for training content, cheaper and faster than wiring Mux/IVS/JW for a low-volume, non-time-critical use case. Adopt-later, S effort.
- **Companion / AWARE tutorial content.** Same logic for consumer-facing tutorial video if the team wants to avoid Cloud Storage bandwidth costs for high-view-count onboarding video; tradeoff is YouTube branding/ads inside an embedded player, which may not fit Companion's senior-trust posture (an unexpected YouTube UI chrome could confuse the exact user this app is built for). Flag as a UX tradeoff to weigh, not an unconditional adopt.

---

## 10. IVS Player / JW Player / Mux Player (three catalog items, grouped)

Amazon Interactive Video Service, JW Player, and Mux Player: all are professional adaptive-bitrate live/on-demand video streaming SDKs with paid backend services.

- **Flatstick live-round spectator streaming (missed opportunity, real but speculative, worth a spike not an adopt).** Flatstick already does live scoring during a round. A natural social/viral extension is "watch a friend's live round" (score updates plus optional live video/audio from the course), which is exactly what these plugins exist to power. This would be a genuinely new premium/social surface (spectator mode, possibly a paid "Pro Round" tier) but it is a SIGNIFICANT scope add: a paid streaming backend account (Mux, IVS, or JW), new backend infrastructure, new privacy/consent design (recording other golfers on a course), and no current roadmap mention in Flatstick's CLAUDE.md or HANDOFF history. Spike only, and flag it as a genuine idea for the CTO/App Lead escalation path, not something to build speculatively. L effort if pursued.
- **Anti-pattern warning for the other seven fleet apps.** None of iHEARtest, AWARE, Companion, FourVault, InnerEase, Fictionary, PlantID, or MedReview has a live-streaming or adaptive-bitrate on-demand video need documented anywhere. Adopting any of these three plugins without a concrete streaming feature is pure vendor sprawl: a new paid account, a new SDK surface area, and a redundant capability on top of the already-established Video Player (local/simple playback) and existing storage/CDN stack (Bunny.net for FourVault, Cloud Storage for Firebase for Companion). Avoid by default fleet-wide; only revisit if Flatstick's spectator-streaming idea above gets a real green light.

---

## 11. Ricoh360 Camera (`@capgo/capacitor-ricoh360-camera-plugin`)

Control Ricoh Theta 360-degree cameras for panoramic photography.

- **No fleet fit.** This plugin exists to control a specific piece of third-party camera hardware (Ricoh Theta). Nothing in any of the 8 apps' product surfaces (hearing tests, aural rehab, senior companion, golf, kids' cards, wellness, plant ID, Rx review) involves 360-degree panoramic photography or a paired hardware camera accessory. Skip, no effort estimate needed, this is a clean non-fit rather than a deferred opportunity.

---

## 12. FFmpeg (`@capgo/capacitor-ffmpeg`)

Video encoding/processing for compression and conversion, client-side.

- **FourVault (missed opportunity).** If FourVault's "AI trade verdict" feature ever includes a short video explanation clip (kid-recorded or app-generated) attached to a trade, client-side compression before upload matters for a kids' app on variable home wifi. Spike, M effort, speculative until FourVault's roadmap confirms video-in-trades.
- **Flatstick (missed opportunity, "round highlight" feature).** A short highlight-clip capture (a great shot, a walk-off putt) compressed client-side before upload/share fits Flatstick's social/betting-with-friends framing and is cheap to prototype using the plugin's compression path even without full live-streaming infra (contrast with the much heavier IVS/JW/Mux path above). Spike, M effort, a lighter-weight complement to the spectator-streaming idea rather than a substitute.
- **General note.** FFmpeg client-side is heavier (binary size, CPU/battery cost on older devices) than File Compressor's simple image compression; only worth adopting where actual video (not photo) upload is a confirmed need, unlike File Compressor which is a near-free win everywhere images are uploaded.

---

## 13. PDF Generator (`@capgo/capacitor-pdf-generator`)

`fromURL`, `fromData` (HTML string to PDF); catalog frames it for invoices/reports/receipts.

- **Flatstick (gap, clean fit with its own non-negotiable rules).** Flatstick's hard rule is "never holds, escrows, or moves money... settlement is outbound Venmo/PayPal/Cash App links only." A clean, generated PDF settlement receipt (who owes whom, computed by the already-property-tested `packages/shared` money math) is exactly the kind of artifact that reinforces the "scorekeeping among friends, not gambling" framing in the actual product, a shareable receipt is trust-building for a betting-adjacent app that needs to stay firmly on the "we just do math" side of the line. Adopt-later, S effort.
- **MedReview (V1.1+, gap).** A generated medication-list PDF (for a doctor visit, or to hand to a caregiver) is a natural senior-UX feature once the Capacitor wrap lands; ties into MedReview's whole "who reviews medications with a senior" value prop. Adopt-later, gated on V1.1 timing.
- **Document Scanner pairing.** Document Scanner's own `scanDocument()` already offers PDF export directly, so for the pure "scan a document, get a PDF" case (MedReview forms, AWARE clinic intake), Document Scanner alone may be sufficient without also adding PDF Generator; PDF Generator's distinct value is HTML-to-PDF for GENERATED content (a settlement receipt, a medication summary) rather than a scanned document. Keep these as two separate use cases, not a redundant pair.

---

## 14. Flash (`@capgo/capacitor-flash`)

Simple torch/flashlight on/off toggle.

- **Minor, low-leverage utility.** Useful as a small quality-of-life addition anywhere low-light capture matters: Companion (a senior photographing a pill bottle or mail in a dim room, a very plausible real-world scenario for the target 70+ user), FourVault (kids photographing cards indoors), MedReview at V1.1+ (medication labels, often photographed in a bathroom or bedroom with poor light). Adopt-now, trivial effort, bundle it into whatever capture UX Camera Preview/Document Scanner land with rather than treating as a separate project.

---

## Top missed opportunities in this slice

1. **B2B clinic document-intake product (AWARE audiologist licensing), built on Document Scanner.** This is the biggest genuinely-new-revenue idea in the slice: a productized, mobile document-intake flow (scan intake forms, insurance cards, hearing-history questionnaires into a clean PDF/crop) is exactly the kind of low-build-cost, high-perceived-value onboarding-friction-reducer that fits the fleet's own Medvi-style growth-playbook language. It strengthens AWARE's B2B pitch to clinics directly and could become a standalone sellable capability to other partners later. Nobody has written this down yet.

2. **Fleet-wide "Capture Pipeline" standard, baked into the scaffolder/app-template.** Camera Preview (or Document Scanner) for capture, File Compressor for size, File Picker for HEIC-safe library picks, this three-plugin combination is the correct default capture-to-upload flow for every current and future camera-touching app (Companion, FourVault, PlantID, MedReview at V1.1, and any next app the factory produces). Standardizing this ONCE at the scaffolder level, rather than each app rediscovering HEIC bugs and unoptimized uploads independently, is a direct throughput win for the "become an app-producing factory" mission, and it is cheap: three small, well-adopted plugins, no new vendor accounts, no new infra.

3. **Companion "show me what's confusing" via Screen Recorder.** A screen-recording-plus-narration flow, sent to the AI assistant or the adult-child caregiver, is a more literal and more powerful version of Companion's own "one less call to the adult child" pitch than the camera-at-a-confusing-screen framing currently in its docs. It is a genuinely new interaction pattern nobody has proposed, it directly serves the stated buyer persona (the adult child wants fewer confused phone calls), and the underlying plugin is already in the catalog and unused fleet-wide.

---

## Anti-patterns / hard-constraint conflicts

- **IVS Player / JW Player / Mux Player as a default adopt.** All three are paid, professional live/adaptive-bitrate streaming SDKs with real backend accounts and ongoing cost. Adopting any of them without a concrete, roadmapped streaming feature is vendor sprawl on top of the fleet's already-established storage/CDN choices (Bunny.net, Cloud Storage for Firebase). The only plausible fleet use (Flatstick spectator streaming) is speculative and undocumented in any current roadmap; treat as spike-only, never adopt-now.
- **Ricoh360 Camera.** Zero product fit anywhere in the fleet (360-degree hardware camera control). Clear skip, not worth a spike.
- **AdMob-adjacent risk via any "monetize with ads" media plugin.** Not in this slice directly, but flagging for completeness since File Compressor/Camera Preview/Photo Library could plausibly feed an ad-supported experience: FourVault's own hard rule (no third-party analytics or ads on kid screens) means any future ad-monetization idea for FourVault is out of bounds regardless of which media plugin would technically deliver it. No current proposal violates this, flagging as a standing guardrail for this slice's plugins specifically because Photo Library/Camera Preview touch the exact kid-facing screens the rule protects.
- **Document Scanner / Camera Preview on MedReview before V1.1.** MedReview V1 is explicitly web-only (Shopify embed, no Capacitor wrap yet) per its own CLAUDE.md phased-delivery plan. Recommending either plugin as an immediate MedReview change would contradict MedReview's own locked build order; both are correctly gated to V1.1 in this report, and should stay gated, not pulled forward.
- **Screen Recorder on Companion without a redaction/consent gate.** Screen recording a senior's device inherently risks capturing sensitive on-screen content (banking apps, other private messages) beyond what the user intends to share. Shipping this feature without an explicit consent prompt and/or a sensitive-app-detection guard would conflict with Companion's own senior-privacy-first non-negotiable rules; this is not a reason to skip the idea (flagged above as a top opportunity) but it must not ship as a bare "record and send" button.
