# Install the OTCHealth OS everywhere — Claude Code, Claude chat/cowork, any AI

The system (standing rules + agent roster + skills + the cash goal + the securities
firewall) installs three ways depending on the surface. Run the bundler first:

```bash
bash dist/build-os-bundle.sh
# -> dist/OTCHEALTH-OS.md            (full, for knowledge upload)
# -> dist/OTCHEALTH-OS-SYSTEM-PROMPT.md  (condensed, for a system prompt)
```

## 1. Claude Code (web sessions, any repo) — full filesystem install
Already automated. Each environment runs the setup script:
```bash
rm -rf /tmp/octools 2>/dev/null
git clone --depth 1 https://github.com/InnerScopeHearing/otchealth-claude-tools /tmp/octools
bash /tmp/octools/setup/session-start.sh
```
This installs **all skills** to `~/.claude/skills` and **all agents** (product team +
Cash Driver) to `~/.claude/agents`, and hydrates every credential. The agents and
skills are real and invokable. Plus `CLAUDE.md` at a repo root loads automatically.

## 2. Claude chat + cowork (claude.ai) — Project + connectors
Chat/cowork cannot run the installer or hold secrets, so they get the knowledge + MCP
tier (steps are in `docs/CLAUDE-CHAT-SETUP.md`):
1. **Create a Project "OTCHealth Ops"**; set custom instructions to `CLAUDE.md`.
2. **Upload `dist/OTCHEALTH-OS.md`** as project knowledge (the full bundle).
3. **Connect MCP connectors** (Notion, GitHub, n8n) so chat can read the vault /
   objectives / repos and act, auth stays server-side, no secret in the chat.
Every chat in that Project now operates as part of the team.

## 3. Any other AI (ChatGPT/GPTs, Gemini Gems, etc.) — paste or upload the bundle
- **System prompt:** paste `dist/OTCHEALTH-OS-SYSTEM-PROMPT.md` into the model's
  system/instructions field (custom GPT instructions, a Gem, an assistant system
  message). The model then follows the rules, knows the roster/skills, and respects
  the securities firewall.
- **Knowledge:** upload `dist/OTCHEALTH-OS.md` as a knowledge file for retrieval.
- **Credentials boundary:** other AIs do NOT get the GCP SA or any token. They operate
  on knowledge + whatever connectors you grant them. Credentialed generation stays in
  Claude Code. Same PHI ring + securities firewall apply everywhere.

## Keeping it current
The bundle is generated from the canonical files (`CLAUDE.md`, `dream-team/*`,
`skills/*/SKILL.md`, the firewall). After any change to those, re-run
`bash dist/build-os-bundle.sh` and re-upload `dist/OTCHEALTH-OS.md` to the Project /
other AIs. In Claude Code nothing to do, it reads the live files.

## The hard rule (every surface)
Never paste the GCP SA or any token into a chat/other-AI window. The system spans
surfaces via knowledge + connectors, not by copying secrets. PHI ring and the
securities firewall are absolute on every surface.
