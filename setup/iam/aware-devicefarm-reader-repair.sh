#!/usr/bin/env bash
# Owner/admin CloudShell repair for the existing AWARE reader policy. Default: read-only check.
# This is NOT the broad account bootstrap. It never creates identities, credentials or attachments,
# changes trust/boundaries, deletes policy versions, or retries a write. Run only from reviewed source.
set -euo pipefail
umask 077
export AWS_PAGER="" AWS_MAX_ATTEMPTS=1
mode=--check
mode_seen=0
allow_root_owner=false
for argument in "$@"; do
  case "$argument" in
    --check|--apply)
      if [ "$mode_seen" -eq 1 ]; then
        echo 'Usage: bash aware-devicefarm-reader-repair.sh [--check|--apply] [--allow-root-owner]' >&2
        exit 2
      fi
      mode="$argument"
      mode_seen=1
      ;;
    --allow-root-owner)
      if [ "$allow_root_owner" = true ]; then
        echo 'Usage: bash aware-devicefarm-reader-repair.sh [--check|--apply] [--allow-root-owner]' >&2
        exit 2
      fi
      allow_root_owner=true
      ;;
    *)
      echo 'Usage: bash aware-devicefarm-reader-repair.sh [--check|--apply] [--allow-root-owner]' >&2
      exit 2
      ;;
  esac
done
for dependency in aws jq awk mktemp; do
  command -v "$dependency" >/dev/null || { echo "STOP: missing $dependency" >&2; exit 1; }
done
account=900915535335
role_name=otchealth-ai-reader-role
role_arn="arn:aws:iam::$account:role/$role_name"
policy_arn="arn:aws:iam::$account:policy/otchealth-ai-reader-extras"
deny_arn="arn:aws:iam::$account:policy/otchealth-ai-reader-deny"
sid=AwareDeviceFarmRunMetadataOnly
scheduler_sid=SchedulerGetOwnedScheduleMetadata
run_arn="arn:aws:devicefarm:us-west-2:$account:run:58bbc541-f082-4594-b744-738a345f3654/*"
project_arn="arn:aws:devicefarm:us-west-2:$account:project:58bbc541-f082-4594-b744-738a345f3654"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source_file="$script_dir/aws-ai-access-2026-10-07.sh"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/aware-reader-repair.XXXXXX")"
chmod 700 "$work_dir"
stop() { echo "STOP: $1. Private evidence: $work_dir; do not retry an uncertain write." >&2; exit 1; }
read_aws() {
  local destination="$1"
  shift
  if ! aws "$@" --region us-east-1 --output json > "$destination" 2> "$work_dir/aws-error.txt"; then
    stop "AWS read failed ($1 $2); no permission bypass attempted"
  fi
  jq -e . "$destination" >/dev/null || stop 'invalid AWS response'
}
extract_policy() {
  local marker="$1" destination="$2"
  awk -v marker="$marker" '
    $0 ~ "<<\047" marker "\047$" { inside=1; next }
    inside && $0 == marker { exit }
    inside { print }
  ' "$source_file" > "$destination"
  jq -e 'type == "object" and .Version == "2012-10-17" and (.Statement | type == "array")' "$destination" >/dev/null || stop 'invalid reviewed policy source'
}
[ -f "$source_file" ] || stop 'sibling reviewed bootstrap source is missing'
extract_policy EXTRAS_JSON "$work_dir/desired.json"
extract_policy DENY_JSON "$work_dir/expected-deny.json"
jq -e --arg role "$role_arn" --arg sid "$sid" '
  [.Statement[] | select(.Sid == $sid)] == [{
    Sid: $sid, Effect: "Allow", Action: ["devicefarm:GetRun"],
    Resource: ["arn:aws:devicefarm:us-west-2:900915535335:run:58bbc541-f082-4594-b744-738a345f3654/*",
      "arn:aws:devicefarm:us-west-2:900915535335:project:58bbc541-f082-4594-b744-738a345f3654"],
    Condition: {ArnEquals: {"aws:PrincipalArn": $role}}
  }]
' "$work_dir/desired.json" >/dev/null || stop 'repair grant is not the exact reviewed action, project and role'
jq -e --arg role "$role_arn" --arg sid "$scheduler_sid" '
  ([.Statement[].Sid] | sort) == (["MonitoringReads", $sid, "AwareDeviceFarmRunMetadataOnly"] | sort) and
  [.Statement[] | select(.Sid == $sid)] == [{
    Sid: $sid, Effect: "Allow", Action: ["scheduler:GetSchedule"],
    Resource: "arn:aws:scheduler:us-east-1:900915535335:schedule/default/otchealth-*",
    Condition: {ArnEquals: {"aws:PrincipalArn": $role}}
  }]
' "$work_dir/desired.json" >/dev/null || stop 'reviewed Scheduler source differs from the exact known statement'
jq --arg sid "$sid" '.Statement |= map(select(.Sid != $sid))' "$work_dir/desired.json" > "$work_dir/baseline.json"
jq --arg sid "$scheduler_sid" '.Statement |= map(select(.Sid != $sid))' "$work_dir/baseline.json" > "$work_dir/legacy-baseline.json"
jq --arg sid "$scheduler_sid" '.Statement |= map(select(.Sid != $sid))' "$work_dir/desired.json" > "$work_dir/legacy-desired.json"
jq --arg sid "$sid" --arg run "$run_arn" '.Statement |= map(if .Sid == $sid then .Resource = $run else . end)' "$work_dir/desired.json" > "$work_dir/run-only-desired.json"
jq --arg sid "$scheduler_sid" '.Statement |= map(select(.Sid != $sid))' "$work_dir/run-only-desired.json" > "$work_dir/run-only-legacy-desired.json"
read_aws "$work_dir/identity.json" sts get-caller-identity
jq -e --arg account "$account" --arg allow_root_owner "$allow_root_owner" '
  .Account == $account and (.Arn | type == "string") and
  ((.Arn == ("arn:aws:iam::" + $account + ":root") and $allow_root_owner == "true") or
   (.Arn | test("^arn:aws:(iam|sts)::" + $account + ":(user/|assumed-role/).+"))) and
  (.Arn | test("(:user/otchealth-ai-reader$|:assumed-role/otchealth-ai-reader-role/)") | not)
' "$work_dir/identity.json" >/dev/null || stop 'use the existing account owner/admin session; root requires --allow-root-owner and the AI reader is never allowed'
read_aws "$work_dir/role-before.json" iam get-role --role-name "$role_name"
jq -e --arg role "$role_arn" --arg account "$account" '
  .Role.Arn == $role and (.Role.PermissionsBoundary == null) and
  (.Role.AssumeRolePolicyDocument.Version == "2012-10-17") and
  (.Role.AssumeRolePolicyDocument.Statement | length == 1) and
  (.Role.AssumeRolePolicyDocument.Statement[0] as $s |
    $s.Sid == "GatewayTaskRoleOnly" and $s.Effect == "Allow" and $s.Action == "sts:AssumeRole" and
    ($s.Condition == null) and ($s.Principal | keys == ["AWS"]) and
    ($s.Principal.AWS == ("arn:aws:iam::" + $account + ":role/otchealthTaskRole") or
     $s.Principal.AWS == ("arn:aws:iam::" + $account + ":role/otchealthGatewayTaskRole")))
' "$work_dir/role-before.json" >/dev/null || stop 'reader role, trust or boundary differs from reviewed provisioning'
read_aws "$work_dir/attachments.json" iam list-attached-role-policies --role-name "$role_name"
jq -e --arg account "$account" '
  [.AttachedPolicies[].PolicyArn] | sort as $actual |
  ([
    "arn:aws:iam::aws:policy/job-function/ViewOnlyAccess",
    "arn:aws:iam::" + $account + ":policy/otchealth-ai-reader-extras",
    "arn:aws:iam::" + $account + ":policy/otchealth-ai-reader-deny"
  ] | sort) as $core |
  ($actual == $core or $actual == ($core + ["arn:aws:iam::" + $account + ":policy/otchealth-ai-reader-billing"] | sort))
' "$work_dir/attachments.json" >/dev/null || stop 'reader attachments differ from the exact reviewed three/four-policy profiles'
read_aws "$work_dir/inline.json" iam list-role-policies --role-name "$role_name"
jq -e '.PolicyNames == []' "$work_dir/inline.json" >/dev/null || stop 'unexpected reader inline policy'
read_aws "$work_dir/deny-policy.json" iam get-policy --policy-arn "$deny_arn"
deny_version="$(jq -er '.Policy.DefaultVersionId | select(test("^v[1-9][0-9]*$"))' "$work_dir/deny-policy.json")"
read_aws "$work_dir/deny-live.json" iam get-policy-version --policy-arn "$deny_arn" --version-id "$deny_version"
jq -e --slurpfile expected "$work_dir/expected-deny.json" '.PolicyVersion.Document == $expected[0]' "$work_dir/deny-live.json" >/dev/null || stop 'existing explicit deny policy differs; it must be preserved'
read_aws "$work_dir/policy-before.json" iam get-policy --policy-arn "$policy_arn"
jq -e --arg arn "$policy_arn" '.Policy.Arn == $arn' "$work_dir/policy-before.json" >/dev/null || stop 'unexpected policy identity'
before_version="$(jq -er '.Policy.DefaultVersionId | select(test("^v[1-9][0-9]*$"))' "$work_dir/policy-before.json")"
read_aws "$work_dir/preimage.json" iam get-policy-version --policy-arn "$policy_arn" --version-id "$before_version"
if jq -e --slurpfile desired "$work_dir/desired.json" '.PolicyVersion.Document == $desired[0]' "$work_dir/preimage.json" >/dev/null; then
  echo "ALREADY_APPLIED: exact M+Scheduler+GetRun policy is default ($before_version); no writes."
  exit 0
fi
if jq -e --slurpfile desired "$work_dir/legacy-desired.json" '.PolicyVersion.Document == $desired[0]' "$work_dir/preimage.json" >/dev/null; then
  echo "ALREADY_APPLIED: exact M+GetRun policy is default ($before_version); no writes."
  exit 0
fi
if jq -e --slurpfile desired "$work_dir/run-only-desired.json" '.PolicyVersion.Document == $desired[0]' "$work_dir/preimage.json" >/dev/null ||
   jq -e --slurpfile desired "$work_dir/run-only-legacy-desired.json" '.PolicyVersion.Document == $desired[0]' "$work_dir/preimage.json" >/dev/null; then
  preimage_variant=run_only_migration
else
  preimage_variant=
fi
desired_file="$work_dir/desired.json"
if [ "$preimage_variant" = run_only_migration ]; then
  # The only run-only preimages accepted are the exact deployed v2 documents above.
  if jq -e --slurpfile previous "$work_dir/run-only-desired.json" '.PolicyVersion.Document == $previous[0]' "$work_dir/preimage.json" >/dev/null; then
    preimage_variant=monitoring_plus_scheduler_run_only
  else
    desired_file="$work_dir/legacy-desired.json"
    preimage_variant=monitoring_only_run_only
  fi
elif jq -e --slurpfile baseline "$work_dir/baseline.json" '.PolicyVersion.Document == $baseline[0]' "$work_dir/preimage.json" >/dev/null; then
  preimage_variant=monitoring_plus_scheduler
elif jq -e --slurpfile baseline "$work_dir/legacy-baseline.json" '.PolicyVersion.Document == $baseline[0]' "$work_dir/preimage.json" >/dev/null; then
  desired_file="$work_dir/legacy-desired.json"
  preimage_variant=monitoring_only
else
  stop 'existing extras policy drift; no unknown statements will be overwritten'
fi
read_aws "$work_dir/versions.json" iam list-policy-versions --policy-arn "$policy_arn"
jq -e --arg version "$before_version" '
  (.Versions | length < 5) and ([.Versions[] | select(.IsDefaultVersion == true) | .VersionId] == [$version])
' "$work_dir/versions.json" >/dev/null || stop 'no safe version slot or unexpected default; no versions will be deleted'
jq -n --arg policy "$policy_arn" --arg version "$before_version" --arg mode "$mode" --arg rootopt "$allow_root_owner" --arg preimage "$preimage_variant" '{policyArn:$policy,previousDefaultVersion:$version,mode:$mode,rootOwnerOptIn:($rootopt == "true"),preimageVariant:$preimage,writeAttempted:false}' > "$work_dir/receipt.json"
if [ "$mode" = --check ]; then
  echo "READY: exact AWARE GetRun-only repair; no writes. Private evidence: $work_dir"
  exit 0
fi
# Narrow the unavoidable IAM compare/write race; IAM does not support a conditional version update.
read_aws "$work_dir/policy-recheck.json" iam get-policy --policy-arn "$policy_arn"
jq -e --arg version "$before_version" '.Policy.DefaultVersionId == $version' "$work_dir/policy-recheck.json" >/dev/null || stop 'default changed before apply'
jq '.writeAttempted = true' "$work_dir/receipt.json" > "$work_dir/attempt.json"
mv "$work_dir/attempt.json" "$work_dir/receipt.json"
if ! aws iam create-policy-version --policy-arn "$policy_arn" --policy-document "file://$desired_file" --set-as-default --region us-east-1 --output json > "$work_dir/write-response.json" 2> "$work_dir/aws-error.txt"; then
  stop 'single policy write did not return success; reconcile the default version before any further action'
fi
after_version="$(jq -er '.PolicyVersion.VersionId | select(test("^v[1-9][0-9]*$"))' "$work_dir/write-response.json")"
read_aws "$work_dir/policy-after.json" iam get-policy --policy-arn "$policy_arn"
jq -e --arg version "$after_version" '.Policy.DefaultVersionId == $version' "$work_dir/policy-after.json" >/dev/null || stop 'new default not confirmed; no automatic retry or rollback'
read_aws "$work_dir/postimage.json" iam get-policy-version --policy-arn "$policy_arn" --version-id "$after_version"
jq -e --slurpfile desired "$desired_file" '.PolicyVersion.Document == $desired[0]' "$work_dir/postimage.json" >/dev/null || stop 'new policy document differs; retain evidence for owner reconciliation'
read_aws "$work_dir/role-after.json" iam get-role --role-name "$role_name"
jq -e --slurpfile before "$work_dir/role-before.json" '.Role == $before[0].Role' "$work_dir/role-after.json" >/dev/null || stop 'role metadata changed concurrently; retain evidence'
jq --arg version "$after_version" '. + {newDefaultVersion:$version,exactPolicyReadback:true,roleUnchanged:true}' "$work_dir/receipt.json" > "$work_dir/completed.json"
mv "$work_dir/completed.json" "$work_dir/receipt.json"
echo "APPLIED: exact policy version $after_version. Private receipt: $work_dir/receipt.json"
echo "Owner rollback only after reconciliation: aws iam set-default-policy-version --policy-arn $policy_arn --version-id $before_version"
echo 'Next: verify the original GetRun through the same reader bridge. This policy receipt is not a Device Farm or Premium PASS.'
