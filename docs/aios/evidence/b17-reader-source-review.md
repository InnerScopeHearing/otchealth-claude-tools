# B17 reader policy source review

PASS source candidate; zero open Important/Critical findings. Live permission remains unrepaired.

The candidate adds exactly11lines: only scheduler:GetSchedule, scoped to account900915535335/us-east-1/default/otchealth-* and the existing reader role via ArnEquals aws:PrincipalArn. The shared IAM user does not receive this new grant. Removing the statement restores all original bytes; complete extras-minus-statement JSON, deny and billing policies remain unchanged. Canonical before blob43824dc11112fc6e3ec8b37c624dcf51413c2e38 independently matches.

Full bash syntax passes. Offline scope and existing fake-IAM tests verify exact-role allow, other-principal/scope/action refusals, and explicit-deny precedence. One official AWS read confirms role ARN context semantics.

Before normal source CI acceptance, extend the existing policy-source/aware-reader-condition test to assert the actual scheduler statement and its negative cases. No new framework or full bootstrap execution is needed.

No provider IAM call, grant, role/trust/writer/deny change or script execution occurred. Effective live access, permission boundaries/SCPs, runtime identity and response minimization remain separate verification gates.

| Frozen source | SHA-256 |
| --- | --- |
| /workspace/b17-reader-source-only/full-before.sh | ce5500f2c99f9c7b1c19f3c66ee77156c3831704d0c78f54f9482579d7e87310 |
| /workspace/b17-reader-source-only/full-candidate.sh | 835eecc55fe69e5950579198fd6ffb928066b0c479c5dec755723f0e547a7a6b |

Detailed source/evaluator evidence and publication boundaries are in b17-reader-source-review.json.

