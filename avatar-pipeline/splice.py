"""FFmpeg concatenation of per-segment clips into one clean MP4."""
import subprocess
from pathlib import Path

import config


def _run(args):
    proc = subprocess.run(args, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {proc.stderr[-500:]}")
    return proc


def concat_clips(clip_paths, out_path=None):
    """Concatenate MP4 clips in order. Re-encodes for a safe, clean join.

    Uses the concat demuxer with a file list. Re-encoding (not stream copy)
    avoids timestamp and codec-mismatch glitches at segment boundaries.
    """
    if not clip_paths:
        raise RuntimeError("no clips to concatenate")
    out_path = Path(out_path or (config.OUTPUT_DIR / "final.mp4"))
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if len(clip_paths) == 1:
        _run(["ffmpeg", "-y", "-i", str(clip_paths[0]), "-c:v", "libx264", "-c:a", "aac",
              "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out_path)])
        return out_path

    list_file = config.OUTPUT_DIR / "concat_list.txt"
    list_file.write_text("".join(f"file '{Path(p).resolve()}'\n" for p in clip_paths))
    _run([
        "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(list_file),
        "-c:v", "libx264", "-c:a", "aac", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", str(out_path),
    ])
    return out_path


def ffmpeg_available():
    try:
        subprocess.run(["ffmpeg", "-version"], capture_output=True, check=True)
        return True
    except Exception:
        return False
