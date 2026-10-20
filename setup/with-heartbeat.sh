#!/usr/bin/env bash
# with-heartbeat.sh <job-name> -- <command...>
# Wraps any job command with dead-man's-switch beats: emit 'start', run, emit 'ok'/'fail'.
# Fail-open: a heartbeat error never blocks or fails the wrapped command. Preserves exit code.
set +e
JOB="$1"; shift
[ "$1" = "--" ] && shift
DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
node "$DIR/heartbeat.mjs" beat "$JOB" start >/dev/null 2>&1
start_rc=$?
if [ "$start_rc" -ne 0 ]; then echo "WARNING: heartbeat start write failed; continuing workload" >&2; fi
"$@"; rc=$?
if [ "$rc" -eq 0 ]; then node "$DIR/heartbeat.mjs" beat "$JOB" ok >/dev/null 2>&1
else node "$DIR/heartbeat.mjs" beat "$JOB" fail --detail "exit $rc" >/dev/null 2>&1; fi
completion_rc=$?
if [ "$completion_rc" -ne 0 ]; then echo "WARNING: heartbeat completion write failed; workload exit status preserved" >&2; fi
exit $rc
