#!/usr/bin/env bash
#
# migrate-transfer.sh — move all repos from the personal GBGolfMatt account into
# the InnerScopeHearing org, in one run.
#
# Prereq: the GitHub CLI installed and logged in AS THE OWNER:
#   gh auth login        # authenticate as GBGolfMatt (the repo owner)
#
# Run:   bash scripts/migrate-transfer.sh
#
# Transfers to an org you own complete immediately (no acceptance step). GitHub
# auto-redirects the old URLs, so existing clones/remotes/links keep working.
#
set -uo pipefail

NEW_OWNER="InnerScopeHearing"

# The 13 app/ops repos. otchealth-claude-tools is intentionally NOT here so it can
# be moved LAST (it cuts the live Claude session's link to this repo).
REPOS=(
  iheartest
  aware-aural-rehab
  medreview
  otchealth-companion
  innerease
  flatstick
  fourvault
  fictionary
  otchealthmart-shopify
  innd-website
  otchealth-ops
  otchealth-mcp-server
  voice-agent-evals
)

command -v gh >/dev/null || { echo "ERROR: gh CLI not installed."; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "ERROR: run 'gh auth login' as GBGolfMatt first."; exit 1; }

for r in "${REPOS[@]}"; do
  printf 'Transferring %-24s -> %s ... ' "$r" "$NEW_OWNER"
  if gh api -X POST "repos/GBGolfMatt/$r/transfer" -f new_owner="$NEW_OWNER" >/dev/null 2>&1; then
    echo "ok"
  else
    echo "FAILED (transfer it manually via Settings -> Danger Zone)"
  fi
done

echo ""
echo "Done with the 13 app/ops repos."
echo "Move this repo LAST, then open a fresh Claude session from its new home:"
echo "  gh api -X POST repos/GBGolfMatt/otchealth-claude-tools/transfer -f new_owner=$NEW_OWNER"
