# Inference image for the avatar pipeline. Default model: LatentSync.
# Build/push is done by the build-image GitHub Actions workflow to GHCR.
# Building needs no GPU; running needs --gpus all on the Azure VM.
#
# MuseTalk and SadTalker can be built as sibling images by swapping the repo
# clone + weights steps and tagging the image per model (see README).

FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1 WEIGHTS_DIR=/app/weights
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3.10 python3-pip python3.10-venv git ffmpeg wget ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3.10 /usr/bin/python

WORKDIR /app

# --- Default model: LatentSync (ByteDance, Apache-2.0 + OpenRAIL++) ---
RUN git clone --depth 1 https://github.com/bytedance/LatentSync.git /app/LatentSync
RUN pip install --no-cache-dir -r /app/LatentSync/requirements.txt || true
RUN pip install --no-cache-dir boto3 requests

# Weights are large; they are downloaded on first run into the mounted
# /app/weights volume (persisted on the VM data disk) rather than baked in.
# LatentSync weights come from its HuggingFace repo; see README.
COPY entrypoint.py /app/entrypoint.py

ENTRYPOINT ["python", "/app/entrypoint.py"]
