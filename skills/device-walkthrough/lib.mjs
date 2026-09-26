// lib.mjs -- pure, network-free, filesystem-free logic for the device-walkthrough skill.
//
// Everything here has a right answer independent of AWS/GitHub, so it is unit-tested directly.
// walkthrough.mjs (the CLI) and the df-client.mjs/gh-client.mjs/syslog-scan.mjs IO shells call into
// this module for every decision.

// ---- app registry -------------------------------------------------------------------------------
//
// AWARE and iHEARtest ship a qa/device-walkthrough/ XCUITest runner + a
// .github/workflows/device-walkthrough.yml (dispatch-only, builds the runner on Depot macOS) on
// their own `main`, and so does Hey Millie (otchealth-companion, merged in PR #73), so the default
// `main` ref works for all three. All three
// workflows upload their test package as an artifact literally named `walkthrough-runner-<sha>`
// (verified against every repo's workflow YAML). NOTE the ios-depot IPA artifact prefix is NOT a
// fleet-wide fixed convention: iHEARtest and Hey Millie (otchealth-companion) both upload a fixed
// `<slug>-ios-ipa-<sha>` name, but AWARE's own ios-depot.yml does not (it uploads
// `aware-<marketing_version>-<build_number>-<source_sha>` for a PUBLIC build or
// `aware-internal-qa-<build_number>-<source_sha>` for an internal-QA build -- verified against
// AWARE's current ios-depot.yml; its `iosIpaArtifactPrefix` below predates that shape and is stale,
// left as-is here since fixing it is outside this entry's scope). Verify the real artifact name in
// each app's own ios-depot.yml before trusting a registry prefix.

export const APP_REGISTRY = Object.freeze({
  AWARE: Object.freeze({
    displayName: "AWARE",
    repo: "InnerScopeHearing/aware-aural-rehab",
    bundleId: "com.innerscope.aware",
    projectArn: "arn:aws:devicefarm:us-west-2:900915535335:project:58bbc541-f082-4594-b744-738a345f3654",
    poolArn: "arn:aws:devicefarm:us-west-2:900915535335:devicepool:58bbc541-f082-4594-b744-738a345f3654/0d514eae-39c6-4700-8d80-6aad6e48e3d0",
    iosIpaArtifactPrefix: "aware-ios-ipa-",
  }),
  iHEARtest: Object.freeze({
    displayName: "iHEARtest",
    repo: "InnerScopeHearing/iheartest",
    bundleId: "com.innerscope.iheartest",
    projectArn: "arn:aws:devicefarm:us-west-2:900915535335:project:784477b0-1a27-43bd-a4d2-00385bf223b2",
    poolArn: "arn:aws:devicefarm:us-west-2:900915535335:devicepool:784477b0-1a27-43bd-a4d2-00385bf223b2/5ca02852-d232-49a4-b56f-ab43f6ac5c8b",
    iosIpaArtifactPrefix: "iheartest-ios-ipa-",
  }),
  // Hey Millie == OTCHealth Companion (bundle id unchanged from the pre-rebrand app; the App Store
  // display name is "Hey Millie: Talk It Through", see docs/research/hey-millie/DECISIONS.md in that
  // repo). Project + pool created 2026-09-26, mirroring AWARE's/iHEARtest's own pools exactly: the
  // SAME single physical device ARN (Apple iPhone 16, iOS 18.0, "arn:...:device:
  // C3481B68E9EA4202BBF6F9D215E9AE5F") in a PRIVATE, one-rule pool (verified by reading AWARE's own
  // pool via GetDevicePool before creating this one). `companion-ios-ipa-<sha>` verified against
  // otchealth-companion's own ios-depot.yml ("Upload IPA artifact" step) -- a real fixed prefix, not
  // the version/build-embedding shape AWARE uses.
  HeyMillie: Object.freeze({
    displayName: "Hey Millie",
    repo: "InnerScopeHearing/otchealth-companion",
    bundleId: "com.otchealth.companion",
    projectArn: "arn:aws:devicefarm:us-west-2:900915535335:project:2cc15086-23a7-4ef2-865e-128e964a030e",
    poolArn: "arn:aws:devicefarm:us-west-2:900915535335:devicepool:2cc15086-23a7-4ef2-865e-128e964a030e/90b31cc3-89c1-46f0-ab7e-d294dd5f375c",
    iosIpaArtifactPrefix: "companion-ios-ipa-",
  }),
});

/** Case-insensitive lookup into APP_REGISTRY. Throws a helpful, exact error (never a bare
 *  "undefined") on a missing or unknown --app. */
export function resolveApp(name) {
  const known = Object.keys(APP_REGISTRY);
  if (!name) throw new Error(`--app is required (one of: ${known.join(", ")})`);
  const key = known.find((k) => k.toLowerCase() === String(name).toLowerCase());
  if (!key) throw new Error(`unknown --app "${name}" (expected one of: ${known.join(", ")})`);
  return APP_REGISTRY[key];
}

// ---- attachment naming / classification (post-test.sh's own convention) -------------------------
//
// devicefarm-post-test.sh copies xcresulttool-exported attachments into /tmp/walkthrough-out with
// their `suggestedHumanReadableName` plus xcresulttool's own `_<index>_<UUID>` disambiguation
// suffix (verified against a real run's Customer Artifacts: e.g.
// "010 crawl Program > 1 Speech details Contrasts and words Current week · Ready_0_EE3D928E-
// D144-400B-8C09-8D83B3EE8BE3.png"). Walker.swift's shot() numbers every screenshot "%03d <label>"
// (tour) or "%03d crawl <path>" (crawl); attachJSON("crawl-coverage.json", ...) has no such prefix
// but gets the same UUID suffix; xcresulttool's own `test_results.json` (written directly by
// post-test.sh, not through XCTAttachment) carries NO suffix at all.

const ATTACHMENT_SUFFIX_RE = /_\d+_[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}(\.[A-Za-z0-9]+)$/;

/** Strips the xcresulttool `_<index>_<UUID>` disambiguation suffix, keeping the extension. A name
 *  with no such suffix (test_results.json, attachment-index.tsv) is returned unchanged. */
export function stripAttachmentSuffix(filename) {
  return ATTACHMENT_SUFFIX_RE.test(filename) ? filename.replace(ATTACHMENT_SUFFIX_RE, "$1") : filename;
}

/**
 * Classifies one walkthrough-out attachment (already suffix-stripped internally) into its home
 * folder: 'tour' (the scripted-tour screenshots), 'crawl' (crawl screenshots + crawl-coverage.json
 * + the renamed device-test-results.json), or 'other' (anything unrecognized, e.g.
 * attachment-index.tsv -- kept, never silently dropped, just not one of the three named folders).
 *
 * Order matters: a crawl screenshot's name ("NNN crawl <path>") also matches the generic
 * numbered-tour pattern, so the crawl checks run first.
 */
export function classifyAttachment(filename) {
  const stripped = stripAttachmentSuffix(filename);
  if (stripped === "test_results.json") {
    return { dest: "crawl", name: "device-test-results.json", stripped };
  }
  if (stripped.startsWith("crawl-coverage")) {
    return { dest: "crawl", name: stripped, stripped };
  }
  if (stripped.includes(" crawl ")) {
    return { dest: "crawl", name: stripped, stripped };
  }
  if (/^\d+\s/.test(stripped)) {
    return { dest: "tour", name: stripped, stripped };
  }
  return { dest: "other", name: stripped, stripped };
}

// ---- Device Farm ListArtifacts filename convention (analyze.sh's own dedupe rule) ---------------
//
// Device Farm's ListArtifacts can return several artifacts with the IDENTICAL `name` (e.g. three
// DEVICE_LOG "Syslog" entries when a large device log is split into parts). The download name is
// `<name with spaces -> underscores>.<extension>`; a collision gets `-1`, `-2`, ... inserted before
// the extension, in encounter order -- verified against a real run (Syslog.syslog,
// Syslog-1.syslog, Syslog-2.syslog).

export function artifactFilename(name, extension) {
  return `${String(name).replace(/ /g, "_")}.${extension}`;
}

/** Returns `filename` unchanged if `existingNames` does not already contain it, else the lowest
 *  `-N` suffixed variant (before the extension) not already present. Does not mutate `existingNames`. */
export function uniqueFilename(existingNames, filename) {
  if (!existingNames.has(filename)) return filename;
  const dot = filename.lastIndexOf(".");
  const base = dot === -1 ? filename : filename.slice(0, dot);
  const ext = dot === -1 ? "" : filename.slice(dot);
  let i = 1;
  let candidate;
  do {
    candidate = `${base}-${i}${ext}`;
    i++;
  } while (existingNames.has(candidate));
  return candidate;
}

// ---- crawl-coverage.json digest ------------------------------------------------------------------
//
// Walker.swift's crawlEveryButton() attaches exactly this shape:
//   { globals: string[], chromeTexts?: string[], visits: Visit[], queuedButNotVisited: string[],
//     elapsedSeconds: number, visitCount: number }
// where each Visit is either a real visit ({path, screen, controls}) or a terminal non-visit
// ({path, result: 'unreachable' | 'left-app' | 'skipped-deny'}).

export function coverageDigest(coverage) {
  const visits = Array.isArray(coverage?.visits) ? coverage.visits : [];
  const screens = new Set();
  const skippedLabels = new Set();
  const leftAppPaths = [];
  let unreachableCount = 0;
  let visitedCount = 0;
  for (const v of visits) {
    if (!v || typeof v !== "object") continue;
    if (v.result === "skipped-deny") {
      const path = Array.isArray(v.path) ? v.path : [];
      if (path.length) skippedLabels.add(path[path.length - 1]);
      continue;
    }
    if (v.result === "left-app") {
      leftAppPaths.push((Array.isArray(v.path) ? v.path : []).join(" > "));
      continue;
    }
    if (v.result === "unreachable") {
      unreachableCount++;
      continue;
    }
    if (typeof v.screen === "string") {
      screens.add(v.screen);
      visitedCount++;
    }
  }
  return {
    visitCount: typeof coverage?.visitCount === "number" ? coverage.visitCount : visitedCount,
    elapsedSeconds: typeof coverage?.elapsedSeconds === "number" ? coverage.elapsedSeconds : null,
    distinctScreens: screens.size,
    skippedLabels: [...skippedLabels].sort(),
    leftAppPaths,
    unreachableCount,
    queuedButNotVisitedCount: Array.isArray(coverage?.queuedButNotVisited) ? coverage.queuedButNotVisited.length : 0,
  };
}

// ---- Test_spec_output.txt parsing ----------------------------------------------------------------
//
// The XCTest UI test-phase output (xcodebuild's own console log, captured verbatim by Device Farm
// as the TESTSPEC_OUTPUT artifact) prints one "Test Case '-[Suite method]' passed|failed (Ns)." line
// per test method, ": error:" on a compiler/runtime error, and devicefarm-post-test.sh's own final
// "kept N files, SIZE" line.

const TEST_CASE_RE = /Test Case '([^']+)' (passed|failed)/;
const KEPT_FILES_RE = /kept \d+ files/;

export function parseTestSpecOutput(text) {
  const passed = [];
  const failed = [];
  const errors = [];
  let keptFilesLine = null;
  for (const rawLine of String(text || "").split("\n")) {
    const line = rawLine.trimEnd();
    const m = line.match(TEST_CASE_RE);
    if (m) {
      (m[2] === "passed" ? passed : failed).push(m[1]);
      continue;
    }
    if (line.includes(": error:")) errors.push(line.trim());
    if (KEPT_FILES_RE.test(line)) keptFilesLine = line.trim();
  }
  return { passed, failed, errors, keptFilesLine };
}

// ---- syslog app-lifetime parsing (pure line matchers; the streaming file read is IO, in
// syslog-scan.mjs) ----------------------------------------------------------------------------------
//
// Both apps' Xcode scheme (and so the on-device process name) is literally "App" (the Capacitor
// default), verified against a real run's syslog: ` App[528]`, ` App[548]`, ... (83 distinct PIDs
// across one tour + one 62-visit crawl run, each relaunch getting a fresh PID).

const APP_PID_RE = / App\[(\d+)\]/;
const SYSLOG_TS_RE = /^(\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})/;
const CRASH_REPORT_RE = /creating type (\d+) as (\S+\.ips)/;

/** The numeric PID from a ` App[NNNN]` syslog mention, or null. */
export function extractAppPid(line) {
  const m = String(line).match(APP_PID_RE);
  return m ? m[1] : null;
}

/** The leading "Mon DD HH:MM:SS" syslog timestamp, or null. */
export function extractSyslogTimestamp(line) {
  const m = String(line).match(SYSLOG_TS_RE);
  return m ? m[1] : null;
}

/**
 * Parses osanalyticshelper's "creating type N as /path/.../<process>-<date>-<time>.ips" line (a
 * diagnostic/crash report being filed -- CrashReporter files these for EVERY process on the device,
 * most of them system daemons having nothing to do with the app under test). Returns null for a
 * non-matching line, else { type, process, namesApp, raw }.
 *
 * `type` is CrashReporter's own report-bucket number (observed 145 = a resource/diskwrites
 * diagnostic, 313 = a Siri search-feedback diagnostic on an unrelated system process in a real run)
 * -- it is NOT Apple's `bug_type` field from inside the .ips content (that would need reading the
 * report itself, which post-test.sh does not export). A hit here is NOT proof of an app crash by
 * itself: confirm `namesApp` is true AND, for real certainty, that the app process stopped logging
 * after the report's timestamp (see extractAppPid/extractSyslogTimestamp above).
 */
export function parseCrashReportLine(line) {
  const m = String(line).match(CRASH_REPORT_RE);
  if (!m) return null;
  const type = Number(m[1]);
  const filePath = m[2];
  const base = filePath.split("/").pop().replace(/\.ips$/, "");
  const process = base.replace(/-\d{4}-\d{2}-\d{2}-\d{6}$/, "").replace(/^\./, "");
  return { type, process, namesApp: /^app$/i.test(process), raw: String(line).trim() };
}

// ---- run-completion (the "0 device minutes is not stuck" rule) ----------------------------------
//
// Verified live: a genuinely healthy, mid-flight XCTEST_UI run reports GetRun `deviceMinutes: {total:
// 0, metered: 0, unmetered: 0}` and every ListSuites entry `status: PENDING` for the ENTIRE duration
// of the test phase -- Device Farm only starts accounting device-minutes once the job finishes. A
// caller must NEVER infer "stuck" from 0 device-minutes or from PENDING suites; the only correct
// completion signal is GetRun's own `status` field reaching a terminal value. Do not add a
// device-minutes-based stall detector.

export function isRunComplete(run) {
  return !!run && run.status === "COMPLETED";
}

// ---- ScheduleRun request body ---------------------------------------------------------------------

/**
 * Builds the DeviceFarm ScheduleRun request body for an XCTEST_UI run. Exactly one of
 * `devicePoolArn` / `deviceArn` must be supplied: `deviceArn` builds a single-device
 * deviceSelectionConfiguration (ARN IN [deviceArn], maxDevices 1) instead of using a shared pool.
 */
export function buildScheduleRunBody({ projectArn, appArn, devicePoolArn, deviceArn, name, testPackageArn, testSpecArn, jobTimeoutMinutes }) {
  for (const [k, v] of [["projectArn", projectArn], ["appArn", appArn], ["testPackageArn", testPackageArn], ["testSpecArn", testSpecArn]]) {
    if (!v) throw new Error(`buildScheduleRunBody: "${k}" is required`);
  }
  if (!devicePoolArn && !deviceArn) {
    throw new Error("buildScheduleRunBody: one of devicePoolArn or deviceArn is required");
  }
  // Device Farm accepts a whole-minute job timeout of 5..150; reject anything else here rather
  // than sending NaN or an out-of-range value in the ScheduleRun body.
  if (jobTimeoutMinutes !== undefined && (!Number.isInteger(jobTimeoutMinutes) || jobTimeoutMinutes < 5 || jobTimeoutMinutes > 150)) {
    throw new Error(`buildScheduleRunBody: jobTimeoutMinutes must be a whole number from 5 to 150 (got ${jobTimeoutMinutes})`);
  }
  const body = {
    projectArn,
    appArn,
    test: { type: "XCTEST_UI", testPackageArn, testSpecArn },
    executionConfiguration: { jobTimeoutMinutes: jobTimeoutMinutes ?? 145, videoCapture: true },
  };
  if (name) body.name = name;
  if (deviceArn) {
    body.deviceSelectionConfiguration = { filters: [{ attribute: "ARN", operator: "IN", values: [deviceArn] }], maxDevices: 1 };
  } else {
    body.devicePoolArn = devicePoolArn;
  }
  return body;
}

// ---- GitHub artifact / run selection --------------------------------------------------------------

/** First artifact whose name starts with `walkthrough-runner-` (device-walkthrough.yml's fixed
 *  artifact-name prefix, identical on both apps), or null. */
export function pickWalkthroughRunnerArtifact(artifacts) {
  return (Array.isArray(artifacts) ? artifacts : []).find((a) => typeof a?.name === "string" && a.name.startsWith("walkthrough-runner-")) || null;
}

/** First artifact whose name starts with the app's ios-depot IPA prefix, or null. */
export function pickIosIpaArtifact(artifacts, prefix) {
  return (Array.isArray(artifacts) ? artifacts : []).find((a) => typeof a?.name === "string" && a.name.startsWith(prefix)) || null;
}

/**
 * From a list of workflow_dispatch runs (as returned newest-first by GitHub's list-runs endpoint),
 * picks the one actually created by a dispatch fired at/after `dispatchIso` (within `bufferMs` of
 * clock-skew tolerance) -- the EARLIEST such run, so an unrelated later dispatch of the same
 * workflow (by someone else, mid-poll) is never mistaken for ours. Returns null if none qualify yet.
 */
export function pickDispatchedRun(runs, dispatchIso, bufferMs = 15000) {
  const cutoff = Date.parse(dispatchIso) - bufferMs;
  const candidates = (Array.isArray(runs) ? runs : []).filter((r) => Number.isFinite(Date.parse(r?.created_at)) && Date.parse(r.created_at) >= cutoff);
  if (!candidates.length) return null;
  candidates.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  return candidates[0];
}

/** Library file name for a job's screen recording. Each run keeps its own video: a fixed
 *  "Video.mp4" would make a second walkthrough of the same build overwrite the first one's
 *  recording in the media library (same destination path, different sha256). The run id is the
 *  second-to-last ARN segment (arn:...:job:<project>/<run>/<job>). */
export function videoFilenameForJob(jobArn) {
  const parts = String(jobArn || "").split("/");
  const runId = parts.length >= 3 ? parts[parts.length - 2] : "";
  return runId ? `iPhone walkthrough run ${runId.slice(0, 8)}.mp4` : "iPhone walkthrough.mp4";
}
