# TEMPLATE FORK CHECKLIST — scaffold a new app from `app-template`

> The standard for every NEW app: fork `InnerScopeHearing/app-template` (the green-
> building premium monorepo), then run this checklist. The nine patterns below are the
> ACTUAL first-build defects fixed while landing app-template PR #1 (merge `be306a3`,
> 2026-06-30) — they are not hypothetical; skipping one re-breaks the build.
>
> Pair this with `AI-AGENT-APP-BUILDING-BIBLE.md` (the one law + the $10M craft rules)
> and the `boot-gate` skill (prove it actually launches and renders).

## 0. Fork + name
- Fork `app-template` (do NOT hand-scaffold a monorepo from scratch). Keep the
  `apps/ + packages/ + services/` shape, pnpm + Turbo, Capacitor 8 / React 19 / Vite 5.
- Set the new appId/appName/bundle id and the per-app brand tokens in `design-system`.
- iOS app-record + App Group container + ASC products are Matt UI gates (API-forbidden).

## 1. The nine first-build patterns (carry into EVERY fork)
1. **pnpm strict: each package declares what it imports.** `react`, `@types/react`,
   `@types/react-dom`, and every cross-package `@template/*` dependency must be in THAT
   package's `package.json`, not just `apps/mobile`. Missing types cascade into dozens
   of confusing JSX/prop errors.
2. **`@capgo/*` plugins track the Capacitor MAJOR.** Use `^8` (there is no `^6`). A
   wrong major hard-fails `pnpm install`.
3. **RevenueCat capacitor v9 API** = `getProducts({ productIdentifiers })` then
   `purchaseStoreProduct({ product })` — NOT `purchaseProduct`.
4. **The `design-system` Button API is `onClick` / `disabled` / `busy`** — NOT
   React-Native-style `onPress` / `isDisabled` / `isLoading`.
5. **`apps/mobile/src/vite-env.d.ts`** (`/// <reference types="vite/client" />`) types
   `import.meta.env` program-wide. Do not scatter casts.
6. **ESLint: defer `no-undef` to TypeScript** (`"no-undef": "off"` for TS files). Don't
   set `project: true` unless you actually need typed rules.
7. **`vitest run --passWithNoTests`** until a package actually has tests.
8. **Never ship an advanced `.github/workflows/codeql.yml` in a fork.** The org runs
   **CodeQL default setup** fleet-wide; an advanced workflow extracts fine but cannot
   upload SARIF and fails with "Resource not accessible by integration / configuration
   error." Let default setup scan it.
9. **OTA security (Capgo):** `autoUpdate: false` until the channel is **signed + pinned**
   (Ed25519 `publicKey`, private `channelUrl`, signed bundles; private key in Secret
   Manager, never in the repo). Pin the plugin version EXACTLY (no caret). See the OTA
   standard set on AWARE PR #33.

## 2. Run the gates before "ready to build"
- Wire the **`boot-gate`** (skill `boot-gate`): boot-smoke + visual/render at iPhone 16
  Pro (402x874) + `check-build-env.mjs` (empty `VITE_*` fails the build) + the
  ErrorBoundary / `SplashScreen.hide()`-in-`finally` boot-resilience standard.
- Frozen-lockfile install + typecheck + lint + test + build must all pass in CI.
- Run the Part 4 pre-ready checklist in the Bible.

## 3. Access + build seams (do not relearn)
- **Out-of-scope repo on a Claude Code session:** git egress is gated by the session's
  managed git proxy (per-session repo allowlist). A repo not in scope 403s on
  clone/push REGARDLESS of the gh-app token (the gh-app token only helps `api.github.com`).
  Fix: add the repo to the session Environment repo list, or operate via the REST/Git-Data
  API. Do NOT chase a phantom GitHub-App permission problem.
- **iOS builds + TestFlight are CTO-ONLY.** Merge to main and escalate "ready to build"
  with the SHA + CFBundleVersion = ASC max + 1 (resolved from the ASC API, never estimated).
