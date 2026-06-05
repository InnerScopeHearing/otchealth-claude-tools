"""quick_render.py — interim path to a finished lip-synced MP4 TODAY.

No Azure, no R2, no GitHub Actions required. Uses:
  - ElevenLabs for the voiceover (ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID)
  - Replicate for lip-sync GPU (REPLICATE_API_TOKEN), no quota needed
  - FFmpeg to splice segments into output/final.mp4

Inputs are uploaded to Replicate's files API, so no object store is needed.

Usage:
  python quick_render.py --script scripts/demo.md --base presenter.mp4 --model latentsync
  python quick_render.py --script scripts/demo.md --base headshot.png --model sadtalker
"""
import argparse
import sys
from pathlib import Path

import config
import voiceover
import avatar
import splice


def _to_url(base):
    """Return a public URL for the base asset, uploading a local file to Replicate."""
    if base.startswith("http://") or base.startswith("https://"):
        return base
    if not Path(base).exists():
        sys.exit(f"base asset not found: {base}")
    print(f"[replicate] uploading base asset {base} ...")
    return avatar.replicate_upload_file(base)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--script", required=True, help="script text or a path (also looks under scripts/)")
    ap.add_argument("--base", required=True, help="presenter base video (latentsync/musetalk) or photo (sadtalker)")
    ap.add_argument("--model", default="latentsync", choices=config.VALID_MODELS)
    ap.add_argument("--backend", default="replicate", choices=("replicate", "modal"),
                    help="no-quota GPU backend for the interim render")
    a = ap.parse_args()

    if a.backend == "replicate" and not config.REPLICATE_API_TOKEN:
        sys.exit("Set REPLICATE_API_TOKEN (Replicate account, no GPU quota needed).")
    if not splice.ffmpeg_available():
        sys.exit("ffmpeg not found on PATH.")

    # read script
    p = Path(a.script)
    if not p.exists():
        p = config.SCRIPTS_DIR / a.script
    script_text = p.read_text(encoding="utf-8").strip() if p.exists() else a.script.strip()

    # 1. voiceover (ElevenLabs)
    audio_paths = voiceover.generate_voiceover(script_text)

    # 2. per-segment lip-sync on the chosen no-quota GPU backend
    clip_paths = []
    base_url = None
    modal_fn = None
    if a.backend == "modal":
        import modal
        modal_fn = modal.Function.lookup("otchealth-avatar", "lipsync_latentsync")
        base_bytes = Path(a.base).read_bytes() if Path(a.base).exists() else None
    else:
        base_url = _to_url(a.base)

    for i, audio_path in enumerate(audio_paths):
        local_clip = config.CLIPS_DIR / f"clip_{i:03d}.mp4"
        print(f"[{a.backend}] lip-sync segment {i+1}/{len(audio_paths)} ({a.model}) ...")
        if a.backend == "modal":
            out_bytes = modal_fn.remote(base_bytes, Path(audio_path).read_bytes())
            local_clip.write_bytes(out_bytes)
        else:
            audio_url = avatar.replicate_upload_file(audio_path)
            clip_url = avatar.generate_clip_replicate(base_url, audio_url, f"clip_{i:03d}", a.model)
            import requests
            with requests.get(clip_url, stream=True, timeout=900) as r:
                r.raise_for_status()
                with open(local_clip, "wb") as f:
                    for chunk in r.iter_content(1 << 16):
                        f.write(chunk)
        clip_paths.append(local_clip)

    # 3. splice
    final_path = splice.concat_clips(clip_paths, config.OUTPUT_DIR / "final.mp4")
    print(f"\nDONE: {final_path}")


if __name__ == "__main__":
    main()
