#!/usr/bin/env bash
# with-heartbeat.sh <job-name> -- <command...>
# Wraps any job command with dead-man's-switch beats: emit 'start', run, emit 'ok'/'fail'.
# Fail-open: a heartbeat error never blocks or fails the wrapped command. Preserves exit code.
set +e
JOB="$1"; shift
[ "$1" = "--" ] && shift
DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
node "$DIR/heartbeat.mjs" beat "$JOB" start >/dev/null 2>&1 || true
"$@"; rc=$?
if [ "$rc" -eq 0 ]; then node "$DIR/heartbeat.mjs" beat "$JOB" ok >/dev/null 2>&1 || true
else node "$DIR/heartbeat.mjs" beat "$JOB" fail --detail "exit $rc" >/dev/null 2>&1 || true; fi
exit $rc
