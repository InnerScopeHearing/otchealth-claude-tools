---
name: release-evidence
description: Complete an authorized software or plugin release while proving built, tested, reviewed, merged, deployed and accepted states, live revision, health and rollback path.
---

# Release evidence

Resolve concrete resulting behavior, authorized scope, source owner, repository/branch/commit and deployment environment. Follow applicable source-owner instructions. One writer owns integration and each deployment target.

| State | Evidence |
| --- | --- |
| Built | Actual source revision and produced artifact/hash. |
| Tested | Appropriate checks executed at that revision, with failures/limits preserved. |
| Reviewed | Independent review of final change and material risks. |
| Merged | Authoritative target-branch readback containing the change, when applicable. |
| Deployed | Provider release ID plus runtime revision matching intended artifact. |
| Accepted | Independent live behavior in requested client/environment, health and rollback/restore evidence. |

Complete already-authorized applicable release steps. Prepare a concrete reviewable artifact before truly required approval. Green CI, saved plugin, package upload or health alone does not establish client adoption.

Plugin updates require exact current source/release, preserved identity/audience/integrations/default prompts and current-release guard. Reconcile uncertain publications before retry. An instruction plugin creates no server or background service.

If deployment is in scope verify live revision, harmless health/behavior read and supported rollback target. Label rollback documented, available or exercised; do not perform it merely for evidence unless authorized.

Test relevant behavior and failure/authority boundaries; complete required checks. Broaden only for new defects or unresolved risks. Preserve evidence and reviewer-facing description.

No paid fallback, permission changes, workflow-control changes or unrelated production writes follow from release authority.

Return six independent states and IDs/hashes/gates. Published package with no cloud-host invocation means publication verified, adoption unproven.
