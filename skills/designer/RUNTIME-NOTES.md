# Runtime notes (Claude Code vs Hyperagent)

The `designer` skill runs on two engines. The scripts are identical; only the launch wrapper differs.

## Claude Code (canonical)
Credentials come from env + GCP Secret Manager (see README). `GOOGLE_APPLICATION_CREDENTIALS` and `GOOGLE_CLOUD_PROJECT` are set normally and Node's fetch reaches the network directly. Run scripts directly: `node scripts/gen-image.mjs ...`.

## Hyperagent (mirror CTO)
Hyperagent injects credentials per-skill and uses a small `ha-run.sh` wrapper (Hyperagent-side only) that: sets `NODE_USE_ENV_PROXY=1` so Node 24 fetch uses the sandbox proxy; maps `GCP_CLAUDE_DRIVER_SA_JSON` (accepts base64) + `GCP_PROJECT_ID` to `GOOGLE_APPLICATION_CREDENTIALS` (temp file) + `GOOGLE_CLOUD_PROJECT` because the `GOOGLE_*` names are reserved there; and installs the bundled default brand profile. Claude Code does not need any of this.

## Shared default flow (both engines)
Image/vision/video default to **Azure OpenAI when configured** (to spend the Azure grant), falling back to direct OpenAI / Vertex Veo otherwise. Per-call overrides: `--provider openai`, `--engine openai|veo`. Azure resource/endpoint/deployment specifics live in the private Notion vault "Azure OpenAI" entry, never in this public repo.
