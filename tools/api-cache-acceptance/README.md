# API cache acceptance pilot

Status: offline, synthetic-only acceptance harness. This directory does not add provider calls, production cache code, environment settings, Cloudflare configuration, or traffic routing.

## Request paths reviewed on 2026-09-25

| Path | Evidence | Disposition |
| --- | --- | --- |
| `otchealth-claude-tools/skills/company-brain/brain.mjs` | `main` commit `1f9e197121aff4f9b35c6a14b919be0efe1ecd01`. The default chat provider is OpenAI. `chatRequestFor()` builds the direct OpenAI Chat Completions request; `callChat()` sends the stable system text before variable question and source content and records `usage.prompt_tokens_details.cached_tokens`. | The code controlled by the toolkit is the only path used to shape the provider prompt-cache scenario. No provider request or live-traffic claim is part of this acceptance run. |
| `otchealth-cto/apps/otchealth-os-chat/server.mjs` | `main` commit `a3d76b8f6ec76a847ad0e8eb5866a4e117f13ceb`, file blob `402803022dd56f4d7e0db0c67026627855948ec3`. The source still has an Azure Foundry `PROJECT_ENDPOINT` call from `/api/chat` and its classifier. Brain source `60e7995041c0f81f2a41208d90a9d8beeaec6ead` records a live Azure Container App read on 2026-07-20. | Historical code and historical deployment evidence. The CTO seat doctrine records Azure as permanently deleted on 2026-08-13, so this is not a current callable route or a cache candidate. No Azure request was made. |
| `otchealth-mcp-server` tool `llm_azure` | Current `main` commit `2e2df3511145ebe7335fc1de8525915faa17735a`; `src/tools/index.ts` imports and registers the handler, `src/tools/llm/azure.ts` defines it, and `src/config/lane-toolsets.ts` still includes it. The live `catalog_list_tools(service="llm")` check on 2026-09-25 returned tool `llm_azure`, catalog version `b34586d4`. | Live advertised gateway tool. Do not invoke or change it here. Retirement belongs to ledger task `t_idem_c2c9f68a`, draft PR [#451](https://github.com/InnerScopeHearing/otchealth-mcp-server/pull/451), branch `claude/ai-os-retired-azure-llm-guard-20260923`, current head `db3ddd3ac829d2a425958e58f689867112b64ede`. Catalog presence proves advertisement, not successful upstream provider connectivity. |
| Cloudflare AI Gateway | No current company route, account binding, cache policy, or log policy was verified. Public documentation describes [response caching](https://developers.cloudflare.com/ai-gateway/features/caching/) and [payload log controls](https://developers.cloudflare.com/ai-gateway/observability/logging/). | Not evaluated. The compatible route and company log/cache controls have not been proven. |

ChatGPT, Claude, and other client-managed model traffic is outside this source-controlled API pilot. A model client or a tool catalog entry alone does not prove a company-controlled provider request path.

## Separate the two cache features

Provider prompt caching keeps a stable prompt prefix in the provider cache and returns its cached input token count. The provider still receives the request and generates a fresh answer. `measureOpenAIPromptCacheUsage()` therefore reports `cachedInputTokens` separately and always reports zero avoided provider calls and zero avoided input tokens.

Exact-response caching can skip a whole provider call, but the offline harness admits only synthetic immutable fixtures. Eligibility fails closed unless every exclusion flag is explicitly false and every required source property is present. Its key requires tenant, seat, role, authorization scope and version, exact query text, every ordered source ID and version, model and model version, prompt version, tool schema version, and response configuration. Credential-shaped fields are rejected. The key digest is in-memory only and never appears in logs.

The harness denies mutable Brain facts, GraphRAG relationship answers, user-specific outputs, permission-dependent outputs, writes, PHI, privileged legal content, and MNPI. Those denials are tested even though tenant and authorization dimensions remain in the key as isolation checks. The cache is in-memory, disabled by default, has an injected TTL and clock, supports source-version invalidation, and clears entries when disabled for rollback.

Event records use a fixed field allowlist. They contain outcome, reason code, elapsed time, saved time, and synthetic aggregate token and call counts. They do not contain query text, answer text, source IDs, tenant, seat, role, authorization data, cache keys, or key hashes.

## Run and verify

Run the local scenario:

```powershell
node tools/api-cache-acceptance/run.mjs
```

Run the new checks with the existing prompt-shape tests:

```powershell
node --test tools/api-cache-acceptance/offline-harness.test.mjs setup/prompt-shape.test.mjs
```

The repository `run-tests.sh` discovers all `*.test.mjs` files, including this harness, for its CI test job.

The checked-in synthetic run reports:

| Measurement | Synthetic result |
| --- | ---: |
| Provider prompt cache input tokens read from fixture receipt | 1,200 |
| Provider calls avoided by prompt caching | 0 |
| Input tokens avoided by prompt caching | 0 |
| Exact-response cache provider calls avoided | 1 |
| Exact-response cache input tokens avoided | 180 |
| Exact-response cache output tokens avoided | 32 |
| Simulated miss latency | 42 ms |
| Simulated hit latency | 0 ms |
| Simulated latency saved | 42 ms |
| Synthetic answer parity | Pass |
| Live quality, price, and cost evidence | Not measured |

These values come from synthetic receipts and a fake clock. They are not provider usage, production savings, latency, cost, or answer-quality measurements. The public `runOfflineAcceptance()` entrypoint installs outbound tripwires for `fetch`, `WebSocket` when present, `node:http`, `node:https`, HTTP agent socket creation, `node:net` connect paths, `node:tls`, `node:http2`, `node:dgram`, and DNS lookup and resolver methods. A call through an instrumented path throws before opening a socket, and the guard restores the built-in methods in a `finally` block. The `probeBuiltinTransports: true` test option exercises each installed tripwire through that same entrypoint; the test confirms each target is replaced before invoking it, so the probes cannot fall through to a real connection.

This is process-local JavaScript instrumentation, not an operating-system egress sandbox. It cannot reliably intercept raw `process.binding` or native-addon/FFI calls, networking delegated to child processes, or network activity in worker threads with separate module state. The harness does not use those paths. The production gate remains unmet.

## Gates before any production proposal

The offline tests do not establish live provider cache hit rates, actual spend reduction, real request latency, or answer-quality parity on production-eligible material. Those require fresh, source-pinned evaluation on a currently verified company-controlled OpenAI-direct path, with content-free usage evidence and an approved non-sensitive quality set. Mutable or permission-dependent company answers remain excluded from exact-response caching.

Cloudflare AI Gateway stays out of scope until an exact company-controlled request route and account binding are proven, and its cache-key, TTL, invalidation, and payload logging controls pass a privacy review. No production traffic shift is authorized by this harness.
