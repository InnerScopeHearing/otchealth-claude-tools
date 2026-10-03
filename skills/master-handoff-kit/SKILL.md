---
name: master-handoff-kit
description: Builds the MASTER HANDOFF KIT, the complete starter kit that moves ONE agent's entire work (knowledge, context, content, memories, pointers to graphics) to a brand-new agent with no context on a different AI platform. One ZIP with a generated START-HERE README, the agent's full memory ledger (counts only for sensitive roles cfo, clo, clo-personal, capital), the Sunset handoff doc and agent definition, a names-only credential registry, snapshots of each repo's CLAUDE.md/AGENTS.md/HANDOFF.md/README.md read from origin/main, every session document not yet in the brain with relative paths preserved, a media index (graphics stay in the media library), and a sha256 MANIFEST that lists every file AND every excluded file with its reason. Every file passes brain-save's fail-closed secret and ring gates first; the zip is uploaded to Matt's OneDrive (CTO Incoming) and verified by listing. Use when Matt says to move, transfer, hand off or migrate an agent to another platform (Codex, ChatGPT, Hyperagent, Copilot, anything new), or to spin up a fresh agent that must be treated as having no memory. Verbs - build, verify, help. Non-PHI ring.
---

# master-handoff-kit

**Matt's words:** "creating that complete starter kit for transferring all knowledge, context, content,
graphics, and memories to another agent ... creating that ZIP file on the OneDrive folder with all of the
items necessary to MOVE a complete agent's work and memories and start up a NEW agent in a NEW and
different AI platform." The receiving agent is treated as brand new with NO context or memory.
**Gold standard: nothing lost, nothing secret leaked, everything findable.**

This is the cross-PLATFORM sibling of the Sunset Transfer Protocol (`skills/sunset-protocol`). Sunset
flushes an agent to the durable brain so another seat of the SAME fleet can attach. This kit packages
everything the new agent needs when it cannot attach to the fleet's tooling on day one (or at all).

## CLI

```
node skills/master-handoff-kit/kit.mjs build --agent <role> [--session-id <id>] [--scratch <dir>]
     [--repos <comma list of local repo paths>] [--repo-docs <repo:glob,repo:glob>] [--include <file-or-dir> ...]
     [--target-platform <name>] [--out <dir>] [--onedrive "CTO Incoming/<folder>"] [--dry-run] [--no-upload] [--cwd <dir>]
node skills/master-handoff-kit/kit.mjs verify <zip>
node skills/master-handoff-kit/kit.mjs help
```

- `--dry-run` runs EVERY gate and prints the counts (files per section, excluded files with reasons,
  withheld ledger entries). It writes no zip and uploads nothing.
- `--no-upload` builds the zip, re-extracts it and re-verifies it, but does not upload. Without
  `--onedrive` nothing is uploaded either.
- With `--onedrive "CTO Incoming/<folder>"`: creates the folder (`cto-onedrive mkdir`), uploads the ZIP plus
  `00-README-START-HERE.md` and `MANIFEST.md` beside it (app-media's resumable upload session, so a
  multi-megabyte zip works; the plain `deliver` PUT is capped at a few MB), then verifies by listing the
  folder (`cto-onedrive ls`) and comparing name and size. Prints the OneDrive path and the local zip path.
- `verify <zip>` extracts a zip, checks `manifest.json` (every listed file present with matching sha256 and
  size, no unlisted extra file) and re-runs the secret gate over EVERY file. Exit 0 PASS, 1 manifest
  problem, 2 a secret tripped (or the gate could not be armed).
- `--include` is repeatable; each file or directory becomes `01-...`, `02-...` in the order given.
- `--repo-docs repo:glob` adds files on top of the defaults (`CLAUDE.md AGENTS.md HANDOFF.md README.md`);
  `repo` is a name (or path) from `--repos`.
- Exit codes: 0 ok, 1 error, 2 refused (the live secret-value set could not be loaded, or verify found a leak).

## Gold-standard kit contents

The zip has one top folder, `<ROLE>-MASTER-HANDOFF-KIT-<YYYY-MM-DD>/`:

| Path | What it is |
|---|---|
| `00-README-START-HERE.md` | Generated orientation for a brand-new agent on ANY platform: reading order, what every file is, how to reach the gateway and the brain, a first-hour checklist, the two standing mandates (do all the work; continuous improvement) and the ground rules that survive any platform. Role specifics come from the agent definition and the handoff. |
| `01-...` .. `NN-...` | Core documents supplied with `--include`, first, in the order given. |
| `memories/<role>-ledger-full.jsonl` + `<role>-ledger.md` | The COMPLETE ledger export: every entry, all types, with ids, dates, type and text, plus the Latest Values and Corrections views. For SENSITIVE roles (`cfo`, `clo`, `clo-personal`, `capital`) only `<role>-ledger-COUNTS-ONLY.md`: counts, never text, mirroring the Sunset protocol's ring rule (the `clo-personal` ledger is read only from the `clo-personal` seat). Every entry also passes the secret and ring gates; a tripped entry keeps its id, date and type, loses its content, and is recorded in the manifest. |
| `handoff/` | `HANDOFF-<role>.md` (the commons `_HANDOFF/<role>.md` sunset doc, or one generated by `sunset-protocol`'s `renderHandoff` when none exists), `AGENT-DEFINITION-<role>.md` (`dream-team/agents/<role>.md`), and `DEVELOPER-PLAYBOOK.md` when role is `developer`. |
| `credentials/CREDENTIAL-REGISTRY-names-only.md` | From `vault-registry.mjs --dry --print`: which credentials exist, by service, ring and date. NAMES ONLY. The generator asserts it (secret gate, a strict row shape, no value-looking token) and refuses the whole file otherwise. |
| `repo-docs/<repo>/<path>` | Snapshots read with `git show origin/main:<path>` (never the working tree), the repo's CLAUDE.md, AGENTS.md, HANDOFF.md, README.md plus any `--repo-docs` globs. The commit sha is recorded in the manifest. |
| `session-files/<relative path>` | Every `.md`/`.html` document the session produced that is not yet in the brain (the Stop-hook discovery from `brain-save`: `findScratchpads`, `scanFolder`, `candidateRepos`, `unsavedFiles`), plus small allowlisted images already in the scratchpad. Relative paths under the scratchpad are preserved. |
| `media/MEDIA-INDEX.md` | The app-media catalog as an index: OneDrive and S3 location of every screenshot, video and graphic. The binaries are NOT in the kit; graphics stay in the media library and the index says where. |
| `MANIFEST.md` + `manifest.json` | Every file with source path, sha256 and bytes, plus every EXCLUDED file with its exact reason (secret, ring, too large, unreadable, unsupported type) and every withheld ledger entry. |
| `VERIFY.md` | Gate results: counts scanned, refused by the secret gate, refused by the ring gate, other exclusions, entries withheld, registry status. |

## Gates (mandatory, fail-closed, reused from brain-save, never re-implemented)

1. **Secret gate** (`brain-save/lib/secret-gate.mjs`): layer A credential shapes plus layer B the LIVE SSM
   secret values (loaded exactly as `brain-save` loads them, floor-checked). If the live set cannot be
   loaded the build is REFUSED (exit 2); there is no flag to skip it.
2. **Ring gate** (`brain-save/lib/ring-gate.mjs`): PHI, privileged, personal-legal, CFO ledgers and INND
   MNPI never enter the kit. A false positive is excluded and listed, never silently included.
3. **Binary allowlist**: only `.png .jpg .jpeg .gif .webp` under 2 MB (scanned for embedded credentials
   too). Video, audio, PDF and archives are excluded with the reason.
4. Excluded, withheld and refused items appear in `MANIFEST.md` with rule NAMES only. A secret VALUE is
   never printed, never logged, never written into any generated file.
5. The finished zip is re-extracted and re-verified before it is reported (and before upload).

## Typical use

```bash
# 1. look first (runs every gate, writes nothing)
node skills/master-handoff-kit/kit.mjs build --agent developer --session-id <session id> \
  --repos /home/user/otchealth-companion,/home/user/aware-aural-rehab,/home/user/iheartest,/home/user/otchealth-claude-tools \
  --target-platform Codex --dry-run
# 2. build for real and upload to Matt's OneDrive
node skills/master-handoff-kit/kit.mjs build --agent developer --session-id <session id> --repos ... \
  --target-platform Codex --onedrive "CTO Incoming/Developer Master Handoff Kit 2026-10-03"
# 3. prove any kit again later
node skills/master-handoff-kit/kit.mjs verify DEVELOPER-MASTER-HANDOFF-KIT-2026-10-03.zip
```

Credentials for the upload are the OneDrive delegated token the CFO/CTO OneDrive skills use
(`graph-onedrive-refresh-token` and the `graph-mail-*` app in SSM, resolved by `kvSecret`).
Run the build with the seat's AWS credentials so the ledger, commons handoff and media catalog can be read.

## Notes and limits

- The ledger is read from the same store `mem.mjs` writes (`_MEMORY/<role>.jsonl` through the commons-store
  facade, or the lane store for cfo/clo/exec), with the local write-through cache as a labeled fallback for
  non-sensitive roles. `mem.mjs` itself is a CLI with import-time side effects, so it is not imported.
- A session scan is capped at 5000 candidate documents and 150 MB of session files per kit; anything past
  a cap is listed as excluded, not dropped.
- The kit is a SNAPSHOT dated at build time. The README tells the new agent that the live ledger and brain
  win over the kit on any conflict.
- Non-PHI ring. Do not point it at MedReview or any PHI store.

## Tests

```
node --test skills/master-handoff-kit/tests/*.test.mjs
```

Covers layout naming, the sensitive-role counts-only rule, manifest exclusion recording, the secret gate
(a fake AWS key shape built at runtime so the repo carries no secret-shaped literal), relative-path
preservation, the binary allowlist, origin/main-only repo snapshots, zip and verify round trips, tamper
detection, and the OneDrive upload-and-verify flow with a fake uploader.
