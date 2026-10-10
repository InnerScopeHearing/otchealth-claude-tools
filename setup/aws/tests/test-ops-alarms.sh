#!/usr/bin/env bash
# test-ops-alarms.sh: scenarios for setup/aws/ops-alarms-2026-10-07.sh, run against the pretend account.
# Sourced by run-owner-script-tests.sh (it supplies $ALARMS, the script under test, and the helpers in lib.sh).
# shellcheck shell=bash
# shellcheck disable=SC2154,SC2034  # ALARMS and the lib.sh helpers come from run-owner-script-tests.sh; RUN_ENV is read by run_owner in lib.sh

MAIL="you@example.com"
OTHER_FAMILY_ROW='{"ecs":{"services":[{"name":"n8n-worker","family":"otchealth-job-brain-reindex"}]}}'

# alarms_stops_cleanly: the script stopped on purpose (exit 1, a STOP line, the ROLLBACK block saying nothing was changed)
# and made no change in the account at all.
alarms_stops_cleanly() {
  expect_rc 1
  expect_out_has "STOP: "
  expect_out_has "ROLLBACK"
  expect_out_has "(nothing was changed)"
  expect_out_lacks "RESULT:"
  expect_no_writes
  expect_calls_lack "cloudformation deploy"
}

# alarms_gateway_stops: a gateway that cannot be pinned down is a FAIL line and a STOP. Nothing is written, and the
# brain alarms are not installed on their own.
alarms_gateway_stops() {
  alarms_stops_cleanly
  expect_out_has "  FAIL  "
  expect_out_has "STOP: the 3 gateway alarms cannot be set up, and this script does not install only the brain alarms unless you ask for that."
  expect_out_has "run the script again with --brain-only"
  expect_out_lacks "WARN  the gateway alarms are skipped"
  expect_calls_lack "cloudformation validate-template"
}

# ---- the gateway's ECS service is found ---------------------------------------------------------------------------------
t_begin "ops-alarms: the live service name (otchealth-gateway) resolves directly, and all 6 alarms are installed"
new_world '{}'
run_owner "$ALARMS" --email "$MAIL"
expect_rc 0
expect_out_has "RESULT: ALL CHECKS PASSED"
expect_out_has "Service used   : otchealth-gateway (the configured name, ACTIVE)"
expect_out_has "Installed: 6 alarm(s) and the email topic otchealth-ops-alerts"
expect_out_lacks "NOT INSTALLED"
expect_out_lacks "WARN  "
expect_calls_lack "ecs list-services"
expect_calls_have "W cloudformation deploy --stack-name otchealth-ops-alarms"
expect_calls_have "--parameter-overrides AlertEmail=$MAIL GatewayTargetGroup=targetgroup/otchealth-gateway-tg/0123456789abcdef GatewayLoadBalancer=app/otchealth-gateway/fedcba9876543210 BrainDomainName=otchealth-brain BrainClientId=900915535335 LowStoragePercent=20 LowStorageThresholdMb=20480"
expect_state_has cfn template "service otchealth-gateway:"
expect_state_lacks cfn template "service otchealth:"
expect_state_has cw alarms "otchealth-gateway-no-healthy-targets"
expect_state_has cw alarms "otchealth-gateway-target-5xx"
expect_state_has cw alarms "otchealth-gateway-elb-5xx"
expect_state_has cw alarms "otchealth-brain-cluster-red"
expect_state_has cw alarms "otchealth-brain-writes-blocked"
expect_state_has cw alarms "otchealth-brain-low-storage"
t_end

t_begin "ops-alarms: no ACTIVE service has the configured name, so the one with task definition family otchealth-gateway is used"
new_world '{"ecs":{"services":[{"name":"gw-blue"}]}}'
run_owner "$ALARMS" --email "$MAIL"
expect_rc 0
expect_out_has "There is no ACTIVE service named otchealth-gateway in cluster otchealth."
expect_out_has "Service used   : gw-blue (found by its task definition family; otchealth-gateway is not an ACTIVE service)"
expect_out_has "RESULT: ALL CHECKS PASSED"
expect_out_has "Installed: 6 alarm(s)"
expect_calls_have "ecs list-services"
expect_calls_have "--services gw-blue --query services[0].[status,desiredCount,runningCount,taskDefinition]"
expect_calls_have "--services gw-blue --query services[0].loadBalancers[].targetGroupArn"
expect_state_has cw alarms "otchealth-gateway-no-healthy-targets"
t_end

t_begin "ops-alarms: the old wrong name (a service called just otchealth) is found by its family too"
new_world '{"ecs":{"services":[{"name":"otchealth"}]}}'
run_owner "$ALARMS" --email "$MAIL"
expect_rc 0
expect_out_has "Service used   : otchealth (found by its task definition family"
expect_out_has "RESULT: ALL CHECKS PASSED"
t_end

t_begin "ops-alarms: ECS_SERVICE names a service that is not there, so the family decides"
new_world '{}'
RUN_ENV=("ECS_SERVICE=no-such-service")
run_owner "$ALARMS" --email "$MAIL"
expect_rc 0
expect_out_has "There is no ACTIVE service named no-such-service in cluster otchealth."
expect_out_has "Service used   : otchealth-gateway (found by its task definition family; no-such-service is not an ACTIVE service)"
expect_out_has "RESULT: ALL CHECKS PASSED"
t_end

t_begin "ops-alarms: ECS_SERVICE names an ACTIVE service, which is used as it is (no listing)"
new_world '{"ecs":{"services":[{"name":"otchealth-gateway"},{"name":"gw-custom"}]}}'
RUN_ENV=("ECS_SERVICE=gw-custom")
run_owner "$ALARMS" --email "$MAIL"
expect_rc 0
expect_out_has "Service used   : gw-custom (the configured name, ACTIVE)"
expect_calls_lack "ecs list-services"
expect_calls_have "--services gw-custom"
t_end

t_begin "ops-alarms: a second service with the same family does not matter when the configured name is ACTIVE"
new_world '{"ecs":{"services":[{"name":"otchealth-gateway"},{"name":"otchealth-gateway-canary"}]}}'
run_owner "$ALARMS" --email "$MAIL"
expect_rc 0
expect_out_has "Service used   : otchealth-gateway (the configured name, ACTIVE)"
expect_out_has "RESULT: ALL CHECKS PASSED"
expect_calls_lack "ecs list-services"
t_end

t_begin "ops-alarms: 12 services in the cluster are read in batches of 10 and the gateway is still found"
new_world "{\"ecs\":{\"services\":$(services_json 11 gw-moved)}}"
run_owner "$ALARMS" --email "$MAIL"
expect_rc 0
expect_out_has "Service used   : gw-moved (found by its task definition family"
expect_out_has "RESULT: ALL CHECKS PASSED"
expect_calls_count "[serviceName,taskDefinition]" 2
t_end

# ---- the gateway's ECS service is NOT found: FAIL and STOP, nothing written, no brain-only install by itself --------------
t_begin "ops-alarms: two ACTIVE services with the gateway family and none with the configured name: FAIL and STOP before any write"
new_world '{"ecs":{"services":[{"name":"gw-blue"},{"name":"gw-green"}]}}'
run_owner "$ALARMS" --email "$MAIL"
alarms_gateway_stops
expect_out_has "FAIL  more than one ACTIVE service in cluster otchealth has the task definition family otchealth-gateway (gw-blue gw-green)"
expect_out_has "the script will not guess which one is the gateway"
expect_state_lacks cw alarms "otchealth-brain-cluster-red"
t_end

t_begin "ops-alarms: no service has the gateway family (e: no --brain-only): FAIL and STOP before any write"
new_world "$OTHER_FAMILY_ROW"
run_owner "$ALARMS" --email "$MAIL"
alarms_gateway_stops
expect_out_has "FAIL  the gateway's ECS service was not found: cluster otchealth has no ACTIVE service named otchealth-gateway"
expect_out_has "none of the 1 service(s) in it is an ACTIVE one with the task definition family otchealth-gateway"
expect_state_lacks cw alarms "otchealth-brain-cluster-red"
expect_state_lacks cfn template "Resources"
t_end

t_begin "ops-alarms: an empty cluster: FAIL and STOP before any write"
new_world '{"ecs":{"services":[]}}'
run_owner "$ALARMS" --email "$MAIL"
alarms_gateway_stops
expect_out_has "none of the 0 service(s)"
t_end

t_begin "ops-alarms: the only gateway service is INACTIVE: FAIL and STOP before any write"
new_world '{"ecs":{"services":[{"name":"otchealth-gateway","status":"INACTIVE"}]}}'
run_owner "$ALARMS" --email "$MAIL"
alarms_gateway_stops
expect_out_has "the gateway's ECS service was not found"
t_end

t_begin "ops-alarms: the only gateway service is DRAINING: FAIL and STOP before any write"
new_world '{"ecs":{"services":[{"name":"otchealth-gateway","status":"DRAINING"}]}}'
run_owner "$ALARMS" --email "$MAIL"
alarms_gateway_stops
expect_out_has "the gateway's ECS service was not found"
t_end

t_begin "ops-alarms: the ECS cluster is not there: FAIL and STOP before any write"
new_world '{"ecs":{"cluster_exists":false}}'
run_owner "$ALARMS" --email "$MAIL"
alarms_gateway_stops
expect_out_has "FAIL  the gateway's ECS service was not found: the ECS cluster otchealth does not exist in this account and region."
t_end

t_begin "ops-alarms: ECS_SERVICE with odd characters: STOP before any ECS call"
new_world '{}'
RUN_ENV=("ECS_SERVICE=bad name;rm")
run_owner "$ALARMS" --email "$MAIL"
alarms_stops_cleanly
expect_out_has 'is not valid (ECS service names hold only letters, numbers, dashes and underscores)'
expect_calls_lack "R ecs "
t_end

t_begin "ops-alarms: ECS cannot be read (access denied): STOP before any write, with the AWS message shown"
new_world '{"fail":{"ecs describe-services":"AccessDeniedException"}}'
run_owner "$ALARMS" --email "$MAIL"
alarms_stops_cleanly
expect_out_has "AccessDeniedException"
expect_out_has "STOP: could not read the ECS service (message above)."
t_end

t_begin "ops-alarms: the services of the cluster cannot be listed (access denied): STOP before any write"
new_world '{"ecs":{"services":[{"name":"gw-blue"}]},"fail":{"ecs list-services":"AccessDeniedException"}}'
run_owner "$ALARMS" --email "$MAIL"
alarms_stops_cleanly
expect_out_has "STOP: could not list the services in cluster otchealth (message above)."
t_end

# ---- --brain-only ------------------------------------------------------------------------------------------------------------
t_begin "ops-alarms: the same account with --brain-only (e): only the 3 brain alarms are installed, and the gateway is not looked for"
new_world "$OTHER_FAMILY_ROW"
run_owner "$ALARMS" --email "$MAIL" --brain-only
expect_rc 0
expect_out_has "Gateway: not looked for, because --brain-only was given."
expect_out_has "RESULT: ALL CHECKS PASSED"
expect_out_has "Installed: 3 alarm(s) and the email topic otchealth-ops-alerts"
expect_out_has "WARN  the gateway alarms are skipped because you asked for --brain-only"
expect_out_has "NOT INSTALLED: the 3 gateway alarms"
expect_out_has "aws cloudwatch set-alarm-state --alarm-name otchealth-brain-cluster-red"
expect_calls_lack "R ecs "
expect_calls_lack "elbv2"
expect_calls_have "--parameter-overrides AlertEmail=$MAIL GatewayTargetGroup= GatewayLoadBalancer= BrainDomainName=otchealth-brain BrainClientId=900915535335 LowStoragePercent=20 LowStorageThresholdMb=20480"
expect_state_has cw alarms "otchealth-brain-cluster-red"
expect_state_has cw alarms "otchealth-brain-writes-blocked"
expect_state_has cw alarms "otchealth-brain-low-storage"
expect_state_lacks cw alarms "otchealth-gateway-no-healthy-targets"
expect_state_lacks cw alarms "otchealth-gateway-target-5xx"
expect_state_lacks cw alarms "otchealth-gateway-elb-5xx"
t_end

t_begin "ops-alarms: --brain-only given before --email works the same, and a healthy gateway is still not looked for"
new_world '{}'
run_owner "$ALARMS" --brain-only --email "$MAIL"
expect_rc 0
expect_out_has "Gateway: not looked for, because --brain-only was given."
expect_out_has "Installed: 3 alarm(s)"
expect_calls_lack "R ecs "
expect_calls_lack "elbv2"
expect_state_lacks cw alarms "otchealth-gateway-no-healthy-targets"
t_end

t_begin "ops-alarms: --brain-only does not read ECS, so an ECS that cannot be read does not matter"
new_world '{"fail":{"ecs describe-services":"AccessDeniedException","ecs list-services":"AccessDeniedException"}}'
run_owner "$ALARMS" --email "$MAIL" --brain-only
expect_rc 0
expect_out_has "Installed: 3 alarm(s)"
expect_calls_lack "R ecs "
t_end

t_begin "ops-alarms: --brain-only after a full install would leave 3 installed alarms out: STOP, nothing removed"
new_world '{}'
run_owner "$ALARMS" --email "$MAIL"
expect_rc 0
run_owner "$ALARMS" --email "$MAIL" --brain-only
alarms_stops_cleanly
expect_out_has "These alarms were installed by an earlier run, and --brain-only would leave them out:"
expect_out_has "    - otchealth-gateway-no-healthy-targets"
expect_out_has "    - otchealth-gateway-target-5xx"
expect_out_has "    - otchealth-gateway-elb-5xx"
expect_out_has "the script will not remove existing alarms by itself"
expect_state_has cw alarms "otchealth-gateway-no-healthy-targets"
t_end

t_begin "ops-alarms: --brain-only and no brain: STOP, nothing to watch"
new_world '{"os":{"exists":false}}'
run_owner "$ALARMS" --email "$MAIL" --brain-only
alarms_stops_cleanly
expect_out_has "STOP: --brain-only was given and the script could not find the brain, so there is nothing to watch."
t_end

# ---- the command line --------------------------------------------------------------------------------------------------------
t_begin "ops-alarms: --help lists --brain-only and makes no aws call"
new_world '{}'
run_owner "$ALARMS" --help
expect_rc 0
expect_out_has "--email ADDRESS"
expect_out_has "--brain-only      install only the 3 brain alarms and do not look for the gateway"
expect_no_calls
t_end

t_begin "ops-alarms: an unknown option is a STOP that names --brain-only, with no aws call"
new_world '{}'
run_owner "$ALARMS" --email "$MAIL" --bogus
expect_rc 1
expect_out_has 'STOP: unknown option "--bogus". The options are --email you@example.com and, only if the CTO says so, --brain-only.'
expect_no_calls
t_end

t_begin "ops-alarms: no --email is a STOP, with no aws call"
new_world '{}'
run_owner "$ALARMS" --brain-only
expect_rc 1
expect_out_has "STOP: the --email option is missing, so nothing was changed."
expect_no_calls
t_end

t_begin "ops-alarms: ALERT_EMAIL in the environment is never used"
new_world '{}'
RUN_ENV=("ALERT_EMAIL=someone@example.com")
run_owner "$ALARMS"
expect_rc 1
expect_out_has "STOP: the --email option is missing"
expect_no_calls
t_end

# ---- what the script did before this change still holds ---------------------------------------------------------------------
t_begin "ops-alarms: the ECS service has no load balancer: WARN-skip of the gateway group, brain alarms installed (unchanged behaviour)"
new_world '{"ecs":{"services":[{"name":"otchealth-gateway","lb":false}]}}'
run_owner "$ALARMS" --email "$MAIL"
expect_rc 0
expect_out_has "Service used   : otchealth-gateway (the configured name, ACTIVE)"
expect_out_has "WARN  the gateway alarms are skipped because the ECS service has no load balancer target group attached"
expect_out_has "NOT INSTALLED: the 3 gateway alarms"
expect_out_has "Installed: 3 alarm(s)"
t_end

t_begin "ops-alarms: the target group is on no load balancer: WARN-skip of the gateway group (unchanged behaviour)"
new_world '{"elb":{"target_group_attached":false}}'
run_owner "$ALARMS" --email "$MAIL"
expect_rc 0
expect_out_has "WARN  the gateway alarms are skipped because target group otchealth-gateway-tg is not attached to any load balancer"
expect_out_has "Installed: 3 alarm(s)"
t_end

t_begin "ops-alarms: CloudWatch has no gateway data yet: WARN-skip of the gateway group (unchanged behaviour)"
new_world '{"cw":{"gateway_data":false}}'
run_owner "$ALARMS" --email "$MAIL"
expect_rc 0
expect_out_has "WARN  the gateway alarms are skipped because CloudWatch shows no HealthyHostCount data for target group otchealth-gateway-tg"
expect_out_has "Installed: 3 alarm(s)"
t_end

t_begin "ops-alarms: the brain is not there: WARN-skip of the brain group, gateway alarms installed (unchanged behaviour)"
new_world '{"os":{"exists":false}}'
run_owner "$ALARMS" --email "$MAIL"
expect_rc 0
expect_out_has "WARN  the brain alarms are skipped because the OpenSearch domain otchealth-brain was not found"
expect_out_has "NOT INSTALLED: the 3 brain alarms"
expect_out_has "Installed: 3 alarm(s)"
expect_state_has cw alarms "otchealth-gateway-no-healthy-targets"
expect_state_lacks cw alarms "otchealth-brain-cluster-red"
t_end

t_begin "ops-alarms: neither the gateway wiring nor the brain can be found: STOP before any write (unchanged behaviour)"
new_world '{"ecs":{"services":[{"name":"otchealth-gateway","lb":false}]},"os":{"exists":false}}'
run_owner "$ALARMS" --email "$MAIL"
alarms_stops_cleanly
expect_out_has "STOP: the script could not find the gateway or the brain, so there is nothing to watch."
t_end

t_begin "ops-alarms: no gateway server is healthy right now: a WARN, and the alarms are still installed (unchanged behaviour)"
new_world '{"elb":{"healthy":0,"total":2}}'
run_owner "$ALARMS" --email "$MAIL"
expect_rc 0
expect_out_has "WARN  no gateway server is healthy right now."
expect_out_has "Installed: 6 alarm(s)"
t_end

t_begin "ops-alarms: a second run changes nothing that is already right"
new_world '{}'
run_owner "$ALARMS" --email "$MAIL"
expect_rc 0
run_owner "$ALARMS" --email "$MAIL"
expect_rc 0
expect_out_has "Stack otchealth-ops-alarms: already installed (CREATE_COMPLETE)."
expect_out_has "Nothing to change: the stack already matches what the script found."
expect_out_has "RESULT: ALL CHECKS PASSED"
expect_calls_lack "ecs list-services"
t_end

t_begin "ops-alarms: an existing alarm that has one of the stack's names, but is not part of the stack, is never overwritten"
new_world '{"cw":{"alarms":{"otchealth-brain-cluster-red":{"ns":"AWS/ES","metric":"ClusterStatus.red","threshold":1.0,"state":"OK","actions":[],"ok":[]}}}}'
run_owner "$ALARMS" --email "$MAIL"
alarms_stops_cleanly
expect_out_has "These alarm names are already in use by something that is NOT part of stack otchealth-ops-alarms:"
expect_out_has "    - otchealth-brain-cluster-red"
expect_out_has "installing would overwrite them"
t_end

t_begin "ops-alarms: signed in to another account: STOP before any write"
new_world '{"account":"111111111111"}'
run_owner "$ALARMS" --email "$MAIL"
alarms_stops_cleanly
expect_out_has "STOP: you are signed in to account 111111111111, not 900915535335."
expect_calls_lack "R ecs "
t_end
