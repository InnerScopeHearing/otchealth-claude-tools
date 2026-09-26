#!/usr/bin/env node
// walkthrough.mjs -- the device-walkthrough skill CLI: builds the real-iPhone XCUITest walkthrough
// runner on Depot macOS, schedules it on AWS Device Farm, fetches + classifies the results, and
// archives them through app-media. See SKILL.md for the full command reference and background.
//
// Usage: node skills/device-walkthrough/walkthrough.mjs <command> [--flag value ...]
// Commands: apps | build-runner | fetch-ipa | run | fetch | archive | stop | all
//
// No process.exit() anywhere (only process.exitCode) -- Node's stdout is asynchronous when piped,
// and exit() does not wait for a pending write to flush, which can silently truncate a large JSON
// summary (the exact bug this fleet's github-app skill documents and fixed the same way).
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { resolveApp, APP_REGISTRY, artifactFilename, uniqueFilename, classifyAttachment, coverageDigest, parseTestSpecOutput, buildScheduleRunBody, pickWalkthroughRunnerArtifact, pickIosIpaArtifact, pickDispatchedRun, videoFilenameForJob } from "./lib.mjs";
import { uploadAndWait, scheduleRun, stopRun, waitForRunCompletion, listJobs, listSuites, listArtifacts } from "./df-client.mjs";
import { dispatchWorkflow, findDispatchedRun, waitForRunCompletion as waitForGhRunCompletion, listRunArtifacts, downloadArtifactZip } from "./gh-client.mjs";
import { readInfoPlist } from "./plist.mjs";
import { scanSyslogFiles } from "./syslog-scan.mjs";
import { ensureDir, downloadTo, unzip, walkFiles, findFirst, copyInto, appInfoPlistPath } from "./fsio.mjs";

const SKILL_DIR = dirname(fileURLToPath(import.meta.url));

// ---- argv parsing ---------------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        opts[key] = next;
        i++;
      } else {
        opts[key] = true;
      }
    }
  }
  return opts;
}

// ---- apps -------------------------------------------------------------------------------------

function cmdApps() {
  for (const key of Object.keys(APP_REGISTRY)) {
    const a = APP_REGISTRY[key];
    console.log(`${a.displayName}`);
    console.log(`  repo:              ${a.repo}`);
    console.log(`  bundle:            ${a.bundleId}`);
    console.log(`  project:           ${a.projectArn}`);
    console.log(`  pool:              ${a.poolArn}`);
    console.log(`  ios-ipa artifact:  ${a.iosIpaArtifactPrefix}*`);
    console.log("");
  }
}

// ---- build-runner -------------------------------------------------------------------------------

async function cmdBuildRunner(opts) {
  const app = resolveApp(opts.app);
  const ref = opts.ref || "main";
  const [owner, repo] = app.repo.split("/");
  const out = opts.out || join(tmpdir(), "device-walkthrough", app.displayName, `build-runner-${Date.now()}`);
  ensureDir(out);

  console.error(`[build-runner] dispatching device-walkthrough.yml on ${app.repo}@${ref}`);
  const dispatchIso = await dispatchWorkflow({ owner, repo, workflow: "device-walkthrough.yml", ref });
  console.error(`[build-runner] dispatched at ${dispatchIso}; waiting for the run to appear on GitHub...`);
  const run = await findDispatchedRun(
    { owner, repo, workflow: "device-walkthrough.yml", dispatchIso },
    { pick: (runs, iso) => pickDispatchedRun(runs, iso) },
  );
  console.error(`[build-runner] run ${run.id} appeared (${run.html_url}); waiting for completion (job has a 40min timeout)...`);
  const finalRun = await waitForGhRunCompletion({ owner, repo, runId: run.id }, { pollMs: 20 * 1000, timeoutMs: 55 * 60 * 1000 });
  console.error(`[build-runner] run ${run.id} completed: conclusion=${finalRun.conclusion}`);
  if (finalRun.conclusion !== "success") {
    throw new Error(`device-walkthrough.yml run ${run.id} did not succeed (conclusion=${finalRun.conclusion}); see ${finalRun.html_url}`);
  }

  const artifacts = await listRunArtifacts({ owner, repo, runId: run.id });
  const runnerArtifact = pickWalkthroughRunnerArtifact(artifacts);
  if (!runnerArtifact) throw new Error(`no walkthrough-runner-* artifact found on run ${run.id} (found: ${artifacts.map((a) => a.name).join(", ") || "(none)"})`);

  const zipPath = join(out, "artifact.zip");
  console.error(`[build-runner] downloading artifact "${runnerArtifact.name}"...`);
  await downloadArtifactZip({ owner, repo, artifactId: runnerArtifact.id, outPath: zipPath });
  const extractDir = ensureDir(join(out, "extracted"));
  unzip(zipPath, extractDir);

  const runnerZip = findFirst(extractDir, /^WalkthroughUITests\.zip$/);
  const specYml = findFirst(extractDir, /^devicefarm-testspec\.yml$/);
  if (!runnerZip) throw new Error(`WalkthroughUITests.zip not found inside artifact "${runnerArtifact.name}"`);
  if (!specYml) throw new Error(`devicefarm-testspec.yml not found inside artifact "${runnerArtifact.name}"`);

  const result = { runId: run.id, htmlUrl: run.html_url, runnerZip, specYml };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

// ---- fetch-ipa ------------------------------------------------------------------------------------

async function cmdFetchIpa(opts) {
  const app = resolveApp(opts.app);
  const [owner, repo] = app.repo.split("/");
  const runId = opts.run;
  if (!runId) throw new Error("fetch-ipa requires --run <ios-depot GitHub Actions run id>");
  const out = opts.out || join(tmpdir(), "device-walkthrough", app.displayName, `ipa-${runId}`);
  ensureDir(out);

  const artifacts = await listRunArtifacts({ owner, repo, runId });
  const ipaArtifact = pickIosIpaArtifact(artifacts, app.iosIpaArtifactPrefix);
  if (!ipaArtifact) {
    throw new Error(`no "${app.iosIpaArtifactPrefix}*" artifact on run ${runId} (found: ${artifacts.map((a) => a.name).join(", ") || "(none)"})`);
  }

  const zipPath = join(out, "artifact.zip");
  console.error(`[fetch-ipa] downloading artifact "${ipaArtifact.name}"...`);
  await downloadArtifactZip({ owner, repo, artifactId: ipaArtifact.id, outPath: zipPath });
  const extractDir = ensureDir(join(out, "extracted"));
  unzip(zipPath, extractDir);

  const ipaPath = findFirst(extractDir, /\.ipa$/i);
  if (!ipaPath) throw new Error(`no .ipa found inside artifact "${ipaArtifact.name}"`);

  const payloadDir = ensureDir(join(out, "payload"));
  unzip(ipaPath, payloadDir);
  const plistPath = appInfoPlistPath(payloadDir);
  if (!plistPath) throw new Error(`no Payload/*.app/Info.plist found inside ${ipaPath}`);

  const info = readInfoPlist(plistPath);
  if (info.CFBundleIdentifier !== app.bundleId) {
    throw new Error(`bundle id mismatch: the IPA is "${info.CFBundleIdentifier}", the registry expects "${app.bundleId}" for ${app.displayName}. Refusing.`);
  }

  const result = { ipaPath, bundleId: info.CFBundleIdentifier, marketingVersion: info.CFBundleShortVersionString, buildNumber: String(info.CFBundleVersion) };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

// ---- run --------------------------------------------------------------------------------------

async function cmdRun(opts) {
  const app = resolveApp(opts.app);
  if (!opts.ipa) throw new Error("run requires --ipa <path>");
  if (!opts.runner) throw new Error("run requires --runner <WalkthroughUITests.zip>");
  if (!opts.spec) throw new Error("run requires --spec <devicefarm-testspec.yml>");

  const label = typeof opts.label === "string" ? opts.label : `${app.displayName}-walkthrough-${Date.now()}`;
  const timeoutMinutes = opts.timeout ? Number(opts.timeout) : 145;
  const deviceArn = typeof opts["device-arn"] === "string" ? opts["device-arn"] : undefined;

  console.error(`[run] uploading app/runner/spec for ${app.displayName} (label "${label}")...`);
  const appArn = await uploadAndWait({ projectArn: app.projectArn, name: `${label}-app.ipa`, type: "IOS_APP", filePath: opts.ipa });
  console.error(`[run]   app uploaded: ${appArn}`);
  const testPackageArn = await uploadAndWait({ projectArn: app.projectArn, name: `${label}-runner.zip`, type: "XCTEST_UI_TEST_PACKAGE", filePath: opts.runner });
  console.error(`[run]   runner uploaded: ${testPackageArn}`);
  const testSpecArn = await uploadAndWait({ projectArn: app.projectArn, name: `${label}-spec.yml`, type: "XCTEST_UI_TEST_SPEC", filePath: opts.spec });
  console.error(`[run]   spec uploaded: ${testSpecArn}`);

  const body = buildScheduleRunBody({
    projectArn: app.projectArn,
    appArn,
    devicePoolArn: deviceArn ? undefined : app.poolArn,
    deviceArn,
    name: label,
    testPackageArn,
    testSpecArn,
    jobTimeoutMinutes: timeoutMinutes,
  });
  const run = await scheduleRun(body);
  console.log(run.arn);
  console.error(`[run] scheduled ${run.arn}`);

  if (opts["no-wait"]) return run;

  console.error("[run] waiting for completion (polling GetRun every 90s -- 0 device-minutes/PENDING suites mid-flight is normal, not stuck)...");
  const finalRun = await waitForRunCompletion(run.arn, {
    pollMs: 90 * 1000,
    onPoll: (r) => console.error(`[run]   status=${r.status} result=${r.result || "-"}`),
  });
  console.error(`[run] completed: status=${finalRun.status} result=${finalRun.result}`);
  console.log(JSON.stringify(finalRun, null, 2));
  return finalRun;
}

// ---- fetch ------------------------------------------------------------------------------------

async function fetchOneJob(job, jobOut) {
  console.error(`[fetch] job ${job.arn}`);
  console.error(`[fetch]   device: ${job.device?.name} ${job.device?.os} result=${job.result} counters=${JSON.stringify(job.counters)}`);

  const suites = await listSuites(job.arn);
  for (const s of suites) console.error(`[fetch]   suite "${s.name}": ${s.result} -- ${(s.message || "").slice(0, 140)}`);

  const rawDir = ensureDir(join(jobOut, "_raw"));
  const seenNames = new Set();
  const downloaded = [];
  for (const type of ["FILE", "LOG"]) {
    const arts = await listArtifacts(job.arn, type);
    for (const a of arts) {
      const filename = uniqueFilename(seenNames, artifactFilename(a.name, a.extension));
      seenNames.add(filename);
      const dest = join(rawDir, filename);
      console.error(`[fetch]   downloading ${a.type} "${a.name}" -> ${filename}`);
      await downloadTo(a.url, dest);
      downloaded.push({ ...a, filename, localPath: dest });
    }
  }

  const tourDir = ensureDir(join(jobOut, "tour"));
  const crawlDir = ensureDir(join(jobOut, "crawl"));
  const videoDir = ensureDir(join(jobOut, "video"));
  const otherDir = join(jobOut, "other");

  const classifiedCounts = { tour: 0, crawl: 0, other: 0 };
  const customerArtifact = downloaded.find((a) => a.type === "CUSTOMER_ARTIFACT");
  if (customerArtifact) {
    const caDir = join(jobOut, "_raw", "ca");
    unzip(customerArtifact.localPath, caDir);
    for (const f of walkFiles(caDir)) {
      const base = basename(f);
      const c = classifyAttachment(base);
      if (c.dest === "tour") {
        copyInto(f, tourDir, c.name);
        classifiedCounts.tour++;
      } else if (c.dest === "crawl") {
        copyInto(f, crawlDir, c.name);
        classifiedCounts.crawl++;
      } else {
        copyInto(f, otherDir, c.name);
        classifiedCounts.other++;
      }
    }
  } else {
    console.error("[fetch]   no CUSTOMER_ARTIFACT on this job (no tour/crawl output)");
  }
  console.error(`[fetch]   classified: tour=${classifiedCounts.tour} crawl=${classifiedCounts.crawl} other=${classifiedCounts.other}`);

  const videoArtifact = downloaded.find((a) => a.type === "VIDEO");
  if (videoArtifact) copyInto(videoArtifact.localPath, videoDir, videoFilenameForJob(job.arn));

  const testSpecOutput = downloaded.find((a) => a.type === "TESTSPEC_OUTPUT");
  let specSummary = null;
  if (testSpecOutput) {
    specSummary = parseTestSpecOutput(readFileSync(testSpecOutput.localPath, "utf8"));
    console.error(`[fetch]   Test_spec_output: ${specSummary.passed.length} passed, ${specSummary.failed.length} failed, ${specSummary.errors.length} error line(s)`);
    for (const p of specSummary.passed) console.error(`[fetch]     PASSED ${p}`);
    for (const f of specSummary.failed) console.error(`[fetch]     FAILED ${f}`);
    if (specSummary.keptFilesLine) console.error(`[fetch]     ${specSummary.keptFilesLine}`);
  }

  let coverage = null;
  const coveragePath = join(crawlDir, "crawl-coverage.json");
  if (existsSync(coveragePath)) {
    coverage = coverageDigest(JSON.parse(readFileSync(coveragePath, "utf8")));
    console.error(
      `[fetch]   crawl coverage: visitCount=${coverage.visitCount} distinctScreens=${coverage.distinctScreens} unreachable=${coverage.unreachableCount} leftApp=${coverage.leftAppPaths.length} skipped=${coverage.skippedLabels.length} queuedButNotVisited=${coverage.queuedButNotVisitedCount}`,
    );
  }

  const syslogArtifacts = downloaded.filter((a) => a.type === "DEVICE_LOG");
  let syslogSummary = null;
  if (syslogArtifacts.length) {
    console.error(`[fetch]   scanning ${syslogArtifacts.length} syslog file(s) for app lifetime + crash reports...`);
    const r = await scanSyslogFiles(syslogArtifacts.map((a) => a.localPath));
    const crashReportsNamingApp = r.crashReports.filter((c) => c.namesApp);
    syslogSummary = {
      distinctPids: r.pids.size,
      appLineCount: r.appLineCount,
      firstTimestamp: r.firstTimestamp,
      lastTimestamp: r.lastTimestamp,
      crashReportsNamingApp,
      crashReportsOtherCount: r.crashReports.length - crashReportsNamingApp.length,
    };
    console.error(`[fetch]   app process: ${syslogSummary.distinctPids} distinct PID(s), first=${syslogSummary.firstTimestamp || "-"} last=${syslogSummary.lastTimestamp || "-"}`);
    console.error(
      `[fetch]   crash/diagnostic reports naming the app process: ${crashReportsNamingApp.length} (NOT by itself proof of a crash -- see lib.mjs's parseCrashReportLine); other (system) process reports: ${syslogSummary.crashReportsOtherCount}`,
    );
  }

  return { jobArn: job.arn, device: job.device, result: job.result, counters: job.counters, jobOut, suites, classifiedCounts, specSummary, coverage, syslogSummary };
}

async function cmdFetch(opts) {
  const runArn = opts.run;
  if (!runArn) throw new Error("fetch requires --run <run ARN>");
  const out = opts.out;
  if (!out) throw new Error("fetch requires --out <dir>");
  ensureDir(out);

  const jobs = await listJobs(runArn);
  if (!jobs.length) throw new Error(`no jobs found for run ${runArn}`);
  const multi = jobs.length > 1;

  const results = [];
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const jobOut = multi ? join(out, `job-${i + 1}-${String(job.device?.name || "device").replace(/[^A-Za-z0-9._-]+/g, "-")}`) : out;
    results.push(await fetchOneJob(job, jobOut));
  }

  console.log(JSON.stringify({ runArn, jobs: results }, null, 2));
  return results;
}

// ---- archive ----------------------------------------------------------------------------------

async function cmdArchive(opts) {
  const app = resolveApp(opts.app);
  if (!opts.dir) throw new Error("archive requires --dir <dir from fetch>");
  if (!opts.version) throw new Error("archive requires --version");
  if (!opts.build) throw new Error("archive requires --build");

  const archiveScript = join(SKILL_DIR, "..", "app-media", "archive.mjs");
  const source = typeof opts["run-label"] === "string" ? opts["run-label"] : "Device Farm run";
  const mapping = [
    ["tour", "iphone-screenshots"],
    ["crawl", "coverage-report"],
    ["video", "iphone-video"],
  ];

  const results = [];
  for (const [sub, kind] of mapping) {
    const p = join(opts.dir, sub);
    if (!existsSync(p)) {
      console.error(`[archive] skip ${sub} (no such directory: ${p})`);
      continue;
    }
    const files = readdirSync(p);
    if (!files.length) {
      console.error(`[archive] skip ${sub} (empty)`);
      continue;
    }
    console.error(`[archive] archiving ${sub}/ -> kind=${kind} (${files.length} file(s))`);
    execFileSync("node", [archiveScript, "add", "--app", app.displayName, "--version", String(opts.version), "--build", String(opts.build), "--kind", kind, "--source", source, p], {
      stdio: "inherit",
    });
    results.push({ sub, kind });
  }
  return results;
}

// ---- stop -------------------------------------------------------------------------------------

async function cmdStop(opts) {
  if (!opts.run) throw new Error("stop requires --run <run ARN>");
  const run = await stopRun(opts.run);
  console.log(JSON.stringify(run, null, 2));
  return run;
}

// ---- all --------------------------------------------------------------------------------------

async function cmdAll(opts) {
  const app = resolveApp(opts.app);
  if (!opts["ios-run"]) throw new Error("all requires --ios-run <ios-depot GitHub Actions run id>");
  const ref = opts.ref || "main";
  const base = opts.out || join(tmpdir(), "device-walkthrough", app.displayName, `all-${Date.now()}`);
  ensureDir(base);

  console.error("[all] step 1/5: build-runner");
  const built = await cmdBuildRunner({ app: app.displayName, ref, out: join(base, "runner") });

  console.error("[all] step 2/5: fetch-ipa");
  const ipa = await cmdFetchIpa({ app: app.displayName, run: opts["ios-run"], out: join(base, "ipa") });

  console.error("[all] step 3/5: run");
  const label = typeof opts.label === "string" ? opts.label : `${app.displayName}-${ipa.marketingVersion}-${ipa.buildNumber}`;
  const run = await cmdRun({
    app: app.displayName,
    ipa: ipa.ipaPath,
    runner: built.runnerZip,
    spec: built.specYml,
    label,
    timeout: opts.timeout,
    "device-arn": opts["device-arn"],
  });

  console.error("[all] step 4/5: fetch");
  const fetchOut = join(base, "fetch");
  const fetched = await cmdFetch({ run: run.arn, out: fetchOut });

  console.error("[all] step 5/5: archive");
  const runIdTail = String(run.arn).split("/").pop();
  await cmdArchive({ app: app.displayName, version: ipa.marketingVersion, build: ipa.buildNumber, dir: fetchOut, "run-label": `Device Farm run ${runIdTail}` });

  const result = { runArn: run.arn, ipa, fetchOut, jobs: fetched };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

// ---- main ---------------------------------------------------------------------------------------

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);
  try {
    switch (cmd) {
      case "apps":
        cmdApps();
        break;
      case "build-runner":
        await cmdBuildRunner(opts);
        break;
      case "fetch-ipa":
        await cmdFetchIpa(opts);
        break;
      case "run":
        await cmdRun(opts);
        break;
      case "fetch":
        await cmdFetch(opts);
        break;
      case "archive":
        await cmdArchive(opts);
        break;
      case "stop":
        await cmdStop(opts);
        break;
      case "all":
        await cmdAll(opts);
        break;
      default:
        console.error("usage: walkthrough.mjs <apps|build-runner|fetch-ipa|run|fetch|archive|stop|all> [--flag value ...]");
        console.error("see SKILL.md for the full flag reference per command");
        process.exitCode = cmd ? 1 : 2;
    }
  } catch (e) {
    console.error(`ERROR: ${e && e.message ? e.message : e}`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();
