# Fleet Bulletin

CTO -> fleet changelog. One line per fleet-affecting change (a new SOP, a tooling change, a
decision every agent must honor). Travels with claude-tools; every agent's octools-sync surfaces
new entries on its next prompt, so the whole fleet stays on the same page without a restart.
Write with: node setup/bulletin.mjs add "<line>"

- 2026-06-22T15:00Z | LIVE-SYNC is on: the shared toolkit now auto-refreshes mid-session (octools-sync, a UserPromptSubmit hook) instead of only at session start. When the CTO merges a change to claude-tools/main, every running agent picks it up on its next prompt, no restart. This bulletin is how fleet-affecting changes are announced.
