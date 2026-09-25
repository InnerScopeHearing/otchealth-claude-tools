// syslog-scan.mjs -- streams a Device Farm DEVICE_LOG (syslog) file and applies lib.mjs's pure line
// matchers. Kept separate from lib.mjs because it is genuinely IO (large files, ~500MB+ observed on
// a real 62-visit crawl run): readline streaming keeps memory flat regardless of file size (measured
// live: a 546MB / 4.3M-line file scans in ~2.5s).
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { extractAppPid, extractSyslogTimestamp, parseCrashReportLine } from "./lib.mjs";

/**
 * Scans one syslog file for the app's own process lifetime (distinct PIDs, first/last mention) and
 * every CrashReporter "creating type N as ..." line (see lib.mjs's parseCrashReportLine for why a
 * hit here is NOT proof of an app crash by itself).
 *
 * @returns {Promise<{pids: Set<string>, firstLine: string|null, firstTimestamp: string|null,
 *   lastLine: string|null, lastTimestamp: string|null, appLineCount: number,
 *   crashReports: Array<ReturnType<typeof parseCrashReportLine>>}>}
 */
export async function scanSyslogFile(path) {
  const pids = new Set();
  let firstLine = null;
  let firstTimestamp = null;
  let lastLine = null;
  let lastTimestamp = null;
  let appLineCount = 0;
  const crashReports = [];

  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    const pid = extractAppPid(line);
    if (pid !== null) {
      pids.add(pid);
      appLineCount++;
      if (firstLine === null) {
        firstLine = line;
        firstTimestamp = extractSyslogTimestamp(line);
      }
      lastLine = line;
      lastTimestamp = extractSyslogTimestamp(line);
    }
    const crash = parseCrashReportLine(line);
    if (crash) crashReports.push(crash);
  }
  return { pids, firstLine, firstTimestamp, lastLine, lastTimestamp, appLineCount, crashReports };
}

/** Scans several syslog part files IN THE ORDER GIVEN (Device Farm splits a large device log into
 *  numbered parts; the order Device Farm's own ListArtifacts response returns them in is the true
 *  chronological order) and merges the results: PIDs union, first-mention from the first file that
 *  has one, last-mention from the last file that has one, crash reports concatenated in file order. */
export async function scanSyslogFiles(paths) {
  const pids = new Set();
  let firstLine = null;
  let firstTimestamp = null;
  let lastLine = null;
  let lastTimestamp = null;
  let appLineCount = 0;
  const crashReports = [];
  for (const p of paths) {
    const r = await scanSyslogFile(p);
    for (const pid of r.pids) pids.add(pid);
    appLineCount += r.appLineCount;
    crashReports.push(...r.crashReports);
    if (firstLine === null && r.firstLine !== null) {
      firstLine = r.firstLine;
      firstTimestamp = r.firstTimestamp;
    }
    if (r.lastLine !== null) {
      lastLine = r.lastLine;
      lastTimestamp = r.lastTimestamp;
    }
  }
  return { pids, firstLine, firstTimestamp, lastLine, lastTimestamp, appLineCount, crashReports };
}
