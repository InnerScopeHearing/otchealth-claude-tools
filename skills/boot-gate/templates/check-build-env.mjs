#!/usr/bin/env node
/**
 * check-build-env.mjs — fails the build if a required VITE_* var is empty/missing.
 *
 * Vite inlines import.meta.env.VITE_* at BUILD time; an empty value compiles
 * cleanly and ships a dead app (PlantID build 1: VITE_API_BASE_URL=""). Run this
 * as a `prebuild` step AND as a CI step before the Depot archive, so an empty/
 * misconfigured secret fails on the runner, not on the user's phone.
 *
 * Wire: package.json (mobile) -> "prebuild": "node scripts/check-build-env.mjs"
 * Dependency-free.
 */

// Edit per app. Every var here must be non-empty for a release build.
const REQUIRED = [
  "VITE_API_BASE_URL", // the PlantID green-screen culprit
  // "VITE_REVENUECAT_KEY",
  // "VITE_SENTRY_DSN",
];

// Vars allowed to be empty in some envs — document WHY for each.
const ALLOWED_EMPTY = new Set([
  // "VITE_OPTIONAL_FLAG", // reason...
]);

// Vars whose value must parse as a URL.
const MUST_BE_URL = new Set(["VITE_API_BASE_URL"]);

const missing = REQUIRED.filter((k) => {
  if (ALLOWED_EMPTY.has(k)) return false;
  const v = process.env[k];
  return v === undefined || String(v).trim() === "";
});

if (missing.length) {
  console.error(
    `\n[build-env] BLOCKING BUILD. These VITE_* vars are empty/missing:\n` +
      missing.map((k) => `  - ${k}`).join("\n") +
      `\nVite bakes env at build time, so an empty value ships a broken app ` +
      `(see PlantID build 1).\n`,
  );
  process.exit(1);
}

for (const k of MUST_BE_URL) {
  const v = process.env[k];
  if (v && !ALLOWED_EMPTY.has(k)) {
    try {
      new URL(v);
    } catch {
      console.error(`[build-env] ${k} is not a valid URL: "${v}"`);
      process.exit(1);
    }
  }
}

console.log("[build-env] all required VITE_* present and well-formed.");
