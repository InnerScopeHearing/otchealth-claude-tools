// Regression tests for the device-walkthrough skill's pure logic (lib.mjs). Every fixture below is
// taken verbatim from a real AWS Device Farm XCTEST_UI run against AWARE (project
// 58bbc541-f082-4594-b744-738a345f3654, run d198e60f-c6ad-47bb-a559-1843fc67755b), not invented --
// the exact attachment names, crawl-coverage.json shape, Test_spec_output.txt lines, and syslog
// lines a real fetch will see.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  APP_REGISTRY,
  resolveApp,
  stripAttachmentSuffix,
  classifyAttachment,
  artifactFilename,
  uniqueFilename,
  coverageDigest,
  parseTestSpecOutput,
  extractAppPid,
  extractSyslogTimestamp,
  parseCrashReportLine,
  isRunComplete,
  buildScheduleRunBody,
  pickWalkthroughRunnerArtifact,
  pickIosIpaArtifact,
  pickDispatchedRun,
  videoFilenameForJob,
} from "../lib.mjs";

// ---- registry -----------------------------------------------------------------------------------

test("resolveApp: exact and case-insensitive lookup for all registered apps", () => {
  assert.equal(resolveApp("AWARE").bundleId, "com.innerscope.aware");
  assert.equal(resolveApp("aware").repo, "InnerScopeHearing/aware-aural-rehab");
  assert.equal(resolveApp("iHEARtest").bundleId, "com.innerscope.iheartest");
  assert.equal(resolveApp("IHEARTEST").repo, "InnerScopeHearing/iheartest");
  assert.equal(resolveApp("HeyMillie").bundleId, "com.otchealth.companion");
  assert.equal(resolveApp("heymillie").repo, "InnerScopeHearing/otchealth-companion");
  assert.equal(Object.keys(APP_REGISTRY).length, 3);
});

test("HeyMillie registry entry: distinct Device Farm project/pool from AWARE and iHEARtest", () => {
  const millie = APP_REGISTRY.HeyMillie;
  assert.equal(millie.iosIpaArtifactPrefix, "companion-ios-ipa-");
  assert.match(millie.projectArn, /^arn:aws:devicefarm:us-west-2:900915535335:project:/);
  assert.match(millie.poolArn, /^arn:aws:devicefarm:us-west-2:900915535335:devicepool:/);
  const arns = Object.values(APP_REGISTRY).map((a) => `${a.projectArn}|${a.poolArn}`);
  assert.equal(new Set(arns).size, arns.length, "every app must have its own project+pool ARN pair");
});

test("resolveApp: throws a helpful, exact error on missing/unknown app", () => {
  assert.throws(() => resolveApp(undefined), /--app is required/);
  assert.throws(() => resolveApp("Flatstick"), /unknown --app "Flatstick"/);
});

// ---- attachment classification -------------------------------------------------------------------

test("stripAttachmentSuffix removes the xcresulttool _<index>_<UUID> suffix, keeps the extension", () => {
  assert.equal(
    stripAttachmentSuffix("010 crawl Program > 1 Speech details Contrasts and words Current week · Ready_0_EE3D928E-D144-400B-8C09-8D83B3EE8BE3.png"),
    "010 crawl Program > 1 Speech details Contrasts and words Current week · Ready.png",
  );
  assert.equal(stripAttachmentSuffix("crawl-coverage_0_05E94F7E-16EB-4208-AEC5-4F74A02E7CBE.json"), "crawl-coverage.json");
  // No suffix present -> unchanged.
  assert.equal(stripAttachmentSuffix("test_results.json"), "test_results.json");
  assert.equal(stripAttachmentSuffix("attachment-index.tsv"), "attachment-index.tsv");
});

test("classifyAttachment: tour screenshot", () => {
  const c = classifyAttachment("001 Today, first launch_0_5C0AAF81-CA52-4C92-8EE7-6C87A8982397.png");
  assert.equal(c.dest, "tour");
  assert.equal(c.name, "001 Today, first launch.png");
});

test("classifyAttachment: crawl screenshot (the task's own worked example)", () => {
  const c = classifyAttachment("045 crawl Program > 1 Speech details Contrasts and words Current week · Ready_0_D0271F75-7231-4C5D-8B2B-5DCEA5B1CB79.png");
  assert.equal(c.dest, "crawl");
  assert.equal(c.name, "045 crawl Program > 1 Speech details Contrasts and words Current week · Ready.png");
});

test("classifyAttachment: crawl-coverage.json and test_results.json (renamed)", () => {
  const cov = classifyAttachment("crawl-coverage_0_05E94F7E-16EB-4208-AEC5-4F74A02E7CBE.json");
  assert.equal(cov.dest, "crawl");
  assert.equal(cov.name, "crawl-coverage.json");

  const tr = classifyAttachment("test_results.json");
  assert.equal(tr.dest, "crawl");
  assert.equal(tr.name, "device-test-results.json");
});

test("classifyAttachment: unrecognized file goes to 'other', never silently dropped", () => {
  const c = classifyAttachment("attachment-index.tsv");
  assert.equal(c.dest, "other");
  assert.equal(c.name, "attachment-index.tsv");
});

test("classifyAttachment: a full real batch reproduces the observed 101 tour / 64 crawl+coverage split", () => {
  // 101 tour screenshots numbered 001..101, each also has a same-numbered crawl entry for the first
  // 62 (the crawl's own visitCount), plus the coverage json and the renamed test-results file.
  const files = [];
  for (let i = 1; i <= 101; i++) files.push(`${String(i).padStart(3, "0")} Some Tour Screen (${i})_0_${uuid(i)}.png`);
  for (let i = 1; i <= 62; i++) files.push(`${String(i).padStart(3, "0")} crawl Some > Path ${i}_0_${uuid(i + 1000)}.png`);
  files.push("crawl-coverage_0_05E94F7E-16EB-4208-AEC5-4F74A02E7CBE.json");
  files.push("test_results.json");
  files.push("attachment-index.tsv");

  const counts = { tour: 0, crawl: 0, other: 0 };
  for (const f of files) counts[classifyAttachment(f).dest]++;

  assert.equal(counts.tour, 101);
  assert.equal(counts.crawl, 64); // 62 crawl screenshots + crawl-coverage.json + device-test-results.json
  assert.equal(counts.other, 1); // attachment-index.tsv
});

function uuid(seed) {
  const hex = seed.toString(16).padStart(8, "0").toUpperCase();
  return `${hex}-0000-4000-8000-000000000000`;
}

// ---- Device Farm ListArtifacts filename dedupe -----------------------------------------------

test("artifactFilename: spaces become underscores", () => {
  assert.equal(artifactFilename("Test spec output", "txt"), "Test_spec_output.txt");
  assert.equal(artifactFilename("Video", "mp4"), "Video.mp4");
});

test("uniqueFilename: collisions get -1, -2, ... inserted before the extension (a real run had 3 'Syslog' artifacts)", () => {
  const seen = new Set();
  const names = ["Syslog", "Syslog", "Syslog"].map((n) => {
    const fn = uniqueFilename(seen, artifactFilename(n, "syslog"));
    seen.add(fn);
    return fn;
  });
  assert.deepEqual(names, ["Syslog.syslog", "Syslog-1.syslog", "Syslog-2.syslog"]);
});

test("uniqueFilename: no collision returns the name unchanged", () => {
  const seen = new Set(["Video.mp4"]);
  assert.equal(uniqueFilename(seen, "Test_spec_output.txt"), "Test_spec_output.txt");
});

// ---- crawl-coverage.json digest ------------------------------------------------------------------

const REAL_COVERAGE_SAMPLE = {
  elapsedSeconds: 1356,
  globals: ["AWARE, go to Today", "Skip to content"],
  queuedButNotVisited: [],
  visitCount: 62,
  visits: [
    { path: ["Today"], screen: "Skip to content | Using | Thursday | A quiet place to begin.", controls: ["Today", "Program"] },
    { path: ["Program"], screen: "Skip to content | Using | Six weeks of listening practice | Using Me", controls: ["Today", "Program"] },
    { path: ["Program", "Delete profile"], result: "skipped-deny" },
    { path: ["Practice", "Buy now"], result: "skipped-deny" },
    { path: ["Activity", "Sign out"], result: "skipped-deny" },
    { path: ["Today", "Call support"], result: "left-app" },
    { path: ["You", "Something odd"], result: "unreachable" },
  ],
};

test("coverageDigest: matches the real run's shape (visitCount 62, elapsedSeconds 1356)", () => {
  const d = coverageDigest(REAL_COVERAGE_SAMPLE);
  assert.equal(d.visitCount, 62);
  assert.equal(d.elapsedSeconds, 1356);
  assert.equal(d.distinctScreens, 2);
  assert.deepEqual(d.skippedLabels, ["Buy now", "Delete profile", "Sign out"]);
  assert.deepEqual(d.leftAppPaths, ["Today > Call support"]);
  assert.equal(d.unreachableCount, 1);
  assert.equal(d.queuedButNotVisitedCount, 0);
});

test("coverageDigest: tolerates a missing/malformed coverage object rather than throwing", () => {
  assert.doesNotThrow(() => coverageDigest({}));
  assert.doesNotThrow(() => coverageDigest(null));
  const d = coverageDigest({ visits: [{ path: [], result: "skipped-deny" }] });
  assert.equal(d.skippedLabels.length, 0); // an empty path has no label to record
});

// ---- Test_spec_output.txt parsing ----------------------------------------------------------------

test("parseTestSpecOutput: real Test_spec_output.txt lines", () => {
  const text = [
    "Some xcodebuild noise",
    "Test Case '-[WalkthroughUITests.AwareWalkthrough test1_Tour]' passed (870.763 seconds).",
    "Test Case '-[WalkthroughUITests.AwareWalkthrough test2_EveryButton]' passed (1356.575 seconds).",
    "kept 166 files, 169M",
  ].join("\n");
  const r = parseTestSpecOutput(text);
  assert.deepEqual(r.passed, ["-[WalkthroughUITests.AwareWalkthrough test1_Tour]", "-[WalkthroughUITests.AwareWalkthrough test2_EveryButton]"]);
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.errors, []);
  assert.equal(r.keptFilesLine, "kept 166 files, 169M");
});

test("parseTestSpecOutput: a failing test and a compiler error are both captured", () => {
  const text = [
    "/path/to/Walker.swift:123:45: error: cannot find 'foo' in scope",
    "Test Case '-[WalkthroughUITests.AwareWalkthrough test1_Tour]' failed (12.0 seconds).",
  ].join("\n");
  const r = parseTestSpecOutput(text);
  assert.deepEqual(r.failed, ["-[WalkthroughUITests.AwareWalkthrough test1_Tour]"]);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /error: cannot find 'foo'/);
});

// ---- syslog line matchers -------------------------------------------------------------------------

test("extractAppPid: matches the fleet-wide ' App[NNNN]' Capacitor process-name convention", () => {
  const line = "Sep 24 16:16:12 iPhone runningboardd(RunningBoard)[52] <Notice>: Xpc: com.innerscope.aware App[528]";
  assert.equal(extractAppPid(line), "528");
  assert.equal(extractAppPid("Sep 24 16:16:12 iPhone SpringBoard[54] <Notice>: something unrelated"), null);
});

test("extractSyslogTimestamp: leading 'Mon DD HH:MM:SS'", () => {
  assert.equal(extractSyslogTimestamp("Sep 24 16:16:07 LHFM2HWCTQ osanalyticshelper[165] <Notice>: hi"), "Sep 24 16:16:07");
  assert.equal(extractSyslogTimestamp("not a syslog line"), null);
});

test("parseCrashReportLine: real system-process diagnostic lines (NOT the app) are classified correctly", () => {
  const a = parseCrashReportLine(
    "Sep 24 16:16:07 LHFM2HWCTQ osanalyticshelper(OSAnalytics)[165] <Notice>: creating type 145 as /private/var/mobile/Library/Logs/CrashReporter/.mediaplaybackd.diskwrites_resource-2026-09-24-161607.ips",
  );
  assert.equal(a.type, 145);
  assert.equal(a.process, "mediaplaybackd.diskwrites_resource");
  assert.equal(a.namesApp, false);

  const b = parseCrashReportLine(
    "Sep 24 16:33:36 LHFM2HWCTQ osanalyticshelper(OSAnalytics)[165] <Notice>: creating type 313 as /private/var/mobile/Library/Logs/CrashReporter/.SiriSearchFeedback-2026-09-24-163336.ips",
  );
  assert.equal(b.process, "SiriSearchFeedback");
  assert.equal(b.namesApp, false);
});

test("parseCrashReportLine: a report naming the app's own process ('App') is flagged, others are not", () => {
  const app = parseCrashReportLine(
    "Sep 24 16:40:00 LHFM2HWCTQ osanalyticshelper(OSAnalytics)[165] <Notice>: creating type 309 as /private/var/mobile/Library/Logs/CrashReporter/App-2026-09-24-164000.ips",
  );
  assert.equal(app.process, "App");
  assert.equal(app.namesApp, true);

  assert.equal(parseCrashReportLine("no crash marker on this line"), null);
});

// ---- run completion: the "0 device minutes is not stuck" rule --------------------------------

test("isRunComplete: only status COMPLETED counts, regardless of deviceMinutes or suite state", () => {
  const midFlight = { status: "RUNNING", deviceMinutes: { total: 0, metered: 0, unmetered: 0 }, result: "PENDING" };
  const midFlightWithMinutes = { status: "RUNNING", deviceMinutes: { total: 12.3, metered: 5, unmetered: 0 }, result: "PENDING" };
  const done = { status: "COMPLETED", deviceMinutes: { total: 39.13, metered: 20, unmetered: 0 }, result: "PASSED" };
  // Both non-terminal runs read the same way regardless of deviceMinutes -- proves the function
  // never keys off deviceMinutes (the real "0 minutes while genuinely healthy" case observed live).
  assert.equal(isRunComplete(midFlight), false);
  assert.equal(isRunComplete(midFlightWithMinutes), false);
  assert.equal(isRunComplete(done), true);
  assert.equal(isRunComplete(null), false);
  assert.equal(isRunComplete(undefined), false);
});

// ---- ScheduleRun body ---------------------------------------------------------------------------

test("buildScheduleRunBody: device pool path", () => {
  const body = buildScheduleRunBody({
    projectArn: "arn:aws:devicefarm:us-west-2:900915535335:project:P",
    appArn: "arn:...:upload:A",
    devicePoolArn: "arn:...:devicepool:P/D",
    name: "label",
    testPackageArn: "arn:...:upload:T",
    testSpecArn: "arn:...:upload:S",
    jobTimeoutMinutes: 145,
  });
  assert.equal(body.devicePoolArn, "arn:...:devicepool:P/D");
  assert.equal(body.deviceSelectionConfiguration, undefined);
  assert.equal(body.test.type, "XCTEST_UI");
  assert.equal(body.executionConfiguration.videoCapture, true);
  assert.equal(body.executionConfiguration.jobTimeoutMinutes, 145);
});

test("buildScheduleRunBody: single-device path builds deviceSelectionConfiguration, not devicePoolArn", () => {
  const body = buildScheduleRunBody({
    projectArn: "arn:aws:devicefarm:us-west-2:900915535335:project:P",
    appArn: "arn:...:upload:A",
    deviceArn: "arn:aws:devicefarm:us-west-2::device:XYZ",
    testPackageArn: "arn:...:upload:T",
    testSpecArn: "arn:...:upload:S",
  });
  assert.equal(body.devicePoolArn, undefined);
  assert.deepEqual(body.deviceSelectionConfiguration, { filters: [{ attribute: "ARN", operator: "IN", values: ["arn:aws:devicefarm:us-west-2::device:XYZ"] }], maxDevices: 1 });
  assert.equal(body.executionConfiguration.jobTimeoutMinutes, 145); // the documented default
});

test("buildScheduleRunBody: throws on missing required fields, and when neither pool nor device is given", () => {
  assert.throws(() => buildScheduleRunBody({ appArn: "a", testPackageArn: "t", testSpecArn: "s", devicePoolArn: "p" }), /projectArn/);
  assert.throws(
    () => buildScheduleRunBody({ projectArn: "p", appArn: "a", testPackageArn: "t", testSpecArn: "s" }),
    /devicePoolArn or deviceArn/,
  );
});

// ---- GitHub artifact / run selection --------------------------------------------------------------

test("pickIosIpaArtifact: HeyMillie's fixed companion-ios-ipa- prefix", () => {
  const artifacts = [
    { id: 1, name: "build-for-testing-logs" },
    { id: 2, name: "companion-ios-ipa-abc123" },
    { id: 3, name: "aware-ios-ipa-def456" },
  ];
  assert.equal(pickIosIpaArtifact(artifacts, APP_REGISTRY.HeyMillie.iosIpaArtifactPrefix).id, 2);
  assert.equal(pickIosIpaArtifact(artifacts, "iheartest-ios-ipa-"), null);
});

test("pickWalkthroughRunnerArtifact / pickIosIpaArtifact match the real fixed artifact-name prefixes", () => {
  const artifacts = [
    { id: 1, name: "build-for-testing-logs" },
    { id: 2, name: "walkthrough-runner-abc123" },
    { id: 3, name: "aware-ios-ipa-def456" },
  ];
  assert.equal(pickWalkthroughRunnerArtifact(artifacts).id, 2);
  assert.equal(pickIosIpaArtifact(artifacts, "aware-ios-ipa-").id, 3);
  assert.equal(pickIosIpaArtifact(artifacts, "iheartest-ios-ipa-"), null);
  assert.equal(pickWalkthroughRunnerArtifact([]), null);
});

test("pickDispatchedRun: earliest run at/after the dispatch timestamp, ignoring an older run and preferring the earliest of two newer ones", () => {
  const dispatchIso = "2026-09-24T22:00:00Z";
  const runs = [
    { id: 3, created_at: "2026-09-24T22:00:20Z" }, // newest-first order, as GitHub returns
    { id: 2, created_at: "2026-09-24T22:00:05Z" }, // OUR run: earliest one at/after dispatch
    { id: 1, created_at: "2026-09-24T21:59:00Z" }, // an older, unrelated run -- must be ignored
  ];
  assert.equal(pickDispatchedRun(runs, dispatchIso).id, 2);
  assert.equal(pickDispatchedRun([{ id: 9, created_at: "2026-09-24T21:00:00Z" }], dispatchIso), null);
});

test("videoFilenameForJob: each run keeps its own recording (no shared Video.mp4)", () => {
  const a = videoFilenameForJob("arn:aws:devicefarm:us-west-2:900915535335:job:58bbc541-f082/452dd779-70db-431e/00000");
  const b = videoFilenameForJob("arn:aws:devicefarm:us-west-2:900915535335:job:58bbc541-f082/d198e60f-1111-2222/00000");
  assert.equal(a, "iPhone walkthrough run 452dd779.mp4");
  assert.notEqual(a, b);
  assert.equal(videoFilenameForJob(""), "iPhone walkthrough.mp4");
});

test("buildScheduleRunBody: rejects a non-numeric or out-of-range job timeout", () => {
  const base = { projectArn: "p", appArn: "a", testPackageArn: "t", testSpecArn: "s", devicePoolArn: "d" };
  assert.throws(() => buildScheduleRunBody({ ...base, jobTimeoutMinutes: Number("abc") }), /whole number from 5 to 150/);
  assert.throws(() => buildScheduleRunBody({ ...base, jobTimeoutMinutes: 151 }), /whole number from 5 to 150/);
  assert.equal(buildScheduleRunBody({ ...base, jobTimeoutMinutes: 145 }).executionConfiguration.jobTimeoutMinutes, 145);
  assert.equal(buildScheduleRunBody(base).executionConfiguration.jobTimeoutMinutes, 145);
});

// Regression: Hey Millie build 2's IPA nests Alamofire's SPM resource bundle (with its own
// Info.plist) inside App.app; a recursive "first Info.plist" search returned that one and
// fetch-ipa refused the real app with a bogus bundle-id mismatch.
test("appInfoPlistPath returns the top-level app Info.plist, never a nested bundle's", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { appInfoPlistPath } = await import("../fsio.mjs");
  const dir = mkdtempSync(join(tmpdir(), "dw-plist-"));
  const app = join(dir, "Payload", "App.app");
  const nested = join(app, "Alamofire_Alamofire.bundle");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, "Info.plist"), "nested");
  writeFileSync(join(app, "Info.plist"), "app");
  assert.equal(appInfoPlistPath(dir), join(app, "Info.plist"));
  assert.equal(appInfoPlistPath(join(dir, "missing")), null);
});
