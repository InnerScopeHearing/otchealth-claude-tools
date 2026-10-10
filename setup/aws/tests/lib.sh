#!/usr/bin/env bash
# lib.sh: helpers for the owner-script tests. Sourced by run-owner-script-tests.sh; it is not run on its own.
# shellcheck shell=bash
#
# Each test gets its own sandbox: a pretend `aws` (fake-aws.py) first on PATH, a pretend `sleep` that returns at once,
# an empty HOME and TMPDIR, and no AWS credentials at all (env -i), so even a mistake here could not reach a real account.
# The pretend account is changed per test with a JSON patch (see fake-aws.py). Every aws call the script made is in
# $CALLS_FILE ("R ..." for a read, "W ..." for a change); everything it printed is in $OUT_FILE.

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SAFE_PATH="/usr/local/bin:/usr/bin:/bin"
SANDBOXES=()
T_PASSED=0
T_FAILED=0
T_FAILED_NAMES=()
T_NAME=""
T_BAD=0
T_NOTES=()
SANDBOX=""
FAKE_AWS_DIR=""
OUT_FILE=""
CALLS_FILE=""
RC=0
RUN_N=0
RUN_ENV=()

cleanup_sandboxes() {
  local d
  if [ "${#SANDBOXES[@]}" -gt 0 ]; then
    for d in "${SANDBOXES[@]}"; do rm -rf "$d"; done
  fi
}

# register_sandbox DIR: DIR is removed with the sandboxes when the tests end (for a folder a test makes for its own use).
register_sandbox() { SANDBOXES+=("$1"); }

# new_world [PATCH_JSON]: a fresh sandbox with a pretend account (changed by the patch, if one is given).
new_world() {
  local patch="${1:-}"
  if [ -z "$patch" ]; then patch="{}"; fi
  if ! python3 -I -c 'import json, sys; json.loads(sys.argv[1])' "$patch" 2>/dev/null; then
    echo "test bug: the world patch is not valid JSON: $patch" >&2
    exit 2
  fi
  SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/owner-tests.XXXXXX")"
  SANDBOXES+=("$SANDBOX")
  mkdir -p "$SANDBOX/bin" "$SANDBOX/home" "$SANDBOX/tmp" "$SANDBOX/aws"
  # shellcheck disable=SC2016  # the stub must expand $FAKE_AWS_PY when it runs, not here
  printf '%s\n' '#!/bin/sh' 'exec python3 -I -S "$FAKE_AWS_PY" "$@"' >"$SANDBOX/bin/aws"
  printf '%s\n' '#!/bin/sh' 'exit 0' >"$SANDBOX/bin/sleep"
  chmod +x "$SANDBOX/bin/aws" "$SANDBOX/bin/sleep"
  printf '%s\n' "$patch" >"$SANDBOX/aws/patch.json"
  FAKE_AWS_DIR="$SANDBOX/aws"
  CALLS_FILE="$FAKE_AWS_DIR/calls.log"
  OUT_FILE=""
  RUN_N=0
  RUN_ENV=()
  if [ "$(PATH="$SANDBOX/bin:$SAFE_PATH" command -v aws)" != "$SANDBOX/bin/aws" ]; then
    echo "test bug: the pretend aws is not the first aws on PATH" >&2
    exit 2
  fi
}

# run_owner SCRIPT [ARGS...]: runs the script with bash inside the sandbox. RUN_ENV (an array of NAME=value) adds
# environment variables. Leaves the exit code in RC, the call log in CALLS_FILE and the screen text in OUT_FILE.
# Each run starts with an empty call log (the pretend account keeps its state, so a second run sees the first one's work).
run_owner() {
  local script="$1" limit=()
  shift
  RUN_N=$((RUN_N + 1))
  OUT_FILE="$SANDBOX/out.$RUN_N.txt"
  : >"$CALLS_FILE"
  if command -v timeout >/dev/null 2>&1; then limit=(timeout 300); fi
  RC=0
  env -i PATH="$SANDBOX/bin:$SAFE_PATH" HOME="$SANDBOX/home" TMPDIR="$SANDBOX/tmp" LANG=C \
    AWS_REGION=us-east-1 AWS_PAGER="" AWS_EC2_METADATA_DISABLED=true \
    AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null \
    FAKE_AWS_DIR="$FAKE_AWS_DIR" FAKE_AWS_PY="$HERE/fake-aws.py" \
    ${RUN_ENV[@]+"${RUN_ENV[@]}"} \
    ${limit[@]+"${limit[@]}"} "$BASH" "$script" "$@" >"$OUT_FILE" 2>&1 </dev/null || RC=$?
}

# ---- test bookkeeping ----------------------------------------------------------------------------------------------
t_begin() {
  T_NAME="$1"
  T_BAD=0
  T_NOTES=()
}

t_note() {
  T_BAD=$((T_BAD + 1))
  T_NOTES+=("$1")
}

t_end() {
  local n
  # A call the pretend aws could not answer is a hole in the harness, and it always fails the test.
  if [ -n "$OUT_FILE" ] && [ -f "$OUT_FILE" ] && grep -Fq 'FAKE-AWS:' "$OUT_FILE"; then
    t_note "the pretend aws had no answer for a call: $(grep -F 'FAKE-AWS:' "$OUT_FILE" | head -n 1)"
  fi
  if [ "$T_BAD" -eq 0 ]; then
    T_PASSED=$((T_PASSED + 1))
    printf 'ok      %s\n' "$T_NAME"
  else
    T_FAILED=$((T_FAILED + 1))
    T_FAILED_NAMES+=("$T_NAME")
    printf 'FAILED  %s\n' "$T_NAME"
    for n in "${T_NOTES[@]}"; do printf '          - %s\n' "$n"; done
    if [ -n "$OUT_FILE" ] && [ -f "$OUT_FILE" ]; then
      echo "          --- the last 30 lines the script printed ---"
      tail -n 30 "$OUT_FILE" | sed 's/^/          | /'
    fi
  fi
}

# ---- assertions (each one records a note; t_end prints the verdict) ---------------------------------------------------
expect_rc() { if [ "$RC" -ne "$1" ]; then t_note "exit code was $RC, expected $1"; fi; }
expect_out_has() { if ! grep -Fq -- "$1" "$OUT_FILE"; then t_note "the output lacks: $1"; fi; }
expect_out_lacks() { if grep -Fq -- "$1" "$OUT_FILE"; then t_note "the output has this, and must not: $1"; fi; }
expect_calls_have() { if ! grep -Fq -- "$1" "$CALLS_FILE"; then t_note "no aws call contains: $1"; fi; }
expect_calls_lack() { if grep -Fq -- "$1" "$CALLS_FILE"; then t_note "an aws call contains this, and must not: $1"; fi; }
expect_no_calls() { if [ -s "$CALLS_FILE" ]; then t_note "the script made aws calls, and must not have: $(head -n 2 "$CALLS_FILE" | tr '\n' ';')"; fi; }
expect_some_writes() { if ! grep -q '^W ' "$CALLS_FILE"; then t_note "the script changed nothing, and should have"; fi; }
expect_no_writes() {
  if grep -q '^W ' "$CALLS_FILE"; then
    t_note "the script changed something (it must stop before any change): $(grep '^W ' "$CALLS_FILE" | head -n 3 | tr '\n' ';')"
  fi
}
# expect_calls_count PATTERN N: exactly N aws calls contain the fixed text PATTERN
expect_calls_count() {
  local got
  got="$(grep -Fc -- "$1" "$CALLS_FILE" || true)"
  if [ "$got" != "$2" ]; then t_note "expected $2 aws call(s) containing '$1', saw $got"; fi
}
expect_file() { if [ ! -f "$1" ]; then t_note "the file is missing: $1"; fi; }
expect_no_file() { if [ -e "$1" ]; then t_note "the file exists, and must not: $1"; fi; }
# expect_state_has KEY... TEXT: the pretend account holds TEXT (as a substring) at the given path of keys in state.json
expect_state_has() {
  local text="${*: -1}" keys=("${@:1:$#-1}")
  if ! python3 -I -c '
import json, sys
state = json.load(open(sys.argv[1]))
text = sys.argv[2]
for key in sys.argv[3:]:
    state = state[key]
sys.exit(0 if text in state else 1)
' "$FAKE_AWS_DIR/state.json" "$text" "${keys[@]}"; then
    t_note "the pretend account does not hold '$text' at ${keys[*]}"
  fi
}
expect_state_lacks() {
  local text="${*: -1}" keys=("${@:1:$#-1}")
  if python3 -I -c '
import json, sys
state = json.load(open(sys.argv[1]))
text = sys.argv[2]
for key in sys.argv[3:]:
    state = state[key]
sys.exit(0 if text in state else 1)
' "$FAKE_AWS_DIR/state.json" "$text" "${keys[@]}"; then
    t_note "the pretend account holds '$text' at ${keys[*]}, and must not"
  fi
}

# services_json N EXTRA_NAME: a JSON list of N unrelated services plus one more gateway-family service called EXTRA_NAME
services_json() {
  python3 -I -c '
import json, sys
n, extra = int(sys.argv[1]), sys.argv[2]
rows = [{"name": "other-%d" % i, "family": "otchealth-job-%d" % i} for i in range(n)]
rows.append({"name": extra})
print(json.dumps(rows))
' "$1" "$2"
}
