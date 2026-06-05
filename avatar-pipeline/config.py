"""Central config for the avatar pipeline.

Values come from environment variables. Locally they are loaded from a
gitignored .env; in GitHub Actions they are injected from repository Actions
Secrets. Nothing secret is hardcoded here.
"""
import os
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass


def _get(name, default=None, required=False):
    val = os.environ.get(name, default)
    if required and not val:
        raise RuntimeError(f"Missing required env var: {name}")
    return val


# --- Paths (all relative to this package; no local-PC paths) ---
ROOT = Path(__file__).resolve().parent
AUDIO_DIR = ROOT / "audio"
CLIPS_DIR = ROOT / "clips"
OUTPUT_DIR = ROOT / "output"
SCRIPTS_DIR = ROOT / "scripts"
for d in (AUDIO_DIR, CLIPS_DIR, OUTPUT_DIR, SCRIPTS_DIR):
    d.mkdir(parents=True, exist_ok=True)

# --- Model / backend defaults ---
DEFAULT_MODEL = "latentsync"          # latentsync | musetalk | sadtalker
DEFAULT_BACKEND = "azure"             # azure | fal
VALID_MODELS = ("latentsync", "musetalk", "sadtalker")
VALID_BACKENDS = ("azure", "fal")

# Models that relip-sync a BASE VIDEO (vs photo-only SadTalker)
BASE_VIDEO_MODELS = ("latentsync", "musetalk")

# Segment length cap (seconds of audio per segment)
MAX_SEGMENT_SECONDS = 60

# --- ElevenLabs ---
ELEVENLABS_API_KEY = _get("ELEVENLABS_API_KEY")
ELEVENLABS_VOICE_ID = _get("ELEVENLABS_VOICE_ID")
ELEVENLABS_MODEL = _get("ELEVENLABS_MODEL", "eleven_multilingual_v2")

# --- Cloudflare R2 (S3-compatible) ---
R2_ACCESS_KEY_ID = _get("R2_ACCESS_KEY_ID")
R2_SECRET_ACCESS_KEY = _get("R2_SECRET_ACCESS_KEY")
R2_ACCOUNT_ID = _get("R2_ACCOUNT_ID")
R2_BUCKET = _get("R2_BUCKET")
R2_PUBLIC_URL_BASE = (_get("R2_PUBLIC_URL_BASE") or "").rstrip("/")
R2_ENDPOINT = f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com" if R2_ACCOUNT_ID else None

# --- Notion ---
NOTION_API_KEY = _get("NOTION_API_KEY")
NOTION_RENDER_DB_ID = _get("NOTION_RENDER_DB_ID")  # created by notion_log if absent
NOTION_PARENT_PAGE_ID = _get("NOTION_PARENT_PAGE_ID")  # where to create the DB

# --- Azure GPU VM ---
AZURE_RG = _get("AZURE_RG", "otchealth-avatar-rg")
AZURE_VM_NAME = _get("AZURE_VM_NAME", "otchealth-avatar-gpu")
AZURE_REGION = _get("AZURE_REGION", "eastus")
AZURE_VM_SKU = _get("AZURE_VM_SKU", "Standard_NC4as_T4_v3")
# Approx on-demand USD/hr for cost logging (override per region/SKU as needed)
AZURE_SKU_HOURLY_USD = float(_get("AZURE_SKU_HOURLY_USD", "0.526"))

# --- Container image on GHCR ---
GHCR_IMAGE = _get("GHCR_IMAGE", "ghcr.io/gbgolfmatt/otchealth-avatar:latest")

# --- Paid fallback ---
FAL_KEY = _get("FAL_KEY")

# Idle/job guardrails
JOB_TIMEOUT_MINUTES = int(_get("JOB_TIMEOUT_MINUTES", "60"))
