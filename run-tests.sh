#!/usr/bin/env bash
# Toolkit test gate. The skills are dependency-free Node (.mjs), so tests are too: this discovers and
# runs every *.test.mjs (node:test) and every skills/*/selftest.mjs, and reports a single pass/fail.
# Run: bash run-tests.sh   (CI-gateable). Add tests next to the code they cover.
set -u
ROOT="$(cd -- "$(dirname -- "$0")" && pwd)"
cd "$ROOT"
fail=0; ran=0

echo "== syntax gate (node --check on every skill .mjs) =="
syntax_bad=0
while IFS= read -r f; do
  if ! node --check "$f" 2>/tmp/synerr; then
    echo "  SYNTAX ERROR: $f"; sed 's/^/    /' /tmp/synerr | head -3; syntax_bad=$((syntax_bad+1)); fail=1
  fi
done < <(find skills setup -path '*/node_modules' -prune -o -name '*.mjs' -print 2>/dev/null | sort)
[ "$syntax_bad" -eq 0 ] && echo "  ok (all .mjs parse)" || echo "  ${syntax_bad} file(s) with syntax errors"
ran=$((ran+1))

echo "== node:test files (*.test.mjs) =="
mapfile -t TESTS < <(find . -path './node_modules' -prune -o -path '*/node_modules' -prune -o -name '*.test.mjs' -print 2>/dev/null | sort)
if [ "${#TESTS[@]}" -gt 0 ]; then
  node --test "${TESTS[@]}"; [ $? -ne 0 ] && fail=1; ran=$((ran+${#TESTS[@]}))
else
  echo "  (none yet)"
fi

echo "== skill self-tests (skills/*/selftest.mjs) =="
for st in skills/*/selftest.mjs; do
  [ -f "$st" ] || continue
  ran=$((ran+1))
  echo "-- $st"
  # selftests that need a browser are skipped unless RUN_BROWSER_TESTS=1 (they download chromium)
  case "$st" in
    *browser-agent*) [ "${RUN_BROWSER_TESTS:-0}" = "1" ] || { echo "   skipped (set RUN_BROWSER_TESTS=1 to run)"; continue; };;
  esac
  if node "$st"; then echo "   ok"; else echo "   FAIL"; fail=1; fi
done

echo ""
[ "$ran" -eq 0 ] && { echo "no tests found"; exit 0; }
[ "$fail" -eq 0 ] && echo "ALL GREEN ($ran test target(s))" || echo "FAILURES present"
exit $fail
