---
name: test-author
description: QA's equipment. Installs and authors the web-first test stack for a Capacitor app, because a Capacitor app is a web app in a WebView, so ~70-80% of risk is browser risk covered cheaply. Sets up Vitest 4 Browser Mode, Playwright (Chromium+WebKit), axe-core accessibility, visual snapshots, Lighthouse CI, and Capacitor plugin mocks, then wires them as CI gates.
---

# test-author — web-first tests that cover the real risk

Strategic insight: don't lead with flaky native device automation. A Capacitor UI is
web; test it like one and reserve device automation for the thin native slice.

## When to invoke
Adopting an app with no/low tests, or QA needs to author tests for a change.

## Install (free/OSS)
```bash
npm i -D vitest @vitest/browser @vitest/browser-playwright playwright \
        @axe-core/playwright @lhci/cli
npx playwright install --with-deps chromium webkit
```

## The layers (copy configs from `templates/`)
1. **Vitest 4 Browser Mode** (`vitest.config.ts`): component/integration tests in real
   Chromium (not JSDOM). Mock Capacitor plugins with manual mocks (`templates/capacitor-mocks.ts`).
2. **Playwright E2E** (`playwright.config.ts`): critical journeys on the served build,
   run **chromium + webkit** (WebKit approximates iOS WKWebView, so you catch iOS web bugs
   with no Mac).
3. **axe-core a11y** (`templates/a11y.spec.ts`): WCAG 2.2 AA on changed screens. For a
   senior-health app this is core product value, gate PRs on zero violations.
4. **Visual snapshots**: Playwright `toHaveScreenshot()`, baselines generated in CI,
   dynamic content masked.
5. **Lighthouse CI** (`templates/lighthouserc.js`): perf/size budgets per PR.

## Native smoke (only the genuinely-native slice)
Maestro local flow, or the `adb forward` CDP-WebView trick to drive the real installed
app's web layer. Reserve Appium for native<->web context-switching; skip Detox.

## Wire as CI gates
Each layer fails the PR on regression. Write results to `manifest.gates`
(tests/axe/visual/lighthouse). Ship every bug fix with a regression test (LESSONS.md).

## Guardrails
Never weaken a gate to make it pass. Keep tests deterministic (mock plugins, mask dynamic UI).
