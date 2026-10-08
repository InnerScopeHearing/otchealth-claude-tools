#!/usr/bin/env bash
# =============================================================================================
# fleet-monitor-grant-2026-10-07.sh  -  OTCHealth one-time AWS permission step (CTO, 2026-10-07)
#
# WHAT IT DOES (nothing is deleted, nothing is switched off):
#   A. Role otchealth-aws-dr-canary (used by the nightly DR canary and the nightly fleet silence
#      monitor in otchealth-claude-tools) gets ONE policy, otchealth-fleet-monitor-read-2026-10-07:
#        - list and read the heartbeat folder only
#              s3://otchealth-brain-dr-55c84f6b/otchealthcommons/company-journal/_HEARTBEAT/
#        - write ONLY its own heartbeat file  .../_HEARTBEAT/nightly-aws-dr-canary.json
#   B. The hourly AWS health monitor in otchealth-cto signs in with role otchealth-github-recovery-console
#      when that role is configured for it, otherwise with the escrowed IAM user cto-hyperagent (the
#      recovery console ran as that user on 2026-10-08). Whichever of the two exists gets ONE policy,
#      otchealth-fleet-heartbeat-aws-health-monitor-2026-10-07:
#        - read and write ONLY  .../_HEARTBEAT/aws-health-monitor.json
#   If the bucket is encrypted with a customer-managed KMS key, both policies also allow
#   kms:Decrypt and kms:GenerateDataKey on that one key, and only when the call comes through S3.
#   NOT granted on purpose: any OpenSearch access (the canary's freshness check moves to _count, which
#   the role already has), SSM parameters (paging is a GitHub issue @mention), any other S3 path.
#
# HOW TO RUN: download this file and run it with bash (do not paste its body into the shell).
# SAFE TO RE-RUN: the same policy names are used every time; a re-run rewrites them identically.
# RUN IN:  AWS CloudShell, region us-east-1, signed in as the account owner or an administrator.
# UNDO:    the script prints one ROLLBACK line per change.
# SECRETS: none in this file, none printed.
#
# Evidence (otchealth-claude-tools, 2026-10-07): DR canary run 37646729668 (heartbeat s3 put 403);
# silence-monitor run 37669544722 / issue 621 (beat store unreadable: s3:ListBucket and s3:GetObject
# on _HEARTBEAT/).
# =============================================================================================
set -euo pipefail
export AWS_PAGER=""
export AWS_REGION="us-east-1"
export AWS_DEFAULT_REGION="us-east-1"

EXPECTED_ACCOUNT="900915535335"
REGION="us-east-1"
BUCKET="otchealth-brain-dr-55c84f6b"
BEAT_FOLDER="otchealthcommons/company-journal/_HEARTBEAT"

CANARY_ROLE="otchealth-aws-dr-canary"
CANARY_POLICY="otchealth-fleet-monitor-read-2026-10-07"
CANARY_BEAT="nightly-aws-dr-canary.json"

CONSOLE_ROLE="otchealth-github-recovery-console"
HEALTH_USER="cto-hyperagent"
HEALTH_POLICY="otchealth-fleet-heartbeat-aws-health-monitor-2026-10-07"
HEALTH_BEAT="aws-health-monitor.json"

BUCKET_ARN="arn:aws:s3:::${BUCKET}"
BEAT_ARN="${BUCKET_ARN}/${BEAT_FOLDER}"
CANARY_ARN=""
CONSOLE_ARN=""
USER_ARN=""

WORK_DIR="$(mktemp -d)"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

PASSED=0
FAILED=0
ROLLBACKS=()
NOTES=()

section() { printf '\n==== %s ====\n' "$1"; }

print_rollbacks() {
  echo ""
  echo " ROLLBACK (only if the CTO asks; each line undoes one change):"
  if [ "${#ROLLBACKS[@]}" -gt 0 ]; then
    for r in "${ROLLBACKS[@]}"; do echo "   $r"; done
  else
    echo "   (nothing was changed)"
  fi
  if [ "${#NOTES[@]}" -gt 0 ]; then
    for r in "${NOTES[@]}"; do echo "   Note: $r"; done
  fi
  echo ""
}

set -o errtrace
on_error() {
  local rc=$?
  echo ""
  echo "STOPPED: a step failed (see the message above). Nothing after that step was changed."
  echo "Copy everything on this screen and send it to the CTO. It is safe to run the script again."
  print_rollbacks
  exit "$rc"
}
trap on_error ERR

stop() {
  echo ""
  echo "STOP: $1"
  print_rollbacks
  exit 1
}

show_list() {
  local n=0 line
  while IFS= read -r line; do
    if [ -n "$line" ] && [ "$line" != "None" ]; then
      printf '  - %s\n' "$line"
      n=$((n + 1))
    fi
  done
  if [ "$n" -eq 0 ]; then echo "  (none)"; fi
}

# sim ROLE_ARN ACTION RESOURCE [CONTEXT_JSON]  ->  prints allowed | implicitDeny | explicitDeny | error
sim() {
  local role_arn="$1" action="$2" resource="$3" ctx="${4:-}" out
  local args=(iam simulate-principal-policy --policy-source-arn "$role_arn" --action-names "$action" --resource-arns "$resource")
  if [ -n "$ctx" ]; then args+=(--context-entries "$ctx"); fi
  if out="$(aws "${args[@]}" --query 'EvaluationResults[0].EvalDecision' --output text 2>"$WORK_DIR/sim.err")"; then
    echo "$out"
  else
    echo "error"
  fi
}

# expect_allowed LABEL ROLE_ARN ACTION RESOURCE [CONTEXT_JSON]  (IAM is eventually consistent: retry a few times)
expect_allowed() {
  local label="$1" role_arn="$2" action="$3" resource="$4" ctx="${5:-}" d="error" try=1
  while [ "$try" -le 5 ]; do
    d="$(sim "$role_arn" "$action" "$resource" "$ctx")"
    if [ "$d" = "allowed" ] || [ "$d" = "error" ]; then break; fi
    try=$((try + 1))
    if [ "$try" -le 5 ]; then sleep 4; fi
  done
  if [ "$d" = "allowed" ]; then
    printf '  PASS  %s\n' "$label"
    PASSED=$((PASSED + 1))
  else
    printf '  FAIL  %s   (simulator says: %s)\n' "$label" "$d"
    if [ "$d" = "error" ] && [ -s "$WORK_DIR/sim.err" ]; then head -n 3 "$WORK_DIR/sim.err" | sed 's/^/        /'; fi
    FAILED=$((FAILED + 1))
  fi
}

# look_not_allowed LABEL ROLE_ARN ACTION RESOURCE  (information only, never counted as a failure)
look_not_allowed() {
  local label="$1" role_arn="$2" action="$3" resource="$4" d
  d="$(sim "$role_arn" "$action" "$resource")"
  if [ "$d" = "allowed" ]; then
    printf '  NOTE  %s is allowed, by another policy already on this role (not by this script)\n' "$label"
  elif [ "$d" = "error" ]; then
    printf '  info  could not check: %s\n' "$label"
  else
    printf '  ok    %s is not allowed (as intended)\n' "$label"
  fi
}

# save_policy KIND WHO NAME FILE (KIND is role or user): inline policy; if the inline space is full
# (LimitExceeded), a customer-managed policy with the same name is created or updated and attached.
# Every command is guarded with `|| return 1` because errexit is suspended inside `if ! save_policy`.
save_policy() {
  local kind="$1" who="$2" name="$3" file="$4" out arn n old flag
  flag="--${kind}-name"
  if out="$(aws iam "put-${kind}-policy" "$flag" "$who" --policy-name "$name" --policy-document "file://$file" 2>&1)"; then
    ROLLBACKS+=("aws iam delete-${kind}-policy $flag $who --policy-name $name")
    if ! aws iam "get-${kind}-policy" "$flag" "$who" --policy-name "$name" --query PolicyName --output text >/dev/null; then
      echo "  Saved inline policy $name on $kind $who, but reading it back failed."
      return 1
    fi
    echo "  Saved and read back: inline policy $name on $kind $who."
    return 0
  fi
  case "$out" in
    *LimitExceeded*) ;;
    *) printf '%s\n' "$out"; return 1 ;;
  esac
  echo "  The $kind's inline policy space is full, so this grant is saved as a managed policy with the same name."
  arn="arn:aws:iam::${EXPECTED_ACCOUNT}:policy/${name}"
  if aws iam get-policy --policy-arn "$arn" >/dev/null 2>&1; then
    n="$(aws iam list-policy-versions --policy-arn "$arn" --query 'length(Versions)' --output text)" || return 1
    if [ "$n" -ge 5 ]; then
      old="$(aws iam list-policy-versions --policy-arn "$arn" --query 'sort_by(Versions[?IsDefaultVersion==`false`], &CreateDate)[0].VersionId' --output text)" || return 1
      aws iam delete-policy-version --policy-arn "$arn" --version-id "$old" || return 1
    fi
    aws iam create-policy-version --policy-arn "$arn" --policy-document "file://$file" --set-as-default >/dev/null || return 1
  else
    aws iam create-policy --policy-name "$name" --policy-document "file://$file" >/dev/null || return 1
  fi
  aws iam "attach-${kind}-policy" "$flag" "$who" --policy-arn "$arn" || return 1
  echo "  Saved: managed policy $name, attached to $kind $who."
  ROLLBACKS+=("aws iam detach-${kind}-policy $flag $who --policy-arn $arn")
  NOTES+=("after detaching everywhere, delete the managed policy $name in the IAM console (Policies page).")
  return 0
}

# show_role ROLE VAR: prints the role's current state and stores its real ARN (path included) in VAR.
show_role() {
  local role="$1" var="$2" info r_arn r_created r_boundary
  info="$(aws iam get-role --role-name "$role" --query 'Role.[Arn,CreateDate,PermissionsBoundary.PermissionsBoundaryArn]' --output text)"
  read -r r_arn r_created r_boundary <<<"$info"
  printf -v "$var" '%s' "$r_arn"
  echo "  Role ARN : $r_arn"
  echo "  Created  : $r_created"
  if [ "$r_boundary" = "None" ] || [ -z "$r_boundary" ]; then
    echo "  Boundary : none"
  else
    echo "  Boundary : $r_boundary"
  fi
  echo "  Who may use this role (trust conditions):"
  aws iam get-role --role-name "$role" --query 'Role.AssumeRolePolicyDocument.Statement[].Condition' --output json | sed 's/^/    /'
  echo "  Inline policies:"
  aws iam list-role-policies --role-name "$role" --query 'PolicyNames' --output text | tr '\t' '\n' | show_list
  echo "  Attached (managed) policies:"
  aws iam list-attached-role-policies --role-name "$role" --query 'AttachedPolicies[].PolicyName' --output text | tr '\t' '\n' | show_list
}

# ---------------------------------------------------------------------------------------------
section "0. Who is running this"
if ! command -v aws >/dev/null 2>&1; then
  stop "the aws command was not found. Open AWS CloudShell (the >_ icon at the top of the console)."
fi
aws sts get-caller-identity --output json
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
if [ "$ACCOUNT" != "$EXPECTED_ACCOUNT" ]; then
  stop "you are signed in to account $ACCOUNT, not $EXPECTED_ACCOUNT. Nothing was changed. Sign in to the OTCHealth account and run this again."
fi
echo "OK: account $ACCOUNT is the OTCHealth account."

# ---------------------------------------------------------------------------------------------
section "1. Who gets the permissions (current state)"
echo "Role $CANARY_ROLE:"
show_role "$CANARY_ROLE" CANARY_ARN
CONSOLE_PRESENT="yes"
if aws iam get-role --role-name "$CONSOLE_ROLE" >/dev/null 2>&1; then
  echo "Role $CONSOLE_ROLE:"
  show_role "$CONSOLE_ROLE" CONSOLE_ARN
else
  CONSOLE_PRESENT="no"
  echo "  Role $CONSOLE_ROLE was not found (part B uses the user below instead)."
fi
USER_PRESENT="yes"
if USER_ARN="$(aws iam get-user --user-name "$HEALTH_USER" --query User.Arn --output text 2>/dev/null)"; then
  echo "User $HEALTH_USER:"
  echo "  User ARN : $USER_ARN"
  echo "  Inline policies:"
  aws iam list-user-policies --user-name "$HEALTH_USER" --query 'PolicyNames' --output text | tr '\t' '\n' | show_list
  echo "  Attached (managed) policies:"
  aws iam list-attached-user-policies --user-name "$HEALTH_USER" --query 'AttachedPolicies[].PolicyName' --output text | tr '\t' '\n' | show_list
else
  USER_PRESENT="no"
  USER_ARN=""
  echo "  User $HEALTH_USER was not found."
fi
if [ "$CONSOLE_PRESENT" = "no" ] && [ "$USER_PRESENT" = "no" ]; then
  FAILED=$((FAILED + 1))
  echo "  FAIL  neither $CONSOLE_ROLE nor $HEALTH_USER exists, so part B is skipped. Tell the CTO."
fi

# ---------------------------------------------------------------------------------------------
section "2. Pre-flight checks (read only)"
KMS_KEY_ARN=""
ENC_ALGO="$(aws s3api get-bucket-encryption --bucket "$BUCKET" --query 'ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm' --output text 2>/dev/null || echo unreadable)"
ENC_KEY="$(aws s3api get-bucket-encryption --bucket "$BUCKET" --query 'ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.KMSMasterKeyID' --output text 2>/dev/null || echo None)"
case "$ENC_ALGO" in
  AES256)
    echo "  Bucket encryption: AES256 (S3-managed). No key permission is needed." ;;
  aws:kms*)
    if [ -z "$ENC_KEY" ] || [ "$ENC_KEY" = "None" ] || [ "$ENC_KEY" = "alias/aws/s3" ]; then
      echo "  Bucket encryption: $ENC_ALGO with the AWS-managed S3 key. No extra key permission is needed."
    else
      KEY_INFO="$(aws kms describe-key --key-id "$ENC_KEY" --query 'KeyMetadata.[Arn,KeyManager]' --output text 2>/dev/null || echo 'unreadable unreadable')"
      read -r K_ARN K_MGR <<<"$KEY_INFO"
      if [ "$K_MGR" = "CUSTOMER" ]; then
        KMS_KEY_ARN="$K_ARN"
        echo "  Bucket encryption: $ENC_ALGO with customer-managed key $K_ARN."
        echo "  The grants below include that key, usable only through S3."
      elif [ "$K_MGR" = "AWS" ]; then
        echo "  Bucket encryption: $ENC_ALGO with an AWS-managed key. No extra key permission is needed."
      else
        FAILED=$((FAILED + 1))
        echo "  FAIL  the bucket uses KMS key $ENC_KEY, which this sign-in could not read. Tell the CTO."
      fi
    fi ;;
  *)
    echo "  Bucket encryption could not be read ($ENC_ALGO). The grant still goes ahead; if the monitors"
    echo "  still report AccessDenied afterwards, tell the CTO." ;;
esac

if BP="$(aws s3api get-bucket-policy --bucket "$BUCKET" --query Policy --output text 2>&1)"; then
  if command -v python3 >/dev/null 2>&1; then
    printf '%s' "$BP" | python3 -c '
import json, sys
d = json.load(sys.stdin)
st = d.get("Statement", [])
if isinstance(st, dict):
    st = [st]
deny = [s for s in st if s.get("Effect") == "Deny"]
print("  Bucket policy: %d statement(s), %d of them Deny." % (len(st), len(deny)))
for s in deny:
    print("    Deny sid=%s action=%s" % (s.get("Sid", "-"), s.get("Action")))
if deny:
    print("  NOTE: a Deny in the bucket policy can still block a role even when the simulator says allowed.")
' || echo "  Bucket policy exists but could not be parsed; skipped."
  else
    echo "  Bucket policy exists; python3 not found, so the Deny scan was skipped."
  fi
else
  case "$BP" in
    *NoSuchBucketPolicy*) echo "  Bucket policy: none (the role policies decide)." ;;
    *) echo "  Bucket policy could not be read with this sign-in. The grant still goes ahead." ;;
  esac
fi

KMS_STMT=""
if [ -n "$KMS_KEY_ARN" ]; then
  KMS_STMT=",
    {
      \"Sid\": \"HeartbeatKeyThroughS3Only\",
      \"Effect\": \"Allow\",
      \"Action\": [\"kms:Decrypt\", \"kms:GenerateDataKey\"],
      \"Resource\": \"${KMS_KEY_ARN}\",
      \"Condition\": {\"StringEquals\": {\"kms:ViaService\": \"s3.${REGION}.amazonaws.com\"}}
    }"
fi

# ---------------------------------------------------------------------------------------------
section "3. Part A: policy $CANARY_POLICY on role $CANARY_ROLE"
CANARY_FILE="$WORK_DIR/canary-policy.json"
cat > "$CANARY_FILE" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "HeartbeatListOnlyThatFolder",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "${BUCKET_ARN}",
      "Condition": {
        "StringLike": {
          "s3:prefix": "${BEAT_FOLDER}/*"
        }
      }
    },
    {
      "Sid": "HeartbeatReadBeatFiles",
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "${BEAT_ARN}/*"
    },
    {
      "Sid": "HeartbeatWriteOwnBeatOnly",
      "Effect": "Allow",
      "Action": "s3:PutObject",
      "Resource": "${BEAT_ARN}/${CANARY_BEAT}"
    }${KMS_STMT}
  ]
}
EOF
if command -v python3 >/dev/null 2>&1; then python3 -c 'import json, sys; json.load(open(sys.argv[1]))' "$CANARY_FILE"; fi
cat "$CANARY_FILE"
echo ""
if ! save_policy role "$CANARY_ROLE" "$CANARY_POLICY" "$CANARY_FILE"; then
  stop "part A could not be saved or read back (the message above says why). Usual cause: this sign-in may not change IAM. Sign in as the account owner or an administrator and run again."
fi

# ---------------------------------------------------------------------------------------------
section "4. Part B: policy $HEALTH_POLICY for the hourly health monitor"
if [ "$CONSOLE_PRESENT" = "yes" ] || [ "$USER_PRESENT" = "yes" ]; then
  HEALTH_FILE="$WORK_DIR/health-policy.json"
  cat > "$HEALTH_FILE" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "HealthMonitorOwnBeatOnly",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "${BEAT_ARN}/${HEALTH_BEAT}"
    }${KMS_STMT}
  ]
}
EOF
  if command -v python3 >/dev/null 2>&1; then python3 -c 'import json, sys; json.load(open(sys.argv[1]))' "$HEALTH_FILE"; fi
  cat "$HEALTH_FILE"
  echo ""
  if [ "$CONSOLE_PRESENT" = "yes" ]; then
    if ! save_policy role "$CONSOLE_ROLE" "$HEALTH_POLICY" "$HEALTH_FILE"; then
      stop "part B could not be saved on role $CONSOLE_ROLE (the message above says why). Part A is already saved. Copy this screen and send it to the CTO."
    fi
  fi
  if [ "$USER_PRESENT" = "yes" ]; then
    if ! save_policy user "$HEALTH_USER" "$HEALTH_POLICY" "$HEALTH_FILE"; then
      stop "part B could not be saved on user $HEALTH_USER (the message above says why). Part A is already saved. Copy this screen and send it to the CTO."
    fi
  fi
else
  echo "  Skipped (no role or user to attach it to)."
fi

# ---------------------------------------------------------------------------------------------
section "5. Checking with the IAM policy simulator"
echo "  (The simulator checks the role's own policies, boundary and organization rules. It cannot see the"
echo "   bucket policy or the KMS key policy; the first real monitor run after this is the final proof.)"
sleep 3
PREFIX_CTX="[{\"ContextKeyName\":\"s3:prefix\",\"ContextKeyValues\":[\"${BEAT_FOLDER}/\"],\"ContextKeyType\":\"string\"}]"
expect_allowed "A  s3:ListBucket  $BUCKET, folder ${BEAT_FOLDER}/" "$CANARY_ARN" "s3:ListBucket" "$BUCKET_ARN" "$PREFIX_CTX"
expect_allowed "A  s3:GetObject   ${BEAT_FOLDER}/${CANARY_BEAT}" "$CANARY_ARN" "s3:GetObject" "${BEAT_ARN}/${CANARY_BEAT}"
expect_allowed "A  s3:GetObject   ${BEAT_FOLDER}/${HEALTH_BEAT}" "$CANARY_ARN" "s3:GetObject" "${BEAT_ARN}/${HEALTH_BEAT}"
expect_allowed "A  s3:PutObject   ${BEAT_FOLDER}/${CANARY_BEAT}" "$CANARY_ARN" "s3:PutObject" "${BEAT_ARN}/${CANARY_BEAT}"
if [ "$CONSOLE_PRESENT" = "yes" ]; then
  expect_allowed "B  role: s3:GetObject ${BEAT_FOLDER}/${HEALTH_BEAT}" "$CONSOLE_ARN" "s3:GetObject" "${BEAT_ARN}/${HEALTH_BEAT}"
  expect_allowed "B  role: s3:PutObject ${BEAT_FOLDER}/${HEALTH_BEAT}" "$CONSOLE_ARN" "s3:PutObject" "${BEAT_ARN}/${HEALTH_BEAT}"
fi
if [ "$USER_PRESENT" = "yes" ]; then
  expect_allowed "B  user: s3:GetObject ${BEAT_FOLDER}/${HEALTH_BEAT}" "$USER_ARN" "s3:GetObject" "${BEAT_ARN}/${HEALTH_BEAT}"
  expect_allowed "B  user: s3:PutObject ${BEAT_FOLDER}/${HEALTH_BEAT}" "$USER_ARN" "s3:PutObject" "${BEAT_ARN}/${HEALTH_BEAT}"
fi
if [ -n "$KMS_KEY_ARN" ]; then
  VIA_CTX="[{\"ContextKeyName\":\"kms:ViaService\",\"ContextKeyValues\":[\"s3.${REGION}.amazonaws.com\"],\"ContextKeyType\":\"string\"}]"
  expect_allowed "A  kms:Decrypt     bucket key, through S3" "$CANARY_ARN" "kms:Decrypt" "$KMS_KEY_ARN" "$VIA_CTX"
  if [ "$CONSOLE_PRESENT" = "yes" ]; then
    expect_allowed "B  role: kms:GenerateDataKey through S3" "$CONSOLE_ARN" "kms:GenerateDataKey" "$KMS_KEY_ARN" "$VIA_CTX"
  fi
  if [ "$USER_PRESENT" = "yes" ]; then
    expect_allowed "B  user: kms:GenerateDataKey through S3" "$USER_ARN" "kms:GenerateDataKey" "$KMS_KEY_ARN" "$VIA_CTX"
  fi
fi
echo "Least-privilege look (information only, not counted):"
look_not_allowed "A  s3:PutObject on the health monitor's beat" "$CANARY_ARN" "s3:PutObject" "${BEAT_ARN}/${HEALTH_BEAT}"
look_not_allowed "A  s3:GetObject outside the heartbeat folder" "$CANARY_ARN" "s3:GetObject" "${BUCKET_ARN}/otchealthcommons/company-journal/_JOURNAL/x.md"
if [ "$CONSOLE_PRESENT" = "yes" ]; then
  look_not_allowed "B  s3:PutObject on the DR canary's beat" "$CONSOLE_ARN" "s3:PutObject" "${BEAT_ARN}/${CANARY_BEAT}"
fi

# ---------------------------------------------------------------------------------------------
TOTAL=$((PASSED + FAILED))
echo ""
echo "=============================================================="
if [ "$FAILED" -eq 0 ]; then
  echo " RESULT: ALL CHECKS PASSED ($PASSED of $TOTAL)"
  echo "=============================================================="
  echo " Tell the CTO: grant applied."
else
  echo " RESULT: $FAILED of $TOTAL CHECKS FAILED"
  echo "=============================================================="
  echo " Copy this whole screen and send it to the CTO. It is safe to run this script again."
fi
print_rollbacks
if [ "$FAILED" -ne 0 ]; then exit 1; fi
