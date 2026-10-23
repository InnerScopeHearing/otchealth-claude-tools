# AWARE Device Farm reader repair

Scope: fix the missing `devicefarm:GetProject` identity grant while preserving the existing project-scoped `devicefarm:GetRun` metadata grant, not general Developer tooling or IAM administration. The gateway's renewable assumed-role AWS bridge is healthy. Its dedicated reader role cannot repair its own permissions.

## Diagnosed cause

The initial reported `GetRun` denial said no identity-based policy allowed the operation. AWS-managed `ViewOnlyAccess` grants `devicefarm:List*`, not `GetRun`. After the run-only v2 policy was applied and its exact document read back, the same gateway reader's call for the AWARE run was still denied on the AWARE project ARN (source review `SARCORR1083bf90`, operation denial `corre5445fbc`). AWS's Service Authorization Reference lists the run resource for `GetRun`; this observed call also names the exact project ARN as missing, so the follow-up is limited to those two known ARNs. A live `iam:GetRole` diagnostic was also denied, so this source diagnosis does not claim a complete live boundary, SCP or session-policy audit.

The follow-up grant keeps `devicefarm:GetRun` on the exact run ARN `arn:aws:devicefarm:us-west-2:900915535335:run:58bbc541-f082-4594-b744-738a345f3654/*` and adds only the exact project ARN `arn:aws:devicefarm:us-west-2:900915535335:project:58bbc541-f082-4594-b744-738a345f3654`, conditioned on IAM principal ARN `arn:aws:iam::900915535335:role/otchealth-ai-reader-role`. The condition excludes the human reader user, although the existing extras policy is shared. Both provisioning sources (`aws-ai-access-2026-10-07.sh` and `aws-ai-reader-role-only-2026-10-09.py`) carry the same extras document. Monitoring statements, explicit denies, billing grants, trust and attachments stay unchanged. No new inline policy or identity is introduced.

Official references:

- <https://docs.aws.amazon.com/aws-managed-policy/latest/reference/ViewOnlyAccess.html>
- <https://docs.aws.amazon.com/service-authorization/latest/reference/list_devicefarm.html>
- <https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_condition-keys.html#condition-keys-principalarn>

## Owner deployment

Run from the reviewed repository revision in AWS CloudShell using the existing account owner/admin session for account `900915535335`. By default the helper accepts the existing non-root owner/admin identity and refuses root. If the authorized operator has selected the existing account root session for this repair, pass the explicit `--allow-root-owner` opt-in with `--check` and `--apply`; it accepts only the exact `arn:aws:iam::900915535335:root` identity in that account. The opt-in does not accept a wrong-account root, the reader user, or the reader role. It does not change the requested IAM grant or skip any policy, role, attachment, version-capacity, preimage, recheck, single-write, or readback guard. Do not create keys, borrow another seat's credential, or rerun the broad `aws-ai-access` bootstrap for this one-policy fix.

```bash
bash setup/iam/aware-devicefarm-reader-repair.sh --check
bash setup/iam/aware-devicefarm-reader-repair.sh --apply
```

For the explicit account-root path only:

```bash
bash setup/iam/aware-devicefarm-reader-repair.sh --check --allow-root-owner
bash setup/iam/aware-devicefarm-reader-repair.sh --apply --allow-root-owner
```

Default mode is read-only `--check`. `--apply` makes at most one `CreatePolicyVersion` call on the existing extras managed policy and sets that version as default. It preserves the old default version and writes private preimage, response, postimage and receipt files in a mode-700 temporary directory (files mode 600). It accepts only the exact three-policy role-only layout (ViewOnlyAccess, extras, deny) or the exact four-policy bootstrap layout (those three plus billing); billing is neither attached nor removed. Without `--allow-root-owner`, it refuses root and the reader identities; with that flag, it allows only the exact account root ARN while continuing to refuse the reader identities and wrong-account callers. It refuses unexpected role trust/boundary, missing critical or extra attachment, inline policy, changed deny/extras policy, or five occupied policy-version slots. It never removes versions, rewrites trust, changes attachments, retries a write or automatically rolls back.

For the extras preimage, the helper recognizes exactly two reviewed baselines: current `MonitoringReads` plus `SchedulerGetOwnedScheduleMetadata`, and legacy `MonitoringReads` only. For each it accepts the known v2 run-only AWARE statement as a migration preimage and creates the corresponding two-resource statement above; it also accepts the exact corrected target as already applied. The legacy path does not add Scheduler permission; the current path preserves its Scheduler statement. Any other statement, duplicate, or modified statement remains drift and is refused.

IAM offers no atomic compare-and-set for the default version. A final pre-write read narrows but does not eliminate the race; coordinate this single policy writer with other owners. An uncertain write, unexpected postimage or concurrent role change is a reconciliation condition, not permission to retry. Preserve private evidence. A rollback command for the exact previous default version is printed only after successful readback; use it only after owner reconciliation.

The connected reader cannot execute this operation, and the inspected existing OIDC workflows do not grant writes to this policy. Do not expand the recovery-console role or repurpose the retired Azure OAuth workflows. Source merge and tests are not live IAM deployment receipts.

## Verification after a successful owner receipt

Use the same renewable reader bridge for the original AWARE `GetRun` once the applied policy has propagated. Retain the provider receipt; if another policy layer still denies it, diagnose that layer without switching identity. A `GetRun` success proves metadata access only, not a Device Farm run or a complete Premium Pass.

Preserve the already accepted internal TestFlight build `1.4.0 (1779565795)`, immutable app source `f4055fec97e2f80dca789f3053e9cc12e8ee7d53`, original IPA and its SHA-256 `68b7a0ddcaaa04f1a45a181d812f592cfb6bec7b6110e503dda56f75ed38e3bc`. Do not rebuild, sign again, re-upload or reuse the older `1779565794` Device Farm run as evidence for this build. Exact-build Device Farm and real commerce/assistive-audio acceptance remain separate evidence requirements.

## Regression tests

```bash
node --test setup/aws/tests/aware-devicefarm-reader.test.mjs
bash setup/aws/tests/run-owner-script-tests.sh
bash run-tests.sh
```

The new `*.test.mjs` is discovered automatically by the existing toolkit gate. All provider mutation scenarios use an isolated fake CLI; no credentials or live AWS calls are involved. Negative tests require their specific failure reason so an unrelated early guard cannot create a false pass.
