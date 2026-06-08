# Claude chat + cowork — sharing the OTCHealth context (Task 2)

Claude Code sessions get the full credentialed stack via `session-start.sh`.
Claude **chat** (claude.ai) and **cowork** sessions can't run that installer or
hold the GCP SA, so they get the **knowledge + MCP** tier: the same standing
context and the same ability to read the vault / act on the stack, with auth held
server-side by the connector (no secret ever pasted into a chat).

This is a one-time setup in the claude.ai web UI (it can't be done from Claude
Code), so the steps are below.

## 1. Connect the MCP servers (Settings -> Connectors)
Add these as custom connectors so chat/cowork can read and act:
- **Notion** -> the API vault, business objectives, and the Dream Team run log.
- **GitHub** -> browse repos, PRs, issues, CI.
- **n8n** (optional) -> trigger/inspect automations.

Auth lives in the connector (OAuth/server-side). Nothing sensitive is typed into
the conversation.

## 2. Create a Project "OTCHealth Ops" (Projects -> New)
Set the **custom instructions** to the contents of `CLAUDE.md` (the standing
rules: host facts, PHI ring, lane decisions, secret store).

Add as **project knowledge** (upload or paste):
- `CLAUDE.md`
- `docs/PLATFORM.md` (the wiring + deployment map)
- `dream-team/README.md` + `dream-team/ROSTER.md` (the team + who owns what)

Every chat started in that Project now shares the same context, no re-explaining
the stack, the rules, or the decisions.

## 3. What chat/cowork can and cannot do
- **Can:** read the vault/objectives/repos via MCP, reason over the standing
  context, draft plans, review PRs, answer "how is X wired," kick off n8n flows.
- **Cannot:** run the credentialed generators (designer/Vertex/avatars) or hold
  the GCP SA, those stay in Claude Code by design. If chat needs a credentialed
  action, it hands it to a Claude Code session.

## 4. The hard rule
Never paste the GCP SA or any token into a chat window. The connector model means
you don't have to: auth is server-side. Same PHI ring applies, no PHI in prompts
or context.
