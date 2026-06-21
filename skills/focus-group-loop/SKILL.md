# focus-group-loop — the autonomous "$10M-feel" product-improvement engine

A reusable, fleet-wide loop that turns "is the app good?" into a measurable, looping signal and
drives the builder agents to a ship-ready, premium product. Run it on ANY app, website, or product.

## The panel (20 personas, persistent across rounds)
- **10 demo customers** (ages spanning the demo, English-first). Rate /10. Question: **"Would you pay for it?"**
- **5 domain professionals** (UI eng, UX, content, brand/graphics, storyteller). Rate /10. Question:
  **"Would you present this to your clients as complete and put YOUR name on it?"** They name exact
  defects + the exact fix, they TEACH the builder.
- **5 fictional investor archetypes** (Shark-Tank-style, NOT real people, IP-safe). Rate /10.
  Question: **"Would you invest, and on what terms?"** (amount / equity % / implied valuation).

Roster: `personas.json`. Override or extend per app with `--personas <app/focus-personas.json>`
(inject the app's real demographic + domain).

## One round
```
node fgl.mjs round --app <name> --pitch <pitch.txt> [--screens <dir-of-pngs>] \
     [--round N] [--prior results/<app>-round-<N-1>.json] [--catalog]
```
Each persona reviews (vision on the screenshots), rates /10, answers their group question, and gives
feedback. Output: a scorecard (per-person), the **prioritized change list** (pro technical fixes
first), the investor offers, and the **90% gate** (PASS only when all 3 groups average >= 9.0/10).
Saved to `results/<app>-round-<N>.json` (includes per-persona memory for the next round). Exit code:
0 = passed 90%, 2 = not yet (loop continues), 1 = error.

## Make the personas actually USE the app (the visual review)
The personas judge real pixels when you pass `--screens`. To produce those screens, the orchestrating
agent, BEFORE the round:
1. Builds/serves the app (web build or the deployed URL).
2. **Screenshots the key screens** (Playwright against the URL, or `npx cap` + simulator) into a dir.
3. Runs the automated checks that catch what humans miss: broken links + console errors + `axe-core`
   a11y + layout overflow/wrapping (use the `web-qa` / Playwright skills) and append the findings to
   the pitch so the panel reacts to them too.
Pass that dir as `--screens`. gpt-4o (vision) then critiques actual alignment, typography, spacing,
contrast, wrapping/overflow, and cheap-looking elements. (Fully-autonomous click-through is the
computer-use extension, initiative #4; screenshots + automated checks are the strong v1.)

## The AUTO LOOP (run until 90%)
1. **Round N:** `fgl.mjs round ... --round N --prior <N-1> --catalog`.
2. If the gate passed (all groups >= 9.0): STOP, report the investor headline (offers + terms). Done.
3. Else: take the **prioritized change list** and drive the app-builder agent(s) to execute every
   item autonomously (the 5 professional personas' fixes are the teaching spec, build to them).
4. Re-capture screenshots, then **Round N+1** with `--prior results/<app>-round-N.json`. The SAME 20
   personas are told what they said last time, so they verify whether changes actually landed and
   re-rate.
5. Repeat. Each round should climb. Continue until all 3 groups average >= 90%.

## Cross-app learning (the compounding part)
`--catalog` writes the round's generalizable product lessons to the shared brain (`kb-memory`
`--agent focus-group --share`). Those land in the exec feed that the **memory-exec semantic index**
covers, so a focus group on iHEARtest is recalled by the AWARE / Companion / PlantID builder agents
when they ask "how do we make this feel premium". Every loop makes the WHOLE fleet's building smarter,
not just this one app. (Heavy artifacts can also be staged to a `focus-group` data room for the
librarians; the kb-memory channel is the default.)

## Cost / model
Azure OpenAI **gpt-4o** (vision, credit-funded), 20 calls/round. Set `FGL_MODEL` to override. Point
at Claude when an `anthropic-api-key` is added for higher-fidelity personas.
