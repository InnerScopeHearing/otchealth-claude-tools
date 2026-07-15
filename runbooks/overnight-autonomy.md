# Tier-2 autonomous runners (timed and overnight) plus the Bedrock overflow lane

The Fleet Intelligence "Tier-2" standard: on-demand or scheduled headless `claude -p` runners that
draw the Claude Max plan subscription (zero metered API spend under normal operation), open draft
PRs as they go, and never push to `main`. This file is the canonical doc referenced by both
workflow files, `dream-team/FLEET-TOOLKIT-REFERENCE.md`, and the CTO's dated notes; keep it current
as the mechanism changes.

## The two runners

- **`.github/workflows/autonomous-run.yml`** ("Autonomous Run (timed)"): dispatch-only, takes a
  `task` and a `minutes` budget (max 345), and loops `claude -p --continue` iterations until the
  time budget is spent. Least privilege by design: only Claude auth plus the repo's own scoped
  `GITHUB_TOKEN` (no Secret Manager, no other repos).
- **`.github/workflows/overnight-agent.yml`** ("Overnight Agent"): the same pattern, one task
  prompt per invocation, and can also run on a cron schedule (currently `0 9 * * *`, about 02:00
  Pacific). Per the workflow's own header comment, `CLAUDE_CODE_OAUTH_TOKEN` was set 2026-06-22 and
  the schedule is armed.

Both are documented in more depth in the otchealth-cto CTO's fleet-wide CLAUDE.md, under "Fleet
autonomy: browser-agent (#4) + overnight/timed runners"; this file is the working runbook, not a
duplicate of that narrative.

## Setup (one time, Matt)

`claude setup-token` must be run interactively in a browser-attached shell (a cloud sandbox cannot
mint it headlessly; do not re-attempt headless minting). The resulting one-year token is stored as
the `CLAUDE_CODE_OAUTH_TOKEN` repository secret. Until that secret exists, both workflows refuse to
run rather than silently falling back to a metered path (see Auth selection below).

## Safety rails, common to both runners

- Hard rules handed to the agent every iteration: work only on `claude/*` branches and open or
  update draft PRs, never touch PHI or INND/HearingAssist financial or securities content, stop at
  any payment/KYC/account-login/e-signature gate, prefer small reversible changes, run tests before
  committing.
- **Safety-net step** (`if: always()`): if the agent leaves work uncommitted, or commits but never
  pushes, this step captures whatever is in the working tree onto a `claude/autonomous-<run-id>` or
  `claude/overnight-<run-id>` branch and opens a draft PR. It never pushes the default branch, even
  if the agent committed there locally. Regression-tested in `tests/autonomy-runner.test.mjs`.
- `set -o pipefail` guards the `claude -p ... | tee` line in both runners so a failed iteration is
  actually observed rather than swallowed by the pipe (see `tests/workflow-exit-codes.test.mjs`,
  the class guard for this exact failure family).

## Auth selection (`setup/select-agent-auth.sh`)

Both runners source `setup/select-agent-auth.sh` as their first real step. It picks the auth plane
for that run, in priority order, and never lets a fallback plane become a silent default:

1. **`CLAUDE_CODE_OAUTH_TOKEN` present** (the normal path): subscription auth on the Max plan.
   `ANTHROPIC_API_KEY` is defensively unset so a stray metered key can never be used instead. This
   branch always wins when the token is present, even if the Bedrock opt-in below is also set.
2. **Else, the AWS Bedrock overflow lane** (Phase 6 AI-OS, opt-in): see the dedicated section below.
3. **Else**: the step fails loudly with a `::error::` annotation and a non-zero exit, exactly the
   behavior of the original inline guard it replaced. The run never proceeds to `claude -p` with no
   credentials at all.

The selection logic is pure-function testable and covered by `tests/select-agent-auth.test.mjs`
(13 cases: each branch, the opt-in-alone and creds-alone failure cases, the OAuth-always-wins
regression guard, and the `GITHUB_ENV` propagation for the next step).

## AWS Bedrock overflow lane (Phase 6 AI-OS)

**What it is.** A bounded, credit-funded fallback for when the shared weekly Max-plan limit is
exhausted mid-run. `CLAUDE_CODE_USE_BEDROCK=1` plus AWS credentials routes Claude Code through
Amazon Bedrock instead of the Anthropic API directly (official mechanism, see
`https://code.claude.com/docs/en/amazon-bedrock`). This is a **different billing plane, not a
second agent runtime**: it draws AWS IAM TPM/RPM service quota (raisable by request, no weekly
cap), separate from both the Max subscription and the Anthropic direct API. Per-token pricing on
Bedrock is identical to Anthropic direct, so the lane is only a genuine win while AWS credit
covers it; after the credit is exhausted it is a cash-identical redundancy path, not a discount.

**Current state: ships inert.** As of this writing no AWS IAM key or role is provisioned for the
fleet (a Matt physical gate: an AWS account, an IAM principal, and a decision on the credential
shape). `setup/select-agent-auth.sh` only activates the Bedrock branch when BOTH of the following
are true at once, so the code path is correct and tested but dormant in production:

- The `allow_bedrock_overflow` workflow input is `true` (default `false`; on the `overnight-agent`
  schedule trigger, which carries no inputs at all, this always resolves to `false`).
- At least one AWS credential form is present: `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`,
  `AWS_PROFILE`, or `AWS_BEARER_TOKEN_BEDROCK`.

**Provisioning path (when Matt is ready).** Two options, in preference order:

1. **Recommended, OIDC role-assume** (no long-lived key in GitHub secrets at all): each workflow
   has a commented-out `aws-actions/configure-aws-credentials` step, pinned by commit SHA, that
   assumes an IAM role via GitHub's OIDC provider. Provisioning steps: create the IAM role with a
   trust policy scoped to this repo's OIDC subject, grant it `bedrock:InvokeModel` and
   `bedrock:InvokeModelWithResponseStream` on the target model/inference-profile ARNs, store the
   role ARN as the `AWS_BEDROCK_ROLE_ARN` secret and the region as `AWS_BEDROCK_REGION`, then
   uncomment both the step and the job's `id-token: write` permission.
2. **Simpler fallback, a Bedrock API key**: store a single `AWS_BEARER_TOKEN_BEDROCK` secret (per
   AWS's own "simpler authentication method without needing full AWS credentials"). No IAM role,
   no OIDC wiring, one secret. The classic `AWS_BEDROCK_ACCESS_KEY_ID` / `AWS_BEDROCK_SECRET_ACCESS_KEY`
   pair (mapped to `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` in the job env) is the last-resort
   long-lived-key option if neither of the above fits.

**Arming a run.** Once credentials exist, dispatch either workflow with `allow_bedrock_overflow:
true`. If `CLAUDE_CODE_OAUTH_TOKEN` is unavailable (unset, revoked, or the Max weekly window is
exhausted and the token deliberately withheld for that run) and the AWS credentials resolve, the
run proceeds on Bedrock; the workflow log's "Select agent auth" step prints
`AGENT_AUTH_MODE=bedrock-overflow` so this is visible after the fact.

**Rotation.** Add whichever secret form is provisioned (`AWS_BEDROCK_ROLE_ARN`,
`AWS_BEARER_TOKEN_BEDROCK`, or the access-key pair) to the fleet's ROTATE-BEFORE-LAUNCH list in
`otchealth-cto/CLAUDE.md` at provisioning time.

## Known gaps, not addressed here

- No automatic detection of "the Max weekly limit was hit" to auto-set `allow_bedrock_overflow`;
  today it is a manual dispatch decision per the CTO/Matt.
- No cost/usage telemetry wired for the Bedrock lane specifically (fleet-telemetry's Lane-A burn
  meter covers the Max plan; a Bedrock-lane meter is future work if the lane is armed for real use).
