# Capgo Adoption Protocol (fleet standard)

Standard, reusable protocol for taking a fleet app from "we built our own" to
"battle-tested Capgo where it is at parity or better, our uniqueness reskinned
on top." Established 2026-07-21 (Matt directive). Run it app by app:
**iHEARtest first, then FourVault / Flatstick, then the rest.**

## Why
Capgo's Capacitor plugins, CLI, Observe, Skills, updater (OTA), and white-label
stack are more battle-tested than the primitive/custom code an AI agent tends to
hand-roll. When Capgo has a comparable capability, **default to Capgo** even at
parity: fewer edge-case bugs, real maintenance, a community. We get on base
immediately with our $10M apps and spend our effort on *uniqueness + reskin*, not
re-chasing solved problems.

## The seven phases (per app)

### Phase A — Forensic validation (read EVERYTHING)
Fan out Sonnet subagents (one per app area) that read the REAL files and validate
correctness, not just presence. For each capability record: what it does, how it
is implemented (custom code / @capgo plugin / @capacitor core / third-party), any
bug/dead-code/security/compliance issue, and whether a Capgo plugin/skill could
replace or improve it. Preserve exact facts (formulas, versions, file:line, call
sites) as raw research.

Area partition (adapt per app): audio/engine, clinical/business-logic, content/UI,
growth/gamification, reports, observability+config, native-plugins+capacitor-config,
QA infra, build/release infra (.github/workflows, lockfile, SHA-pins), compliance+i18n+docs.

### Phase B — Capgo deep research (the WHOLE surface + external)
Fan out Sonnet researchers over: `capgo.app/plugins/` + `/docs/plugins/` (enumerate
EVERY plugin), the updater/OTA docs (channels, staged rollout, self-host, encryption,
rollback), `capgo.app/capgo-cli/`, `capgo.app/observe/`, `capgo.app/skills/`,
`capgo.app/solutions/white-label/`, and EXTERNAL community sources (blogs, GitHub,
HN/Reddit/dev.to, YouTube) on how people shortcut Capacitor dev with Capgo, plus
`dyad.sh`. Save every real URL + raw excerpt. Compare each Capgo capability to what
the app already does.

### Phase C — Comparison matrix + verdicts
One high-effort synthesis pass builds the capability matrix: capability | ours |
Capgo option | verdict (adopt-capgo / keep-ours / investigate / already-capgo) |
reason. Verdict rule: **adopt-capgo whenever Capgo >= parity; keep-ours needs a
concrete reason.**

### Phase D — Wave plan
Group adopt-capgo + forensic-fix items into small, independently CI-gated waves,
lowest-risk first, each with a gate (vitest / boot-gate / compliance grep /
focus-group). Respect the app's hard rails.

### Phase E — Execute autonomously
One repo per builder (avoid collisions). Sonnet builders (Haiku for mechanical);
each wave = a branch off fresh `origin/main` (avoid the stale-branch trap: cherry-pick
only the new commit if a sibling already merged), PR, CI green, adversarial/Copilot
review addressed on real findings, merge on verified green. iOS builds stay
**CTO-only dispatch** (merge to main + escalate "ready to build").

### Phase F — Update living docs + tests/focus-groups
Review the app's living documents (e.g. `docs/<APP>-LIVING-BUILD-SPEC.md`, HANDOFF.md,
qa/RELEASE-LEDGER.md, cto-bridge) and UPDATE them with everything changed. Run the
unit suite, boot-gate, and a persona focus-group round; loop fixes to the gate.

### Phase G — Release + checkpoint
CTO dispatches the iOS build (Depot `depot-macos-26`, dispatch-only) or an OTA bundle
(`@capgo/capacitor-updater` via the app's `ota-capgo.yml`) for web-layer-only changes.
Write-through the whole arc to the kb-memory ledger + a durable recovery doc
(runbook + Azure commons `_RECOVERY/`).

## Standing rails (never violated during adoption)
- Binding LAW: no secret VALUES in a repo (names fine); no real PHI to the non-BAA
  runtime; no autonomous INND MNPI disclosure.
- Per-app compliance rails hold (iHEARtest: only `category_band` leaves device, never
  `hearing_number`/`threshold_db_hl` in `www/js`; i18n en/es parity; no em/en dashes
  in app copy; SHA-pinned Actions; 7-day dependency cooldown; ar-US human-gated).
- New Capgo deps still respect the dependency cooldown + full lockfile review.
- Prefer web-layer (`www/`) changes: they are OTA-patchable via `@capgo/capacitor-updater`
  without a native build.

## Raw research
Save all raw research under `docs/capgo-adoption/` in the app repo (per-area forensic
notes + Capgo research + the matrix + the wave plan), plus the workflow journal. Raw is
never discarded; it seeds the next app's pass.

## Reuse
This protocol IS the template. For the next app, re-run Phase A/B with that app's area
partition and rails; Phase B's Capgo research is largely reusable (refresh, don't
re-derive from scratch).
