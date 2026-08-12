#!/usr/bin/env bash
# select-agent-auth.sh -- Phase 6 AI-OS: pick the auth plane for a Tier-2 headless `claude -p`
# runner, in priority order, and NEVER let the AWS Bedrock overflow lane become a silent default.
# Extracted out of the inline Guard step in .github/workflows/autonomous-run.yml and
# overnight-agent.yml so the selection logic is unit testable. See runbooks/overnight-autonomy.md.
#
# BRANCHES (first match wins):
#   (a) CLAUDE_CODE_OAUTH_TOKEN is set -> subscription auth (the Max plan, zero metered spend).
#       Always wins when present, unconditionally, even if ALLOW_BEDROCK_OVERFLOW and AWS creds
#       are also present. Unsets ANTHROPIC_API_KEY defensively. Never touches Bedrock.
#   (b) else, if the explicit opt-in ALLOW_BEDROCK_OVERFLOW is "true" or "1" AND AWS credentials
#       are present (any of: AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY, AWS_PROFILE, or
#       AWS_BEARER_TOKEN_BEDROCK) -> export CLAUDE_CODE_USE_BEDROCK=1, unset ANTHROPIC_API_KEY.
#       This is metered Bedrock usage, a DIFFERENT auth/billing plane from both the Max
#       subscription and the Anthropic direct API: it draws AWS IAM TPM/RPM quota, not the shared
#       weekly Max cap. It is credit funded (AWS Activate credit granted 2026-07-xx per the ledger,
#       see the CTO's dated notes) so tokens are free while the credit lasts; after that it is
#       cash-identical per-token pricing to Anthropic direct, so it is purely a redundancy lane,
#       never a cost win on its own.
#   (c) else -> fail loudly with a clear message and a non-zero exit. This is the ONLY
#       auth-required failure mode and matches the original inline Guard step's behavior exactly.
#
# INERT BY DESIGN: branch (b) requires BOTH the opt-in input AND real AWS credentials to be
# present at the same time. As of this writing no AWS IAM key is provisioned for the fleet (a
# Matt gate), so branch (b) never fires in production; the code path is correct and tested, but
# dormant until Matt provisions AWS_BEARER_TOKEN_BEDROCK (or an IAM role/key pair) and a workflow
# run is dispatched with allow_bedrock_overflow=true.
#
# USAGE
#   SOURCE this file (do not execute it) as the first line of the run step that then invokes
#   `claude -p ...`, or as a standalone early step, so its export/unset apply to that shell:
#     source setup/select-agent-auth.sh
#   Direct execution (`bash setup/select-agent-auth.sh`) is also supported, for local inspection
#   or tests that assert on stdout / the GITHUB_ENV side effect rather than on a parent shell's
#   live environment (a plain execution runs in a subprocess, so export/unset there do not
#   propagate back to the caller, only to that subprocess).
#
# INPUTS (env)
#   CLAUDE_CODE_OAUTH_TOKEN    - the Max-plan subscription token. Presence alone selects branch a.
#   ALLOW_BEDROCK_OVERFLOW     - "true" or "1" opts into branch b. Anything else, including unset,
#                                "false", or "0", means Bedrock is NEVER attempted, even with
#                                valid AWS credentials present.
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY  - a long-lived or OIDC-assumed IAM credential pair
#                                (AWS_SESSION_TOKEN, if present, rides along automatically; it is
#                                not required for this check).
#   AWS_PROFILE                - a named AWS profile (SSO, or a mounted shared credentials file).
#   AWS_BEARER_TOKEN_BEDROCK   - a Bedrock API key, the simplest AWS auth option (no full IAM pair).
#   GITHUB_ENV                 - when set (a real GitHub Actions run), the CLAUDE_CODE_USE_BEDROCK
#                                decision (branch b only) is ALSO appended there, so it persists
#                                into the NEXT step even when this file is sourced in its own
#                                dedicated step rather than inline before the `claude -p` call. A
#                                no-op outside Actions, for example a local test run.
#
# OUTPUT (stdout)
#   One line: "AGENT_AUTH_MODE=oauth" or "AGENT_AUTH_MODE=bedrock-overflow" on success.
#   On failure, a GitHub-Actions-annotation-formatted "::error::..." line and exit code 1.
#
# EXIT CODE
#   0  a usable auth path was selected
#   1  neither path is usable; the caller must not proceed to `claude -p`

_agent_auth_bedrock_opt_in() {
  case "${ALLOW_BEDROCK_OVERFLOW:-}" in
    true | 1) return 0 ;;
    *) return 1 ;;
  esac
}

# Real AWS access key IDs are uppercase alphanumeric and at least 16 chars
# (AKIA... long-term, ASIA... STS, ABIA/ACCA for other principal types). A
# non-empty value is NOT sufficient evidence: the Claude Code cloud sandbox
# injects an AGENT-PROXY placeholder into AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY
# (lowercase, 14 chars, prefix "prox") that is non-empty but authenticates to
# nothing. A presence-only check therefore reports "AWS is available", selects
# bedrock-overflow, and every call then fails with InvalidClientTokenId while
# the selector claims it found working auth. This shape check is offline and
# dependency-free; it rejects the placeholder without rejecting any real key.
_agent_auth_aws_key_id_looks_real() {
  case "${1:-}" in
    *[!A-Z0-9]* | "") return 1 ;;
  esac
  [ "${#1}" -ge 16 ]
}

_agent_auth_aws_creds_present() {
  if [ -n "${AWS_ACCESS_KEY_ID:-}" ] && [ -n "${AWS_SECRET_ACCESS_KEY:-}" ] &&
    _agent_auth_aws_key_id_looks_real "${AWS_ACCESS_KEY_ID:-}"; then
    return 0
  fi
  [ -n "${AWS_PROFILE:-}" ] && return 0
  [ -n "${AWS_BEARER_TOKEN_BEDROCK:-}" ] && return 0
  return 1
}

# Pure decision: prints the chosen branch ("oauth" | "bedrock-overflow" | "none") to stdout given
# the current env, with no side effects. Exit code 0 for a usable branch, 1 for "none". Kept
# separate from agent_auth_apply so tests can exercise the decision alone.
agent_auth_select() {
  if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
    echo "oauth"
    return 0
  fi
  if _agent_auth_bedrock_opt_in && _agent_auth_aws_creds_present; then
    echo "bedrock-overflow"
    return 0
  fi
  echo "none"
  return 1
}

# Side-effecting entry point: calls agent_auth_select, applies the export/unset for the chosen
# branch to the CURRENT shell (real effect only when this file is sourced), prints
# AGENT_AUTH_MODE=..., and when GITHUB_ENV is set also persists the Bedrock flag for the next
# step. On failure, exits the process outright (see the header note on exit vs return) with a
# clear message, exactly mirroring the original inline Guard step.
agent_auth_apply() {
  mode="$(agent_auth_select)"
  case "$mode" in
    oauth)
      unset ANTHROPIC_API_KEY
      echo "AGENT_AUTH_MODE=oauth"
      ;;
    bedrock-overflow)
      unset ANTHROPIC_API_KEY
      export CLAUDE_CODE_USE_BEDROCK=1
      echo "AGENT_AUTH_MODE=bedrock-overflow"
      if [ -n "${GITHUB_ENV:-}" ]; then
        echo "CLAUDE_CODE_USE_BEDROCK=1" >>"$GITHUB_ENV"
      fi
      ;;
    *)
      echo "::error::No usable Claude Code auth path. Set CLAUDE_CODE_OAUTH_TOKEN for subscription auth (preferred, run 'claude setup-token' and add the secret), or opt into the Bedrock overflow lane with ALLOW_BEDROCK_OVERFLOW=true plus AWS credentials (AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or AWS_PROFILE, or AWS_BEARER_TOKEN_BEDROCK)." >&2
      # exit (not return) is deliberate: it terminates the current process unconditionally,
      # whether this file was sourced or executed directly, matching the original Guard step's
      # `exit 1` and guaranteeing the caller cannot silently fall through to `claude -p`.
      exit 1
      ;;
  esac
  unset mode
}

agent_auth_apply
