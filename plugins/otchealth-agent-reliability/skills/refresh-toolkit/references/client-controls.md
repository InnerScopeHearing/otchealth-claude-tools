# Supported client controls

Choose the product that owns the failed binding. These instructions describe a workflow; only a callable tool, verified product UI or supported runtime command can execute it.

| Product | Supported approach and evidence |
| --- | --- |
| Ordinary Chat | Use the matching plugin's supported settings/update control. Custom MCP app Refresh may be an owner/admin product control; an action schema changing on the server does not refresh an existing Chat by itself. Observe the same Chat's new bindings and permitted invocation. Respect workspace review and newly disabled actions. |
| Codex local | Repository/user skill discovery, installed plugin version and effective local configuration are distinct. Codex normally detects skill changes automatically; if it does not, use its supported restart/reload after preserving context and pending-write handles. |
| ChatGPT Work | Work runs in a managed environment and does not read local Codex configuration files. Use Work's exposed controls and effective task policy; changing a laptop config cannot establish a repair. Managed global orchestrator policy cannot be overridden by a local executor setting. A ChatGPT app permission setting does not override Work execution policy. |
| Codex cloud | Update the correct repository/environment and verify the actual task checkout and own loader. A local configuration or laptop cache change does not update a running cloud task. |
| Claude Code / Cowork | Use that client's documented skill/plugin update control and discovery paths. A repository copy is source preparation until the actual supported client/session loads it. |

For a local-marketplace Codex plugin, the documented `plugins.<plugin>.enabled` config setting uses the exact `plugin-name@marketplace-name` key. Its effective merged config can differ from one file, and workspace-managed enabled states can constrain it. Disabling does not promise removal of cached files: marketplace refresh can still install/refresh a configured disabled package. Use a supported uninstall when full removal is authorized and available. Never use ChatGPT's app-uninstall tool for a Codex code plugin.

For the demonstrated retired Azure package, the exact key is `azure@claude-plugins-official`. It belongs in retirement cleanup; missing frontmatter in that old installation is not a reason to restore Azure to the active company stack. Do not copy a full credential-bearing config into a handoff.

Before diagnosing permissions, distinguish provider OAuth/scopes, ChatGPT app confirmation mode, Codex task approval policy, filesystem sandbox and managed workspace requirements. Inspect only the relevant layer. Preserve an exact approval rejection and require the owning product's supported policy/admin action instead of editing another layer speculatively.

Primary sources to verify when controls change:

- https://developers.openai.com/codex/skills
- https://developers.openai.com/codex/config-reference
- https://learn.chatgpt.com/docs/developer-settings
- https://learn.chatgpt.com/docs/enterprise/agent-security
- https://help.openai.com/en/articles/11487775-connectors-in-chatgpt

Snapshot contract for `scripts/classify-toolkit.ps1`: JSON with `schema_version: 1`, nonempty `client_id`, `session_id`, `seat`, `captured_at_utc`, optional sanitized `errors`, optional `pending_writes` containing only `intent_id` and `state`, and optional `capabilities` containing `id`, boolean `available`, optional booleans `retired`, `invoked`, `configured_enabled` and `loader_failed`, plus optional `expected_revision` and `loaded_revision`. A retired package's absent binding does not establish disabled configuration or successful loader cleanup. Prefix an error with `Provider:` only when its origin is independently known; a bare 403/OAuth/forbidden message leaves the authorization layer unverified. IDs and errors must contain no credentials or protected data. The classifier validates this metadata and supplies fixed next-action categories; declaring fields in JSON is not live acceptance evidence.
