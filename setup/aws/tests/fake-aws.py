#!/usr/bin/env python3
"""fake-aws.py: a pretend `aws` command for the owner-script tests (setup/aws/tests).

It answers from a small made-up account kept in one JSON file (FAKE_AWS_DIR/state.json), so an owner script can be run
from start to finish with no AWS account, no credentials and no network. It imports only the Python standard library
and never opens a socket.

  * Every call is appended to FAKE_AWS_DIR/calls.log as "R ..." (a read) or "W ..." (a change), so a test can prove that
    a script stopped before it changed anything.
  * The made-up account starts like the real one (cluster otchealth, ECS service otchealth-gateway, an application load
    balancer, the otchealth-brain OpenSearch domain; names from infra/aws in otchealth-mcp-server). A test changes it
    by putting a JSON patch in FAKE_AWS_DIR/patch.json before the first call (dicts merge, everything else replaces).
  * An answer the fake does not know is a loud failure ("FAKE-AWS: ...", exit 97), never a guess. A script that starts
    asking a new question therefore breaks its test instead of passing by accident.
  * Only the --query strings the owner scripts really use are answered, with the text the real CLI prints for them
    (--output text: tab between values, one row per line, True/False for booleans, None for a missing value).
"""
import hashlib
import json
import os
import re
import sys

ACCOUNT = "900915535335"
REGION = "us-east-1"
CLUSTER = "otchealth"
TASK_ROLE = "otchealthTaskRole"
STACK = "otchealth-ops-alarms"
TG_ARN = "arn:aws:elasticloadbalancing:%s:%s:targetgroup/otchealth-gateway-tg/0123456789abcdef" % (REGION, ACCOUNT)
LB_ARN = "arn:aws:elasticloadbalancing:%s:%s:loadbalancer/app/otchealth-gateway/fedcba9876543210" % (REGION, ACCOUNT)
TOPIC_ARN = "arn:aws:sns:%s:%s:otchealth-ops-alerts" % (REGION, ACCOUNT)
AWS_MANAGED = {
    "ViewOnlyAccess": "arn:aws:iam::aws:policy/job-function/ViewOnlyAccess",
    "AWSMCPSignInOAuthAccessPolicy": "arn:aws:iam::aws:policy/AWSMCPSignInOAuthAccessPolicy",
    "SignInLocalDevelopmentAccess": "arn:aws:iam::aws:policy/SignInLocalDevelopmentAccess",
    "IAMUserChangePassword": "arn:aws:iam::aws:policy/IAMUserChangePassword",
}
# alarm name -> (namespace, metric, threshold, group)
ALARMS = {
    "otchealth-gateway-no-healthy-targets": ("AWS/ApplicationELB", "HealthyHostCount", 1.0, "gateway"),
    "otchealth-gateway-target-5xx": ("AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", 20.0, "gateway"),
    "otchealth-gateway-elb-5xx": ("AWS/ApplicationELB", "HTTPCode_ELB_5XX_Count", 10.0, "gateway"),
    "otchealth-brain-cluster-red": ("AWS/ES", "ClusterStatus.red", 1.0, "brain"),
    "otchealth-brain-writes-blocked": ("AWS/ES", "ClusterIndexWritesBlocked", 1.0, "brain"),
    "otchealth-brain-low-storage": ("AWS/ES", "FreeStorageSpace", None, "storage"),
}
# What the IAM policy simulator answers (a stand-in for the real one; the tests are about the scripts, not about IAM).
EXPLICIT_DENY = {
    "secretsmanager:GetSecretValue", "ssm:GetParameter", "s3:GetObject", "es:ESHttpGet",
    "lightsail:GetInstanceAccessDetails", "iam:CreateAccessKey", "iam:AttachUserPolicy",
    "ecs:DescribeTaskDefinition", "lambda:ListFunctions", "s3:ListBucket",
}
ALLOWED = {
    "ecs:DescribeServices", "cloudwatch:GetMetricData", "ce:GetCostAndUsage", "sts:GetCallerIdentity",
    "iam:ChangePassword", "signin:AuthorizeOAuth2Access", "signin:CreateOAuth2Token",
}


class AwsError(Exception):
    def __init__(self, code, message):
        Exception.__init__(self, message)
        self.code = code
        self.message = message


class Gap(Exception):
    """The fake has no answer for this call: a gap in the harness, not an AWS error."""


def merge(base, patch):
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            merge(base[key], value)
        else:
            base[key] = value


def default_world():
    return {
        "account": ACCOUNT,
        "caller_arn": "arn:aws:iam::%s:user/owner-admin" % ACCOUNT,
        "fail": {},  # "service operation" -> AWS error code to return for that call
        "ecs": {
            "cluster_exists": True,
            "services": [{"name": "otchealth-gateway"}],  # name, family, rev, status, desired, running, lb
            "task_role": TASK_ROLE,
        },
        "iam": {
            "roles": {TASK_ROLE: {"arn": "arn:aws:iam::%s:role/%s" % (ACCOUNT, TASK_ROLE), "max_session": 3600, "trust": {}}},
            "users": {},
            "policies": {},
            "attached": {},  # "user:NAME" or "role:NAME" -> [policy arns]
            "inline": {},  # "user:NAME" or "role:NAME" -> {policy name: document}
            "groups": {},  # user name -> [group names]
            "login": {},  # user name -> True
            "access_keys": {},  # user name -> count
            "password_policy": None,
        },
        "elb": {"target_group_attached": True, "lb_type": "application", "healthy": 2, "total": 2},
        "cw": {"gateway_data": True, "brain_data": True, "alarms": {}},
        "os": {"exists": True, "volume": 100},
        "cfn": {"stack": None, "template": ""},
        "sns": {"topic": False, "subs": []},
    }


def state_paths():
    folder = os.environ["FAKE_AWS_DIR"]
    return folder, os.path.join(folder, "state.json"), os.path.join(folder, "calls.log")


def load_world():
    folder, state, _ = state_paths()
    if os.path.exists(state):
        with open(state) as handle:
            return json.load(handle)
    world = default_world()
    patch = os.path.join(folder, "patch.json")
    if os.path.exists(patch):
        with open(patch) as handle:
            merge(world, json.load(handle))
    return world


def save_world(world):
    _, state, _ = state_paths()
    with open(state + ".tmp", "w") as handle:
        json.dump(world, handle)
    os.replace(state + ".tmp", state)


def parse(argv):
    service, op = argv[0], argv[1]
    flags = {}
    i = 2
    while i < len(argv):
        if argv[i].startswith("--"):
            name = argv[i][2:]
            values = []
            i += 1
            while i < len(argv) and not argv[i].startswith("--"):
                values.append(argv[i])
                i += 1
            flags[name] = values
        else:
            i += 1
    return service, op, flags


def one(flags, name, default=None):
    values = flags.get(name)
    return values[0] if values else default


def text(value):
    """What `aws ... --output text` prints for the shapes the owner scripts ask for."""
    if value is None:
        return "None"
    if isinstance(value, bool):
        return "True" if value else "False"
    if isinstance(value, (int, float, str)):
        return str(value)
    if isinstance(value, list):
        if not value:
            return ""
        if all(not isinstance(x, (list, dict)) for x in value):
            return "\t".join(text(x) for x in value)
        return "\n".join(text(x) for x in value)
    raise Gap("cannot print %r as text" % (value,))


def render(value, fmt):
    if fmt == "text":
        return text(value)
    return json.dumps(value, indent=4)


def answer(flags, table):
    query = one(flags, "query")
    if query not in table:
        raise Gap("no canned answer for --query %r" % query)
    return render(table[query](), one(flags, "output", "json"))


def read_doc(flags, name):
    path = one(flags, name, "")
    if not path.startswith("file://"):
        raise Gap("--%s is not a file:// value" % name)
    with open(path[len("file://"):]) as handle:
        return json.load(handle)


def policy_arn(name):
    return "arn:aws:iam::%s:policy/%s" % (ACCOUNT, name)


def require(world, kind, who):
    table = world["iam"]["users"] if kind == "user" else world["iam"]["roles"]
    if who not in table:
        word = "user" if kind == "user" else "role"
        raise AwsError("NoSuchEntity", "The %s with name %s cannot be found." % (word, who))
    return table[who]


# ---------------------------------------------------------------------------------------------------- sts, configure
def sts_get_caller_identity(world, flags):
    return answer(flags, {
        None: lambda: {"UserId": "AIDAEXAMPLE", "Account": world["account"], "Arn": world["caller_arn"]},
        "Account": lambda: world["account"],
        "Arn": lambda: world["caller_arn"],
        "[Account,Arn]": lambda: [world["account"], world["caller_arn"]],
    })


# ---------------------------------------------------------------------------------------------------------------- iam
def iam_get_account_summary(world, flags):
    return answer(flags, {"SummaryMap.Users": lambda: len(world["iam"]["users"]) + 2})


def iam_list_policies(world, flags):
    query = one(flags, "query", "")
    match = re.match(r"^Policies\[\?(.*)\]\.\[PolicyName,Arn\]$", query)
    if not match:
        raise Gap("no canned answer for --query %r" % query)
    names = re.findall(r"PolicyName=='([^']+)'", match.group(1))
    return render([[n, AWS_MANAGED[n]] for n in names if n in AWS_MANAGED], one(flags, "output", "json"))


def iam_get_account_password_policy(world, flags):
    if world["iam"]["password_policy"] is None:
        raise AwsError("NoSuchEntity", "The Password Policy with domain name %s cannot be found." % ACCOUNT)
    return answer(flags, {"PasswordPolicy": lambda: world["iam"]["password_policy"]})


def iam_get_principal(kind):
    def handler(world, flags):
        who = one(flags, kind + "-name")
        entity = require(world, kind, who)
        key = "User" if kind == "user" else "Role"
        table = {
            key + ".Arn": lambda: entity["arn"],
            key + ".PermissionsBoundary.PermissionsBoundaryArn": lambda: entity.get("boundary"),
        }
        if kind == "role":
            table["Role.[MaxSessionDuration,length(AssumeRolePolicyDocument.Statement),"
                  "AssumeRolePolicyDocument.Statement[0].Principal.AWS]"] = lambda: [
                entity.get("max_session", 3600),
                len(entity.get("trust", {}).get("Statement", [])),
                (entity.get("trust", {}).get("Statement") or [{}])[0].get("Principal", {}).get("AWS"),
            ]
        return answer(flags, table)
    return handler


def iam_create_user(world, flags):
    who = one(flags, "user-name")
    if who in world["iam"]["users"]:
        raise AwsError("EntityAlreadyExists", "User with name %s already exists." % who)
    world["iam"]["users"][who] = {"arn": "arn:aws:iam::%s:user/%s" % (ACCOUNT, who)}
    return answer(flags, {"User.Arn": lambda: world["iam"]["users"][who]["arn"], None: lambda: {}})


def iam_create_role(world, flags):
    who = one(flags, "role-name")
    if who in world["iam"]["roles"]:
        raise AwsError("EntityAlreadyExists", "Role with name %s already exists." % who)
    world["iam"]["roles"][who] = {
        "arn": "arn:aws:iam::%s:role/%s" % (ACCOUNT, who),
        "max_session": int(one(flags, "max-session-duration", "3600")),
        "trust": read_doc(flags, "assume-role-policy-document"),
    }
    return answer(flags, {"Role.Arn": lambda: world["iam"]["roles"][who]["arn"], None: lambda: {}})


def iam_update_assume_role_policy(world, flags):
    require(world, "role", one(flags, "role-name"))["trust"] = read_doc(flags, "policy-document")
    return ""


def iam_update_role(world, flags):
    require(world, "role", one(flags, "role-name"))["max_session"] = int(one(flags, "max-session-duration", "3600"))
    return ""


def iam_tag(kind):
    def handler(world, flags):
        require(world, kind, one(flags, kind + "-name"))
        return ""
    return handler


def iam_attach(kind):
    def handler(world, flags):
        who = one(flags, kind + "-name")
        require(world, kind, who)
        have = world["iam"]["attached"].setdefault("%s:%s" % (kind, who), [])
        arn = one(flags, "policy-arn")
        if arn not in have:
            have.append(arn)
        return ""
    return handler


def iam_list_attached(kind):
    def handler(world, flags):
        who = one(flags, kind + "-name")
        require(world, kind, who)
        arns = list(world["iam"]["attached"].get("%s:%s" % (kind, who), []))
        return answer(flags, {
            "AttachedPolicies[].PolicyArn": lambda: arns,
            "AttachedPolicies[].PolicyName": lambda: [a.rsplit("/", 1)[1] for a in arns],
        })
    return handler


def iam_list_inline(kind):
    def handler(world, flags):
        who = one(flags, kind + "-name")
        require(world, kind, who)
        names = sorted(world["iam"]["inline"].get("%s:%s" % (kind, who), {}))
        return answer(flags, {"PolicyNames": lambda: names})
    return handler


def iam_put_inline(kind):
    def handler(world, flags):
        who = one(flags, kind + "-name")
        require(world, kind, who)
        world["iam"]["inline"].setdefault("%s:%s" % (kind, who), {})[one(flags, "policy-name")] = read_doc(flags, "policy-document")
        return ""
    return handler


def iam_get_inline(kind):
    def handler(world, flags):
        who = one(flags, kind + "-name")
        require(world, kind, who)
        name = one(flags, "policy-name")
        if name not in world["iam"]["inline"].get("%s:%s" % (kind, who), {}):
            raise AwsError("NoSuchEntity", "The %s policy with name %s cannot be found." % (kind, name))
        return answer(flags, {"PolicyName": lambda: name})
    return handler


def iam_list_groups_for_user(world, flags):
    who = one(flags, "user-name")
    require(world, "user", who)
    return answer(flags, {"Groups[].GroupName": lambda: world["iam"]["groups"].get(who, [])})


def iam_list_access_keys(world, flags):
    who = one(flags, "user-name")
    require(world, "user", who)
    return answer(flags, {"length(AccessKeyMetadata)": lambda: world["iam"]["access_keys"].get(who, 0)})


def customer_policy(world, flags):
    arn = one(flags, "policy-arn")
    for entry in world["iam"]["policies"].values():
        if entry["arn"] == arn:
            return entry
    raise AwsError("NoSuchEntity", "Policy %s was not found." % arn)


def iam_create_policy(world, flags):
    name = one(flags, "policy-name")
    if name in world["iam"]["policies"]:
        raise AwsError("EntityAlreadyExists", "A policy called %s already exists." % name)
    world["iam"]["policies"][name] = {"arn": policy_arn(name), "next": 2, "versions": [{"id": "v1", "doc": read_doc(flags, "policy-document"), "default": True}]}
    return "{}"


def iam_get_policy(world, flags):
    entry = customer_policy(world, flags)
    default = [v["id"] for v in entry["versions"] if v["default"]][0]
    return answer(flags, {"Policy.DefaultVersionId": lambda: default, None: lambda: {"Policy": {"Arn": entry["arn"]}}})


def iam_get_policy_version(world, flags):
    entry = customer_policy(world, flags)
    wanted = one(flags, "version-id")
    version = [v for v in entry["versions"] if v["id"] == wanted]
    if not version:
        raise AwsError("NoSuchEntity", "Policy version %s was not found." % wanted)
    return answer(flags, {"PolicyVersion.Document": lambda: version[0]["doc"]})


def iam_list_policy_versions(world, flags):
    entry = customer_policy(world, flags)
    older = [v["id"] for v in entry["versions"] if not v["default"]]
    return answer(flags, {
        "length(Versions)": lambda: len(entry["versions"]),
        "sort_by(Versions[?IsDefaultVersion==`false`], &CreateDate)[0].VersionId": lambda: older[0] if older else None,
    })


def iam_create_policy_version(world, flags):
    entry = customer_policy(world, flags)
    if len(entry["versions"]) >= 5:
        raise AwsError("LimitExceeded", "A managed policy can have up to 5 versions.")
    for v in entry["versions"]:
        v["default"] = False
    entry["versions"].append({"id": "v%d" % entry["next"], "doc": read_doc(flags, "policy-document"), "default": True})
    entry["next"] += 1
    return "{}"


def iam_delete_policy_version(world, flags):
    entry = customer_policy(world, flags)
    wanted = one(flags, "version-id")
    entry["versions"] = [v for v in entry["versions"] if v["id"] != wanted or v["default"]]
    return ""


def iam_get_login_profile(world, flags):
    who = one(flags, "user-name")
    require(world, "user", who)
    if not world["iam"]["login"].get(who):
        raise AwsError("NoSuchEntity", "Login Profile for User %s cannot be found." % who)
    return answer(flags, {"LoginProfile.PasswordResetRequired": lambda: True})


def iam_create_login_profile(world, flags):
    who = one(flags, "user-name")
    require(world, "user", who)
    if not one(flags, "password", "").startswith("file://"):
        raise Gap("the password must come from a file:// value")
    world["iam"]["login"][who] = True
    return "{}"


def iam_simulate(world, flags):
    who = one(flags, "policy-source-arn", "")
    action = one(flags, "action-names", "")
    resource = one(flags, "resource-arns", "")
    task_role = "arn:aws:iam::%s:role/%s" % (ACCOUNT, world["ecs"]["task_role"])
    user_arn = "arn:aws:iam::%s:user/otchealth-ai-reader" % ACCOUNT
    if action in EXPLICIT_DENY:
        decision = "explicitDeny"
    elif action in ALLOWED:
        decision = "allowed"
    elif action == "iam:EnableMFADevice":
        decision = "allowed" if (who == user_arn and resource == user_arn) else "implicitDeny"
    elif action == "sts:AssumeRole":
        decision = "allowed" if (who == task_role and resource.endswith("role/otchealth-ai-reader-role")) else "implicitDeny"
    else:
        decision = "implicitDeny"
    return answer(flags, {"EvaluationResults[0].EvalDecision": lambda: decision})


# ---------------------------------------------------------------------------------------------------------------- ecs
def ecs_services(world):
    rows = []
    for spec in world["ecs"]["services"]:
        name = spec["name"]
        family = spec.get("family", "otchealth-gateway")
        rows.append({
            "serviceName": name,
            "serviceArn": "arn:aws:ecs:%s:%s:service/%s/%s" % (REGION, ACCOUNT, CLUSTER, name),
            "status": spec.get("status", "ACTIVE"),
            "desiredCount": spec.get("desired", 2),
            "runningCount": spec.get("running", 2),
            "taskDefinition": "arn:aws:ecs:%s:%s:task-definition/%s:%s" % (REGION, ACCOUNT, family, spec.get("rev", 198)),
            "loadBalancers": [{"targetGroupArn": TG_ARN}] if spec.get("lb", True) else [],
        })
    return rows


def ecs_check_cluster(world, flags):
    if one(flags, "cluster") != CLUSTER or not world["ecs"]["cluster_exists"]:
        raise AwsError("ClusterNotFoundException", "Cluster not found.")


def ecs_describe_services(world, flags):
    ecs_check_cluster(world, flags)
    asked = flags.get("services", [])
    if len(asked) > 10:
        raise AwsError("InvalidParameterException", "Invalid parameter: services cannot have more than 10 entries (got %d)." % len(asked))
    rows = [s for s in ecs_services(world) if s["serviceName"] in asked or s["serviceArn"] in asked]
    return answer(flags, {
        "services[?status=='ACTIVE'].taskDefinition | [0]":
            lambda: ([s["taskDefinition"] for s in rows if s["status"] == "ACTIVE"] or [None])[0],
        "services[?status=='ACTIVE'].[serviceName,taskDefinition]":
            lambda: [[s["serviceName"], s["taskDefinition"]] for s in rows if s["status"] == "ACTIVE"],
        "services[0].[status,desiredCount,runningCount,taskDefinition]":
            lambda: [rows[0]["status"], rows[0]["desiredCount"], rows[0]["runningCount"], rows[0]["taskDefinition"]] if rows else None,
        "services[0].loadBalancers[].targetGroupArn":
            lambda: [lb["targetGroupArn"] for lb in rows[0]["loadBalancers"]] if rows else None,
    })


def ecs_list_services(world, flags):
    ecs_check_cluster(world, flags)
    arns = [s["serviceArn"] for s in ecs_services(world) if s["status"] != "INACTIVE"]
    # The real CLI prints one line per page of 10 when the answer has several pages.
    pages = [arns[i:i + 10] for i in range(0, len(arns), 10)]
    return answer(flags, {"serviceArns[]": lambda: pages if len(pages) > 1 else arns})


def ecs_describe_task_definition(world, flags):
    return answer(flags, {"taskDefinition.taskRoleArn": lambda: "arn:aws:iam::%s:role/%s" % (ACCOUNT, world["ecs"]["task_role"])})


# --------------------------------------------------------------------------- elbv2, cloudwatch, opensearch, sns, cfn
def elb_describe_target_groups(world, flags):
    return answer(flags, {"TargetGroups[0].[TargetGroupName,LoadBalancerArns[0]]":
                          lambda: ["otchealth-gateway-tg", LB_ARN if world["elb"]["target_group_attached"] else None]})


def elb_describe_load_balancers(world, flags):
    return answer(flags, {"LoadBalancers[0].[LoadBalancerName,Type,State.Code,Scheme]":
                          lambda: ["otchealth-gateway", world["elb"]["lb_type"], "active", "internet-facing"]})


def elb_describe_target_health(world, flags):
    states = ["healthy"] * world["elb"]["healthy"] + ["unhealthy"] * (world["elb"]["total"] - world["elb"]["healthy"])
    return answer(flags, {"TargetHealthDescriptions[].TargetHealth.State": lambda: states})


def cw_list_metrics(world, flags):
    namespace = one(flags, "namespace")
    have = world["cw"]["gateway_data"] if namespace == "AWS/ApplicationELB" else world["cw"]["brain_data"]
    return answer(flags, {"length(Metrics)": lambda: 1 if have else 0})


def alarm_rows(world):
    return world["cw"]["alarms"]


def cw_describe_alarms(world, flags):
    names = flags.get("alarm-names", [])
    found = [n for n in names if n in alarm_rows(world)]
    first = alarm_rows(world).get(names[0]) if names else None

    def one_alarm():
        if not first:
            return None
        return [names[0], first["state"], first["ns"], first["metric"], first["threshold"], first["actions"][0], first["ok"][0]]
    return answer(flags, {
        "[MetricAlarms[].AlarmName, CompositeAlarms[].AlarmName][]": lambda: found,
        "MetricAlarms[0].[AlarmName,StateValue,Namespace,MetricName,Threshold,AlarmActions[0],OKActions[0]]": one_alarm,
    })


def cw_describe_alarms_for_metric(world, flags):
    namespace, metric = one(flags, "namespace"), one(flags, "metric-name")
    rows = [[n, a["state"]] for n, a in sorted(alarm_rows(world).items()) if a["ns"] == namespace and a["metric"] == metric]
    return answer(flags, {"MetricAlarms[].[AlarmName,StateValue]": lambda: rows})


def os_describe_domain(world, flags):
    if not world["os"]["exists"]:
        raise AwsError("ResourceNotFoundException", "Domain not found: otchealth-brain")
    return answer(flags, {
        "DomainStatus.[EngineVersion,Deleted,Processing,EBSOptions.EBSEnabled,EBSOptions.VolumeSize,"
        "EBSOptions.VolumeType,ClusterConfig.InstanceType,ClusterConfig.InstanceCount]":
            lambda: ["OpenSearch_2.19", False, False, True, world["os"]["volume"], "gp3", "r6g.large.search", 1],
    })


def sns_get_topic_attributes(world, flags):
    if not world["sns"]["topic"]:
        raise AwsError("NotFound", "Topic does not exist")
    return answer(flags, {"Attributes.TopicArn": lambda: TOPIC_ARN})


def sns_list_subscriptions_by_topic(world, flags):
    rows = [[s["endpoint"], s["arn"]] for s in world["sns"]["subs"]]
    return answer(flags, {"Subscriptions[?Protocol=='email'].[Endpoint,SubscriptionArn]": lambda: rows})


def template_parameters(body):
    keys, inside = [], False
    for line in body.splitlines():
        if re.match(r"^Parameters:\s*$", line):
            inside = True
        elif inside and re.match(r"^\S", line):
            break
        elif inside:
            match = re.match(r"^  ([A-Za-z][A-Za-z0-9]*):\s*$", line)
            if match:
                keys.append(match.group(1))
    return keys


def cfn_validate_template(world, flags):
    path = one(flags, "template-body", "")
    if not path.startswith("file://"):
        raise Gap("--template-body is not a file:// value")
    with open(path[len("file://"):]) as handle:
        body = handle.read()
    if "Resources:" not in body:
        raise AwsError("ValidationError", "Template format error: At least one Resources member must be defined.")
    return answer(flags, {"Parameters[].ParameterKey": lambda: template_parameters(body)})


def cfn_describe_stacks(world, flags):
    stack = world["cfn"]["stack"]
    if not stack:
        raise AwsError("ValidationError", "Stack with id %s does not exist" % one(flags, "stack-name"))
    return answer(flags, {"Stacks[0].StackStatus": lambda: stack["status"]})


def cfn_list_stack_resources(world, flags):
    stack = world["cfn"]["stack"]
    if not stack:
        raise AwsError("ValidationError", "Stack with id %s does not exist" % one(flags, "stack-name"))
    return answer(flags, {"StackResourceSummaries[?ResourceStatus!='DELETE_COMPLETE'].PhysicalResourceId":
                          lambda: [TOPIC_ARN] + stack["alarms"]})


def wanted_alarms(params):
    has_gateway = bool(params.get("GatewayTargetGroup")) and bool(params.get("GatewayLoadBalancer"))
    has_brain = bool(params.get("BrainDomainName")) and bool(params.get("BrainClientId"))
    has_storage = has_brain and params.get("LowStorageThresholdMb", "0") != "0"
    groups = {"gateway": has_gateway, "brain": has_brain, "storage": has_storage}
    return [name for name, spec in ALARMS.items() if groups[spec[3]]]


def cfn_deploy(world, flags):
    name = one(flags, "stack-name")
    with open(one(flags, "template-file")) as handle:
        body = handle.read()
    params = {}
    for item in flags.get("parameter-overrides", []):
        key, _, value = item.partition("=")
        params[key] = value
    digest = hashlib.sha256(body.encode("utf-8")).hexdigest()
    previous = world["cfn"]["stack"]
    if previous and previous["digest"] == digest and previous["params"] == params:
        return "\nNo changes to deploy. Stack %s is up to date\n" % name
    names = wanted_alarms(params)
    world["cfn"]["template"] = body
    world["cfn"]["stack"] = {"status": "UPDATE_COMPLETE" if previous else "CREATE_COMPLETE", "digest": digest, "params": params, "alarms": names}
    for alarm in list(world["cw"]["alarms"]):
        if world["cw"]["alarms"][alarm].get("owned"):
            del world["cw"]["alarms"][alarm]
    for alarm in names:
        namespace, metric, threshold, _ = ALARMS[alarm]
        if threshold is None:
            threshold = float(params["LowStorageThresholdMb"])
        world["cw"]["alarms"][alarm] = {"ns": namespace, "metric": metric, "threshold": threshold, "state": "INSUFFICIENT_DATA",
                                         "actions": [TOPIC_ARN], "ok": [TOPIC_ARN], "owned": True}
    world["sns"]["topic"] = True
    if not world["sns"]["subs"]:
        world["sns"]["subs"] = [{"endpoint": params["AlertEmail"], "arn": "PendingConfirmation"}]
    return "Waiting for changeset to be created..\nWaiting for stack create/update to complete\nSuccessfully created/updated stack - %s\n" % name


HANDLERS = {
    "sts get-caller-identity": sts_get_caller_identity,
    "iam get-account-summary": iam_get_account_summary,
    "iam list-policies": iam_list_policies,
    "iam get-account-password-policy": iam_get_account_password_policy,
    "iam get-user": iam_get_principal("user"),
    "iam get-role": iam_get_principal("role"),
    "iam create-user": iam_create_user,
    "iam create-role": iam_create_role,
    "iam update-assume-role-policy": iam_update_assume_role_policy,
    "iam update-role": iam_update_role,
    "iam tag-user": iam_tag("user"),
    "iam tag-role": iam_tag("role"),
    "iam attach-user-policy": iam_attach("user"),
    "iam attach-role-policy": iam_attach("role"),
    "iam list-attached-user-policies": iam_list_attached("user"),
    "iam list-attached-role-policies": iam_list_attached("role"),
    "iam list-user-policies": iam_list_inline("user"),
    "iam list-role-policies": iam_list_inline("role"),
    "iam put-user-policy": iam_put_inline("user"),
    "iam put-role-policy": iam_put_inline("role"),
    "iam get-user-policy": iam_get_inline("user"),
    "iam get-role-policy": iam_get_inline("role"),
    "iam list-groups-for-user": iam_list_groups_for_user,
    "iam list-access-keys": iam_list_access_keys,
    "iam create-policy": iam_create_policy,
    "iam get-policy": iam_get_policy,
    "iam get-policy-version": iam_get_policy_version,
    "iam list-policy-versions": iam_list_policy_versions,
    "iam create-policy-version": iam_create_policy_version,
    "iam delete-policy-version": iam_delete_policy_version,
    "iam get-login-profile": iam_get_login_profile,
    "iam create-login-profile": iam_create_login_profile,
    "iam simulate-principal-policy": iam_simulate,
    "ecs describe-services": ecs_describe_services,
    "ecs list-services": ecs_list_services,
    "ecs describe-task-definition": ecs_describe_task_definition,
    "elbv2 describe-target-groups": elb_describe_target_groups,
    "elbv2 describe-load-balancers": elb_describe_load_balancers,
    "elbv2 describe-target-health": elb_describe_target_health,
    "cloudwatch list-metrics": cw_list_metrics,
    "cloudwatch describe-alarms": cw_describe_alarms,
    "cloudwatch describe-alarms-for-metric": cw_describe_alarms_for_metric,
    "opensearch describe-domain": os_describe_domain,
    "sns get-topic-attributes": sns_get_topic_attributes,
    "sns list-subscriptions-by-topic": sns_list_subscriptions_by_topic,
    "cloudformation validate-template": cfn_validate_template,
    "cloudformation describe-stacks": cfn_describe_stacks,
    "cloudformation list-stack-resources": cfn_list_stack_resources,
    "cloudformation deploy": cfn_deploy,
}


def operation_name(op):
    return "".join(part.capitalize() for part in op.split("-"))


def log_call(kind, argv):
    _, _, calls = state_paths()
    with open(calls, "a") as handle:
        handle.write("%s %s\n" % (kind, " ".join(argv)))


def main(argv):
    if argv[:3] == ["configure", "get", "region"]:
        log_call("R", argv)
        print(os.environ.get("AWS_REGION", REGION))
        return 0
    if len(argv) < 2:
        sys.stderr.write("FAKE-AWS: expected 'aws SERVICE OPERATION ...'\n")
        return 97
    service, op, flags = parse(argv)
    kind = "R" if re.match(r"^(describe|list|get|simulate|validate|wait)", op) else "W"
    log_call(kind, argv)
    world = load_world()
    try:
        code = world["fail"].get("%s %s" % (service, op))
        if code:
            raise AwsError(code, "The fake was told to fail this call.")
        handler = HANDLERS.get("%s %s" % (service, op))
        if handler is None:
            raise Gap("no canned answer for: aws %s %s" % (service, op))
        output = handler(world, flags)
    except AwsError as err:
        sys.stderr.write("An error occurred (%s) when calling the %s operation: %s\n" % (err.code, operation_name(op), err.message))
        return 254
    except Gap as gap:
        sys.stderr.write("FAKE-AWS: %s (aws %s)\n" % (gap, " ".join(argv)))
        return 97
    save_world(world)
    if output:
        sys.stdout.write(output if output.endswith("\n") else output + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
