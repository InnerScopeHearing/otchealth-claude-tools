---
name: revenuecat-dashboard
description: Drive the RevenueCat dashboard as Matt (signed-in headless Chromium, login from AWS SSM) for the few RevenueCat actions the v2 REST API refuses, creating a new project and minting a project's v2 secret API key, then hand everything else to the v2 API. Use whenever an app needs a RevenueCat project, a new or rotated secret key, or any dashboard-only fix ("fix RC", "set up RevenueCat for <app>"). Matt directive 2026-09-25, the fleet must ALWAYS be able to fix RevenueCat without him. Keys go straight to SSM and are never printed. Non-PHI ring.
---

# revenuecat-dashboard

**Why this exists:** RevenueCat's v2 API does nearly everything with a project's own `sk_` key:
- apps, products, entitlements, offerings and packages;
- attaching Apple's In-App Purchase key and App Store Connect key.

Two things need a signed-in dashboard, proven live on 2026-09-25:
- **Create a project.** `POST /v2/projects` returns 401 "Invalid API key" with any project-scoped key.
- **Mint a project's first secret key.** Without one, the v2 API can't touch the project at all.

Matt authorized the fleet to act as him here (2026-09-25).

## Credentials (names only; values never in chat, repos or the ledger)

- `revenuecat-login-email`, `revenuecat-login-password` (AWS SSM `/otchealth/*`). The login is plain email and password; no 2FA or emailed code was seen.
- Per-project v2 secret keys:
  - `revenuecat-secret-key` (PlantID Care)
  - `fourvault-revenuecat-secret-key`
  - `revenuecat-flatstick-secret-key`
  - `revenuecat-aware-secret-key` (AWARE, `proja2cc4776`)
- Apple keys used on RevenueCat apps. All are team-wide and work for every fleet app:
  - `flatstick-iap-subscription-key-p8` and `-id` (the In-App Purchase key)
  - `asc-api-key-p8` and `asc-key-id` (the App Store Connect key)
  - `asc-issuer-id`

## Commands

Run from a directory with `node_modules/playwright`, or set `PLAYWRIGHT_DIR`. Chromium defaults to `/opt/pw-browsers/chromium`.

```bash
node skills/revenuecat-dashboard/rc-dashboard.mjs login
node skills/revenuecat-dashboard/rc-dashboard.mjs create-project "<Name>" [--category Health] [--platform Capacitor]
node skills/revenuecat-dashboard/rc-dashboard.mjs new-secret-key <proj...> --ssm <secret-name> [--label fleet-provisioning] [--dry-run --shot form.png]
node skills/revenuecat-dashboard/rc-dashboard.mjs run <url> <actions.json> [--shot out.png]   # any other dashboard fix
node skills/revenuecat-dashboard/rc-dashboard.mjs shot <url> <out.png>
```

- `new-secret-key` creates a V2 key with these permissions:
  - Project configuration: Read & write
  - Customer information: Read & write
  - Charts metrics: Read only

  It then reveals only that key's row, checks it with `GET /v2/projects`, only then writes it to SSM, and reads it back. Its output shows only the key's prefix and length.
- `run` takes an action list, validated before any live click:
  - `click` (text, optional `exact`), `role` + `name`, `css`
  - `fill` + `value`, `label` + `value`
  - `xy` `[x, y]`, `press`
  - `dump` (print page text), `inputs` (list form fields), `wait` (ms)
- Screenshots (`shot`, `run --shot`) are written as local files and are NOT redacted; never screenshot an API-keys page after revealing a key, and never archive such an image.
- The session cookie is cached at `~/.cache/revenuecat-dashboard/state.json` (mode 0600).

## Full new-app recipe (what was done for AWARE)

1. `create-project "AWARE"` gives `proj<id>`.
2. `new-secret-key proj<id> --ssm revenuecat-<app>-secret-key`.
3. Create the App Store app, products, entitlement, offering and packages with the v2 API. AWARE's script is `qa/scripts/revenuecat-provision.mjs`. The entitlement and offering lookup keys must equal the client's `ENTITLEMENT_ID` and `OFFERING_ID`.
4. Attach the Apple keys: `POST /v2/projects/{pid}/apps/{app}`, with an `app_store` body carrying:
   - `subscription_private_key`, `subscription_key_id`, `subscription_key_issuer`
   - `app_store_connect_api_key`, `app_store_connect_api_key_id`, `app_store_connect_api_key_issuer`

   Afterwards both `*_configured` flags must read true.
5. Read the public SDK key from `GET /v2/projects/{pid}/apps/{app}/public_api_keys`, put it in the client, and build.

## Pitfalls (each cost a retry)

- **The dashboard is a slow single-page app.** A fixed sleep misreads a dead session as live. Wait for the login form or the app shell.
- **The login form resets.** It first renders under the original URL, then the app navigates to `/login` and re-mounts it empty. Load `/login` directly and let it settle before typing.
- **Target the visible Email field by label.** A generic `input[type=email]` selector matched a hidden input first.
- **Package attach uses the top-level path.** It is `POST /v2/projects/{pid}/packages/{pkg}/actions/attach_products`. The path nested under the offering returns 404.
- **The current offering can't be deleted (422).** Make another offering current first.
- **Offering display names must be unique** (409). Rename the old one before re-creating.
