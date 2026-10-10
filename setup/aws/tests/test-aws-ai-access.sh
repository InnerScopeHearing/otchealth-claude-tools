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
