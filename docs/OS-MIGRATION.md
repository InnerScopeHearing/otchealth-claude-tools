# OTCHealth AI OS — Migration & Reconciliation

## What this is
The **OTCHealth AI OS** is a dedicated Azure AI Foundry agent:

- **Account:** `otchealth-foundry` (eastus)
- **Project:** `otchealth-os`
- **Model:** `gpt-5.4`
- **Grounding:** 13 Azure AI Search indexes on service `otchealth-dataroom-search` (eastus) —
  `memory-exec`, `finance-cfo-source-docs`, `finance-cfo-memory`, `legal-company`, `legal-personal`,
  `legal-personal-memory`, `commons-company-journal`, `commons-coo-memory`, `commons-cro-memory`,
  `commons-cpo-memory`, `commons-cco-memory`, `commons-developer-memory`, `cs-knowledge`.

It is the **unified, company-wide brain**: every agent's shared exec feed, private ledger, and
data-room corpus is being consolidated so the fleet draws from and feeds ONE compounding source of
truth, rather than each session/agent holding its own disconnected context. This is the same
"Billion Dollar Shared Super-Brain" described in `dream-team/SUPER-BRAIN-PROTOCOL.md`, now backed
by a first-class Foundry agent that federates all 13 indexes into one cited answer surface.

**Everything is consolidating into the brain.** Legacy per-app/per-agent memory silos are being
migrated so their durable knowledge is discoverable by the whole company through the OS, not just
by the agent that originally wrote it.

## Why this matters for a new session
A Claude Code session that starts without reconciling into the OS is working from a stale or
partial view of company knowledge, and anything it learns stays trapped in its own chat window
(disposable) instead of the shared ledger (durable, source of truth). Reconcile early in the
session, not just at the end.

## The 8-step reconciliation process
Run this once per session, right after `session-start.sh` (or whenever this notice reminds you).
All steps are fail-open — a missing credential or unreachable service should be logged and skipped,
never block your actual work.

1. **Identify yourself.** Set `KB_AGENT` to your role/app id (`cfo`, `clo`, `coo`, `cco`, `cro`,
   `cpo`, `developer`, or an app name) so every write is attributable.
2. **Check freshness.** `bash /tmp/octools/setup/octools-version.sh` — if STALE, refresh before
   trusting any skill result from this session.
3. **Draw from the brain first.** Before researching or asserting anything, ask what the company
   already knows:
   - `node ~/.claude/skills/company-brain/brain.mjs ask "<question>" --rooms memory,journal`
   - `node ~/.claude/skills/kb-memory/semantic.mjs recall "<question>"`
   - `node ~/.claude/skills/kb-memory/mem.mjs team`
4. **Reconcile local/session knowledge into the ledger.** Any durable fact, decision, correction,
   or pitfall this session has already produced (or is about to act on) gets written through to the
   shared ledger, not left only in this chat transcript:
   - `node ~/.claude/skills/kb-memory/mem.mjs remember "<fact>" --agent $KB_AGENT`
   - `node ~/.claude/skills/kb-memory/mem.mjs decision "<decision + why>" --agent $KB_AGENT`
   - `node ~/.claude/skills/kb-memory/mem.mjs correct "<correction>" --agent $KB_AGENT`
   - `node ~/.claude/skills/kb-memory/mem.mjs pitfall "<trap + fix>" --agent $KB_AGENT`
5. **Publish status.** `node ~/.claude/skills/kb-memory/mem.mjs status "<what I'm doing now>" --agent $KB_AGENT`
   so the live company picture reflects this session.
6. **Share what's safe to share.** Add `--share` to any NON-sensitive, cross-team-useful entry so it
   reaches the shared exec feed and, on the next `brain-reindex` pass (6h cadence), the OS itself.
   Respect the rings: PHI/MedReview never leaves its system; INND/securities (MNPI) stays
   internal-only and is never `--share`d; the `clo-personal` lane is never shared.
7. **Verify connectivity.** Confirm this session's agent lane can reach the fleet gateway (see
   `runbooks/agent-gateway-connectivity.md` if present, or `skills/gateway-connect/`) so future
   writes and recalls actually land — a disconnected lane silently reconciles nothing.
8. **Save the protocol.** Record that this session followed the migration process so it survives
   context compaction:
   `node ~/.claude/skills/kb-memory/mem.mjs decision "Reconciled session knowledge into the OTCHealth AI OS per docs/OS-MIGRATION.md (identify -> freshness check -> draw -> reconcile -> status -> share -> verify connectivity -> save)." --agent $KB_AGENT --share`

## Reference doc
The canonical, longer-form version of this process lives in the global doc **"OTCHealth AI OS —
Session Migration & Reconciliation Prompt."** This file is the in-repo mirror so it travels with
every checkout and every `session-start.sh` run, even offline from the docs store.

## Related
- `dream-team/SUPER-BRAIN-PROTOCOL.md` — the paste-ready fleet protocol this process implements.
- `dream-team/MEMORY-SOP.md` — the deeper kb-memory how-to (verbs, rings, recall).
- `skills/company-brain/SKILL.md` — federated `ask` across all 13 Search rooms.
- `skills/ring-memory-index/SKILL.md` — per-agent private-ledger semantic recall.
- `skills/doc-indexer/job/README.md` — the librarian/deep-pass jobs that keep the OS's indexes current.
