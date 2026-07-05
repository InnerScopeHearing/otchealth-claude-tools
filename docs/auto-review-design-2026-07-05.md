# C7-AUTOREVIEW: auto-review/classifier pre-screen for approvals

Status: **design only**. Not implemented — needs a live LLM call this sandbox can't exercise
end-to-end (no reachable Azure OpenAI credentials here, and a classifier is only as good as running it
against real historical `matt-gate` rows, which live in Cosmos, not this repo). This doc proposes a
small, concrete extension so a human/CTO can implement + tune it for real in an environment with
credentials.

## The Cursor pattern being copied

Cursor's approval flow (and similar "human-in-the-loop" agent systems) puts a cheap classifier in front
of every action that WOULD otherwise need a human approval, and only escalates the ~4% the classifier is
genuinely unsure about or that trip an explicit policy rule. Two things make that work, and both are
missing from this fleet today:

1. A **pre-screen step** that runs before the human ever sees the request, with its own binary
   decision ("auto-resolve" vs "escalate to human") — separate from the human's own judgement.
2. A **feedback loop**: when the classifier gets it wrong (a human later overrides it, or an
   auto-resolved item turns out to have mattered), that correction feeds back into the classifier's
   prompt/rubric so it self-corrects, rather than making the same misclassification forever.

## What this fleet has today

There is no generic "approval request" primitive. The closest thing is **decision-clock**'s
`category=matt-gate` rows (`skills/decision-clock/decision.mjs`) — these ARE approval-shaped: they have
an owner, an SLA (`expected_by`), a status lifecycle (`open -> ack -> closed`), and (as of the
`terminal_policy` work) an explicit policy for "what happens if nobody ever looks"
(`block`/`escalate`/`proceed`). What they do NOT have is any pre-screening: every `matt-gate` row that
gets opened sits in the queue and eventually gets a nudge via `sweep()`, with no attempt to
auto-classify "does this ACTUALLY need Matt, or could policy resolve it."

`skills/agent-evals/run-evals.mjs` already has the judge infrastructure this needs: `judge(task, rubric,
answer)` calls an LLM-as-judge with a strict "return compact JSON, one boolean per criterion" contract
(see `run-evals.mjs:72-80`). The classifier proposed below is structurally the same shape — a rubric,
one candidate row of text, one LLM call, one parsed JSON verdict — just pointed at a different question
("should a human see this?" instead of "does this answer satisfy criterion N?").

## Proposed extension: `--auto-screen` on `decision.mjs open`

Add an **optional** flag to the existing `open` verb. Nothing changes for callers who don't pass it —
this must not become a forced gate on every matt-gate open, since a broken/unreachable classifier must
never block a real approval from being opened (same fail-open discipline as everything else in
decision-clock: sweep, terminal_policy auto-close, etc.).

```
node decision.mjs open --category matt-gate --owner cto --text "..." --auto-screen
```

When `--auto-screen` is passed AND `category === "matt-gate"` (the only category that's approval-shaped
today — see "Scope" below):

1. Build a small classification prompt from the row's `text` + a short, versioned POLICY RUBRIC (see
   below) — analogous to `run-evals.mjs`'s `judge()` call, reusing the same Azure OpenAI chat plumbing
   (`chatBody`/`TIERS` from `setup/model-routing.mjs`, the same fallback-tier discipline already used by
   `run-evals.mjs` and `signal-radar`'s `groundedness.mjs` detector).
2. Parse a strict JSON verdict: `{ needs_human: true|false, reason: "one line", policy_match: "<rule-id
   or null>" }`.
3. Persist the verdict ON the row (`auto_screen: { needs_human, reason, policy_match, screened_at,
   model }`) rather than acting on it silently — the row still opens as `status: "open"` either way.
   This is the load-bearing design choice: **the classifier annotates, it does not auto-close.** A
   human (or the sweep) still makes the final call, but now sees the classifier's recommendation +
   reasoning right in the nudge line, so a human who agrees can `close` immediately instead of doing
   the analysis themselves, and — critically — **the "reason" text is exactly the self-correction
   signal**: if a human closes a row the classifier flagged `needs_human: true` with no changes, or
   REOPENS/escalates a row the classifier flagged `needs_human: false`, that disagreement is the training
   signal for tightening the rubric (see "Feedback loop" below). Auto-closing outright was considered
   and rejected for v1: matt-gate rows exist specifically because Matt wants eyes on them, and a
   classifier auto-resolving 96% of them the first week it exists, with zero human-in-the-loop
   validation of its own accuracy, is precisely the kind of silent-failure-with-blast-radius this fleet's
   fail-open/fail-safe conventions exist to prevent.

## Proposed diff sketch (small, not a full implementation)

```diff
--- a/skills/decision-clock/decision.mjs
+++ b/skills/decision-clock/decision.mjs
@@ imports
 import * as cosmos from "./cosmos-client.mjs";
+// Lazily imported only when --auto-screen is passed, so decision.mjs has zero new hard dependency on
+// model-routing / a live LLM for every other verb (open without the flag, ack, close, list, sweep,
+// metrics all continue to work exactly as today with no network call).
 
@@ async function open()
   const terminalPolicyRaw = val("--terminal-policy", "");
+  const autoScreen = FLAG("--auto-screen");
   ...
   const doc = {
     id: cosmos.newId("dec"),
     ...
     terminal_policy: terminalPolicyRaw || undefined,
+    auto_screen: undefined, // filled in below if --auto-screen requested and classification succeeds
   };
+  if (autoScreen && category === "matt-gate") {
+    try {
+      const { classifyApproval } = await import("./auto-screen.mjs");
+      doc.auto_screen = await classifyApproval(doc.text);
+    } catch (e) {
+      // FAIL-OPEN: classifier unreachable/broken never blocks opening the row, exactly like every
+      // other Cosmos/dispatch integration point in this file. Row opens with auto_screen=undefined,
+      // identical to today's behavior.
+      console.error(`[decision-clock] auto-screen skipped (${e.message}); row opens un-annotated.`);
+    }
+  }
   if (!(await cosmos.isConfigured())) { ... }
   await cosmos.createDoc(CONTAINER, owner, doc);
```

A new `skills/decision-clock/auto-screen.mjs` (NOT sketched in full here — this is the "needs a live LLM
call" part) would export `classifyApproval(text) -> { needs_human, reason, policy_match, screened_at,
model }`, structured exactly like `run-evals.mjs`'s `judge()`: same Azure OpenAI call shape, same
`TIERS`/`chatBody` from `setup/model-routing.mjs`, same "parse the first `{...}` blob, default to the
safe answer on parse failure" defensiveness — except the safe default on failure here is **`needs_human:
true`** (fail toward showing a human, not toward auto-hiding an approval — the opposite failure
direction from `run-evals.mjs`'s judge, which fails toward `false`/not-met, because there the safe
default is "don't grade it a pass," and here the safe default is "don't grade it auto-resolvable").

## The policy rubric (what the classifier is actually checking)

Not a vague "is this important" prompt — a short, versioned, explicit rule list, e.g.:

```
POLICY RUBRIC v1 (matt-gate auto-screen):
1. Does resolving this WITHOUT Matt's input risk an irreversible action (spend, legal commitment,
   public/investor-facing statement, PHI/MNPI exposure)? -> if yes, needs_human=true.
2. Is this a ROUTINE, previously-approved-pattern request (e.g. "rotate a secret per the existing
   14-day SLA", something Matt has approved the same shape of before)? -> if yes AND #1 is no,
   needs_human=false.
3. Is the row's `text` too short/ambiguous to classify confidently? -> needs_human=true (ambiguity
   always escalates; the classifier is not allowed to guess).
```

This rubric would live as its own small JSON/markdown file (versioned, like `skills/signal-radar/
schema.mjs`'s constants), NOT hardcoded inline, so it can be tuned without touching decision.mjs.

## Feedback loop (the "self-corrects" half of the Cursor pattern)

The whole point of pre-screening is wasted if disagreements vanish. Two concrete hooks, both build on
data decision-clock already writes:

- **Track disagreement events.** When a human `close`s a row where `auto_screen.needs_human === true`
  with no `--note` explaining why it needed a human after all — or, inversely, when a row the classifier
  marked `needs_human: false` ends up sitting unresolved past its SLA and gets manually escalated — that
  is a disagreement. Log it (append to the row's `notes[]`, same pattern `updateTask`/`setStatus` already
  use) as `auto_screen_disagreement: true`.
- **Periodic rubric review, not automatic rubric mutation.** Resist having the classifier rewrite its
  own rubric unsupervised (that is how a classifier drifts silently). Instead: a weekly/monthly batch
  job (mirroring `skills/agent-evals/eval-gate.mjs`'s baseline-vs-current comparison pattern) tallies
  `auto_screen_disagreement` rows and surfaces a digest line ("N/M auto-screened matt-gate rows were
  overridden this month; rubric may need a v2 rule for pattern X") — a human decides whether to bump the
  rubric version. This mirrors the eval-gate's own "report-first, enforce later once trust is
  established" posture, and reuses the SAME judge-infrastructure conventions this repo already trusts.

## Scope note: why only `matt-gate`, and why not a generic approval primitive yet

The four related roadmap items (C7/C8/C9/C11) are being closed together, but C7 deliberately does NOT
propose a new generic "approval request" object type. `matt-gate` already has everything an approval
primitive needs (owner, SLA, ack/close lifecycle, terminal policy) — extending it is a one-flag change.
Building an entirely separate `approvals` container/schema would duplicate that machinery for no
immediate benefit; if a second category ever needs pre-screening (e.g. `security-finding`), the same
`--auto-screen` flag and `auto-screen.mjs` module generalize to it by relaxing the
`category === "matt-gate"` guard above — a follow-up, not a blocker for v1.

## What's explicitly NOT built here (and why)

- **No `auto-screen.mjs` implementation.** It needs a real Azure OpenAI call this sandbox has no
  credentials to exercise, and — more importantly — a classifier with zero real matt-gate row history to
  validate against is unfalsifiable design; it should be built and tuned against actual historical rows
  in an environment with Cosmos + Azure OpenAI access, not written blind here.
- **No rubric file.** The example rubric above is illustrative; the real v1 rubric should be drafted
  with Matt/CTO input on what's actually irreversible/routine in THIS fleet, not guessed.
- **No auto-close path.** As argued above, v1 is annotate-only by design; auto-close is an explicit,
  separate, later decision once the classifier's disagreement rate is known to be low (mirrors
  `terminal_policy=proceed`'s pattern: policy-driven auto-resolution already exists in decision-clock,
  but only for the "timed out with zero human action" case, never for "the classifier said so" case yet).
