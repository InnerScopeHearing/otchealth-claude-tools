# Runbook: editing otchealth-mcp-gateway environment variables

**This is the ONE supported way to change an env var on the gateway (or any
sibling Container App). Do not use inline `az containerapp update --set-env-vars
"KEY=value"` anymore** — it has caused three separate production incidents
(emptied JSON array, clobbered secretRef, `@`-in-value failure).

## What replaces it

- Workflow: [`.github/workflows/manage-gateway-env.yml`](../.github/workflows/manage-gateway-env.yml)
- Core script: [`scripts/manage_gateway_env.py`](../scripts/manage_gateway_env.py)
- Tests: [`tests/test_manage_gateway_env.py`](../tests/test_manage_gateway_env.py)

The script reads the full resource as JSON, edits
`properties.template.containers[0].env` as structured Python data, and applies it
with `az containerapp update --yaml`. Values are never interpolated into a shell
string, so `@`, quotes, spaces, and JSON arrays are just data.

## How to run (workflow_dispatch)

Actions → **manage-gateway-env** → Run workflow. Inputs:

| input | meaning |
|-------|---------|
| `name` | env var name, e.g. `GRAPH_DRIVE_USER` |
| `value` | the literal value, **or** the secret name if `value_type=secretref` |
| `value_type` | `literal` or `secretref` |
| `operation` | `upsert` (default), `add` (must not exist), `update` (must exist) |
| `app_name` / `resource_group` | default to the gateway |
| `allow_type_change` | required to convert a key literal↔secretref |
| `dry_run` | validate + print diff, do not apply |

## Safety guarantees (why this can't repeat the old incidents)

1. **secretRef preservation** — writing a key that is currently a `secretRef`
   is *refused* unless you pass `value_type=secretref` (to keep it) or explicitly
   set `allow_type_change=true`. No silent secretRef→literal flattening.
2. **Regression guard** — after computing the new env array the script diffs it
   against the old one and **fails loudly** if *any other key* changed (value,
   secretRef, or presence). The self-test job repeats this with an independent
   `jq`/`diff` check.
3. **Special characters** — because the value is only ever a JSON string,
   `matthew@innd.com` and JSON-array payloads round-trip byte-for-byte.
4. **Race-free diagnostics** — proof artifacts are committed to a fresh,
   uniquely-named branch after `git fetch && git reset --hard origin/main`, then
   opened as a PR. Nothing pushes to `main` directly. Ephemeral output goes to
   `$GITHUB_STEP_SUMMARY`.

## Self-test

Touching `tests/gateway-env-selftest.trigger` on `main` runs the self-test: it
sets `GRAPH_DRIVE_USER=matthew@innd.com` for real, runs the unit tests + the
independent regression diff, and opens a PR with an env before/after proof.
