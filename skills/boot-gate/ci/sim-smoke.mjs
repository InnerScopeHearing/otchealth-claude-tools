#!/usr/bin/env node
/**
 * sim-smoke.mjs — pass/fail the iOS Simulator boot smoke from the screenshot
 * (+ optional log). Hard-fails if the launched app screen is mostly one flat
 * color (stuck/blank splash — the PlantID green screen scores ~0.99) or if the
 * app log shows a crash. Exit 0 = boot looks healthy.
 *
 *   node sim-smoke.mjs <screenshot.png> [app-log.txt]
 *
 * Uses pngjs if available (CI macOS images have it via Playwright or installable);
 * if absent it degrades to a size/sanity check rather than failing the build for a
 * missing dependency. Install with: npm i -D pngjs (or vendor it).
 */
import { readFileSync, existsSync, statSync } from "node:fs";

const FLAT_FAIL = 0.92; // >92% one color = stuck/blank
const shot = process.argv[2];
const logPath = process.argv[3];

if (!shot || !existsSync(shot)) {
  console.error(`[sim-smoke] screenshot not found: ${shot}`);
  process.exit(1);
}

// 1) Crash check (best-effort): a crash/fatal/signal line in the app log fails.
if (logPath && existsSync(logPath)) {
  const log = readFileSync(logPath, "utf8");
  const crash = log.split("\n").find((l) => /\b(crash|fatal error|signal (sigabrt|sigsegv|sigtrap)|exception)\b/i.test(l));
  if (crash) {
    console.error(`[sim-smoke] FAIL: crash signature in app log:\n  ${crash.trim().slice(0, 200)}`);
    process.exit(1);
  }
}

// 2) Flat-color check: the app must have painted a real screen, not a stuck splash.
let PNG;
try {
  ({ PNG } = await import("pngjs"));
} catch {
  // Dependency-free fallback: a real rendered screen is a non-trivial PNG.
  const bytes = statSync(shot).size;
  if (bytes < 20_000) {
    console.error(`[sim-smoke] FAIL: screenshot is only ${bytes} bytes (likely blank).`);
    process.exit(1);
  }
  console.log(`[sim-smoke] pngjs absent; size sanity ok (${bytes} bytes). Install pngjs for the flat-color gate.`);
  process.exit(0);
}

const png = PNG.sync.read(readFileSync(shot));
const counts = new Map();
for (let i = 0; i < png.data.length; i += 4) {
  const key =
    ((png.data[i] >> 3) << 10) | ((png.data[i + 1] >> 3) << 5) | (png.data[i + 2] >> 3);
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
const total = png.data.length / 4;
const frac = Math.max(...counts.values()) / total;
const pct = (frac * 100).toFixed(1);

if (frac > FLAT_FAIL) {
  console.error(
    `[sim-smoke] FAIL: boot screen is ${pct}% a single flat color — the app booted ` +
      `but never rendered its UI (stuck splash / green/white screen). This is the ` +
      `PlantID failure mode.`,
  );
  process.exit(1);
}
console.log(`[sim-smoke] PASS: boot screen rendered real content (dominant color ${pct}% < ${FLAT_FAIL * 100}%).`);
process.exit(0);
