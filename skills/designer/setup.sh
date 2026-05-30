#!/usr/bin/env bash
# Designer skill — one-time setup. Idempotent; safe to re-run.
#
# Installs npm deps (sharp + nothing else), prepares the credentials
# directory, and validates that env vars or ~/.designer/credentials.env
# resolve cleanly.

set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USER_HOME_DESIGNER="$HOME/.designer"

echo "[designer] installing npm deps in $SKILL_DIR..."
cd "$SKILL_DIR"
if [ ! -f package.json ]; then
    cat > package.json <<JSON
{
  "name": "claude-skill-designer",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "Designer skill — Claude as creative quarterback",
  "dependencies": {
    "sharp": "^0.33.0"
  }
}
JSON
fi
npm install --no-audit --no-fund

mkdir -p "$USER_HOME_DESIGNER/brand-profiles"

# Create stub credentials.env if missing
if [ ! -f "$USER_HOME_DESIGNER/credentials.env" ]; then
    cat > "$USER_HOME_DESIGNER/credentials.env" <<EOF
# Designer skill credentials. Anything set here is read by every gen-*.mjs script.
# Process env vars take precedence over this file. Add or replace values as needed.
# Keep this file out of git — it lives in ~/.designer/, not in any project.

# OpenAI — DALL-E 3 / GPT-image-1 / GPT-4 Vision
OPENAI_API_KEY=
OPENAI_ORG_ID=

# Google Cloud — Vertex AI Imagen 3 / Veo 2
GOOGLE_APPLICATION_CREDENTIALS=
GOOGLE_CLOUD_PROJECT=

# ElevenLabs — voiceover
ELEVENLABS_API_KEY=

# Optional: Recraft — vectorization. Without this, falls back to local potrace.
RECRAFT_API_KEY=
EOF
    echo "[designer] wrote stub $USER_HOME_DESIGNER/credentials.env — edit with your API keys."
fi

echo ""
echo "[designer] checking credential resolution..."
node "$SKILL_DIR/scripts/_lib.mjs" 2>/dev/null || true
node -e "
import('$SKILL_DIR/scripts/_lib.mjs').then(({ loadCredentials }) => {
    const c = loadCredentials();
    const checks = [
        ['OpenAI', Boolean(c.openaiKey)],
        ['Google Cloud Project', Boolean(c.googleProject)],
        ['Google SA JSON', Boolean(c.googleCredsPath)],
        ['ElevenLabs', Boolean(c.elevenlabsKey)],
        ['Recraft (optional)', Boolean(c.recraftKey)],
    ];
    for (const [n, ok] of checks) {
        console.log('  ' + (ok ? '✓' : '·') + ' ' + n + (ok ? '' : ' (not set)'));
    }
});
"

echo ""
echo "[designer] setup complete. Quick checks:"
echo "  node $SKILL_DIR/scripts/gen-image.mjs --prompt 'test' --dry-run"
echo "  node $SKILL_DIR/scripts/gen-icon-batch.mjs --names 'home,settings,bell' --dry-run"
echo "  node $SKILL_DIR/scripts/gen-app-icon-family.mjs --prompt 'audiogram curve mark on teal' --dry-run"
echo "  node $SKILL_DIR/scripts/gen-video.mjs --prompt 'cinematic logo reveal' --duration 5 --dry-run"
echo ""
echo "If any credential is missing, edit ~/.designer/credentials.env or export the env var."
