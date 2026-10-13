# AWARE Device Farm reader repair

Scope: fix the missing `devicefarm:GetRun` identity grant, not general Developer tooling or IAM administration. The gateway's renewable assumed-role AWS bridge is healthy. Its dedicated reader role cannot repair its own permissions.

## Diagnosed cause

The reported `GetRun` denial says no identity-based policy allows the operation. AWS-managed `ViewOnlyAccess` grants `devicefarm:List*`, not `GetRun`. The current owner provisioning source had no Device Farm addition in its extras policy. A live `iam:GetRole` diagnostic is also denied, so this source diagnosis does not claim a complete live boundary, SCP or session-policy audit.

The fix adds only `devicefarm:GetRun` on `arn:aws:devicefarm:us-west-2:900915535335:run:58bbc541-f082-4594-b744-738a345f3654/*`, conditioned on the IAM principal ARN `arn:aws:iam::900915535335:role/otchealth-ai-reader-role`. The condition excludes the human reader user, although the existing extras policy is shared. All existing monitoring statements, explicit denies, billing grants, trust and attachment rules are preserved. No new inline policy or identity is introduced.

Official references:

- <https://docs.aws.amazon.com/aws-managed-policy/latest/reference/ViewOnlyAccess.html>
- <https://docs.aws.amazon.com/service-authorization/latest/reference/list_devicefarm.html>
- <https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_condition-keys.html#condition-keys-principalarn>

## Owner deployment

Run from the reviewed repository revision in AWS CloudShell using the existing **non-root owner/admin session** for account `900915535335`. Do not use the AI reader, create keys, borrow another seat's credential, or rerun the broad `aws-ai-access` bootstrap for this one-policy fix.

```bash
bash setup/iam/aware-devicefarm-reader-repair.sh --check
bash setup/iam/aware-devicefarm-reader-repair.sh --apply
```

Default mode is read-only `--check`. `--apply` makes at most one `CreatePolicyVersion` call on the existing extras managed policy and sets that version as default. It preserves the old default version and writes private preimage, response, postimage and receipt files in a mode-700 temporary directory (files mode 600). It refuses a wrong account, root/reader caller, unexpected role trust/boundary, missing or extra attachment, inline policy, changed deny/extras policy, or five occupied policy-version slots. It never removes versions, rewrites trust, changes attachments, retries a write or automatically rolls back.

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
