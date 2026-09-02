#!/bin/sh
# quantize-indices job entrypoint (manual ECS RunTask override on the otchealth-job-brain-reindex
# task definition -- see skills/doc-indexer/run-quantize-task.mjs, the seat-side helper that launches
# it). NOT a scheduled job: this is dispatched on demand by the CTO to migrate the fleet's OpenSearch
# k-NN indexes from fp32 to disk-optimized/quantized vectors (FND-20260829-f7fa). Styled like
# brain-reindex.sh/deep-pass.sh (env-driven, ROOT-relative, no framework), NOT registered in
# setup/heartbeat-registry.json on purpose: a one-off manual tool with no cron cadence would only
# produce false "DEAD" alerts if it were treated like a scheduled job's expected heartbeat.
#
# Env (all optional except QUANTIZE_MODE for anything beyond a read-only plan):
#   QUANTIZE_MODE=plan|migrate|rollback   (default: plan)
#   QUANTIZE_INDEX=<name>                 (single index, for migrate/rollback)
#   QUANTIZE_ALL=1                        (migrate every eligible index, smallest first)
#   QUANTIZE_COMMIT=1                     (actually mutate; omitted = dry run)
#   QUANTIZE_COMPRESSION=32x              (1x|2x|4x|8x|16x|32x; default 32x)
#   QUANTIZE_INCLUDE_PRIVILEGED=1         (include finance/legal rooms; default excluded)
#   QUANTIZE_MIN_OVERLAP_PCT=90           (kNN top-10 overlap floor; default 90)
#   QUANTIZE_JSON=1                       (plan: machine-readable JSON instead of a table)
#   QUANTIZE_FORCE=1                      (rollback only: overwrite a "broken" target index)
# Any additional args after `--` are passed through to quantize-indices.mjs verbatim.
set -e
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"

# Preserve any args the caller already passed (e.g. a manual `sh quantize-indices.sh -- --json`)
# before rebuilding $@ from env below -- `set --` would otherwise silently discard them.
PASSTHROUGH="$@"

MODE="${QUANTIZE_MODE:-plan}"
set -- "$MODE"
[ -n "$QUANTIZE_INDEX" ] && set -- "$@" --index "$QUANTIZE_INDEX"
[ "$QUANTIZE_ALL" = "1" ] && set -- "$@" --all
[ "$QUANTIZE_COMMIT" = "1" ] && set -- "$@" --commit
[ -n "$QUANTIZE_COMPRESSION" ] && set -- "$@" --compression "$QUANTIZE_COMPRESSION"
[ "$QUANTIZE_INCLUDE_PRIVILEGED" = "1" ] && set -- "$@" --include-privileged
[ -n "$QUANTIZE_MIN_OVERLAP_PCT" ] && set -- "$@" --min-overlap-pct "$QUANTIZE_MIN_OVERLAP_PCT"
[ "$QUANTIZE_JSON" = "1" ] && set -- "$@" --json
[ "$QUANTIZE_FORCE" = "1" ] && set -- "$@" --force
# Word-split intentionally (POSIX /bin/sh has no arrays): every flag value this tool accepts is a
# single space-free token (an index name, a compression level, a number), so this is safe. Anything
# containing a space would need a different mechanism; not needed today.
# shellcheck disable=SC2086
set -- "$@" $PASSTHROUGH

echo "[quantize-indices] $(date -u +%FT%TZ) - mode=$MODE commit=${QUANTIZE_COMMIT:-0} index=${QUANTIZE_INDEX:-<none>} all=${QUANTIZE_ALL:-0}"
node "$ROOT/skills/doc-indexer/quantize-indices.mjs" "$@"
rc=$?
echo "[quantize-indices] done: exit $rc"
exit $rc
