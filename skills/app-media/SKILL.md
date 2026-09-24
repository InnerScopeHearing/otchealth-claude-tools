---
name: app-media
description: The single write path for every app screenshot and video the fleet captures (real-iPhone AWS Device Farm walkthroughs, Device Farm run videos, Playwright web renders). Archives each file to BOTH Matt's OneDrive (human-facing, "5-Media/App Screenshots and Videos/<app>/<version> (<build>)/<kind>/<filename>") and the fleet's S3 commons store (machine-facing, "_APP-MEDIA/<app>/<version> (<build>)/<kind>/<filename>"), keeps a durable JSON catalog + a rendered INDEX.md in sync at both destinations, and is idempotent by sha256 so a re-run never re-uploads an unchanged file. Also renames Xcode's opaque `xcresulttool export attachments` output using its manifest.json's suggestedHumanReadableName. Use whenever an app-review, Device Farm, or Playwright walkthrough produces screenshots or videos Matt should be able to find later for a presentation. Wielded by the CTO / App Lead agents. Non-PHI ring.
---

# app-media

Every app screenshot and video the fleet captures should end up here, permanently, organized, and
findable in a future session, not left in an ephemeral scratchpad directory. This skill is the ONE
write path: run it once per capture batch and both Matt's OneDrive and the fleet's S3 catalog stay
in sync.

## Where files land

Both destinations share the same folder shape, just rooted differently:

| Destination | Root | Full path |
|---|---|---|
| OneDrive (human-facing) | `5-Media/App Screenshots and Videos` | `5-Media/App Screenshots and Videos/<app>/<version> (<build>)/<kind>/<filename>` |
| S3 (fleet-facing, commons store) | `_APP-MEDIA` | `_APP-MEDIA/<app>/<version> (<build>)/<kind>/<filename>` |

`<kind>` is one of `iphone-screenshots`, `iphone-video`, `web-screenshots`, `web-video`,
`coverage-report`, `marketing`. Anything else is rejected.

A machine catalog (`_APP-MEDIA/catalog.json`, in S3) and a rendered `INDEX.md` (both in S3 at
`_APP-MEDIA/INDEX.md` and in OneDrive at `5-Media/App Screenshots and Videos/INDEX.md`) are kept in
sync on every run that actually archives something.

## CLI

```
node skills/app-media/archive.mjs add \
  --app <AWARE|iHEARtest|...> --version <1.4.0> --build <1779565789> --kind <kind> \
  [--source "free text, e.g. \"Device Farm run e3567aee\""] [--note "free text"] [--dry-run] \
  <file-or-dir> [more...]
```

- Directories are walked recursively. Only images (`.png .jpg .jpeg .webp .heic`), videos
  (`.mp4 .mov .webm .m4v`) and reports (`.json .md`) are taken; everything else is skipped and
  listed, never silently dropped.
- Destination filenames are flattened to their basename. If two different local files in one run
  would land on the same destination filename, the second is skipped with a warning rather than
  silently overwriting the plan for the first.
- Idempotent by content: before uploading, the file's sha256 is checked against the live catalog
  entry at that exact destination. Same sha256 at the same destination -> skipped, nothing
  re-uploaded. Same destination but different sha256 -> re-archived (the catalog entry is replaced,
  not duplicated).
- `--dry-run` prints the full upload/skip plan and touches neither OneDrive nor S3.
- At least one file per run is verified with an explicit S3 GET-and-compare (byte-identical sha256)
  after upload, not just trusted from the PUT's 2xx status.

```
node skills/app-media/archive.mjs list [--app <app>]
```

Prints a JSON summary of the live catalog (from S3): total file count, then app -> version(build)
-> kind -> count.

```
node skills/app-media/archive.mjs rename-from-manifest <dir>
```

Xcode's `xcrun xcresulttool export attachments --path Result.xcresult --output-path <dir>` writes
opaque filenames plus a `manifest.json` mapping each attachment to a
`suggestedHumanReadableName` (e.g. `"001 Today, first launch"`). This command renames every file in
`<dir>` in place to its human-readable name (kept as-is, including any numeric prefix; only illegal
filesystem characters are stripped and whitespace is collapsed), so a `add` run over that directory
produces a self-explanatory OneDrive/S3 listing instead of a folder of opaque hashes. If
`manifest.json` does not match the expected xcresulttool shape (an array of test entries, each with
an `attachments` array of `{exportedFileName, suggestedHumanReadableName}`), it refuses to rename
ANYTHING and exits non-zero, printing what it actually found -- a manifest that is "almost" the
right shape is exactly the case where a partial rename would do the most damage.

## Under the hood

- **OneDrive**: `onedrive-upload.mjs` is a small, self-contained Microsoft Graph client using a
  resumable upload session (chunked, 10 MiB fragments) for every file regardless of size, so files
  well over Graph's 4 MiB simple-upload ceiling (Device Farm run videos, typically ~30 MB) upload
  reliably. It is NOT built on top of `skills/cfo-onedrive/onedrive.mjs`'s `upload` command (that
  does a single small PUT and exports no functions to import); auth reuses the same delegated
  refresh-token credential (`graph-onedrive-refresh-token`) and app registration
  (`graph-mail-client-id/-secret/-tenant-id`) that skill already depends on.
- **S3**: `skills/kb-memory/commons-store.mjs` (the `otchealthcommons/company-journal` facade) for
  the catalog and INDEX.md, and `skills/kb-memory/s3-blob.mjs` directly for binary media (its
  `getBufferFromS3` is what makes the byte-identical round-trip verification possible; the text-only
  facade functions would corrupt binary content on read-back).
- **lib.mjs** holds every pure decision (kind validation, destination-path building, sha256
  idempotency, catalog grouping/summary, INDEX.md rendering, xcresulttool manifest parsing and the
  rename plan) with zero network or filesystem writes, so it is directly unit-tested; `archive.mjs`
  is the IO shell around it.

## Rules

- Never print or persist a secret value.
- INDEX.md is human-facing: no em dashes or en dashes (`renderIndexMarkdown` strips any that sneak
  in from a `--source`/`--note` string, but write clean copy in the first place).
- Never deletes or moves an existing OneDrive or S3 object; a re-archive of changed content lands
  as a new object at the same path (OneDrive) / overwrite (S3), and the catalog entry is updated,
  not appended as a duplicate.
