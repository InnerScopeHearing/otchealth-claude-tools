"""One-shot inference container CLI (runs on the Azure GPU VM).

Invoked by `az vm run-command` as:
  docker run --rm --gpus all -e R2_... <image> \
    --model latentsync --base-video-url <url> --audio-url <url> --out-key <key>

It downloads inputs from their public R2 URLs, runs the selected model, uploads
the resulting MP4 to R2 under out-key, and prints the public URL.

The per-model commands below follow each model's OFFICIAL repo CLI. Because GPU
inference cannot be validated in the build sandbox, the first real GPU run is
the validation point (see README, Stage 7).
"""
import argparse
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.request import urlretrieve

import boto3
from botocore.config import Config

WEIGHTS = Path(os.environ.get("WEIGHTS_DIR", "/app/weights"))
REPOS = Path("/app")


def r2():
    acct = os.environ["R2_ACCOUNT_ID"]
    return boto3.client(
        "s3",
        endpoint_url=f"https://{acct}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        config=Config(signature_version="s3v4"),
        region_name="auto",
    )


def fetch(url, dest):
    if not url:
        return None
    urlretrieve(url, dest)
    return dest


def run(cmd, cwd=None):
    print("[container] $", " ".join(cmd), flush=True)
    subprocess.run(cmd, cwd=cwd, check=True)


def infer_latentsync(base_video, audio, out_path):
    # https://github.com/bytedance/LatentSync  (official inference CLI)
    repo = REPOS / "LatentSync"
    run([
        "python", "-m", "scripts.inference",
        "--unet_config_path", "configs/unet/stage2.yaml",
        "--inference_ckpt_path", str(WEIGHTS / "latentsync_unet.pt"),
        "--video_path", base_video,
        "--audio_path", audio,
        "--video_out_path", out_path,
    ], cwd=str(repo))


def infer_musetalk(base_video, audio, out_path):
    # https://github.com/TMElyralab/MuseTalk  (official realtime inference)
    repo = REPOS / "MuseTalk"
    run([
        "python", "-m", "scripts.inference",
        "--video_path", base_video,
        "--audio_path", audio,
        "--result_dir", str(Path(out_path).parent),
        "--output_vid_name", Path(out_path).name,
    ], cwd=str(repo))


def infer_sadtalker(photo, audio, out_path):
    # https://github.com/OpenTalker/SadTalker  (photo + audio)
    repo = REPOS / "SadTalker"
    out_dir = Path(out_path).parent
    run([
        "python", "inference.py",
        "--driven_audio", audio,
        "--source_image", photo,
        "--result_dir", str(out_dir),
        "--still", "--preprocess", "full",
    ], cwd=str(repo))
    # SadTalker names its own output; normalize to out_path
    produced = sorted(out_dir.glob("*.mp4"))
    if produced and str(produced[-1]) != out_path:
        os.replace(produced[-1], out_path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, choices=["latentsync", "musetalk", "sadtalker"])
    ap.add_argument("--base-video-url", default="")
    ap.add_argument("--audio-url", required=True)
    ap.add_argument("--out-key", required=True)
    a = ap.parse_args()

    work = Path(tempfile.mkdtemp())
    audio = fetch(a.audio_url, str(work / "audio.mp3"))
    out_path = str(work / "out.mp4")

    if a.model == "sadtalker":
        photo = fetch(a.base_video_url, str(work / "photo.png"))
        if not photo:
            sys.exit("sadtalker requires a source image via --base-video-url")
        infer_sadtalker(photo, audio, out_path)
    else:
        base = fetch(a.base_video_url, str(work / "base.mp4"))
        if not base:
            sys.exit(f"{a.model} requires a base video via --base-video-url")
        (infer_latentsync if a.model == "latentsync" else infer_musetalk)(base, audio, out_path)

    if not Path(out_path).exists():
        sys.exit("inference produced no output file")

    bucket = os.environ["R2_BUCKET"]
    r2().upload_file(out_path, bucket, a.out_key, ExtraArgs={"ContentType": "video/mp4"})
    public = os.environ.get("R2_PUBLIC_URL_BASE", "").rstrip("/")
    print(f"R2_URL={public}/{a.out_key}", flush=True)


if __name__ == "__main__":
    main()
