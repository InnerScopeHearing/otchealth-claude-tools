"""End-to-end orchestrator for the avatar pipeline.

Runs on a GitHub-hosted Ubuntu runner. Flow:
  1. read script
  2. ElevenLabs TTS, split into <=60s sentence-boundary segments
  3. upload audio segments and the presenter base video to R2
  4. (azure backend) start the GPU VM, wait until reachable
  5. per segment, trigger inference via az vm run-command -> clip in R2
  6. download clips, FFmpeg concat into final.mp4
  7. upload final.mp4 to R2, write Notion row
  8. deallocate the VM (the workflow also does this in an always() step)

Usage:
  python orchestrate.py --script scripts/demo.md \
     --model latentsync --backend azure --base-video presenter.mp4
"""
import argparse
import sys
import time
from pathlib import Path

import config
import voiceover
import storage
import splice
import avatar
import notion_log


def _read_script(script_arg):
    p = Path(script_arg)
    if not p.exists():
        p = config.SCRIPTS_DIR / script_arg
    if p.exists():
        return p.read_text(encoding="utf-8").strip(), p.stem
    # treat the argument itself as inline script text
    return script_arg.strip(), "inline-script"


def _resolve_base_video(base_video, run_id):
    """Return a public R2 URL for the base video, uploading a local path if needed."""
    if not base_video:
        return None
    if base_video.startswith("http://") or base_video.startswith("https://"):
        return base_video
    key = f"avatar/{run_id}/base{Path(base_video).suffix or '.mp4'}"
    return storage.upload(base_video, key, content_type="video/mp4")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--script", required=True, help="script text, or a path (also looks under scripts/)")
    ap.add_argument("--model", default=config.DEFAULT_MODEL, choices=config.VALID_MODELS)
    ap.add_argument("--backend", default=config.DEFAULT_BACKEND, choices=config.VALID_BACKENDS)
    ap.add_argument("--base-video", default=None, help="presenter base video (local path or URL) for latentsync/musetalk")
    ap.add_argument("--title", default=None)
    ap.add_argument("--no-deallocate", action="store_true", help="leave VM running (workflow always() still deallocates)")
    args = ap.parse_args()

    # CHECKPOINT 2 enforcement: relip-sync models require a base video.
    if args.model in config.BASE_VIDEO_MODELS and not args.base_video:
        sys.exit(f"ERROR: model '{args.model}' needs a presenter base video. "
                 f"Pass --base-video, or use --model sadtalker with a photo.")

    script_text, slug = _read_script(args.script)
    run_id = f"{slug}-{int(time.time())}"
    title = args.title or slug
    print(f"[run] {run_id} | model={args.model} backend={args.backend}")

    if not splice.ffmpeg_available():
        sys.exit("ERROR: ffmpeg not found on PATH.")

    status = "failed"
    gpu_minutes = 0.0
    final_url = ""
    artifact = f"final.mp4 (GitHub Actions artifact: {run_id})"
    segments = []
    vm_started = False
    t_gpu_start = None

    try:
        # 1-2. voiceover
        audio_paths = voiceover.generate_voiceover(script_text)
        segments = audio_paths

        # 3. upload audio + base video
        audio_urls = []
        for i, ap_path in enumerate(audio_paths):
            key = f"avatar/{run_id}/audio_{i:03d}.mp3"
            audio_urls.append(storage.upload(ap_path, key, content_type="audio/mpeg"))
        base_video_url = _resolve_base_video(args.base_video, run_id)

        # 4. start GPU (azure backend only)
        if args.backend == "azure":
            avatar.start_vm()
            vm_started = True
            t_gpu_start = time.time()
            avatar.wait_until_ready()

        # 5. per-segment inference
        clip_paths = []
        for i, audio_url in enumerate(audio_urls):
            out_key = f"avatar/{run_id}/clip_{i:03d}.mp4"
            print(f"[infer] segment {i+1}/{len(audio_urls)} via {args.backend}/{args.model}")
            clip_url = avatar.generate_clip(args.backend, base_video_url, audio_url, out_key, args.model)
            local_clip = config.CLIPS_DIR / f"clip_{i:03d}.mp4"
            # derive the R2 key from the known out_key for the download
            storage.download(out_key, local_clip)
            clip_paths.append(local_clip)

        # 6. splice
        final_path = splice.concat_clips(clip_paths, config.OUTPUT_DIR / "final.mp4")
        print(f"[splice] -> {final_path}")

        # 7. publish + log
        final_key = f"avatar/{run_id}/final.mp4"
        final_url = storage.upload(final_path, final_key, content_type="video/mp4")
        status = "success"
    except Exception as e:
        print(f"[error] {e}")
        status = "partial" if final_url else "failed"
        raise
    finally:
        if vm_started and t_gpu_start:
            gpu_minutes = (time.time() - t_gpu_start) / 60.0
        est_cost = gpu_minutes / 60.0 * config.AZURE_SKU_HOURLY_USD
        # 8. deallocate (defense in depth; the workflow always() step also does this)
        if args.backend == "azure" and vm_started and not args.no_deallocate:
            try:
                avatar.deallocate_vm()
            except Exception as de:
                print(f"[warn] deallocate failed (workflow always() step will retry): {de}")
        # Notion render row (best effort)
        try:
            notion_log.log_render(
                title=title, model=args.model, backend=args.backend,
                segments=len(segments), gpu_minutes=gpu_minutes, est_cost_usd=est_cost,
                status=status, r2_url=final_url, artifact=artifact,
            )
        except Exception as ne:
            print(f"[warn] notion log failed: {ne}")
        print(f"[cost] GPU minutes ~{gpu_minutes:.1f} | est ${est_cost:.2f} | "
              f"REMINDER: check remaining Azure credit in the portal.")
        if final_url:
            print(f"[done] final video: {final_url}")


if __name__ == "__main__":
    main()
