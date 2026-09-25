#!/usr/bin/env node
// archive.mjs -- the app-media library's single write path.
//
// Every app screenshot / video the fleet captures (real-iPhone AWS Device Farm walkthroughs,
// Device Farm run videos, Playwright web renders) is archived through THIS script, to TWO places:
//   1. OneDrive (human-facing, Matt's drive):
//        5-Media/App Screenshots and Videos/<app>/<version> (<build>)/<kind>/<filename>
//   2. S3 (fleet-facing, the commons store otchealthcommons/company-journal):
//        _APP-MEDIA/<app>/<version> (<build>)/<kind>/<filename>
// plus a machine catalog (_APP-MEDIA/catalog.json) and a human-readable INDEX.md, both kept in
// sync on every archive run and mirrored to both destinations.
//
// Usage:
//   node archive.mjs add --app <app> --version <v> --build <b> --kind <kind>
//                     [--source "free text"] [--note "free text"] [--dry-run]
//                     <file-or-dir> [more...]
//   node archive.mjs list [--app <app>]
//   node archive.mjs rename-from-manifest <dir>
//
// See SKILL.md for the full contract. All decision logic (kind validation, destination paths,
// idempotency, INDEX.md rendering, the xcresulttool manifest rename plan) lives in lib.mjs, kept
// pure/network-free so it is unit-tested directly; this file is the IO shell around it.

import { readFileSync, existsSync, statSync, readdirSync, renameSync } from "node:fs";
import { join, basename } from "node:path";

import {
  validateKind,
  classifyExtension,
  contentTypeFor,
  buildDestinations,
  versionFolderName,
  sha256Hex,
  shouldSkipUpload,
  upsertCatalogEntry,
  renderIndexMarkdown,
  summarizeCatalog,
  parseXcresultManifest,
  buildRenamePlan,
  safeMediaFilename,
} from "./lib.mjs";
import { cGet, cPut, commonsConfigured } from "../kb-memory/commons-store.mjs";
import { getBufferFromS3 } from "../kb-memory/s3-blob.mjs";
import { uploadFileToOneDrive } from "./onedrive-upload.mjs";

const CATALOG_KEY = "_APP-MEDIA/catalog.json";
const INDEX_S3_KEY = "_APP-MEDIA/INDEX.md";
const INDEX_ONEDRIVE_PATH = "5-Media/App Screenshots and Videos/INDEX.md";
const COMMONS_ACCOUNT = "otchealthcommons";
const COMMONS_CONTAINER = "company-journal";

function parseArgs(argv) {
  const opts = { files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--app": opts.app = argv[++i]; break;
      case "--version": opts.version = argv[++i]; break;
      case "--build": opts.build = argv[++i]; break;
      case "--kind": opts.kind = argv[++i]; break;
      case "--source": opts.source = argv[++i]; break;
      case "--note": opts.note = argv[++i]; break;
      case "--dry-run": opts.dryRun = true; break;
      default: opts.files.push(a);
    }
  }
  return opts;
}

/** Recursively walk `paths` (files or directories). Returns {eligible: absPath[], skipped:
 *  {path, reason}[]}. Directories are walked in sorted order for deterministic output. */
function collectEligibleFiles(paths) {
  const eligible = [];
  const skipped = [];
  function visit(p) {
    if (!existsSync(p)) {
      skipped.push({ path: p, reason: "not found" });
      return;
    }
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const name of readdirSync(p).sort()) visit(join(p, name));
    } else if (st.isFile()) {
      if (classifyExtension(p)) eligible.push(p);
      else skipped.push({ path: p, reason: "unsupported extension" });
    }
  }
  for (const p of paths) visit(p);
  return { eligible, skipped };
}

async function loadCatalog() {
  const text = await cGet(CATALOG_KEY);
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    throw new Error(`app-media: ${CATALOG_KEY} in S3 is not valid JSON (${e.message}); refusing to overwrite it blindly`);
  }
}

async function cmdAdd(opts) {
  if (!opts.app || !opts.version || !opts.build || !opts.kind) {
    console.error("usage: add --app <app> --version <v> --build <b> --kind <kind> [--source s] [--note n] [--dry-run] <file-or-dir> [more...]");
    process.exit(2);
  }
  try {
    validateKind(opts.kind);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  if (opts.files.length === 0) {
    console.error("no files/directories given");
    process.exit(2);
  }

  const { eligible, skipped } = collectEligibleFiles(opts.files);
  for (const s of skipped) console.log(`  skip: ${s.path} (${s.reason})`);
  if (eligible.length === 0) {
    console.log("nothing eligible to archive.");
    return;
  }

  // Destination filenames are flattened to their basename (see SKILL.md); guard against two
  // different local files landing on the same destination filename within one run rather than
  // silently letting the second overwrite the first in the plan.
  const seenNames = new Map();
  const plan = [];
  for (const abs of eligible) {
    const filename = safeMediaFilename(basename(abs));
    if (seenNames.has(filename)) {
      console.log(`  skip: ${abs} (destination filename "${filename}" collides with ${seenNames.get(filename)} in this run)`);
      continue;
    }
    seenNames.set(filename, abs);
    const { oneDrivePath, s3Key } = buildDestinations({ app: opts.app, version: opts.version, build: opts.build, kind: opts.kind, filename });
    plan.push({ abs, filename, oneDrivePath, s3Key, contentType: contentTypeFor(filename) });
  }

  if (opts.dryRun) {
    console.log(`DRY RUN: app=${opts.app} version=${opts.version} build=${opts.build} kind=${opts.kind}, ${plan.length} file(s) to evaluate`);
    let catalog = [];
    try {
      catalog = await loadCatalog();
    } catch (e) {
      console.log(`  (could not read the live catalog for the skip preview: ${e.message})`);
    }
    for (const f of plan) {
      const buf = readFileSync(f.abs);
      const sha = sha256Hex(buf);
      const skip = shouldSkipUpload(catalog, f.s3Key, sha);
      console.log(`  ${skip ? "SKIP (already archived, same sha256)" : "UPLOAD"}: ${f.abs}  (${buf.length} bytes)`);
      console.log(`    -> OneDrive: ${f.oneDrivePath}`);
      console.log(`    -> S3:       ${f.s3Key}`);
    }
    console.log("dry run: nothing uploaded, catalog unchanged.");
    return;
  }

  if (!(await commonsConfigured())) {
    console.error("app-media: AWS credentials unavailable, cannot reach the S3 catalog. Aborting (no partial uploads).");
    process.exit(1);
  }

  let catalog = await loadCatalog();
  let uploaded = 0;
  let skippedIdempotent = 0;
  let skippedEmpty = 0;
  let verifiedOne = false;
  let failed = 0;
  let catalogChanged = false;

  for (const f of plan) {
    const buf = readFileSync(f.abs);
    if (buf.length === 0) {
      console.log(`  skip: ${f.abs} (empty file, 0 bytes)`);
      skippedEmpty++;
      continue;
    }
    const sha = sha256Hex(buf);
    if (shouldSkipUpload(catalog, f.s3Key, sha)) {
      console.log(`  already archived (same sha256), skipping: ${f.abs}`);
      skippedIdempotent++;
      continue;
    }

    let odItem;
    try {
      odItem = await uploadFileToOneDrive(f.oneDrivePath, buf, f.contentType);
      await cPut(f.s3Key, buf, f.contentType);
    } catch (e) {
      // One bad file must not abandon the rest of a 200-file run; it is
      // reported, left out of the catalog, and the run exits non-zero.
      console.error(`  FAILED: ${f.abs}: ${String(e.message).slice(0, 240)}`);
      failed++;
      continue;
    }

    // Verify at least one file per run round-trips byte-identically. Every S3 PUT succeeding (2xx)
    // is already strong evidence, but a real GET-and-compare against the live object catches a
    // class of failure a status code alone cannot (e.g. a proxy/CDN silently truncating or
    // re-encoding the body between here and the bucket).
    if (!verifiedOne) {
      const back = await getBufferFromS3(COMMONS_ACCOUNT, COMMONS_CONTAINER, f.s3Key);
      if (!back || sha256Hex(back) !== sha) {
        throw new Error(`app-media: S3 round-trip verification FAILED for ${f.s3Key} (the object read back does not match what was uploaded)`);
      }
      console.log(`  verified byte-identical S3 round trip: ${f.s3Key}`);
      verifiedOne = true;
    }

    const entry = {
      app: opts.app,
      version: opts.version,
      build: opts.build,
      kind: opts.kind,
      filename: f.filename,
      sha256: sha,
      bytes: buf.length,
      contentType: f.contentType,
      source: opts.source || null,
      note: opts.note || null,
      capturedAt: statSync(f.abs).mtime.toISOString(),
      archivedAt: new Date().toISOString(),
      onedrivePath: f.oneDrivePath,
      s3Key: f.s3Key,
      versionFolder: versionFolderName(opts.version, opts.build),
    };
    catalog = upsertCatalogEntry(catalog, entry);
    catalogChanged = true;
    uploaded++;
    // Checkpoint the catalog during long runs (a walkthrough is ~200 files),
    // so a failure partway leaves every uploaded file already catalogued.
    if (uploaded % 25 === 0) await cPut(CATALOG_KEY, JSON.stringify(catalog, null, 2), "application/json");
    console.log(`  archived: ${f.abs} (${buf.length} bytes)  onedrive id=${odItem.id || "?"}`);
  }

  if (catalogChanged) {
    await cPut(CATALOG_KEY, JSON.stringify(catalog, null, 2), "application/json");
    const indexMd = renderIndexMarkdown(catalog);
    await cPut(INDEX_S3_KEY, indexMd, "text/markdown");
    await uploadFileToOneDrive(INDEX_ONEDRIVE_PATH, Buffer.from(indexMd, "utf8"), "text/markdown");
    console.log(`catalog updated (${catalog.length} total entries). INDEX.md refreshed in S3 and OneDrive.`);
  }

  console.log(
    `\nsummary: ${uploaded} uploaded, ${skippedIdempotent} already-archived (skipped), ${skippedEmpty} empty (skipped), ${skipped.length} not-media (skipped), ${failed} failed`
  );
  if (failed > 0) process.exitCode = 1;
}

async function cmdList(opts) {
  const catalog = await loadCatalog();
  const filtered = opts.app ? catalog.filter((e) => e && e.app === opts.app) : catalog;
  console.log(JSON.stringify(summarizeCatalog(filtered), null, 2));
}

function cmdRenameFromManifest(dir) {
  if (!dir) {
    console.error("usage: rename-from-manifest <dir>");
    process.exit(2);
  }
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) {
    console.error(`no manifest.json in ${dir}`);
    process.exit(1);
  }
  let data;
  try {
    data = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    console.error(`manifest.json is not valid JSON: ${e.message}`);
    process.exit(1);
  }
  const parsed = parseXcresultManifest(data);
  if (!parsed.ok) {
    console.error(`refusing to rename: manifest.json does not match the expected xcresulttool shape (${parsed.reason}; found: ${parsed.found})`);
    process.exit(1);
  }
  const plan = buildRenamePlan(parsed.items);
  let renamed = 0;
  let missing = 0;
  for (const { from, to } of plan) {
    const src = join(dir, from);
    if (!existsSync(src)) {
      console.error(`  MISSING (skipped): ${from}`);
      missing++;
      continue;
    }
    renameSync(src, join(dir, to));
    console.log(`  ${from} -> ${to}`);
    renamed++;
  }
  console.log(`renamed ${renamed}/${plan.length} file(s)${missing ? `, ${missing} referenced in manifest.json but missing on disk` : ""}`);
  process.exit(missing > 0 ? 1 : 0);
}

function usage() {
  console.error("usage: archive.mjs add --app <A> --version <V> --build <B> --kind <kind> [--source s] [--note n] [--dry-run] <file-or-dir>...");
  console.error("       archive.mjs list [--app <A>]");
  console.error("       archive.mjs rename-from-manifest <dir>");
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "add") {
  await cmdAdd(parseArgs(rest));
} else if (cmd === "list") {
  await cmdList(parseArgs(rest));
} else if (cmd === "rename-from-manifest") {
  cmdRenameFromManifest(rest[0]);
} else {
  usage();
  process.exit(2);
}
