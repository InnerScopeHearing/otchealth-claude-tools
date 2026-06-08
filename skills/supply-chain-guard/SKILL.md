---
name: supply-chain-guard
description: Guardian's equipment. Hardens a repo against the 2026 dependency-bot malware vector and scans for leaks. Drops in dependency cooldown configs across every package manager, disables bot auto-merge, SHA-pins GitHub Actions, adds Gitleaks pre-commit + TruffleHog CI, and generates a CycloneDX SBOM with cdxgen. Use when adopting a repo into the portfolio, on every security gate, and in maintenance sweeps.
---

# supply-chain-guard — make a repo safe to auto-update

The 2026 reality: dependency bots became malware accelerators (axios 1.14.1: malicious version live, Dependabot PR 5 min later, ~60% of repos auto-merged it). The single highest-leverage control is **cooldowns + no auto-merge + SHA-pinned Actions**. This skill applies that, plus leak scanning + an SBOM.

## When to invoke
Adopting a repo into the portfolio, the Guardian security gate, or a maintenance sweep. Non-PHI and PHI repos alike (it is pure hardening, no data).

## 1. Apply the hardening configs (copy from `templates/`)
- **Renovate** (`renovate.json`): `"minimumReleaseAge": "3 days"` (v42+), grouping, `"automerge": false`. 
- **Dependabot** (`.github/dependabot.yml`): `cooldown: { default-days: 3 }` for every ecosystem present.
- **npm** (`.npmrc`): `min-release-age=3`; **pnpm 10.16+** (`pnpm-workspace.yaml`/`.npmrc`): `minimum-release-age=259200`.
- Apply to **every package manager present, even unused ones**, so an AI agent can't bypass policy by reaching for a different one.

## 2. Kill the unsafe defaults
- Remove any auto-merge of bot PRs; require human review.
- **SHA-pin GitHub Actions:** rewrite `uses: org/action@vX` to `uses: org/action@<full-40-char-sha>  # vX`. Run `scripts/pin-actions.mjs` to do this across `.github/workflows/**` and stop Renovate from un-pinning (`"pinDigests"` off for workflows).

## 3. Scan (run `scripts/scan.sh`)
- **Gitleaks** as a pre-commit hook (`templates/.pre-commit-config.yaml`) and in CI (blocks on detection, SARIF to the security tab).
- **TruffleHog** in CI with `--only-verified` over full history (live-credential check).
- **cdxgen** to emit a CycloneDX SBOM (`bom.json`) so "are we affected?" is answerable in minutes when the next npm compromise hits — essential for a PHI breach assessment.

## 4. Don't relax CVE alerting
Cooldowns are preventive, not detective. Keep advisory alerts on; fast-track real CVEs past the cooldown with a manual diff review (look for obfuscation, dynamic exec, unexpected network).

## Output (handoff)
Set `manifest.gates.supplyChain = pass` (or `fail` with the violation). Commit the configs + SBOM. On a violation (e.g. a dep newer than the cooldown), block and hand back to Builder with the specific package + fix.

## Guardrails
A bot PR is never auto-merged. A dep added inside the cooldown window is a block, not a warning.
