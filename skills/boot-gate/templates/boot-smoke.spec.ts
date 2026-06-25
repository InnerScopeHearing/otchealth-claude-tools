/**
 * boot-smoke.spec.ts — the gate PlantID's green-screen build would have failed.
 *
 * Loads the BUILT bundle in WebKit (~= iOS WKWebView) at iPhone 16 Pro size and
 * fails the build if the app does not boot cleanly to its first interactive
 * screen. Drop into an app's e2e/; the Playwright webServer must `vite build`
 * with the real env baked in, then `vite preview` (see FourVault playwright.config.ts).
 *
 * Dependency-free (only @playwright/test).
 */
import { test, expect, type ConsoleMessage } from "@playwright/test";

const IP16 = { width: 402, height: 874 }; // iPhone 16 Pro logical points
const BOOT_BUDGET_MS = 8000; // must reach an interactive element within this

test.use({ viewport: IP16 });

test("app boots to an interactive screen with no boot errors", async ({ page }) => {
  const errors: string[] = [];

  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("requestfailed", (req) => {
    const u = req.url();
    // an empty VITE_API_BASE_URL turns API calls into same-origin 404s or
    // about:blank failures — surface them as boot failures.
    if (/\/api\//.test(u) || u.startsWith("about:")) {
      errors.push(`requestfailed: ${u} (${req.failure()?.errorText})`);
    }
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });

  // STUCK-SPLASH DETECTOR: a real interactive control must appear within budget.
  // If the JS never mounts (green/white screen), this throws on timeout = FAIL.
  const interactive = page.locator(
    "button, a[href], input, [role='button'], [data-boot-ready]",
  );
  await expect(
    interactive.first(),
    `App did not reach an interactive element within ${BOOT_BUDGET_MS}ms ` +
      `(stuck on splash / blank / green screen). Boot errors: ` +
      `${errors.join(" | ") || "none"}`,
  ).toBeVisible({ timeout: BOOT_BUDGET_MS });

  // NON-TRIVIAL RENDER: #root must mount a real tree with visible text, not just
  // a painted background. Guards the "green paint, no UI" failure mode.
  const nodeCount = await page.locator("#root *").count();
  const rootText = (await page.locator("#root").innerText().catch(() => "")).trim();
  expect(nodeCount, `#root mounted only ${nodeCount} elements (expected a real UI).`)
    .toBeGreaterThan(5);
  expect(rootText.length, `#root rendered no visible text (blank/stuck splash).`)
    .toBeGreaterThan(0);

  // CLEAN BOOT: assert last so the messages above are richer on failure.
  expect(errors, `Boot fired ${errors.length} error(s):\n${errors.join("\n")}`)
    .toEqual([]);
});
