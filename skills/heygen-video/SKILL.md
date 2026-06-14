---
name: heygen-video
description: Land a HeyGen video into an app repo from just a HeyGen SHARE LINK. Resolves the rendered MP4 via the HeyGen MCP (subscription, not the paid API, so no generation credits), re-encodes it to the app standard under GitHub's size limit, and commits it via Git LFS. Use when Matt or an app agent provides a HeyGen share link (e.g. https://app.heygen.com/videos/...-<id>) and a destination path like www/assets/video/composed/<name>.mp4. Wielded by the CTO and any app-building agent (iHEARtest, AWARE, Companion, etc.).
---

# HeyGen video -> repo (the standardized one-off flow)

Goal: Matt provides ONLY a HeyGen share link (+ where it goes). The agent pulls it
properly, re-encodes it to the right size, and uploads it to GitHub via Git LFS. No
manual download, no guesswork on encode settings, no oversized commits.

## Inputs
- A HeyGen SHARE LINK or video id. The id is the trailing 32-hex chars of the link,
  e.g. `https://app.heygen.com/videos/iheartest-final-welcome-video-b0023bb9fef541eb889f58287ce7b9e7`
  -> id `b0023bb9fef541eb889f58287ce7b9e7`.
- A destination repo path, e.g. `www/assets/video/composed/founder-welcome.mp4`.
- The branch to commit to (the app's working `claude/*` branch).

## Procedure

1. **Parse the id** from the share link: the last 32 hex characters.

2. **Resolve the download URL via the HeyGen MCP (subscription path, NOT the paid API).**
   Call `mcp__HeyGen__get_video` with `video_id=<id>`. Confirm `status: completed`, then
   take `video_url` (a time-limited signed URL). This is a READ of an already-rendered
   video, so it consumes no generation credits. NEVER wire HeyGen *generation* through the
   paid API / n8n (that bills); generation happens in the HeyGen app on the subscription.

3. **Download + re-encode to size** with the bundled helper (installs a static ffmpeg if
   missing, escalates CRF, falls back to 720-wide until the output is <= 24 MB):
   ```
   bash ~/.claude/skills/heygen-video/heygen-encode.sh "<video_url>" <dest_path>
   ```
   Standard encode (matches the per-video `*.meta.json`): libx264 CRF25 / preset slow /
   `-profile:v high` / yuv420p / `hqdn3d=1.5:1.5:6:6` / aac mono 44100 Hz 96k / `+faststart`.
   Target <= 24 MB (under GitHub's 25 MB). The helper prints the final size + CRF used.

4. **Make sure Git LFS handles it.** Most app repos already track video as LFS
   (`.gitattributes`: `www/assets/video/**/*.mp4 filter=lfs diff=lfs merge=lfs -text`).
   - If git-lfs is not installed in the sandbox, install the static binary:
     ```
     curl -fsSL https://github.com/git-lfs/git-lfs/releases/download/v3.6.1/git-lfs-linux-amd64-v3.6.1.tar.gz -o /tmp/gitlfs.tgz
     tar xf /tmp/gitlfs.tgz -C /tmp && cp /tmp/git-lfs-3.6.1/git-lfs /usr/local/bin/git-lfs
     ```
   - In the repo: `git lfs install --local`. If the dest path is NOT already an LFS rule,
     add one to `.gitattributes` and `git add .gitattributes`.

5. **Commit + push** on the app's branch:
   ```
   git add <dest_path>
   git lfs status        # confirm the staged blob is an LFS pointer (oid + size), not raw bytes
   git commit -m "assets: land HeyGen video -> <dest_path>"
   git push origin <branch>     # the LFS object uploads during push
   ```

6. **Verify + update meta.** Confirm `ls -lh` shows the real size (not a ~133-byte pointer),
   `git lfs ls-files` lists it, and (if a `*.meta.json` sits next to it) its `duration_s` /
   video / audio fields match the actual file (`ffmpeg -i <dest>` to read them).

## Notes / guardrails
- **Subscription, not the paid API.** Use the HeyGen MCP `get_video` to resolve the URL.
- **Builds are Depot only** (Codemagic retired). The web bundle (incl. the video) bakes into
  the IPA on the next Depot build; iOS builds are CTO-dispatched. Merging the PR does not ship
  it until the CTO dispatches the build.
- **CI alternative (no agent in the loop):** the `heygen-video` GitHub Action
  (`.github/workflows/heygen-video.yml`, first added to iHEARtest) does steps 2-5 automatically
  from a video id/URL + dest path. It needs a `HEYGEN_API_KEY` repo secret (the API is fine for
  `video.get`, a read). Use the Action for routine drops; use this skill for one-offs / new repos.
- **Never** commit a raw MP4 outside LFS, and never exceed ~24 MB without scaling/trimming.
