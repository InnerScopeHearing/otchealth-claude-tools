"""Avatar backends.

azure (default): ensure the GPU VM is running, then trigger the one-shot
inference container on the VM via `az vm run-command invoke`. No inbound port
is opened; everything goes through the Azure control plane. The container pulls
inputs from R2, runs the model, and uploads the finished clip back to R2. The
clip URL is deterministic from its R2 key.

fal (fallback): submit the job to fal.ai (paid) for hero shots.
"""
import json
import shlex
import subprocess
import time

import requests

import config
import storage


# ----------------------------- Azure VM control -----------------------------
def _az(args):
    proc = subprocess.run(["az", *args, "--only-show-errors", "-o", "json"],
                          capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"az {' '.join(args[:3])} failed: {proc.stderr[-400:]}")
    return json.loads(proc.stdout) if proc.stdout.strip() else {}


def vm_power_state():
    data = _az(["vm", "get-instance-view", "-g", config.AZURE_RG, "-n", config.AZURE_VM_NAME])
    for s in data.get("instanceView", {}).get("statuses", []):
        if s.get("code", "").startswith("PowerState/"):
            return s["code"].split("/", 1)[1]
    return "unknown"


def start_vm():
    if vm_power_state() == "running":
        print("[azure] VM already running")
        return
    print("[azure] starting VM ...")
    _az(["vm", "start", "-g", config.AZURE_RG, "-n", config.AZURE_VM_NAME])
    print("[azure] VM started")


def deallocate_vm():
    print("[azure] deallocating VM (stops billing) ...")
    _az(["vm", "deallocate", "-g", config.AZURE_RG, "-n", config.AZURE_VM_NAME])
    print("[azure] VM deallocated")


def wait_until_ready(timeout=600):
    """Confirm run-command can reach the VM (it is booted and the agent is up)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            out = _run_command("echo ready")
            if "ready" in out:
                print("[azure] VM reachable via run-command")
                return True
        except Exception:
            pass
        time.sleep(15)
    raise RuntimeError("VM did not become reachable via run-command in time")


def _run_command(script):
    proc = subprocess.run(
        ["az", "vm", "run-command", "invoke", "-g", config.AZURE_RG, "-n", config.AZURE_VM_NAME,
         "--command-id", "RunShellScript", "--scripts", script, "--only-show-errors", "-o", "json"],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"run-command failed: {proc.stderr[-400:]}")
    data = json.loads(proc.stdout)
    msgs = data.get("value", [])
    return "\n".join(m.get("message", "") for m in msgs)


# ----------------------------- Clip generation ------------------------------
def generate_clip_azure(base_video_url, audio_url, out_key, model):
    """Run the inference container on the VM for one segment. Returns R2 URL."""
    docker = (
        "docker run --rm --gpus all "
        f"-e R2_ACCOUNT_ID={shlex.quote(config.R2_ACCOUNT_ID)} "
        f"-e R2_ACCESS_KEY_ID={shlex.quote(config.R2_ACCESS_KEY_ID)} "
        f"-e R2_SECRET_ACCESS_KEY={shlex.quote(config.R2_SECRET_ACCESS_KEY)} "
        f"-e R2_BUCKET={shlex.quote(config.R2_BUCKET)} "
        f"-e R2_PUBLIC_URL_BASE={shlex.quote(config.R2_PUBLIC_URL_BASE)} "
        "-v /mnt/weights:/app/weights "
        f"{shlex.quote(config.GHCR_IMAGE)} "
        f"--model {shlex.quote(model)} "
        f"--base-video-url {shlex.quote(base_video_url or '')} "
        f"--audio-url {shlex.quote(audio_url)} "
        f"--out-key {shlex.quote(out_key)}"
    )
    out = _run_command(docker)
    print(f"[azure] inference output tail: {out[-200:]}")
    # The container uploads to R2 under out_key; the public URL is deterministic.
    return storage.public_url(out_key)


def generate_clip_fal(base_video_url, audio_url, out_key, model):
    """Paid fal.ai fallback for hero shots. Submits and polls a fal job."""
    if not config.FAL_KEY:
        raise RuntimeError("FAL_KEY not set; cannot use --backend fal.")
    # fal model slugs vary; latentsync is exposed as a fal app. Adjust as needed.
    endpoint = config.__dict__.get("FAL_LATENTSYNC_URL", "https://fal.run/fal-ai/latentsync")
    resp = requests.post(
        endpoint,
        headers={"Authorization": f"Key {config.FAL_KEY}", "Content-Type": "application/json"},
        json={"video_url": base_video_url, "audio_url": audio_url},
        timeout=900,
    )
    if not resp.ok:
        raise RuntimeError(f"fal {resp.status_code}: {resp.text[:300]}")
    data = resp.json()
    video = (data.get("video") or {}).get("url") or data.get("video_url")
    if not video:
        raise RuntimeError(f"fal returned no video url: {json.dumps(data)[:300]}")
    # Mirror the result into R2 so downstream handling is uniform.
    import tempfile, os
    tmp = os.path.join(tempfile.gettempdir(), "fal_clip.mp4")
    with requests.get(video, stream=True, timeout=900) as r:
        r.raise_for_status()
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(1 << 16):
                f.write(chunk)
    return storage.upload(tmp, out_key, content_type="video/mp4")


# ----------------------------- Replicate backend ----------------------------
# No GPU quota required. Hosts LatentSync / MuseTalk / SadTalker. Interim path
# while the Azure GPU quota request is in review.
_REPLICATE_BASE = "https://api.replicate.com/v1"


def _replicate_headers():
    if not config.REPLICATE_API_TOKEN:
        raise RuntimeError("REPLICATE_API_TOKEN not set; cannot use --backend replicate.")
    return {"Authorization": f"Bearer {config.REPLICATE_API_TOKEN}", "Content-Type": "application/json"}


def replicate_upload_file(local_path):
    """Upload a local file to Replicate's files API and return its served URL."""
    with open(local_path, "rb") as fh:
        resp = requests.post(
            f"{_REPLICATE_BASE}/files",
            headers={"Authorization": f"Bearer {config.REPLICATE_API_TOKEN}"},
            files={"content": (str(local_path).split("/")[-1], fh)},
            timeout=300,
        )
    if not resp.ok:
        raise RuntimeError(f"replicate file upload {resp.status_code}: {resp.text[:300]}")
    return resp.json()["urls"]["get"]


def generate_clip_replicate(base_url, audio_url, out_key, model):
    """Run a lip-sync model on Replicate. base_url/audio_url must be public URLs."""
    slug = config.REPLICATE_MODELS.get(model)
    fields = config.REPLICATE_INPUT_FIELDS.get(model, {"video": "video", "audio": "audio"})
    inp = {fields["audio"]: audio_url}
    inp[fields.get("image") and fields["image"] or fields.get("video", "video")] = base_url

    # Resolve the model's latest version, then use the version-based predictions
    # endpoint (works for both official and community/versioned models).
    minfo = requests.get(f"{_REPLICATE_BASE}/models/{slug}", headers=_replicate_headers(), timeout=60)
    if not minfo.ok:
        raise RuntimeError(f"replicate model lookup {minfo.status_code} for {slug}: {minfo.text[:200]}")
    version = (minfo.json().get("latest_version") or {}).get("id")
    if not version:
        raise RuntimeError(f"replicate model {slug} has no runnable version")

    resp = requests.post(
        f"{_REPLICATE_BASE}/predictions",
        headers={**_replicate_headers(), "Prefer": "wait"},
        json={"version": version, "input": inp},
        timeout=120,
    )
    if not resp.ok:
        raise RuntimeError(f"replicate create {resp.status_code}: {resp.text[:400]}")
    pred = resp.json()

    # Poll if not finished from the Prefer: wait hint.
    for _ in range(240):
        status = pred.get("status")
        if status in ("succeeded", "failed", "canceled"):
            break
        time.sleep(5)
        get_url = pred.get("urls", {}).get("get")
        pred = requests.get(get_url, headers=_replicate_headers(), timeout=60).json()

    if pred.get("status") != "succeeded":
        raise RuntimeError(f"replicate {model} {pred.get('status')}: {str(pred.get('error'))[:300]}")
    out = pred.get("output")
    url = out[-1] if isinstance(out, list) else out
    if not url:
        raise RuntimeError("replicate succeeded but returned no output url")
    return url


def generate_clip(backend, base_video_url, audio_url, out_key, model):
    if backend == "replicate":
        return generate_clip_replicate(base_video_url, audio_url, out_key, model)
    if backend == "fal":
        return generate_clip_fal(base_video_url, audio_url, out_key, model)
    return generate_clip_azure(base_video_url, audio_url, out_key, model)
