"""Focused unit tests with a stateful mocked AWS CLI boundary."""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import re
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "setup/iam/aws-ai-reader-role-only-2026-10-09.py"
SPEC = importlib.util.spec_from_file_location("role_only", SCRIPT)
role_only = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(role_only)


def jcopy(value):
    return json.loads(json.dumps(value))


class MockAws:
    def __init__(self, *, account=role_only.ACCOUNT, caller_type="assumed-role", drift=None,
                 deny_preexisting=False, fail_simulation=False):
        self.account = account
        self.caller_type = caller_type
        self.fail_simulation = fail_simulation
        self.policies = {}
        if deny_preexisting:
            self.policies[role_only.DENY_ARN] = jcopy(role_only.DENY_DOC)
        if drift == "extras":
            self.policies[role_only.EXTRAS_ARN] = {"Version": "2012-10-17", "Statement": []}
        self.role = None
        self.attached = set()
        self.inline = {}
        self.calls = []
        self.writes = []
        self.attempt_limits = []

    def run(self, argv, **kwargs):
        self.attempt_limits.append(kwargs.get("env", {}).get("AWS_MAX_ATTEMPTS"))
        args = argv[1:]
        # Remove global CLI options appended by the provisioner.
        for flag in ("--region", "--no-cli-pager", "--output"):
            if flag in args:
                index = args.index(flag)
                del args[index:index + (2 if flag != "--no-cli-pager" else 1)]
        self.calls.append(args[:])
        service, operation, *rest = args
        options = {rest[i]: rest[i + 1] for i in range(len(rest) - 1) if rest[i].startswith("--") and rest[i] != "--no-cli-pager"}
        result = {}
        if (service, operation) == ("sts", "get-caller-identity"):
            arn = (f"arn:aws:sts::{self.account}:assumed-role/Admin/session" if self.caller_type == "assumed-role"
                   else f"arn:aws:iam::{self.account}:{self.caller_type}")
            result = {"Account": self.account, "Arn": arn}
        elif (service, operation) == ("ecs", "describe-services"):
            result = {"failures": [], "services": [{"serviceName": options.get("--services"), "status": "ACTIVE",
                       "taskDefinition": "arn:aws:ecs:us-east-1:900915535335:task-definition/gateway:200"}]}
        elif (service, operation) == ("ecs", "describe-task-definition"):
            result = {"taskDefinition": {"taskRoleArn": role_only.TASK_ROLE_ARN}}
        elif (service, operation) == ("iam", "list-policies"):
            result = {"Policies": [{"Arn": arn} for arn in self.policies]}
        elif (service, operation) == ("iam", "get-policy"):
            arn = options["--policy-arn"]
            if arn not in self.policies:
                return SimpleNamespace(returncode=254, stdout="", stderr="NoSuchEntity")
            result = {"Policy": {"Arn": arn, "DefaultVersionId": "v1"}}
        elif (service, operation) == ("iam", "get-policy-version"):
            result = {"PolicyVersion": {"Document": jcopy(self.policies[options["--policy-arn"]])}}
        elif (service, operation) == ("iam", "list-roles"):
            result = {"Roles": ([{"RoleName": role_only.ROLE}] if self.role else [])}
        elif (service, operation) == ("iam", "get-role"):
            if options["--role-name"] == role_only.ROLE:
                if not self.role:
                    return SimpleNamespace(returncode=254, stdout="", stderr="NoSuchEntity")
                result = {"Role": jcopy(self.role)}
            else:
                result = {"Role": {"RoleName": role_only.TASK_ROLE}}
        elif (service, operation) == ("iam", "list-attached-role-policies"):
            result = {"AttachedPolicies": [{"PolicyArn": arn} for arn in sorted(self.attached)]}
        elif (service, operation) == ("iam", "list-role-policies"):
            result = {"PolicyNames": sorted(self.inline) if options["--role-name"] == role_only.TASK_ROLE else []}
        elif (service, operation) == ("iam", "get-role-policy"):
            result = {"PolicyDocument": jcopy(self.inline[options["--policy-name"]])}
        elif (service, operation) == ("iam", "simulate-principal-policy"):
            action = options["--action-names"]
            decision = {"sts:AssumeRole": "allowed",
                        "cloudwatch:GetMetricData": "allowed",
                        "secretsmanager:GetSecretValue": "explicitDeny",
                        "s3:GetObject": "explicitDeny", "s3:ListBucket": "explicitDeny",
                        "logs:GetLogEvents": "explicitDeny", "ssm:GetParameter": "explicitDeny",
                        "ecs:UpdateService": "implicitDeny",
                        "ec2:RunInstances": "allowed" if self.fail_simulation else "implicitDeny"}[action]
            result = {"EvaluationResults": [{"EvalDecision": decision}]}
        elif (service, operation) == ("iam", "create-policy"):
            self.writes.append(operation)
            name = options["--policy-name"]
            arn = f"arn:aws:iam::{role_only.ACCOUNT}:policy/{name}"
            self.policies[arn] = json.loads(options["--policy-document"])
        elif (service, operation) == ("iam", "create-role"):
            self.writes.append(operation)
            self.role = {"RoleName": role_only.ROLE, "Arn": role_only.ROLE_ARN,
                         "MaxSessionDuration": int(options["--max-session-duration"]),
                         "AssumeRolePolicyDocument": json.loads(options["--assume-role-policy-document"])}
        elif (service, operation) == ("iam", "attach-role-policy"):
            self.writes.append(operation)
            self.attached.add(options["--policy-arn"])
        elif (service, operation) == ("iam", "put-role-policy"):
            self.writes.append(operation)
            self.inline[options["--policy-name"]] = json.loads(options["--policy-document"])
        else:
            raise AssertionError(f"Unexpected AWS CLI call: {args}")
        return SimpleNamespace(returncode=0, stdout=json.dumps(result), stderr="")

    def existing_exact_state(self):
        self.policies[role_only.DENY_ARN] = jcopy(role_only.DENY_DOC)
        self.policies[role_only.EXTRAS_ARN] = jcopy(role_only.EXTRAS_DOC)
        self.role = {"RoleName": role_only.ROLE, "Arn": role_only.ROLE_ARN,
                     "MaxSessionDuration": role_only.MAX_SESSION,
                     "AssumeRolePolicyDocument": jcopy(role_only.TRUST_DOC)}
        self.attached = set(role_only.EXPECTED_POLICIES)
        self.inline[role_only.ASSUME] = jcopy(role_only.ASSUME_DOC)


class RoleOnlyTests(unittest.TestCase):
    def invoke(self, fake, apply=True):
        out, err = io.StringIO(), io.StringIO()
        with patch.object(role_only.subprocess, "run", side_effect=fake.run), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = role_only.Provisioner(apply).run()
        return code, out.getvalue(), err.getvalue()

    def test_root_rejected_before_any_write(self):
        fake = MockAws(caller_type="root")
        code, _, error = self.invoke(fake)
        receipt = json.loads(error)
        self.assertEqual(code, 1)
        self.assertEqual(fake.writes, [])
        self.assertEqual([call[:2] for call in fake.calls], [["sts", "get-caller-identity"]])
        self.assertIn("assumed-role", receipt["error"])
        self.assertEqual(fake.attempt_limits, ["1"])

    def test_wrong_account_rejected_before_any_write(self):
        fake = MockAws(account="301001539500")
        code, _, _ = self.invoke(fake)
        self.assertEqual(code, 1)
        self.assertEqual(fake.writes, [])
        self.assertEqual(len(fake.calls), 1)

    def test_discovers_correct_gateway_service_and_grants_last(self):
        fake = MockAws()
        code, output, _ = self.invoke(fake)
        receipt = json.loads(output)
        self.assertEqual(code, 0)
        svc = next(call for call in fake.calls if call[:2] == ["ecs", "describe-services"])
        self.assertEqual(svc[svc.index("--cluster") + 1], "otchealth")
        self.assertEqual(svc[svc.index("--services") + 1], "otchealth-gateway")
        self.assertEqual(fake.writes[-1], "put-role-policy")
        self.assertLess(fake.writes.index("attach-role-policy"), fake.writes.index("put-role-policy"))
        attach_arns = [call[call.index("--policy-arn") + 1] for call in fake.calls
                       if call[:2] == ["iam", "attach-role-policy"]]
        self.assertEqual(attach_arns[0], role_only.DENY_ARN)
        self.assertEqual(attach_arns[-1], role_only.VIEW_ONLY_ARN)
        self.assertEqual(receipt["status"], "complete")

    def test_existing_shared_policy_drift_stops_without_writes(self):
        fake = MockAws(drift="extras")
        code, _, error = self.invoke(fake)
        self.assertEqual(code, 1)
        self.assertEqual(fake.writes, [])
        self.assertIn("differs from the reviewed document", json.loads(error)["error"])

    def test_rollback_never_deletes_preexisting_policy(self):
        fake = MockAws(deny_preexisting=True, fail_simulation=True)
        code, _, error = self.invoke(fake)
        self.assertEqual(code, 1)
        receipt = json.loads(error)
        rollback = receipt["rollback_new_state_only"]
        self.assertFalse(any(role_only.DENY_ARN in command and "delete-policy" in command for command in rollback))
        self.assertTrue(any(role_only.EXTRAS_ARN in command and "delete-policy" in command for command in rollback))
        self.assertTrue(any("delete-role --role-name" in command for command in rollback))
        self.assertFalse(any("delete-role-policy" in command for command in rollback))

    def test_exact_prestate_is_idempotent(self):
        fake = MockAws()
        fake.existing_exact_state()
        code, output, _ = self.invoke(fake)
        self.assertEqual(code, 0)
        self.assertEqual(fake.writes, [])
        self.assertEqual(json.loads(output)["status"], "complete")
        self.assertTrue(fake.attempt_limits)
        self.assertEqual(set(fake.attempt_limits), {"1"})

    def test_policy_documents_match_reviewed_source_byte_semantics(self):
        old = (ROOT / "setup/iam/aws-ai-access-2026-10-07.sh").read_text()
        for name, actual in (("EXTRAS_JSON", role_only.EXTRAS_DOC), ("DENY_JSON", role_only.DENY_DOC)):
            match = re.search(r"<<'" + name + r"'\n(.*?)\n" + name, old, re.S)
            self.assertIsNotNone(match, name)
            self.assertEqual(json.loads(match.group(1)), actual, name)

    def test_malformed_policy_listing_is_not_absence(self):
        class MissingCollection(MockAws):
            def run(self, argv, **kwargs):
                result = super().run(argv, **kwargs)
                if argv[1:3] == ["iam", "list-policies"]:
                    return SimpleNamespace(returncode=0, stdout="{}", stderr="")
                return result
        fake = MissingCollection()
        code, _, _ = self.invoke(fake)
        self.assertEqual(code, 1)
        self.assertEqual(fake.writes, [])

    def test_unknown_create_is_not_retried_or_claimed_owned(self):
        class UnknownCreate(MockAws):
            def run(self, argv, **kwargs):
                result = super().run(argv, **kwargs)
                if argv[1:3] == ["iam", "create-policy"]:
                    return SimpleNamespace(returncode=254, stdout="", stderr="ambiguous result")
                return result
        fake = UnknownCreate()
        code, _, error = self.invoke(fake)
        receipt = json.loads(error)
        self.assertEqual(code, 1)
        self.assertEqual(fake.writes, ["create-policy"])
        self.assertEqual(receipt["rollback_new_state_only"], [])
        self.assertIn("ownership cannot be proven", receipt["error"])

    def test_policy_drift_before_grant_stops_activation(self):
        class DriftAfterAttachment(MockAws):
            def run(self, argv, **kwargs):
                result = super().run(argv, **kwargs)
                if argv[1:3] == ["iam", "attach-role-policy"] and role_only.VIEW_ONLY_ARN in argv:
                    self.policies[role_only.EXTRAS_ARN] = {"Version": "2012-10-17", "Statement": []}
                return result
        fake = DriftAfterAttachment()
        code, _, error = self.invoke(fake)
        self.assertEqual(code, 1)
        self.assertNotIn("put-role-policy", fake.writes)
        self.assertIn("extras policy changed", json.loads(error)["error"])

    def test_existing_unexpected_trust_is_untouched(self):
        fake = MockAws()
        fake.existing_exact_state()
        fake.role["AssumeRolePolicyDocument"]["Statement"][0]["Principal"]["AWS"] = "*"
        code, _, error = self.invoke(fake)
        self.assertEqual(code, 1)
        self.assertEqual(fake.writes, [])
        self.assertIn("trust differs", json.loads(error)["error"])


if __name__ == "__main__":
    unittest.main()
