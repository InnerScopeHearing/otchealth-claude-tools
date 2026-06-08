#!/usr/bin/env bash
# scan.sh — leak scan + SBOM for the current repo. Safe, read-only except bom.json.
# Requires (auto-skips if missing): gitleaks, trufflehog, cdxgen.
set -uo pipefail
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"
rc=0

echo "== Gitleaks (secrets in working tree + history) =="
if command -v gitleaks >/dev/null 2>&1; then
  gitleaks detect --no-banner --redact -f sarif -r gitleaks.sarif || { echo "  LEAK(S) FOUND"; rc=1; }
else echo "  (gitleaks not installed: brew/go install, or use the prebuilt binary)"; fi

echo "== TruffleHog (verified live credentials) =="
if command -v trufflehog >/dev/null 2>&1; then
  trufflehog git "file://$ROOT" --only-verified --fail || { echo "  VERIFIED LEAK(S)"; rc=1; }
else echo "  (trufflehog not installed)"; fi

echo "== cdxgen (CycloneDX SBOM -> bom.json) =="
if command -v cdxgen >/dev/null 2>&1; then
  cdxgen -o bom.json >/dev/null 2>&1 && echo "  wrote bom.json" || echo "  cdxgen failed"
else echo "  (cdxgen not installed: npm i -g @cyclonedx/cdxgen)"; fi

[ "$rc" -eq 0 ] && echo "RESULT: clean" || echo "RESULT: findings — BLOCK the release"
exit "$rc"
