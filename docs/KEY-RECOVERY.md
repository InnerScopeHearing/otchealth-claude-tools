# Key recovery runbook — the one credential the whole system bootstraps from

The entire tooling system hydrates from a single secret. If it is lost or broken,
sessions stop getting credentials. This is the recover-it runbook (bus-factor insurance).

## The one key
- **`GCP_CLAUDE_DRIVER_SA_JSON`** = the full JSON of the `claude-driver@otchealth-shared-prod`
  Google service-account key. It is the ONLY env secret set in each Claude Code
  environment. Everything else (OpenAI, ElevenLabs, Depot, PostHog, Miro, the PHI .p8s,
  FourVault keys, ...) is pulled from **GCP Secret Manager** at session start using it.

## Where the source of truth lives
- The SA key JSON is in the **Notion vault** -> "Google Cloud - Claude Driver SA" /
  "Claude Driver SA".
- The 40 downstream secrets live in **GCP Secret Manager (project `otchealth-shared-prod`)**.
- The installer that uses them: `setup/session-start.sh` + `setup/fetch-secrets.mjs`.

## What breaks if the key is lost / revoked
- New sessions can't fetch secrets -> the designer skill, diagrammer, and any tool
  needing OpenAI/Vertex/ElevenLabs/etc. go dark. Agents still install (they're files),
  but credentialed actions fail. The Secret Manager contents are safe; only the *reader*
  is gone.

## Recover (10 minutes, needs a GCP project Owner)
1. In GCP Console -> IAM & Admin -> Service Accounts -> `claude-driver@otchealth-shared-prod`.
2. Keys -> **Add key -> JSON** -> download the new key file.
3. Confirm the SA still has `roles/secretmanager.secretAccessor` (and `secretmanager.admin`
   if you want it to keep provisioning).
4. Paste the **entire** new JSON as the `GCP_CLAUDE_DRIVER_SA_JSON` environment secret in
   each Claude Code environment (and update the Notion vault entry).
5. Start a session; `session-start.sh` should log the keys loading again.
6. Delete the old/compromised key version in the SA's Keys list.

## Rotate (no outage)
Same as recover, but add the new key before deleting the old, and roll the env secret.
The SA email and Secret Manager contents do not change, so nothing downstream needs editing.

## If the GCP project itself is lost
Worst case. The downstream secrets also live, in their original form, in the **Notion
vault** (every token was saved there). Re-create the Secret Manager secrets from the
vault using the `gcloud secrets create` commands in `docs/PLATFORM.md`, then issue a new
SA + key. The vault is the ultimate backstop, keep it current.

## Bus-factor note
Make sure at least one trusted person besides you can reach the GCP project as Owner and
the Notion vault. The whole system's continuity depends on those two.
