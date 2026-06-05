"""Cloudflare R2 upload and download via boto3 (S3-compatible).

R2 exposes an S3 API at https://<account_id>.r2.cloudflarestorage.com. Public
read URLs are served from R2_PUBLIC_URL_BASE (a public bucket domain or a custom
domain bound to the bucket).
"""
from pathlib import Path

import config

_client = None


def client():
    global _client
    if _client is None:
        # Lazy import so the no-R2 paths (e.g. Replicate quick_render) do not require boto3.
        import boto3
        from botocore.config import Config
        if not (config.R2_ENDPOINT and config.R2_ACCESS_KEY_ID and config.R2_SECRET_ACCESS_KEY):
            raise RuntimeError("R2 credentials are not fully configured (need R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY).")
        _client = boto3.client(
            "s3",
            endpoint_url=config.R2_ENDPOINT,
            aws_access_key_id=config.R2_ACCESS_KEY_ID,
            aws_secret_access_key=config.R2_SECRET_ACCESS_KEY,
            config=Config(signature_version="s3v4", retries={"max_attempts": 3}),
            region_name="auto",
        )
    return _client


def public_url(key):
    return f"{config.R2_PUBLIC_URL_BASE}/{key}"


def upload(local_path, key, content_type=None):
    """Upload a local file to R2 under key. Returns the public URL."""
    extra = {"ContentType": content_type} if content_type else {}
    client().upload_file(str(local_path), config.R2_BUCKET, key, ExtraArgs=extra or None)
    print(f"[r2] uploaded {Path(local_path).name} -> {key}")
    return public_url(key)


def download(key, local_path):
    """Download an R2 object by key to local_path."""
    Path(local_path).parent.mkdir(parents=True, exist_ok=True)
    client().download_file(config.R2_BUCKET, key, str(local_path))
    print(f"[r2] downloaded {key} -> {Path(local_path).name}")
    return local_path
