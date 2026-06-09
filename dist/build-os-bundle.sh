#!/usr/bin/env bash
# build-os-bundle.sh — assemble the portable "OTCHealth OS": one document that
# encodes the whole operating system (rules + agents + skills + cash goal) so it can
# be installed ANYWHERE: Claude Code (filesystem), Claude chat/cowork (Project
# knowledge), or any other AI (paste as a system prompt / upload as knowledge).
#
# Outputs (gitignored, regenerated on demand):
#   dist/OTCHEALTH-OS.md                 full bundle (knowledge upload)
#   dist/OTCHEALTH-OS-SYSTEM-PROMPT.md   condensed (system prompt for other AIs)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
FULL="dist/OTCHEALTH-OS.md"
SYS="dist/OTCHEALTH-OS-SYSTEM-PROMPT.md"

# Pull a frontmatter field (name/description) from a markdown file.
fm() { awk -v k="$1:" '/^---$/{n++; next} n==1 && $0 ~ "^"k {sub("^"k" *",""); print; exit}' "$2"; }

index_dir() { # $1=dir  $2=heading
  echo "### $2"
  for f in "$1"/*/SKILL.md "$1"/*.md; do
    [ -f "$f" ] || continue
    local name desc
    name="$(fm name "$f")"; desc="$(fm description "$f")"
    [ -n "$name" ] && echo "- **${name}** — ${desc}"
  done
}

{
  echo "# OTCHealth / InnerScope — Operating System (portable bundle)"
  echo "_Generated $(date -u +%Y-%m-%dT%H:%MZ) by dist/build-os-bundle.sh. Install this in any AI to give it the full operating context._"
  echo
  echo "This bundle makes any assistant (Claude Code, Claude chat/cowork, or another"
  echo "AI) operate as part of the team: it carries the standing rules, the agent"
  echo "roster, the skills index, the cash goal, and the securities firewall. In"
  echo "Claude Code the skills/agents also install as real files; elsewhere this"
  echo "document IS the system."
  echo
  echo "---"
  echo "## 1. Standing rules (CLAUDE.md)"; echo
  cat CLAUDE.md
  echo; echo "---"
  echo "## 2. The one goal: CASH IN — the Cash Driver"; echo
  cat dream-team/CASH-DRIVER.md
  echo; echo "---"
  echo "## 3. Agent roster (operators)"; echo
  index_dir "dream-team/agents" "Agents"
  echo; echo "---"
  echo "## 4. Skills index (equipment)"; echo
  index_dir "skills" "Skills"
  echo; echo "---"
  echo "## 5. The securities firewall (read before any growth/PR/IR action)"; echo
  cat skills/growth-pr/templates/securities-firewall.md
  echo; echo "---"
  echo "## 6. How the team interconnects"; echo
  cat dream-team/INTERCONNECT.md
} > "$FULL"

# Condensed system-prompt version (rules + indexes + firewall summary only).
{
  echo "# OTCHealth / InnerScope — operating system prompt (condensed)"
  echo "You operate as part of the OTCHealth/InnerScope team. North star: CASH into the bank, fastest legal path. Obey these:"
  echo
  echo "## Standing rules"; echo
  cat CLAUDE.md
  echo; echo "## Agents you can think/act as"; echo
  index_dir "dream-team/agents" "Agents"
  echo; echo "## Skills (capabilities) available"; echo
  index_dir "skills" "Skills"
  echo; echo "## Securities firewall (absolute)"
  echo "Two lanes: PRODUCT marketing (factual, automate) is open; anything touching INND / the stock / a raise / 3(a)(10) / Southridge-Trilium / reverse split is GATED — factual, Reg-FD-safe, attorney + Matt approved, never autonomous, never timed to share price. No medical/device claims; never claim a 510(k) OTCHealth does not hold. No PHI. No em or en dashes in published copy."
} > "$SYS"

echo "[os-bundle] wrote $FULL ($(wc -l < "$FULL") lines) and $SYS ($(wc -l < "$SYS") lines)"
