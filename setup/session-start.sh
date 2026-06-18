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
# Secrets model: ONE environment secret bootstraps everything.
#   GCP_CLAUDE_DRIVER_SA_JSON  full JSON of the non-PHI claude-driver SA key
# Using that SA, this script pulls the API keys from GCP Secret Manager
# (secrets: openai-api-key, elevenlabs-api-key, optional recraft-api-key).
# OPENAI_API_KEY / ELEVENLABS_API_KEY may still be passed directly as env
# vars to override Secret Manager (useful for local dev).
# Optional:
#   GOOGLE_CLOUD_PROJECT (default otchealth-shared-prod),
#   VERTEX_DEFAULT_IMAGEN_MODEL / _VIDEO_MODEL / _LLM_MODEL

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

# ─── Install fleet Claude Code plugins (official marketplace) ────────
# Belt-and-suspenders for web sessions: .claude/settings.json declares the
# marketplace + enabledPlugins, but the web "trust folder" gate can skip silent
# auto-install. Registering + installing headlessly here makes the curated dev +
# security plugins active every session. Best-effort; never aborts startup.
# Curated set (see dream-team/PLUGIN-LAUNCH-PLAN.md): code-review, pr-review-toolkit,
# commit-commands, feature-dev, frontend-design, hookify, plugin-dev, agent-sdk-dev,
# security-guidance. The marketplace clones over public HTTPS (no auth).
if command -v claude >/dev/null 2>&1; then
  FLEET_PLUGINS="code-review pr-review-toolkit commit-commands feature-dev frontend-design hookify plugin-dev agent-sdk-dev security-guidance ralph-wiggum explanatory-output-style learning-output-style claude-opus-4-5-migration"
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

# ─── Write the GCP SA key from the one env secret ───────────────────
if [ -n "${GCP_CLAUDE_DRIVER_SA_JSON:-}" ]; then
  printf '%s' "$GCP_CLAUDE_DRIVER_SA_JSON" > "$SA_PATH"
  chmod 600 "$SA_PATH"
  echo "[octools] GCP SA key written to $SA_PATH"
elif [ -f "$SA_PATH" ]; then
  echo "[octools] Using existing SA key at $SA_PATH"
else
  echo "[octools] WARN: GCP_CLAUDE_DRIVER_SA_JSON not set and no key on disk — Vertex AI + Secret Manager unavailable."
fi

# ─── Pull API keys from GCP Secret Manager (override with direct env vars) ──
FETCHED=""
if [ -f "$SA_PATH" ]; then
  echo "[octools] Fetching API keys from Secret Manager (project: $PROJECT)..."
  FETCHED="$(GOOGLE_APPLICATION_CREDENTIALS="$SA_PATH" GOOGLE_CLOUD_PROJECT="$PROJECT" \
    node "${TOOLS_DIR}/setup/fetch-secrets.mjs" 2>/dev/null || true)"
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
  echo "# Secrets sourced from GCP Secret Manager via the claude-driver SA."
  echo "# RING: NON-PHI ONLY. This SA must never touch a PHI project."
  echo "OPENAI_API_KEY=${OPENAI_KEY}"
  echo "ELEVENLABS_API_KEY=${ELEVEN_KEY}"
  echo "GOOGLE_CLOUD_PROJECT=${PROJECT}"
  echo "GOOGLE_APPLICATION_CREDENTIALS=${SA_PATH}"
  echo "VERTEX_DEFAULT_IMAGEN_MODEL=${VERTEX_DEFAULT_IMAGEN_MODEL:-imagen-4.0-generate-001}"
  echo "VERTEX_DEFAULT_VIDEO_MODEL=${VERTEX_DEFAULT_VIDEO_MODEL:-veo-2.0-generate-001}"
  echo "VERTEX_DEFAULT_LLM_MODEL=${VERTEX_DEFAULT_LLM_MODEL:-gemini-2.5-flash}"
  echo "RECRAFT_API_KEY=${RECRAFT_KEY}"
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
    if node "${TOOLS_DIR}/setup/get-secret.mjs" context7-api-key "$C7TMP" >/dev/null 2>&1 && [ -s "$C7TMP" ]; then
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

echo "[octools] Done. Designer skill + Dream Team agents ready."
echo "[octools] Credentials: $CRED"

# Always succeed: skills + agents are installed. Missing secrets are warned above,
# not fatal — a session must be able to start without the GCP SA / Secret Manager.
exit 0
