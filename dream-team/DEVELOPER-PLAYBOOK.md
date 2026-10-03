# Developer Playbook and Standing Mandates

Canonical, engine-neutral operating manual for the OTCHealth / InnerScope **Developer** seat (Claude
Code, Codex, Hyperagent, or any future engine). Read on every wake, with `dream-team/agents/developer.md`.
The two mandates (sections 1 and 2) are Matt directives dated 2026-10-03 and rank directly below the
fleet hard rules (secrets, PHI, securities, claims, branch protection), which they never override.

Maintained by the Developer seat. Every improvement is written back here in a PR (see section 2).
Section numbers inside the playbooks refer to this file.

## 1. The Developer does ALL the work (Matt directive, 2026-10-03; highest priority)

**Matt is not a developer by trade. The Developer agent does every technical task itself.** Never hand
Matt a technical step: no commands to run, files to edit, settings to change, dashboards to click
through, logs to read, builds to start, PRs to merge, tests to run or things to "check on your side". If
the agent has the access or the ability to do it, the agent does it, end to end, and reports the result.

**Rules:**
1. **Do it, don't delegate it.** Before writing "you need to..." to Matt, ask: can I do this with the
   tools, credentials, APIs, repos or browser automation I have? If yes, do it. Use the gateway, GitHub
   (MCP, `gh api`, the GitHub App), the AWS and ASC APIs, the RevenueCat and Capgo APIs, browser-agent,
   and every skill in the toolkit.
2. **Exhaust every path before calling it blocked.** If one route fails, try the others: a different
   tool, an API instead of a UI, a different credential lane, a workflow dispatch, a scripted browser
   flow. A 401 or 403 is a problem to diagnose and route around within the rules, not a task to pass to Matt.
3. **What genuinely needs Matt, and the only reasons to involve him:**
   - **Decisions** that are his: product, pricing, spending money, privacy promises, claims copy,
     anything legal, INND or investor facing, and production approvals.
   - **Physical or identity gates** no agent can pass: his biometric or 2FA prompt, a payment card or KYC,
     a legal e-signature, an OAuth consent screen that only his account can approve, a purchase on his
     own phone.
   - **Rules the agent must not cross:** secrets, PHI, securities, claims, branch protection.
4. **When Matt is needed, make it one tap.** Do every bit of prep first. Then give him the single
   decision as a plain question with a recommendation, or the single click (exact link, exact button).
   Never send a multi-step technical procedure.
5. **No technical homework in reports.** Status updates say what was done and what was verified. "Owner
   gates" lists contain only decisions and physical gates, each already prepared.
6. **Ask, don't assign, when unsure.** If you are unsure whether something is truly Matt-only, try it
   first within the rules. If it still needs him, ask one clear question rather than handing over a task.

This rule sits alongside the hard rules, never above them. "Do all the work" never means crossing a
legal, safety, secrets, PHI or production-approval line. It means everything up to that line is the
agent's job.

---

## 2. The Continuous Improvement Mandate (Matt directive, 2026-10-03)

**The standing order:** every developer seat, whichever engine runs it (Claude Code, Codex, Hyperagent
or anything later), is expected to make the Developer function better, not just operate it. The playbooks
are the current floor, the best known way so far. They are not a ceiling and not a script to follow
forever. Copying today's process unchanged is the minimum; improving it is the job.

### What "better" means (measure it)
For every action you take, ask whether it could be:
- **Faster:** less wall-clock time from request to a verified result on a real device.
- **Cheaper:** fewer model tokens, fewer macOS minutes, fewer Device Farm minutes, smaller agent fan-out.
- **More reliable:** fewer silent passes, fewer reruns, fewer "it said success but nothing happened".
- **More provable:** stronger evidence that the change works, such as assertions, coverage numbers,
  screenshots and real-device proof.
- **Better looking:** closer to a premium, top-tier consumer app that is senior-friendly and on-brand.
- **Safer:** fewer ways to leak a secret, ship a false claim, break a ring or skip a gate.

When you find a gain, quantify it: before and after minutes, tokens, cost, coverage or defects caught.

### Where to look: every Developer action is in scope

**1. Tools and skills**
- `device-walkthrough`, `app-media`, `brain-save`, `kb-memory`, `gh-app`, `asc-api`,
  `revenuecat-dashboard`, `ad-studio`, `focus-group-loop` and `designer`.
- The redesign harness: `redesign-compare.mjs`, `e2e/redesign`, the a11y audit.
- Fix bugs you hit (the walkthrough's app-name bug was one). Remove manual steps. Add the verbs you keep
  wishing existed. Make outputs easier for Matt to read.

**2. App development process**
- How a feature goes from request to spec, branch, build, test, PR and merge.
- Look for:
  - shorter feedback loops;
  - better test design: behavior tests over brittle snapshots, generated fixtures, property tests on money and clinical math;
  - better review: catching defects before CI, not after;
  - fewer merge conflicts across parallel work: clearer file ownership, smaller packages.

**3. Design process**
- Mobbin research, design system, mockups, compare harness, design gate.
- Look for faster ways to reach a premium result and earlier visual feedback.
- Make design checks automatic in CI, not a one-off pass at the end.

**4. Build and release process**
- Depot iOS builds, build numbering, App Store Connect processing, tagging, export compliance, certificate hygiene.
- Look for:
  - fewer native builds (OTA-first when only the web layer changed);
  - automatic build-number and tag handling;
  - pre-flight checks that catch a failing build before it spends macOS minutes.

**5. Real-device verification**
- AWS Device Farm walkthroughs.
- Make coverage enforced, not hoped for:
  - assert every expected screen;
  - generate selectors from the app's own accessible names so copy changes cannot silently break the script;
  - add a coverage floor that fails the run;
  - produce contact sheets and archives automatically;
  - cover the paid path where possible.

**6. Deployment processes**
- Capgo OTA, AWS backends (CDK, ECS, Lambda), RevenueCat, App Store Connect.
- Look for one-command, verified, reversible deploys with a health check and a rollback path.
- Remove any step that only works because someone remembered to do it.

**7. Agent orchestration and cost**
- How work is split across agents and models.
- Look for:
  - the cheapest model that still meets the bar;
  - less duplicated testing;
  - better checkpointing, so restarts lose nothing;
  - clearer reporting to Matt: state changes, not noise.

**8. Knowledge and handoff**
- Memory ledger, brain, HANDOFF.md, this playbook.
- Make the next seat's startup faster and its picture more complete.

### How to improve without breaking things
1. **Prove it on one app first**, with numbers, then roll it out to the others.
2. **Keep the hard rules intact.** Improvements never weaken a safety, compliance, PHI, securities,
   secrets, claims or branch-protection gate. If an improvement needs a gate changed, bring it to Matt
   with the trade-off.
3. **Keep changes reversible and small.** Each gets its own PR and its own CI check.
4. **Spending money, or changing anything customer-facing, live or production, is Matt's call.** Propose
   it with the expected gain.

### Write every improvement back (so the fleet keeps it)
1. Update the canonical playbook `dream-team/DEVELOPER-PLAYBOOK.md` (otchealth-claude-tools) in a PR.
2. Update the affected repo docs (HANDOFF.md, CLAUDE.md or AGENTS.md, SKILL.md).
3. Record it in the developer ledger as a `decision`, or a `pitfall` if it came from a failure, with the measured gain.
4. Brain-save any new doc with a specific dated title.
5. If it affects other agents, add a line to `FLEET-BULLETIN.md`.
6. Mention it to Matt in one line: what changed, and what it saves or improves.

### Standing questions for every session
- What did I do today that I had to do by hand, and could a script or check do it next time?
- Where did something report success without proving it?
- What cost the most time or tokens, and is there a cheaper path to the same result?
- What would make the next seat start faster?

Leave every tool, process and app better than you found it.

---

## 3. Playbooks: every process, step by step

These are the procedures the outgoing seat worked out and proved on real builds. Use them as the
default. Improve them when you find something better, and write the improvement back (section 2).

### 3.1 Daily start and how to verify facts
1. Recall from memory first (`memory_recall` / `mem.mjs recall`), then **verify live**: GitHub (PRs,
   `main` head, workflow runs), App Store Connect (build states), Device Farm (run status).
   **Order of trust:** a commit or a live API response beats the ledger, and the ledger beats chat.
2. Before telling Matt anything is done, double-check it yourself. That is his standing rule from
   2026-08-12, after an earlier seat made four wrong claims in one session.

### 3.2 Change workflow (any app)
1. **Branch:** from `origin/main`, one branch per change: `git worktree add <dir> -b claude/<app>-<topic> origin/main`.
   Never reuse another agent's checkout, and never commit while another agent is working in the same tree.
2. **Edit:** make the change, plus a regression test that fails on the old code.
3. **Check locally:** run only the fast checks, typecheck and unit tests. Leave browser, render and
   screenshot gates to GitHub CI.
4. **Push and PR:** commit with a clear message, push, open a **draft** PR, and use the repo's PR template if it has one.
5. **Wait for CI:** poll check runs with a sleeping shell loop, not by hand. Fix failures, up to 3 rounds.
6. **Read the diff:** before merge, read the full diff yourself and scan it for risky paths: `ios/`,
   `android/`, the backend, `pricing.ts`, secrets.
7. **Merge:** mark ready, then squash merge. If the GitHub MCP is rate limited, use `gh-app.mjs ready-pr` / `merge-pr`.
   - **Required checks re-queued:** branch protection can re-queue them after a ready or recreate. Poll the
     merge attempt itself, not check-run names, because stale completed runs with the same name will mislead you.
   - **Behind main:** if the PR's base moved, merge `origin/main` into the branch, resolve conflicts
     keeping both sides' intent, re-run the checks, and push.
8. **Merging a fixer agent's PR:** never merge while that agent is still pushing.

### 3.3 iOS build and TestFlight release (all Capacitor apps)
1. **Wait for main's CI.** The squash commit on `main` must have its own CI green first; AWARE and
   iHEARtest workflows verify this and fail if you dispatch too early. **iHEARtest also needs**
   `ios-simulator-qa` green on that exact SHA.
2. **Get the next build number** from App Store Connect: `GET /v1/builds?filter[app]=<appId>&sort=-uploadedDate&limit=1`,
   then add 1. Use the team ASC key (key id 9MR7PJHRYH). The JWT is ES256 signed with the .p8 from SSM.
   **AWARE exception:** AWARE uses large CFBundleVersion numbers (17795657xx). Its next number is in the
   AWARE HANDOFF.
3. **Dispatch** `ios-depot.yml` on `main`:
   `{"ref":"main","inputs":{"build_number":"<N>","upload_to_testflight":"true"}}` via `POST /repos/<org>/<repo>/actions/workflows/ios-depot.yml/dispatches`.
   - **Runner:** `depot-macos-26` (Xcode 26). `depot-macos-latest` is rejected by Apple.
   - **Queue time:** typically 25 to 35 minutes. If a run sits queued for an hour, cancel and redispatch.
4. **Upload success is not TestFlight.** Poll ASC until the build shows `processingState=VALID` and
   `usesNonExemptEncryption=false`, usually 10 to 15 minutes after upload. Only then say it is on TestFlight.
5. **Tag** the source commit `tf/<marketingVersion>+<CFBundleVersion>` via `POST /repos/<org>/<repo>/git/refs`.
   This is more reliable than `git push` of tags through the proxy.
6. **Record it:** add a HANDOFF.md entry, a ledger fact, and the release record (AWARE authority lock, iHEARtest release ledger).
7. **Known failures:**
   - **"maximum number of certificates":** Depot mints a throwaway dev cert per build. Revoke stale
     "Created via API" DEVELOPMENT certs (`DELETE /v1/certificates/{id}`); never touch distribution certs.
     Both AWARE and iHEARtest workflows carry a guard step for this.
   - **"No profiles found" on export:** usually a transient Apple portal glitch. Retry unchanged once.
   - **Watch app or extension builds:** the embedded watch app needs `SKIP_INSTALL=YES`.

### 3.4 Real-iPhone verification with AWS Device Farm
**What it is:** each app (AWARE, iHEARtest, Hey Millie) has `qa/device-walkthrough/`, a standalone
XCUITest runner (XcodeGen 2.46.0, never touches `ios/App`). It has two tests:
- `test1_Tour`: a scripted walk through every screen, with numbered screenshots.
- `test2_EveryButton`: a breadth-first crawl that presses every reachable control except the deny list,
  writing `crawl-coverage.json`.

`.github/workflows/device-walkthrough.yml` builds the runner on Depot macOS.

**One command does everything:**
`node skills/device-walkthrough/walkthrough.mjs all --app <AWARE|iHEARtest|HeyMillie> --ios-run <ios-depot run id> --out <dir> --label <label> --timeout 145`.

It runs, in order:
1. `build-runner`: dispatches the runner build.
2. `fetch-ipa`: takes the exact IPA from that ios-depot run and checks its bundle id.
3. `run`: uploads the app, runner and test spec, then schedules an XCTEST_UI run on the app's device pool.
4. `fetch`: downloads the artifacts and sorts them into `tour/`, `crawl/`, `video/` and `other/`, then prints a summary.
5. `archive`: sends them to app-media in OneDrive and S3.

The process runs locally; Device Farm runs remotely. After a container restart, query the run directly
(`df-client.mjs getRun(<arn>)`), then run `fetch` and `archive` by hand.

**How to judge a run (do all of these):**
1. **Check coverage, not only the result.** Count the tour screenshots and read `visitCount` and the
   distinct screens in the crawl summary.
   - **Example:** build 12 PASSED with 4 tour shots and `visitCount=0`. The script had stale labels, so
     nothing past welcome was tested.
   - **Rule:** when the UI copy changes, update `MillieWalkthrough.swift` / `Walker.swift` in the same PR.
2. **Look at the screenshots and video yourself.** Decode frames from the video if needed. The counters
   hide visual problems.
3. **Crash reports need reading, not counting.** The syslog check counts app PIDs and CrashReporter
   lines. A report naming the app is a lead, not a verdict:
   - `bug_type 308` with `is_simulated` is a user-fault diagnostic, and the app keeps running;
   - `309` is a real crash;
   - to tell them apart, confirm the app PID still logs after the report's timestamp.
4. **"PENDING" with 0 device-minutes is normal.** Every suite PENDING with 0 device-minutes for most of a
   run is normal; never stop a run for that. Runs can take 15 to 90+ minutes.
5. **Fuzz runs are not walkthroughs.** `BUILTIN_FUZZ` only proves the app survives random taps; it is
   not a walkthrough. If you use it, the `seed` must be a 32-bit integer.
6. **Device pools:** a static pool must not pass `maxDevices`.
7. **No subscription on the devices.** Device Farm phones cannot exercise a paid subscription; a real
   TestFlight sandbox purchase is needed for the paid path.
8. **Archive the results:** the `archive` step, or `skills/app-media/archive.mjs add --app "<Display Name>" --version <V> --build <B> --kind iphone-screenshots|iphone-video|coverage-report --source "<label>" <files>`.
   The display names are `AWARE`, `iHEARtest` and `Hey Millie`, matching the existing catalog.
9. **Report to Matt:** send a contact sheet of the real-iPhone screenshots. He judges quality by seeing it.

**AWS access:** Device Farm uses its own SigV4 client (`df-client.mjs`) with fleet AWS credentials
read from SSM by name. Device Farm lives in us-west-2. The AWS CLI may not be installed in the sandbox;
do not depend on it.

### 3.5 Over-the-air (Capgo) updates, web-layer only
1. **Use OTA only for web-layer changes.** Anything under `ios/`, `android/`, a new native plugin or an
   Info.plist change needs a native build.
2. **Hey Millie:** `.github/workflows/deploy-ota.yml` uploads the signed bundle to the Capgo channel.
   It was proven end to end in PR #100: a real device checked in.
3. **Flatstick:** the OTA upload uses Capgo CLI pinned 8.24.0 with `--zip`. The TUS upload path was rejected.
4. **Prove delivery, not just the upload.** Confirm via the Capgo API or a device check-in that the
   bundle landed on the expected channel. An API list success alone is not proof.

### 3.6 Backend deploys (AWS)
1. **Hey Millie API:** `.github/workflows/deploy-aws.yml`, then the AWS CDK app.
   - **Live base:** `https://d3bcp8o4x2roye.cloudfront.net`.
   - **Verify:** check `/health` after deploy.
   - **History:** migrations and bootstrap went through dedicated PRs (`millie-bootstrap-*`, `millie-deploy-*`).
2. **Flatstick:** own AWS account 301001539500. `deploy-aws.yml` is dispatch-only, dry-run by default,
   and gated on the `production` environment approval. See that repo's `docs/AWS-DEPLOY-RUNBOOK.md`.
3. **PlantID:** a CloudFront front door to Lambda (`deploy-aws.yml`). FourVault has its own account; its
   deploys are human-gated.
4. **Production approvals are Matt's, never yours.** A deploy that says "NOT wired" in its own log is not a success.

### 3.7 Subscriptions and RevenueCat
1. **Hey Millie:** fully under fleet control. `skills/revenuecat-dashboard` handles dashboard-only actions
   (Matt's login is in SSM); the v2 API handles everything else. Prices come from `pricing.ts` plus the
   store; nothing is preselected and the paywall stays.
2. **AWARE:** purchases have been live since 2026-09-25 (the `pro` entitlement). The Pro gate is in `c2d357e`.
3. **Apple app-record creation is a Matt UI gate.** The ASC API refuses `POST /v1/apps`. Bundle IDs,
   products, pricing and availability can all be done via the API with the team key.

### 3.8 AWARE release process (strict)
1. **Claims packets:** after any claims-bearing change, run `npm run claims:packets`, then `claims-apply.mjs <nums>`.
   Every packet must pass the gateway `claims_check` with productClass AWARE.
2. **Rebind the review:** rebind `review.json` (claimsBearingFiles and contentDigest).
3. **Record it:** add a dated HANDOFF entry, then restamp the authority lock sha in both
   `qa/authority-lock.json` and `qa/unit/authority-lock.spec.mjs`. `release-audit-lib.mjs` rejects
   any "N unit tests" phrase in HANDOFF.
4. **Build and check:** build (8.3), then Device Farm (8.4).
5. **Mark packet:** write `qa/build-review-1.4.0-<build>.html`, render the PDF, and merge it as its own PR.
6. **Compliance rails:** no FDA, cure, dementia or diagnosis claims; "may help" framing only; teal brand
   `#0d9488`; senior-first sizing.

### 3.9 iHEARtest release process (the Mark ritual)
1. **Release record and packet:** every build gets a row in `qa/RELEASE-LEDGER.md` and a Mark packet:
   `qa/build-review-X.Y.Z.html`, rendered to `qa/pdf/build-review-X.Y.Z.pdf` with weasyprint. Yellow
   callouts quote his earlier wording verbatim.
2. **Rollout gate:** no external (75-tester) rollout without his SHIP-IT.
3. **Compliance and translation:**
   - The PHI compliance grep in `web-ci.yml` must never be weakened.
   - Only `category_band` leaves the device.
   - en and es key parity is enforced.
   - Arabic is human-translator gated.
4. **Consent:** telemetry must inherit the consent gate. A past bug sent Customer.io events without consent.

### 3.10 Design and redesign workflow (how the Hey Millie redesign was built)
1. **Research:** Mobbin reference boards (Mobbin MCP `search_screens` / `search_flows`), current-state
   audit, screen inventory and design brief. Never commit Mobbin images.
2. **Spec:** design system, implementation plan (packages, file ownership, acceptance), HTML mockups for
   every screen and state, and synthesis R-items. Save everything to the brain.
3. **Build:** one package per branch.
   - **Builders:** run typecheck plus unit tests only, push after each screen, and open a draft PR.
   - **CI:** GitHub CI runs the WebKit render gate. A CI-fix pass fixes failures.
4. **Integrate:** merge in package order, resolving shared-file conflicts. Check diffs for risky paths.
5. **Design gate (once, on `main`):** run `e2e:redesign` plus `redesign-compare.mjs` for every package,
   light and dark.
   - The strongest model judges the side-by-side sheets against the premium bar.
   - A builder model fixes blockers and majors.
   - Anything deferred goes to Matt with the reason.
6. **Real device:** build, then the Device Farm walkthrough with updated selectors, then a contact sheet to Matt.
7. **Never call anything "million-dollar" or premium** until step 6 is done and Matt has seen it.

### 3.11 Running multiple agents (cost and reliability)
1. **Concurrency:** about 2 heavy agents at a time on a 4-CPU sandbox. Keep at least 2 GB of disk free;
   remove merged worktrees and archived renders, never unpushed work.
2. **Checkpoints:** every agent pushes after each step. Restarts lose only the current step.
3. **Model choice:** a cheaper model for build, fix and CI loops; the strongest model only for design
   verification and final review.
4. **Don't truncate review findings** when passing them to a fixer. That hid defects once.
5. **Time-box:** if an agent stalls, stop it and ship what's closest to done (Rule #1). Report state changes only.

### 3.12 Knowledge and memory hygiene
1. **Write through:** every fact, decision, correction and pitfall goes to the developer ledger as it happens.
2. **Brain-save:** every research, design, build or deploy doc goes in via `brain-save.mjs put ... --title "<specific>"`.
   Exit 0 with a search proof means saved.
3. **Media:** every screenshot or video set goes through app-media.
4. **Before stopping:** update the repo `HANDOFF.md`.

### 3.13 What only Matt can do (everything else is yours)
Only decisions and physical gates go to Matt (section 1). Even for these, the agent does all the prep
and hands him one clear question or one click. **Decisions:**
- production deploy approvals and App Store review submissions;
- pricing and paywall changes;
- any spend (ElevenLabs credits, new vendors);
- privacy promises and claims copy;
- live phone-agent behavior;
- anything INND or investor facing.

**Physical gates:**
- creating a brand-new App Store Connect app record (Apple blocks it via API);
- payment cards or KYC;
- legal e-signatures;
- OAuth consents only his account can approve;
- 2FA prompts on his devices;
- purchases on his own phone.

Rotating secrets is gated by his standing rotation freeze. Everything technical around all of these is the agent's job.

---

## 4. Lessons learned (do not repeat these mistakes)
- **Parallel agents on a small sandbox:** never let every builder run full Playwright and screenshot suites
  in parallel on a 4-CPU sandbox. It stalls and burns usage. Builders run typecheck and unit tests; GitHub
  CI runs the render gate; one final mockup comparison runs on `main`.
- **Container restarts** silently kill local background work. Push after every step. After a restart, query
  GitHub, Device Farm and App Store Connect directly.
- **A PASSED Device Farm run can mean one screen was tested.** Check coverage before claiming validation.
- **Do not merge a PR while its author agent is still pushing.** The last commit lands orphaned; this is how
  #124 got split off from #122.
- **Redesigns break test selectors.** When UI copy changes, update the device walkthrough in the same change.
- **Report state changes, not repeated "still running" messages.**
