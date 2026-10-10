#!/usr/bin/env bash
# =============================================================================================
# aws-ai-access-2026-10-07.sh  -  OTCHealth: bounded, read-only AWS sign-ins for AI tools
#                                 (CTO, 2026-10-07)
#
# WHY: AI connectors (the claude.ai "AWS MCP" connector, "aws login" on the owner's PC, and the
#      gateway's server-side AWS bridge) must never be signed in as the account root user. This
#      script creates two read-only identities instead. Nothing is deleted and nothing is
#      switched off.
#
# WHAT IT CREATES:
#   A. IAM user  otchealth-ai-reader   (a person signs in with a browser or "aws login").
#        - AWS managed policies, looked up by name at run time (a missing one stops the script):
#          ViewOnlyAccess, AWSMCPSignInOAuthAccessPolicy, SignInLocalDevelopmentAccess,
#          IAMUserChangePassword
#        - customer managed policy otchealth-ai-reader-extras (a few more read calls: metrics,
#          cost, alarms, ECS, load balancers, OpenSearch domain info, Lightsail instances)
#        - customer managed policy otchealth-ai-reader-billing (read-only cost and billing; see
#          COST AND BILLING below)
#        - customer managed policy otchealth-ai-reader-deny (explicit Deny; wins over any Allow)
#        - inline policy otchealth-ai-reader-self-mfa (the user may set up ITS OWN MFA device)
#        - a console password written ONLY to ~/otchealth-ai-reader-initial-password.txt (mode
#          600). It is never printed. The user must choose a new password at first sign-in.
#        - NO access keys are ever created.
#   B. IAM role  otchealth-ai-reader-role   (used by the gateway's AWS bridge).
#        - Only the gateway's ECS task role may assume it (found at run time: cluster otchealth,
#          service otchealth-gateway, task definition taskRoleArn). If no ACTIVE service has that
#          name, the one ACTIVE service in the cluster whose task definition family is
#          otchealth-gateway is used instead; none, or more than one, is a STOP before anything is
#          written. Sessions last at most 1 hour.
#        - Same read-only policies as the user (ViewOnlyAccess + extras + billing + deny).
#        - The task role gets ONE small inline policy, otchealth-assume-ai-reader-2026-10-07,
#          that allows sts:AssumeRole on this one role and nothing else.
#
# READ-ONLY MEANS SETTINGS AND METRICS, NOT CONTENT. The deny policy blocks, for both identities
# and on every path: secret and parameter values, KMS decrypt, S3 object reads AND S3 file names
# (bucket listings), OpenSearch data, log contents, database rows, queue messages, container and
# function environment variables, instance user data and VPN keys, CloudFront origin headers, shell
# or exec access, payment methods, and changes to IAM credentials or permissions. See the policy
# text below.
#
# COST AND BILLING: READ ONLY (added 2026-10-09). The policy otchealth-ai-reader-billing has ONE Allow
# statement, written as explicit action names (no wildcards), and every name is marked Read or List
# in the AWS Service Authorization Reference: Cost Explorer reads (spend by service, forecasts, tags,
# anomalies, cost categories, reservation and Savings Plans use, coverage and advice, right-sizing),
# Budgets view, Savings Plans describe, Cost Optimization Hub reads, Compute Optimizer reads, the Price
# List, and what the Billing console reads to show credits and bills (billing:, account:
# GetAccountInformation, consolidatedbilling:, invoicing:ListInvoiceSummaries). Nothing in it can
# create, change, buy, pay for or cancel anything. The retired aws-portal actions are not used (AWS
# ended standard support for them in July 2023). The payment actions stay denied by the deny policy
# below, and no tax or contact action is allowed, so the console Bills page may show a payments error
# while the bill itself loads. The list, with the page that documents each action, is
# setup/aws/tests/billing-read-actions.tsv; the tests fail when the policy and that list differ.
# Owner steps this script cannot do: launch Cost Explorer once (console only), switch on "Activate IAM
# Access" (account owner; only the Billing console pages need it, the cost reports do not), and opt in
# to Cost Optimization Hub and Compute Optimizer (each is empty until then).
#
# KNOWN TRADE-OFF (kept on purpose): cloudtrail:LookupEvents and ecs:DescribeTasks stay ALLOWED.
# CloudTrail events can show request parameters, and ECS task details can show per-run overrides, so
# a plaintext secret passed that way would be visible. The repo's snapshot of the gateway task
# definition takes all of its tokens from SSM (secrets / valueFrom). That was NOT re-verified against
# the live task definition, so it is a claim to check, not a fact. If a plaintext secret is ever
# found there, add those two actions to the deny policy below and run this script again.
#
# EXISTING IDENTITIES MUST BE EXACT: if the user or the role already exists, it may carry only what
# this script puts on it. Any other managed policy, inline policy, group membership (user) or
# permissions boundary is a FAIL, printed together with the command that removes it. A user that
# fails this check never gets a console password. A role is checked BEFORE anything on it is
# changed: if it fails, it is left completely alone (its trust policy is not rewritten, nothing is
# attached to it, and the gateway task role is not given permission to use it).
# An identity made by an earlier version of this script (before the billing policy existed) passes this
# check: the check only objects to what is NOT on the expected list, and the billing policy is on it.
# This run then attaches the billing policy to that identity. Everything else is set again exactly as in
# any re-run, and nothing is removed.
#
# HOW TO RUN: download this file and run it with bash (do not paste its body into the shell).
# SAFE TO RE-RUN: every name is fixed; a re-run changes nothing that is already correct and never
#                 creates a second password.
# RUN IN:  AWS CloudShell, region us-east-1, signed in as the account owner or an administrator.
# UNDO:    the script prints a ROLLBACK block (exact commands, in order) at every STOP and at the end.
# SECRETS: none in this file, none printed.
# =============================================================================================
set -uo pipefail
umask 077
export LC_ALL=C
export AWS_PAGER=""

EXPECTED_ACCOUNT="900915535335"
REGION="us-east-1"

READER_USER="otchealth-ai-reader"
READER_ROLE="otchealth-ai-reader-role"
EXTRAS_POLICY="otchealth-ai-reader-extras"
DENY_POLICY="otchealth-ai-reader-deny"
BILLING_POLICY="otchealth-ai-reader-billing"
MFA_POLICY="otchealth-ai-reader-self-mfa"
ASSUME_POLICY="otchealth-assume-ai-reader-2026-10-07"
ECS_CLUSTER="otchealth"
# The gateway's ECS service: the name infra/aws/ecs-gateway.tf (otchealth-mcp-server) gives it. The environment may
# set ECS_SERVICE to use another one. If no ACTIVE service has the name, the service is found by its task
# definition family instead (see resolve_gateway_service below).
ECS_SERVICE="${ECS_SERVICE:-otchealth-gateway}"
EXPECTED_TASK_FAMILY="otchealth-gateway"
SESSION_SECONDS="3600"
ROLE_DESCRIPTION="Read-only AWS access for the OTCHealth gateway AI bridge (created 2026-10-07)"
# One argument per tag, in the AWS CLI shorthand form Key=...,Value=... (the commas are part of the argument).
TAG_ARGS=("Key=purpose,Value=ai-read-only" "Key=owner,Value=cto" "Key=created,Value=2026-10-07")
PW_FILE="${HOME:-/nonexistent}/otchealth-ai-reader-initial-password.txt"
SIGNIN_URL="https://${EXPECTED_ACCOUNT}.signin.aws.amazon.com/console"

# AWS managed policies for the user; looked up by name (never by a guessed path).
MANAGED_NAMES=(ViewOnlyAccess AWSMCPSignInOAuthAccessPolicy SignInLocalDevelopmentAccess IAMUserChangePassword)
MANAGED_ARNS=()

EXTRAS_ARN="arn:aws:iam::${EXPECTED_ACCOUNT}:policy/${EXTRAS_POLICY}"
DENY_ARN="arn:aws:iam::${EXPECTED_ACCOUNT}:policy/${DENY_POLICY}"
BILLING_ARN="arn:aws:iam::${EXPECTED_ACCOUNT}:policy/${BILLING_POLICY}"
USER_ARN=""
ROLE_ARN=""
TASK_ROLE_ARN=""
TASK_ROLE_NAME=""
PW_CREATED="no"
PW_EXISTING="no"
PW_POLICY_JSON="{}"
B_OK="no"
ROLE_EXACT="yes"
GRANT_OK="no"
BILLING_USER_OK="no"
BILLING_ROLE_OK="no"
EXPECT_MANAGED=()
EXPECT_INLINE=()
EXACT_N=0
EXACT_LIST=""
MFA_MODE="inline"

WORK_DIR="$(mktemp -d)"
ERRF="$WORK_DIR/err.txt"
# shellcheck disable=SC2329  # called through the EXIT trap below
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

PASSED=0
FAILED=0
FAIL_A=0
FAIL_B=0
CUR_PART="0"
CHECKS=()
ROLLBACKS=()
FIXES=()

section() { printf '\n==== %s ====\n' "$1"; }

# ---------------------------------------------------------------------------------------------
# Rollback bookkeeping. Each entry is "STAGE|command"; lower stages are printed first, which is
# the order that works (children before parents).
#   5 password file   10 task-role policy   20 role: detach   25 role: delete
#   30 login profile  31 MFA devices        32 user inline policy   33 user: detach
#   40 user: delete   50 customer managed policies: delete
# ---------------------------------------------------------------------------------------------
add_rollback() {
  local line="$1|$2" r
  if [ "${#ROLLBACKS[@]}" -gt 0 ]; then
    for r in "${ROLLBACKS[@]}"; do
      if [ "$r" = "$line" ]; then return 0; fi
    done
  fi
  ROLLBACKS+=("$line")
  return 0
}

add_fix() {
  local r
  if [ "${#FIXES[@]}" -gt 0 ]; then
    for r in "${FIXES[@]}"; do
      if [ "$r" = "$1" ]; then return 0; fi
    done
  fi
  FIXES+=("$1")
  return 0
}

print_rollbacks() {
  echo ""
  echo " ROLLBACK (only if the CTO asks. Run these lines in this order; each one undoes one change):"
  if [ "${#ROLLBACKS[@]}" -gt 0 ]; then
    printf '%s\n' "${ROLLBACKS[@]}" | sort -s -t'|' -k1,1n | cut -d'|' -f2- | sed 's/^/   /'
  else
    echo "   (nothing was changed)"
  fi
  echo ""
}

set -o errtrace
# shellcheck disable=SC2329  # called through the ERR trap below
on_error() {
  local rc=$?
  echo ""
  echo "STOPPED: a step failed (see the message above). Nothing after that step was changed."
  echo "Send the CTO only the STOPPED line and the error message just above it. It is safe to run the script again."
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

pass() {
  PASSED=$((PASSED + 1))
  CHECKS+=("PASS|$1")
  printf '  PASS  %s\n' "$1"
}

fail() {
  FAILED=$((FAILED + 1))
  case "$CUR_PART" in
    A) FAIL_A=$((FAIL_A + 1)) ;;
    B) FAIL_B=$((FAIL_B + 1)) ;;
    *) ;;
  esac
  CHECKS+=("FAIL|$1")
  printf '  FAIL  %s\n' "$1"
}

info() { printf '  info  %s\n' "$1"; }

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

# run_aws VAR ARGS...: runs aws; stdout goes into VAR, stderr into $ERRF. Returns aws's status.
run_aws() {
  local __var="$1" __out
  shift
  if __out="$(aws "$@" 2>"$ERRF")"; then
    printf -v "$__var" '%s' "$__out"
    return 0
  fi
  printf -v "$__var" '%s' ""
  return 1
}

err_has() { grep -q -- "$1" "$ERRF" 2>/dev/null; }

show_err() { { grep -v '^[[:space:]]*$' "$ERRF" 2>/dev/null || true; } | head -n 4 | sed 's/^/        /'; }

# err_text: the first two non-blank lines of the last aws error, on one line
err_text() { { grep -v '^[[:space:]]*$' "$ERRF" 2>/dev/null || true; } | head -n 2 | tr '\n' ' '; }

# policy_summary FILE LIMIT: validates the JSON, prints one line per statement and the size.
# Returns 3 when the text is longer than IAM allows (whitespace is not counted by IAM).
policy_summary() {
  python3 -I -c '
import json, re, sys
path, limit = sys.argv[1], int(sys.argv[2])
raw = open(path).read()
doc = json.loads(raw)
size = len(re.sub(r"\s", "", raw))
for s in doc["Statement"]:
    a = s["Action"]
    a = [a] if isinstance(a, str) else a
    print("    %-5s %-34s %3d action(s)" % (s["Effect"], s.get("Sid", "-"), len(a)))
print("    size %d of %d characters allowed" % (size, limit))
sys.exit(0 if size <= limit else 3)
' "$1" "$2"
}

# same_json JSON_TEXT FILE: exit 0 when the two documents are equal.
same_json() {
  python3 -I -c '
import json, sys
sys.exit(0 if json.loads(sys.argv[1]) == json.load(open(sys.argv[2])) else 1)
' "$1" "$2" 2>/dev/null
}

policy_delete_cmd() {
  printf '%s' "for v in \$(aws iam list-policy-versions --policy-arn $1 --query 'Versions[?!IsDefaultVersion].VersionId' --output text); do aws iam delete-policy-version --policy-arn $1 --version-id \"\$v\"; done; aws iam delete-policy --policy-arn $1"
}

# put_managed NAME FILE LIMIT DESCRIPTION: create the customer managed policy, or add a new default
# version when its text changed. Keeps at most 5 versions (IAM limit).
put_managed() {
  local name="$1" file="$2" limit="$3" desc="$4" arn cur doc n old
  arn="arn:aws:iam::${EXPECTED_ACCOUNT}:policy/${name}"
  if ! policy_summary "$file" "$limit"; then
    echo "  The text of policy $name is invalid or too long. Nothing was saved."
    return 1
  fi
  if run_aws cur iam get-policy --policy-arn "$arn" --query Policy.DefaultVersionId --output text; then
    if ! run_aws doc iam get-policy-version --policy-arn "$arn" --version-id "$cur" --query PolicyVersion.Document --output json; then
      show_err
      return 1
    fi
    if same_json "$doc" "$file"; then
      echo "  Policy $name is already up to date."
    else
      if ! run_aws n iam list-policy-versions --policy-arn "$arn" --query 'length(Versions)' --output text; then
        show_err
        return 1
      fi
      if [ "$n" -ge 5 ]; then
        # shellcheck disable=SC2016  # the backticks are a JMESPath literal for the AWS CLI, not shell syntax
        if ! run_aws old iam list-policy-versions --policy-arn "$arn" --query 'sort_by(Versions[?IsDefaultVersion==`false`], &CreateDate)[0].VersionId' --output text; then
          show_err
          return 1
        fi
        aws iam delete-policy-version --policy-arn "$arn" --version-id "$old" || return 1
      fi
      aws iam create-policy-version --policy-arn "$arn" --policy-document "file://$file" --set-as-default >/dev/null || return 1
      echo "  Policy $name changed: saved as the new default version."
    fi
  elif err_has NoSuchEntity; then
    aws iam create-policy --policy-name "$name" --policy-document "file://$file" --description "$desc" --tags "${TAG_ARGS[@]}" >/dev/null || return 1
    echo "  Policy $name created."
  else
    show_err
    return 1
  fi
  add_rollback 50 "$(policy_delete_cmd "$arn")"
  return 0
}

# ensure_attached KIND NAME POLICY_ARN (KIND is user or role)
ensure_attached() {
  local kind="$1" who="$2" arn="$3" have
  if ! run_aws have iam "list-attached-${kind}-policies" "--${kind}-name" "$who" --query 'AttachedPolicies[].PolicyArn' --output text; then
    show_err
    return 1
  fi
  if printf '%s\n' "$have" | tr '\t' '\n' | grep -Fxq -- "$arn"; then
    echo "  Already attached to $kind $who: ${arn##*/}"
  else
    aws iam "attach-${kind}-policy" "--${kind}-name" "$who" --policy-arn "$arn" || return 1
    echo "  Attached to $kind $who: ${arn##*/}"
  fi
  if [ "$kind" = "user" ]; then
    add_rollback 33 "aws iam detach-user-policy --user-name $who --policy-arn $arn"
  else
    add_rollback 20 "aws iam detach-role-policy --role-name $who --policy-arn $arn"
  fi
  return 0
}

# save_policy KIND WHO NAME FILE LIMIT (KIND is role or user): inline policy; if the inline space is
# full (LimitExceeded), a customer managed policy with the same name is created and attached.
# Every command is guarded with `|| return 1` because errexit is suspended inside `if ! save_policy`.
LAST_SAVE_MODE="inline"
save_policy() {
  local kind="$1" who="$2" name="$3" file="$4" limit="$5" out arn n old flag stage
  flag="--${kind}-name"
  LAST_SAVE_MODE="inline"
  if [ "$kind" = "user" ]; then stage=32; else stage=10; fi
  if ! policy_summary "$file" "$limit"; then
    echo "  The text of policy $name is invalid or too long. Nothing was saved."
    return 1
  fi
  if out="$(aws iam "put-${kind}-policy" "$flag" "$who" --policy-name "$name" --policy-document "file://$file" 2>&1)"; then
    add_rollback "$stage" "aws iam delete-${kind}-policy $flag $who --policy-name $name"
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
  LAST_SAVE_MODE="managed"
  arn="arn:aws:iam::${EXPECTED_ACCOUNT}:policy/${name}"
  if aws iam get-policy --policy-arn "$arn" >/dev/null 2>&1; then
    n="$(aws iam list-policy-versions --policy-arn "$arn" --query 'length(Versions)' --output text)" || return 1
    if [ "$n" -ge 5 ]; then
      # shellcheck disable=SC2016  # the backticks are a JMESPath literal for the AWS CLI, not shell syntax
      old="$(aws iam list-policy-versions --policy-arn "$arn" --query 'sort_by(Versions[?IsDefaultVersion==`false`], &CreateDate)[0].VersionId' --output text)" || return 1
      aws iam delete-policy-version --policy-arn "$arn" --version-id "$old" || return 1
    fi
    aws iam create-policy-version --policy-arn "$arn" --policy-document "file://$file" --set-as-default >/dev/null || return 1
  else
    aws iam create-policy --policy-name "$name" --policy-document "file://$file" >/dev/null || return 1
  fi
  aws iam "attach-${kind}-policy" "$flag" "$who" --policy-arn "$arn" || return 1
  echo "  Saved: managed policy $name, attached to $kind $who."
  if [ "$kind" = "user" ]; then
    add_rollback 33 "aws iam detach-user-policy $flag $who --policy-arn $arn"
  else
    add_rollback 20 "aws iam detach-role-policy $flag $who --policy-arn $arn"
  fi
  add_rollback 50 "$(policy_delete_cmd "$arn")"
  return 0
}

# show_state KIND NAME: the attached and inline policies of a user or role (read only).
show_state() {
  local kind="$1" who="$2"
  echo "  Attached (managed) policies:"
  aws iam "list-attached-${kind}-policies" "--${kind}-name" "$who" --query 'AttachedPolicies[].PolicyName' --output text | tr '\t' '\n' | show_list
  echo "  Inline policies:"
  aws iam "list-${kind}-policies" "--${kind}-name" "$who" --query 'PolicyNames' --output text | tr '\t' '\n' | show_list
}

# list_missing LIST ARN...: prints (space separated) the names of the ARNs that are not in the
# tab or newline separated LIST.
list_missing() {
  local list="$1" a out=""
  shift
  for a in "$@"; do
    if ! printf '%s\n' "$list" | tr '\t' '\n' | grep -Fxq -- "$a"; then out="$out ${a##*/}"; fi
  done
  printf '%s' "$out"
}

# list_has LIST ARN: succeeds when ARN is in the tab or newline separated LIST.
list_has() { printf '%s\n' "$1" | tr '\t' '\n' | grep -Fxq -- "$2"; }

# ---- "an existing user or role must be exactly what this script would have made" ------------------
# safe_token TEXT: succeeds when TEXT holds only the characters that IAM names and ARNs normally use and does not
# start with a dash (the AWS CLI would read a leading dash as the start of an option), so it can be shown inside a
# command that someone copies. (An IAM path may legally hold other characters.)
safe_token() {
  case "$1" in
    "" | -* | *[!A-Za-z0-9+=,.@_/:-]*) return 1 ;;
    *) return 0 ;;
  esac
}

# in_list ITEM ARG...: succeeds when ITEM is one of the remaining arguments.
in_list() {
  local needle="$1" x
  shift
  for x in "$@"; do
    if [ "$x" = "$needle" ]; then return 0; fi
  done
  return 1
}

# found_item DESCRIPTION COMMAND: prints one unexpected item and the command that removes it.
found_item() {
  EXACT_N=$((EXACT_N + 1))
  EXACT_LIST="${EXACT_LIST}${EXACT_LIST:+; }$1"
  printf '        - %s\n' "$1"
  if [ -n "$2" ]; then
    printf '          remove it with:  %s\n' "$2"
    add_fix "$2"
  else
    echo "          remove it in the IAM console (its name starts with a dash or has unusual characters)"
  fi
}

found_unreadable() {
  EXACT_N=$((EXACT_N + 1))
  EXACT_LIST="${EXACT_LIST}${EXACT_LIST:+; }$1"
  printf '        - %s\n' "$1"
}

# exact_check KIND NAME (KIND is user or role): the identity may hold only the managed policies in
# EXPECT_MANAGED, the inline policies in EXPECT_INLINE, no group (users) and no permissions boundary.
# Anything else is printed with the command that removes it (also collected in FIXES). EXACT_N is the number
# of unexpected or unreadable items. Returns 0 only when the identity is exactly as expected.
exact_check() {
  local kind="$1" who="$2" out item cmd q
  EXACT_N=0
  EXACT_LIST=""
  if ! run_aws out iam "list-attached-${kind}-policies" "--${kind}-name" "$who" --query 'AttachedPolicies[].PolicyArn' --output text; then
    show_err
    found_unreadable "the attached managed policies could not be read"
  else
    while IFS= read -r item; do
      if [ -z "$item" ] || [ "$item" = "None" ]; then continue; fi
      if in_list "$item" ${EXPECT_MANAGED[@]+"${EXPECT_MANAGED[@]}"}; then continue; fi
      cmd=""
      if safe_token "$who" && safe_token "$item"; then cmd="aws iam detach-${kind}-policy --${kind}-name $who --policy-arn $item"; fi
      found_item "managed policy $item" "$cmd"
    done < <(printf '%s\n' "$out" | tr '\t' '\n')
  fi
  if ! run_aws out iam "list-${kind}-policies" "--${kind}-name" "$who" --query 'PolicyNames' --output text; then
    show_err
    found_unreadable "the inline policies could not be read"
  else
    while IFS= read -r item; do
      if [ -z "$item" ] || [ "$item" = "None" ]; then continue; fi
      if in_list "$item" ${EXPECT_INLINE[@]+"${EXPECT_INLINE[@]}"}; then continue; fi
      cmd=""
      if safe_token "$who" && safe_token "$item"; then cmd="aws iam delete-${kind}-policy --${kind}-name $who --policy-name $item"; fi
      found_item "inline policy $item" "$cmd"
    done < <(printf '%s\n' "$out" | tr '\t' '\n')
  fi
  if [ "$kind" = "user" ]; then
    if ! run_aws out iam list-groups-for-user --user-name "$who" --query 'Groups[].GroupName' --output text; then
      show_err
      found_unreadable "the group memberships could not be read"
    else
      while IFS= read -r item; do
        if [ -z "$item" ] || [ "$item" = "None" ]; then continue; fi
        cmd=""
        if safe_token "$who" && safe_token "$item"; then cmd="aws iam remove-user-from-group --user-name $who --group-name $item"; fi
        found_item "member of group $item" "$cmd"
      done < <(printf '%s\n' "$out" | tr '\t' '\n')
    fi
    q='User.PermissionsBoundary.PermissionsBoundaryArn'
  else
    q='Role.PermissionsBoundary.PermissionsBoundaryArn'
  fi
  if ! run_aws out iam "get-${kind}" "--${kind}-name" "$who" --query "$q" --output text; then
    show_err
    found_unreadable "the permissions boundary could not be read"
  elif [ -n "$out" ] && [ "$out" != "None" ]; then
    cmd=""
    if safe_token "$who"; then cmd="aws iam delete-${kind}-permissions-boundary --${kind}-name $who"; fi
    found_item "permissions boundary $out" "$cmd"
  fi
  if [ "$EXACT_N" -eq 0 ]; then return 0; fi
  return 1
}

# ---- IAM policy simulator -------------------------------------------------------------------
# sim ARN ACTION RESOURCE [CONTEXT_JSON]  ->  allowed | implicitDeny | explicitDeny | error
sim() {
  local arn="$1" action="$2" resource="$3" ctx="${4:-}" out
  local args=(iam simulate-principal-policy --policy-source-arn "$arn" --action-names "$action" --resource-arns "$resource")
  if [ -n "$ctx" ]; then args+=(--context-entries "$ctx"); fi
  if out="$(aws "${args[@]}" --query 'EvaluationResults[0].EvalDecision' --output text 2>"$ERRF")"; then
    echo "$out"
  else
    echo "error"
  fi
}

# transient_err: succeeds when the last aws error (in $ERRF) looks temporary (throttling, a timeout, a dropped
# connection). A temporary error is retried like any other not-yet-settled answer; a permanent one (for example
# AccessDenied) is not, because waiting would not change it.
transient_err() {
  grep -qiE 'Throttl|Rate exceeded|RequestLimitExceeded|TooManyRequests|ServiceUnavailable|InternalFailure|InternalError|RequestTimeout|timed out|Could not connect|Connection (reset|was closed|aborted)|EOF occurred|Temporary failure' "$ERRF" 2>/dev/null
}

# settle WANT ARN ACTION RESOURCE CONTEXT: asks the simulator again (IAM is eventually consistent, and the
# simulator can be throttled) until the answer is what we want; leaves the last answer in $DECISION.
# Up to 5 tries for a wrong answer (4 seconds apart) and up to 5 for a temporary error (8 seconds apart).
# Over the whole run at most 12 waits for temporary errors are spent (ERR_WAITS), so a simulator that stays
# unavailable makes the remaining checks fail quickly instead of keeping the owner waiting for many minutes.
# WANT is one of: allowed, explicit, any (any = not allowed).
DECISION="error"
ERR_WAITS=0
settle() {
  local want="$1" arn="$2" action="$3" resource="$4" ctx="$5" dtry=1 etry=1
  while :; do
    DECISION="$(sim "$arn" "$action" "$resource" "$ctx")"
    case "$want" in
      allowed) if [ "$DECISION" = "allowed" ]; then return 0; fi ;;
      explicit) if [ "$DECISION" = "explicitDeny" ]; then return 0; fi ;;
      any) if [ "$DECISION" = "explicitDeny" ] || [ "$DECISION" = "implicitDeny" ]; then return 0; fi ;;
      *) ;;
    esac
    if [ "$DECISION" = "error" ]; then
      if ! transient_err || [ "$etry" -ge 5 ] || [ "$ERR_WAITS" -ge 12 ]; then return 1; fi
      etry=$((etry + 1))
      ERR_WAITS=$((ERR_WAITS + 1))
      sleep 8
    else
      if [ "$dtry" -ge 5 ]; then return 1; fi
      dtry=$((dtry + 1))
      sleep 4
    fi
  done
}

# expect_allowed LABEL ARN ACTION RESOURCE [CONTEXT_JSON]
expect_allowed() {
  local label="$1" arn="$2" action="$3" resource="$4" ctx="${5:-}"
  if settle allowed "$arn" "$action" "$resource" "$ctx"; then
    pass "$label"
  else
    fail "$label   (simulator says: $DECISION)"
    if [ "$DECISION" = "error" ] && [ -s "$ERRF" ]; then show_err; fi
  fi
}

# expect_blocked LABEL ARN ACTION RESOURCE WANT [CONTEXT_JSON]  (WANT = explicit or any)
expect_blocked() {
  local label="$1" arn="$2" action="$3" resource="$4" want="$5" ctx="${6:-}"
  if settle "$want" "$arn" "$action" "$resource" "$ctx"; then
    pass "$label"
  else
    fail "$label   (simulator says: $DECISION)"
    if [ "$DECISION" = "error" ] && [ -s "$ERRF" ]; then show_err; fi
  fi
}

# look_allowed LABEL ARN ACTION RESOURCE: for actions the simulator may not know (sign-in). A clear
# "allowed" counts as a pass; anything else is information only, never a failure.
look_allowed() {
  local label="$1" arn="$2" action="$3" resource="$4" d dtry=1 etry=1
  while :; do
    d="$(sim "$arn" "$action" "$resource" "")"
    if [ "$d" = "allowed" ]; then break; fi
    if [ "$d" = "error" ]; then
      if ! transient_err || [ "$etry" -ge 4 ] || [ "$ERR_WAITS" -ge 12 ]; then break; fi
      etry=$((etry + 1))
      ERR_WAITS=$((ERR_WAITS + 1))
      sleep 8
    else
      if [ "$dtry" -ge 2 ]; then break; fi
      dtry=$((dtry + 1))
      sleep 4
    fi
  done
  if [ "$d" = "allowed" ]; then
    pass "$label"
  else
    info "$label: simulator answered '$d' (it may not model sign-in actions; the first real sign-in is the proof)"
  fi
}

# ---- the gateway's ECS service ---------------------------------------------------------------------------------
# resolve_gateway_service: finds the gateway's ECS service in cluster $ECS_CLUSTER and leaves its task definition ARN in TD.
#   1. The service named $ECS_SERVICE (default otchealth-gateway) is looked up first. If it is ACTIVE, that is the gateway.
#   2. If no ACTIVE service has that name (it is missing, INACTIVE or DRAINING), the services of the cluster are listed and
#      the ACTIVE ones are checked. The ONE whose task definition family is $EXPECTED_TASK_FAMILY is the gateway, and
#      ECS_SERVICE is set to its name. ECS describes at most 10 services per call, so this reads them in batches of 10.
#   No match, more than one match, or a cluster that is not there is a STOP: nothing has been written when this runs.
#   Any other trouble reading ECS is left in B_PROBLEM: part B is then reported as FAILED and part A still goes ahead.
resolve_gateway_service() {
  local configured="$ECS_SERVICE" arn name td fam i total
  local arns=() batch=() found=() found_td=()
  case "$ECS_SERVICE" in
    "" | *[!A-Za-z0-9_-]*)
      stop "the ECS service name \"$ECS_SERVICE\" is not valid (ECS service names hold only letters, numbers, dashes and underscores). Nothing was changed. Run the script again without setting ECS_SERVICE." ;;
    *) ;;
  esac
  if ! run_aws TD ecs describe-services --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE" --query "services[?status=='ACTIVE'].taskDefinition | [0]" --output text; then
    if err_has ClusterNotFoundException; then
      stop "the ECS cluster $ECS_CLUSTER was not found in this account and region, so the gateway's ECS service cannot be found. Nothing was changed. Tell the CTO."
    fi
    B_PROBLEM="the ECS service could not be read: $(err_text)"
    return 0
  fi
  if [ -n "$TD" ] && [ "$TD" != "None" ]; then
    echo "  Service used           : $ECS_SERVICE (the configured name, ACTIVE)"
    return 0
  fi
  TD=""
  echo "  There is no ACTIVE service named $configured in cluster $ECS_CLUSTER."
  echo "  Looking for the ACTIVE service in the cluster whose task definition family is $EXPECTED_TASK_FAMILY:"
  if ! run_aws SVC_LIST ecs list-services --cluster "$ECS_CLUSTER" --query 'serviceArns[]' --output text; then
    B_PROBLEM="the services in cluster $ECS_CLUSTER could not be listed: $(err_text)"
    return 0
  fi
  while IFS= read -r arn; do
    if [ -n "$arn" ] && [ "$arn" != "None" ]; then arns+=("$arn"); fi
  done < <(printf '%s\n' "$SVC_LIST" | tr '\t' '\n')
  total="${#arns[@]}"
  i=0
  while [ "$i" -lt "$total" ]; do
    batch=("${arns[@]:i:10}")
    i=$((i + 10))
    if ! run_aws SVC_ROWS ecs describe-services --cluster "$ECS_CLUSTER" --services "${batch[@]}" --query "services[?status=='ACTIVE'].[serviceName,taskDefinition]" --output text; then
      B_PROBLEM="the services in cluster $ECS_CLUSTER could not be read: $(err_text)"
      return 0
    fi
    while IFS=$'\t' read -r name td; do
      if [ -z "$name" ] || [ "$name" = "None" ]; then continue; fi
      fam="${td##*/}"
      fam="${fam%%:*}"
      if [ "$fam" = "$EXPECTED_TASK_FAMILY" ]; then
        found+=("$name")
        found_td+=("$td")
      fi
    done <<<"$SVC_ROWS"
  done
  case "${#found[@]}" in
    0)
      stop "the gateway's ECS service was not found: cluster $ECS_CLUSTER has no ACTIVE service named $configured, and none of the $total service(s) in it is an ACTIVE one with the task definition family $EXPECTED_TASK_FAMILY. Nothing was changed. Tell the CTO." ;;
    1)
      ECS_SERVICE="${found[0]}"
      TD="${found_td[0]}"
      echo "  Service used           : $ECS_SERVICE (found by its task definition family; $configured is not an ACTIVE service)" ;;
    *)
      stop "more than one ACTIVE service in cluster $ECS_CLUSTER has the task definition family $EXPECTED_TASK_FAMILY (${found[*]}), and the script will not guess which one is the gateway. Nothing was changed. Tell the CTO." ;;
  esac
  return 0
}

# ---------------------------------------------------------------------------------------------
section "0. Who is running this"
if ! command -v aws >/dev/null 2>&1; then
  stop "the aws command was not found. Open AWS CloudShell (the >_ icon at the top of the console)."
fi
if ! command -v python3 >/dev/null 2>&1; then
  stop "python3 was not found (AWS CloudShell has it). Nothing was changed."
fi
if ! aws sts get-caller-identity --output json 2>"$ERRF"; then
  show_err
  stop "could not read who you are signed in as. Open AWS CloudShell from the OTCHealth console and run this again. Nothing was changed."
fi
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
CALLER_ARN="$(aws sts get-caller-identity --query Arn --output text)"
if [ "$ACCOUNT" != "$EXPECTED_ACCOUNT" ]; then
  stop "you are signed in to account $ACCOUNT, not $EXPECTED_ACCOUNT. Nothing was changed. Sign in to the OTCHealth account and run this again."
fi
echo "OK: account $ACCOUNT is the OTCHealth account."
case "$CALLER_ARN" in
  *":user/${READER_USER}"|*"assumed-role/${READER_ROLE}/"*)
    stop "this script must be run by the account owner or an administrator, not by the AI reader itself. Nothing was changed." ;;
  *) ;;
esac
EFFECTIVE_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
if [ -z "$EFFECTIVE_REGION" ]; then
  EFFECTIVE_REGION="$(aws configure get region 2>/dev/null || true)"
fi
if [ -z "$EFFECTIVE_REGION" ]; then
  echo "No region is set; using $REGION."
  EFFECTIVE_REGION="$REGION"
fi
if [ "$EFFECTIVE_REGION" != "$REGION" ]; then
  stop "this session is in region $EFFECTIVE_REGION, not $REGION (N. Virginia). The gateway lives in $REGION. Nothing was changed. Switch the console to US East (N. Virginia), reopen CloudShell and run this again."
fi
export AWS_REGION="$REGION"
export AWS_DEFAULT_REGION="$REGION"
echo "OK: region $REGION."
if ! run_aws SUMMARY iam get-account-summary --query 'SummaryMap.Users' --output text; then
  show_err
  stop "this sign-in cannot read IAM, so it cannot create the read-only identities. Nothing was changed. Sign in as the account owner or an administrator and run this again."
fi
echo "OK: this sign-in can read IAM (the account has $SUMMARY IAM user(s))."
if [ ! -d "${HOME:-/nonexistent}" ] || [ ! -w "${HOME:-/nonexistent}" ]; then
  stop "your home folder is missing or not writable, and the one-time password file goes there. Nothing was changed."
fi

# ---------------------------------------------------------------------------------------------
section "1. Current state (read only)"
echo "AWS managed policies, looked up by name (a path is never guessed):"
NAME_FILTER=""
for n in "${MANAGED_NAMES[@]}"; do
  if [ -n "$NAME_FILTER" ]; then NAME_FILTER="$NAME_FILTER || "; fi
  NAME_FILTER="${NAME_FILTER}PolicyName=='${n}'"
done
if ! run_aws LISTING iam list-policies --scope AWS --query "Policies[?${NAME_FILTER}].[PolicyName,Arn]" --output text; then
  show_err
  stop "could not list the AWS managed policies. Nothing was changed."
fi
MISSING=""
AMBIGUOUS=""
for n in "${MANAGED_NAMES[@]}"; do
  FOUND="$(printf '%s\n' "$LISTING" | awk -F'\t' -v n="$n" '$1 == n { print $2 }')"
  COUNT="$(printf '%s' "$FOUND" | grep -c . || true)"
  if [ "$COUNT" -eq 0 ]; then
    printf '  %-32s NOT FOUND\n' "$n"
    MISSING="$MISSING $n"
  elif [ "$COUNT" -gt 1 ]; then
    printf '  %-32s MORE THAN ONE POLICY HAS THIS NAME (a path is never guessed):\n' "$n"
    printf '%s\n' "$FOUND" | sed 's/^/        /'
    AMBIGUOUS="$AMBIGUOUS $n"
  else
    case "$FOUND" in
      "arn:aws:iam::aws:policy/${n}"|"arn:aws:iam::aws:policy/"*"/${n}")
        MANAGED_ARNS+=("$FOUND")
        printf '  %-32s %s\n' "$n" "$FOUND" ;;
      *)
        printf '  %-32s UNEXPECTED ARN: %s\n' "$n" "$FOUND"
        AMBIGUOUS="$AMBIGUOUS $n" ;;
    esac
  fi
done
if [ -n "$MISSING" ] || [ -n "$AMBIGUOUS" ]; then
  MSG=""
  if [ -n "$MISSING" ]; then MSG="not found by name:$MISSING. "; fi
  if [ -n "$AMBIGUOUS" ]; then MSG="${MSG}more than one match, or an unexpected ARN:$AMBIGUOUS. "; fi
  stop "AWS managed policies: ${MSG}A path is never guessed, so nothing was changed. Tell the CTO."
fi

if run_aws PW_POLICY_JSON iam get-account-password-policy --query PasswordPolicy --output json; then
  echo "Account password policy: custom policy found."
elif err_has NoSuchEntity; then
  PW_POLICY_JSON="{}"
  echo "Account password policy: none set (AWS defaults apply)."
else
  show_err
  PW_POLICY_JSON="{}"
  echo "Account password policy could not be read; a long password with all character types will be used."
fi

echo "User $READER_USER:"
if run_aws UARN iam get-user --user-name "$READER_USER" --query User.Arn --output text; then
  USER_ARN="$UARN"
  echo "  Exists: $USER_ARN"
  show_state user "$READER_USER"
elif err_has NoSuchEntity; then
  echo "  Does not exist yet."
else
  show_err
  stop "could not read user $READER_USER. Nothing was changed."
fi
echo "Role $READER_ROLE:"
if run_aws RARN iam get-role --role-name "$READER_ROLE" --query Role.Arn --output text; then
  ROLE_ARN="$RARN"
  echo "  Exists: $ROLE_ARN"
  show_state role "$READER_ROLE"
elif err_has NoSuchEntity; then
  echo "  Does not exist yet."
else
  show_err
  stop "could not read role $READER_ROLE. Nothing was changed."
fi

echo "Gateway task role (cluster $ECS_CLUSTER, service $ECS_SERVICE):"
B_PROBLEM=""
resolve_gateway_service
if [ -z "$B_PROBLEM" ]; then
  echo "  Task definition in use : ${TD##*/}"
  if ! run_aws TROLE ecs describe-task-definition --task-definition "$TD" --query taskDefinition.taskRoleArn --output text; then
    B_PROBLEM="the task definition ${TD##*/} could not be read: $(err_text)"
  elif [ -z "$TROLE" ] || [ "$TROLE" = "None" ]; then
    B_PROBLEM="task definition ${TD##*/} has no taskRoleArn"
  else
    TASK_ROLE_NAME="${TROLE##*/}"
    if ! run_aws TASK_ROLE_ARN iam get-role --role-name "$TASK_ROLE_NAME" --query Role.Arn --output text; then
      TASK_ROLE_ARN=""
      TASK_ROLE_NAME=""
      B_PROBLEM="the task role named in the task definition ($TROLE) could not be read in IAM: $(err_text)"
    else
      echo "  Task role              : $TASK_ROLE_ARN"
    fi
  fi
fi
if [ -n "$B_PROBLEM" ]; then
  echo "  Not found: $B_PROBLEM"
  echo "  Part B (the role for the gateway) will be reported as FAILED; part A still goes ahead."
fi

# ---------------------------------------------------------------------------------------------
section "2. Shared policies (used by the user and the role)"
EXTRAS_FILE="$WORK_DIR/extras.json"
cat > "$EXTRAS_FILE" <<'EXTRAS_JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "MonitoringReads",
      "Effect": "Allow",
      "Action": [
        "cloudwatch:GetMetricData", "cloudwatch:GetMetricStatistics", "cloudwatch:ListMetrics",
        "cloudwatch:DescribeAlarms", "cloudwatch:DescribeAlarmHistory", "ce:GetCostAndUsage",
        "ce:GetCostAndUsageWithResources", "ce:GetCostForecast", "ce:GetDimensionValues",
        "budgets:ViewBudget", "health:DescribeEvents", "ecs:DescribeClusters",
        "ecs:DescribeServices", "ecs:DescribeTasks", "ecs:ListClusters", "ecs:ListServices",
        "ecs:ListTasks", "elasticloadbalancing:Describe*", "es:DescribeDomain",
        "es:DescribeDomainHealth", "es:DescribeDomains", "es:ListDomainNames",
        "lightsail:GetInstance", "lightsail:GetInstances", "lightsail:GetInstanceState",
        "lightsail:GetInstanceMetricData", "cloudtrail:LookupEvents", "logs:DescribeLogGroups",
        "logs:DescribeLogStreams", "sts:GetCallerIdentity"
      ],
      "Resource": "*"
    }
  ]
}
EXTRAS_JSON
DENY_FILE="$WORK_DIR/deny.json"
cat > "$DENY_FILE" <<'DENY_JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "NoSecretOrKeyValues",
      "Effect": "Deny",
      "Action": [
        "secretsmanager:GetSecretValue", "secretsmanager:BatchGetSecretValue", "ssm:GetParameter",
        "ssm:GetParameters", "ssm:GetParametersByPath", "ssm:GetParameterHistory", "kms:Decrypt",
        "kms:GenerateDataKey*", "kms:ReEncrypt*", "acm:ExportCertificate", "ec2:GetPasswordData",
        "lightsail:GetInstanceAccessDetails", "lightsail:DownloadDefaultKeyPair",
        "lightsail:GetRelationalDatabaseMasterUserPassword", "lightsail:GetContainerServices",
        "lightsail:GetContainerServiceDeployments", "cognito-idp:DescribeUserPoolClient",
        "cognito-idp:ListUserPoolClientSecrets", "wafv2:ListAPIKeys",
        "directconnect:DescribeVirtualInterfaces", "directconnect:DescribeRouterConfiguration",
        "redshift:GetClusterCredentials", "redshift:GetClusterCredentialsWithIAM",
        "redshift-serverless:GetCredentials", "rds-db:connect",
        "bedrock-agentcore:GetResourceApiKey", "bedrock-agentcore:GetResourceOauth2Token",
        "ecr:GetAuthorizationToken", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage",
        "ecr-public:GetAuthorizationToken"
      ],
      "Resource": "*"
    },
    {
      "Sid": "NoDataContent",
      "Effect": "Deny",
      "Action": [
        "s3:GetObject*", "s3express:CreateSession", "logs:GetLogEvents", "logs:FilterLogEvents",
        "logs:StartQuery", "logs:GetQueryResults", "logs:StartLiveTail", "logs:GetLogRecord",
        "logs:Unmask", "dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query",
        "dynamodb:Scan", "dynamodb:PartiQLSelect", "dynamodb:ExportTableToPointInTime",
        "dynamodb:GetRecords", "es:ESHttp*", "aoss:APIAccessAll", "aoss:DashboardsAccessAll",
        "rds-data:*", "athena:GetQueryResults", "athena:GetQueryResultsStream",
        "redshift-data:GetStatementResult", "sqs:ReceiveMessage", "kinesis:GetRecords",
        "kinesis:GetShardIterator", "states:GetExecutionHistory", "states:DescribeExecution",
        "ssm:GetCommandInvocation", "ssm:ListCommandInvocations",
        "cloudwatch:GetTelemetryQueryResults", "cloudwatch:GetRecords",
        "cloudwatch:GetSpaceCredentials", "cloudwatch:GetSpaceCredentialsForOrganization",
        "cognito-idp:ListUsers", "cognito-idp:ListUsersInGroup", "ses:ListContacts",
        "ses:ListSuppressedDestinations", "ses:ListMembersOfAddressList",
        "cloudwatch:GetInsightRuleReport", "redshift:ViewQueriesInConsole", "lex:GetUtterancesView"
      ],
      "Resource": "*"
    },
    {
      "Sid": "NoFileNames",
      "Effect": "Deny",
      "Action": [
        "s3:ListBucket", "s3:ListBucketVersions", "s3:ListBucketMultipartUploads"
      ],
      "Resource": "*"
    },
    {
      "Sid": "NoConfigThatHoldsSecrets",
      "Effect": "Deny",
      "Action": [
        "lambda:GetFunction", "lambda:GetFunctionConfiguration", "lambda:ListFunctions",
        "lambda:ListVersionsByFunction", "lambda:GetLayerVersion", "ecs:DescribeTaskDefinition",
        "ecs:DescribeDaemonTaskDefinition", "ecs:DescribeExpressGatewayService",
        "ec2:GetConsoleOutput", "ec2:GetConsoleScreenshot", "ec2:GetLaunchTemplateData",
        "ec2:DescribeInstanceAttribute", "ec2:DescribeLaunchTemplateVersions",
        "ec2:DescribeSpotFleetRequests", "ec2:DescribeVpnConnections",
        "autoscaling:DescribeLaunchConfigurations", "events:ListTargetsByRule",
        "codebuild:BatchGetProjects", "codebuild:BatchGetBuilds", "glue:GetConnection",
        "glue:GetConnections", "glue:GetJob", "glue:GetJobs", "glue:GetJobRun", "glue:GetJobRuns",
        "sagemaker:DescribeTrainingJob", "sagemaker:DescribeProcessingJob",
        "sagemaker:DescribeTransformJob", "sagemaker:DescribeModel",
        "sagemaker:DescribeNotebookInstanceLifecycleConfig",
        "sagemaker:DescribeStudioLifecycleConfig", "cloudfront:GetDistribution",
        "cloudfront:GetDistributionConfig", "cloudfront:ListDistributions",
        "ec2:DescribeSpotInstanceRequests", "elasticmapreduce:ListSteps"
      ],
      "Resource": "*"
    },
    {
      "Sid": "NoShellOrRemoteExec",
      "Effect": "Deny",
      "Action": [
        "ecs:ExecuteCommand", "ssm:StartSession", "ssm:SendCommand",
        "ec2-instance-connect:SendSSHPublicKey",
        "ec2-instance-connect:SendSerialConsoleSSHPublicKey"
      ],
      "Resource": "*"
    },
    {
      "Sid": "NoPaymentsOrPaymentMethods",
      "Effect": "Deny",
      "Action": [
        "payments:*", "aws-portal:ViewPaymentMethods", "aws-portal:ModifyPaymentMethods"
      ],
      "Resource": "*"
    },
    {
      "Sid": "NoCredentialOrPermissionChanges",
      "Effect": "Deny",
      "Action": [
        "iam:CreateAccessKey", "iam:CreateLoginProfile", "iam:UpdateLoginProfile",
        "iam:AttachUserPolicy", "iam:PutUserPolicy", "iam:AttachRolePolicy", "iam:PutRolePolicy",
        "iam:AttachGroupPolicy", "iam:PutGroupPolicy", "iam:CreatePolicyVersion",
        "iam:SetDefaultPolicyVersion", "iam:UpdateAssumeRolePolicy", "iam:AddUserToGroup",
        "iam:CreateServiceSpecificCredential", "iam:ResetServiceSpecificCredential"
      ],
      "Resource": "*"
    },
    {
      "Sid": "NoApiGatewayStageVariables",
      "Effect": "Deny",
      "Action": [
        "apigateway:GET"
      ],
      "Resource": [
        "arn:aws:apigateway:*::/restapis/*/stages",
        "arn:aws:apigateway:*::/restapis/*/stages/*",
        "arn:aws:apigateway:*::/apis/*/stages",
        "arn:aws:apigateway:*::/apis/*/stages/*"
      ]
    }
  ]
}
DENY_JSON
echo "Policy $DENY_POLICY (explicit Deny, wins over every Allow):"
if ! put_managed "$DENY_POLICY" "$DENY_FILE" 6144 "Explicit deny for AI read-only identities: secrets, data content, shell access, payments, IAM credential changes (2026-10-07)"; then
  stop "the deny policy could not be saved (the message above says why). Usual cause: this sign-in may not change IAM. Sign in as the account owner or an administrator and run again."
fi
echo "Policy $EXTRAS_POLICY (a few extra read calls):"
if ! put_managed "$EXTRAS_POLICY" "$EXTRAS_FILE" 6144 "Extra read-only calls for AI read-only identities: metrics, cost, alarms, ECS, load balancers, OpenSearch domain info, Lightsail (2026-10-07)"; then
  stop "the extras policy could not be saved (the message above says why). Run again, or send this screen to the CTO."
fi
# The billing policy is its own policy (not part of the extras), so the extras and the deny text stay exactly as they
# were, and taking cost and billing away again is one detach per identity. Five of the Cost Explorer and Budgets names
# are also in the extras; they are repeated here so this policy stands on its own. None of the names below is matched by
# a Deny statement in the deny policy (the tests check that with the saved policies).
BILLING_FILE="$WORK_DIR/billing.json"
cat > "$BILLING_FILE" <<'BILLING_JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CostAndBillingReadOnly",
      "Effect": "Allow",
      "Action": [
        "ce:DescribeCostCategoryDefinition", "ce:GetAnomalies", "ce:GetAnomalyMonitors",
        "ce:GetAnomalySubscriptions", "ce:GetApproximateUsageRecords", "ce:GetCommitmentPurchaseAnalysis",
        "ce:GetCostAndUsage", "ce:GetCostAndUsageComparisons", "ce:GetCostAndUsageWithResources",
        "ce:GetCostCategories", "ce:GetCostComparisonDrivers", "ce:GetCostForecast",
        "ce:GetDimensionValues", "ce:GetReservationCoverage", "ce:GetReservationPurchaseRecommendation",
        "ce:GetReservationUtilization", "ce:GetRightsizingRecommendation",
        "ce:GetSavingsPlanPurchaseRecommendationDetails", "ce:GetSavingsPlansCoverage",
        "ce:GetSavingsPlansPurchaseRecommendation", "ce:GetSavingsPlansUtilization",
        "ce:GetSavingsPlansUtilizationDetails", "ce:GetTags", "ce:GetUsageForecast",
        "ce:ListCommitmentPurchaseAnalyses", "ce:ListCostAllocationTagBackfillHistory",
        "ce:ListCostAllocationTags", "ce:ListCostCategoryDefinitions",
        "ce:ListCostCategoryResourceAssociations", "ce:ListSavingsPlansPurchaseRecommendationGeneration",
        "ce:ListTagsForResource",
        "budgets:ViewBudget", "budgets:DescribeBudgetAction", "budgets:DescribeBudgetActionHistories",
        "budgets:DescribeBudgetActionsForAccount", "budgets:DescribeBudgetActionsForBudget",
        "budgets:ListTagsForResource",
        "savingsplans:DescribeSavingsPlanRates", "savingsplans:DescribeSavingsPlans",
        "savingsplans:DescribeSavingsPlansOfferingRates", "savingsplans:DescribeSavingsPlansOfferings",
        "savingsplans:ListTagsForResource",
        "cost-optimization-hub:GetPreferences", "cost-optimization-hub:GetRecommendation",
        "cost-optimization-hub:ListEfficiencyMetrics", "cost-optimization-hub:ListEnrollmentStatuses",
        "cost-optimization-hub:ListRecommendationSummaries", "cost-optimization-hub:ListRecommendations",
        "compute-optimizer:DescribeRecommendationExportJobs",
        "compute-optimizer:GetAutoScalingGroupRecommendations",
        "compute-optimizer:GetEBSVolumeRecommendations", "compute-optimizer:GetEC2InstanceRecommendations",
        "compute-optimizer:GetEC2RecommendationProjectedMetrics",
        "compute-optimizer:GetECSServiceRecommendationProjectedMetrics",
        "compute-optimizer:GetECSServiceRecommendations",
        "compute-optimizer:GetEffectiveRecommendationPreferences", "compute-optimizer:GetEnrollmentStatus",
        "compute-optimizer:GetEnrollmentStatusesForOrganization",
        "compute-optimizer:GetIdleRecommendations", "compute-optimizer:GetLambdaFunctionRecommendations",
        "compute-optimizer:GetLicenseRecommendations",
        "compute-optimizer:GetRDSDatabaseRecommendationProjectedMetrics",
        "compute-optimizer:GetRDSDatabaseRecommendations",
        "compute-optimizer:GetRecommendationPreferences", "compute-optimizer:GetRecommendationSummaries",
        "pricing:DescribeServices", "pricing:GetAttributeValues", "pricing:GetPriceListFileUrl",
        "pricing:GetProducts", "pricing:ListPriceLists",
        "billing:GetBillingData", "billing:GetBillingDetails", "billing:GetBillingNotifications",
        "billing:GetBillingPreferences", "billing:GetBillingView", "billing:GetBillingViewData",
        "billing:GetCreditAllocationHistory", "billing:GetCredits", "billing:ListBillingViews",
        "account:GetAccountInformation",
        "consolidatedbilling:GetAccountBillingRole", "consolidatedbilling:ListLinkedAccounts",
        "invoicing:ListInvoiceSummaries"
      ],
      "Resource": "*"
    }
  ]
}
BILLING_JSON
echo "Policy $BILLING_POLICY (cost and billing, read only: Read and List actions, nothing that changes or buys):"
if ! put_managed "$BILLING_POLICY" "$BILLING_FILE" 6144 "Read-only cost and billing calls for AI read-only identities: Cost Explorer, Budgets, Savings Plans, Cost Optimization Hub, Compute Optimizer, price list, credits and bills. No write action (2026-10-09)"; then
  stop "the billing policy could not be saved (the message above says why). Run again, or send this screen to the CTO."
fi

# ---------------------------------------------------------------------------------------------
section "3. Part A: IAM user $READER_USER"
CUR_PART="A"
if [ -n "$USER_ARN" ]; then
  echo "  User exists: $USER_ARN"
  aws iam tag-user --user-name "$READER_USER" --tags "${TAG_ARGS[@]}" || stop "could not tag user $READER_USER."
else
  if ! run_aws USER_ARN iam create-user --user-name "$READER_USER" --tags "${TAG_ARGS[@]}" --query User.Arn --output text; then
    show_err
    stop "the user could not be created (the message above says why). Usual cause: this sign-in may not change IAM."
  fi
  echo "  Created user: $USER_ARN"
fi
add_rollback 40 "aws iam delete-user --user-name $READER_USER"
add_rollback 31 "for s in \$(aws iam list-mfa-devices --user-name $READER_USER --query 'MFADevices[].SerialNumber' --output text); do aws iam deactivate-mfa-device --user-name $READER_USER --serial-number \"\$s\"; aws iam delete-virtual-mfa-device --serial-number \"\$s\"; done"
add_rollback 30 "aws iam delete-login-profile --user-name $READER_USER"
pass "A  user $READER_USER exists (tags: purpose=ai-read-only, owner=cto, created=2026-10-07)"

echo "  Policies on the user:"
for arn in "$DENY_ARN" "$EXTRAS_ARN" "$BILLING_ARN" "${MANAGED_ARNS[@]}"; do
  if ! ensure_attached user "$READER_USER" "$arn"; then
    stop "could not attach ${arn##*/} to $READER_USER (the message above says why)."
  fi
done

MFA_FILE="$WORK_DIR/self-mfa.json"
cat > "$MFA_FILE" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CreateOwnVirtualMfaDevice",
      "Effect": "Allow",
      "Action": "iam:CreateVirtualMFADevice",
      "Resource": "arn:aws:iam::${EXPECTED_ACCOUNT}:mfa/*"
    },
    {
      "Sid": "ManageOwnMfaOnly",
      "Effect": "Allow",
      "Action": ["iam:EnableMFADevice", "iam:ResyncMFADevice", "iam:ListMFADevices", "iam:GetMFADevice", "iam:GetUser"],
      "Resource": "${USER_ARN}"
    }
  ]
}
EOF
echo "  Inline policy $MFA_POLICY (the user may set up its own MFA device, nothing else):"
if ! save_policy user "$READER_USER" "$MFA_POLICY" "$MFA_FILE" 2048; then
  stop "the MFA policy could not be saved on $READER_USER (the message above says why)."
fi
MFA_MODE="$LAST_SAVE_MODE"
pass "A  the user may set up its own MFA device and nothing else in IAM (policy $MFA_POLICY, read back)"

if ! run_aws HAVE_ALL iam list-attached-user-policies --user-name "$READER_USER" --query 'AttachedPolicies[].PolicyArn' --output text; then
  show_err
  stop "could not read back the policies attached to $READER_USER."
fi
UMISSING="$(list_missing "$HAVE_ALL" "$DENY_ARN" "$EXTRAS_ARN" "$BILLING_ARN" "${MANAGED_ARNS[@]}")"
if [ -z "$UMISSING" ]; then
  pass "A  all 7 managed policies are attached to the user (4 AWS managed, extras, billing, deny)"
else
  fail "A  these policies are not attached to the user:$UMISSING"
fi
if list_has "$HAVE_ALL" "$BILLING_ARN"; then BILLING_USER_OK="yes"; fi
echo "  Checking that the user has nothing this script did not put there:"
EXPECT_MANAGED=("$DENY_ARN" "$EXTRAS_ARN" "$BILLING_ARN" "${MANAGED_ARNS[@]}")
EXPECT_INLINE=()
if [ "$MFA_MODE" = "managed" ]; then
  EXPECT_MANAGED+=("arn:aws:iam::${EXPECTED_ACCOUNT}:policy/${MFA_POLICY}")
else
  EXPECT_INLINE+=("$MFA_POLICY")
fi
if exact_check user "$READER_USER"; then
  pass "A  the user has only the expected policies (7 managed, plus the MFA policy): no other policy, no group, no permissions boundary"
else
  fail "A  the user has $EXACT_N item(s) this script did not add, or that could not be read: ${EXACT_LIST}. Do not connect any AI tool as this user until they are gone. No console password is created or changed meanwhile."
fi
if run_aws KEYS iam list-access-keys --user-name "$READER_USER" --query 'length(AccessKeyMetadata)' --output text; then
  if [ "$KEYS" = "0" ]; then
    pass "A  the user has no access keys (this script never creates any)"
  else
    fail "A  the user has $KEYS access key(s). This script never creates keys; delete them in the IAM console (user > Security credentials)."
  fi
else
  show_err
  fail "A  could not check the user's access keys"
fi

# ---------------------------------------------------------------------------------------------
section "4. Part B: IAM role $READER_ROLE"
CUR_PART="B"
if [ -z "$TASK_ROLE_ARN" ]; then
  fail "B  the gateway's task role was not found, so the role was not created or changed ($B_PROBLEM)"
else
  pass "B  gateway task role found: $TASK_ROLE_ARN"
  TRUST_FILE="$WORK_DIR/trust.json"
  cat > "$TRUST_FILE" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "GatewayTaskRoleOnly",
      "Effect": "Allow",
      "Principal": {"AWS": "${TASK_ROLE_ARN}"},
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF
  echo "  Trust policy this script would write:"
  policy_summary "$TRUST_FILE" 2048 || stop "the trust policy text is invalid."
  echo "  (When the role is written, only $TASK_ROLE_ARN may assume it.)"
  B_OK="yes"
  ROLE_EXACT="yes"
  if [ -n "$ROLE_ARN" ]; then
    # An existing role is checked BEFORE anything on it is changed. A role that holds anything this script did not
    # add is left completely alone: no trust rewrite, nothing attached, and no permission for the gateway task role.
    # (A same-account trust policy that names the task role is already enough for it to assume the role, so the
    # trust policy is the thing that must never be written to a role that is not exact.)
    echo "  Role exists: $ROLE_ARN. Checking that it holds nothing this script did not put there, BEFORE anything on it is changed:"
    EXPECT_MANAGED=("$DENY_ARN" "$EXTRAS_ARN" "${MANAGED_ARNS[0]}")
    EXPECT_INLINE=()
    if ! exact_check role "$READER_ROLE"; then
      ROLE_EXACT="no"
      B_OK="no"
      fail "B  the role has $EXACT_N item(s) this script did not add, or that could not be read: ${EXACT_LIST}. This run changed nothing on the role and gave the gateway task role no permission to use it. Do not let the gateway use the role until they are gone."
    fi
  fi
  if [ "$ROLE_EXACT" = "no" ]; then
    : # nothing is written to a role that is not exact; the FAIL above says so
  elif [ -n "$ROLE_ARN" ]; then
    echo "  Role is exact: $ROLE_ARN (trust policy, session length and tags are set again below)"
    if ! aws iam update-assume-role-policy --role-name "$READER_ROLE" --policy-document "file://$TRUST_FILE"; then B_OK="no"; fi
    if [ "$B_OK" = "yes" ] && ! aws iam update-role --role-name "$READER_ROLE" --description "$ROLE_DESCRIPTION" --max-session-duration "$SESSION_SECONDS"; then B_OK="no"; fi
    if [ "$B_OK" = "yes" ] && ! aws iam tag-role --role-name "$READER_ROLE" --tags "${TAG_ARGS[@]}"; then B_OK="no"; fi
  else
    if run_aws ROLE_ARN iam create-role --role-name "$READER_ROLE" --assume-role-policy-document "file://$TRUST_FILE" --max-session-duration "$SESSION_SECONDS" --description "$ROLE_DESCRIPTION" --tags "${TAG_ARGS[@]}" --query Role.Arn --output text; then
      echo "  Created role: $ROLE_ARN"
    else
      show_err
      B_OK="no"
    fi
  fi
  if [ "$B_OK" = "yes" ]; then
    add_rollback 25 "aws iam delete-role --role-name $READER_ROLE"
    for arn in "$DENY_ARN" "$EXTRAS_ARN" "${MANAGED_ARNS[0]}"; do
      if ! ensure_attached role "$READER_ROLE" "$arn"; then B_OK="no"; break; fi
    done
  fi
  if [ "$B_OK" = "yes" ]; then
    if run_aws RINFO iam get-role --role-name "$READER_ROLE" --query 'Role.[MaxSessionDuration,length(AssumeRolePolicyDocument.Statement),AssumeRolePolicyDocument.Statement[0].Principal.AWS]' --output text; then
      if [ "$RINFO" = "$(printf '%s\t%s\t%s' "$SESSION_SECONDS" 1 "$TASK_ROLE_ARN")" ]; then
        pass "B  role $READER_ROLE trusts only the gateway task role; sessions last at most $SESSION_SECONDS seconds"
      else
        fail "B  role $READER_ROLE does not read back as intended (session seconds, trust statements, principal): $RINFO"
      fi
    else
      show_err
      fail "B  could not read back role $READER_ROLE"
    fi
    if run_aws RPOL iam list-attached-role-policies --role-name "$READER_ROLE" --query 'AttachedPolicies[].PolicyArn' --output text; then
      RMISSING="$(list_missing "$RPOL" "$DENY_ARN" "$EXTRAS_ARN" "${MANAGED_ARNS[0]}")"
      if [ -z "$RMISSING" ]; then
        pass "B  the role has ViewOnlyAccess, the extras and the deny policy attached"
      else
        fail "B  these policies are not attached to the role:$RMISSING"
      fi
      echo "  Checking that the role has nothing this script did not put there:"
      EXPECT_MANAGED=("$DENY_ARN" "$EXTRAS_ARN" "${MANAGED_ARNS[0]}")
      EXPECT_INLINE=()
      if exact_check role "$READER_ROLE"; then
        pass "B  the role has only the 3 expected managed policies: no inline policy, no permissions boundary"
      else
        fail "B  the role has $EXACT_N item(s) this script did not add, or that could not be read: ${EXACT_LIST}. Do not let the gateway use the role until they are gone."
      fi
    else
      show_err
      fail "B  could not read back the policies attached to role $READER_ROLE"
    fi
    ASSUME_FILE="$WORK_DIR/assume.json"
    cat > "$ASSUME_FILE" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AssumeAiReaderRoleOnly",
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": "${ROLE_ARN}"
    }
  ]
}
EOF
    echo "  Policy $ASSUME_POLICY on the gateway task role $TASK_ROLE_NAME:"
    if save_policy role "$TASK_ROLE_NAME" "$ASSUME_POLICY" "$ASSUME_FILE" 10240; then
      GRANT_OK="yes"
      pass "B  the gateway task role may assume $READER_ROLE (one small policy, that role only)"
    else
      fail "B  the assume policy could not be saved on the gateway task role $TASK_ROLE_NAME"
    fi
  elif [ "$ROLE_EXACT" = "yes" ]; then
    fail "B  role $READER_ROLE could not be created or set up (the message above says why)"
  fi
fi

# ---------------------------------------------------------------------------------------------
section "5. Checking with the IAM policy simulator"
echo "  (The simulator checks identity policies, boundaries and organization rules. It cannot see"
echo "   resource policies, so the first real use is the final proof.)"
sleep 3
SVC_ARN="arn:aws:ecs:${REGION}:${EXPECTED_ACCOUNT}:service/${ECS_CLUSTER}/${ECS_SERVICE}"
USERNAME_CTX="[{\"ContextKeyName\":\"aws:username\",\"ContextKeyValues\":[\"${READER_USER}\"],\"ContextKeyType\":\"string\"}]"
OTHER_USER_ARN="arn:aws:iam::${EXPECTED_ACCOUNT}:user/someone-else"
MCP_ARN="arn:aws:signin:${REGION}:${EXPECTED_ACCOUNT}:service-principal/aws-mcp.amazonaws.com"
LOCAL_ARN="arn:aws:signin:${REGION}:${EXPECTED_ACCOUNT}:oauth2/public-client/aws-cli"
# "some other role in the account": the gateway task role when it is known, otherwise a made-up name
OTHER_ROLE_ARN="${TASK_ROLE_ARN:-arn:aws:iam::${EXPECTED_ACCOUNT}:role/example-other-role}"

# check_identity LABEL ARN  : the read-only checks that are the same for the user and the role
check_identity() {
  local who="$1" arn="$2"
  expect_allowed "$who  can read ECS service settings (ecs:DescribeServices)" "$arn" ecs:DescribeServices "$SVC_ARN"
  expect_allowed "$who  can read metrics (cloudwatch:GetMetricData)" "$arn" cloudwatch:GetMetricData "*"
  expect_allowed "$who  can read cost (ce:GetCostAndUsage)" "$arn" ce:GetCostAndUsage "*"
  expect_allowed "$who  can ask who it is (sts:GetCallerIdentity)" "$arn" sts:GetCallerIdentity "*"
  expect_blocked "$who  cannot read secrets (secretsmanager:GetSecretValue is explicitly denied)" "$arn" secretsmanager:GetSecretValue "arn:aws:secretsmanager:${REGION}:${EXPECTED_ACCOUNT}:secret:example" explicit
  expect_blocked "$who  cannot read parameters (ssm:GetParameter is explicitly denied)" "$arn" ssm:GetParameter "arn:aws:ssm:${REGION}:${EXPECTED_ACCOUNT}:parameter/otchealth/example" explicit
  expect_blocked "$who  cannot read S3 objects (s3:GetObject is explicitly denied)" "$arn" s3:GetObject "arn:aws:s3:::example-bucket/example-key" explicit
  expect_blocked "$who  cannot query OpenSearch data (es:ESHttpGet is explicitly denied)" "$arn" es:ESHttpGet "arn:aws:es:${REGION}:${EXPECTED_ACCOUNT}:domain/otchealth-brain/*" explicit
  expect_blocked "$who  cannot get Lightsail login details (lightsail:GetInstanceAccessDetails is explicitly denied)" "$arn" lightsail:GetInstanceAccessDetails "arn:aws:lightsail:${REGION}:${EXPECTED_ACCOUNT}:Instance/otchealth-cs-n8n" explicit
  expect_blocked "$who  cannot create access keys (iam:CreateAccessKey is explicitly denied)" "$arn" iam:CreateAccessKey "$USER_ARN" explicit
  expect_blocked "$who  cannot attach policies to users (iam:AttachUserPolicy is explicitly denied)" "$arn" iam:AttachUserPolicy "$USER_ARN" explicit
  expect_blocked "$who  cannot read container settings (ecs:DescribeTaskDefinition denied; ViewOnlyAccess alone would allow it)" "$arn" ecs:DescribeTaskDefinition "*" explicit
  expect_blocked "$who  cannot list Lambda settings (lambda:ListFunctions denied; ViewOnlyAccess alone would allow it)" "$arn" lambda:ListFunctions "*" explicit
  expect_blocked "$who  cannot list S3 file names (s3:ListBucket is explicitly denied)" "$arn" s3:ListBucket "arn:aws:s3:::example-bucket" explicit
  expect_blocked "$who  cannot start servers (ec2:RunInstances is not allowed)" "$arn" ec2:RunInstances "*" any
  expect_blocked "$who  cannot write to S3 (s3:PutObject is not allowed)" "$arn" s3:PutObject "arn:aws:s3:::example-bucket/example-key" any
  expect_blocked "$who  cannot hand a role to a service (iam:PassRole is not allowed)" "$arn" iam:PassRole "$OTHER_ROLE_ARN" any
  expect_blocked "$who  cannot take over another role (sts:AssumeRole is not allowed)" "$arn" sts:AssumeRole "$OTHER_ROLE_ARN" any
  expect_blocked "$who  cannot change parameters (ssm:PutParameter is not allowed)" "$arn" ssm:PutParameter "arn:aws:ssm:${REGION}:${EXPECTED_ACCOUNT}:parameter/otchealth/example" any
  expect_blocked "$who  cannot change secrets (secretsmanager:PutSecretValue is not allowed)" "$arn" secretsmanager:PutSecretValue "arn:aws:secretsmanager:${REGION}:${EXPECTED_ACCOUNT}:secret:example" any
  expect_blocked "$who  cannot change ECS services (ecs:UpdateService is not allowed)" "$arn" ecs:UpdateService "$SVC_ARN" any
}

CUR_PART="A"
echo "The user $READER_USER:"
check_identity "A" "$USER_ARN"
expect_allowed "A  user can change its own password (iam:ChangePassword)" "$USER_ARN" iam:ChangePassword "$USER_ARN" "$USERNAME_CTX"
expect_allowed "A  user can add an MFA device to itself (iam:EnableMFADevice on its own ARN)" "$USER_ARN" iam:EnableMFADevice "$USER_ARN"
expect_blocked "A  user cannot add an MFA device to anyone else (iam:EnableMFADevice on another user)" "$USER_ARN" iam:EnableMFADevice "$OTHER_USER_ARN" any
look_allowed "A  browser sign-in for the AWS MCP connector (signin:AuthorizeOAuth2Access)" "$USER_ARN" signin:AuthorizeOAuth2Access "$MCP_ARN"
look_allowed "A  browser sign-in for the AWS MCP connector (signin:CreateOAuth2Token)" "$USER_ARN" signin:CreateOAuth2Token "$MCP_ARN"
look_allowed "A  aws login on a PC (signin:CreateOAuth2Token, local development)" "$USER_ARN" signin:CreateOAuth2Token "$LOCAL_ARN"

CUR_PART="B"
echo "The role $READER_ROLE:"
if [ -n "$TASK_ROLE_ARN" ] && [ -n "$ROLE_ARN" ] && [ "$B_OK" = "yes" ]; then
  check_identity "B" "$ROLE_ARN"
  expect_blocked "B  role cannot add an MFA device to the reader user (it does not get the user's MFA policy)" "$ROLE_ARN" iam:EnableMFADevice "$USER_ARN" any
  expect_allowed "B  gateway task role can assume $READER_ROLE (sts:AssumeRole)" "$TASK_ROLE_ARN" sts:AssumeRole "$ROLE_ARN"
elif [ "$ROLE_EXACT" = "no" ]; then
  info "skipped: the role was left exactly as it was, because it holds something this script did not add (see the FAIL in part B above)"
else
  info "skipped: part B did not complete, so there is no role to check"
fi

# ---------------------------------------------------------------------------------------------
section "6. Console sign-in for $READER_USER"
CUR_PART="C"
PWGEN='
import os, secrets, sys
path, minlen = sys.argv[1], int(sys.argv[2])
n = min(128, max(32, minlen))
upper = "ABCDEFGHJKLMNPQRSTUVWXYZ"
lower = "abcdefghijkmnopqrstuvwxyz"
digit = "23456789"
symbol = "!@#%^*_+-="
chars = [secrets.choice(c) for c in (upper, lower, digit, symbol) for _ in range(3)]
pool = upper + lower + digit + symbol
chars += [secrets.choice(pool) for _ in range(n - len(chars))]
secrets.SystemRandom().shuffle(chars)
tmp = path + ".tmp"
if os.path.lexists(tmp):
    os.unlink(tmp)
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as f:
    f.write("".join(chars))
os.chmod(tmp, 0o600)
os.replace(tmp, path)
print(n)
'
PWPARSE='
import json, sys
p = json.loads(sys.argv[1] or "{}")
print(int(p.get("MinimumPasswordLength", 8)), "no" if p.get("AllowUsersToChangePassword") is False else "yes")
'
# remove any copy of the password from text that is about to be shown
scrub() {
  python3 -I -c '
import sys
try:
    pw = open(sys.argv[1]).read()
except OSError:
    pw = ""
t = sys.stdin.read()
sys.stdout.write(t.replace(pw, "[removed]") if pw else t)
' "$PW_FILE"
}

if [ "$FAIL_A" -ne 0 ]; then
  info "no console password was created or changed: part A has a failed check (see above). Fix that first, then run this script again."
elif run_aws LP iam get-login-profile --user-name "$READER_USER" --query 'LoginProfile.PasswordResetRequired' --output text; then
  PW_EXISTING="yes"
  add_rollback 30 "aws iam delete-login-profile --user-name $READER_USER"
  pass "C  console sign-in already exists for $READER_USER (left unchanged; this script does not touch an existing password)"
elif ! err_has NoSuchEntity; then
  show_err
  fail "C  could not check whether $READER_USER already has a console sign-in"
else
  read -r PW_MIN PW_CAN_CHANGE <<<"$(python3 -I -c "$PWPARSE" "$PW_POLICY_JSON")"
  if [ "$PW_CAN_CHANGE" = "no" ]; then
    info "the account password policy does not let users change their own password in general. That is fine here: the IAMUserChangePassword policy on $READER_USER still lets this one user change its own."
  fi
  if ! PW_LEN="$(python3 -I -c "$PWGEN" "$PW_FILE" "$PW_MIN" 2>"$ERRF")"; then
    show_err
    fail "C  the password file could not be written"
  else
    add_rollback 5 "rm -f $PW_FILE"
    if aws iam create-login-profile --user-name "$READER_USER" --password "file://$PW_FILE" --password-reset-required >"$WORK_DIR/clp.out" 2>"$WORK_DIR/clp.err"; then
      add_rollback 30 "aws iam delete-login-profile --user-name $READER_USER"
      PW_CREATED="yes"
      PW_MODE="$(stat -c '%a' "$PW_FILE" 2>/dev/null || echo unknown)"
      if [ "$PW_MODE" = "600" ]; then
        pass "C  console password created ($PW_LEN characters, must be changed at first sign-in), saved only in a mode 600 file, not printed"
      else
        fail "C  console password created, but the file mode is $PW_MODE instead of 600. Run: chmod 600 $PW_FILE"
      fi
    else
      head -n 4 "$WORK_DIR/clp.err" | scrub | sed 's/^/        /'
      rm -f "$PW_FILE"
      fail "C  the console sign-in could not be created (the message above says why). No password file was kept."
    fi
  fi
fi

# ---------------------------------------------------------------------------------------------
section "7. Summary"
echo "Checks:"
N=0
for c in "${CHECKS[@]}"; do
  N=$((N + 1))
  printf '  %2d. %-4s %s\n' "$N" "${c%%|*}" "${c#*|}"
done
echo ""
echo "Identities:"
echo "  User : ${USER_ARN:-not created}"
if [ "$ROLE_EXACT" = "no" ]; then
  echo "  Role : $ROLE_ARN (it already existed; this run did not change it)"
else
  echo "  Role : ${ROLE_ARN:-not created}"
fi
if [ "$GRANT_OK" = "yes" ]; then
  echo "  Gateway task role allowed to assume it: $TASK_ROLE_ARN"
elif [ -n "$TASK_ROLE_ARN" ]; then
  echo "  Gateway task role allowed to assume it: no (this run did not add that permission)"
else
  echo "  Gateway task role allowed to assume it: no (the gateway task role was not found)"
fi
TOTAL=$((PASSED + FAILED))
echo ""
echo "=============================================================="
if [ "$FAILED" -eq 0 ]; then
  echo " RESULT: ALL CHECKS PASSED ($PASSED of $TOTAL)"
  echo "=============================================================="
  echo " Tell the CTO: read-only AWS identities are ready."
else
  echo " RESULT: $FAILED of $TOTAL CHECKS FAILED"
  echo "=============================================================="
  echo " Send the CTO only the RESULT line and the lines that start with FAIL. It is safe to run this script again."
  if [ "${#FIXES[@]}" -gt 0 ]; then
    echo ""
    echo " TO REMOVE WHAT THIS SCRIPT DID NOT ADD (run these lines only after the CTO has said yes, then run this script again):"
    printf '   %s\n' "${FIXES[@]}"
  fi
fi
if [ "$PW_CREATED" = "yes" ]; then
  echo ""
  echo " CONSOLE SIGN-IN FOR $READER_USER (the password was NOT printed on this screen):"
  echo "   1. Show it:      cat ~/otchealth-ai-reader-initial-password.txt; echo"
  echo "      Save it in your password manager (name it: AWS otchealth-ai-reader), then run:  clear"
  echo "   2. Sign in at $SIGNIN_URL"
  echo "      as IAM user $READER_USER with that password."
  echo "   3. AWS asks you to choose a new password. Do that."
  echo "   4. Add an MFA device BEFORE you connect any AI tool (top right menu > Security credentials >"
  echo "      Assign MFA device). This script is public, so the account number, user name and sign-in"
  echo "      link are world-readable: a password alone is not enough."
  echo "   5. Delete the file:  rm ~/otchealth-ai-reader-initial-password.txt"
elif [ "$PW_EXISTING" = "yes" ]; then
  echo ""
  echo " $READER_USER already had a console sign-in, so this run did not touch it."
  echo " If you need a fresh password: run  aws iam delete-login-profile --user-name $READER_USER"
  echo " and then run this script again (it creates a new password file; nothing is printed)."
  if [ -e "$PW_FILE" ]; then
    echo " An older password file is still in your CloudShell home folder. Once the password is in your"
    echo " password manager, delete it:  rm ~/otchealth-ai-reader-initial-password.txt"
  fi
fi
print_rollbacks
if [ "$FAILED" -ne 0 ]; then exit 1; fi
exit 0
