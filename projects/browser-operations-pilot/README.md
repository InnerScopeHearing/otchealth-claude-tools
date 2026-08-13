# Browser Operations Pilot — AWS AgentCore Browser

## Objective

Create a controlled, AWS-native browser-execution lane for repeatable non-financial web tasks that cannot be completed through an existing API or MCP tool. This package is a pilot implementation: it contains policy, tests, read-only capability preflight, and CI validation. It does not create an AWS browser, browser profile, secret, paid vendor subscription, or production traffic.

The intended runtime is Amazon Bedrock AgentCore Browser, controlled through Playwright over CDP. It supplies isolated browser sessions and operator handoff through Live View. Browserless OSS on ECS remains an optional future fallback, not a dependency.

## Mandatory controls

- Non-PHI and non-MNPI work only.
- Prefer APIs and existing gateway tools over browser control.
- Require an exact domain allowlist, named provider, named role, bounded steps, and bounded duration.
- Require a non-secret persistent profile identifier per provider and role.
- Enforce one active lease for a profile. Never share profiles across providers, roles, or agents.
- Reject payment, KYC, legal e-signature, and 2FA pages. 2FA requires an operator to take over through Live View; no bypass path exists.
- Emit only redacted audit metadata. Secret values, profile contents, cookies, and OAuth codes are never put into logs or source.
- Resolve AWS credentials from Key Vault only at execution time. No secret values belong in source control.

## Validation performed

- Policy tests prove allowlist suffix protection, hard-gate detection, 2FA detection, named-profile enforcement, explicit persistence, bounded execution, and lease exclusivity.
- AWS identity preflight succeeds with the Key Vault-backed CTO AWS principal without exposing secret values.
- AgentCore endpoint preflight confirms the us-east-1 service endpoint is reachable. The expected 404 from the guessed read-only discovery path confirms network and SigV4 reachability only; it does not create or mutate any AgentCore resource.

## Follow-on deployment gate

A separate reviewed deployment change must verify the current AgentCore Browser API shape, regional quotas, budget/credit envelope, IAM least privilege, CloudTrail/S3 retention, and the first single non-financial internal flow. It must use a dedicated runtime role and cannot reuse the broad CTO provisioning principal.
