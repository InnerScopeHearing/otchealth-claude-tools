#!/usr/bin/env bash
# session-start.sh — installs the OTCHealth designer skill into ~/.claude/skills
# and re-hydrates credentials from environment secrets. Idempotent: safe to run
# at the start of every Claude Code (web) session.
#
# Wire this into each project's Claude Code environment setup script, e.g.:
#   git clone https://github.com/gbgolfmatt/otchealth-claude-tools /tmp/octools \
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

[ -n "$OPENAI_KEY" ] && echo "[octools] OPENAI_API_KEY: loaded" || echo "[octools] WARN: OPENAI_API_KEY missing (create 'openai-api-key' secret)."
[ -n "$ELEVEN_KEY" ] && echo "[octools] ELEVENLABS_API_KEY: loaded" || echo "[octools] WARN: ELEVENLABS_API_KEY missing (create 'elevenlabs-api-key' secret)."
[ -n "$AZ_OAI_KEY" ] && echo "[octools] AZURE_OPENAI: loaded (provider toggle available)" || echo "[octools] Azure OpenAI: not configured (optional)."
SVC_LOADED="$(grep -cE '^(DEPOT_TOKEN|POSTHOG_PERSONAL_API_KEY|MIRO_TOKEN|MAKE_API_TOKEN|DAYTONA_API_KEY|GREPTILE_TOKEN|REPLICATE_API_TOKEN|N8N_API_KEY|SENTRY_AUTH_TOKEN)=' "$CRED" || true)"
echo "[octools] Platform/service tokens loaded: ${SVC_LOADED} (provision the rest via 'gcloud secrets create' — see docs/PLATFORM.md)."

echo "[octools] Done. Designer skill + Dream Team agents ready."
echo "[octools] Credentials: $CRED"

# Always succeed: skills + agents are installed. Missing secrets are warned above,
# not fatal — a session must be able to start without the GCP SA / Secret Manager.
exit 0
