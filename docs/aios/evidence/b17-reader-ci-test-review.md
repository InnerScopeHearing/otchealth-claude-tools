# B17 source-CI regression addition

Base test: `InnerScopeHearing/otchealth-claude-tools` `main`, `setup/aws/tests/aware-reader-condition.test.mjs`, blob SHA `39b45698766cccf9b113109c3ab94324265e9d30`. This was independently matched with `git hash-object` against an existing local copy. Helper used: canonical `setup/aws/tests/fake-aws.py`, blob SHA `a1d4f8429eb1bd00d4e537a97884bd1156793123`; the local helper hash-object matches exactly.

Prepared test: [`aware-reader-condition.test.mjs`](/workspace/b17-reader-source-only/aware-reader-condition.test.mjs). It retains the existing `aws:PrincipalArn` fake-evaluator tests and adds a second test that reads and parses the candidate script's `EXTRAS_JSON` heredoc without executing the script. In CI the default candidate path is `setup/iam/aws-ai-access-2026-10-07.sh`; local verification used `AIOS_READER_POLICY_SCRIPT` and `AIOS_READER_FAKE_AWS` to point at the isolated candidate and exact local helper.

The new case asserts the exact `SchedulerGetOwnedScheduleMetadata` statement, role ARN condition, and only `scheduler:GetSchedule`. The fake evaluator then asserts: matching reader-role + matching `default/otchealth-*` schedule allowed; reader user denied; other role denied; other schedule denied; other group denied; wrong region/account denied; `ListSchedules` denied; `UpdateSchedule` denied. It also asserts the existing scoped DeviceFarm statement remains present. No AWS/provider calls and no bootstrap script execution.

RED/GREEN commands and results:

```sh
AIOS_READER_FAKE_AWS=/workspace/aios-implementation-fleet/setup/aws/tests/fake-aws.py \
AIOS_READER_POLICY_SCRIPT=/workspace/b17-reader-source-only/full-before.sh \
node --test /workspace/b17-reader-source-only/aware-reader-condition.test.mjs
```

Expected RED: 1 existing test passes; new candidate assertion fails because no Scheduler statement exists in `full-before.sh`.

```sh
AIOS_READER_FAKE_AWS=/workspace/aios-implementation-fleet/setup/aws/tests/fake-aws.py \
AIOS_READER_POLICY_SCRIPT=/workspace/b17-reader-source-only/full-candidate.sh \
node --test /workspace/b17-reader-source-only/aware-reader-condition.test.mjs
```

GREEN: 2 tests pass, 0 fail. Candidate is read as text only, never executed. The test helper matches the remote `main` helper blob.

Hashes: modified test SHA-256 `8724b97a77227368c53eff741fbb486a5aaf2841bb54a1f98e11e6056098d163`; candidate script SHA-256 `835eecc55fe69e5950579198fd6ffb928066b0c479c5dec755723f0e547a7a6b`; before script SHA-256 `ce5500f2c99f9c7b1c19f3c66ee77156c3831704d0c78f54f9482579d7e87310`.

No repository source/test file, Git ref, AWS role, policy, or provider state was changed. Root may apply this reviewed test diff through the approved publisher route alongside the policy source change.
