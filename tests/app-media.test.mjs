// Tests for skills/app-media/lib.mjs and the rename-from-manifest CLI path.
//
// Covers, per the build brief: kind validation, destination path building, sha256 idempotency
// decision, INDEX.md generation from a sample catalog, and rename-from-manifest on a temp dir with
// a fake manifest (including the malformed-manifest refusal). No network, no OneDrive/S3 calls --
// lib.mjs is deliberately network-free so all of this runs offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  VALID_KINDS,
  validateKind,
  classifyExtension,
  isTakeableFile,
  contentTypeFor,
  buildDestinations,
  versionFolderName,
  sha256Hex,
  shouldSkipUpload,
  upsertCatalogEntry,
  groupCatalog,
  summarizeCatalog,
  renderIndexMarkdown,
  parseXcresultManifest,
  sanitizeHumanName,
  buildRenamePlan,
} from "../skills/app-media/lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const ARCHIVE_CLI = join(ROOT, "skills", "app-media", "archive.mjs");

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ---- kind validation -----------------------------------------------------------------------------

test("VALID_KINDS lists exactly the six documented kinds", () => {
  assert.deepEqual(
    [...VALID_KINDS].sort(),
    ["coverage-report", "iphone-screenshots", "iphone-video", "marketing", "web-screenshots", "web-video"].sort()
  );
});

for (const kind of VALID_KINDS) {
  test(`validateKind accepts "${kind}"`, () => {
    assert.equal(validateKind(kind), kind);
  });
}

test("validateKind rejects an unknown kind", () => {
  assert.throws(() => validateKind("android-screenshots"), /invalid --kind/);
});

test("validateKind rejects empty/undefined", () => {
  assert.throws(() => validateKind(""), /invalid --kind/);
  assert.throws(() => validateKind(undefined), /invalid --kind/);
});

test("classifyExtension / isTakeableFile: images, videos, reports are takeable; other extensions are not", () => {
  for (const f of ["a.png", "a.JPG", "a.jpeg", "a.webp", "a.heic"]) assert.equal(classifyExtension(f), "image", f);
  for (const f of ["a.mp4", "a.MOV", "a.webm", "a.m4v"]) assert.equal(classifyExtension(f), "video", f);
  for (const f of ["a.json", "a.MD"]) assert.equal(classifyExtension(f), "report", f);
  for (const f of ["a.txt", "a.zip", "a.DS_Store", "a"]) {
    assert.equal(classifyExtension(f), null, f);
    assert.equal(isTakeableFile(f), false, f);
  }
  assert.equal(isTakeableFile("a.png"), true);
});

test("contentTypeFor returns a sane mime type per extension and a safe default otherwise", () => {
  assert.equal(contentTypeFor("a.png"), "image/png");
  assert.equal(contentTypeFor("a.mp4"), "video/mp4");
  assert.equal(contentTypeFor("a.json"), "application/json");
  assert.equal(contentTypeFor("a.md"), "text/markdown");
  assert.equal(contentTypeFor("a.bin"), "application/octet-stream");
});

// ---- destination path building --------------------------------------------------------------------

test("versionFolderName formats as \"<version> (<build>)\"", () => {
  assert.equal(versionFolderName("1.4.0", "1779565789"), "1.4.0 (1779565789)");
});

test("buildDestinations builds the exact documented OneDrive and S3 paths", () => {
  const { oneDrivePath, s3Key, versionFolder } = buildDestinations({
    app: "AWARE",
    version: "1.4.0",
    build: "1779565789",
    kind: "web-screenshots",
    filename: "activity-list-two.png",
  });
  assert.equal(versionFolder, "1.4.0 (1779565789)");
  assert.equal(oneDrivePath, "5-Media/App Screenshots and Videos/AWARE/1.4.0 (1779565789)/web-screenshots/activity-list-two.png");
  assert.equal(s3Key, "_APP-MEDIA/AWARE/1.4.0 (1779565789)/web-screenshots/activity-list-two.png");
});

test("buildDestinations rejects an invalid kind before building any path", () => {
  assert.throws(
    () => buildDestinations({ app: "AWARE", version: "1.0", build: "1", kind: "nope", filename: "f.png" }),
    /invalid --kind/
  );
});

test("buildDestinations rejects a missing required field", () => {
  assert.throws(() => buildDestinations({ version: "1.0", build: "1", kind: "marketing", filename: "f.png" }), /app/);
  assert.throws(() => buildDestinations({ app: "A", version: "1.0", build: "1", kind: "marketing", filename: "" }), /filename/);
});

// ---- sha256 idempotency decision ------------------------------------------------------------------

test("sha256Hex is deterministic and content-sensitive", () => {
  const a = sha256Hex(Buffer.from("hello"));
  const b = sha256Hex(Buffer.from("hello"));
  const c = sha256Hex(Buffer.from("hello!"));
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 64);
});

test("shouldSkipUpload: true only when the SAME s3Key has the SAME sha256 already in the catalog", () => {
  const sha = sha256Hex(Buffer.from("content-a"));
  const catalog = [{ s3Key: "_APP-MEDIA/X/1.0 (1)/marketing/f.png", sha256: sha }];

  assert.equal(shouldSkipUpload(catalog, "_APP-MEDIA/X/1.0 (1)/marketing/f.png", sha), true, "identical destination + hash -> skip");
  assert.equal(
    shouldSkipUpload(catalog, "_APP-MEDIA/X/1.0 (1)/marketing/f.png", sha256Hex(Buffer.from("content-b"))),
    false,
    "same destination, different content -> re-archive, not skip"
  );
  assert.equal(shouldSkipUpload(catalog, "_APP-MEDIA/X/1.0 (1)/marketing/other.png", sha), false, "different destination -> not a skip");
  assert.equal(shouldSkipUpload([], "_APP-MEDIA/X/1.0 (1)/marketing/f.png", sha), false, "empty catalog -> never a skip");
  assert.equal(shouldSkipUpload(undefined, "k", sha), false, "non-array catalog -> false, never throws");
});

test("upsertCatalogEntry replaces an existing entry at the same s3Key instead of duplicating it", () => {
  const first = { s3Key: "k1", sha256: "aaa", bytes: 1 };
  const second = { s3Key: "k1", sha256: "bbb", bytes: 2 };
  const other = { s3Key: "k2", sha256: "ccc", bytes: 3 };
  let catalog = upsertCatalogEntry([], first);
  catalog = upsertCatalogEntry(catalog, other);
  catalog = upsertCatalogEntry(catalog, second);
  assert.equal(catalog.length, 2);
  assert.deepEqual(
    catalog.find((e) => e.s3Key === "k1"),
    second
  );
  // pure: does not mutate the input array
  const before = [{ s3Key: "k1", sha256: "aaa" }];
  const after = upsertCatalogEntry(before, { s3Key: "k1", sha256: "zzz" });
  assert.equal(before[0].sha256, "aaa");
  assert.notEqual(before, after);
});

// ---- INDEX.md generation from a sample catalog ------------------------------------------------------

const SAMPLE_CATALOG = [
  {
    app: "AWARE",
    version: "1.4.0",
    build: "1779565789",
    versionFolder: "1.4.0 (1779565789)",
    kind: "web-screenshots",
    filename: "activity-list-two.png",
    source: "Playwright WebKit render of the real PUBLIC payload",
    note: null,
  },
  {
    app: "AWARE",
    version: "1.4.0",
    build: "1779565789",
    versionFolder: "1.4.0 (1779565789)",
    kind: "web-screenshots",
    filename: "activity-list-one.png",
    source: null,
    note: null,
  },
  {
    app: "AWARE",
    version: "1.4.0",
    build: "1779565789",
    versionFolder: "1.4.0 (1779565789)",
    kind: "iphone-video",
    filename: "run.mp4",
    source: "Device Farm run e3567aee",
    note: "20 min fuzz, clean",
  },
  {
    app: "iHEARtest",
    version: "1.6.0",
    build: "60",
    versionFolder: "1.6.0 (60)",
    kind: "iphone-screenshots",
    filename: "today.png",
    source: null,
    note: null,
  },
];

test("groupCatalog nests app -> versionFolder -> kind -> entries", () => {
  const g = groupCatalog(SAMPLE_CATALOG);
  assert.deepEqual(Object.keys(g).sort(), ["AWARE", "iHEARtest"]);
  assert.equal(g.AWARE["1.4.0 (1779565789)"]["web-screenshots"].length, 2);
  assert.equal(g.AWARE["1.4.0 (1779565789)"]["iphone-video"].length, 1);
  assert.equal(g.iHEARtest["1.6.0 (60)"]["iphone-screenshots"].length, 1);
});

test("summarizeCatalog reports counts, not the full entries, plus a total", () => {
  const s = summarizeCatalog(SAMPLE_CATALOG);
  assert.equal(s.totalFiles, 4);
  assert.equal(s.apps.AWARE["1.4.0 (1779565789)"]["web-screenshots"], 2);
  assert.equal(s.apps.AWARE["1.4.0 (1779565789)"]["iphone-video"], 1);
  assert.equal(s.apps.iHEARtest["1.6.0 (60)"]["iphone-screenshots"], 1);
});

test("renderIndexMarkdown groups by app > version(build) > kind, shows counts, sources, and the OneDrive path", () => {
  const md = renderIndexMarkdown(SAMPLE_CATALOG, "2026-09-24T00:00:00.000Z");
  assert.match(md, /^# App Media Library/);
  assert.match(md, /Generated 2026-09-24T00:00:00\.000Z\. 4 file\(s\) across 2 app\(s\)\./);
  assert.match(md, /## AWARE/);
  assert.match(md, /## iHEARtest/);
  assert.match(md, /### 1\.4\.0 \(1779565789\)/);
  assert.match(md, /OneDrive folder: 5-Media\/App Screenshots and Videos\/AWARE\/1\.4\.0 \(1779565789\)/);
  assert.match(md, /- \*\*web-screenshots\*\* \(2 files\)/);
  assert.match(md, /- \*\*iphone-video\*\* \(1 file\)/);
  assert.match(md, /activity-list-two\.png, source: Playwright WebKit render of the real PUBLIC payload/);
  assert.match(md, /run\.mp4, source: Device Farm run e3567aee, note: 20 min fuzz, clean/);
  // a file with no source/note renders its filename alone, no dangling ", source:"
  assert.match(md, /- activity-list-one\.png$/m);
});

test("renderIndexMarkdown is deterministic for the same catalog + generatedAt", () => {
  const a = renderIndexMarkdown(SAMPLE_CATALOG, "2026-01-01T00:00:00.000Z");
  const b = renderIndexMarkdown(SAMPLE_CATALOG, "2026-01-01T00:00:00.000Z");
  assert.equal(a, b);
});

test("renderIndexMarkdown never contains an em dash or en dash, even if a note carries one", () => {
  const dashy = [{ ...SAMPLE_CATALOG[0], note: "before – after — done" }];
  const md = renderIndexMarkdown(dashy);
  assert.equal(/[–—]/.test(md), false);
  assert.match(md, /before - after - done/);
});

test("renderIndexMarkdown handles an empty catalog without throwing", () => {
  const md = renderIndexMarkdown([]);
  assert.match(md, /0 file\(s\) across 0 app\(s\)/);
});

// ---- rename-from-manifest: parsing + plan ------------------------------------------------------------

test("parseXcresultManifest accepts the documented shape", () => {
  const manifest = [
    {
      testIdentifier: "AwareUITests/testToday",
      attachments: [
        { exportedFileName: "1_abc123.png", suggestedHumanReadableName: "001 Today, first launch" },
        { exportedFileName: "2_def456.png", suggestedHumanReadableName: "002 Today, tap start" },
      ],
    },
  ];
  const r = parseXcresultManifest(manifest);
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 2);
  assert.deepEqual(r.items[0], { exportedFileName: "1_abc123.png", humanReadableName: "001 Today, first launch" });
});

test("parseXcresultManifest refuses a non-array root", () => {
  const r = parseXcresultManifest({ not: "an array" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not an array/);
});

test("parseXcresultManifest refuses an entry with no attachments array", () => {
  const r = parseXcresultManifest([{ testIdentifier: "x" }]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /attachments/);
});

test("parseXcresultManifest refuses an attachment missing suggestedHumanReadableName", () => {
  const r = parseXcresultManifest([{ attachments: [{ exportedFileName: "a.png" }] }]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /exportedFileName.*suggestedHumanReadableName/);
});

test("sanitizeHumanName strips slashes/colons, collapses whitespace, keeps the leading numeric prefix", () => {
  assert.equal(sanitizeHumanName("001 Today, first launch"), "001 Today, first launch");
  assert.equal(sanitizeHumanName("Path/with:bad chars"), "Path-with-bad chars");
  assert.equal(sanitizeHumanName("  double   spaced  "), "double spaced");
});

test("buildRenamePlan keeps the original extension and de-duplicates a name collision", () => {
  const items = [
    { exportedFileName: "1_a.png", humanReadableName: "001 Today" },
    { exportedFileName: "2_b.PNG", humanReadableName: "001 Today" }, // same human name, different source file
  ];
  const plan = buildRenamePlan(items);
  assert.deepEqual(plan[0], { from: "1_a.png", to: "001 Today.png" });
  assert.deepEqual(plan[1], { from: "2_b.PNG", to: "001 Today (2).PNG" });
});

// ---- rename-from-manifest CLI, exercised end to end on a real temp dir --------------------------------

function runCli(args, cwd) {
  try {
    const out = execFileSync("node", [ARCHIVE_CLI, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, stdout: out, stderr: "" };
  } catch (e) {
    return { status: e.status ?? 1, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" };
  }
}

test("rename-from-manifest renames real files on disk to their human-readable names", () => {
  const dir = tmpDir("app-media-rename-ok-");
  writeFileSync(join(dir, "1_abc.png"), Buffer.from([1, 2, 3]));
  writeFileSync(join(dir, "2_def.png"), Buffer.from([4, 5, 6]));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify([
      {
        attachments: [
          { exportedFileName: "1_abc.png", suggestedHumanReadableName: "001 Today, first launch" },
          { exportedFileName: "2_def.png", suggestedHumanReadableName: "002 Today, tap start" },
        ],
      },
    ])
  );

  const r = runCli(["rename-from-manifest", dir]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(join(dir, "001 Today, first launch.png")), true);
  assert.equal(existsSync(join(dir, "002 Today, tap start.png")), true);
  assert.equal(existsSync(join(dir, "1_abc.png")), false);
  assert.equal(readFileSync(join(dir, "001 Today, first launch.png")).equals(Buffer.from([1, 2, 3])), true);
});

test("rename-from-manifest refuses to rename ANYTHING when manifest.json has the wrong shape", () => {
  const dir = tmpDir("app-media-rename-bad-");
  writeFileSync(join(dir, "1_abc.png"), Buffer.from([9]));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ this: "is not the expected array shape" }));

  const r = runCli(["rename-from-manifest", dir]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refusing to rename/);
  // nothing renamed: the original file is untouched
  assert.deepEqual(readdirSync(dir).sort(), ["1_abc.png", "manifest.json"]);
});

test("rename-from-manifest reports a referenced-but-missing file without crashing, and still renames the rest", () => {
  const dir = tmpDir("app-media-rename-missing-");
  writeFileSync(join(dir, "1_abc.png"), Buffer.from([7]));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify([
      {
        attachments: [
          { exportedFileName: "1_abc.png", suggestedHumanReadableName: "001 Present" },
          { exportedFileName: "9_missing.png", suggestedHumanReadableName: "009 Missing" },
        ],
      },
    ])
  );

  const r = runCli(["rename-from-manifest", dir]);
  assert.equal(r.status, 1, "missing referenced file -> non-zero, but not a shape refusal");
  assert.match(r.stderr, /MISSING/);
  assert.equal(existsSync(join(dir, "001 Present.png")), true);
});

test("rename-from-manifest errors cleanly with no manifest.json present", () => {
  const dir = tmpDir("app-media-rename-nomanifest-");
  const r = runCli(["rename-from-manifest", dir]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no manifest\.json/);
});
