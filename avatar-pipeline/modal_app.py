"""Modal GPU app for the avatar pipeline (zero-cost path via Modal's free tier).

Deploy from the sandbox once a Modal token is configured:
    pip install modal
    modal token set --token-id <id> --token-secret <secret>
    modal deploy modal_app.py

Then call from avatar.py (--backend modal):
    fn = modal.Function.lookup("otchealth-avatar", "lipsync_latentsync")
    out_bytes = fn.remote(base_video_bytes, audio_bytes)

Notes:
- Runs LatentSync on a T4. Weights download once into a persistent Modal Volume.
- First deploy validates the exact inference args and weight paths on real GPU.
"""
import os
import subprocess
import tempfile

import modal

app = modal.App("otchealth-avatar")

image = (
    modal.Image.from_registry("nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04", add_python="3.10")
    .apt_install("git", "ffmpeg", "wget", "libgl1", "libglib2.0-0")
    .run_commands("git clone --depth 1 https://github.com/bytedance/LatentSync.git /app/LatentSync")
    .run_commands("pip install --no-cache-dir -r /app/LatentSync/requirements.txt || true")
    .pip_install("huggingface_hub")
)

weights = modal.Volume.from_name("avatar-weights", create_if_missing=True)
WEIGHTS_DIR = "/weights"


def _ensure_weights():
    """Download LatentSync weights into the volume on first use."""
    from huggingface_hub import snapshot_download
    marker = os.path.join(WEIGHTS_DIR, ".latentsync_ready")
    if os.path.exists(marker):
        return
    snapshot_download(repo_id="ByteDance/LatentSync", local_dir=WEIGHTS_DIR)
    open(marker, "w").close()
    weights.commit()


@app.function(gpu="T4", image=image, volumes={WEIGHTS_DIR: weights}, timeout=1800)
def lipsync_latentsync(base_video_bytes: bytes, audio_bytes: bytes) -> bytes:
    """Relip-sync the base video to the audio. Returns the output MP4 bytes."""
    _ensure_weights()
    work = tempfile.mkdtemp()
    base = os.path.join(work, "base.mp4")
    audio = os.path.join(work, "audio.mp3")
    out = os.path.join(work, "out.mp4")
    open(base, "wb").write(base_video_bytes)
    open(audio, "wb").write(audio_bytes)

    subprocess.run([
        "python", "-m", "scripts.inference",
        "--unet_config_path", "configs/unet/stage2.yaml",
        "--inference_ckpt_path", os.path.join(WEIGHTS_DIR, "latentsync_unet.pt"),
        "--video_path", base,
        "--audio_path", audio,
        "--video_out_path", out,
    ], cwd="/app/LatentSync", check=True)

    return open(out, "rb").read()


@app.local_entrypoint()
def smoke():
    print("Modal app 'otchealth-avatar' deployed. Function: lipsync_latentsync.")
