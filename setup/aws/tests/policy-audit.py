#!/usr/bin/env python3
"""policy-audit.py: audits the policies that setup/iam/aws-ai-access-2026-10-07.sh saved in the PRETEND account.

It reads the account that fake-aws.py kept (FAKE_AWS_DIR/state.json) and the manifest billing-read-actions.tsv. It only
reads two local files: it never reaches AWS, never opens a socket and changes nothing. It imports only the Python
standard library, plus fake-aws.py itself (so the audit applies the same IAM rule as the pretend simulator).

  python3 -I -S policy-audit.py STATE_JSON MANIFEST_TSV GROUP [--no-role] [--no-user]

GROUP is one of these, so that a failing test names what broke:
  attached   the billing policy and the deny policy are attached to the user and to the role
  manifest   the saved billing policy is ONE Allow statement whose actions are exactly the ones in the manifest, with
             no wildcard, and every one of them is marked Read or List in the AWS Service Authorization Reference
  writes     no Allow statement in any saved policy can match a write verb (Create, Update, Delete, Modify, Put,
             Purchase, Accept, Cancel); the billing policy gets no exception, one older grant is named below
  reads      the IAM rule applied to the saved policies: every manifest action is allowed (so no Deny blocks it),
             and none of the write actions of the same services is allowed
  denies     the explicit denies are still there and still win: secret, data, payment, shell and IAM-credential
             actions are denied for the user and the role

It prints one "AUDIT-FAIL: ..." line per finding and a last line "AUDIT <group>: N checks, M failed".
Exit code: 0 when nothing failed, 1 when anything failed, 2 for a bad command line.
"""
import importlib.util
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True  # loading fake-aws.py must not leave a __pycache__ folder in the repository
spec = importlib.util.spec_from_file_location("fake_aws", os.path.join(HERE, "fake-aws.py"))
fake = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fake)

USER = "otchealth-ai-reader"
ROLE = "otchealth-ai-reader-role"
BILLING = "otchealth-ai-reader-billing"
DENY = "otchealth-ai-reader-deny"
BILLING_SID = "CostAndBillingReadOnly"
WRITE_VERBS = ("Create", "Update", "Delete", "Modify", "Put", "Purchase", "Accept", "Cancel")
# The one Allow that has a write verb in its name and was there before the billing policy: the user may create its OWN
# virtual MFA device (inline policy otchealth-ai-reader-self-mfa, scoped to mfa/* in this account). Nothing else.
OLDER_GRANTS = {"iam:CreateVirtualMFADevice"}
DENY_SIDS = {
    "NoSecretOrKeyValues", "NoDataContent", "NoFileNames", "NoConfigThatHoldsSecrets", "NoShellOrRemoteExec",
    "NoPaymentsOrPaymentMethods", "NoCredentialOrPermissionChanges", "NoApiGatewayStageVariables",
}
# Actions of the same services that change, buy, pay or cancel: none of them may be allowed. aws-portal is the retired
# namespace: it must not be used.
WRITE_PROBES = [
    "budgets:ModifyBudget", "budgets:ExecuteBudgetAction", "budgets:CreateBudgetAction", "budgets:UpdateBudgetAction",
    "ce:CreateAnomalyMonitor", "ce:UpdateAnomalySubscription", "ce:CreateCostCategoryDefinition",
    "ce:UpdateCostCategoryDefinition", "ce:DeleteCostCategoryDefinition", "ce:UpdateCostAllocationTagsStatus",
    "ce:TagResource", "ce:StartCommitmentPurchaseAnalysis", "ce:ProvideAnomalyFeedback", "ce:CreateReport",
    "savingsplans:CreateSavingsPlan", "savingsplans:ReturnSavingsPlan", "savingsplans:DeleteQueuedSavingsPlan",
    "cost-optimization-hub:UpdateEnrollmentStatus", "cost-optimization-hub:UpdatePreferences",
    "compute-optimizer:PutRecommendationPreferences", "compute-optimizer:UpdateEnrollmentStatus",
    "compute-optimizer:ExportEC2InstanceRecommendations", "compute-optimizer:DeleteRecommendationPreferences",
    "billing:RedeemCredits", "billing:SplitCredit", "billing:TransferCredit", "billing:UpdateBillingPreferences",
    "billing:UpdateIAMAccessPreference", "billing:PutContractInformation", "billing:CreateBillingView",
    "billing:GetResourcePolicy", "billing:PutResourcePolicy",
    "account:PutContactInformation", "account:PutAlternateContact", "account:StartPrimaryEmailUpdate",
    "account:CloseAccount", "account:EnableRegion",
    "tax:PutTaxRegistration", "tax:BatchPutTaxRegistration", "tax:DeleteTaxRegistration", "tax:UpdateExemptions",
    "invoicing:PutInvoiceEmailDeliveryPreferences", "invoicing:CreateInvoiceUnit", "invoicing:StartInvoiceCorrection",
    "cur:PutReportDefinition", "cur:DeleteReportDefinition", "freetier:PutFreeTierAlertPreference",
    "aws-portal:ViewBilling", "aws-portal:ViewUsage", "aws-portal:ViewAccount", "aws-portal:ModifyBilling",
    "aws-portal:ModifyAccount",
]
# Actions the deny policy must keep blocking (action, resource).
DENY_PROBES = [
    ("secretsmanager:GetSecretValue", "*"), ("ssm:GetParameter", "*"), ("ssm:GetParametersByPath", "*"),
    ("kms:Decrypt", "*"), ("s3:GetObject", "*"), ("s3:ListBucket", "*"), ("logs:GetLogEvents", "*"),
    ("logs:StartQuery", "*"), ("dynamodb:GetItem", "*"), ("es:ESHttpGet", "*"), ("sqs:ReceiveMessage", "*"),
    ("lambda:GetFunctionConfiguration", "*"), ("lambda:ListFunctions", "*"), ("ecs:DescribeTaskDefinition", "*"),
    ("ecs:ExecuteCommand", "*"), ("ssm:StartSession", "*"), ("payments:ListPaymentInstruments", "*"),
    ("payments:MakePayment", "*"), ("payments:GetPaymentInstrument", "*"), ("aws-portal:ViewPaymentMethods", "*"),
    ("iam:CreateAccessKey", "*"), ("iam:AttachUserPolicy", "*"), ("iam:PutRolePolicy", "*"),
    ("iam:CreatePolicyVersion", "*"), ("apigateway:GET", "arn:aws:apigateway:us-east-1::/restapis/abc123/stages/prod"),
]


class Audit:
    def __init__(self, group):
        self.group = group
        self.checks = 0
        self.failed = 0

    def check(self, ok, message):
        self.checks += 1
        if not ok:
            self.failed += 1
            print("AUDIT-FAIL: " + message)
        return ok

    def finish(self):
        print("AUDIT %s: %d checks, %d failed" % (self.group, self.checks, self.failed))
        return 1 if self.failed else 0


def load_manifest(path):
    rows = []
    with open(path) as handle:
        for number, line in enumerate(handle, 1):
            line = line.rstrip("\n")
            if not line or line.startswith("#"):
                continue
            parts = line.split("|")
            if len(parts) != 3:
                raise SystemExit("AUDIT-FAIL: %s line %d does not have 3 columns (action|access level|page)" % (path, number))
            rows.append(tuple(parts))
    return rows


def policy_doc(world, name):
    entry = world["iam"]["policies"].get(name)
    if not entry:
        return None
    return [v["doc"] for v in entry["versions"] if v["default"]][0]


def principals(world, want_user, want_role):
    """(label, arn, state key) of the principals to audit."""
    rows = []
    if want_user:
        rows.append(("user", "arn:aws:iam::%s:user/%s" % (fake.ACCOUNT, USER), "user:" + USER))
    if want_role:
        rows.append(("role", "arn:aws:iam::%s:role/%s" % (fake.ACCOUNT, ROLE), "role:" + ROLE))
    return rows


def statements_of(doc):
    statements = doc["Statement"]
    return [statements] if isinstance(statements, dict) else list(statements)


def group_attached(audit, world, manifest, who):
    for label, _, key in who:
        have = world["iam"]["attached"].get(key, [])
        for name in (BILLING, DENY):
            audit.check(fake.policy_arn(name) in have, "the %s %s does not have policy %s attached" % (label, key.split(":", 1)[1], name))
    for name in (BILLING, DENY):
        audit.check(policy_doc(world, name) is not None, "policy %s is not in the account" % name)


def group_manifest(audit, world, manifest, who):
    names = [row[0] for row in manifest]
    audit.check(len(names) > 0, "the manifest is empty")
    audit.check(len(set(names)) == len(names), "the manifest lists an action twice")
    for action, level, page in manifest:
        audit.check(level in ("Read", "List"), "manifest: %s is marked %r, only Read or List is allowed" % (action, level))
        audit.check(re.match(r"^[a-z0-9-]+:[A-Za-z0-9]+$", action) is not None, "manifest: %r is not a plain action name (no wildcard)" % action)
        audit.check(page.startswith("list_") and page.endswith(".html"), "manifest: %s has no Service Authorization Reference page" % action)
    doc = policy_doc(world, BILLING)
    if not audit.check(doc is not None, "policy %s is not in the account" % BILLING):
        return
    statements = statements_of(doc)
    audit.check(doc.get("Version") == "2012-10-17", "the billing policy has no Version 2012-10-17")
    if not audit.check(len(statements) == 1, "the billing policy has %d statements, expected exactly 1" % len(statements)):
        return
    statement = statements[0]
    audit.check(set(statement) <= {"Sid", "Effect", "Action", "Resource"}, "the billing statement has unexpected elements: %s" % sorted(set(statement) - {"Sid", "Effect", "Action", "Resource"}))
    audit.check(statement.get("Sid") == BILLING_SID, "the billing statement Sid is %r, expected %s" % (statement.get("Sid"), BILLING_SID))
    audit.check(statement.get("Effect") == "Allow", "the billing statement Effect is %r" % statement.get("Effect"))
    audit.check(statement.get("Resource") == "*", "the billing statement Resource is %r, expected *" % (statement.get("Resource"),))
    actions = statement.get("Action")
    if not audit.check(isinstance(actions, list), "the billing statement Action is not a list"):
        return
    audit.check(len(set(actions)) == len(actions), "the billing statement lists an action twice")
    audit.check(not any("*" in a or "?" in a for a in actions), "the billing statement uses a wildcard: %s" % [a for a in actions if "*" in a or "?" in a])
    missing = sorted(set(names) - set(actions))
    extra = sorted(set(actions) - set(names))
    audit.check(not missing, "the billing policy lacks %d action(s) of the manifest: %s" % (len(missing), ", ".join(missing[:6])))
    audit.check(not extra, "the billing policy holds %d action(s) that are not in the manifest: %s" % (len(extra), ", ".join(extra[:6])))


def can_match_write(pattern):
    """The write verb this action name (or wildcard) can stand for, or None."""
    service, _, name = pattern.partition(":")
    for verb in WRITE_VERBS:
        if name.startswith(verb):
            return verb
        if fake.glob_match(pattern, service + ":" + verb + "Example", fold=True):
            return verb
    return None


def group_writes(audit, world, manifest, who):
    sources = []
    for name, entry in sorted(world["iam"]["policies"].items()):
        sources.append(("policy " + name, [v["doc"] for v in entry["versions"] if v["default"]][0], name == BILLING))
    for key, docs in sorted(world["iam"]["inline"].items()):
        for name, doc in sorted(docs.items()):
            sources.append(("inline policy %s on %s" % (name, key), doc, False))
    audit.check(any(s[2] for s in sources), "the billing policy is not in the account, so it could not be audited")
    for label, doc, strict in sources:
        for statement in statements_of(doc):
            if statement.get("Effect") != "Allow":
                continue
            if not audit.check("NotAction" not in statement, "%s: an Allow with NotAction can allow a write action" % label):
                continue
            for action in fake.listed(statement.get("Action")):
                verb = can_match_write(action)
                ok = verb is None or (not strict and action in OLDER_GRANTS)
                audit.check(ok, "%s: Allow %s can match the write verb %s" % (label, action, verb))


def group_reads(audit, world, manifest, who):
    for label, arn, key in who:
        blocked = []
        for action, _, _ in manifest:
            decision = fake.evaluate(world, arn, action, "*")
            if decision != "allowed":
                blocked.append("%s (%s)" % (action, decision))
        audit.check(not blocked, "the %s cannot use %d manifest action(s): %s" % (label, len(blocked), ", ".join(blocked[:6])))
        allowed = []
        for action in WRITE_PROBES:
            if fake.evaluate(world, arn, action, "*") == "allowed":
                allowed.append(action)
        audit.check(not allowed, "the %s is allowed %d write action(s): %s" % (label, len(allowed), ", ".join(allowed[:6])))


def group_denies(audit, world, manifest, who):
    doc = policy_doc(world, DENY)
    if audit.check(doc is not None, "policy %s is not in the account" % DENY):
        statements = statements_of(doc)
        audit.check(all(s.get("Effect") == "Deny" for s in statements), "the deny policy holds a statement that is not a Deny")
        have = {s.get("Sid") for s in statements}
        audit.check(DENY_SIDS <= have, "the deny policy lost statement(s): %s" % ", ".join(sorted(DENY_SIDS - have)))
    for label, arn, key in who:
        loose = []
        for action, resource in DENY_PROBES:
            decision = fake.evaluate(world, arn, action, resource)
            if decision != "explicitDeny":
                loose.append("%s (%s)" % (action, decision))
        audit.check(not loose, "the %s is not explicitly denied %d action(s): %s" % (label, len(loose), ", ".join(loose[:6])))


GROUPS = {
    "attached": group_attached,
    "manifest": group_manifest,
    "writes": group_writes,
    "reads": group_reads,
    "denies": group_denies,
}


def main(argv):
    flags = [a for a in argv if a.startswith("--")]
    args = [a for a in argv if not a.startswith("--")]
    if len(args) != 3 or args[2] not in GROUPS or any(f not in ("--no-role", "--no-user") for f in flags):
        sys.stderr.write(__doc__)
        return 2
    state_path, manifest_path, group = args
    with open(state_path) as handle:
        world = json.load(handle)
    manifest = load_manifest(manifest_path)
    who = principals(world, "--no-user" not in flags, "--no-role" not in flags)
    audit = Audit(group)
    try:
        GROUPS[group](audit, world, manifest, who)
    except fake.Gap as gap:
        audit.check(False, "the pretend simulator cannot answer: %s" % gap)
    return audit.finish()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
