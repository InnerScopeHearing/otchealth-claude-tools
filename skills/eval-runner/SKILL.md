---
name: eval-runner
description: QA's equipment for AI features. Stands up Promptfoo evals + red-team for any in-app LLM feature (symptom chat, med-info Q&A, summarization), because deterministic tests can't judge model quality. Gates AI quality and safety (PII-leakage, hallucination, jailbreak) in CI. Use whenever a change adds or touches an LLM feature.
---

# eval-runner — gate AI quality and safety, not just code

Deterministic E2E can't tell you the model gave a safe, grounded answer. For a
health app that's a patient-safety + compliance gap. Promptfoo (MIT, OpenAI-owned)
closes it. (Do NOT build on OpenAI Evals, it sunsets Nov 30 2026.)

## When to invoke
The Builder handoff has `aiFeatureTouched: true`, or an app ships any LLM feature.

## Set up
```bash
npx promptfoo@latest init
```
Author `promptfooconfig.yaml` (start from `templates/promptfooconfig.yaml`):
- **prompts**: the app's real system+user prompt(s).
- **providers**: the model(s) the app uses (incl. on-device path if applicable).
- **tests + assert**: `contains`, `llm-rubric` (graded by a model against your rubric),
  `factuality`, `latency`, `cost`. Include health-specific rubrics: stays grounded in
  provided context, shows a disclaimer, refuses diagnosis, no medical claims the brand
  doesn't hold.

## Run as a gate
```bash
promptfoo eval -c promptfooconfig.yaml --fail-on-error   # quality gate in CI
promptfoo redteam run                                    # safety: PII leakage,
                                                          # jailbreak, hallucination
```
Fail the PR on a regression. Write `manifest.gates.evals`.

## Guardrails
PII-leakage and hallucination red-team are mandatory for any health LLM feature. Never
send real PHI through evals, use synthetic fixtures. Keep prompts/disclaimers in the web
layer so they're OTA-patchable.
