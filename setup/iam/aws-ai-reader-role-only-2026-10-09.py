#!/usr/bin/env python3
"""Provision only the gateway's read-only AI role. Dry-run unless --apply is explicit."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from typing import Any, Callable


ACCOUNT = "900915535335"
REGION = "us-east-1"
ROLE = "otchealth-ai-reader-role"
TASK_ROLE = "otchealthGatewayTaskRole"
TASK_ROLE_ARN = f"arn:aws:iam::{ACCOUNT}:role/{TASK_ROLE}"
ROLE_ARN = f"arn:aws:iam::{ACCOUNT}:role/{ROLE}"
EXTRAS = "otchealth-ai-reader-extras"
DENY = "otchealth-ai-reader-deny"
ASSUME = "otchealth-assume-ai-reader-2026-10-07"
EXTRAS_ARN = f"arn:aws:iam::{ACCOUNT}:policy/{EXTRAS}"
DENY_ARN = f"arn:aws:iam::{ACCOUNT}:policy/{DENY}"
VIEW_ONLY_ARN = "arn:aws:iam::aws:policy/job-function/ViewOnlyAccess"
MAX_SESSION = 3600

# These documents are copied without permission changes from the reviewed
# aws-ai-access-2026-10-07.sh source (EXTRAS_JSON and DENY_JSON).
EXTRAS_DOC = {
    "Version": "2012-10-17",
    "Statement": [{
        "Sid": "MonitoringReads", "Effect": "Allow",
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
            "logs:DescribeLogStreams", "sts:GetCallerIdentity",
        ],
        "Resource": "*",
    }],
}

DENY_DOC = {
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "NoSecretOrKeyValues", "Effect": "Deny",
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
                "ecr-public:GetAuthorizationToken",
            ],
            "Resource": "*",
        },
        {
            "Sid": "NoDataContent", "Effect": "Deny",
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
                "cloudwatch:GetInsightRuleReport", "redshift:ViewQueriesInConsole", "lex:GetUtterancesView",
            ],
            "Resource": "*",
        },
        {
            "Sid": "NoFileNames", "Effect": "Deny",
            "Action": ["s3:ListBucket", "s3:ListBucketVersions", "s3:ListBucketMultipartUploads"],
            "Resource": "*",
        },
        {
            "Sid": "NoConfigThatHoldsSecrets", "Effect": "Deny",
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
                "ec2:DescribeSpotInstanceRequests", "elasticmapreduce:ListSteps",
            ],
            "Resource": "*",
        },
        {
            "Sid": "NoShellOrRemoteExec", "Effect": "Deny",
            "Action": [
                "ecs:ExecuteCommand", "ssm:StartSession", "ssm:SendCommand",
                "ec2-instance-connect:SendSSHPublicKey", "ec2-instance-connect:SendSerialConsoleSSHPublicKey",
            ],
            "Resource": "*",
        },
        {
            "Sid": "NoPaymentsOrPaymentMethods", "Effect": "Deny",
            "Action": ["payments:*", "aws-portal:ViewPaymentMethods", "aws-portal:ModifyPaymentMethods"],
            "Resource": "*",
        },
        {
            "Sid": "NoCredentialOrPermissionChanges", "Effect": "Deny",
            "Action": [
                "iam:CreateAccessKey", "iam:CreateLoginProfile", "iam:UpdateLoginProfile",
                "iam:AttachUserPolicy", "iam:PutUserPolicy", "iam:AttachRolePolicy", "iam:PutRolePolicy",
                "iam:AttachGroupPolicy", "iam:PutGroupPolicy", "iam:CreatePolicyVersion",
                "iam:SetDefaultPolicyVersion", "iam:UpdateAssumeRolePolicy", "iam:AddUserToGroup",
                "iam:CreateServiceSpecificCredential", "iam:ResetServiceSpecificCredential",
            ],
            "Resource": "*",
        },
        {
            "Sid": "NoApiGatewayStageVariables", "Effect": "Deny",
            "Action": ["apigateway:GET"],
            "Resource": [
                "arn:aws:apigateway:*::/restapis/*/stages", "arn:aws:apigateway:*::/restapis/*/stages/*",
                "arn:aws:apigateway:*::/apis/*/stages", "arn:aws:apigateway:*::/apis/*/stages/*",
            ],
        },
    ],
}

TRUST_DOC = {
    "Version": "2012-10-17",
    "Statement": [{
        "Sid": "GatewayTaskRoleOnly", "Effect": "Allow",
        "Principal": {"AWS": TASK_ROLE_ARN}, "Action": "sts:AssumeRole",
    }],
}
ASSUME_DOC = {
    "Version": "2012-10-17",
    "Statement": [{
        "Sid": "AssumeAiReaderRoleOnly", "Effect": "Allow",
        "Action": "sts:AssumeRole", "Resource": ROLE_ARN,
    }],
}
EXPECTED_POLICIES = {DENY_ARN, EXTRAS_ARN, VIEW_ONLY_ARN}


class ProvisionError(Exception):
    pass


def canonical(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: canonical(item) for key, item in sorted(value.items())}
    if isinstance(value, list):
        return [canonical(item) for item in value]
    return value


class Provisioner:
    def __init__(self, apply: bool):
        self.apply = apply
        self.prestate: dict[str, Any] = {}
        self.rollback: list[str] = []
        self.newly_attached: list[str] = []

    def aws(self, *args: str) -> Any:
        command = ["aws", *args, "--region", REGION, "--no-cli-pager", "--output", "json"]
        try:
            env = os.environ.copy()
            env["AWS_MAX_ATTEMPTS"] = "1"
            result = subprocess.run(command, check=False, capture_output=True, text=True, timeout=45, env=env)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise ProvisionError(f"AWS CLI call failed or timed out ({args[0]} {args[1]}). Reconcile live state before retrying.") from exc
        if result.returncode != 0:
            # Never surface raw stderr: it is uncontrolled CLI output.
            raise ProvisionError(f"AWS CLI read failed ({args[0]} {args[1]}); no command output was logged.")
        try:
            return json.loads(result.stdout) if result.stdout.strip() else {}
        except json.JSONDecodeError as exc:
            raise ProvisionError(f"AWS CLI returned invalid JSON ({args[0]} {args[1]}).") from exc

    def require_identity(self) -> None:
        identity = self.aws("sts", "get-caller-identity")
        arn = identity.get("Arn", "")
        account = identity.get("Account", "")
        if account != ACCOUNT:
            raise ProvisionError("Caller account is not the required account; no writes were attempted.")
        if not arn.startswith(f"arn:aws:sts::{ACCOUNT}:assumed-role/"):
            raise ProvisionError("Caller is not an assumed-role identity; no writes were attempted.")
        self.prestate["caller"] = {"account": account, "identity_type": "assumed-role"}

    def discover_gateway_task_role(self) -> None:
        services = self.aws("ecs", "describe-services", "--cluster", "otchealth", "--services", "otchealth-gateway")
        service_rows = services.get("services")
        if not isinstance(service_rows, list):
            raise ProvisionError("ECS describe-services response was incomplete; no writes were attempted.")
        found = [s for s in service_rows if isinstance(s, dict) and s.get("serviceName") == "otchealth-gateway"]
        if len(found) != 1 or services.get("failures"):
            raise ProvisionError("Could not uniquely discover ECS service otchealth/otchealth-gateway.")
        if found[0].get("status") != "ACTIVE":
            raise ProvisionError("Gateway ECS service is not ACTIVE; no writes were attempted.")
        taskdef_arn = found[0].get("taskDefinition")
        if not taskdef_arn:
            raise ProvisionError("Gateway service has no task definition ARN.")
        td = self.aws("ecs", "describe-task-definition", "--task-definition", taskdef_arn).get("taskDefinition", {})
        if td.get("taskRoleArn") != TASK_ROLE_ARN:
            raise ProvisionError("Gateway task definition taskRoleArn does not match the known role; no writes were attempted.")
        self.prestate["gateway"] = {
            "cluster": "otchealth", "service": "otchealth-gateway",
            "task_definition": taskdef_arn.rsplit("/", 1)[-1], "task_role": TASK_ROLE_ARN,
        }

    def policy_document(self, arn: str) -> Any:
        policy = self.aws("iam", "get-policy", "--policy-arn", arn).get("Policy")
        if not policy:
            raise ProvisionError(f"Managed policy metadata missing for {arn}.")
        version = policy.get("DefaultVersionId")
        doc = self.aws("iam", "get-policy-version", "--policy-arn", arn, "--version-id", version).get("PolicyVersion", {}).get("Document")
        if not isinstance(doc, dict):
            raise ProvisionError(f"Managed policy document unreadable for {arn}.")
        return doc

    def read_custom_policy(self, name: str, arn: str, expected: Any) -> bool:
        listing = self.aws("iam", "list-policies", "--scope", "Local")
        policies = listing.get("Policies")
        if not isinstance(policies, list):
            raise ProvisionError(f"Could not completely list account policies before checking {name}.")
        if not any(p.get("Arn") == arn for p in policies):
            self.prestate[f"policy:{name}"] = "absent"
            return False
        if canonical(self.policy_document(arn)) != canonical(expected):
            raise ProvisionError(f"Existing shared policy {name} differs from the reviewed document; left unchanged.")
        self.prestate[f"policy:{name}"] = "exact-existing"
        return True

    def read_role(self) -> bool:
        listing = self.aws("iam", "list-roles")
        roles = listing.get("Roles")
        if not isinstance(roles, list):
            raise ProvisionError("Could not completely list IAM roles before checking the reader role.")
        if not any(r.get("RoleName") == ROLE for r in roles):
            self.prestate["reader_role"] = "absent"
            return False
        role = self.aws("iam", "get-role", "--role-name", ROLE).get("Role")
        if not role or canonical(role.get("AssumeRolePolicyDocument")) != canonical(TRUST_DOC):
            raise ProvisionError("Existing reader role trust differs from the exact intended trust; left unchanged.")
        if role.get("MaxSessionDuration") != MAX_SESSION or role.get("PermissionsBoundary"):
            raise ProvisionError("Existing reader role session duration or boundary is not exact; left unchanged.")
        attached = self.aws("iam", "list-attached-role-policies", "--role-name", ROLE).get("AttachedPolicies")
        if not isinstance(attached, list):
            raise ProvisionError("Could not completely list reader-role managed policies; role left unchanged.")
        attached_arns = {p.get("PolicyArn") for p in attached}
        inline = self.aws("iam", "list-role-policies", "--role-name", ROLE).get("PolicyNames")
        if not isinstance(inline, list):
            raise ProvisionError("Could not completely list reader-role inline policies; role left unchanged.")
        if attached_arns != EXPECTED_POLICIES or inline:
            raise ProvisionError("Existing reader role policies are not exactly the three expected managed policies with no inline policies; left unchanged.")
        self.prestate["reader_role"] = "exact-existing"
        return True

    def read_task_grant(self) -> bool:
        names = self.aws("iam", "list-role-policies", "--role-name", TASK_ROLE).get("PolicyNames")
        if not isinstance(names, list):
            raise ProvisionError("Could not completely list gateway task-role inline policies.")
        if ASSUME not in names:
            self.prestate["task_role_grant"] = "absent"
            return False
        doc = self.aws("iam", "get-role-policy", "--role-name", TASK_ROLE, "--policy-name", ASSUME).get("PolicyDocument")
        if canonical(doc) != canonical(ASSUME_DOC):
            raise ProvisionError("Existing task-role grant differs from the exact intended policy; left unchanged.")
        self.prestate["task_role_grant"] = "exact-existing"
        return True

    def preflight(self) -> tuple[bool, bool, bool, bool]:
        self.require_identity()
        self.discover_gateway_task_role()
        extras_exists = self.read_custom_policy(EXTRAS, EXTRAS_ARN, EXTRAS_DOC)
        deny_exists = self.read_custom_policy(DENY, DENY_ARN, DENY_DOC)
        role_exists = self.read_role()
        grant_exists = self.read_task_grant()
        self.prestate["safe_incremental_prestate"] = True
        # Existing-role exactness intentionally makes partial attachment recovery fail closed.
        return extras_exists, deny_exists, role_exists, grant_exists

    def write_once(self, args: list[str], reconcile: Callable[[], bool], label: str, rollback: str | None = None) -> None:
        """Issue a write once, then read back whether it landed; never blindly retry."""
        try:
            env = os.environ.copy()
            env["AWS_MAX_ATTEMPTS"] = "1"
            result = subprocess.run(["aws", *args, "--region", REGION, "--no-cli-pager", "--output", "json"],
                                    check=False, capture_output=True, text=True, timeout=45, env=env)
            # Ignore command output and status until readback; status may be ambiguous after timeout/network errors.
            write_status = result.returncode
        except (OSError, subprocess.TimeoutExpired):
            write_status = None
        try:
            matches = reconcile()
        except ProvisionError as exc:
            raise ProvisionError(f"Write status unknown for {label}; reconciliation readback failed. Inspect live AWS state before retrying.") from exc
        if not matches:
            status = "success" if write_status == 0 else "unknown/failure"
            raise ProvisionError(f"Write reported {status} but readback did not confirm {label}; stop and reconcile manually.")
        if write_status != 0:
            raise ProvisionError(f"Write status is unknown for {label}; readback matches, but ownership cannot be proven. Do not retry automatically.")
        if rollback:
            self.rollback.append(rollback)

    def create_policy(self, name: str, arn: str, doc: Any) -> None:
        self.write_once(
            ["iam", "create-policy", "--policy-name", name, "--policy-document", json.dumps(doc, separators=(",", ":"))],
            lambda: self.policy_document(arn) == doc,
            f"shared policy {name}", f"aws iam delete-policy --policy-arn {arn}",
        )

    def create_reader_role(self) -> None:
        role_readback = lambda: self._reader_role_matches()
        self.write_once(
            ["iam", "create-role", "--role-name", ROLE, "--assume-role-policy-document", json.dumps(TRUST_DOC, separators=(",", ":")),
             "--max-session-duration", str(MAX_SESSION), "--description", "Read-only AWS access for gateway AI bridge"],
            role_readback, f"reader role {ROLE}",
            f"aws iam delete-role --role-name {ROLE}  # after detaching listed policies",
        )

    def _reader_role_matches(self) -> bool:
        role = self.aws("iam", "get-role", "--role-name", ROLE).get("Role", {})
        return canonical(role.get("AssumeRolePolicyDocument")) == canonical(TRUST_DOC) and role.get("MaxSessionDuration") == MAX_SESSION

    def attach(self, arn: str) -> None:
        def readback() -> bool:
            policies = self.aws("iam", "list-attached-role-policies", "--role-name", ROLE).get("AttachedPolicies", [])
            return arn in {p.get("PolicyArn") for p in policies}
        self.write_once(["iam", "attach-role-policy", "--role-name", ROLE, "--policy-arn", arn], readback,
                        f"attach {arn} to {ROLE}", f"aws iam detach-role-policy --role-name {ROLE} --policy-arn {arn}")

    def strict_role_readback(self) -> None:
        role = self.aws("iam", "get-role", "--role-name", ROLE).get("Role", {})
        policies = self.aws("iam", "list-attached-role-policies", "--role-name", ROLE).get("AttachedPolicies", [])
        inline = self.aws("iam", "list-role-policies", "--role-name", ROLE).get("PolicyNames", [])
        if (canonical(role.get("AssumeRolePolicyDocument")) != canonical(TRUST_DOC)
                or role.get("MaxSessionDuration") != MAX_SESSION or role.get("PermissionsBoundary")
                or {p.get("PolicyArn") for p in policies} != EXPECTED_POLICIES or inline):
            raise ProvisionError("Strict reader-role readback failed; task-role grant was not written.")
        if canonical(self.policy_document(DENY_ARN)) != canonical(DENY_DOC):
            raise ProvisionError("The attached deny policy changed during provisioning; task-role grant was not written.")
        if canonical(self.policy_document(EXTRAS_ARN)) != canonical(EXTRAS_DOC):
            raise ProvisionError("The attached extras policy changed during provisioning; task-role grant was not written.")

    def simulate(self) -> None:
        checks = [
            ("cloudwatch:GetMetricData", "*", "allowed"),
            ("secretsmanager:GetSecretValue", f"arn:aws:secretsmanager:{REGION}:{ACCOUNT}:secret:example", "explicitDeny"),
            ("s3:GetObject", "arn:aws:s3:::example-bucket/example-key", "explicitDeny"),
            ("s3:ListBucket", "arn:aws:s3:::example-bucket", "explicitDeny"),
            ("logs:GetLogEvents", f"arn:aws:logs:{REGION}:{ACCOUNT}:log-group:example", "explicitDeny"),
            ("ssm:GetParameter", f"arn:aws:ssm:{REGION}:{ACCOUNT}:parameter/otchealth/example", "explicitDeny"),
            ("ecs:UpdateService", f"arn:aws:ecs:{REGION}:{ACCOUNT}:service/otchealth/otchealth-gateway", "implicitDeny"),
            ("ec2:RunInstances", "*", "implicitDeny"),
        ]
        for action, resource, expected in checks:
            result = self.aws("iam", "simulate-principal-policy", "--policy-source-arn", ROLE_ARN,
                              "--action-names", action, "--resource-arns", resource)
            actual = (result.get("EvaluationResults") or [{}])[0].get("EvalDecision")
            if actual != expected:
                raise ProvisionError(f"Policy simulation for {action} returned {actual!r}, expected {expected!r}; grant not written.")

    def add_task_grant(self) -> None:
        def readback() -> bool:
            doc = self.aws("iam", "get-role-policy", "--role-name", TASK_ROLE, "--policy-name", ASSUME).get("PolicyDocument")
            return canonical(doc) == canonical(ASSUME_DOC)
        self.write_once(["iam", "put-role-policy", "--role-name", TASK_ROLE, "--policy-name", ASSUME,
                         "--policy-document", json.dumps(ASSUME_DOC, separators=(",", ":"))], readback,
                        f"task-role grant {ASSUME}", f"aws iam delete-role-policy --role-name {TASK_ROLE} --policy-name {ASSUME}")

    def simulate_task_assume(self) -> None:
        result = self.aws("iam", "simulate-principal-policy", "--policy-source-arn", TASK_ROLE_ARN,
                          "--action-names", "sts:AssumeRole", "--resource-arns", ROLE_ARN)
        actual = (result.get("EvaluationResults") or [{}])[0].get("EvalDecision")
        if actual != "allowed":
            raise ProvisionError(f"Gateway task-role AssumeRole simulation returned {actual!r}; inspect the grant readback.")

    def receipt(self, status: str) -> dict[str, Any]:
        return {
            "artifact": "aws-ai-reader-role-only-2026-10-09",
            "status": status,
            "mode": "apply" if self.apply else "dry-run",
            "prestate": self.prestate,
            "planned_writes": [
                f"create {DENY} if absent", f"create {EXTRAS} if absent", f"create {ROLE} if absent",
                f"attach {DENY_ARN}", f"attach {EXTRAS_ARN}", f"attach {VIEW_ONLY_ARN}",
                f"write {ASSUME} on {TASK_ROLE} last",
            ],
            "rollback_new_state_only": list(reversed(self.rollback)),
        }

    def run(self) -> int:
        try:
            extras_exists, deny_exists, role_exists, grant_exists = self.preflight()
            if not self.apply:
                print(json.dumps(self.receipt("ready"), sort_keys=True, separators=(",", ":")))
                return 0
            # Shared deny must exist and be attached before ViewOnlyAccess is attached.
            if not deny_exists:
                self.create_policy(DENY, DENY_ARN, DENY_DOC)
            if not extras_exists:
                self.create_policy(EXTRAS, EXTRAS_ARN, EXTRAS_DOC)
            if not role_exists:
                self.create_reader_role()
            if not role_exists:
                for arn in (DENY_ARN, EXTRAS_ARN, VIEW_ONLY_ARN):
                    self.attach(arn)
            self.strict_role_readback()
            self.simulate()
            # This is the final write. Existing exact grants need no mutation.
            if not grant_exists:
                self.add_task_grant()
            self.simulate_task_assume()
            print(json.dumps(self.receipt("complete"), sort_keys=True, separators=(",", ":")))
            return 0
        except ProvisionError as exc:
            # Exception strings are authored locally and exclude uncontrolled AWS output.
            print(json.dumps({"error": str(exc), **self.receipt("stopped")}, sort_keys=True, separators=(",", ":")), file=sys.stderr)
            return 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="apply the exact plan; default is read-only dry-run")
    args = parser.parse_args(argv)
    return Provisioner(args.apply).run()


if __name__ == "__main__":
    raise SystemExit(main())
