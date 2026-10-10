#!/usr/bin/env bash
# test-aws-ai-access.sh: scenarios for setup/iam/aws-ai-access-2026-10-07.sh, run against the pretend account.
# Sourced by run-owner-script-tests.sh (it supplies $AI, the script under test, and the helpers in lib.sh).
# shellcheck shell=bash
# shellcheck disable=SC2154,SC2034  # AI and the lib.sh helpers come from run-owner-script-tests.sh; RUN_ENV is read by run_owner in lib.sh

# ai_stops_cleanly: the script stopped on purpose (exit 1, a STOP line, the ROLLBACK block saying nothing was changed)
# and made no change in the account at all.
ai_stops_cleanly() {
  expect_rc 1
  expect_out_has "STOP: "
  expect_out_has "ROLLBACK"
  expect_out_has "(nothing was changed)"
  expect_out_lacks "RESULT:"
  expect_no_writes
  expect_calls_lack "iam create-"
}

# ---- the gateway's ECS service is found --------------------------------------------------------------------------------
t_begin "aws-ai-access: the live service name (otchealth-gateway) resolves directly, and the whole run passes"
new_world '{}'
run_owner "$AI"
expect_rc 0
expect_out_has "RESULT: ALL CHECKS PASSED"
expect_out_has "Service used           : otchealth-gateway (the configured name, ACTIVE)"
expect_out_has "Task role              : arn:aws:iam::900915535335:role/otchealthTaskRole"
expect_out_has "PASS  B  role otchealth-ai-reader-role trusts only the gateway task role"
expect_calls_lack "ecs list-services"
expect_calls_have "service/otchealth/otchealth-gateway"
expect_calls_have "W iam create-role --role-name otchealth-ai-reader-role"
expect_calls_have "W iam put-role-policy --role-name otchealthTaskRole"
expect_file "$SANDBOX/home/otchealth-ai-reader-initial-password.txt"
if [ "$(stat -c '%a' "$SANDBOX/home/otchealth-ai-reader-initial-password.txt" 2>/dev/null)" != "600" ]; then
  t_note "the password file is not mode 600"
fi
if grep -Fqf "$SANDBOX/home/otchealth-ai-reader-initial-password.txt" "$OUT_FILE"; then t_note "the password was printed on the screen"; fi
t_end

t_begin "aws-ai-access: the task role is read from the task definition, so the other spelling of its name works too (otchealthGatewayTaskRole)"
new_world '{"ecs":{"task_role":"otchealthGatewayTaskRole"},"iam":{"roles":{"otchealthGatewayTaskRole":{"arn":"arn:aws:iam::900915535335:role/otchealthGatewayTaskRole","max_session":3600,"trust":{}}}}}'
run_owner "$AI"
expect_rc 0
expect_out_has "Service used           : otchealth-gateway (the configured name, ACTIVE)"
expect_out_has "Task role              : arn:aws:iam::900915535335:role/otchealthGatewayTaskRole"
expect_out_has "RESULT: ALL CHECKS PASSED"
expect_calls_have "W iam put-role-policy --role-name otchealthGatewayTaskRole"
expect_calls_lack "put-role-policy --role-name otchealthTaskRole"
t_end

t_begin "aws-ai-access: no ACTIVE service has the configured name, so the one with task definition family otchealth-gateway is used"
new_world '{"ecs":{"services":[{"name":"gw-blue"}]}}'
run_owner "$AI"
expect_rc 0
expect_out_has "There is no ACTIVE service named otchealth-gateway in cluster otchealth."
expect_out_has "Service used           : gw-blue (found by its task definition family; otchealth-gateway is not an ACTIVE service)"
expect_out_has "RESULT: ALL CHECKS PASSED"
expect_calls_have "ecs list-services"
expect_calls_have "service/otchealth/gw-blue"
expect_calls_lack "service/otchealth/otchealth-gateway"
expect_calls_have "W iam create-role --role-name otchealth-ai-reader-role"
t_end

t_begin "aws-ai-access: the old wrong name (a service called just otchealth) is found by its family too"
new_world '{"ecs":{"services":[{"name":"otchealth"}]}}'
run_owner "$AI"
expect_rc 0
expect_out_has "Service used           : otchealth (found by its task definition family"
expect_out_has "RESULT: ALL CHECKS PASSED"
t_end

t_begin "aws-ai-access: ECS_SERVICE names a service that is not there, so the family decides"
new_world '{}'
RUN_ENV=("ECS_SERVICE=no-such-service")
run_owner "$AI"
expect_rc 0
expect_out_has "There is no ACTIVE service named no-such-service in cluster otchealth."
expect_out_has "Service used           : otchealth-gateway (found by its task definition family; no-such-service is not an ACTIVE service)"
expect_out_has "RESULT: ALL CHECKS PASSED"
t_end

t_begin "aws-ai-access: ECS_SERVICE names an ACTIVE service, which is used as it is (no listing)"
new_world '{"ecs":{"services":[{"name":"otchealth-gateway"},{"name":"gw-custom"}]}}'
RUN_ENV=("ECS_SERVICE=gw-custom")
run_owner "$AI"
expect_rc 0
expect_out_has "Service used           : gw-custom (the configured name, ACTIVE)"
expect_calls_lack "ecs list-services"
expect_calls_have "service/otchealth/gw-custom"
t_end

t_begin "aws-ai-access: a second service with the same family does not matter when the configured name is ACTIVE"
new_world '{"ecs":{"services":[{"name":"otchealth-gateway"},{"name":"otchealth-gateway-canary"}]}}'
run_owner "$AI"
expect_rc 0
expect_out_has "Service used           : otchealth-gateway (the configured name, ACTIVE)"
expect_out_has "RESULT: ALL CHECKS PASSED"
expect_calls_lack "ecs list-services"
t_end

t_begin "aws-ai-access: 12 services in the cluster are read in batches of 10 and the gateway is still found"
new_world "{\"ecs\":{\"services\":$(services_json 11 gw-moved)}}"
run_owner "$AI"
expect_rc 0
expect_out_has "Service used           : gw-moved (found by its task definition family"
expect_out_has "RESULT: ALL CHECKS PASSED"
expect_calls_count "[serviceName,taskDefinition]" 2
t_end

# ---- the gateway's ECS service is NOT found: stop before any write ------------------------------------------------------
t_begin "aws-ai-access: two ACTIVE services with the gateway family and none with the configured name: STOP before any write"
new_world '{"ecs":{"services":[{"name":"gw-blue"},{"name":"gw-green"}]}}'
run_owner "$AI"
ai_stops_cleanly
expect_out_has "STOP: more than one ACTIVE service in cluster otchealth has the task definition family otchealth-gateway (gw-blue gw-green)"
expect_out_has "the script will not guess which one is the gateway"
t_end

t_begin "aws-ai-access: no service has the gateway family: STOP before any write"
new_world '{"ecs":{"services":[{"name":"n8n-worker","family":"otchealth-job-brain-reindex"}]}}'
run_owner "$AI"
ai_stops_cleanly
expect_out_has "STOP: the gateway's ECS service was not found: cluster otchealth has no ACTIVE service named otchealth-gateway"
expect_out_has "none of the 1 service(s) in it is an ACTIVE one with the task definition family otchealth-gateway"
t_end

t_begin "aws-ai-access: an empty cluster: STOP before any write"
new_world '{"ecs":{"services":[]}}'
run_owner "$AI"
ai_stops_cleanly
expect_out_has "STOP: the gateway's ECS service was not found"
expect_out_has "none of the 0 service(s)"
t_end

t_begin "aws-ai-access: the only gateway service is INACTIVE: STOP before any write"
new_world '{"ecs":{"services":[{"name":"otchealth-gateway","status":"INACTIVE"}]}}'
run_owner "$AI"
ai_stops_cleanly
expect_out_has "STOP: the gateway's ECS service was not found"
t_end

t_begin "aws-ai-access: the only gateway service is DRAINING: STOP before any write"
new_world '{"ecs":{"services":[{"name":"otchealth-gateway","status":"DRAINING"}]}}'
run_owner "$AI"
ai_stops_cleanly
expect_out_has "STOP: the gateway's ECS service was not found"
t_end

t_begin "aws-ai-access: the ECS cluster is not there: STOP before any write"
new_world '{"ecs":{"cluster_exists":false}}'
run_owner "$AI"
ai_stops_cleanly
expect_out_has "STOP: the ECS cluster otchealth was not found in this account and region"
t_end

t_begin "aws-ai-access: ECS_SERVICE with odd characters: STOP before any write"
new_world '{}'
RUN_ENV=("ECS_SERVICE=bad name;rm")
run_owner "$AI"
ai_stops_cleanly
expect_out_has 'is not valid (ECS service names hold only letters, numbers, dashes and underscores)'
expect_calls_lack "ecs "
t_end

# ---- what the script did before this change still holds -------------------------------------------------------------------
t_begin "aws-ai-access: ECS cannot be read (access denied): part B fails, part A still goes ahead (unchanged behaviour)"
new_world '{"fail":{"ecs describe-services":"AccessDeniedException"}}'
run_owner "$AI"
expect_rc 1
expect_out_has "FAIL  B  the gateway's task role was not found, so the role was not created or changed (the ECS service could not be read"
expect_out_lacks "STOP: "
expect_out_has "CHECKS FAILED"
expect_calls_have "W iam create-user --user-name otchealth-ai-reader"
expect_calls_lack "iam create-role"
t_end

t_begin "aws-ai-access: signed in to another account: STOP before any write"
new_world '{"account":"111111111111"}'
run_owner "$AI"
ai_stops_cleanly
expect_out_has "STOP: you are signed in to account 111111111111, not 900915535335."
t_end

t_begin "aws-ai-access: run by the AI reader itself: STOP before any write"
new_world '{"caller_arn":"arn:aws:iam::900915535335:user/otchealth-ai-reader"}'
run_owner "$AI"
ai_stops_cleanly
expect_out_has "this script must be run by the account owner or an administrator, not by the AI reader itself"
t_end

t_begin "aws-ai-access: an existing role that holds an extra policy is left alone and part B fails (unchanged behaviour)"
new_world '{"iam":{"roles":{"otchealth-ai-reader-role":{"arn":"arn:aws:iam::900915535335:role/otchealth-ai-reader-role","max_session":3600,"trust":{}}},"attached":{"role:otchealth-ai-reader-role":["arn:aws:iam::aws:policy/AdministratorAccess"]}}}'
run_owner "$AI"
expect_rc 1
expect_out_has "FAIL  B  the role has 1 item(s) this script did not add, or that could not be read: managed policy arn:aws:iam::aws:policy/AdministratorAccess"
expect_out_has "TO REMOVE WHAT THIS SCRIPT DID NOT ADD"
expect_calls_lack "update-assume-role-policy"
expect_calls_lack "attach-role-policy"
expect_calls_lack "put-role-policy"
expect_calls_have "W iam create-user"
t_end

t_begin "aws-ai-access: an existing console sign-in is left alone (no new password)"
new_world '{"iam":{"users":{"otchealth-ai-reader":{"arn":"arn:aws:iam::900915535335:user/otchealth-ai-reader"}},"login":{"otchealth-ai-reader":true}}}'
run_owner "$AI"
expect_rc 0
expect_out_has "PASS  C  console sign-in already exists for otchealth-ai-reader"
expect_calls_lack "create-login-profile"
expect_no_file "$SANDBOX/home/otchealth-ai-reader-initial-password.txt"
t_end

t_begin "aws-ai-access: a second run changes nothing that is already right (no new policy, user, role or password)"
new_world '{}'
run_owner "$AI"
expect_rc 0
run_owner "$AI"
expect_rc 0
expect_out_has "RESULT: ALL CHECKS PASSED"
expect_out_has "Policy otchealth-ai-reader-deny is already up to date."
expect_out_has "Already attached to user otchealth-ai-reader"
expect_out_has "PASS  C  console sign-in already exists for otchealth-ai-reader"
expect_calls_lack "W iam create-"
expect_calls_lack "create-login-profile"
t_end

# ---- cost and billing: the read-only policy otchealth-ai-reader-billing (added 2026-10-09) -----------------------------------
# The pretend IAM simulator answers ce:, budgets:, billing: (and the other cost services) by applying the policies that are
# REALLY attached to the user or role in the pretend account (evaluate in fake-aws.py). So these scenarios fail when the policy
# is missing, is not attached, holds a write action, or when a Deny statement blocks one of its reads. policy-audit.py does the
# audits. Its manifest, billing-read-actions.tsv, lists every action with the access level AWS documents for it (Read or List).
# The blocks run in order: the first one builds the account that the next ones audit and copy.
BILLING_MANIFEST="$HERE/billing-read-actions.tsv"
AUDIT_MANIFEST=""    # audit_catches uses this manifest instead of the real one while it is set
BILLING_ARN_TEXT="arn:aws:iam::900915535335:policy/otchealth-ai-reader-billing"
BILLING_SNAP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/owner-tests.XXXXXX")" || { echo "test bug: could not make a temporary folder" >&2; exit 2; }
SANDBOXES+=("$BILLING_SNAP_DIR")

# Python that runs on the pretend account (the variable "world") when a scenario needs it changed. PY_PRELUDE always comes first.
PY_PRELUDE='
BILLING = "otchealth-ai-reader-billing"
DENY = "otchealth-ai-reader-deny"
USER = "user:otchealth-ai-reader"
ROLE = "role:otchealth-ai-reader-role"
BILLING_ARN = "arn:aws:iam::900915535335:policy/" + BILLING
def doc(name):
    return [v for v in world["iam"]["policies"][name]["versions"] if v["default"]][0]["doc"]
def billing_actions():
    return doc(BILLING)["Statement"][0]["Action"]
'
# What the PREVIOUS version of the script leaves behind: the same account, but it never created or attached the billing policy.
PY_PREVIOUS_VERSION='
world["iam"]["policies"].pop(BILLING)
for key in list(world["iam"]["attached"]):
    world["iam"]["attached"][key] = [a for a in world["iam"]["attached"][key] if a != BILLING_ARN]
'

# expect_out_line TEXT: the output has a line that is exactly TEXT (expect_out_has also matches inside a longer line)
expect_out_line() { if ! grep -Fxq -- "$1" "$OUT_FILE"; then t_note "the output has no line that is exactly: $1"; fi; }

# billing_audit GROUP [FLAGS]: policy-audit.py audits the policies that the last run saved in the pretend account
billing_audit() {
  local group="$1" out rc=0 last
  shift
  out="$(python3 -I -S "$HERE/policy-audit.py" "$FAKE_AWS_DIR/state.json" "$BILLING_MANIFEST" "$group" "$@" 2>&1)" || rc=$?
  last="$(printf '%s\n' "$out" | tail -n 1)"
  if [ "$rc" -ne 0 ]; then
    t_note "policy audit '$group' failed (exit $rc): $(printf '%s\n' "$out" | head -n 4 | tr '\n' ' ')"
  elif ! printf '%s\n' "$last" | grep -Eq "^AUDIT $group: [1-9][0-9]* checks, 0 failed$"; then
    t_note "policy audit '$group' printed no clean result line: $last"
  fi
}

# billing_audit_all: every audit group
billing_audit_all() {
  local group
  for group in attached manifest writes reads denies; do billing_audit "$group"; done
}

# audit_catches LABEL GROUP PYTHON WANTED_TEXT [FLAGS]: proves an audit is not blind. It damages a COPY of the pretend account
# with the python statements, and the audit must then fail (exit 1) and say WANTED_TEXT.
audit_catches() {
  local label="$1" group="$2" mutation="$3" wanted="$4" copy out rc=0
  shift 4
  copy="$BILLING_SNAP_DIR/damaged.json"
  if ! python3 -I -c '
import json, sys
world = json.load(open(sys.argv[1]))
exec(sys.argv[3] + "\n" + sys.argv[4], {"world": world})
json.dump(world, open(sys.argv[2], "w"))
' "$FAKE_AWS_DIR/state.json" "$copy" "$PY_PRELUDE" "$mutation" 2>"$BILLING_SNAP_DIR/damage.err"; then
    t_note "$label: the test could not damage its copy of the account: $(tail -n 2 "$BILLING_SNAP_DIR/damage.err" | tr '\n' ' ')"
    return 0
  fi
  out="$(python3 -I -S "$HERE/policy-audit.py" "$copy" "${AUDIT_MANIFEST:-$BILLING_MANIFEST}" "$group" "$@" 2>&1)" || rc=$?
  if [ "$rc" -ne 1 ]; then
    t_note "$label: the '$group' audit did not fail (exit $rc), so it would miss this"
  elif ! printf '%s\n' "$out" | grep -Fq -- "$wanted"; then
    t_note "$label: the '$group' audit failed, but its message lacks: $wanted"
  fi
  return 0
}

# world_from_snapshot SNAPSHOT [PYTHON]: a new sandbox whose pretend account is a copy of SNAPSHOT (a state.json that an earlier
# run left behind), changed by the optional python statements.
world_from_snapshot() {
  local snap="$1" change="${2:-pass}"
  new_world '{}'
  if [ ! -f "$snap" ]; then
    t_note "test setup: the account copy $snap is missing (the fresh run above left no pretend account)"
    return 1
  fi
  if ! python3 -I -c '
import json, sys
world = json.load(open(sys.argv[1]))
exec(sys.argv[3] + "\n" + sys.argv[4], {"world": world})
json.dump(world, open(sys.argv[2], "w"))
' "$snap" "$FAKE_AWS_DIR/state.json" "$PY_PRELUDE" "$change" 2>"$BILLING_SNAP_DIR/seed.err"; then
    t_note "test setup: the pretend account could not be prepared: $(tail -n 2 "$BILLING_SNAP_DIR/seed.err" | tr '\n' ' ')"
    return 1
  fi
  return 0
}

# expect_same_account SNAPSHOT: the pretend account holds the same IAM objects as the account in SNAPSHOT. The order of the
# policies attached to an identity does not matter (an upgrade attaches the new policy last, a fresh run attaches it third).
expect_same_account() {
  local differs
  if ! differs="$(python3 -I -c '
import json, sys
def iam_of(path):
    iam = json.load(open(path))["iam"]
    iam["attached"] = {key: sorted(value) for key, value in iam["attached"].items()}
    return iam
a, b = iam_of(sys.argv[1]), iam_of(sys.argv[2])
bad = [key for key in sorted(set(a) | set(b)) if a.get(key) != b.get(key)]
print(", ".join(bad))
sys.exit(1 if bad else 0)
' "$1" "$FAKE_AWS_DIR/state.json" 2>&1)"; then
    t_note "the pretend account is not the same as the account in $(basename "$1"); these parts differ: $differs"
  fi
}

# assert_upgrade_ran: the run just made was the first run of this version on an account that the previous version set up
assert_upgrade_ran() {
  expect_rc 0
  expect_out_has "RESULT: ALL CHECKS PASSED"
  expect_out_has "Policy otchealth-ai-reader-deny is already up to date."
  expect_out_has "Policy otchealth-ai-reader-extras is already up to date."
  expect_out_has "Policy otchealth-ai-reader-billing created."
  expect_out_has "Attached to user otchealth-ai-reader: otchealth-ai-reader-billing"
  expect_out_has "Attached to role otchealth-ai-reader-role: otchealth-ai-reader-billing"
  expect_out_has "Already attached to user otchealth-ai-reader: otchealth-ai-reader-deny"
  expect_out_has "Already attached to role otchealth-ai-reader-role: ViewOnlyAccess"
  expect_out_has "PASS  A  the user has only the expected policies (7 managed, plus the MFA policy)"
  expect_out_has "PASS  B  the role has only the 4 expected managed policies: no inline policy, no permissions boundary"
  expect_out_has "PASS  C  console sign-in already exists for otchealth-ai-reader"
  expect_out_line "Cost and billing: read only"
  expect_calls_count "W iam create-policy " 1
  expect_calls_have "W iam create-policy --policy-name otchealth-ai-reader-billing"
  expect_calls_count "W iam attach-user-policy" 1
  expect_calls_count "W iam attach-role-policy" 1
  expect_calls_lack "create-policy-version"
  expect_calls_lack "W iam create-user"
  expect_calls_lack "W iam create-role"
  expect_calls_lack "create-login-profile"
  expect_calls_lack "W iam delete-"
  expect_calls_lack "W iam detach-"
}

# ---- 1. a fresh run: the policy, who has it, and what the summary says -------------------------------------------------------
t_begin "aws-ai-access billing: a fresh run saves the cost and billing policy, attaches it to the user and the role, and prints 'Cost and billing: read only'"
new_world '{}'
run_owner "$AI"
cp "$FAKE_AWS_DIR/state.json" "$BILLING_SNAP_DIR/fresh.json" 2>/dev/null || t_note "the fresh run left no pretend account to copy"
expect_rc 0
expect_out_has "RESULT: ALL CHECKS PASSED"
expect_out_has "Policy otchealth-ai-reader-billing created."
expect_out_has "Attached to user otchealth-ai-reader: otchealth-ai-reader-billing"
expect_out_has "Attached to role otchealth-ai-reader-role: otchealth-ai-reader-billing"
expect_out_has "PASS  A  all 7 managed policies are attached to the user (4 AWS managed, extras, billing, deny)"
expect_out_has "PASS  B  the role has ViewOnlyAccess, the extras, the billing policy and the deny policy attached"
expect_out_has "PASS  A  can read cost anomalies (ce:GetAnomalies)"
expect_out_has "PASS  B  can read credits (billing:GetCredits)"
expect_out_has "PASS  A  cannot change budgets (budgets:ModifyBudget is not allowed)"
expect_out_has "PASS  B  cannot buy a Savings Plan (savingsplans:CreateSavingsPlan is not allowed)"
expect_out_line "Cost and billing: read only"
expect_out_has "It cannot change, buy, pay for or cancel anything."
expect_out_has "User otchealth-ai-reader: ON (policy otchealth-ai-reader-billing is attached)"
expect_out_has "Role otchealth-ai-reader-role: ON (policy otchealth-ai-reader-billing is attached)"
expect_out_has "Cost and billing: read only, on for the user and the role (details above)."
expect_out_has "aws iam detach-user-policy --user-name otchealth-ai-reader --policy-arn $BILLING_ARN_TEXT"
expect_out_has "aws iam detach-role-policy --role-name otchealth-ai-reader-role --policy-arn $BILLING_ARN_TEXT"
expect_calls_have "W iam create-policy --policy-name otchealth-ai-reader-billing"
expect_calls_have "W iam attach-user-policy --user-name otchealth-ai-reader --policy-arn $BILLING_ARN_TEXT"
expect_calls_have "W iam attach-role-policy --role-name otchealth-ai-reader-role --policy-arn $BILLING_ARN_TEXT"
expect_state_has iam attached "user:otchealth-ai-reader" "$BILLING_ARN_TEXT"
expect_state_has iam attached "role:otchealth-ai-reader-role" "$BILLING_ARN_TEXT"
t_end

t_begin "aws-ai-access billing: the billing policy and the deny policy are attached to both the user and the role"
billing_audit attached
t_end

t_begin "aws-ai-access billing: the saved billing policy is ONE Allow statement with exactly the actions in billing-read-actions.tsv (no wildcard, all Read or List)"
billing_audit manifest
t_end

t_begin "aws-ai-access billing: no Allow statement in any saved policy can match Create, Update, Delete, Modify, Put, Purchase, Accept or Cancel (one older grant is named)"
billing_audit writes
t_end

t_begin "aws-ai-access billing: every billing action is allowed for the user and the role (no Deny blocks one), and no write action of those services is"
billing_audit reads
t_end

t_begin "aws-ai-access billing: the explicit denies are all still there and still win (secrets, data, payments, shell, IAM credentials)"
billing_audit denies
t_end

t_begin "aws-ai-access billing: the audits are not blind (each kind of damage to a copy of the account is caught)"
audit_catches "a write action in the billing policy" writes \
  'billing_actions().append("budgets:ModifyBudget")' "Allow budgets:ModifyBudget can match the write verb Modify"
audit_catches "a write action in the billing policy" reads \
  'billing_actions().append("budgets:ModifyBudget")' "is allowed 1 write action(s): budgets:ModifyBudget"
audit_catches "a write action in the billing policy" manifest \
  'billing_actions().append("budgets:ModifyBudget")' "holds 1 action(s) that are not in the manifest: budgets:ModifyBudget"
audit_catches "a wildcard that spans every verb" writes \
  'billing_actions().append("ce:*")' "Allow ce:* can match the write verb"
audit_catches "a wildcard that starts with a write verb" writes \
  'billing_actions().append("ce:Create*")' "Allow ce:Create* can match the write verb Create"
audit_catches "a wildcard of any kind" manifest \
  'billing_actions().append("ce:Get*")' "uses a wildcard"
audit_catches "an action dropped from the billing policy" manifest \
  'billing_actions().remove("ce:GetTags")' "lacks 1 action(s) of the manifest: ce:GetTags"
audit_catches "an action dropped from the billing policy" reads \
  'billing_actions().remove("ce:GetTags")' "ce:GetTags (implicitDeny)"
audit_catches "a second statement in the billing policy" manifest \
  'doc(BILLING)["Statement"].append({"Sid": "More", "Effect": "Allow", "Action": "ce:GetTags", "Resource": "*"})' "has 2 statements, expected exactly 1"
audit_catches "the billing policy detached from the role" attached \
  'world["iam"]["attached"][ROLE].remove(BILLING_ARN)' "the role otchealth-ai-reader-role does not have policy otchealth-ai-reader-billing attached"
audit_catches "the billing policy detached from the user" reads \
  'world["iam"]["attached"][USER].remove(BILLING_ARN)' "the user cannot use"
audit_catches "a Deny that blocks one billing read" reads \
  'doc(DENY)["Statement"].append({"Sid": "NoTags", "Effect": "Deny", "Action": "ce:GetTags", "Resource": "*"})' "ce:GetTags (explicitDeny)"
audit_catches "the payments Deny removed" denies \
  's = doc(DENY)["Statement"]; s[:] = [x for x in s if x["Sid"] != "NoPaymentsOrPaymentMethods"]' "the deny policy lost statement(s): NoPaymentsOrPaymentMethods"
audit_catches "the secrets Deny turned into an Allow" denies \
  'doc(DENY)["Statement"][0]["Effect"] = "Allow"' "the deny policy holds a statement that is not a Deny"
audit_catches "a write action in an inline policy" writes \
  'world["iam"]["inline"].setdefault(USER, {})["sneaky"] = {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "s3:PutObject", "Resource": "*"}]}' \
  "Allow s3:PutObject can match the write verb Put"
audit_catches "an Allow with NotAction" writes \
  'doc(BILLING)["Statement"].append({"Effect": "Allow", "NotAction": "iam:*", "Resource": "*"})' "an Allow with NotAction can allow a write action"
# The manifest is not trusted either: a write action added to the policy AND to the manifest (marked Read) is still caught by the verbs.
{ cat "$BILLING_MANIFEST"; echo "budgets:ModifyBudget|Read|list_budgets.html"; } >"$BILLING_SNAP_DIR/manifest-smuggled.tsv"
AUDIT_MANIFEST="$BILLING_SNAP_DIR/manifest-smuggled.tsv"
audit_catches "a write action in the policy and in the manifest" writes \
  'billing_actions().append("budgets:ModifyBudget")' "Allow budgets:ModifyBudget can match the write verb Modify"
awk -F'|' 'BEGIN { OFS = "|" } !done && $2 == "Read" { $2 = "Write"; done = 1 } { print }' "$BILLING_MANIFEST" >"$BILLING_SNAP_DIR/manifest-write.tsv"
AUDIT_MANIFEST="$BILLING_SNAP_DIR/manifest-write.tsv"
audit_catches "a manifest row marked Write" manifest 'pass' "only Read or List is allowed"
awk -F'|' 'BEGIN { OFS = "|" } !done && $2 == "Read" { $3 = "notes.txt"; done = 1 } { print }' "$BILLING_MANIFEST" >"$BILLING_SNAP_DIR/manifest-nodoc.tsv"
AUDIT_MANIFEST="$BILLING_SNAP_DIR/manifest-nodoc.tsv"
audit_catches "a manifest row with no documentation page" manifest 'pass' "has no Service Authorization Reference page"
AUDIT_MANIFEST=""
t_end

# ---- 2. identities made by the PREVIOUS version of the script ----------------------------------------------------------------
# The previous version differs from this one in one thing: it never created or attached otchealth-ai-reader-billing. So its
# account is this version's fresh account without that policy (PY_PREVIOUS_VERSION). The decision, and why it is safe:
#  - a user or role that has nothing but the previous version's policies PASSES the "only what this script added" check, because
#    that check objects to extra items and never to a missing one. The billing policy is then created and attached, nothing else;
#  - the billing policy is in the expected set, so an account that already has it (a re-run) passes too;
#  - a role that holds anything else is still left completely alone, and now also gets no billing policy.
t_begin "aws-ai-access billing: a re-run on the identities the previous version made UPGRADES them (billing policy created and attached, nothing removed, same account as a fresh run)"
world_from_snapshot "$BILLING_SNAP_DIR/fresh.json" "$PY_PREVIOUS_VERSION"
cp "$FAKE_AWS_DIR/state.json" "$BILLING_SNAP_DIR/previous.json" 2>/dev/null || t_note "the pretend account could not be copied"
expect_state_lacks iam policies "otchealth-ai-reader-billing"
expect_state_lacks iam attached "user:otchealth-ai-reader" "$BILLING_ARN_TEXT"
expect_state_lacks iam attached "role:otchealth-ai-reader-role" "$BILLING_ARN_TEXT"
run_owner "$AI"
assert_upgrade_ran
expect_no_file "$SANDBOX/home/otchealth-ai-reader-initial-password.txt"
expect_same_account "$BILLING_SNAP_DIR/fresh.json"
billing_audit_all
t_end

t_begin "aws-ai-access billing: a second run after the upgrade changes nothing more (the billing policy is up to date and already attached)"
run_owner "$AI"
expect_rc 0
expect_out_has "RESULT: ALL CHECKS PASSED"
expect_out_has "Policy otchealth-ai-reader-billing is already up to date."
expect_out_has "Already attached to user otchealth-ai-reader: otchealth-ai-reader-billing"
expect_out_has "Already attached to role otchealth-ai-reader-role: otchealth-ai-reader-billing"
expect_calls_lack "W iam create-"
expect_calls_lack "W iam attach-"
expect_calls_lack "W iam delete-"
expect_calls_lack "W iam detach-"
expect_calls_lack "create-policy-version"
expect_calls_lack "create-login-profile"
expect_same_account "$BILLING_SNAP_DIR/fresh.json"
t_end

t_begin "aws-ai-access billing: an upgraded role that holds an extra policy is left alone: no billing policy, no trust rewrite, and the user is still upgraded"
world_from_snapshot "$BILLING_SNAP_DIR/previous.json" 'world["iam"]["attached"][ROLE].append("arn:aws:iam::aws:policy/AdministratorAccess")'
run_owner "$AI"
expect_rc 1
expect_out_has "FAIL  B  the role has 1 item(s) this script did not add, or that could not be read: managed policy arn:aws:iam::aws:policy/AdministratorAccess"
expect_out_has "This run changed nothing on the role and gave the gateway task role no permission to use it."
expect_out_has "User otchealth-ai-reader: ON (policy otchealth-ai-reader-billing is attached)"
expect_out_has "Role otchealth-ai-reader-role: OFF (the role was left exactly as it was)"
expect_calls_have "W iam attach-user-policy --user-name otchealth-ai-reader --policy-arn $BILLING_ARN_TEXT"
expect_calls_lack "attach-role-policy"
expect_calls_lack "update-assume-role-policy"
expect_calls_lack "put-role-policy"
expect_calls_lack "W iam detach-"
expect_calls_lack "W iam delete-"
expect_state_lacks iam attached "role:otchealth-ai-reader-role" "$BILLING_ARN_TEXT"
expect_state_has iam attached "role:otchealth-ai-reader-role" "arn:aws:iam::aws:policy/AdministratorAccess"
billing_audit manifest
billing_audit writes
billing_audit reads --no-role
t_end

t_begin "aws-ai-access billing: a user that holds an extra policy still FAILS, gets no console password, and the billing policy is never offered for removal"
new_world '{"iam":{"users":{"otchealth-ai-reader":{"arn":"arn:aws:iam::900915535335:user/otchealth-ai-reader"}},"attached":{"user:otchealth-ai-reader":["arn:aws:iam::aws:policy/AdministratorAccess"]}}}'
run_owner "$AI"
expect_rc 1
expect_out_has "FAIL  A  the user has 1 item(s) this script did not add, or that could not be read: managed policy arn:aws:iam::aws:policy/AdministratorAccess"
expect_out_has "no console password was created or changed: part A has a failed check"
expect_out_has "TO REMOVE WHAT THIS SCRIPT DID NOT ADD"
expect_calls_lack "create-login-profile"
expect_no_file "$SANDBOX/home/otchealth-ai-reader-initial-password.txt"
expect_calls_have "W iam attach-user-policy --user-name otchealth-ai-reader --policy-arn $BILLING_ARN_TEXT"
if [ "$(sed -n '/TO REMOVE WHAT THIS SCRIPT DID NOT ADD/,/^$/p' "$OUT_FILE" | grep -Fc 'otchealth-ai-reader-billing')" != "0" ]; then
  t_note "the list of items to remove names the billing policy, and it must name only what the script did not add"
fi
if ! sed -n '/TO REMOVE WHAT THIS SCRIPT DID NOT ADD/,/^$/p' "$OUT_FILE" | grep -Fq 'AdministratorAccess'; then
  t_note "the list of items to remove does not name the extra policy"
fi
t_end

t_begin "aws-ai-access billing: a billing policy that already has 5 saved versions is updated (the oldest version is deleted first) and attached where it is missing"
world_from_snapshot "$BILLING_SNAP_DIR/previous.json" '
old = {"Version": "2012-10-17", "Statement": [{"Sid": "CostAndBillingReadOnly", "Effect": "Allow", "Action": ["ce:GetTags"], "Resource": "*"}]}
world["iam"]["policies"][BILLING] = {"arn": BILLING_ARN, "next": 6, "versions": [{"id": "v%d" % i, "doc": old, "default": i == 5} for i in range(1, 6)]}
world["iam"]["attached"][USER].append(BILLING_ARN)
'
run_owner "$AI"
expect_rc 0
expect_out_has "RESULT: ALL CHECKS PASSED"
expect_out_has "Policy otchealth-ai-reader-billing changed: saved as the new default version."
expect_out_has "Already attached to user otchealth-ai-reader: otchealth-ai-reader-billing"
expect_out_has "Attached to role otchealth-ai-reader-role: otchealth-ai-reader-billing"
expect_calls_count "W iam delete-policy-version" 1
expect_calls_have "W iam delete-policy-version --policy-arn $BILLING_ARN_TEXT --version-id v1"
expect_calls_count "W iam create-policy-version" 1
expect_calls_lack "W iam create-policy "
billing_audit_all
t_end

t_begin "aws-ai-access billing: the billing policy cannot be saved: STOP, and the user and role are left exactly as the previous version left them"
world_from_snapshot "$BILLING_SNAP_DIR/previous.json" 'world["fail"]["iam create-policy"] = "AccessDenied"'
run_owner "$AI"
expect_rc 1
expect_out_has "STOP: the billing policy could not be saved"
expect_out_has "ROLLBACK"
expect_out_lacks "RESULT:"
expect_out_lacks "Cost and billing: read only"
expect_calls_lack "attach-user-policy"
expect_calls_lack "attach-role-policy"
expect_calls_lack "put-user-policy"
expect_calls_lack "put-role-policy"
expect_calls_lack "update-assume-role-policy"
expect_calls_lack "W iam create-user"
expect_calls_lack "W iam create-role"
expect_calls_lack "create-login-profile"
expect_same_account "$BILLING_SNAP_DIR/previous.json"
t_end

# ---- 3. the real previous version of the script, when a path to it is given ---------------------------------------------------
# Optional: OWNER_PREVIOUS_AI_SCRIPT=/path/to/the/previous/aws-ai-access-2026-10-07.sh bash setup/aws/tests/run-owner-script-tests.sh
if [ -n "$PREV_AI" ]; then
  t_begin "aws-ai-access billing: the REAL previous version of the script builds the account, and this version upgrades it to the same account a fresh run makes"
  new_world '{}'
  run_owner "$PREV_AI"
  expect_rc 0
  expect_out_has "RESULT: ALL CHECKS PASSED"
  expect_out_lacks "otchealth-ai-reader-billing"
  expect_state_lacks iam policies "otchealth-ai-reader-billing"
  run_owner "$AI"
  assert_upgrade_ran
  expect_same_account "$BILLING_SNAP_DIR/fresh.json"
  billing_audit_all
  t_end
else
  echo "skipped  OWNER_PREVIOUS_AI_SCRIPT is not set, so the scenario with the real previous version of the script was not run"
fi
