// lib.mjs -- pure(ish) functions for the app-media library, kept dependency-free and network-free
// so they are unit-testable without touching OneDrive or S3. archive.mjs (the CLI) does all the IO
// and calls into this module for every decision that has a right answer independent of the network.
//
// See SKILL.md for the library's purpose and the CLI surface.

import { createHash } from "node:crypto";
import { extname } from "node:path";
import { readFileSync } from "node:fs";

// ---- kind validation --------------------------------------------------------------------------

export const VALID_KINDS = Object.freeze([
  "iphone-screenshots",
  "iphone-video",
  "web-screenshots",
  "web-video",
  "coverage-report",
  "marketing",
]);

/** Throws on any kind not in VALID_KINDS. Returns the kind unchanged when valid, so a caller can
 *  use this inline (`kind = validateKind(opts.kind)`). */
export function validateKind(kind) {
  if (!VALID_KINDS.includes(kind)) {
    throw new Error(`invalid --kind "${kind}" (expected one of: ${VALID_KINDS.join(", ")})`);
  }
  return kind;
}

// ---- file eligibility (what the walker takes vs skips) ----------------------------------------

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".heic"]);
const VIDEO_EXT = new Set([".mp4", ".mov", ".webm", ".m4v"]);
const REPORT_EXT = new Set([".json", ".md"]);

/** "image" | "video" | "report" | null (null = not something this library archives). */
export function classifyExtension(filename) {
  const ext = extname(String(filename)).toLowerCase();
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  if (REPORT_EXT.has(ext)) return "report";
  return null;
}

export function isTakeableFile(filename) {
  return classifyExtension(filename) !== null;
}

const CONTENT_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".m4v": "video/x-m4v",
  ".json": "application/json",
  ".md": "text/markdown",
};

export function contentTypeFor(filename) {
  const ext = extname(String(filename)).toLowerCase();
  return CONTENT_TYPES[ext] || "application/octet-stream";
}

// ---- destination path building -----------------------------------------------------------------
// Both destinations share one folder shape, "<app>/<version> (<build>)/<kind>/<filename>", just
// rooted differently: OneDrive under the human-facing "5-Media/App Screenshots and Videos", S3
// under the machine-facing "_APP-MEDIA" prefix in the commons store.

export const ONEDRIVE_MEDIA_ROOT = "5-Media/App Screenshots and Videos";
export const S3_MEDIA_PREFIX = "_APP-MEDIA";

export function versionFolderName(version, build) {
  return `${version} (${build})`;
}

/** {app, version, build, kind, filename} -> {oneDrivePath, s3Key, versionFolder}. Throws if kind is
 *  invalid or any required field is missing/empty, same fail-loud contract as validateKind. */
export function buildDestinations({ app, version, build, kind, filename }) {
  validateKind(kind);
  for (const [name, value] of [["app", app], ["version", version], ["build", build], ["filename", filename]]) {
    if (!value || typeof value !== "string" || !value.trim()) {
      throw new Error(`buildDestinations: missing/empty "${name}"`);
    }
  }
  const versionFolder = versionFolderName(version, build);
  const oneDrivePath = `${ONEDRIVE_MEDIA_ROOT}/${app}/${versionFolder}/${kind}/${filename}`;
  const s3Key = `${S3_MEDIA_PREFIX}/${app}/${versionFolder}/${kind}/${filename}`;
  return { oneDrivePath, s3Key, versionFolder };
}

// ---- sha256 idempotency -------------------------------------------------------------------------

export function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function sha256File(path) {
  return sha256Hex(readFileSync(path));
}

/** True when the catalog already holds an entry at this exact s3Key with this exact sha256 -- the
 *  signal that this file was already archived byte-for-byte and the upload should be skipped. A
 *  matching s3Key with a DIFFERENT sha256 (someone re-captured the same screenshot name with new
 *  content) is NOT a skip -- it is a legitimate re-archive that replaces the catalog entry. */
export function shouldSkipUpload(catalog, s3Key, sha256) {
  return Array.isArray(catalog) && catalog.some((e) => e && e.s3Key === s3Key && e.sha256 === sha256);
}

/** Insert or replace the catalog entry for entry.s3Key. Returns a NEW array (does not mutate the
 *  input), matching the fleet's usual pure-reducer style for catalog/ledger state. */
export function upsertCatalogEntry(catalog, entry) {
  const list = Array.isArray(catalog) ? catalog.slice() : [];
  const idx = list.findIndex((e) => e && e.s3Key === entry.s3Key);
  if (idx >= 0) list[idx] = entry;
  else list.push(entry);
  return list;
}

// ---- catalog grouping / summary / INDEX.md -------------------------------------------------------

/** app -> versionFolder -> kind -> entry[] */
export function groupCatalog(catalog) {
  const apps = {};
  for (const e of Array.isArray(catalog) ? catalog : []) {
    if (!e || !e.app) continue;
    const vf = e.versionFolder || versionFolderName(e.version, e.build);
    apps[e.app] ??= {};
    apps[e.app][vf] ??= {};
    apps[e.app][vf][e.kind] ??= [];
    apps[e.app][vf][e.kind].push(e);
  }
  return apps;
}

/** app -> versionFolder -> kind -> count, plus a totalFiles count. Used by `archive.mjs list`. */
export function summarizeCatalog(catalog) {
  const grouped = groupCatalog(catalog);
  const apps = {};
  for (const app of Object.keys(grouped).sort()) {
    apps[app] = {};
    for (const vf of Object.keys(grouped[app]).sort()) {
      apps[app][vf] = {};
      for (const kind of Object.keys(grouped[app][vf]).sort()) {
        apps[app][vf][kind] = grouped[app][vf][kind].length;
      }
    }
  }
  return { totalFiles: Array.isArray(catalog) ? catalog.length : 0, apps };
}

// En/em dashes are a hard published-copy rule fleet-wide (CLAUDE.md); a --source/--note string a
// human typed could carry one, so strip both at render time rather than trusting every caller.
function stripDashes(s) {
  return String(s).replace(/[–—]/g, "-");
}

/** Render the human-facing INDEX.md: grouped app > version(build) > kind, with counts and each
 *  file's source/note, plus the OneDrive folder path for every version group. Deterministic given
 *  the same catalog + generatedAt, so it is directly diffable in a test. */
export function renderIndexMarkdown(catalog, generatedAt = new Date().toISOString()) {
  const list = Array.isArray(catalog) ? catalog : [];
  const grouped = groupCatalog(list);
  const appNames = Object.keys(grouped).sort();
  const lines = [];
  lines.push("# App Media Library");
  lines.push("");
  lines.push(`Generated ${generatedAt}. ${list.length} file(s) across ${appNames.length} app(s).`);
  lines.push("");
  for (const app of appNames) {
    lines.push(`## ${app}`);
    lines.push("");
    const versionFolders = Object.keys(grouped[app]).sort();
    for (const vf of versionFolders) {
      lines.push(`### ${vf}`);
      lines.push("");
      lines.push(`OneDrive folder: ${ONEDRIVE_MEDIA_ROOT}/${app}/${vf}`);
      lines.push("");
      const kinds = Object.keys(grouped[app][vf]).sort();
      for (const kind of kinds) {
        const files = grouped[app][vf][kind];
        lines.push(`- **${kind}** (${files.length} file${files.length === 1 ? "" : "s"})`);
        for (const f of files.slice().sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0))) {
          const bits = [f.filename];
          if (f.source) bits.push(`source: ${f.source}`);
          if (f.note) bits.push(`note: ${f.note}`);
          lines.push(`  - ${bits.join(", ")}`);
        }
      }
      lines.push("");
    }
  }
  return stripDashes(lines.join("\n"));
}

// ---- xcresulttool manifest.json parsing + rename plan --------------------------------------------
// `xcrun xcresulttool export attachments` writes opaque exported filenames plus a manifest.json
// that maps each attachment to a human-readable suggested name. The shape assumed here (documented
// in the build brief): an ARRAY of test entries, each with an `attachments` ARRAY whose items carry
// `exportedFileName` and `suggestedHumanReadableName` (both strings). Any deviation from that shape
// is refused wholesale -- see parseXcresultManifest's contract below -- rather than partially
// trusted, because a manifest.json that is "almost" the expected shape is exactly the case where a
// silent partial rename would do the most damage (renaming some files off a guess and leaving
// others alone, with no clean way to tell which is which afterward).

/** Validate + flatten a parsed manifest.json. Returns {ok:true, items:[{exportedFileName,
 *  humanReadableName}]} on a fully-conformant manifest, or {ok:false, reason, found} the moment ANY
 *  entry/attachment fails to match the expected shape -- the caller must refuse to rename ANYTHING
 *  in that case (fail closed, not partially). `data` is the already-JSON.parsed manifest content. */
export function parseXcresultManifest(data) {
  if (!Array.isArray(data)) {
    return { ok: false, reason: "manifest root is not an array", found: typeof data };
  }
  const items = [];
  for (let i = 0; i < data.length; i++) {
    const entry = data[i];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, reason: `entry ${i} is not an object`, found: JSON.stringify(entry).slice(0, 120) };
    }
    const attachments = entry.attachments;
    if (!Array.isArray(attachments)) {
      return { ok: false, reason: `entry ${i} has no "attachments" array`, found: typeof attachments };
    }
    for (let j = 0; j < attachments.length; j++) {
      const a = attachments[j];
      if (
        !a ||
        typeof a !== "object" ||
        typeof a.exportedFileName !== "string" ||
        !a.exportedFileName ||
        typeof a.suggestedHumanReadableName !== "string" ||
        !a.suggestedHumanReadableName
      ) {
        return {
          ok: false,
          reason: `entry ${i} attachment ${j} is missing a non-empty "exportedFileName"/"suggestedHumanReadableName"`,
          found: JSON.stringify(a).slice(0, 120),
        };
      }
      items.push({ exportedFileName: a.exportedFileName, humanReadableName: a.suggestedHumanReadableName });
    }
  }
  return { ok: true, items };
}

/** Make a human-readable attachment name safe as a filename fragment: no slashes or colons (both
 *  illegal or dangerous across the filesystems this ever gets copied to), collapsed whitespace.
 *  Deliberately keeps everything else, including a leading numeric prefix like "001" -- the brief
 *  is explicit that the prefix stays, and Xcode's suggested names already carry it verbatim, so
 *  there is nothing to add here, only unsafe characters to remove. */
export function sanitizeHumanName(name) {
  return String(name)
    .replace(/[/\\:]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** items -> [{from: exportedFileName, to: safe renamed filename}], keeping each item's own
 *  extension (from its exportedFileName, which is what actually exists on disk) and de-duplicating
 *  any within-manifest name collision by appending " (2)", " (3)", ... rather than overwriting. */
export function buildRenamePlan(items) {
  const used = new Set();
  const plan = [];
  for (const it of items) {
    const ext = extname(it.exportedFileName);
    const base = sanitizeHumanName(it.humanReadableName);
    let candidate = `${base}${ext}`;
    let n = 2;
    while (used.has(candidate.toLowerCase())) {
      candidate = `${base} (${n})${ext}`;
      n++;
    }
    used.add(candidate.toLowerCase());
    plan.push({ from: it.exportedFileName, to: candidate });
  }
  return plan;
}
