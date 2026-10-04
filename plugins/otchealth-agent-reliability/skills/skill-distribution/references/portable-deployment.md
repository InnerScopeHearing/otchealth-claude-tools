# Portable deployment

This pack has portable Agent Plugins 1.0 and Codex compatibility manifests, eight original skills, no servers, grants, hooks or credentials.

Use Plugin Creator to save the private plugin once, preserve returned IDs, then retrieve exact source for hash comparison. Creation is not verified install in another Chat.

For authorized filesystem deployment the optional host helper requires PowerShell 7. Run scripts/install-skills.ps1 with explicit DestinationRoot pointing to the actual container: <repo>/.agents/skills for Codex or <repo>/.claude/skills for Claude. Inspect target owner instructions first. The script copies only eight named folders, validates containment in both directions, refuses differing existing files and compares exact hashes. It creates no settings/permissions/symlinks. Save receipt outside source. Same content is a no-op. The Markdown skills need no PowerShell runtime.

For cloud hosts commit selected layout with supported source-control, prove host/checkout and invoke harmless scenario. A local copy is not cloud distribution.

Hyperagent supports UI SKILL.md/JSON import. This run's CTO metadata catalog exposes no verified skill-import tool. Use approved import controls only when callable. Do not launch paid threads to imitate installation or guess endpoints.

Official references checked 2026-10-04:
- https://developers.openai.com/plugins/concepts/skills
- https://developers.openai.com/plugins/build/plugins
- https://help.openai.com/en/articles/20001066-skills-in-chatgpt
- https://github.com/anthropics/skills
- https://www.hyperagent.com/docs/concepts/skills/skills-edit-and-import
- https://www.hyperagent.com/docs/concepts/teams/team-skills
