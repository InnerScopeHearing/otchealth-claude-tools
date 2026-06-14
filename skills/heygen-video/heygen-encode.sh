#!/usr/bin/env bash
# heygen-encode.sh <download_url> <dest_path> [max_mb]
#
# Downloads a HeyGen render and re-encodes it to the app standard, escalating CRF
# until the output is under the size cap (default 24 MB, to stay under GitHub's
# 25 MB and keep LFS objects lean). Installs a static ffmpeg if none is present.
#
# Resolve <download_url> FIRST via the HeyGen MCP get_video (subscription, no paid
# API, no generation credits): the video_url field. See SKILL.md for the full flow.
#
# Standard encode (matches www/assets/video/.../*.meta.json across the fleet):
#   libx264 CRF / preset slow / -profile:v high / yuv420p / hqdn3d=1.5:1.5:6:6 /
#   aac mono 44100 Hz 96k / +faststart (web-streamable).
set -euo pipefail

URL="${1:?usage: heygen-encode.sh <download_url> <dest_path> [max_mb]}"
DEST="${2:?dest path required (e.g. www/assets/video/composed/foo.mp4)}"
MAX_MB="${3:-24}"

case "$DEST" in
  *..*) echo "dest must not contain '..'"; exit 1;;
  /*)   echo "dest must be repo-relative"; exit 1;;
  *.mp4) ;;
  *) echo "dest must end in .mp4"; exit 1;;
esac

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "[heygen-encode] installing static ffmpeg..."
  curl -fsSL https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz -o /tmp/ffmpeg.tar.xz
  tar xf /tmp/ffmpeg.tar.xz -C /tmp
  cp /tmp/ffmpeg-*-amd64-static/ffmpeg /usr/local/bin/ffmpeg
fi

mkdir -p "$(dirname "$DEST")"
echo "[heygen-encode] downloading..."
curl -fsSL "$URL" -o /tmp/heygen-raw.mp4
echo "[heygen-encode] raw size: $(du -h /tmp/heygen-raw.mp4 | cut -f1)"

encode() {
  local crf="$1" scale_filter="$2"
  ffmpeg -y -i /tmp/heygen-raw.mp4 \
    -c:v libx264 -crf "$crf" -preset slow -profile:v high -pix_fmt yuv420p \
    -vf "hqdn3d=1.5:1.5:6:6${scale_filter}" \
    -c:a aac -ac 1 -ar 44100 -b:a 96k -movflags +faststart "$DEST" >/dev/null 2>&1
}

# Escalate CRF first (keeps full resolution), then fall back to a 720-wide scale.
for crf in 25 27 29 31; do
  encode "$crf" ""
  mb=$(( $(stat -c%s "$DEST") / 1024 / 1024 ))
  echo "[heygen-encode] CRF $crf -> ${mb}MB"
  if [ "$mb" -le "$MAX_MB" ]; then echo "[heygen-encode] OK: ${mb}MB at CRF $crf -> $DEST"; exit 0; fi
done
for crf in 27 30; do
  encode "$crf" ",scale=720:-2"
  mb=$(( $(stat -c%s "$DEST") / 1024 / 1024 ))
  echo "[heygen-encode] CRF $crf + 720w -> ${mb}MB"
  if [ "$mb" -le "$MAX_MB" ]; then echo "[heygen-encode] OK: ${mb}MB at CRF $crf (720w) -> $DEST"; exit 0; fi
done
echo "[heygen-encode] STILL over ${MAX_MB}MB. The source is unusually long/busy; trim it or lower further by hand."
exit 1
