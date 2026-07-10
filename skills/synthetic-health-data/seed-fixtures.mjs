#!/usr/bin/env node
// synthetic-health-data / seed-fixtures.mjs — generate the fleet's CANONICAL synthetic dev/test
// fixture bundle in one command. This is the "default to gen.mjs output" convention made concrete:
// every app's dev/test data comes from here, at a FIXED seed, so fixtures are reproducible and
// identical across machines, CI runs, and agents. Nothing here reads or touches real PHI.
//
// Usage:
//   node seed-fixtures.mjs                      # writes fixtures/synthetic/ at the default seed
//   node seed-fixtures.mjs --out path/to/dir    # custom output dir
//   node seed-fixtures.mjs --seed 7             # different (still reproducible) seed
//   node seed-fixtures.mjs --csv                # also emit CSV alongside JSON
//
// Output is a bundle + a manifest.json recording seed, counts, and a content hash per file so a
// drift-check ("are my fixtures the canonical ones?") is a diff, not a guess.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const GEN = join(HERE, "gen.mjs");

const argv = process.argv.slice(2);
function takeVal(flag, dflt) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}
const OUT_DIR = takeVal("--out", join(HERE, "fixtures", "synthetic"));
const SEED = takeVal("--seed", "42");
const ALSO_CSV = argv.includes("--csv");

// The canonical bundle: shape -> record count. Counts are enough to exercise pagination,
// distributions, and empty/edge states without being slow. Adjust here to reshape the fleet default.
const BUNDLE = [
  { shape: "hearing-screening", count: 200 },
  { shape: "patient", count: 100 },
  { shape: "customer", count: 300 },
  { shape: "order", count: 200 },
];

function genOne(shape, count, asCsv) {
  const ext = asCsv ? "csv" : "json";
  const outFile = join(OUT_DIR, `${shape}.${ext}`);
  const args = [GEN, shape, "--count", String(count), "--seed", String(SEED), "--out", outFile];
  if (asCsv) args.push("--csv");
  const r = spawnSync(process.execPath, args, { encoding: "utf8" });
  if (r.status !== 0) {
    console.error(`FAILED generating ${shape}:`, r.stderr || r.stdout);
    process.exit(1);
  }
  const bytes = readFileSync(outFile);
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  return { shape, count, file: outFile, ext, sha256_16: hash, bytes: bytes.length };
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const files = [];
  for (const { shape, count } of BUNDLE) {
    files.push(genOne(shape, count, false));
    if (ALSO_CSV) files.push(genOne(shape, count, true));
  }
  const manifest = {
    generator: "synthetic-health-data/gen.mjs",
    seed: SEED,
    generated_note: "100% fabricated data, zero real PHI. Reproducible: same seed -> identical output.",
    bundle: files,
  };
  const manifestPath = join(OUT_DIR, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.error(`Wrote ${files.length} fixture file(s) + manifest to ${OUT_DIR} (seed ${SEED}).`);
  for (const f of files) console.error(`  ${f.shape}.${f.ext}  ${f.count} rows  sha256:${f.sha256_16}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

export { BUNDLE, genOne };
