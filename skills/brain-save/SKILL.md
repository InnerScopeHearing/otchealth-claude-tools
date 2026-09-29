---
name: brain-save
description: THE write path for company knowledge (Matt directive 2026-09-29) -- save a research report, design doc, spec, audit, review packet, build or deploy receipt, runbook, decision, postmortem, or the HTML/Markdown source of a published Artifact into the company brain AND prove it is searchable. One command, `node /tmp/octools/skills/brain-save/brain-save.mjs put <file-or-folder> --kind <kind> --app <app>`, normalizes the file (md/txt/html/json), stamps a provenance header, runs a fail-closed secret gate (credential shapes + the live SSM secret values) and ring gate (PHI, attorney-client / personal-legal, CFO ledgers, INND MNPI never reach the open commons room), writes the S3 commons under _KNOWLEDGE/, chunks + embeds + pushes into the commons-company-journal OpenSearch room itself, and proves retrieval with a real search (room + gateway kb_search). Only exit 0 means saved. "Uploaded to S3" is NOT "in the brain" -- the nightly commons push is off. Also verify, list --check, audit --secrets, retract, backfill, doctor. Use whenever you finish research, a build/deploy receipt, a review packet, a runbook, or publish an Artifact, and as a workflow's final step. Non-PHI ring only.
---

# brain-save -- every document goes into the brain, proven searchable

**Directive (Matt, 2026-09-29):** all research and any other documents, artifacts or markdown files
from research, build and deploy work are saved in the brain and searchable, so the tokens spent
making them are reusable by every agent later.

## The one command

```bash
node /tmp/octools/skills/brain-save/brain-save.mjs put <file-or-folder> \
  --kind <research|design|spec|audit|review|packet|build|deploy|receipt|runbook|artifact|report|decision|doc|auto> \
  --app <app-slug|auto> [--title "..."] [--artifact-url <claude.ai url>] [--tags a,b] [--json]
```

- A file inside a git repo gets its source (`repo@sha[+dirty]:path`) and `--app` (via
  `config/apps.json`) automatically. Anything else needs `--app` (use `fleet` for cross-fleet work).
- Folders recurse (skipping `.git`, `node_modules`, nested git work trees, and `.brain-save-ignore`
  globs). Supported: `.md .markdown .txt .html .htm .json`.
- `--dry-run` runs every gate and prints the plan: zero writes, zero embedding calls.
- `--title` and `--id` name ONE document: with more than one file they are exit 1 (drop them so each file
  keeps its own H1, or put each file separately).
- `--store-only` keeps the raw bytes (e.g. 50 HTML mockups) under `_KNOWLEDGE-META/src/` without
  embedding them; `backfill` then writes ONE searchable collection-index doc per group.

## Exit codes (a workflow must treat every non-zero code as "not done")

| Code | Meaning |
|---|---|
| 0 | saved and verified, or unchanged (identical content already live AND re-proven searchable just now), or an alias (identical content saved under another id, re-proven) |
| 1 | error: bad input (empty / under 16 VISIBLE characters of text (zero-width and other format characters do not count), binary, NUL bytes, UTF-16, not UTF-8, over 30% base64), file over 20 MB (50 MB with `--store-only`; checked before reading), generic title (pass `--title`), > 400,000 chars (split it), an identity collision (below), `--title`/`--id` with several files, nothing stored (the first S3 write failed), dependency down or timed out before anything was stored |
| 2 | REFUSED by the secret or ring gate: nothing was written anywhere and nothing was embedded |
| 3 | stored but NOT searchable. Either the proof RAN and missed (a clean miss: its chunks were removed) or it COULD NOT RUN (a search / gateway error on the final attempt: "stored + pushed, proof could not run", its chunks are LEFT in place because nothing proved them not searchable). A re-run of the same `put` retries and verifies |
| 4 | saved and verified, but superseding the previous version, or retiring an orphaned failed attempt, is incomplete (`audit --repair`) |
| 5 | `--store-only`: the raw source is stored and NOTHING was embedded. "Stored, NOT searchable by request": not a failure of the tool, but not "in the brain's search" either, so it is never exit 0 (a `backfill` treats its own `include: store-only` entries as expected) |
| 6 | stored and room-verified, but the GATEWAY proof was attempted (`kb_search` on mcp.otchealth.app as the `coo` lane) and did not pass (error, or a clean miss remembered across retries turns into exit 3): not proven searchable through the path every lane uses. `--gateway off` is the explicit opt-out; a gateway that was never attempted (no lane token) stays a warning under `auto` |

## Document identity (what a re-save replaces)

A document's identity decides whether a save is a NEW document or the next VERSION of one (which
supersedes the previous version: it leaves search and moves to `_ARCHIVE/`). Precedence:

1. `--id <stable-id>`: the id.
2. a git source (`repo:path`, commit dropped) or `--source`: the source.
3. `--artifact-url`: the URL.
4. otherwise a TITLE identity: `<kind>/<app>/<title slug>`.

Title identities collide: two different files with the same H1 share one. So, for a title identity
(adjudication round 3, when build receipts 57 and 58 silently replaced each other):
- a live version is replaced only by the SAME file (its local brain-save receipt names this identity) or
  with an explicit `--supersedes <brain_id>` / `--id`. Otherwise the save is **exit 1, nothing saved**,
  with the fix printed: `--supersedes <brain_id>` for a newer version of that document, a distinct title
  (H1 or `--title`) or an `--id` for a different document;
- one batch holding two files with DIFFERENT content under one identity: both are exit 1 (the rest of
  the batch still saves);
- the same local file re-saved under a new H1 (a retitle) supersedes the brain_id that file was last
  saved as, so the old draft does not stay searchable next to it. A file that was only an ALIAS of
  another document (same body) never supersedes that document.

Receipts live in `~/.claude/brain-save/receipts.jsonl` (per seat): from another seat, use `--supersedes`.

## Seats (who may write the open room)

- **clo-personal never writes commons**: `--agent clo-personal` or `KB_AGENT=clo-personal` is exit 2,
  not overridable. Its route is `legal_blob_put` container `personal` on the clo-personal lane.
- **cfo, clo, capital** keep work product in their own ring stores; a document from those seats saves to
  commons only with `--share` (the same acknowledgment `mem.mjs --share` asks for), meaning "this document
  is non-privileged and safe for every lane to read". Both the `--agent` flag AND the process seat
  (`KB_AGENT` / `~/.claude/.kb-agent`) are checked; either one being a gated seat applies.
- The Stop-hook reminder is silent for those four seats.

## What "proven searchable" means

After the push and one index refresh, the tool searches the live room:
1. a keyword query on the object's `key_ref` (sha1 of its storage key: a 40-hex token unique to this
   stored KEY, even when two identities save the same body; objects saved before key_ref fall back to the
   body's 64-hex `content_sha256`; never `brain_id`, which every version shares, nor the 8-hex key suffix,
   which is unindexable when it ends in a-f) must return it at **rank 1**, and a hybrid (BM25 + kNN)
   query on its **title** must return it in the **top 10**;
2. the gateway (`mcp.otchealth.app`) `kb_search` on a minted **coo** lane token (the least-privileged
   internal lane that reads commons) must find it. No lane token (never attempted) -> warning only; a
   gateway ERROR (attempted, did not pass) -> exit 6 with the room proof kept; token but no hit -> exit 3 (a
   clean miss is remembered: a later transport error on another query cannot turn it back into an error).
   With `--gateway on` the gateway proof is REQUIRED: skipped or error is exit 3. `--gateway off` opts out.

A room proof that hits an exception (a 503, a timeout) is retried inside its retry loop. If the FINAL
attempt could not run, that is "stored + pushed, proof could not run": exit 3 with the chunks KEPT (only a
proven clean miss deletes them).

An identical re-put ("unchanged" / "alias") is re-proven every time (keyword-only, zero writes, zero
embedding calls) AND its S3 object must exist. If the live version fell out of the room or its object is
gone, it is re-pushed with the object recreated and reported `saved`; if the brain cannot be checked,
exit 3 and no local receipt. An HTML page's `<title>` is kept searchable (a trailing `Page title:` line)
when the body does not already say it.

## Deadlines

Every S3 / OpenSearch / embedding / gateway / token-mint call races a per-call timeout
(`BRAIN_SAVE_CALL_TIMEOUT_MS`, default 30000) and a `put` has an overall budget (`BRAIN_SAVE_DEADLINE_MS`,
default 15 min); the SSM secret-set load has its own (`BRAIN_SAVE_SSM_TIMEOUT_MS`, default 90000, a
timeout there is the usual exit-2 "secret set unavailable"). A timeout before anything is stored is exit 1;
after the object is stored it is exit 3. A timed-out gateway call ends the gateway proof (no retries into a
black hole), and the CLI exits as soon as its output has flushed.
A `--title` correction of the same file, or a `--tags` change, with an unchanged body is a new version. So
is an `--app` correction (the key embeds the app, so the document is re-keyed and re-pushed) and a changed
source IDENTITY (`repo:path` or URL: a new commit sha alone is not a change). An ALIAS (identical content
already live under another identity) records THIS document's identity in its own registry entry
(`alias_of` / `alias_key`, title, app, tags, source); if that record cannot be written the save is exit 1.

The nightly job (`otchealth-job-daily-digest`) catalogs commons objects but does NOT push them
(`SKIP_PUSH_SEARCH=1`; the allow-listed push `COMMONS_PUSH_PREFIXES=_KNOWLEDGE/,_DAILY/` is a gated
arming step), so a raw S3 upload is never searchable. brain-save does not depend on the nightly job.
**Arming the nightly commons push takes BOTH: remove `SKIP_PUSH_SEARCH` from the task definition AND set
`COMMONS_PUSH_PREFIXES=_KNOWLEDGE/,_DAILY/`; either alone leaves it off** (the job logs which one is still
holding it). Once armed, the push runs the commons CONTENT GATE on every row before it is embedded
(`skills/doc-indexer/commons-push-gate.mjs`: the same secret layers A+B and ring gate as `put`/`audit`, plus
brain-save provenance for `_KNOWLEDGE/`); a blocked row is skipped, logged by path and rule name only, and
makes the run exit non-zero. If the live secret set cannot be loaded the WHOLE push is refused (exit 2). A
failed push makes the nightly job exit non-zero at the END, after its other steps ran. `--prefixes` may only
name `_KNOWLEDGE/` and `_DAILY/` (`COMMONS_PUSH_ALLOWED_PREFIXES` in `push-rules.mjs`); anything else is exit 2.

## Rings (hard)

`commons-company-journal` is readable by **every** gateway lane, including external ChatGPT /
Perplexity connectors. The bar for "safe to save" is "safe for an external connector to read".

| Signal | Kind | Route printed on refusal |
|---|---|---|
| a secret shape or a live SSM secret VALUE | hard | remove the value; reference the SSM parameter NAME `/otchealth/<name>` |
| `--ring` other than commons; a declaration (front matter in any YAML form: scalar, flow list/map, `- item` list, next-line or block scalar, nested key; HTML `<meta name=classification/confidentiality/ring>`; a JSON key at ANY depth, arrays and array roots included, except under rule contexts such as a charter's `classifier`) whose `ring/classification/confidentiality/sensitivity/privilege/audience` value is NOT on the explicit safe allowlist (commons, public, internal, internal-only/use, general, fleet, all, everyone, team, engineering, developers, unclassified, low, normal, standard, none, no, false, n/a, 0, off; an `audience` that is an http(s) URL is an OAuth/JWT audience, not a ring): so `ring: exec`, `sensitivity: high`, `audience: cfo only`, `confidentiality: confidential` all refuse. Or a truthy `contains_phi/phi/hipaa/mnpi/privileged` flag. A value that starts with a negation ("non-PHI (...)") ignores its own family's words | hard | per ring |
| denylisted path/repo/Artifact (`config/ring-denylist.json`: medreview (repo and path segment), legal-personal, CFO folders, `_MEMORY/_HANDOFF/_DISPATCH/_JOURNAL`, moore-playbook, two CFO Artifacts), matched case-insensitively with every `-_ .` separator removed and a file's extension ignored; finance/legal entries also match inside a segment (`finance-cfo-source-docs/`, `legal-personal.md`); on the symlink-resolved path too; the repo is parsed out of `repo@sha:path`, `repo:path`, GitHub https URLs and `git@host:org/repo.git` | hard | per ring |
| a standalone privilege / PHI / MNPI banner line (separators: hyphen, any Unicode dash, colon, pipe, comma, slash, period, semicolon, repeated like `//`; tails such as DRAFT, COMMUNICATION, FOR COUNSEL REVIEW; a leading CONFIDENTIAL - / DRAFT -; also inside an HTML comment); "ATTORNEY-CLIENT COMMUNICATION", "PROTECTED HEALTH INFORMATION", "NOT FOR DISTRIBUTION: MNPI"; a bare PRIVILEGED / PHI line only when shouted or bold and not a Markdown heading | hard | CLO / BAA / CLO |
| PHI data: SSNs (`SSN`, `SS#`, `Social:`, table cells), DOB (numeric, ISO, "March 3rd, 1962", "3 March 1962", `Born:`), MRN (with a digit), MBI, payment cards, bank account/routing numbers | hard | BAA environment / CFO |
| (html/json) the same banner / PHI / heuristic checks over the RAW input too: `<script>`, comments, every JSON field | as above | as above |
| entity (OTCHealth / OTC Health / InnerScope / INND / Hearing Assist, any spelling) + 3 accounting terms + 20 amounts (`$`, `1,234.56`, bare `1234.56`, JSON Debit/Credit/Amount fields) (finance ledger) | heuristic | CFO seat: `cfo-store put` |
| INND x2 + 3 securities-deal terms (INND_SECURITIES); a paragraph naming INND with 2 corporate-event terms (8-K, definitive agreement, LOI, merger/acquisition, earnings, guidance, embargo) AND a not-yet-public marker (a draft filing, embargoed, an earnings preview, "will be filed", "not yet announced") (INND_EVENT); source repo `innd-website`, also from `--source` (INND_IR_SOURCE) | heuristic, overridable ONLY from the clo / capital / exec seat | CLO + counsel + Matt |
| 3+ personal family-law terms (superior court, family law, custody, dissolution, spousal/child support, a "X v. Y" caption) (PERSONAL_LEGAL) | heuristic | CLO-personal seat |
| ring VOCABULARY in prose (MNPI, PHI, privileged, Reg FD) | warning only | (recorded in the header) |

A heuristic false positive can pass with `--ring-override "<CODE>: <why>"`: the reason must NAME every
overridden signal code (e.g. `INND_SECURITIES: wording copied from the public 8-K press release`) and
explain itself in at least 20 characters besides the codes (audited in the header, with the seat, and
under `_KNOWLEDGE-META/audit/overrides/`); hard signals are never overridable. An INND code
(INND_SECURITIES, INND_EVENT, INND_IR_SOURCE) is overridable only when the SEAT (`KB_AGENT` /
`~/.claude/.kb-agent`, not the `--agent` flag) is clo, capital or exec; everyone else gets the refusal and
the route. **Never work around a
refusal with a raw S3 write.** Privileged / MNPI work product goes to its own ring store instead:
CFO `cfo-store put`; CLO `legal_blob_put` (`personal` only from the clo-personal seat); PHI stays in
the MedReview BAA environment.

Secret gate rule (CTO Library lesson, 2026-09-01): gate on LABELED values and KNOWN secret prefixes,
never on identifier shapes. Labels include `token`, `secret`, `auth token`, `private key`, env lines whose
name says secret (`*SECRET*`, `*TOKEN*`, `*PASSWORD*`, `*_KEY`: `STRIPE_KEY=`, `DD_APP_KEY=`),
`**Secret key:**`-style markdown, a space-padded table cell (`| Client Secret | <v> |`), prose ("the API
token is <v>"), JSON `"privateKey"`, `<meta name="api-key" content=...>`, `Authorization: Basic / ApiKey /
Token / Bearer`, `curl -u user:pass`, connection strings (an empty user too), and passwords from 8
characters when they look random. Known prefixes include OpenAI/Anthropic, GitHub, Stripe, Slack, AWS,
Google, PostHog `phx_`, ElevenLabs `sk_`, Tavily, Perplexity, Sentry, Netlify, Hugging Face, GitLab,
Google OAuth `ya29.`, Notion `ntn_`, Groq, Datadog `ddpat_`, `wsec_`, PEM / PGP / PuTTY private keys.
Placeholders (`<...>`, `${...}`, "example", "fake", "xxxx") are judged on the captured VALUE only. An SSM
parameter NAME, `secretref:`, `NAME:latest`, a file reference, a regex literal or an env var NAME next to a
label is a reference, not a value. Publishable identifiers pass: PostHog `phc_`, RevenueCat `appl_`/`goog_`,
Stripe `pk_`, Sentry DSNs, gateway OAuth client ids `oc_`/`occ_`, ASC key/issuer/team ids, AWS account
ids. Layer B scans for the live `/otchealth/*` SecureString VALUES (plus secret-named env vars and
`~/.designer/credentials.env`), in memory only: letters-only secrets of 20+ chars count, values over 512
chars (refresh tokens, certificates) are matched by 48-char sliding shingles so a partial leak is caught,
and `*cert*`/`*secret*`/`*token*`/`*database-url*` names are never treated as public ids. Layer B also
searches a NORMALIZED copy of every text (NFKC, zero-width / soft-hyphen / BOM / bidi characters removed,
`\x` escapes reduced, percent-encoding decoded), a whitespace-SQUASHED copy (a value split across lines),
hex values case-insensitively, and decoded `Authorization: Basic` / `curl -u` credentials. Public
identifiers are never needles: the Twilio Verify service SID, the Xero tenant map, the scheduler
`job-guard/` / `schedule-backups/` snapshots, subnet / security-group / VPC ids, Twilio VA/MG SIDs, and
UUIDs (unless the parameter name says it is a credential). If SSM cannot
be enumerated, or returns fewer than 100 SecureStrings / 100 needles, the tool REFUSES (exit 2). Every
option value that is persisted (`--id`, `--supersedes`, `--ring-override`, `--source`, tags) is scanned
too. A refusal prints only the layer, pattern or parameter NAME, and line number, never the value.

## Storage layout

```
_KNOWLEDGE/<kind>/<app>/<yyyy-mm-dd>-<slug>-<sha8>.md   searchable doc (provenance header + normalized body)
_KNOWLEDGE-META/src/...                                  raw originals for html/json/txt (never indexed)
_KNOWLEDGE-META/registry/<brain_id>.json                 version chain for one document identity
_KNOWLEDGE-META/by-hash/<content_sha256>.json            identical-content alias
_KNOWLEDGE-META/audit/overrides/<date>/...               --ring-override records
_ARCHIVE/_KNOWLEDGE/...                                  superseded / retracted versions (never indexed)
```

Keys are immutable (the `<sha8>` is the body hash). Re-saving the same repo path / Artifact URL /
`--id` with changed content creates v2, verifies it, THEN removes v1's chunks and archives it; the
registry keeps the chain. A failed earlier attempt (exit 3) is retired to `_ARCHIVE/` (status `abandoned`) as soon as a newer
version of the same identity verifies, and `audit` flags/repairs any that slipped through. Chunks are byte-identical to what the nightly indexer would build
(`skills/doc-indexer/chunking.mjs`, 2000/200), so a nightly push converges instead of duplicating.

## Other commands

```bash
brain-save verify "<query>" [--expect <brain_id|key>] [--top 10]     # prove a doc is findable (exit 3 if not)
brain-save list [--kind k] [--app a] [--since YYYY-MM-DD] [--details] [--check]   # --check flags DARK docs
brain-save audit [--secrets] [--ring] [--searchable] [--repair]      # re-gate everything stored (layer C proof) + drift
#   (--repair implies BOTH content gates and NEVER repairs an object with a secret or ring finding: no re-push,
#   no adopt, no restore from _ARCHIVE/ or its chunks; it is reported as "repair BLOCKED"). --keys must be
#   strict stored keys (`..` and odd shapes are exit 1):
#   dark, stale-chunks, orphan-object, extra-live, unregistered-live (searchable but not the registry's live
#   version: --repair retires it, or adopts it when nothing else is live), live-missing (registry live_key
#   whose S3 object is gone: --repair restores it from _ARCHIVE/ or rebuilds it from its chunks, sha256-verified)
brain-save retract <brain_id|key> --reason "<why>"                   # incident path: out of search, archived
brain-save backfill <manifest.json> [--dry-run] [--include review] [--repos-root /home/user] [--no-fetch]
brain-save doctor                                                    # preflight every dependency, no writes kept
```

## Workflows

Subagent task prompts that produce documents end with: "Write deliverables as .md/.html under
<dir>. Never include a secret value (name the SSM parameter). Keep privileged, finance-ledger, INND
MNPI and PHI content out; if the task needs it, say so and stop. The orchestrator saves the folder to
the brain." The orchestrator's LAST step:

```bash
node /tmp/octools/skills/brain-save/brain-save.mjs put "<deliverables dir>" --kind <kind|auto> --app <app> \
  --tags "<workflow-id>" --json > "<deliverables dir>/.brain-save.json"
rc=$?; [ "$rc" -eq 0 ] || { echo "brain-save exit $rc: deliverables are NOT all in the brain"; exit "$rc"; }
```

A Stop hook (`hooks/unsaved-reminder.mjs`, installed user-scope by `setup/install-octools-hook.mjs`)
prints one quiet, non-blocking reminder when this session's scratchpad or changed repo files contain
`.md`/`.html` docs with no brain-save receipt. `BRAIN_SAVE_REMINDER=0` silences it.

## Pitfalls

- **Same title, different documents**: without `--id` or a source, the title IS the identity. Give each
  document a specific H1; the tool refuses (exit 1) rather than let one replace another.
- **A crash mid-save** leaves a pending (stored-unverified) registry entry written BEFORE any chunk
  exists; the next verified version retires it, and `audit --repair` finds any that slipped through.

- **S3 is not the brain.** The nightly commons push is off; only a verified push is searchable.
- **`push-search --prefix` used to push the WHOLE catalog.** Since 2026-09-29 `--prefix`/`--prefixes`
  scope the push (`skills/doc-indexer/push-rules.mjs`), but never run an unscoped commons push: the
  catalog holds `_JOURNAL/` session digests and older ring-sensitive research.
- **An unscoped commons push-search is refused by `indexer.mjs` itself** (2026-09-29): ALL of `_JOURNAL/`
  and `_VAULT/` joined `_MEMORY/ _HANDOFF/ _DISPATCH/` in SKIP_PREFIXES (round 4 dropped the per-lane list),
  the skip check normalizes and case-folds the path (`/_MEMORY/x`, `_memory//x`, `_KNOWLEDGE/../_MEMORY/x`
  are all skipped), and the aws-dr-canary's `commons-ring-residue` check pages (LEAK) on any chunk under
  those prefixes in the open room (a case-insensitive prefix query; an ok `_count` reply without a numeric
  count is an ERROR, never 0); `node skills/doc-indexer/purge-ring-residue.mjs [--commit]` removes them.
  Documented limit: a prefix query does not match `//`, leading-`/` or `./` spellings of a room path.
- **Folder puts never follow symlinks** (each one is reported); put a symlink's target explicitly.
- **Retraction filtering does not cover commons docs** (gateway retractions are memory-ledger ids);
  a stale doc stays searchable until `retract` or a superseding save removes its chunks.
- Seats with no AWS credentials (Codex on Windows, ChatGPT, Hyperagent) cannot run the tool yet:
  commit the document to a repo `docs/`/`runbooks/`/`research/` tree and ask a Claude Code seat to save it.
