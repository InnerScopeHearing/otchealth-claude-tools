#!/usr/bin/env node
// apple-preflight.mjs, print a per-app Apple App Store preflight report before the CTO
// dispatches an ios-depot build for submission, or before promoting a build to the
// external tester pool. REPORT / ADVISORY ONLY: it never blocks a build, it prints the
// guideline-cited checklist sections a human CTO should read and decide against.
//
// Usage:
//   node apple-preflight.mjs --list
//   node apple-preflight.mjs --app companion
//   node apple-preflight.mjs --app flatstick --out /tmp/flatstick-preflight.md
//   node apple-preflight.mjs --app <new-app-id> --name "New App" --tags subscription,ai
//
// Dependency-free. No em dashes or en dashes anywhere in generated output (published-style
// content). Reads the vendored, pre-authorized `capacitor-apple-review-preflight` plugin
// checklists live off disk when present (full text, verbatim, cited by Apple guideline
// number) and falls back to a condensed, still guideline-cited summary when the plugin is
// not installed in the current session. Never invents an Apple guideline: every citation in
// this file traces to either a live-read checklist file or Apple's public App Store Review
// Guidelines index (developer.apple.com/app-store/review/guidelines).

import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue;
  const key = argv[i].slice(2);
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) {
    args[key] = true;
  } else {
    args[key] = next;
    i++;
  }
}

// ---------------------------------------------------------------------------
// Fleet app risk-profile registry. Keep this the single source of truth; the
// same table is rendered in SKILL.md for human reading. Tags select which
// Apple guideline checklists are relevant. `all` and `privacy_manifest` and
// `encryption` are always applied to every app, do not list them per app.
// ---------------------------------------------------------------------------
const APPS = {
  fourvault: {
    name: 'FourVault',
    bundleId: 'unset (see ios/App/App/Info.plist)',
    tags: ['kids'],
    note: 'Kids trading-card app, COPPA + verifiable parental consent, no loot boxes, no third-party analytics on kid screens (CLAUDE.md rules 1-6). kids.md is the primary gate; its parental-gate + no-third-party-analytics bullets map directly onto FourVault\'s own hard rules.',
  },
  medreview: {
    name: 'MedReview',
    bundleId: 'not yet assigned (V1 ships web-only, Shopify-embedded)',
    tags: ['health', 'ai'],
    note: 'PHI/BAA ring app. V1 is web-only (no App Store submission); V1.1 (Day 22-30) adds a Capacitor wrap. Run this preflight BEFORE the V1.1 iOS submission, not before. This tool inspects App Store metadata and checklist coverage only, never PHI; the PHI ring stays absolute regardless (see medreview/CLAUDE.md). AI chat (Gemini 2.5 Pro) triggers ai_apps.md; medication/dosage content triggers health_fitness.md 1.4.1/1.4.2 hard.',
  },
  companion: {
    name: 'OTCHealth Companion',
    bundleId: 'com.otchealth.companion (fleet APNs topic convention)',
    tags: ['health', 'ai', 'subscription', 'social'],
    note: 'Senior AI companion: visual/voice AI assistant (Gemini, triggers ai_apps.md), family photo/video feed (triggers social_ugc.md), five-tier RevenueCat paywall (subscription_iap.md), non-PHI in v1 but health-adjacent framing (health_fitness.md) given "point the camera at a pill" and scam/health-adjacent guidance; CLAUDE.md rule 1 (no medical advice) is the app-side control that answers 1.4.1.',
  },
  aware: {
    name: 'AWARE Aural Rehab',
    bundleId: 'com.innerscope.aware / App Store ID 6772572839',
    tags: ['subscription'],
    note: 'RevenueCat `pro` entitlement (subscription_iap.md). Compliance rails already ban FDA-clearance and dementia/cure claims (own CLAUDE.md); those map onto 1.4.1 medical-claims language even though it is not HealthKit-integrated, worth a light health_fitness.md pass at submission time given the "aural rehabilitation" positioning, flagged here as a recommendation beyond the standard tag set.',
  },
  flatstick: {
    name: 'Flatstick',
    bundleId: 'app.flatstick.ios',
    tags: ['subscription'],
    note: 'RevenueCat organizer Pro + three chat entitlement tiers (subscription_iap.md). Flatstick never holds, escrows, or moves money (hard rule); because it tracks bets/wagers among friends it sits close to Guideline 5.3 Gaming & Gambling and 3.2.2 unacceptable business practices even without money handling, review notes should proactively state the Splitwise-style settlement model and 17+ US-launch framing so a reviewer does not mis-flag it as a gambling app. This is a fleet-specific addition, not a capgo checklist line item.',
  },
  plantid: {
    name: 'PlantID Care',
    bundleId: 'com.innerscope.plantid / ASC app 6781126153',
    tags: ['ai', 'subscription'],
    note: 'AI plant/health recognition (Vertex Gemini 2.5 Flash, ai_apps.md) + RevenueCat annual price-test products (subscription_iap.md). Toxicity/ASPCA provider output is advisory content, not medical, keep 1.1.6 false-information language in mind for any "is this toxic" copy.',
  },
  iheartest: {
    name: 'iHEARtest',
    bundleId: 'per App Store Connect (team 465UF9H72S)',
    tags: ['subscription'],
    note: 'Hearing screening/PSAP companion, non-diagnostic, FTC HBNR + banned-token compliance grep already enforced in CI (own CLAUDE.md). Recommend a health_fitness.md pass in addition to subscription_iap.md, even though not in the original dispatch tag set, because 1.4.1 (medical apps: disclose methodology, no sensor-only diagnostic claims) is exactly the class of finding the existing compliance grep is built to prevent; flagged here as a recommendation.',
  },
  innerease: {
    name: 'InnerEase',
    bundleId: 'com.innerscope.innerease (planned, ships under InnerScope ASC account)',
    tags: [],
    note: 'PRE-CODE as of this writing (own CLAUDE.md: no www/, package.json, capacitor.config, or ios/ yet). Not submittable, this preflight is not actionable until Phase 0 lands the app scaffold. When it does, expect subscription (RC pro planned) and a General Wellness claims-firewall pass (ie-07) that maps onto health_fitness.md 1.4.1 even though InnerEase is explicitly NOT a medical device.',
  },
  fictionary: {
    name: 'Fictionary',
    bundleId: 'not documented in repo at time of writing',
    tags: [],
    note: 'Free and non-commercial (own README), no IAP/subscription, no account system documented, general audience (story-time nursery rhymes content is family-friendly but the app does not target the Kids Category specifically). Baseline (all_apps + privacy_manifest + encryption) only unless the store listing later opts into the Kids Category, in which case add kids.md.',
  },
};

const ALWAYS_TAGS = ['all_apps', 'privacy_manifest'];

// ---------------------------------------------------------------------------
// Checklist sources. `file` is the relative path inside the capgo
// capacitor-apple-review-preflight plugin's references/ directory (read live
// when present). `fallback` is a condensed, still guideline-cited summary
// used when that plugin is not installed in the current session; every line
// in every fallback traces to Apple's public guideline index, never invented.
// ---------------------------------------------------------------------------
const CHECKLISTS = {
  all_apps: {
    label: 'All Apps (Universal Guidelines)',
    file: 'guidelines/by-app-type/all_apps.md',
    fallback: [
      '2.1 App Completeness: final, functional, no placeholder content, demo account provided.',
      '2.3 Accurate Metadata: no placeholder text, no other-platform names, screenshots show the app in use.',
      '3.1.1 In-App Purchase: digital content unlocks use IAP, not license keys or external payment.',
      '4.1 Copycats: not a clone of another app or brand.',
      '4.2 Minimum Functionality: more than a repackaged website.',
      '4.8 Login Services: if social login is offered, Sign in with Apple (or equivalent) must also be offered.',
      '5.1.1 Data Collection: privacy policy linked in App Store Connect AND in-app, consent secured, data minimized, account deletion offered if account creation exists.',
      '5.1.2 Data Use and Sharing: App Tracking Transparency required for cross-app tracking.',
      '5.6.2 Developer Code of Conduct: developer identity accurate and verifiable.',
    ],
  },
  privacy_manifest: {
    label: 'Privacy Manifest (PrivacyInfo.xcprivacy)',
    file: 'rules/privacy/privacy_manifest.md',
    fallback: [
      '5.1.1 Privacy, Spring 2024 requirement: apps using any Required Reason API (file timestamps, ' +
        'UserDefaults, system boot time, disk space) must ship PrivacyInfo.xcprivacy declaring the reason code.',
      'Third-party SDKs (Firebase, analytics, RevenueCat, Sentry, PostHog) increasingly ship their own ' +
        'PrivacyInfo.xcprivacy, the app target must cover Required Reason APIs used in ITS OWN code too.',
      'Missing manifest is a REJECTION-severity finding, not a warning.',
    ],
  },
  kids: {
    label: 'Kids Category Apps',
    file: 'guidelines/by-app-type/kids.md',
    fallback: [
      '1.3 No external links, no purchasing, no third-party advertising, and no third-party analytics ' +
        '(limited exceptions, no IDFA, no PII, no location) unless behind a parental gate.',
      '5.1.4(a) COPPA / GDPR compliance for children\'s data; no sending PII or device info to third parties.',
      '5.1.4 Privacy policy required, linked in App Store Connect AND accessible in-app, must comply with ' +
        'children\'s privacy statutes.',
      '2.3.8 "For Kids" / "For Children" in metadata is reserved for apps actually in the Kids Category.',
      'Parental gate required in front of any external link, purchase, or distraction.',
    ],
  },
  health: {
    label: 'Health, Fitness and Medical Apps',
    file: 'guidelines/by-app-type/health_fitness.md',
    fallback: [
      '1.4.1 Medical apps: clearly disclose data and methodology behind any accuracy claim; cannot claim ' +
        'sensor-only diagnostics (x-ray, blood pressure, blood glucose, SpO2); must tell users to check ' +
        'with a doctor before making medical decisions.',
      '1.4.2 Drug dosage calculators must come from an approved medical entity (manufacturer, hospital, ' +
        'university, or FDA-approved source).',
      '5.1.3(i) HealthKit data: never for advertising, marketing, or data mining.',
      '5.1.3(ii) Never write false or inaccurate data into HealthKit; never store personal health data in iCloud.',
      '5.1.1 Privacy policy clearly describes health data collection and use; data minimization applies.',
    ],
  },
  ai: {
    label: 'AI-Powered / Generative AI Apps',
    file: 'guidelines/by-app-type/ai_apps.md',
    fallback: [
      '1.1.6 No false information or misleading AI capabilities (for example, framing the assistant as ' +
        'an "AI doctor").',
      '1.4.1 AI health advice must include medical disclaimers and cannot substitute for a professional diagnosis.',
      '2.3.1 Every AI feature documented in App Review notes, no hidden AI capabilities.',
      '1.2 If the AI generates user-facing content, content moderation/filtering must be in place.',
      '5.1.1 AI data processing disclosed in the privacy policy; explicit consent for AI processing of ' +
        'user recordings or inputs; do not send more data to the model than necessary.',
      '5.2.5 / 2.3.7 Do not use "GPT", "ChatGPT", "OpenAI", or "Gemini" as part of the app name or keyword-stuff them.',
    ],
  },
  subscription: {
    label: 'Subscriptions and In-App Purchase',
    file: 'guidelines/by-app-type/subscription_iap.md',
    fallback: [
      '3.1.1 All digital content unlocks use Apple In-App Purchase, no license keys, QR codes, or crypto.',
      '3.1.2(a) Subscription provides ongoing value, minimum 7-day period, works on all the user\'s devices.',
      '3.1.2(c) Purchase screen clearly describes what the user gets for the price; the billed amount is ' +
        'the most prominent pricing element, not a calculated monthly figure.',
      'App description must include a functional Terms of Use (EULA) link AND a functional Privacy Policy link.',
      '3.1.2(a) Free trial clearly identifies duration, what ends, and the post-trial charge.',
      'A working Restore Purchases mechanism must exist for restorable IAP.',
      'The in-app subscription screen must show: title, period length, price (and per-unit price where ' +
        'relevant), a tappable Privacy Policy link, and a tappable Terms of Use link.',
    ],
  },
  social: {
    label: 'Social / User-Generated Content Apps',
    file: 'guidelines/by-app-type/social_ugc.md',
    fallback: [
      '1.2 Content moderation (filter objectionable material), a report mechanism with timely response, ' +
        'and the ability to block abusive users, plus published support contact information.',
      '4.8 If third-party login is offered (Facebook, Google), Sign in with Apple (or equivalent) must ' +
        'also be offered.',
      '5.1.1(v) If account creation exists, account deletion must also be offered.',
      '2.5.14 Explicit consent required before recording user activity (camera, microphone, screen).',
      '5.1.2 App Tracking Transparency required for cross-app tracking.',
    ],
  },
};

// Custom, fleet-authored check that is not part of the vendored capgo
// checklist set. Sourced from Apple's public Export Compliance documentation
// (developer.apple.com/documentation/security/complying-with-encryption-export-regulations),
// applied fleet-wide because it already bit PlantID (see PR#12 in
// otchealth-claude-tools history: ITSAppUsesNonExemptEncryption was added to
// Info.plist so build 2+ self-declares instead of needing a per-build manual
// Missing Compliance clearance through the ASC API).
const ENCRYPTION_CHECK = [
  'Export Compliance: every build answers the "does this app use encryption" question at upload time. ' +
    'Standard HTTPS/TLS-only apps should set ITSAppUsesNonExemptEncryption to false in Info.plist so the ' +
    'build self-declares and never blocks in Missing Compliance.',
  'If the app adds any non-exempt cryptography (custom crypto, non-standard key exchange), the correct ' +
    'CCATS / export classification must be on file before the value can legally be set to false.',
  'A build that ships without this declaration sits in "Missing Compliance" in App Store Connect until ' +
    'someone clears it manually, which has previously delayed a fleet release (iHEARtest, see CLAUDE.md).',
];

// ---------------------------------------------------------------------------
// Locate the vendored capgo capacitor-apple-review-preflight plugin, if the
// current session has it installed. We never bundle a copy of its content
// into this repo (provenance + license discipline, see skills/VENDORED.md);
// we only read it live when present and fall back to the summaries above
// otherwise.
// ---------------------------------------------------------------------------
function findCapgoReferencesDir() {
  const candidates = [];
  if (process.env.APPLE_PREFLIGHT_CAPGO_DIR) candidates.push(process.env.APPLE_PREFLIGHT_CAPGO_DIR);
  candidates.push(
    '/root/.claude/plugins/marketplaces/capgo-skills/skills/capacitor-apple-review-preflight/references'
  );
  // Walk any other installed marketplaces looking for the same skill dir, in
  // case the plugin root moves (different marketplace name, different HOME).
  for (const marketplacesRoot of [
    '/root/.claude/plugins/marketplaces',
    join(process.env.HOME || '', '.claude/plugins/marketplaces'),
  ]) {
    if (!marketplacesRoot || !existsSync(marketplacesRoot)) continue;
    let entries = [];
    try {
      entries = readdirSync(marketplacesRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const guess = join(
        marketplacesRoot,
        e.name,
        'skills/capacitor-apple-review-preflight/references'
      );
      candidates.push(guess);
    }
  }
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

const capgoDir = findCapgoReferencesDir();

function renderChecklist(tagKey) {
  const spec = CHECKLISTS[tagKey];
  if (!spec) return `(unknown checklist tag "${tagKey}")\n`;
  let out = `\n### ${spec.label}\n`;
  if (capgoDir) {
    const full = join(capgoDir, spec.file);
    if (existsSync(full)) {
      out += `SOURCE: live read, capgo-skills plugin, ${spec.file}\n\n`;
      out += readFileSync(full, 'utf8').trim() + '\n';
      return out;
    }
  }
  out += 'SOURCE: condensed fallback summary (the capacitor-apple-review-preflight plugin was not found ' +
    'in this session; install/enable the capgo-skills marketplace for the full checklist text and citations).\n\n';
  for (const line of spec.fallback) out += `- [ ] ${line}\n`;
  return out;
}

function renderEncryptionCheck() {
  let out = '\n### Export Compliance / Encryption Declaration\n';
  out += 'SOURCE: fleet-authored, based on Apple Export Compliance documentation and prior fleet incidents ' +
    '(not part of the capgo checklist set).\n\n';
  for (const line of ENCRYPTION_CHECK) out += `- [ ] ${line}\n`;
  return out;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
function listApps() {
  let out = '# Apple preflight, fleet app risk profiles\n\n';
  out += '| App id | Name | Tags | Note |\n|---|---|---|---|\n';
  for (const [id, app] of Object.entries(APPS)) {
    const summary = app.note.length > 150 ? app.note.slice(0, 147).trim() + '...' : app.note;
    out += `| ${id} | ${app.name} | ${app.tags.length ? app.tags.join(', ') : '(baseline only)'} | ${summary} |\n`;
  }
  out += `\ncapgo-skills plugin: ${capgoDir ? 'FOUND at ' + capgoDir : 'NOT FOUND, fallback summaries will be used'}\n`;
  return out;
}

function buildReport(appId, overrideName, overrideTags) {
  const registered = APPS[appId];
  const name = overrideName || (registered && registered.name) || appId;
  const tags = overrideTags
    ? overrideTags.split(',').map((t) => t.trim()).filter(Boolean)
    : registered
      ? registered.tags
      : [];

  if (!registered && !overrideTags) {
    console.error(
      `"${appId}" is not in the fleet app registry (${Object.keys(APPS).join(', ')}). ` +
        'Pass --tags to run an ad hoc preflight for a new app, for example --tags subscription,ai.'
    );
    process.exit(1);
  }

  let out = `# Apple App Store preflight report: ${name}\n\n`;
  out += 'ADVISORY ONLY. This is a report for the human CTO to read before dispatching an ios-depot build ' +
    'for App Store submission (or before promoting a build to the external tester pool). It does not block ' +
    'or gate anything by itself; the CTO decides.\n\n';
  if (registered) {
    out += `Bundle id: ${registered.bundleId}\n\n`;
    out += `Risk-profile note: ${registered.note}\n\n`;
  }
  out += `Applied checklists: ${[...ALWAYS_TAGS, ...tags].join(', ')}\n`;

  for (const tag of ALWAYS_TAGS) out += renderChecklist(tag);
  for (const tag of tags) {
    if (!CHECKLISTS[tag]) {
      out += `\n(unrecognized tag "${tag}", skipped, known tags: ${Object.keys(CHECKLISTS).join(', ')})\n`;
      continue;
    }
    out += renderChecklist(tag);
  }
  out += renderEncryptionCheck();

  out += '\n---\nGenerated by skills/apple-preflight/apple-preflight.mjs. Guideline text is either a live ' +
    'read of the installed capacitor-apple-review-preflight plugin or a condensed summary citing Apple\'s ' +
    'public App Store Review Guidelines (developer.apple.com/app-store/review/guidelines). Nothing in this ' +
    'report was invented.\n';
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
if (args.list) {
  console.log(listApps());
  process.exit(0);
}

const appArg = args.app;
if (!appArg || appArg === true) {
  console.error('required: --app <id> (or --list to see the fleet app registry)');
  console.error(`known app ids: ${Object.keys(APPS).join(', ')}`);
  process.exit(1);
}

const report = buildReport(
  appArg,
  typeof args.name === 'string' ? args.name : null,
  typeof args.tags === 'string' ? args.tags : null
);

if (typeof args.out === 'string') {
  writeFileSync(args.out, report, 'utf8');
  console.log(`wrote ${args.out}`);
} else {
  console.log(report);
}
