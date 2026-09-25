// fsio.mjs -- small filesystem/network IO helpers shared by walkthrough.mjs. No npm dependencies:
// zip extraction shells out to the `unzip` CLI (present in every environment this skill runs in --
// the Depot macOS build workflows already depend on it, and it ships on the Linux agent sandbox),
// which is far less risk than hand-rolling a zip central-directory parser for a one-shot need.
import { createWriteStream, mkdirSync, readdirSync, copyFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, basename } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Streams a URL to `destPath`. Memory-flat regardless of size (a real run's syslog artifacts run
 *  500MB+); never buffers the whole response. */
export async function downloadTo(url, destPath) {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    const text = await res.text?.().catch(() => "") ?? "";
    throw new Error(`download failed (${res.status}) ${url.slice(0, 120)}...: ${text.slice(0, 200)}`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath));
  return destPath;
}

export function unzip(zipPath, destDir) {
  ensureDir(destDir);
  execFileSync("unzip", ["-q", "-o", zipPath, "-d", destDir]);
  return destDir;
}

/** Recursively lists every regular file under `dir` (absolute paths), depth-first, sorted. */
export function walkFiles(dir) {
  const out = [];
  function visit(d) {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) visit(p);
      else if (st.isFile()) out.push(p);
    }
  }
  visit(dir);
  return out;
}

/** First file under `dir` whose basename matches `re`, or null. */
export function findFirst(dir, re) {
  for (const p of walkFiles(dir)) {
    if (re.test(basename(p))) return p;
  }
  return null;
}

export function copyInto(srcPath, destDir, destName) {
  ensureDir(destDir);
  const dest = join(destDir, destName || basename(srcPath));
  copyFileSync(srcPath, dest);
  return dest;
}
