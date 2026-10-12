# Developer cloud connection

Use the already authenticated OTCHealth Developer app for ordinary work. If that client's cached tool schema omits a required current option, the direct cloud session client can use the live gateway schema without changing the client's cache or permissions. It also avoids the desktop credential resolver, which requires an AWS credential source that a cloud task may not have.

The direct connection is a separate Developer-only OAuth session. It does not refresh the native Codex app, create a project, move a chat or grant an AWS role. The gateway continues to enforce all tool, role and protected-ring permissions.

## Enrollment

The authorized CTO uses the existing `connector_setup_code_create` tool for role `developer`, with a short TTL and a label identifying this cloud task. Never write the code to Brain, GitHub, a shared log or an argument on a command line. The owner-authorized setup code is supplied through the bootstrap process's private stdin. Developer cannot issue its own code or choose an executive/personal-legal role.

Run the client in the Developer task's own cloud workspace. In Codex Cloud with Node 24, preserve the inherited proxy and CA settings and use `node --use-env-proxy`. Tokens are stored only in the explicitly chosen owner-only session cache; do not put that cache in a repository or synchronize it to another identity. The native app connection remains usable.

Use the source from the reviewed merged toolkit commit. Bootstrap accepts the owner code only through private stdin; disable terminal echo if stdin is a terminal. Never insert the code into a shell command or a JSON argument file.

```sh
node --use-env-proxy skills/gateway-connect/cloud-session.mjs bootstrap --session-dir /absolute/private/session-directory
node --use-env-proxy skills/gateway-connect/cloud-session.mjs status --session-dir /absolute/private/session-directory
node --use-env-proxy skills/gateway-connect/cloud-session.mjs schema task_get --session-dir /absolute/private/session-directory
node --use-env-proxy skills/gateway-connect/cloud-session.mjs call task_get --args-file /absolute/task-arguments.json --session-dir /absolute/private/session-directory
```

The session directory must be outside every Git working tree, owned by the current user and mode 0700; its credential file is mode 0600. Bootstrap exclusively creates a new directory and refuses to overwrite an existing connection. The status command exercises authenticated Developer identity, without displaying credentials. Each schema/call checks Developer identity and current tool visibility. A refresh happens before a request when the stored access token approaches expiry. No tool call is automatically replayed after an uncertain outcome.

For a coordination-only task read, the nonsecret arguments file can contain:

```json
{"task_id":"the-existing-task-id","board":"its-board","view":"metadata","context_need":"coordination","include_events":false,"dry_run":false}
```

For AWS access, read `schema aws_mcp_tool_call`, then pass `tool_name`, `arguments` and the intended `region` to `call aws_mcp_tool_call`. The Developer must use its own OAuth session; do not borrow a CTO bearer. Validate `api_calls` and the assumed-role identity in the returned AWS receipt. Never equate catalog discovery or a zero shell exit alone with a successful operation: inspect the returned MCP and upstream error/status fields.

## Work after enrollment

Retrieve the schema for one needed tool, then call that tool with the actual supported fields. Avoid sending a complete tool inventory to the model. Compact `task_get` is only for coordination; use full detail and event evidence for implementation, approvals, history and corrections. Do not infer an approval from an omitted field.

AWS metadata reads use the existing renewable assumed-role gateway bridge. AWS writes continue through the already reviewed GitHub OIDC workflows for the authorized operation. The interactive AWS Core/Analytics connection remains a separate connection and may still require its owner's sign-in; this client does not renew it.

Failure handling: one enrollment attempt, no retry after an unknown code redemption or write outcome; one refresh attempt before a request when expiry requires it. Surface authentication failures with a sanitized action, preserving work. Do not change the gateway issuance policy, weaken checks, replay a failed permission request under another role, or start paid device/query runs.
