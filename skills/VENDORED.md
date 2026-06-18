# Vendored third-party skills - provenance + license

Skills in this directory that were copied from external repositories. Each was reviewed
before vendoring (guardian supply-chain pass) and carries its upstream LICENSE file. Only
**permissively licensed** (MIT) skills are vendored here. Pinned to the source commit at
vendoring time so the provenance is reproducible.

Vendored 2026-06-18 by the CTO.

## MIT-licensed (copied into this repo, LICENSE included per skill)

| Skill dir | Source repo | Source commit | License |
|-----------|-------------|---------------|---------|
| creating-financial-models | anthropics/claude-cookbooks (skills/custom_skills) | 34022c5 | MIT |
| analyzing-financial-statements | anthropics/claude-cookbooks (skills/custom_skills) | 34022c5 | MIT |
| brainstorming | obra/superpowers (skills) | b62616f | MIT |
| writing-plans | obra/superpowers (skills) | b62616f | MIT |
| executing-plans | obra/superpowers (skills) | b62616f | MIT |
| subagent-driven-development | obra/superpowers (skills) | b62616f | MIT |
| test-driven-development | obra/superpowers (skills) | b62616f | MIT |
| systematic-debugging | obra/superpowers (skills) | b62616f | MIT |
| verification-before-completion | obra/superpowers (skills) | b62616f | MIT |
| dispatching-parallel-agents | obra/superpowers (skills) | b62616f | MIT |
| requesting-code-review | obra/superpowers (skills) | b62616f | MIT |
| receiving-code-review | obra/superpowers (skills) | b62616f | MIT |
| contract-analyzer | OneWave-AI/claude-skills | 071454b | MIT |
| contract-redliner | OneWave-AI/claude-skills | 071454b | MIT |
| edgartools | dgunning/edgartools (edgar/ai/skills) | ebb4ae2 | MIT |

## NOT vendored - licensed, installed via the authorized marketplace instead

The official Anthropic Agent Skills (`anthropics/skills`, marketplace `anthropic-agent-skills`)
are **NOT open-source**. Their per-skill LICENSE forbids extracting/copying/redistributing
them outside the Services. So they are NOT in this repo; they install through the official
plugin marketplace (`.claude/settings.json` `enabledPlugins` + `setup/session-start.sh`),
which is authorized use within the Services:
- **document-skills** -> xlsx, docx, pptx, pdf (real Office authoring for CFO/COO/capital/growth)
- **example-skills** -> canvas-design, mcp-builder, brand-guidelines, doc-coauthoring,
  webapp-testing, skill-creator, frontend-design, internal-comms, theme-factory, web-artifacts-builder

## Discover-on-demand (not pre-installed)

Everything else in the 50k-skill registry is reachable at runtime via the `skills-discovery`
skill. Adopt durably only after a guardian review, MIT/permissive license, then add here.

See `dream-team/FLEET-SKILLS-RECOMMENDATIONS.md` for the agent-by-agent map.
