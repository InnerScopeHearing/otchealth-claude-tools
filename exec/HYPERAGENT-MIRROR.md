# Hyperagent mirror — running the agent OS on a second runtime (Fable 5)

Goal: stand up a mirror of the Claude Code agent org inside Hyperagent so load can
shift to Hyperagent's Claude Fable 5 when the Claude Code premium pool caps. Same agents,
same shared state, same tools, second engine.

## The mental model (read first)

Hyperagent's "Add MCP server" connects a TOOL server to Hyperagent's agents. It is NOT a
way to plug a Claude Code session in as a controller. In MCP, the agent is the client and
the MCP server provides tools. A Claude Code session is an agent, not an MCP server, so it
cannot remote-drive Hyperagent.

This does not matter, because **Hyperagent's agents already run Claude (Fable 5).** The
brain is already there. What transfers is the identity, the shared state, and the tools,
all of which we built to live in files and services, not in the runtime.

## The four layers that transfer

| Layer | Claude Code | Hyperagent equivalent |
|---|---|---|
| Identity | CLAUDE.md + role charters | Paste each charter as an Agent system prompt |
| Shared state | Notion (dispatch DB, briefings DB) | Notion MCP (connected) |
| Artifacts | GitHub repos | GitHub MCP (connected) |
| Tools | Dream Team skills + MCP servers | Custom MCP = otchealth-mcp-server + uploaded skills |

Because identity + state + artifacts are all external, an agent picks up ~85-90% of its
context cold on either runtime. The gap to ~95% is in-flight working memory (lost on any
session switch) and tool-connection parity.

## Setup steps in Hyperagent (Matt clicks; COO/CTO generates the inputs)

1. **Create each agent** (Agents sidebar > +). One per role: COO, CTO, CRO, CFO, CCO, CPO.
2. **Paste the system prompt.** Use the role charters (coo/CTO-PROMPT.md, exec/CRO-PROMPT.md,
   etc.), adapted to Hyperagent (the adaptation = strip Claude-Code-specific tool names,
   point reads/writes at the Notion + GitHub MCP). Hyperagent-ready prompts live in
   `exec/hyperagent/` (generated on demand).
3. **Connect integrations PER AGENT.** Critical gotcha: the screenshots show GitHub + Notion
   "No agents connected." Integrations attach per agent, not globally. For each agent,
   connect the integrations it needs (most need GitHub + Notion; the CRO also needs
   Customer.io; the CTO needs all).
4. **Add the stack tools via custom MCP.** Add `otchealth-mcp-server` as a custom MCP server
   so Hyperagent agents get the same OTCHealth tools the Claude Code agents have. Check
   "I trust this server" only after confirming the URL is ours.
5. **Upload skills.** Use Create skill > Upload file (JSON export) or Link to documentation
   for the Dream Team skills the role uses.

## The failover protocol (how the same agent continues ~seamlessly)

Both runtimes read the same CLAUDE.md and the same Notion. So:
- **Read first:** every agent, on either runtime, reads its CLAUDE.md + its open
  dispatch/briefing rows before acting.
- **Write last:** every agent, before ending, writes its state back to CLAUDE.md + files a
  briefing. Never end mid-task with unsaved working memory.
- **Switch on a clean boundary:** when the Claude Code pool caps, finish the current task
  (or check its state into Notion), then resume the same role in Hyperagent. The Hyperagent
  agent reads the same files and continues.
- **One trigger target:** the n8n wake/heartbeat/Send-Later workflows fire at a routine
  endpoint. To fail over the autonomous loop too, the trigger URL must be a config value,
  not hardcoded, so it can point at whichever runtime is active. (CTO task.)

## Guardrails (non-PHI, but real blast-radius limits)

- **Notion scope:** the account connected to Hyperagent must NOT be able to reach the
  "COO - Confidential" page (capital structure chain, litigation, person-tied figures).
  Hyperagent is a non-BAA third party and warns custom servers are unverified. Connect a
  scoped Notion account/integration, or keep Confidential in a separate workspace the
  Hyperagent connection cannot see.
- **GitHub scope:** do NOT expose `medreview` (PHI) to the Hyperagent GitHub connection.
  Scope the connected install to the non-PHI repos.
- **Same content rules:** no em/en dashes in published copy; securities firewall on anything
  INND-facing; the CCO still gates regulated output regardless of which runtime produced it.
- **Lane fit:** Hyperagent is strongest on web/research/content/outreach work (good fit for
  CRO outreach, content, competitive research). Engineering-heavy work that must land in a
  repo stays most natural in Claude Code. Use Hyperagent to OFFLOAD, not to replace.

## Division of labor for the build

- COO/CTO **generate**: Hyperagent-formatted agent prompts, the per-agent connection map,
  the skill exports, this protocol.
- Matt **wires**: creates the agents, pastes prompts, connects integrations per agent,
  scopes the Notion + GitHub accounts.
- Verify with one agent end-to-end (recommend the CRO: lowest PHI risk, clear cash output)
  before mirroring the rest.
