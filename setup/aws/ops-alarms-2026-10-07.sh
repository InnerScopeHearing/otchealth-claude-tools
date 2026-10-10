#!/usr/bin/env bash
# =============================================================================================
# ops-alarms-2026-10-07.sh  -  OTCHealth gateway and brain alarms (CTO, 2026-10-07)
#
# WHAT IT DOES (nothing that exists today is changed or deleted; one new stack is added):
#   Creates the CloudFormation stack  otchealth-ops-alarms  in us-east-1. It holds:
#     - an email topic  otchealth-ops-alerts  (emails the address you give with --email; the address
#       confirms once from the first mail)
#     - up to 6 CloudWatch alarms. Each one emails when it goes off and again when it clears:
#         otchealth-gateway-no-healthy-targets   no load balancer node sees a healthy gateway server for 3 minutes
#         otchealth-gateway-target-5xx           the gateway app returns errors (20 or more per 5 min, twice)
#         otchealth-gateway-elb-5xx              the load balancer returns errors (10 or more per 5 min, twice)
#         otchealth-brain-cluster-red            the brain (OpenSearch) reports RED, or goes silent
#         otchealth-brain-writes-blocked         the brain refuses new writes
#         otchealth-brain-low-storage            a brain data server has under 20 percent of its disk free
#   The script finds the gateway load balancer and the brain disk size on its own (nothing is
#   hard-coded). If it cannot find one of the two, or CloudWatch has no data for it yet, it says so
#   (WARN) and installs only the other group.
#   It never removes alarms an earlier run installed: if something it used to watch cannot be found
#   now, it stops and asks you to tell the CTO.
#   NOT touched on purpose: the AWS Budget, the ECS service, the load balancer, the OpenSearch
#   domain, n8n, and every other alarm and topic.
#
# HOW TO RUN: download this file and run it with bash (do not paste its body into the shell):
#       bash ops-alarms-2026-10-07.sh --email you@example.com
#   --email is required: it is the address that receives the alarm emails. There is no default
#   (no address is stored in this file) and no environment variable is read.
# SAFE TO RE-RUN: it looks everything up again; the stack changes only if something is different.
#   It does not repair an alarm that someone deleted or edited by hand: for that, delete the stack
#   (the ROLLBACK line) and run the script again.
# RUN IN:  AWS CloudShell, region us-east-1, signed in as the account owner or an administrator.
# UNDO:    the script prints one ROLLBACK line (it deletes the stack and what is inside it).
# SECRETS: none in this file, none printed.
# =============================================================================================
if [ -z "${BASH_VERSION:-}" ] || [ "${BASH_VERSION%%.*}" -lt 4 ]; then
  echo "This script needs bash 4 or newer. In AWS CloudShell run it with:  bash ops-alarms-2026-10-07.sh --email you@example.com"
  exit 1
fi
set -euo pipefail
SHELL_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
export AWS_PAGER=""
export AWS_REGION="us-east-1"
export AWS_DEFAULT_REGION="us-east-1"

EXPECTED_ACCOUNT="900915535335"
REGION="us-east-1"
STACK="otchealth-ops-alarms"
TOPIC_NAME="otchealth-ops-alerts"
ALERT_EMAIL="" # set from --email below; never from the environment, never defaulted
BRAIN_ONLY="no" # set to yes only by the --brain-only option

ECS_CLUSTER="otchealth"
# The gateway's ECS service: the name infra/aws/ecs-gateway.tf (otchealth-mcp-server) gives it. The environment may
# set ECS_SERVICE to use another one. If no ACTIVE service has the name, the service is found by its task
# definition family instead (see resolve_gateway_service below).
ECS_SERVICE="${ECS_SERVICE:-otchealth-gateway}"
EXPECTED_TASK_FAMILY="otchealth-gateway"
DOMAIN="otchealth-brain"
LOW_STORAGE_PERCENT=20

A_NOHEALTHY="otchealth-gateway-no-healthy-targets"
A_TARGET5XX="otchealth-gateway-target-5xx"
A_ELB5XX="otchealth-gateway-elb-5xx"
A_RED="otchealth-brain-cluster-red"
A_WRITES="otchealth-brain-writes-blocked"
A_STORAGE="otchealth-brain-low-storage"

WORK_DIR="$(mktemp -d)"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

PASSED=0
FAILED=0
WARNED=0
ROLLBACKS=()
NOTES=()
OUT=""
ERRTXT=""

section() { printf '\n==== %s ====\n' "$1"; }
pass() { printf '  PASS  %s\n' "$1"; PASSED=$((PASSED + 1)); }
fail() { printf '  FAIL  %s\n' "$1"; FAILED=$((FAILED + 1)); }
warn() { printf '  WARN  %s\n' "$1"; WARNED=$((WARNED + 1)); }

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
  echo "STOPPED: a step failed (see the message above). Steps before it may already be done (see ROLLBACK)."
  echo "Copy everything on this screen and send it to the CTO. Do not change anything in AWS yourself; wait for the CTO's answer."
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

# try_aws ARGS...: runs aws, keeps stdout in OUT and the error text in ERRTXT, returns aws's exit code.
try_aws() {
  local rc=0
  OUT="$(aws "$@" 2>"$WORK_DIR/err.txt")" || rc=$?
  ERRTXT="$(cat "$WORK_DIR/err.txt" 2>/dev/null || true)"
  return "$rc"
}

show_err() { printf '%s\n' "$ERRTXT" | sed -n '1,3p' | sed 's/^/        /'; }

in_list() {
  local needle="$1" x
  shift
  for x in "$@"; do
    if [ "$x" = "$needle" ]; then return 0; fi
  done
  return 1
}

STACK_STATUS=""
refresh_stack_status() {
  if try_aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text; then
    STACK_STATUS="$OUT"
  elif [[ "$ERRTXT" == *"does not exist"* ]]; then
    STACK_STATUS="NONE"
  else
    show_err
    return 1
  fi
}

# ---------------------------------------------------------------------------------------------
# The one required option is --email ADDRESS: who receives the alarm emails. It has no default and
# is never read from the environment. The only other option is --brain-only (see the top of this file).
# Everything here runs before the first AWS call.
usage() {
  echo "Usage:  bash ops-alarms-2026-10-07.sh --email you@example.com"
  echo "  --email ADDRESS   the address that receives the alarm emails (required, no default)"
  echo "  --brain-only      install only the 3 brain alarms and do not look for the gateway (only if the CTO says so)"
  echo "  --help            show this text"
}
EMAIL_GIVEN="no"
while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help)
      usage
      exit 0 ;;
    --brain-only)
      BRAIN_ONLY="yes"
      shift ;;
    --email|--email=*)
      if [ "$EMAIL_GIVEN" = "yes" ]; then
        stop "--email was given more than once. Nothing was changed. Run the script again with it once."
      fi
      EMAIL_GIVEN="yes"
      if [ "$1" = "--email" ]; then
        if [ "$#" -lt 2 ]; then
          stop "--email must be followed by the address, like this:  --email you@example.com   Nothing was changed."
        fi
        ALERT_EMAIL="$2"
        shift 2
      else
        ALERT_EMAIL="${1#--email=}"
        shift
      fi ;;
    *)
      stop "unknown option \"$1\". The only option is --email you@example.com   Nothing was changed." ;;
  esac
done
if [ -z "$ALERT_EMAIL" ]; then
  stop "the --email option is missing, so nothing was changed. Run the script again with the address that should get the alarm emails:  bash ops-alarms-2026-10-07.sh --email you@example.com"
fi
if ! [[ "$ALERT_EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || [ "${#ALERT_EMAIL}" -gt 254 ]; then
  stop "the address \"$ALERT_EMAIL\" does not look like an email address (it should look like you@example.com). Nothing was changed."
fi

# ---------------------------------------------------------------------------------------------
section "0. Who is running this"
if ! command -v aws >/dev/null 2>&1; then
  stop "the aws command was not found. Open AWS CloudShell (the >_ icon at the top of the console)."
fi
if ! try_aws sts get-caller-identity --query '[Account,Arn]' --output text; then
  show_err
  stop "could not sign in to AWS (message above). Open AWS CloudShell from the AWS console and run this again. Nothing was changed."
fi
read -r ACCOUNT CALLER_ARN <<<"$OUT"
echo "Signed in as: $CALLER_ARN"
echo "Account     : $ACCOUNT"
if [ "$ACCOUNT" != "$EXPECTED_ACCOUNT" ]; then
  stop "you are signed in to account $ACCOUNT, not $EXPECTED_ACCOUNT. Nothing was changed. Sign in to the OTCHealth account and run this again."
fi
echo "OK: account $ACCOUNT is the OTCHealth account."
echo "OK: this script works only in region $REGION (N. Virginia) and always uses it."
if [ -n "$SHELL_REGION" ] && [ "$SHELL_REGION" != "$REGION" ]; then
  echo "NOTE: CloudShell was opened in region $SHELL_REGION. That is fine for this script. When you look at the"
  echo "      alarms in the AWS console afterwards, switch the region picker (top right) to N. Virginia."
fi
TOPIC_ARN="arn:aws:sns:${REGION}:${ACCOUNT}:${TOPIC_NAME}"
echo "Alarm emails will go to: $ALERT_EMAIL"
echo "  Check that this is the right address. If it is not, run the script again with the right one."

# ---------------------------------------------------------------------------------------------
section "1. What the script found (read only)"
GATEWAY_ON="no"
GATEWAY_WHY=""
BRAIN_ON="no"
BRAIN_WHY=""
STORAGE_ON="no"
STORAGE_WHY=""
TG_DIM=""
LB_DIM=""
THRESHOLD_MB=0

discover_gateway() {
  local status desired running taskdef family tg_arn tg_name lb_arn lb_name lb_type lb_state lb_scheme
  local s total healthy
  local tgs=() states=()
  echo "Gateway (ECS service $ECS_SERVICE in cluster $ECS_CLUSTER):"
  if ! try_aws ecs describe-services --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE" \
      --query 'services[0].[status,desiredCount,runningCount,taskDefinition]' --output text; then
    if [[ "$ERRTXT" == *ClusterNotFoundException* ]]; then
      GATEWAY_WHY="the ECS cluster $ECS_CLUSTER was not found"
      return 0
    fi
    show_err
    stop "could not read the ECS service (message above). Nothing was changed. Copy this screen and send it to the CTO."
  fi
  read -r status desired running taskdef <<<"$OUT"
  if [ -z "$status" ] || [ "$status" = "None" ]; then
    GATEWAY_WHY="the ECS service $ECS_SERVICE was not found in cluster $ECS_CLUSTER"
    return 0
  fi
  family="${taskdef##*/}"
  echo "  Service        : $status, $running running of $desired wanted"
  echo "  Task definition: $family"
  if [ "$status" != "ACTIVE" ]; then
    GATEWAY_WHY="the ECS service $ECS_SERVICE is $status, not ACTIVE"
    return 0
  fi
  if [ "${family%%:*}" != "$EXPECTED_TASK_FAMILY" ]; then
    echo "  NOTE  the task family is not the expected $EXPECTED_TASK_FAMILY. The alarms follow the load balancer, so this does not stop anything."
  fi
  if ! try_aws ecs describe-services --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE" \
      --query 'services[0].loadBalancers[].targetGroupArn' --output text; then
    show_err
    stop "could not read the ECS service load balancers (message above). Nothing was changed."
  fi
  read -ra tgs <<<"$OUT"
  if [ "${#tgs[@]}" -eq 0 ] || [ "${tgs[0]}" = "None" ]; then
    GATEWAY_WHY="the ECS service has no load balancer target group attached"
    return 0
  fi
  tg_arn="${tgs[0]}"
  if [ "${#tgs[@]}" -gt 1 ]; then
    echo "  NOTE  the service has ${#tgs[@]} target groups. The alarms use the first one."
  fi
  if ! try_aws elbv2 describe-target-groups --target-group-arns "$tg_arn" \
      --query 'TargetGroups[0].[TargetGroupName,LoadBalancerArns[0]]' --output text; then
    if [[ "$ERRTXT" == *TargetGroupNotFound* ]]; then
      GATEWAY_WHY="the target group of the ECS service was not found"
      return 0
    fi
    show_err
    stop "could not read the target group (message above). Nothing was changed."
  fi
  read -r tg_name lb_arn <<<"$OUT"
  if [ -z "$lb_arn" ] || [ "$lb_arn" = "None" ]; then
    GATEWAY_WHY="target group $tg_name is not attached to any load balancer"
    return 0
  fi
  if ! try_aws elbv2 describe-load-balancers --load-balancer-arns "$lb_arn" \
      --query 'LoadBalancers[0].[LoadBalancerName,Type,State.Code,Scheme]' --output text; then
    if [[ "$ERRTXT" == *LoadBalancerNotFound* ]]; then
      GATEWAY_WHY="the load balancer of target group $tg_name was not found"
      return 0
    fi
    show_err
    stop "could not read the load balancer (message above). Nothing was changed."
  fi
  read -r lb_name lb_type lb_state lb_scheme <<<"$OUT"
  echo "  Load balancer  : $lb_name ($lb_type, $lb_state, $lb_scheme)"
  echo "  Target group   : $tg_name"
  if [ "$lb_type" != "application" ]; then
    GATEWAY_WHY="load balancer $lb_name is of type $lb_type, and these alarms are for Application Load Balancers"
    return 0
  fi
  # CloudWatch dimension values are the tail of each ARN (the ALB metrics page spells the format out).
  TG_DIM="$(printf '%s' "$tg_arn" | cut -d: -f6)"
  LB_DIM="$(printf '%s' "$lb_arn" | cut -d: -f6)"
  LB_DIM="${LB_DIM#loadbalancer/}"
  if ! [[ "$TG_DIM" =~ ^targetgroup/[A-Za-z0-9-]+/[0-9a-f]+$ ]] || ! [[ "$LB_DIM" =~ ^app/[A-Za-z0-9-]+/[0-9a-f]+$ ]]; then
    TG_DIM=""
    LB_DIM=""
    GATEWAY_WHY="the load balancer or target group name did not have the expected shape"
    return 0
  fi
  echo "  CloudWatch name: $TG_DIM  and  $LB_DIM"
  # The 'no healthy targets' alarm treats silence as bad news. If CloudWatch has no HealthyHostCount data for
  # this target group at all (new service, no servers registered yet, or a wrong name), that alarm would go
  # off straight after the install for no real reason, so the whole gateway group is skipped instead.
  if try_aws cloudwatch list-metrics --namespace AWS/ApplicationELB --metric-name HealthyHostCount \
      --dimensions "Name=TargetGroup,Value=$TG_DIM" "Name=LoadBalancer,Value=$LB_DIM" \
      --query 'length(Metrics)' --output text; then
    if [ "$OUT" = "0" ]; then
      TG_DIM=""
      LB_DIM=""
      GATEWAY_WHY="CloudWatch shows no HealthyHostCount data for target group $tg_name (an alarm on a metric that is not there would go off at once, or sit in the wrong state and hide a real problem)"
      return 0
    fi
  else
    echo "  (could not check that CloudWatch has data for the gateway; carrying on)"
  fi
  if try_aws elbv2 describe-target-health --target-group-arn "$tg_arn" \
      --query 'TargetHealthDescriptions[].TargetHealth.State' --output text; then
    read -ra states <<<"$OUT"
    total="${#states[@]}"
    healthy=0
    if [ "$total" -gt 0 ]; then
      for s in "${states[@]}"; do
        if [ "$s" = "healthy" ]; then healthy=$((healthy + 1)); fi
      done
    fi
    echo "  Right now      : $healthy of $total gateway servers are healthy"
    if [ "$healthy" -eq 0 ]; then
      warn "no gateway server is healthy right now. The 'no healthy targets' alarm will go off about 3 minutes after this finishes, because it is true. Tell the CTO."
    fi
  else
    echo "  (could not read the current server health; carrying on)"
  fi
  GATEWAY_ON="yes"
}

discover_brain() {
  local engine deleted processing ebs vol vtype itype icount
  echo "Brain (OpenSearch domain $DOMAIN):"
  if ! try_aws opensearch describe-domain --domain-name "$DOMAIN" \
      --query 'DomainStatus.[EngineVersion,Deleted,Processing,EBSOptions.EBSEnabled,EBSOptions.VolumeSize,EBSOptions.VolumeType,ClusterConfig.InstanceType,ClusterConfig.InstanceCount]' \
      --output text; then
    if [[ "$ERRTXT" == *ResourceNotFoundException* ]]; then
      BRAIN_WHY="the OpenSearch domain $DOMAIN was not found"
      return 0
    fi
    show_err
    stop "could not read the OpenSearch domain (message above). Nothing was changed. Copy this screen and send it to the CTO."
  fi
  read -r engine deleted processing ebs vol vtype itype icount <<<"$OUT"
  if [ "${deleted,,}" = "true" ]; then
    BRAIN_WHY="the OpenSearch domain $DOMAIN is being deleted"
    return 0
  fi
  echo "  Engine         : $engine"
  echo "  Data servers   : $icount x $itype"
  if [ "${processing,,}" = "true" ]; then
    echo "  NOTE  the domain is applying a change right now. Its numbers can have short gaps; that is normal."
  fi
  if try_aws cloudwatch list-metrics --namespace AWS/ES --metric-name ClusterStatus.red \
      --dimensions "Name=DomainName,Value=$DOMAIN" "Name=ClientId,Value=$ACCOUNT" \
      --query 'length(Metrics)' --output text; then
    if [ "$OUT" = "0" ]; then
      BRAIN_WHY="CloudWatch shows no ClusterStatus.red data for domain $DOMAIN (an alarm on a metric that is not there would sit in the wrong state and could hide a real problem)"
      return 0
    fi
  else
    echo "  (could not check that CloudWatch has data for the brain; carrying on)"
  fi
  BRAIN_ON="yes"
  if [ "${ebs,,}" = "true" ] && [[ "$vol" =~ ^[0-9]+$ ]] && [ "$vol" -gt 0 ]; then
    THRESHOLD_MB=$((vol * 1024 * LOW_STORAGE_PERCENT / 100))
    STORAGE_ON="yes"
    echo "  Disk           : $vol GiB per data server ($vtype)"
    echo "  Disk alarm     : goes off when the fullest data server has under $LOW_STORAGE_PERCENT percent free ($THRESHOLD_MB MB)"
  else
    STORAGE_WHY="the domain does not report an EBS disk size (it may use local instance storage)"
  fi
}

discover_gateway
echo ""
discover_brain
echo ""
echo "Coverage:"
SKIPPED=()
if [ "$GATEWAY_ON" = "yes" ]; then
  echo "  Gateway alarms (3): will be installed"
else
  echo "  Gateway alarms (3): SKIPPED"
  SKIPPED+=("the 3 gateway alarms")
  warn "the gateway alarms are skipped because ${GATEWAY_WHY:-the gateway could not be found}. Tell the CTO."
fi
if [ "$BRAIN_ON" = "yes" ]; then
  if [ "$STORAGE_ON" = "yes" ]; then
    echo "  Brain alarms   (3): will be installed"
  else
    echo "  Brain alarms   (2 of 3): will be installed; the low-disk alarm is SKIPPED"
    SKIPPED+=("the brain low-disk alarm")
    warn "the low-disk alarm is skipped because $STORAGE_WHY. Tell the CTO."
  fi
else
  echo "  Brain alarms   (3): SKIPPED"
  SKIPPED+=("the 3 brain alarms")
  warn "the brain alarms are skipped because ${BRAIN_WHY:-the brain could not be found}. Tell the CTO."
fi
if [ "$GATEWAY_ON" != "yes" ] && [ "$BRAIN_ON" != "yes" ]; then
  stop "the script could not find the gateway or the brain, so there is nothing to watch. Nothing was changed. Copy this screen and send it to the CTO."
fi

WANT=()
if [ "$GATEWAY_ON" = "yes" ]; then WANT+=("$A_NOHEALTHY" "$A_TARGET5XX" "$A_ELB5XX"); fi
if [ "$BRAIN_ON" = "yes" ]; then WANT+=("$A_RED" "$A_WRITES"); fi
if [ "$STORAGE_ON" = "yes" ]; then WANT+=("$A_STORAGE"); fi
ALL_ALARMS=("$A_NOHEALTHY" "$A_TARGET5XX" "$A_ELB5XX" "$A_RED" "$A_WRITES" "$A_STORAGE")

# ---------------------------------------------------------------------------------------------
section "2. Safety checks before anything is created (read only)"
refresh_stack_status || stop "could not read the state of stack $STACK (message above). Nothing was changed."
LEFTOVER_SHELL="no"
case "$STACK_STATUS" in
  NONE)
    echo "  Stack $STACK: not there yet (this is a first install)." ;;
  CREATE_COMPLETE|UPDATE_COMPLETE|UPDATE_ROLLBACK_COMPLETE|IMPORT_COMPLETE)
    echo "  Stack $STACK: already installed ($STACK_STATUS). It is updated only if something is different." ;;
  ROLLBACK_COMPLETE)
    LEFTOVER_SHELL="yes"
    echo "  Stack $STACK: left over from an earlier try that failed (ROLLBACK_COMPLETE)."
    echo "  It cannot be reused. It will be removed (it should hold nothing) just before the new try." ;;
  REVIEW_IN_PROGRESS)
    echo "  Stack $STACK: an earlier try stopped before it created anything (REVIEW_IN_PROGRESS). The new try reuses it." ;;
  *_IN_PROGRESS)
    stop "stack $STACK is busy right now ($STACK_STATUS). Wait 5 minutes and run this again. Nothing was changed." ;;
  *)
    stop "stack $STACK is in the state $STACK_STATUS, which this script does not touch. Nothing was changed. Copy this screen and send it to the CTO." ;;
esac

OWNED=" "
if [ "$STACK_STATUS" != "NONE" ] && [ "$LEFTOVER_SHELL" = "no" ]; then
  if try_aws cloudformation list-stack-resources --stack-name "$STACK" \
      --query "StackResourceSummaries[?ResourceStatus!='DELETE_COMPLETE'].PhysicalResourceId" --output text; then
    OWNED=" ${OUT//$'\t'/ } "
  else
    show_err
    stop "could not list what stack $STACK holds (message above). Nothing was changed."
  fi
fi

# Never remove monitoring that an earlier run installed.
REMOVE=()
for a in "${ALL_ALARMS[@]}"; do
  if [[ "$OWNED" == *" $a "* ]] && ! in_list "$a" "${WANT[@]}"; then REMOVE+=("$a"); fi
done
if [ "${#REMOVE[@]}" -gt 0 ]; then
  echo "  These alarms were installed by an earlier run, but the script cannot find what they watch now:"
  for a in "${REMOVE[@]}"; do echo "    - $a"; done
  stop "the script will not remove existing alarms by itself. Nothing was changed. Copy this screen and send it to the CTO."
fi

# A same-named alarm that is not part of the stack would be overwritten. Never do that.
CLASH=()
if ! try_aws cloudwatch describe-alarms --alarm-names "${WANT[@]}" --alarm-types CompositeAlarm MetricAlarm \
    --query '[MetricAlarms[].AlarmName, CompositeAlarms[].AlarmName][]' --output text; then
  show_err
  stop "could not look up existing alarms (message above). Nothing was changed."
fi
read -ra EXISTING <<<"$OUT"
if [ "${#EXISTING[@]}" -gt 0 ]; then
  for a in "${EXISTING[@]}"; do
    if in_list "$a" "${WANT[@]}" && [[ "$OWNED" != *" $a "* ]]; then CLASH+=("$a"); fi
  done
fi
if [ "${#CLASH[@]}" -gt 0 ]; then
  echo "  These alarm names are already in use by something that is NOT part of stack $STACK:"
  for a in "${CLASH[@]}"; do echo "    - $a"; done
  stop "installing would overwrite them, and this script never overwrites or deletes other alarms. Nothing was changed. Send this screen to the CTO, who will rename or remove them. Then run this again."
fi
echo "  Alarm names: none of the ${#WANT[@]} names is in use by anything outside the stack."

# Same for the topic. Its address is fixed, so one direct look-up is enough (no long list to page through).
TOPIC_EXISTS="no"
if try_aws sns get-topic-attributes --topic-arn "$TOPIC_ARN" --query 'Attributes.TopicArn' --output text; then
  TOPIC_EXISTS="yes"
elif [[ "$ERRTXT" != *NotFound* ]]; then
  show_err
  stop "could not look up the email topic (message above). Nothing was changed."
fi
if [ "$TOPIC_EXISTS" = "yes" ]; then
  if [[ "$OWNED" == *" $TOPIC_ARN "* ]]; then
    echo "  Email topic $TOPIC_NAME: exists and belongs to the stack."
  else
    stop "an email topic named $TOPIC_NAME already exists but is NOT part of stack $STACK. The script will not take it over or create a second one. Nothing was changed. Send this screen to the CTO."
  fi
else
  echo "  Email topic $TOPIC_NAME: does not exist yet."
fi

# Other alarms that already watch the same things (information only; never touched).
OTHERS=0
others_on_metric() {
  local ns="$1" metric="$2" n s
  shift 2
  if try_aws cloudwatch describe-alarms-for-metric --namespace "$ns" --metric-name "$metric" --dimensions "$@" \
      --query 'MetricAlarms[].[AlarmName,StateValue]' --output text; then
    while IFS=$'\t' read -r n s; do
      if [ -n "$n" ] && [[ "$OWNED" != *" $n "* ]]; then
        printf '  NOTE  an existing alarm "%s" (%s) already watches %s\n' "$n" "$s" "$metric"
        OTHERS=$((OTHERS + 1))
      fi
    done <<<"$OUT"
  fi
}
if [ "$GATEWAY_ON" = "yes" ]; then
  others_on_metric AWS/ApplicationELB HealthyHostCount "Name=TargetGroup,Value=$TG_DIM" "Name=LoadBalancer,Value=$LB_DIM"
  others_on_metric AWS/ApplicationELB HTTPCode_Target_5XX_Count "Name=TargetGroup,Value=$TG_DIM" "Name=LoadBalancer,Value=$LB_DIM"
  others_on_metric AWS/ApplicationELB HTTPCode_ELB_5XX_Count "Name=LoadBalancer,Value=$LB_DIM"
fi
if [ "$BRAIN_ON" = "yes" ]; then
  others_on_metric AWS/ES ClusterStatus.red "Name=DomainName,Value=$DOMAIN" "Name=ClientId,Value=$ACCOUNT"
  others_on_metric AWS/ES ClusterIndexWritesBlocked "Name=DomainName,Value=$DOMAIN" "Name=ClientId,Value=$ACCOUNT"
  if [ "$STORAGE_ON" = "yes" ]; then
    others_on_metric AWS/ES FreeStorageSpace "Name=DomainName,Value=$DOMAIN" "Name=ClientId,Value=$ACCOUNT"
  fi
fi
if [ "$OTHERS" -gt 0 ]; then
  warn "$OTHERS existing alarm(s) already watch the same things. They are not touched. You may get two emails for one problem."
else
  echo "  Other alarms on the same things: none."
fi

# ---------------------------------------------------------------------------------------------
section "3. The CloudFormation template"
TEMPLATE_FILE="$WORK_DIR/otchealth-ops-alarms.yaml"
cat > "$TEMPLATE_FILE" <<'CFN_TEMPLATE_EOF'
AWSTemplateFormatVersion: '2010-09-09'

Description: >-
  OTCHealth operations alarms (2026-10-07): one email topic and CloudWatch alarms for the
  gateway (ECS service behind an Application Load Balancer) and for the brain (OpenSearch
  domain). Each alarm group is skipped when its parameters are empty. Deleting this stack
  removes everything it created and nothing else.

# Sources used for metric names, namespaces, dimensions and statistics:
#   ALB metrics:        https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-cloudwatch-metrics.html
#   OpenSearch metrics: https://docs.aws.amazon.com/opensearch-service/latest/developerguide/managedomains-cloudwatchmetrics.html
#   OpenSearch alarms:  https://docs.aws.amazon.com/opensearch-service/latest/developerguide/cloudwatch-alarms.html
#   Missing data:       https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/alarms-and-missing-data.html
# The SNS topic is not encrypted with KMS on purpose: alarm emails contain metric names and
# numbers only, and it keeps delivery simple. It uses the standard same-account topic policy.

Parameters:
  AlertEmail:
    Type: String
    AllowedPattern: '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'
    ConstraintDescription: Must be a normal email address.
    Description: Address that receives the alarm emails (required, no default). It must be confirmed once from the first email.
  GatewayTargetGroup:
    Type: String
    Default: ''
    AllowedPattern: '^(targetgroup/[A-Za-z0-9-]+/[0-9a-f]+)?$'
    ConstraintDescription: Must look like targetgroup/NAME/ID, or be empty.
    Description: CloudWatch TargetGroup dimension of the gateway (targetgroup/NAME/ID). Empty skips the gateway alarms.
  GatewayLoadBalancer:
    Type: String
    Default: ''
    AllowedPattern: '^(app/[A-Za-z0-9-]+/[0-9a-f]+)?$'
    ConstraintDescription: Must look like app/NAME/ID, or be empty.
    Description: CloudWatch LoadBalancer dimension of the gateway Application Load Balancer (app/NAME/ID). Empty skips the gateway alarms.
  BrainDomainName:
    Type: String
    Default: ''
    AllowedPattern: '^([a-z][a-z0-9-]{2,27})?$'
    ConstraintDescription: Must be an OpenSearch domain name, or be empty.
    Description: OpenSearch domain name (CloudWatch DomainName dimension). Empty skips the brain alarms.
  BrainClientId:
    Type: String
    Default: ''
    AllowedPattern: '^([0-9]{12})?$'
    ConstraintDescription: Must be a 12 digit AWS account id, or be empty.
    Description: AWS account id that owns the domain (CloudWatch ClientId dimension).
  LowStoragePercent:
    Type: Number
    Default: 20
    MinValue: 1
    MaxValue: 90
    Description: Used only in the low-storage alarm text. The real limit is LowStorageThresholdMb.
  LowStorageThresholdMb:
    Type: Number
    Default: 0
    MinValue: 0
    Description: Low-storage alarm level in MB (CloudWatch reports FreeStorageSpace in MB). 0 skips that one alarm.

Conditions:
  HasGateway: !And
    - !Not [!Equals [!Ref GatewayTargetGroup, '']]
    - !Not [!Equals [!Ref GatewayLoadBalancer, '']]
  HasBrain: !And
    - !Not [!Equals [!Ref BrainDomainName, '']]
    - !Not [!Equals [!Ref BrainClientId, '']]
  HasStorageLimit: !And
    - !Not [!Equals [!Ref BrainDomainName, '']]
    - !Not [!Equals [!Ref BrainClientId, '']]
    - !Not [!Equals [!Ref LowStorageThresholdMb, '0']]

Resources:
  AlertTopic:
    Type: AWS::SNS::Topic
    Properties:
      TopicName: otchealth-ops-alerts
      DisplayName: OTCHealth alerts
      Subscription:
        - Protocol: email
          Endpoint: !Ref AlertEmail

  # ---------------------------------------------------------------------------------------
  # GATEWAY ALARMS
  # ---------------------------------------------------------------------------------------

  # HealthyHostCount is reported every minute while targets are registered, so silence is itself
  # bad news: missing data counts as breaching (AWS gives this exact reasoning for a metric that
  # continually reports). The statistic is Maximum across the load balancer nodes: the alarm goes off
  # only when NO node sees a healthy target, which is a true outage. Minimum would also go off when
  # a single node loses sight of the targets while the others still serve traffic.
  GatewayNoHealthyTargetsAlarm:
    Type: AWS::CloudWatch::Alarm
    Condition: HasGateway
    Properties:
      AlarmName: otchealth-gateway-no-healthy-targets
      AlarmDescription: |-
        WHAT HAPPENED: The OTCHealth gateway has had no healthy servers for 3 minutes in a row (not one load balancer node can see a healthy gateway server), or CloudWatch has stopped getting health reports for it. While this lasts, the AI team may be unable to reach its tools or the company brain.
        WHAT TO DO: Forward this email to the CTO right away and write "gateway down". You do not need to log in to AWS or restart anything yourself.
        FOR THE CTO: AWS console, ECS, cluster otchealth, service otchealth: check the tasks and why they stopped, then the target group health checks.
      Namespace: AWS/ApplicationELB
      MetricName: HealthyHostCount
      Dimensions:
        - Name: TargetGroup
          Value: !Ref GatewayTargetGroup
        - Name: LoadBalancer
          Value: !Ref GatewayLoadBalancer
      Statistic: Maximum
      Period: 60
      EvaluationPeriods: 3
      DatapointsToAlarm: 3
      Threshold: 1
      ComparisonOperator: LessThanThreshold
      TreatMissingData: breaching
      AlarmActions:
        - !Ref AlertTopic
      OKActions:
        - !Ref AlertTopic

  # The load balancer 5XX count is reported only when it is nonzero (the target 5XX count only while targets
  # are registered), so a gap can only mean no errors: notBreaching, which is what AWS advises for a metric
  # that appears only when errors happen.
  GatewayTarget5xxAlarm:
    Type: AWS::CloudWatch::Alarm
    Condition: HasGateway
    Properties:
      AlarmName: otchealth-gateway-target-5xx
      AlarmDescription: |-
        WHAT HAPPENED: The gateway application itself is returning errors (HTTP 5xx). There were 20 or more in each of the last two 5-minute windows. The servers are up, but something inside the gateway is failing.
        WHAT TO DO: Forward this email to the CTO and write "gateway errors". It is not an emergency until the CTO says so. You do not need to do anything in AWS.
        FOR THE CTO: look at the gateway task logs for the failing route, and at recent deploys.
      Namespace: AWS/ApplicationELB
      MetricName: HTTPCode_Target_5XX_Count
      Dimensions:
        - Name: TargetGroup
          Value: !Ref GatewayTargetGroup
        - Name: LoadBalancer
          Value: !Ref GatewayLoadBalancer
      Statistic: Sum
      Period: 300
      EvaluationPeriods: 2
      DatapointsToAlarm: 2
      Threshold: 20
      ComparisonOperator: GreaterThanOrEqualToThreshold
      TreatMissingData: notBreaching
      AlarmActions:
        - !Ref AlertTopic
      OKActions:
        - !Ref AlertTopic

  GatewayElb5xxAlarm:
    Type: AWS::CloudWatch::Alarm
    Condition: HasGateway
    Properties:
      AlarmName: otchealth-gateway-elb-5xx
      AlarmDescription: |-
        WHAT HAPPENED: The load balancer in front of the gateway is returning HTTP 5xx errors on its own account. There were 10 or more in each of the last two 5-minute windows. This usually means the gateway servers are overloaded, restarting, or too slow to answer.
        WHAT TO DO: Forward this email to the CTO and write "load balancer errors". You do not need to do anything in AWS.
        FOR THE CTO: check task restarts, CPU and memory, and target response time.
      Namespace: AWS/ApplicationELB
      MetricName: HTTPCode_ELB_5XX_Count
      Dimensions:
        - Name: LoadBalancer
          Value: !Ref GatewayLoadBalancer
      Statistic: Sum
      Period: 300
      EvaluationPeriods: 2
      DatapointsToAlarm: 2
      Threshold: 10
      ComparisonOperator: GreaterThanOrEqualToThreshold
      TreatMissingData: notBreaching
      AlarmActions:
        - !Ref AlertTopic
      OKActions:
        - !Ref AlertTopic

  # ---------------------------------------------------------------------------------------
  # BRAIN ALARMS (OpenSearch, namespace AWS/ES, dimensions DomainName and ClientId)
  # ---------------------------------------------------------------------------------------

  # ClusterStatus.red is reported continually (0 when fine, 1 when red). Missing data is treated as
  # breaching because a brain that goes silent is worse than a brain that says red, and this is the
  # one brain alarm that has to catch it (the other two keep their last state through a gap, so one
  # outage is one email, not three). A 5 minute period means a single lost minute cannot trip it,
  # and CloudWatch looks back over earlier real data before it applies the missing-data rule.
  BrainClusterRedAlarm:
    Type: AWS::CloudWatch::Alarm
    Condition: HasBrain
    Properties:
      AlarmName: otchealth-brain-cluster-red
      AlarmDescription: |-
        WHAT HAPPENED: The company brain (the OpenSearch search database named otchealth-brain) reports RED, which means some of its data is not available, or it has stopped reporting its health for a while. Memory lookups and searches may fail or come back incomplete.
        WHAT TO DO: Forward this email to the CTO right away and write "brain red". Do not delete or change anything in AWS yourself.
        FOR THE CTO: check cluster health and shard allocation, free disk, and the domain events.
      Namespace: AWS/ES
      MetricName: ClusterStatus.red
      Dimensions:
        - Name: DomainName
          Value: !Ref BrainDomainName
        - Name: ClientId
          Value: !Ref BrainClientId
      Statistic: Maximum
      Period: 300
      EvaluationPeriods: 1
      DatapointsToAlarm: 1
      Threshold: 1
      ComparisonOperator: GreaterThanOrEqualToThreshold
      TreatMissingData: breaching
      AlarmActions:
        - !Ref AlertTopic
      OKActions:
        - !Ref AlertTopic

  # ignore keeps the last known state through a data gap: no false all-clear email while writes are
  # still blocked, and no false alarm from a gap. A silent brain is already caught by the red alarm.
  BrainWritesBlockedAlarm:
    Type: AWS::CloudWatch::Alarm
    Condition: HasBrain
    Properties:
      AlarmName: otchealth-brain-writes-blocked
      AlarmDescription: |-
        WHAT HAPPENED: The company brain (otchealth-brain) is refusing new writes. The usual cause is a nearly full disk or too much memory pressure. Reading may still work, but new memories and documents will not be saved.
        WHAT TO DO: Forward this email to the CTO and write "brain writes blocked". Do not delete anything yourself.
        FOR THE CTO: check free storage and JVM memory pressure, then free space or resize the volume.
      Namespace: AWS/ES
      MetricName: ClusterIndexWritesBlocked
      Dimensions:
        - Name: DomainName
          Value: !Ref BrainDomainName
        - Name: ClientId
          Value: !Ref BrainClientId
      Statistic: Maximum
      Period: 300
      EvaluationPeriods: 1
      DatapointsToAlarm: 1
      Threshold: 1
      ComparisonOperator: GreaterThanOrEqualToThreshold
      TreatMissingData: ignore
      AlarmActions:
        - !Ref AlertTopic
      OKActions:
        - !Ref AlertTopic

  # FreeStorageSpace is in MB (the CloudWatch console shows MiB), for the data node with the least
  # free space when Minimum is used. The limit comes from the real disk size, found by the script.
  # ignore for the same reason as above.
  BrainLowStorageAlarm:
    Type: AWS::CloudWatch::Alarm
    Condition: HasStorageLimit
    Properties:
      AlarmName: otchealth-brain-low-storage
      AlarmDescription: !Sub |-
        WHAT HAPPENED: At least one data server of the company brain (otchealth-brain) has had less than ${LowStoragePercent} percent of its disk free (under ${LowStorageThresholdMb} MB) for 10 minutes. If the disk fills up, the brain stops accepting new data.
        WHAT TO DO: Forward this email to the CTO and write "brain disk low". It is not an emergency today, but it needs a decision within a few days: add disk space or clear old data.
        FOR THE CTO: check FreeStorageSpace per node, index sizes, and resize the EBS volume.
      Namespace: AWS/ES
      MetricName: FreeStorageSpace
      Dimensions:
        - Name: DomainName
          Value: !Ref BrainDomainName
        - Name: ClientId
          Value: !Ref BrainClientId
      Statistic: Minimum
      Period: 300
      EvaluationPeriods: 2
      DatapointsToAlarm: 2
      Threshold: !Ref LowStorageThresholdMb
      ComparisonOperator: LessThanThreshold
      TreatMissingData: ignore
      AlarmActions:
        - !Ref AlertTopic
      OKActions:
        - !Ref AlertTopic

Outputs:
  AlertTopicArn:
    Description: The SNS topic that emails the alarms.
    Value: !Ref AlertTopic
CFN_TEMPLATE_EOF
if try_aws cloudformation validate-template --template-body "file://$TEMPLATE_FILE" \
    --query 'Parameters[].ParameterKey' --output text; then
  if [ -n "$OUT" ] && [ "$OUT" != "None" ]; then
    pass "CloudFormation accepts the template (parameters: ${OUT//$'\t'/, })"
  else
    pass "CloudFormation accepts the template"
  fi
else
  show_err
  stop "CloudFormation rejected the template (message above). Nothing was changed. Copy this screen and send it to the CTO."
fi

P_TG=""
P_LB=""
P_DOMAIN=""
P_CLIENT=""
P_THRESHOLD="0"
if [ "$GATEWAY_ON" = "yes" ]; then
  P_TG="$TG_DIM"
  P_LB="$LB_DIM"
fi
if [ "$BRAIN_ON" = "yes" ]; then
  P_DOMAIN="$DOMAIN"
  P_CLIENT="$ACCOUNT"
  if [ "$STORAGE_ON" = "yes" ]; then P_THRESHOLD="$THRESHOLD_MB"; fi
fi
PARAMS=(
  "AlertEmail=$ALERT_EMAIL"
  "GatewayTargetGroup=$P_TG"
  "GatewayLoadBalancer=$P_LB"
  "BrainDomainName=$P_DOMAIN"
  "BrainClientId=$P_CLIENT"
  "LowStoragePercent=$LOW_STORAGE_PERCENT"
  "LowStorageThresholdMb=$P_THRESHOLD"
)

# ---------------------------------------------------------------------------------------------
section "4. Installing (stack $STACK)"
if [ "$LEFTOVER_SHELL" = "yes" ]; then
  # A failed first install leaves a stack in ROLLBACK_COMPLETE. CloudFormation usually keeps the resource that
  # failed in that list as CREATE_FAILED, and can mark one it never created as DELETE_SKIPPED. Neither is a real
  # resource (rollback finished, so everything that was created is already gone). Only a resource in any other
  # state makes the script keep the stack and stop.
  if ! try_aws cloudformation list-stack-resources --stack-name "$STACK" \
      --query "StackResourceSummaries[?ResourceStatus!='DELETE_COMPLETE' && ResourceStatus!='CREATE_FAILED' && ResourceStatus!='DELETE_SKIPPED'].[LogicalResourceId,ResourceStatus]" --output text; then
    show_err
    stop "could not check the leftover stack (message above). Nothing was changed."
  fi
  if [ -n "$OUT" ] && [ "$OUT" != "None" ]; then
    REAL_LEFT=""
    while IFS=$'\t' read -r left_id left_status; do
      REAL_LEFT+="${REAL_LEFT:+, }$left_id ($left_status)"
    done <<<"$OUT"
    stop "the leftover stack still lists resources that may be real ($REAL_LEFT), so the script will not delete it. Nothing was changed. Send this screen to the CTO."
  fi
  echo "  Removing the empty leftover stack from the failed earlier try..."
  if ! try_aws cloudformation delete-stack --stack-name "$STACK"; then
    show_err
    stop "could not remove the leftover stack (message above). Send this screen to the CTO."
  fi
  if ! try_aws cloudformation wait stack-delete-complete --stack-name "$STACK"; then
    show_err
    stop "the leftover stack did not finish deleting (message above). Wait 5 minutes and run this again, or send this screen to the CTO."
  fi
  echo "  Done."
fi
echo "  Working. This usually takes 1 to 2 minutes."
DEPLOY_RC=0
NO_CHANGES="no"
DEPLOY_OUT="$(aws cloudformation deploy --stack-name "$STACK" --template-file "$TEMPLATE_FILE" \
  --parameter-overrides "${PARAMS[@]}" --no-fail-on-empty-changeset 2>&1)" || DEPLOY_RC=$?
printf '%s\n' "$DEPLOY_OUT" | sed -e '/^[[:space:]]*$/d' -e 's/^/    /'
refresh_stack_status || STACK_STATUS="UNKNOWN"
if [ "$STACK_STATUS" != "NONE" ]; then
  ROLLBACKS+=("aws cloudformation delete-stack --stack-name $STACK --region $REGION")
  NOTES+=("that one line removes the stack and everything this script put in it (the email topic, the email subscription and the alarms), and nothing else.")
fi
if [ "$DEPLOY_RC" -ne 0 ]; then
  fail "the install did not finish (stack status: $STACK_STATUS)"
  echo "  What CloudFormation reported (newest first):"
  if try_aws cloudformation describe-stack-events --stack-name "$STACK" \
      --query "StackEvents[?contains(ResourceStatus, 'FAILED')].[LogicalResourceId,ResourceStatus,ResourceStatusReason]" --output text; then
    if [ -n "$OUT" ] && [ "$OUT" != "None" ]; then
      printf '%s\n' "$OUT" | sed -n '1,8p' | while IFS=$'\t' read -r ev_id ev_status ev_reason; do
        printf '    %s  |  %s  |  %s\n' "$ev_id" "$ev_status" "$ev_reason"
      done
    else
      echo "    (no failed events were listed)"
    fi
  else
    echo "    (could not read the stack events)"
  fi
  case "$STACK_STATUS" in
    ROLLBACK_COMPLETE)
      echo "  CloudFormation undid everything it had started, so no alarm was installed. The failed try leaves an"
      echo "  empty stack behind; running this script again removes it and tries again." ;;
    UPDATE_ROLLBACK_COMPLETE)
      echo "  CloudFormation undid the change, so what was installed before is exactly as it was."
      echo "  Running this script again tries again." ;;
    NONE)
      echo "  The install did not start, so nothing was changed." ;;
    *)
      echo "  The stack is in the state $STACK_STATUS. Do not change anything in AWS yourself." ;;
  esac
  echo "  Copy this whole screen and send it to the CTO."
elif [[ "$DEPLOY_OUT" == *"No changes to deploy"* ]]; then
  NO_CHANGES="yes"
  echo "  Nothing to change: the stack already matches what the script found."
fi

# ---------------------------------------------------------------------------------------------
SUB_STATE="unknown"
if [ "$DEPLOY_RC" -eq 0 ]; then
  section "5. Checking the result"
  case "$STACK_STATUS" in
    CREATE_COMPLETE|UPDATE_COMPLETE) pass "stack $STACK is $STACK_STATUS" ;;
    UPDATE_ROLLBACK_COMPLETE|IMPORT_COMPLETE)
      # Healthy, but only when this run found nothing to change (an earlier change that was undone left it here).
      if [ "$NO_CHANGES" = "yes" ]; then
        pass "stack $STACK is $STACK_STATUS and already matches what the script found"
      else
        fail "stack $STACK is $STACK_STATUS after this run (expected CREATE_COMPLETE or UPDATE_COMPLETE)"
      fi ;;
    *) fail "stack $STACK is $STACK_STATUS (expected CREATE_COMPLETE or UPDATE_COMPLETE)" ;;
  esac

  check_alarm() {
    local name="$1" ns="$2" metric="$3" what="$4" a_name="" a_state="" a_ns="" a_metric="" a_thr="" a_act="" a_ok="" tries=1
    while true; do
      if ! try_aws cloudwatch describe-alarms --alarm-names "$name" \
          --query 'MetricAlarms[0].[AlarmName,StateValue,Namespace,MetricName,Threshold,AlarmActions[0],OKActions[0]]' --output text; then
        fail "$name   (could not read it back from CloudWatch)"
        show_err
        return 0
      fi
      read -r a_name a_state a_ns a_metric a_thr a_act a_ok <<<"$OUT"
      if [ "$a_name" = "$name" ] || [ "$tries" -ge 4 ]; then break; fi
      tries=$((tries + 1))
      sleep 5 # a brand new alarm can take a few seconds to show up
    done
    if [ "$a_name" != "$name" ]; then
      fail "$name   (CloudWatch does not list it)"
      return 0
    fi
    if [ "$a_ns" != "$ns" ] || [ "$a_metric" != "$metric" ]; then
      fail "$name   (it watches $a_ns $a_metric, expected $ns $metric)"
      return 0
    fi
    if [ "$a_act" != "$TOPIC_ARN" ] || [ "$a_ok" != "$TOPIC_ARN" ]; then
      fail "$name   (it does not email $TOPIC_NAME both when it goes off and when it clears)"
      return 0
    fi
    if [ "$name" = "$A_STORAGE" ] && ! awk -v a="$a_thr" -v b="$THRESHOLD_MB" 'BEGIN { exit !(a + 0 == b + 0) }'; then
      fail "$name   (its level is $a_thr MB, expected $THRESHOLD_MB MB)"
      return 0
    fi
    pass "$name   $what   [now: $a_state]"
    if [ "$a_state" = "ALARM" ]; then
      warn "$name is ALARMING right now, which means the problem it watches for is happening. Tell the CTO."
    fi
  }
  if [ "$GATEWAY_ON" = "yes" ]; then
    check_alarm "$A_NOHEALTHY" AWS/ApplicationELB HealthyHostCount "no healthy gateway server for 3 minutes"
    check_alarm "$A_TARGET5XX" AWS/ApplicationELB HTTPCode_Target_5XX_Count "gateway app errors, 20+ per 5 min, twice"
    check_alarm "$A_ELB5XX" AWS/ApplicationELB HTTPCode_ELB_5XX_Count "load balancer errors, 10+ per 5 min, twice"
  fi
  if [ "$BRAIN_ON" = "yes" ]; then
    check_alarm "$A_RED" AWS/ES ClusterStatus.red "brain reports RED or goes silent"
    check_alarm "$A_WRITES" AWS/ES ClusterIndexWritesBlocked "brain refuses new writes"
  fi
  if [ "$STORAGE_ON" = "yes" ]; then
    check_alarm "$A_STORAGE" AWS/ES FreeStorageSpace "brain disk under $LOW_STORAGE_PERCENT percent free ($THRESHOLD_MB MB)"
  fi

  if try_aws sns get-topic-attributes --topic-arn "$TOPIC_ARN" --query 'Attributes.TopicArn' --output text \
      && [ "$OUT" = "$TOPIC_ARN" ]; then
    pass "email topic $TOPIC_NAME exists in $REGION"
  else
    fail "email topic $TOPIC_NAME could not be found in $REGION"
  fi

  SUB_ARN=""
  for sub_try in 1 2 3 4; do
    if try_aws sns list-subscriptions-by-topic --topic-arn "$TOPIC_ARN" \
        --query "Subscriptions[?Protocol=='email'].[Endpoint,SubscriptionArn]" --output text; then
      while IFS=$'\t' read -r s_end s_arn; do
        if [ -n "$s_end" ] && [ "${s_end,,}" = "${ALERT_EMAIL,,}" ]; then SUB_ARN="$s_arn"; fi
      done <<<"$OUT"
    fi
    if [ -n "$SUB_ARN" ]; then break; fi
    if [ "$sub_try" -lt 4 ]; then sleep 5; fi # a brand new subscription can take a few seconds to show up
  done
  case "${SUB_ARN,,}" in
    "")
      SUB_STATE="missing"
      fail "no email subscription for $ALERT_EMAIL on topic $TOPIC_NAME (no alarm email would reach you)"
      echo "        FOR THE CTO: a new confirmation email is sent by:  aws sns subscribe --topic-arn $TOPIC_ARN --protocol email --notification-endpoint $ALERT_EMAIL --region $REGION" ;;
    pending*)
      SUB_STATE="pending"
      pass "email subscription for $ALERT_EMAIL exists (waiting for you to confirm it, see below)" ;;
    *)
      SUB_STATE="confirmed"
      pass "email subscription for $ALERT_EMAIL exists and is confirmed" ;;
  esac
  echo "  New alarms show 'INSUFFICIENT_DATA' for a few minutes. That is normal."
fi

# ---------------------------------------------------------------------------------------------
TOTAL=$((PASSED + FAILED))
echo ""
echo "=============================================================="
if [ "$FAILED" -eq 0 ]; then
  echo " RESULT: ALL CHECKS PASSED ($PASSED of $TOTAL)"
  echo "=============================================================="
  echo " Installed: ${#WANT[@]} alarm(s) and the email topic $TOPIC_NAME (stack $STACK)."
  echo " Alarm emails go to: $ALERT_EMAIL"
  if [ "${#SKIPPED[@]}" -gt 0 ]; then
    NOT_INSTALLED=""
    for skipped_item in "${SKIPPED[@]}"; do NOT_INSTALLED+="${NOT_INSTALLED:+ and }$skipped_item"; done
    echo " NOT INSTALLED: $NOT_INSTALLED (the WARN lines above say why). The CTO must look at this: tell the CTO."
  fi
  if [ "$WARNED" -gt 0 ]; then
    echo " WARNINGS: $WARNED (read the lines marked WARN above; some alarms may be missing). Tell the CTO."
  fi
  if [ "$SUB_STATE" = "pending" ]; then
    if [ "$GATEWAY_ON" = "yes" ]; then TEST_ALARM="$A_NOHEALTHY"; else TEST_ALARM="$A_RED"; fi
    echo ""
    echo " ONE THING LEFT FOR YOU (about one minute). Until you do it, NO alarm email will reach you:"
    echo "   1. Open the inbox of $ALERT_EMAIL."
    echo "   2. Find the email from no-reply@sns.amazonaws.com titled  AWS Notification - Subscription Confirmation"
    echo "      (check Spam too)."
    echo "   3. Click  Confirm subscription  in that email. A web page says the subscription is confirmed."
    echo "   The link stops working after 48 hours. If the email does not arrive within 5 minutes,"
    echo "   send this screen to the CTO."
    echo ""
    echo " THEN, REQUIRED: prove that alarm emails really reach you (about one minute). Wait 10 minutes after this"
    echo " install, then paste this one line into CloudShell:"
    echo "   aws cloudwatch set-alarm-state --alarm-name $TEST_ALARM --state-value ALARM --state-reason \"Email test\" --region $REGION"
    echo "   Within a minute you get one email that starts with ALARM (it is only the test), and a little later"
    echo "   one that starts with OK. If no email arrives within 5 minutes, check Spam, then tell the CTO."
  elif [ "$SUB_STATE" = "confirmed" ]; then
    echo " Your email address is already confirmed, so there is nothing for you to confirm."
  fi
  echo ""
  echo " ABOUT THE EMAILS: they come from no-reply@sns.amazonaws.com. A subject that starts with ALARM means a problem"
  echo " is happening now: forward it to the CTO."
  echo " A subject that starts with OK means it is over. You may get a few OK emails in the first minutes"
  echo " (each new alarm reports once that all is fine). They need no action."
  echo ""
  COST_CENTS=$((${#WANT[@]} * 10))
  printf ' COST: about USD 0.10 per alarm per month (standard resolution), so at most about USD %d.%02d per month for %d alarm(s).\n' \
    $((COST_CENTS / 100)) $((COST_CENTS % 100)) "${#WANT[@]}"
  echo " The AWS free tier can cover some or all of that. Email notifications are free for the first 1,000 per month."
  echo " The AWS Budget was not touched."
  if [ "$WARNED" -gt 0 ]; then
    echo " Tell the CTO: alarms installed, with warnings (the WARN lines above)."
  else
    echo " Tell the CTO: alarms installed."
  fi
else
  echo " RESULT: $FAILED of $TOTAL CHECKS FAILED"
  echo "=============================================================="
  echo " Copy this whole screen and send it to the CTO. Do not change anything in AWS yourself; wait for the CTO's answer."
fi
print_rollbacks
if [ "$FAILED" -ne 0 ]; then exit 1; fi
