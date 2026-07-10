# Anthropic prompt caching — finding (2026-07-05)

## Bottom line
**Nothing in this repo (`otchealth-claude-tools`) or in the read-only gateway reference
(`/tmp/mcpsrv`) calls the Anthropic Messages API directly today.** There is no `cache_control` block,
no `@anthropic-ai/sdk` usage, and no raw `fetch("https://api.anthropic.com/...")` call anywhere in
either tree. Prompt caching (`cache_control: {"type": "ephemeral"}` on message/system/tool blocks) is
an Anthropic Messages API feature — it has nothing to attach to here, because this repo never
constructs a Messages API request.

## What this repo/gateway actually call
- **This repo (`otchealth-claude-tools`)**: it is a **Claude Code skills library** — plain Node
  scripts (`.mjs`) that a Claude Code CLI session (agent) invokes as tools. The Claude model calls
  themselves (the ~854-tool MCP schema + conversation the FinOps note refers to) happen **inside the
  Claude Code CLI/harness process**, which is Anthropic-hosted infrastructure this repo does not
  contain source for. The only outbound model calls this repo's OWN code makes are to **Azure OpenAI /
  Azure Foundry** (`gpt-4o`, `gpt-5.1`, `gpt-4.1-mini`-banned) — see
  `skills/agent-evals/run-evals.mjs` (`callChat` posts to
  `${ep}/openai/deployments/${dep}/chat/completions`), `skills/agent-evals/selfrepair-rewrite.mjs`
  and `setup/model-routing.mjs` (`chatBody`, `TIERS`). Azure OpenAI's cache mechanism is a different,
  automatic feature (no `cache_control` blocks to add) and is out of scope for "Anthropic prompt
  caching" specifically.
- **`/tmp/mcpsrv` (read-only gateway reference)**: also Azure-first — `src/azure/foundry.ts`,
  `src/azure/search.ts`. No `@anthropic-ai/sdk` in `package.json`, no `api.anthropic.com` string
  anywhere in `src/` or `dist/`. The single `anthropic` string hit in this tree
  (`src/server/webhooks.ts:23`, `AGENT_LOGIN` regex matching `anthropic-code-agent` as a bot login
  name) is an unrelated GitHub-bot-identity pattern, not an API call.

## Where the ~854-tool MCP schema actually lives (and where caching would apply)
The FinOps note's premise — a large, mostly-static MCP tool schema resent on every turn is the
single biggest Claude-cost lever, and Anthropic's prompt caching (cache the tool/system block once,
pay ~10% of input price on cache hits) is the fix — is almost certainly correct, but the fix has to
land in whichever process actually assembles the Messages API request and holds the Anthropic API
key: the **Claude Code CLI/harness itself** (or whatever thin wrapper around it issues the live
`messages.create` calls with the full tool schema attached). That code is not in this repo and not in
`/tmp/mcpsrv`. Concretely, the fix (wherever that layer lives) is:
- Mark the system prompt and/or the tool-definitions array with
  `cache_control: { type: "ephemeral" }` on the LAST block that should be cached (Anthropic caches
  everything up to and including a marked block); a static ~854-tool schema is exactly the kind of
  large, turn-invariant prefix caching is built for.
- Minimum cacheable prefix is 1024 tokens (Sonnet/Opus) / 2048 (Haiku) — an 854-tool schema is almost
  certainly well past that floor.
- Cache writes cost ~1.25x base input price for the first call in a ~5-minute TTL window; cache reads
  cost ~0.1x — so this only pays off if the same tool schema/system prompt is reused across enough
  calls within the TTL, which a busy multi-agent fleet almost certainly satisfies.

## Recommendation
Do not build anything in this repo for this — there is no call site here to attach `cache_control`
to. Flag this finding to whoever owns the actual Claude Code CLI/harness invocation layer (outside
this repo's scope) as the concrete next step for the "biggest Claude-cost lever" FinOps item. If a
direct-Anthropic-API call site is ever added to this repo (e.g. a future "true model-fidelity" evals
path per `skills/agent-evals/SKILL.md`'s "Fidelity upgrade" section, which explicitly mentions adding
an `anthropic-api-key` and pointing `AGENT_MODEL` at Claude), prompt caching should be added at that
same time, not retrofitted later — the static persona/rubric text in `evals/*.json` and
`evals/personas.json` would be a good first `cache_control` candidate since it's byte-identical
across every task run in a suite.
