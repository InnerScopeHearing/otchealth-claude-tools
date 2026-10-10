#!/usr/bin/env bash
# run-owner-script-tests.sh: tests for the owner scripts that a person runs once, by hand, in AWS CloudShell:
#   setup/iam/aws-ai-access-2026-10-07.sh      (read-only AI sign-in, and the gateway's AWS read bridge)
#   setup/aws/ops-alarms-2026-10-07.sh         (gateway and brain alarms)
#   setup/iam/fleet-monitor-grant-2026-10-07.sh (checked for syntax and lint only; it has no ECS lookup to test)
#
# WHAT IT DOES: syntax and lint checks on the scripts and on these test files, then runs each script from start to
# finish against a PRETEND AWS account (fake-aws.py). It never reaches a real AWS account: the pretend `aws` is first
# on PATH, every run gets an empty home folder, and no AWS credentials are passed in.
#
# Run it with:  bash setup/aws/tests/run-owner-script-tests.sh
# tests/owner-aws-scripts.test.mjs runs it too, so run-tests.sh and the CI workflow "tests" run it on every PR.
# Optional environment variables, to try the tests on other copies of the scripts (for example the previous version):
#   OWNER_AI_SCRIPT, OWNER_ALARMS_SCRIPT, OWNER_GRANT_SCRIPT   paths of the scripts to test
#   OWNER_SHELLCHECK_SEVERITY                                  shellcheck -S level (default warning)
# Exit code: 0 when every check passed, 1 when anything failed.
# shellcheck source-path=SCRIPTDIR
set -u

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$HERE/../../.." && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

AI="${OWNER_AI_SCRIPT:-$ROOT/setup/iam/aws-ai-access-2026-10-07.sh}"
ALARMS="${OWNER_ALARMS_SCRIPT:-$ROOT/setup/aws/ops-alarms-2026-10-07.sh}"
GRANT="${OWNER_GRANT_SCRIPT:-$ROOT/setup/iam/fleet-monitor-grant-2026-10-07.sh}"
SEVERITY="${OWNER_SHELLCHECK_SEVERITY:-warning}"
trap cleanup_sandboxes EXIT

for needed in python3 mktemp; do
  if ! command -v "$needed" >/dev/null 2>&1; then
    echo "FAILED  this test needs $needed, and it was not found"
    exit 1
  fi
done
for script in "$AI" "$ALARMS" "$GRANT"; do
  if [ ! -f "$script" ]; then
    echo "FAILED  the script to test is missing: $script"
    exit 1
  fi
done

short() { printf '%s' "${1#"$ROOT"/}"; }
flat() { printf '%s' "$1" | head -n 12 | tr '\n' ' '; }

SCRIPT_FILES=("$AI" "$ALARMS" "$GRANT")
HARNESS_FILES=("$HERE/lib.sh" "$HERE/run-owner-script-tests.sh" "$HERE/test-aws-ai-access.sh" "$HERE/test-ops-alarms.sh")

echo "== static checks =="
for f in "${SCRIPT_FILES[@]}" "${HARNESS_FILES[@]}"; do
  t_begin "bash -n $(short "$f")"
  if ! err="$(bash -n "$f" 2>&1)"; then t_note "$(flat "$err")"; fi
  t_end
done

t_begin "fake-aws.py parses"
if ! err="$(python3 -I -c 'import ast, sys; ast.parse(open(sys.argv[1]).read())' "$HERE/fake-aws.py" 2>&1)"; then t_note "$(flat "$err")"; fi
t_end

if command -v shellcheck >/dev/null 2>&1; then
  for f in "${SCRIPT_FILES[@]}" "${HARNESS_FILES[@]}"; do
    t_begin "shellcheck -S $SEVERITY $(short "$f")"
    if ! err="$(shellcheck -S "$SEVERITY" "$f" 2>&1)"; then t_note "$(flat "$err")"; fi
    t_end
  done
else
  echo "skipped  shellcheck is not installed here, so the lint checks were not run"
fi

# The bug these tests were written for: the scripts looked for an ECS service called just "otchealth". The gateway's
# service is otchealth-gateway (infra/aws/ecs-gateway.tf in otchealth-mcp-server). Keep the old name out of the scripts.
t_begin "the old wrong ECS service name is gone from the three owner scripts"
for f in "${SCRIPT_FILES[@]}"; do
  if hits="$(grep -nE 'ECS_SERVICE="otchealth"|ECS_SERVICE=otchealth([^-A-Za-z0-9_]|$)|service otchealth([^-A-Za-z0-9_]|$)' "$f")"; then
    t_note "$(short "$f") still names the service otchealth: $(flat "$hits")"
  fi
done
t_end

echo "== aws-ai-access: scenarios against the pretend account =="
# shellcheck source=test-aws-ai-access.sh
. "$HERE/test-aws-ai-access.sh"

echo "== ops-alarms: scenarios against the pretend account =="
# shellcheck source=test-ops-alarms.sh
. "$HERE/test-ops-alarms.sh"

echo ""
echo "owner-script tests: $T_PASSED passed, $T_FAILED failed"
if [ "$T_FAILED" -gt 0 ]; then
  printf '  failed: %s\n' "${T_FAILED_NAMES[@]}"
  exit 1
fi
exit 0
