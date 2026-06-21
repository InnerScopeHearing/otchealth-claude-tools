---
name: browser-agent
description: A hardened, audited, on-demand headless browser the fleet drives to shrink the SOFT human gates, OAuth consents, account signups, and portal clicks (the exact Xero-OAuth friction we keep hitting). Fully autonomous on NON-FINANCIAL consents per Matt's 2026-06-21 directive; it STOPS and escalates at the HARD gates (payment, KYC, legal e-signature) and at 2FA. Every run is governed by a required domain allowlist, a payment/KYC/e-signature detector, a 2FA detector, a full JSONL audit log plus per-step screenshots, secret values pulled from Secret Manager (never logged), bounded steps/time, and OAuth-redirect capture (extracts the ?code= to hand to a token-exchange skill). Use to complete an OAuth consent or a portal click-path without a human. Non-PHI ring. Run as: node skills/browser-agent/browser.mjs run <flow.json>. Requires playwright (npm i playwright + chromium).
---

# browser-agent — shrink the soft human gates (hardened, audited browser automation)

Initiative #4 of the Fleet Intelligence program. Closes the OAuth-consent / signup / portal-click
friction that keeps interrupting the fleet (Xero re-consent is the canonical case), while keeping the
HARD gates human. Matt's posture (2026-06-21): fully autonomous on NON-financial consents; STOP at
payment, KYC, and legal e-signature.

## Why this design
- **On-demand, not a standing service.** Consents are occasional. The agent composes a flow, runs it
  in one bounded process, reviews the screenshots/result, and tears down. No always-on browser holding
  credentials.
- **Scripted flow, not free roam.** The whole flow is declared up front (goto/fill/click/capture), so
  every action is allowlist-checked, gate-scanned, and audit-logged before it happens. Safer + auditable.
- **The agent is the brain.** Run a flow, read the returned per-step screenshots + aria text, and if a
  selector missed or the page differs, revise the flow and re-run. (Claude is vision-capable, so the
  screenshots are first-class feedback.)

## Security rails (the point of the skill)
1. **Domain allowlist (required).** No open browsing. Only allowlisted hosts (+subdomains); any off-list
   navigation aborts the run (`DISALLOWED_HOST`).
2. **Hard-gate detector.** After every step the page text is scanned for payment/KYC/e-signature signals
   (card number, CVV, SSN, DOB, passport, DocuSign, "sign here", routing/bank-account, ...). A hit STOPS
   the run with `HARD_GATE` and a screenshot, for a human. These gates stay human, always.
3. **2FA detector.** A one-time-code / "approve on your phone" page stops with `TWOFA_GATE`. 2FA on the
   IdP login is the real wall; the human approves, then you resume the flow from the next step.
4. **Audit log.** `audit/<task>-<ts>/log.jsonl` records every action with timestamp, target, resulting
   URL, screenshot path, and gate status. Secret VALUES are never written (only `<secret $NAME>`).
5. **Secrets from Secret Manager.** `"$NAME"` in a step resolves from the flow's `secrets` map; `sm:<id>`
   pulls the value from `otchealth-shared-prod` at run time. Values never reach chat, stdout, or the log.
6. **Bounds.** `max_steps` (default 30) and `max_seconds` (default 240); exceeding either aborts.
7. **Redirect capture.** Watches for the OAuth `redirect_uri` and writes the full URL (with `?code=`) to
   `audit/<...>/captured-redirect.txt` (0600). stdout only shows a truncated code. Hand the code to the
   matching token-exchange skill (e.g. `xero`).

## Use
```
node skills/browser-agent/browser.mjs schema          # the flow spec + an example
node skills/browser-agent/browser.mjs run flow.json   # execute; prints a JSON result + writes the audit dir
```
Result status: `OK` | `HARD_GATE` | `TWOFA_GATE` | `DISALLOWED_HOST` | `TIMEOUT` | `ERROR`. Exit 0 on OK,
3 on a gate (human needed), 1 otherwise.

## Setup (sandbox)
Proven to run in the cloud sandbox. Install once per session:
```
npm i playwright && PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium
# then run browser.mjs with PLAYWRIGHT_BROWSERS_PATH=0 if chromium went into node_modules
```

## Real-world notes (read before wiring a provider)
- **2FA is the actual gate.** Most IdP logins (Google, Microsoft, Xero) enforce 2FA. The agent drives up
  to the 2FA prompt, then stops for the human's approval tap; it does NOT defeat 2FA. So "fully
  autonomous consent" in practice means autonomous EXCEPT the 2FA tap, which collapses a multi-minute
  portal dance into a single phone approval. Where an account has an app-password or a trusted session,
  even that disappears.
- **Per-provider flows are iterative.** Each provider's selectors differ; build + screenshot-verify one
  provider at a time. Xero re-consent is the first target (we hit it constantly). Wiring it needs the
  Xero portal login credentials in Secret Manager (a Matt input; physical-gate to store once).
- **Never put a HARD gate on the allowlist path.** If a flow would cross payment/KYC/signature, it must
  end at that step and escalate. Do not script around the detector.

## Status
Foundation shipped + feasibility proven (headless Chromium drives navigate/fill/click/snapshot/capture
in-sandbox). Next: wire the first real provider flow (Xero) behind stored portal creds, then Google /
Microsoft consent flows. Non-PHI ring only; this tool is keys-to-the-kingdom, so the rails above are
non-negotiable and it is never pointed at a PHI/BAA surface.
