#!/usr/bin/env bash
# session-start.sh — installs the OTCHealth designer skill into ~/.claude/skills
# and re-hydrates credentials from environment secrets. Idempotent: safe to run
# at the start of every Claude Code (web) session.
#
# Wire this into each project's Claude Code environment setup script, e.g.:
#   git clone https://github.com/InnerScopeHearing/otchealth-claude-tools /tmp/octools \
#     2>/dev/null || (cd /tmp/octools && git pull --ff-only)
#   bash /tmp/octools/setup/session-start.sh
#
# Secrets model (Azure-first, 2026-07): a service principal bootstraps everything
# from Azure Key Vault. Set these four in the cloud environment's .env box:
#   AZURE_SP_CLIENT_ID       the fleet service-principal app (client) id
#   AZURE_SP_CLIENT_SECRET   its client secret
#   AZURE_SP_TENANT_ID       the Entra tenant id
#   AZURE_KEYVAULT_NAME      vault name (default kv-otc-55c84f6bef)
# Using that SP, this script pulls all API keys from Key Vault (secret NAMES are a
# 1:1 mirror of the retired GCP Secret Manager ids). OPENAI_API_KEY etc. may still
# be passed directly as env vars to override the vault (useful for local dev).
#
# LEGACY (retired, GCP billing off): GCP_CLAUDE_DRIVER_SA_JSON + GOOGLE_CLOUD_PROJECT
# are still honored as a fallback only if the Azure creds are absent AND a GCP SA
# key is present. This path is expected to fail; Azure Key Vault is the source.

set -euo pipefail

TOOLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILLS_DST="${HOME}/.claude/skills"
DESIGNER_DST="${SKILLS_DST}/designer"

# Self-heal stale caches: when running from the ephemeral /tmp clone, force it to
# the latest origin/main so a warm container never ships old skills. Guarded to
# /tmp so this can NEVER reset a real working checkout.
case "$TOOLS_DIR" in
  /tmp/*)
    if git -C "$TOOLS_DIR" rev-parse --git-dir >/dev/null 2>&1; then
      if git -C "$TOOLS_DIR" fetch --depth 1 origin main >/dev/null 2>&1 \
         && git -C "$TOOLS_DIR" reset --hard FETCH_HEAD >/dev/null 2>&1; then
        echo "[octools] synced $TOOLS_DIR to origin/main ($(git -C "$TOOLS_DIR" rev-parse --short HEAD))"
      else
        echo "[octools] WARN: could not refresh $TOOLS_DIR; using cached copy."
      fi
    fi
    ;;
esac

echo "[octools] Installing skills -> ${SKILLS_DST}"
mkdir -p "$SKILLS_DST"
for skdir in "${TOOLS_DIR}/skills/"*/; do
  sk="$(basename "$skdir")"
  rm -rf "${SKILLS_DST:?}/${sk}"
  cp -R "$skdir" "${SKILLS_DST}/${sk}"
done

# ─── Governed-skills audit: surface "shadow-doctrine" skills ────────
# The copy loop above (and octools-sync.sh's live-refresh equivalent) only ever copies FROM the git
# skills/ tree INTO ~/.claude/skills; neither ever enumerates or removes a destination-only directory.
# So a skill dir that lands there some other way (an agent authoring one ad hoc, a stale leftover) is
# never touched again by either sync path and persists forever, silently, fully outside governance,
# while still loading and steering every session same as a real skill. Report-only here (never prunes);
# best-effort and fail-open so a stat/read hiccup can never block session start. See
# setup/governed-skills-audit.mjs for the full rationale, the --detail classification, and the guarded
# --prune (dry-run by default; a human decides delete-vs-PR-in per orphan, this never auto-deletes).
node "${TOOLS_DIR}/setup/governed-skills-audit.mjs" --report 2>/dev/null || true

# Record the commit the skills were installed from, so a long-running session can later detect it is
# stale (origin/main moved on after it started). `octools-version.sh` compares this to origin/main.
if git -C "$TOOLS_DIR" rev-parse HEAD >/dev/null 2>&1; then
  git -C "$TOOLS_DIR" rev-parse HEAD > "${HOME}/.claude/.octools-installed-commit" 2>/dev/null || true
fi

# Designer carries Node deps (sharp). Skip if already present (warm cache).
if [ -f "${DESIGNER_DST}/package.json" ] && [ ! -d "${DESIGNER_DST}/node_modules" ]; then
  echo "[octools] npm install (designer deps)..."
  (cd "$DESIGNER_DST" && npm install --no-audit --no-fund --silent) \
    || echo "[octools] WARN: npm install failed — sharp-based post-processing may be unavailable."
fi

# ─── Install Dream Team agents -> ~/.claude/agents ──────────────────
# Makes the coordinated agent roster (coach, architect, builder, qa, ...) available
# in every Claude Code session across every repo. Idempotent.
AGENTS_DST="${HOME}/.claude/agents"
if [ -d "${TOOLS_DIR}/dream-team/agents" ]; then
  echo "[octools] Installing Dream Team agents -> ${AGENTS_DST}"
  mkdir -p "$AGENTS_DST"
  cp -f "${TOOLS_DIR}/dream-team/agents/"*.md "$AGENTS_DST/" 2>/dev/null || true
fi

# Secret hydration is best-effort. Skills + agents (above) are the hard requirement
# for a session to start; if the GCP SA / Secret Manager is unavailable, warn and
# continue instead of aborting session startup under `set -e`/pipefail.
set +e
set +o pipefail

# ─── Establish lane identity (~/.claude/.kb-agent) ──────────────────
# kb-memory writes/recall + the gateway lane self-scope off this marker. Without it,
# a session either can't scope its memory or (worse) writes to the wrong lane. We
# resolve it RELIABLY but NEVER GUESS a lane — a wrong lane (esp. a privileged one)
# is worse than none. Precedence:
#   1. KB_AGENT env explicitly set  -> authoritative pin (overrides a stale GLOBAL
#      marker left by a prior session on a reused/shared container). This is the
#      per-session knob: set KB_AGENT=<lane> in the session's env and it sticks.
#   2. else the shared resolver (skills/kb-memory/agent-id.sh): existing marker >
#      repo committed .kb-agent (walked to git root) > unambiguous repo->lane auto-claim.
# The result is validated against the known lane allow-list before it is persisted,
# so a typo never becomes a bogus marker. Unresolved => loud WARN with the exact fix.
KB_MARK="${HOME}/.claude/.kb-agent"
KB_VALID="clo clo-personal cfo coo cpo cro cco cto developer"
mkdir -p "${HOME}/.claude" 2>/dev/null
_LANE=""; _LSRC=""
if [ -n "${KB_AGENT:-}" ]; then
  _LANE="${KB_AGENT}"; _LSRC="KB_AGENT env (explicit pin)"
else
  AG=""; SRC=""
  . "${TOOLS_DIR}/skills/kb-memory/agent-id.sh" 2>/dev/null || true
  _LANE="${AG:-}"; _LSRC="${SRC:-repo resolver}"
fi
case " ${KB_VALID} " in
  *" ${_LANE} "*)
    printf '%s\n' "${_LANE}" > "$KB_MARK" 2>/dev/null
    echo "[octools] Lane identity: ${_LANE}  (source: ${_LSRC})"
    ;;
  *)
    echo "==================================================================================="
    echo "[octools] WARN: lane identity UNRESOLVED${_LANE:+ (got invalid '${_LANE}')} — kb-memory + gateway lane can't self-scope."
    echo "          Not guessing on purpose (a wrong lane, esp. a privileged one, is worse than none). Set it either way:"
    echo "            • env:    add KB_AGENT=<lane> to this session's environment variables (best on the shared env), or"
    echo "            • marker: echo <lane> > ~/.claude/.kb-agent"
    echo "          Valid lanes: ${KB_VALID}"
    echo "==================================================================================="
    ;;
esac

# ─── System deps: document pipeline (LibreOffice + poppler-utils + weasyprint) ─
# The remote container base image ships only libreoffice-core + libreoffice-common
# (the Writer/Calc/Impress MODULES libswlo.so etc. are MISSING), NO poppler-utils,
# and NO weasyprint. The effects are silent and break real work for every agent:
#   * no LO modules -> `soffice --convert-to` fails to load ANY document, with the
#     misleading error "source file could not be loaded" (breaks docx/xlsx/pptx +
#     the doc-indexer office path). Surfaced by the CLO rendering a legal template.
#   * no poppler -> no `pdftotext`, the cheap PDF text-layer extractor the
#     doc-indexer interactive path + the pdf skill rely on.
#   * no weasyprint -> no HTML/Markdown -> PDF RENDERING (the pdf skill's CREATE
#     path: legal docs, financial reports, memos, build-review PDFs). Surfaced by
#     the Developer agent ("PDF rendering tooling isn't installed here").
# These are the document ESSENTIALS an agent needs to actually run the company, so
# they are installed always (when missing). Guarded: skip when present, so a warm
# container pays nothing; non-fatal; only `apt-get update`s when an install is
# needed; root-or-sudo aware. Heavier/rarer deps stay LAZY-installed by the skills
# that use them (tesseract OCR - cloud Document Intelligence covers it; ffmpeg -
# video only). Premium essentials always-on, not the kitchen sink.
if ! dpkg -s libreoffice-writer >/dev/null 2>&1 || ! command -v pdftotext >/dev/null 2>&1 || ! command -v weasyprint >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    APT=""
    if [ "$(id -u)" = 0 ]; then APT="apt-get"; elif command -v sudo >/dev/null 2>&1; then APT="sudo -n apt-get"; fi
    if [ -n "$APT" ]; then
      echo "[octools] Installing document-pipeline deps (LibreOffice writer/calc/impress + poppler-utils + weasyprint)..."
      if $APT update -qq >/dev/null 2>&1 \
         && DEBIAN_FRONTEND=noninteractive $APT install -y -qq \
              libreoffice-writer libreoffice-calc libreoffice-impress poppler-utils weasyprint >/dev/null 2>&1; then
        echo "[octools] Document-pipeline deps installed (soffice + pdftotext + weasyprint ready)."
      else
        echo "[octools] WARN: document-pipeline dep install failed (apt/network/permissions?) - Office conversion, PDF text extraction, and HTML/MD->PDF rendering may be unavailable this session."
      fi
    else
      echo "[octools] WARN: document-pipeline deps missing and no root/sudo to install - soffice/pdftotext/weasyprint unavailable this session."
    fi
  fi
fi

# ─── Install fleet Claude Code plugins (official marketplace) ────────
# Belt-and-suspenders for web sessions: .claude/settings.json declares the
# marketplace + enabledPlugins, but the web "trust folder" gate can skip silent
# auto-install. Registering + installing headlessly here makes the curated dev +
# security plugins active every session. Best-effort; never aborts startup.
# Curated set (see dream-team/PLUGIN-LAUNCH-PLAN.md): code-review, pr-review-toolkit,
# commit-commands, feature-dev, frontend-design, plugin-dev, agent-sdk-dev,
# security-guidance. The marketplace clones over public HTTPS (no auth).
if command -v claude >/dev/null 2>&1; then
  FLEET_PLUGINS="code-review pr-review-toolkit commit-commands feature-dev frontend-design plugin-dev agent-sdk-dev security-guidance ralph-wiggum explanatory-output-style learning-output-style claude-opus-4-5-migration"
  if ! claude plugin marketplace list 2>/dev/null | grep -q "claude-code-plugins"; then
    echo "[octools] Registering official plugin marketplace (anthropics/claude-code)..."
    claude plugin marketplace add anthropics/claude-code >/dev/null 2>&1 \
      || echo "[octools] WARN: could not add plugin marketplace (offline?) — skipping plugin install."
  fi
  if claude plugin marketplace list 2>/dev/null | grep -q "claude-code-plugins"; then
    INSTALLED="$(claude plugin list 2>/dev/null)"
    for p in $FLEET_PLUGINS; do
      if ! printf '%s' "$INSTALLED" | grep -q "${p}@claude-code-plugins"; then
        claude plugin install "${p}@claude-code-plugins" >/dev/null 2>&1 \
          && echo "[octools] plugin installed: ${p}" \
          || echo "[octools] WARN: plugin install failed: ${p}"
      fi
    done
  fi
  # Repair the hookify plugin's broken import layout if it is present at all.
  # hookify is no longer installed by this script and is disabled in
  # .claude/settings.json, but a box that installed it earlier still carries it
  # in the plugin cache, and Claude Code loads plugin hooks at SESSION START and
  # does not re-read enabledPlugins mid-session. On those boxes every
  # PreToolUse/PostToolUse/UserPromptSubmit/Stop prints
  # "Hookify import error: No module named 'hookify'" - two or more messages per
  # tool call, forever.
  #
  # Cause: the hook scripts put dirname(CLAUDE_PLUGIN_ROOT) on sys.path then
  # "import hookify", which needs the content in a directory literally named
  # hookify. The install layout is versioned (.../hookify/<version>/), so the
  # version directory occupies the package slot and the import can never resolve.
  # A symlink named hookify pointing at the version directory makes it resolve,
  # so the hooks no-op silently (there are no rule files) instead of erupting.
  # Idempotent, best-effort, and cheap; never aborts startup.
  _hookify_root="$HOME/.claude/plugins/cache/claude-code-plugins/hookify"
  if [ -d "$_hookify_root" ] && [ ! -e "$_hookify_root/hookify" ]; then
    _hookify_ver="$(find "$_hookify_root" -maxdepth 1 -mindepth 1 -type d ! -name hookify 2>/dev/null | head -1)"
    if [ -n "$_hookify_ver" ] && [ -d "$_hookify_ver/core" ]; then
      ln -sfn "$_hookify_ver" "$_hookify_root/hookify" 2>/dev/null \
        && echo "[octools] repaired hookify plugin import layout (was spamming every tool call)"
    fi
  fi

  # Official Anthropic Agent Skills marketplace (anthropics/skills). These skills are
  # LICENSED, NOT redistributable (Anthropic "use within the Services" terms forbid
  # copying them into our repo), so we install them the AUTHORIZED way via the official
  # marketplace instead of vendoring. document-skills = xlsx/docx/pptx/pdf; example-skills
  # = canvas-design, mcp-builder, brand-guidelines, doc-coauthoring, webapp-testing,
  # skill-creator, frontend-design, etc. Gives the fleet real Office-doc authoring.
  AGENT_SKILL_PLUGINS="document-skills example-skills"
  if ! claude plugin marketplace list 2>/dev/null | grep -q "anthropic-agent-skills"; then
    echo "[octools] Registering Anthropic Agent Skills marketplace (anthropics/skills)..."
    claude plugin marketplace add anthropics/skills >/dev/null 2>&1 \
      || echo "[octools] WARN: could not add anthropic-agent-skills marketplace (offline?)."
  fi
  if claude plugin marketplace list 2>/dev/null | grep -q "anthropic-agent-skills"; then
    INSTALLED="$(claude plugin list 2>/dev/null)"
    for p in $AGENT_SKILL_PLUGINS; do
      if ! printf '%s' "$INSTALLED" | grep -q "${p}@anthropic-agent-skills"; then
        claude plugin install "${p}@anthropic-agent-skills" >/dev/null 2>&1 \
          && echo "[octools] agent-skill plugin installed: ${p}" \
          || echo "[octools] WARN: agent-skill plugin install failed: ${p}"
      fi
    done
  fi
  # wshobson "claude-code-workflows" marketplace (MIT, 84 domain plugins / 156 skills).
  # SUPPLY-CHAIN HARDENING (security review 2026-06-18): this is a THIRD-PARTY marketplace,
  # so autoUpdate is OFF in .claude/settings.json (no tracking of its moving default branch;
  # reviewed at commit cc37bfd). We do NOT mass-enable and we do NOT allow agent-initiated
  # installs from it. Only a CURATED, human-approved set is installed here (declared in
  # settings.json enabledPlugins). The best individual skills are already vendored into
  # skills/. To add another plugin, a human edits this list + enabledPlugins after a review.
  WSHOBSON_PLUGINS="hr-legal-compliance security-compliance"   # CLO + guardian compliance (no hooks; reviewed)
  if ! claude plugin marketplace list 2>/dev/null | grep -q "claude-code-workflows"; then
    echo "[octools] Registering wshobson claude-code-workflows marketplace (curated, no autoUpdate)..."
    claude plugin marketplace add wshobson/agents >/dev/null 2>&1 \
      || echo "[octools] WARN: could not add claude-code-workflows marketplace (offline?)."
  fi
  if claude plugin marketplace list 2>/dev/null | grep -q "claude-code-workflows"; then
    INSTALLED="$(claude plugin list 2>/dev/null)"
    for p in $WSHOBSON_PLUGINS; do
      if ! printf '%s' "$INSTALLED" | grep -q "${p}@claude-code-workflows"; then
        claude plugin install "${p}@claude-code-workflows" >/dev/null 2>&1 \
          && echo "[octools] curated wshobson plugin installed: ${p}" \
          || echo "[octools] WARN: wshobson plugin install failed: ${p}"
      fi
    done
  fi
fi

# NOTE: fleet MCP servers (context7, courtlistener) are registered LATER, after the
# credentials/SA are available, so authenticated servers can read their key. See the
# "Fleet MCP servers" block near the end of this script.

mkdir -p "${HOME}/.designer"
CRED="${HOME}/.designer/credentials.env"
SA_PATH="${HOME}/.gcp_claude_driver_sa.json"
PROJECT="${GOOGLE_CLOUD_PROJECT:-otchealth-shared-prod}"

KEYVAULT="${AZURE_KEYVAULT_NAME:-kv-otc-55c84f6bef}"
FETCHED=""
SECRET_SOURCE=""

# ─── Fleet backend defaults (static config, NOT secrets) ────────────
# Exported before any hydration so every child process below, and every tool that later sources
# credentials.env, agrees on which cloud is live. Each of these had a default baked into code that
# pointed at Azure, and none of them was ever set anywhere in the fleet, so every script silently
# addressed a retired subscription:
#   SECRET_BACKEND      azure-secret.mjs defaulted to "keyvault"  -> now the live AWS SSM store
#   SEARCH_BACKEND      index-one.mjs defaulted to "azure"        -> now the live OpenSearch cluster
#   EMBEDDINGS_PROVIDER index-one.mjs defaulted to "foundry"      -> now OpenAI (Foundry is Azure)
# Set any of them in the environment to override; these are defaults, not overrides.
#
# >>> BEGIN fleet-secret hydration (extracted verbatim by tests/session-start-hydration.test.mjs;
# >>> move the markers with the block if it ever moves, they are what makes this testable)
#
# SECRET_BACKEND is NORMALIZED BY THE JS, not parsed again here. This block used to compare the raw
# string (`[ "$SECRET_BACKEND" = "ssm" ]`) while every Node caller went through secretBackend() in
# skills/kb-memory/azure-secret.mjs, which trims, lowercases, and maps anything unrecognised to
# "ssm". Two parsers for one setting gave two answers: "SSM", " ssm", "Ssm" or a typo made THIS
# SHELL skip the AWS hydrator entirely -- session starts with no credentials -- while every tool it
# launched read happily from SSM. And because the value is written into credentials.env below and
# re-sourced by every later shell, one bad value outlived the session that introduced it. Asking
# the JS keeps exactly one definition of what the setting means. The `|| printf ssm` is a floor,
# not a second parser: if node cannot run at all we land on the same default secretBackend() would
# have returned, and session startup is never aborted over a config lookup.
SECRET_BACKEND="$(node "${TOOLS_DIR}/setup/secret-backend.mjs" 2>/dev/null || printf 'ssm')"
[ -n "$SECRET_BACKEND" ] || SECRET_BACKEND="ssm"
export SECRET_BACKEND
export SEARCH_BACKEND="${SEARCH_BACKEND:-opensearch}"
export EMBEDDINGS_PROVIDER="${EMBEDDINGS_PROVIDER:-openai}"

# ─── STRUCTURAL REDESIGN (2026-08-18, round 4) ──────────────────────
# Three prior rounds each fixed one shape of "a failure reported as a plausible success" in THIS
# block, and each fix was bash re-parsing a hydrator's human-readable log line (sed against
# stderr, `-z` on the result, unquoted word-splitting over it). All three share one root cause:
# prose has no schema, so an empty capture and an absent one print identically, and a shell test
# built for "is this string empty" cannot tell the difference either. A fourth instance of the same
# shape was found and closed the same way the first three were (see setup/hydration-result.mjs's
# header for the exact reproduction).
#
# The fix this round is not a fifth patch to the parsing -- it is removing the parsing. Each
# hydrator now writes a MACHINE-READABLE result (a JSON file, via FLEET_HYDRATION_RESULT_FILE) that
# already holds the exact typed facts this block used to reconstruct from a sentence: is the store
# reachable, how many secrets arrived, and the precise {id, env} of every required secret that did
# not resolve. setup/hydration-report.mjs (a) decides whether the fallback is even worth attempting
# (`gate` mode) using the SAME verdict logic for both arms, and (b) renders the final honesty
# banner (`report` mode) from BOTH arms' structured results plus this session's own environment
# (for the store-truth-vs-session-truth distinction). This shell script's job shrinks to: run the
# hydrators, capture their raw stdout, and hand both to hydration-report.mjs -- it makes no
# completeness decision of its own, so it has nothing left to get wrong the way the last three
# rounds did.
#
# mk_tmp gives every one of these a non-empty path even if mktemp itself fails (mirrors the
# guarded pattern the diagnostics file below already used): a failed temp-file allocation must
# degrade the hydration's OWN diagnostics, never abort session startup.
mk_tmp() {
  local f
  f="$(mktemp 2>/dev/null)" || f=""
  [ -n "$f" ] || f="${TMPDIR:-/tmp}/octools-$1.$$"
  printf '%s' "$f"
}

HR_SSM_ATTEMPTED=0
SSM_RESULT_FILE="$(mk_tmp ssm-result)"
SSM_FETCHED_FILE="$(mk_tmp ssm-fetched)"
: > "$SSM_FETCHED_FILE"
HR_KV_ATTEMPTED=0
KV_RESULT_FILE="$(mk_tmp kv-result)"
KV_FETCHED_FILE="$(mk_tmp kv-fetched)"
: > "$KV_FETCHED_FILE"

# ─── PRIMARY: pull fleet secrets from AWS SSM Parameter Store ───────
# Azure subscription 55c84f6b is permanently gone, so the Key Vault block below cannot return
# anything and, being the only hydration path, left credentials.env empty at every session start.
# All 444 fleet secrets are mirrored to SSM under /otchealth/<id>; this reads them.
#
# Same 3-attempt retry as the Azure path, for the same reason: on a fresh container the task-role
# credential endpoint can lag this hook's first pass, and one bad beat would otherwise blank the
# whole session's credentials silently.
if [ "$SECRET_BACKEND" = "ssm" ]; then
  HR_SSM_ATTEMPTED=1
  ssm_rc=0
  # A redirect target that is guaranteed non-empty: `2>""` from a failed mktemp would break the
  # fetch itself, which is a worse failure than losing the diagnostics we are here to preserve.
  SSM_ERR="$(mk_tmp ssm-err)"
  for attempt in 1 2 3; do
    echo "[octools] Fetching secrets from AWS SSM (${AWS_SSM_PREFIX:-/otchealth}, ${AWS_REGION:-us-east-1}), attempt $attempt/3..."
    FETCHED="$(FLEET_HYDRATION_RESULT_FILE="$SSM_RESULT_FILE" node "${TOOLS_DIR}/setup/fetch-secrets-aws.mjs" 2>"$SSM_ERR")" && ssm_rc=0 || ssm_rc=$?
    # 0 = everything resolved. 1 = no resolvable AWS credentials on this seat. 2 = the store
    # answered but a required secret is not in it. All three are DETERMINISTIC -- a retry cannot
    # change any of them, it only adds dead sleep and delays the Azure fallback by the same. Retry
    # only the undefined-shaped failures (a crash, a network blip), which is what a retry is for.
    case "$ssm_rc" in 0|1|2) break ;; esac
    [ "$attempt" -lt 3 ] && sleep 2
  done

  # Diagnostics for a human tailing the log. Formatting only (a fixed prefix on every line) -- no
  # field is ever extracted from this text; every decision below reads SSM_RESULT_FILE instead.
  [ -s "$SSM_ERR" ] && sed 's/^/[octools]   /' "$SSM_ERR"
  rm -f "$SSM_ERR"

  # The exact bytes this hydrator wrote to stdout, captured BEFORE any Key Vault merge, so
  # hydration-report.mjs's truncation check compares this arm's own claim to this arm's own
  # delivery -- never to a combined total that could hide which store actually lost data.
  printf '%s' "$FETCHED" > "$SSM_FETCHED_FILE"

  echo "[octools] AWS SSM hydrator exited ${ssm_rc}."
fi

# ─── FALLBACK: pull fleet secrets from Azure Key Vault ──────────────
# Demoted from primary 2026-08-18 (Azure exit). Retained, not deleted: it is the transition path
# for any secret that exists only in the vault, and the path that comes back if a vault is ever
# re-provisioned. Expected to return nothing while subscription 55c84f6b stays retired.
# The Key Vault secret NAMES are a 1:1 mirror of the SSM ids, so nothing downstream changes
# whichever source answers — only the fetch mechanism. The client_secret is never logged.
#
# WHETHER TO EVEN TRY: `gate` mode runs the identical verdictFor() logic hydration-report.mjs's
# final banner uses (property D: the two arms are never treated by different rules), on the SSM
# arm's own structured result. Its output is one byte, "0" or "1" -- anything else (a crash, empty
# output, a stray line) is read as "1", because attempting an unnecessary fallback is harmless and
# skipping a needed one is exactly the bug this rewrite exists to close.
SSM_NEEDS_FALLBACK=1
if [ "$HR_SSM_ATTEMPTED" = "1" ]; then
  _gate="$(node "${TOOLS_DIR}/setup/hydration-report.mjs" gate "$SSM_RESULT_FILE" "$SSM_FETCHED_FILE" 2>/dev/null)"
  case "$_gate" in
    0) SSM_NEEDS_FALLBACK=0 ;;
    *) SSM_NEEDS_FALLBACK=1 ;;
  esac
fi

if [ "$SSM_NEEDS_FALLBACK" = "1" ] && [ -n "${AZURE_SP_CLIENT_ID:-}" ] && [ -n "${AZURE_SP_CLIENT_SECRET:-}" ] && [ -n "${AZURE_SP_TENANT_ID:-}" ]; then
  HR_KV_ATTEMPTED=1
  KV_FETCHED=""
  # Same diagnostics discipline as the SSM arm (property D): stderr is captured and shown, not
  # discarded, and no field is ever extracted from it -- the completeness decision lives entirely
  # in KV_RESULT_FILE, read by hydration-report.mjs.
  KV_ERR="$(mk_tmp kv-err)"
  for attempt in 1 2 3; do
    echo "[octools] Fetching secrets from Azure Key Vault ($KEYVAULT), attempt $attempt/3..."
    KV_FETCHED="$(AZURE_KEYVAULT_NAME="$KEYVAULT" FLEET_HYDRATION_RESULT_FILE="$KV_RESULT_FILE" \
      node "${TOOLS_DIR}/setup/fetch-secrets-azure.mjs" 2>"$KV_ERR")" && kv_rc=0 || kv_rc=$?
    [ -n "$KV_FETCHED" ] && break
    [ "$attempt" -lt 3 ] && sleep 2
  done
  [ -s "$KV_ERR" ] && sed 's/^/[octools]   /' "$KV_ERR"
  rm -f "$KV_ERR"
  printf '%s' "$KV_FETCHED" > "$KV_FETCHED_FILE"
  echo "[octools] Azure Key Vault hydrator exited ${kv_rc:-?}."
  if [ -n "$KV_FETCHED" ] && [ -n "$FETCHED" ]; then
    # MERGE, never replace. get_key() below takes the FIRST match for a name, so putting the SSM
    # lines first keeps the primary store authoritative for every id it did serve and lets Key
    # Vault fill only the gaps. Replacing would silently demote the live store to whatever the
    # fallback happened to hold.
    FETCHED="${FETCHED}
${KV_FETCHED}"
  elif [ -n "$KV_FETCHED" ]; then
    FETCHED="$KV_FETCHED"
  fi
fi

# ─── THE ONE HONESTY CHECK, run once, over BOTH arms' structured results ────────────────────────
# hydration-report.mjs is the SOLE place that turns "what did each arm actually resolve" into an
# operator-facing verdict (property A: no re-parsing here, ever). Its output contract is one thing
# and one thing only: line 1 is `SECRET_SOURCE=<value>`, everything after is the banner. If that
# contract is not met -- a crash, empty output, a mangled first line, ANYTHING -- this script does
# NOT fall through to silence or to an assumed-good default. It prints its own loud, explicit
# UNVERIFIED warning instead. That is the outermost safety net: even a future bug INSIDE
# hydration-report.mjs cannot become a silent all-clear, because the code path that would have to
# carry a false "everything is fine" simply does not exist here -- there is no default branch that
# assumes completeness, only one that names the gap.
HR_OUT="$(
  HR_SSM_ATTEMPTED="$HR_SSM_ATTEMPTED" HR_SSM_RESULT_FILE="$SSM_RESULT_FILE" HR_SSM_FETCHED_FILE="$SSM_FETCHED_FILE" \
  HR_KV_ATTEMPTED="$HR_KV_ATTEMPTED" HR_KV_RESULT_FILE="$KV_RESULT_FILE" HR_KV_FETCHED_FILE="$KV_FETCHED_FILE" \
  node "${TOOLS_DIR}/setup/hydration-report.mjs" 2>&1
)"
HR_RC=$?
_hr_first_line="$(printf '%s\n' "$HR_OUT" | head -1)"

case "$_hr_first_line" in
  SECRET_SOURCE=*)
    if [ "$HR_RC" -eq 0 ]; then
      SECRET_SOURCE="${_hr_first_line#SECRET_SOURCE=}"
      printf '%s\n' "$HR_OUT" | tail -n +2
    else
      # The report printed something well-formed but STILL exited non-zero -- do not trust a
      # banner whose own producer says it did not finish cleanly.
      _hr_ok=0
    fi
    ;;
  *)
    _hr_ok=0
    ;;
esac

if [ "${_hr_ok:-1}" = "0" ]; then
  echo "==================================================================================="
  echo "[octools] WARN: the hydration completeness report itself could not be produced (rc=${HR_RC})."
  echo "          Treat this session's secret completeness as UNVERIFIED, not as an all-clear."
  [ -n "$HR_OUT" ] && printf '%s\n' "$HR_OUT" | sed 's/^/[octools]   /'
  echo "          Re-run to get a clean read: bash setup/session-start.sh"
  echo "==================================================================================="
  SECRET_SOURCE="${SECRET_SOURCE:-unknown}"
fi

rm -f "$SSM_RESULT_FILE" "$SSM_FETCHED_FILE" "$KV_RESULT_FILE" "$KV_FETCHED_FILE" 2>/dev/null
# >>> END fleet-secret hydration

# ─── LEGACY FALLBACK: GCP Secret Manager (RETIRED; only if Azure gave nothing) ──
# Kept for backward-compat on any Desktop still carrying the old SA env; GCP billing is
# off, so this path is expected to fail silently. Azure above is the supported source.
if [ -z "$FETCHED" ]; then
  if [ -n "${GCP_CLAUDE_DRIVER_SA_JSON:-}" ] && \
     printf '%s' "$GCP_CLAUDE_DRIVER_SA_JSON" | node -e 'JSON.parse(require("fs").readFileSync(0,"utf8"))' 2>/dev/null; then
    printf '%s' "$GCP_CLAUDE_DRIVER_SA_JSON" > "$SA_PATH"; chmod 600 "$SA_PATH"
  fi
  if [ -f "$SA_PATH" ]; then
    echo "[octools] (legacy) Attempting GCP Secret Manager fallback (expected to be retired)..."
    FETCHED="$(GOOGLE_APPLICATION_CREDENTIALS="$SA_PATH" GOOGLE_CLOUD_PROJECT="$PROJECT" \
      node "${TOOLS_DIR}/setup/fetch-secrets.mjs" 2>/dev/null || true)"
  fi
fi
# Direct env vars win over Secret Manager (handy for local dev).
get_key() {  # $1=env name
  local name="$1" direct="${!1:-}"
  if [ -n "$direct" ]; then printf '%s' "$direct"; return; fi
  printf '%s' "$FETCHED" | sed -n "s/^${name}=//p" | head -1
}
OPENAI_KEY="$(get_key OPENAI_API_KEY)"
ELEVEN_KEY="$(get_key ELEVENLABS_API_KEY)"
RECRAFT_KEY="$(get_key RECRAFT_API_KEY)"
# Azure (optional — empty until the secrets are added to the vault)
AZ_OAI_ENDPOINT="$(get_key AZURE_OPENAI_ENDPOINT)"
AZ_OAI_KEY="$(get_key AZURE_OPENAI_API_KEY)"
AZ_OAI_APIVER="$(get_key AZURE_OPENAI_API_VERSION)"
AZ_OAI_IMG_DEP="$(get_key AZURE_OPENAI_IMAGE_DEPLOYMENT)"
AZ_OAI_VIS_DEP="$(get_key AZURE_OPENAI_VISION_DEPLOYMENT)"
AZ_OAI_VID_DEP="$(get_key AZURE_OPENAI_VIDEO_DEPLOYMENT)"
AZ_SPEECH_KEY="$(get_key AZURE_SPEECH_KEY)"
AZ_SPEECH_REGION="$(get_key AZURE_SPEECH_REGION)"
AZ_SP_CLIENT_ID="$(get_key AZURE_SP_CLIENT_ID)"
AZ_SP_CLIENT_SECRET="$(get_key AZURE_SP_CLIENT_SECRET)"
AZ_SP_TENANT_ID="$(get_key AZURE_SP_TENANT_ID)"
AZ_SUBSCRIPTION_ID="$(get_key AZURE_SUBSCRIPTION_ID)"
# Platform / service tokens (NON-PHI; blank until promoted to Secret Manager)
DEPOT_TOKEN_V="$(get_key DEPOT_TOKEN)"
DEPOT_PROJECT_ID_V="$(get_key DEPOT_PROJECT_ID)"
POSTHOG_KEY_V="$(get_key POSTHOG_PERSONAL_API_KEY)"
POSTHOG_HOST_V="$(get_key POSTHOG_HOST)"
MIRO_TOKEN_V="$(get_key MIRO_TOKEN)"
MIRO_CLIENT_ID_V="$(get_key MIRO_CLIENT_ID)"
MIRO_CLIENT_SECRET_V="$(get_key MIRO_CLIENT_SECRET)"
MAKE_TOKEN_V="$(get_key MAKE_API_TOKEN)"
DAYTONA_KEY_V="$(get_key DAYTONA_API_KEY)"
DAYTONA_URL_V="$(get_key DAYTONA_API_URL)"
GREPTILE_TOKEN_V="$(get_key GREPTILE_TOKEN)"
REPLICATE_TOKEN_V="$(get_key REPLICATE_API_TOKEN)"
N8N_API_KEY_V="$(get_key N8N_API_KEY)"
N8N_BASE_URL_V="$(get_key N8N_BASE_URL)"
# Pin the n8n SELF-HOST as the default (COO-21, 2026-06-11). n8n Cloud
# (otchealth.app.n8n.cloud) is decommissioned; never let CLI/skill use fall back
# to it. The first-party n8n MCP connection is repointed separately in the Claude
# Code env settings (base URL + self-host API key from the Notion vault).
N8N_BASE_URL_V="${N8N_BASE_URL_V:-https://automation.otchealth.app}"
SENTRY_AUTH_TOKEN_V="$(get_key SENTRY_AUTH_TOKEN)"
CLOUDFLARE_TOKEN_V="$(get_key CLOUDFLARE_API_TOKEN)"
NETLIFY_TOKEN_V="$(get_key NETLIFY_TOKEN)"
RAILWAY_TOKEN_V="$(get_key RAILWAY_TOKEN)"
FOURVAULT_GEMINI_V="$(get_key FOURVAULT_GEMINI_API_KEY)"
FOURVAULT_NEON_V="$(get_key FOURVAULT_NEON_DATABASE_URL)"
FOURVAULT_NEON_DIRECT_V="$(get_key FOURVAULT_NEON_DATABASE_URL_DIRECT)"

# ─── Write ~/.designer/credentials.env ──────────────────────────────
# Create the file locked to 600 BEFORE writing any secrets, so it is never
# world-readable during the write window. Redirection (> and >>) preserves the
# permissions of an existing file, so every secret below lands in a 600 file.
( umask 077; : > "$CRED" )
{
  echo "# Auto-generated by otchealth-claude-tools/setup/session-start.sh"
  echo "# Secrets sourced from: ${SECRET_SOURCE:-none}"
  echo "# RING: NON-PHI ONLY. These credentials must never touch a PHI project."
  # Fleet backend selection (static config, NOT secrets). credentials.env is auto-sourced with
  # `set -a` into every shell, so writing them here is what makes the defaults reach tools started
  # later in the session -- not just the children of this script. Without this line a subsequent
  # shell would fall back to each script's own baked-in default, every one of which points at the
  # retired Azure subscription.
  echo "SECRET_BACKEND=${SECRET_BACKEND}"
  echo "SEARCH_BACKEND=${SEARCH_BACKEND}"
  echo "EMBEDDINGS_PROVIDER=${EMBEDDINGS_PROVIDER}"
  # Fleet feature flag (static, not a secret). Enables the low-cardinality otc.fleet.* Datadog
  # metrics emitted by kb-memory on each ledger write (mem.mjs emitFleet -> datadog/dd-fleet.mjs):
  # throttled <=1 emit / 5 min / agent, fail-open, tags = agent/type/ring/engine/shared ONLY (no ids,
  # content, or PHI). credentials.env is auto-sourced with `set -a` into every shell, so this reaches
  # every mem.mjs call fleet-wide. Feeds the Datadog AI-Fleet activity + credit-guard volume monitors
  # (they read "No Data" while this is unset). Set KB_DD_EMIT=0 in the environment to opt out.
  echo "KB_DD_EMIT=1"
  echo "OPENAI_API_KEY=${OPENAI_KEY}"
  echo "ELEVENLABS_API_KEY=${ELEVEN_KEY}"
  echo "RECRAFT_API_KEY=${RECRAFT_KEY}"
  # GCP is retired; only emit the SA path/project if a key actually exists on disk
  # (legacy Desktops). Otherwise these point at nothing and break JSON.parse downstream.
  if [ -f "$SA_PATH" ]; then
    echo "# (legacy GCP — key present on disk)"
    echo "GOOGLE_CLOUD_PROJECT=${PROJECT}"
    echo "GOOGLE_APPLICATION_CREDENTIALS=${SA_PATH}"
    echo "VERTEX_DEFAULT_IMAGEN_MODEL=${VERTEX_DEFAULT_IMAGEN_MODEL:-imagen-4.0-generate-001}"
    echo "VERTEX_DEFAULT_VIDEO_MODEL=${VERTEX_DEFAULT_VIDEO_MODEL:-veo-2.0-generate-001}"
    echo "VERTEX_DEFAULT_LLM_MODEL=${VERTEX_DEFAULT_LLM_MODEL:-gemini-2.5-flash}"
  fi
  echo "# Azure (optional; blank until provisioned + secrets added to the vault)"
  echo "AZURE_OPENAI_ENDPOINT=${AZ_OAI_ENDPOINT}"
  echo "AZURE_OPENAI_API_KEY=${AZ_OAI_KEY}"
  echo "AZURE_OPENAI_API_VERSION=${AZ_OAI_APIVER:-2025-04-01-preview}"
  echo "AZURE_OPENAI_IMAGE_DEPLOYMENT=${AZ_OAI_IMG_DEP}"
  echo "AZURE_OPENAI_VISION_DEPLOYMENT=${AZ_OAI_VIS_DEP}"
  echo "AZURE_OPENAI_VIDEO_DEPLOYMENT=${AZ_OAI_VID_DEP}"
  echo "AZURE_SPEECH_KEY=${AZ_SPEECH_KEY}"
  echo "AZURE_SPEECH_REGION=${AZ_SPEECH_REGION}"
  echo "# Azure Contributor service principal (provisioning; blank until created)"
  echo "AZURE_SP_CLIENT_ID=${AZ_SP_CLIENT_ID}"
  echo "AZURE_SP_CLIENT_SECRET=${AZ_SP_CLIENT_SECRET}"
  echo "AZURE_SP_TENANT_ID=${AZ_SP_TENANT_ID}"
  echo "AZURE_SUBSCRIPTION_ID=${AZ_SUBSCRIPTION_ID}"
  echo "AZURE_KEYVAULT_NAME=${KEYVAULT}"
} > "$CRED"

# ─── Append platform/service tokens that are actually provisioned ───
# Kept out of the block above so credentials.env only carries what exists.
append_if() { [ -n "$2" ] && echo "$1=$2" >> "$CRED"; }
echo "# ─ Platform / service tokens (non-PHI; present only when provisioned) ─" >> "$CRED"
append_if DEPOT_TOKEN "$DEPOT_TOKEN_V"
append_if DEPOT_PROJECT_ID "$DEPOT_PROJECT_ID_V"
append_if POSTHOG_PERSONAL_API_KEY "$POSTHOG_KEY_V"
append_if POSTHOG_HOST "$POSTHOG_HOST_V"
append_if MIRO_TOKEN "$MIRO_TOKEN_V"
append_if MIRO_CLIENT_ID "$MIRO_CLIENT_ID_V"
append_if MIRO_CLIENT_SECRET "$MIRO_CLIENT_SECRET_V"
append_if MAKE_API_TOKEN "$MAKE_TOKEN_V"
append_if DAYTONA_API_KEY "$DAYTONA_KEY_V"
append_if DAYTONA_API_URL "$DAYTONA_URL_V"
append_if GREPTILE_TOKEN "$GREPTILE_TOKEN_V"
append_if REPLICATE_API_TOKEN "$REPLICATE_TOKEN_V"
append_if N8N_API_KEY "$N8N_API_KEY_V"
append_if N8N_BASE_URL "$N8N_BASE_URL_V"
append_if SENTRY_AUTH_TOKEN "$SENTRY_AUTH_TOKEN_V"
append_if CLOUDFLARE_API_TOKEN "$CLOUDFLARE_TOKEN_V"
append_if NETLIFY_TOKEN "$NETLIFY_TOKEN_V"
append_if RAILWAY_TOKEN "$RAILWAY_TOKEN_V"
append_if FOURVAULT_GEMINI_API_KEY "$FOURVAULT_GEMINI_V"
append_if FOURVAULT_NEON_DATABASE_URL "$FOURVAULT_NEON_V"
append_if FOURVAULT_NEON_DATABASE_URL_DIRECT "$FOURVAULT_NEON_DIRECT_V"
chmod 600 "$CRED"

# ─── Fleet MCP servers (user scope; SURGICAL adds only — ~40-50 active-tool ceiling) ───
# Registered here (after the SA/credentials exist) so authenticated servers get their key.
# ~/.claude.json is ephemeral, so re-register every session (idempotent: skip if present).
#  - context7    = live, version-pinned library docs (kills hallucinated package APIs);
#                  Bearer-keyed from context7-api-key for higher limits, keyless fallback.
#  - courtlistener = the CLO's MCP over 9M+ opinions, dockets, citation networks; OAuth 2.1,
#                  so first use prompts a ONE-TIME human consent (a physical gate).
if command -v claude >/dev/null 2>&1; then
  MCP_LIST="$(claude mcp list 2>/dev/null || true)"
  if ! printf '%s' "$MCP_LIST" | grep -q "context7"; then
    C7TMP="$(mktemp)"
    if { AZURE_KEYVAULT_NAME="$KEYVAULT" node "${TOOLS_DIR}/setup/get-secret-azure.mjs" context7-api-key "$C7TMP" >/dev/null 2>&1 \
         || node "${TOOLS_DIR}/setup/get-secret.mjs" context7-api-key "$C7TMP" >/dev/null 2>&1; } && [ -s "$C7TMP" ]; then
      claude mcp add --transport http --scope user context7 https://mcp.context7.com/mcp \
        --header "Authorization: Bearer $(cat "$C7TMP")" >/dev/null 2>&1 \
        && echo "[octools] MCP added: context7 (authenticated)" || echo "[octools] WARN: context7 MCP add failed."
    else
      claude mcp add --transport http --scope user context7 https://mcp.context7.com/mcp >/dev/null 2>&1 \
        && echo "[octools] MCP added: context7 (keyless)" || echo "[octools] WARN: context7 MCP add failed."
    fi
    shred -u "$C7TMP" 2>/dev/null || rm -f "$C7TMP"
  fi
  if ! printf '%s' "$MCP_LIST" | grep -q "courtlistener"; then
    claude mcp add --transport http --scope user courtlistener https://mcp.courtlistener.com/ >/dev/null 2>&1 \
      && echo "[octools] MCP added: courtlistener (OAuth — one-time consent on first use)" \
      || echo "[octools] WARN: courtlistener MCP add failed."
  fi
  #  - tavily = live web search / extract / crawl / map. This is the EXTERNAL, public-world lane and
  #    it sits OUTSIDE the compliance boundary: never send company-confidential, personal, legal,
  #    customer, or PHI content to it (same rule the One Brain ground-first protocol states for
  #    web_search). Company questions go to brain_search; only public-world questions go here.
  #    AWS SSM is tried FIRST and Key Vault second: SSM is the store that survives the Azure
  #    retirement, and the Key Vault read is a transition fallback, not the source of truth.
  if ! printf '%s' "$MCP_LIST" | grep -q "tavily"; then
    TVTMP="$(mktemp)"
    if { node "${TOOLS_DIR}/setup/get-secret-aws.mjs" tavily-api-key "$TVTMP" >/dev/null 2>&1 \
         || AZURE_KEYVAULT_NAME="$KEYVAULT" node "${TOOLS_DIR}/setup/get-secret-azure.mjs" tavily-api-key "$TVTMP" >/dev/null 2>&1; } && [ -s "$TVTMP" ]; then
      # Tavily keys the remote MCP by query string, so the URL itself carries the credential. It
      # lands only in the ephemeral ~/.claude.json, never in a repo -- and is redacted from output.
      claude mcp add --transport http --scope user tavily \
        "https://mcp.tavily.com/mcp/?tavilyApiKey=$(cat "$TVTMP")" >/dev/null 2>&1 \
        && echo "[octools] MCP added: tavily (live web search — EXTERNAL lane, never send confidential content)" \
        || echo "[octools] WARN: tavily MCP add failed."
    else
      echo "[octools] tavily: no API key resolvable (create SSM /otchealth/tavily-api-key) — skipping."
    fi
    shred -u "$TVTMP" 2>/dev/null || rm -f "$TVTMP"
  fi
fi

[ -n "$OPENAI_KEY" ] && echo "[octools] OPENAI_API_KEY: loaded" || echo "[octools] WARN: OPENAI_API_KEY missing (create 'openai-api-key' secret)."
[ -n "$ELEVEN_KEY" ] && echo "[octools] ELEVENLABS_API_KEY: loaded" || echo "[octools] WARN: ELEVENLABS_API_KEY missing (create 'elevenlabs-api-key' secret)."
[ -n "$AZ_OAI_KEY" ] && echo "[octools] AZURE_OPENAI: loaded (provider toggle available)" || echo "[octools] Azure OpenAI: not configured (optional)."
SVC_LOADED="$(grep -cE '^(DEPOT_TOKEN|POSTHOG_PERSONAL_API_KEY|MIRO_TOKEN|MAKE_API_TOKEN|DAYTONA_API_KEY|GREPTILE_TOKEN|REPLICATE_API_TOKEN|N8N_API_KEY|SENTRY_AUTH_TOKEN)=' "$CRED" || true)"
echo "[octools] Platform/service tokens loaded: ${SVC_LOADED} (provision the rest via 'gcloud secrets create' — see docs/PLATFORM.md)."

# ─── Make the non-PHI fleet creds env-available in every shell ──────
# credentials.env is file-based (the designer skill reads it directly), but
# Bash tool calls start fresh shells from the user profile and so do NOT see the
# keys as env vars. Source the file from the profile (idempotent, guarded) so
# DEPOT_TOKEN / POSTHOG_PERSONAL_API_KEY / N8N_* / etc. are usable directly.
# RING: these are NON-PHI fleet keys only (the SA never touches a PHI project).
for PROFILE in "${HOME}/.bashrc" "${HOME}/.profile"; do
  [ -e "$PROFILE" ] || continue
  if ! grep -qF '.designer/credentials.env' "$PROFILE"; then
    {
      echo ''
      echo '# octools: hydrate non-PHI fleet creds into the shell env (added by session-start.sh)'
      echo '[ -f "$HOME/.designer/credentials.env" ] && set -a && . "$HOME/.designer/credentials.env" 2>/dev/null && set +a'
    } >> "$PROFILE"
    echo "[octools] Wired credentials.env into $PROFILE (fleet keys now env-available in new shells)."
  fi
done

# ─── Install the `octsync` helper: one word to catch a stale session up to origin/main ──────────────
# repo-freshen won't touch a dirty branch, so a long-lived session goes stale. `octsync` is the manual,
# work-preserving catch-up (stash -> fetch -> merge -> restore). Named octsync (NOT `sync`) so it never
# shadows the coreutils `sync`. Idempotent per profile.
for PROFILE in "${HOME}/.bashrc" "${HOME}/.profile"; do
  [ -e "$PROFILE" ] || continue
  if ! grep -qF 'octsync()' "$PROFILE"; then
    {
      echo ''
      echo '# octools: octsync — catch this session'"'"'s repo up to origin/main without losing work (added by session-start.sh)'
      echo 'octsync() { bash /tmp/octools/setup/sync.sh || echo "[octsync] toolkit not at /tmp/octools"; }'
    } >> "$PROFILE"
    echo "[octools] Wired octsync helper into $PROFILE."
  fi
done

# Fleet rollout of the in-session live-sync hook: install the octools-sync UserPromptSubmit hook into
# the user-scope ~/.claude/settings.json once. Because session-start runs in every app session (and is
# itself live-synced from main), this propagates the live-pull to the whole fleet with NO per-app edits.
node "${TOOLS_DIR}/setup/install-octools-hook.mjs" 2>/dev/null || true

# Surface the Fleet Bulletin (CTO -> fleet changelog) at every wake, so a session that starts after a
# fleet-affecting change sees what changed + why. octools-sync (UserPromptSubmit) keeps it current
# in-session thereafter. Together: the fleet stays on the same page off one source (main) without resets.
node "${TOOLS_DIR}/setup/bulletin.mjs" since 2>/dev/null || true

# Keep the agent's OWN app/web repo current with origin/main, SAFELY (fast-forward a pristine stale
# branch; never touch a branch that has local commits - just warn). Belt-and-suspenders alongside the
# SessionStart hook, so even the very first session in a fresh container starts on the latest base.
[ -n "${CLAUDE_PROJECT_DIR:-}" ] && bash "${TOOLS_DIR}/setup/repo-freshen.sh" "${CLAUDE_PROJECT_DIR}" 2>/dev/null || true

# Agent onboarding: auto-connect this agent's Claude Code session to the MCP gateway on its OWN
# ring-scoped lane (clo->clo, cfo->cfo, ...). Fail-open + no-op for agents without a lane, non-Desktop
# envs (no `claude` CLI), or a missing SA — never blocks session start.
bash "${TOOLS_DIR}/skills/gateway-connect/session-connect.sh" 2>/dev/null || true

echo "[octools] Done. Designer skill + Dream Team agents ready."
echo "[octools] Credentials: $CRED"

# ─── OTCHealth AI OS migration notice ────────────────────────────────
# The Azure AI Foundry agent "otchealth-os" (project otchealth-os, gpt-5.4) is now the unified,
# company-wide brain: every fleet ledger/data-room is being consolidated into its 13 Azure AI Search
# indexes. Point new sessions at the reconciliation process so this session's knowledge lands in the
# shared brain instead of staying siloed. Fail-open (best-effort only): never blocks session start.
if [ -f "${TOOLS_DIR}/docs/OS-MIGRATION.md" ]; then
  echo "───────────────────────────────────────────────────────────────────"
  echo "[octools] OTCHealth AI OS is now the unified company brain (Foundry project otchealth-os, gpt-5.4)."
  echo "[octools] To reconcile THIS session's knowledge into it, follow ${TOOLS_DIR}/docs/OS-MIGRATION.md"
  echo "[octools]   (and runbooks/agent-gateway-connectivity.md once published) — the 8-step migration"
  echo "[octools]   process for the global doc 'OTCHealth AI OS — Session Migration & Reconciliation Prompt'."
  echo "───────────────────────────────────────────────────────────────────"
fi

# Always succeed: skills + agents are installed. Missing secrets are warned above,
# not fatal — a session must be able to start without the GCP SA / Secret Manager.
exit 0
