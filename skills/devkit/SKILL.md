---
name: devkit
description: The Claude Code operating layer. Installs the productivity + safety setup that makes Claude Code itself faster and less glitchy in a repo: sandboxed bash, the format/lint + test-gate hooks, the Capacitor/Ionic Agent Skills pack (70%->92% correct native code), the CLAUDE.md standard, and Spec Kit. Architect and Builder run this first in any app repo.
---

# devkit — make Claude Code sharp in this repo

The highest-ROI, lowest-effort wins from the research sweep, applied per repo.

## When to invoke
First thing when adopting or building in an app repo, before Builder writes code.

## 1. Capacitor/Ionic Agent Skills pack (the single highest-ROI find)
For any Capacitor app, install the official pack so generated native code is correct:
```bash
npx skills add capawesome-team/skills
```
Reported jump from ~70% to ~92% correct Capacitor code. Do this in every hybrid repo.

## 2. Sandboxed bash (fewer permission prompts)
In `.claude/settings.json` enable the sandbox so routine commands don't prompt:
```json
{ "sandbox": { "enabled": true } }
```
~84% fewer prompts; agents run with less babysitting.

## 3. The hooks (auto-format / lint / test gate)
Merge `templates/settings.hooks.json` into `.claude/settings.json`:
- **PostToolUse** (Edit|Write) -> `prettier --write` + `eslint --fix` on the changed files.
- **PreToolUse** test gate -> run affected unit tests; non-zero blocks a bad change.
Only enable the prettier/eslint hook where those toolchains exist (skip on a docs-only repo).

## 4. CLAUDE.md standard
If the repo has no `CLAUDE.md`, drop in `templates/CLAUDE.template.md` and fill the app
specifics (name, ring, bundle id). It carries the non-negotiables: PHI ring, no medical
claims, senior accessibility as a hard requirement, secrets never ship to the client.

## 5. Spec Kit (spec-driven development for the Architect)
```bash
uvx --from git+https://github.com/github/spec-kit.git specify init
```
Then the Architect uses `/specify` -> `/plan` -> `/tasks` before code.

## Output
The repo now has the sandbox, hooks, Agent Skills pack, CLAUDE.md, and Spec Kit.
Set `manifest.kits.devkit = true`. Hand to Builder.

## Guardrails
Hooks are configured in `.claude/settings.json` (the harness runs them, not the model).
Never put secrets in settings.json. Respect the repo's `manifest.ring`.
