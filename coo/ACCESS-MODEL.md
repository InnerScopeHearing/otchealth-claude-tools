# COO Access Model — what the COO can reach, and how to set it (action once)

The COO is the director/quarterback. Its power is **read everything, coordinate
everything, create new buckets** — NOT edit every line of production code itself.
This doc is the one-time setup so the COO has exactly the right reach, and the
reasoning so we never relitigate it.

## How access actually works (the facts)
- A Claude Code web session **can access any repo the connecting GitHub account can
  see.** The connecting account (Matt / org owner) can see all repos, so the ceiling
  is already "all of them."
- The real limiter is the **per-session repo scope chosen when the environment is
  created.** It is NOT an environment variable and cannot be changed from inside a
  running session.
- **Creating** repos additionally needs the Claude GitHub App to have **Administration**
  permission on the org. Without it you get `403 Resource not accessible by integration`.
- The environment env-var store is **not** a secrets vault (visible to anyone who can
  edit the environment). Secrets stay in the `otchealth-shared-prod` Secret Manager.

## The recommended COO scope (least privilege on purpose)
| Capability | COO? | Where it happens instead |
| --- | --- | --- |
| Read all 14 repos | YES | already works |
| Write to `otchealth-claude-tools`, `otchealth-cto`, `otchealth-ops` | YES | coordination repos the COO directs from |
| Create new repos (spin up buckets) | YES | needs App Administration perm |
| Write to app code (iheartest, aware, companion, etc.) | NO | CTO + builders, through QA -> Guardian -> Release gates |
| Write to the PHI repo (`medreview`) | NO | CTO/clinical, on the compliant path only |

**Why not full god-mode:** this COO session ingests untrusted external email (the
BCC/inbound wake loop). Every repo it can write to is blast radius if a malicious email
ever beats the injection guards. Least privilege is what keeps that loop safe. Routing
app/PHI changes through the CTO preserves the release gates a direct COO write would
bypass. A great director reads-all, coordinates-all, and creates — it does not hand-edit
production.

## Setup checklist (Matt, action once)
1. **Widen the GitHub App permissions.** GitHub -> org **InnerScopeHearing** -> Settings
   -> GitHub Apps / Installed Apps -> **Claude** -> Configure:
   - Repository access: **All repositories** (the connecting account already sees all;
     this aligns the App for Auto-fix + creation).
   - Permissions: **Administration: Read & write** (enables repo creation), **Contents:
     Read & write**, **Pull requests: Read & write**, **Workflows** as needed.
2. **Set the COO environment's repo scope.** At claude.ai/code, edit (or recreate) the
   COO environment and select the three coordination repos:
   `otchealth-claude-tools`, `otchealth-cto`, `otchealth-ops`. (Add others only if the
   COO will truly edit them.)
3. **Start a fresh COO session** so the new scope + permissions take effect. Scope binds
   at launch; existing sessions keep their original scope.
4. **Verify:** in the new session ask the COO to create a throwaway private repo and
   delete it, and to push a trivial commit to `otchealth-cto`. If both succeed, the model
   is live.

## Notes
- App-level write across ALL repos is possible (step 1 with All repositories + Contents
  write) if you ever want it, but keep the email-listening COO session out of that scope;
  give broad write to the CTO session instead, which does not ingest untrusted email.
- This is storage/permission only. The content rules, PHI ring, and securities firewall
  still bind every session regardless of access.
