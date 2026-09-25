#!/usr/bin/env node
// rc-dashboard.mjs -- drive the RevenueCat DASHBOARD as Matt, for the few things the v2 API refuses.
//
// The v2 REST API (with a project's own sk_ key) does almost everything: apps, products,
// entitlements, offerings, packages, even attaching the Apple In-App Purchase + App Store Connect
// keys. What it CANNOT do, verified live 2026-09-25: create a new project (POST /v2/projects -> 401
// with any project-scoped key) and mint that project's first secret key. Those two need a signed-in
// dashboard session, which is what this script provides.
//
// Credentials: Matt's dashboard login lives in AWS SSM as /otchealth/revenuecat-login-email and
// /otchealth/revenuecat-login-password (Matt directive 2026-09-25: "ALWAYS fix RC"). They are read
// in-process and never printed. The session cookie is cached (mode 0600) so repeat runs skip login.
//
// Usage:
//   node rc-dashboard.mjs login
//   node rc-dashboard.mjs create-project <name> [--category Health] [--platform Capacitor]
//   node rc-dashboard.mjs new-secret-key <projectId> --ssm <secret-name> [--label fleet-provisioning] [--dry-run]
//   node rc-dashboard.mjs run <url> <actions.json> [--shot out.png]
//   node rc-dashboard.mjs shot <url> <out.png>
//
// Needs playwright (resolved from the cwd, or PLAYWRIGHT_DIR=<dir containing node_modules/playwright>)
// and a Chromium (defaults to /opt/pw-browsers/chromium when present).
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ssmSecret, ssmSecretSet } from "../kb-memory/aws-secret.mjs";
import { extractSecretKey, redactKey, redactText, dashboardProjectId, validateActions } from "./lib.mjs";

const BASE = "https://app.revenuecat.com";
const STATE_DIR = join(homedir(), ".cache", "revenuecat-dashboard");
const STATE = join(STATE_DIR, "state.json");

function loadPlaywright() {
  const roots = [process.env.PLAYWRIGHT_DIR, process.cwd()].filter(Boolean);
  for (const r of roots) {
    try { return createRequire(resolve(r, "package.json"))("playwright"); } catch { /* try next */ }
  }
  throw new Error("playwright not found: run from a directory with node_modules/playwright or set PLAYWRIGHT_DIR");
}

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

async function openBrowser() {
  const { chromium } = loadPlaywright();
  const exe = process.env.CHROMIUM_PATH || (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
  const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined;
  const browser = await chromium.launch({ executablePath: exe, proxy, args: proxy ? ["--ignore-certificate-errors"] : [] });
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 1000 },
    ignoreHTTPSErrors: !!proxy,
    storageState: existsSync(STATE) ? STATE : undefined,
  });
  return { browser, ctx, page: await ctx.newPage() };
}

async function saveState(ctx) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  await ctx.storageState({ path: STATE });
  chmodSync(STATE, 0o600);
}

// Ensures a signed-in session. The dashboard is a slow SPA: wait for real inputs or the app shell.
async function ensureLogin(page) {
  await page.goto(`${BASE}/overview`, { waitUntil: "load", timeout: 90000 });
  // The SPA redirects to /login only after its session check resolves, which can take well over
  // 6s, so a fixed sleep misreads a dead session as live. Wait for one of the two real end states.
  const loginForm = page.locator("input[type=password], input[type=email]").first();
  const appShell = page.getByText("Project settings", { exact: true }).or(page.getByText("All projects", { exact: true })).first();
  await Promise.race([
    loginForm.waitFor({ timeout: 60000 }).catch(() => {}),
    appShell.waitFor({ timeout: 60000 }).catch(() => {}),
  ]);
  if (!/login/.test(page.url()) && !(await loginForm.isVisible().catch(() => false))) return "session-reused";
  const email = await ssmSecret("revenuecat-login-email");
  const password = await ssmSecret("revenuecat-login-password");
  if (!email || !password) throw new Error("revenuecat-login-email/-password missing from SSM");
  // The login form first renders under the ORIGINAL url, then the SPA navigates to /login and
  // re-mounts it EMPTY (verified 2026-09-25: a value typed before that navigation is wiped). So load
  // /login explicitly and let it settle before typing anything.
  await page.goto(`${BASE}/login`, { waitUntil: "load", timeout: 90000 });
  await page.waitForURL(/\/login/, { timeout: 30000 });
  await page.waitForTimeout(4000);
  // Target the VISIBLE Email field by its label: a generic input[type=email]/autocomplete selector
  // matched a hidden input first on the redirected login page, leaving the real field empty.
  const emailField = page.getByLabel("Email", { exact: true }).or(page.getByPlaceholder("email@example.com")).first();
  await emailField.waitFor({ timeout: 30000 });
  await emailField.fill(email);
  // The password field renders a beat after the email field; only treat the form as a two-step
  // (email first, then password) flow if it still has not appeared after a short wait.
  const pwField = page.locator("input[type=password]").first();
  if (!(await pwField.waitFor({ timeout: 10000 }).then(() => true, () => false))) {
    await page.keyboard.press("Enter");
    await page.waitForSelector("input[type=password]", { timeout: 30000 });
  }
  await page.locator("input[type=password]").first().fill(password);
  await page.keyboard.press("Enter");
  await appShell.waitFor({ timeout: 60000 }).catch(() => {});
  if (/login/.test(page.url())) {
    const body = (await page.innerText("body")).slice(0, 300).replace(/\s+/g, " ");
    throw new Error(`still on the login page after submit (2FA/verification or wrong password?): ${body}`);
  }
  return "logged-in";
}

async function runActions(page, actions) {
  for (const a of validateActions(actions)) {
    if (a.click) await page.getByText(a.click, { exact: !!a.exact }).first().click({ timeout: 15000 });
    if (a.role) await page.getByRole(a.role, { name: a.name, exact: !!a.exact }).first().click({ timeout: 15000 });
    if (a.css) await page.locator(a.css).first().click({ timeout: 15000 });
    if (a.fill) await page.locator(a.fill).first().fill(a.value, { timeout: 15000 });
    if (a.label) await page.getByLabel(a.label).first().fill(a.value, { timeout: 15000 });
    if (a.xy) await page.mouse.click(a.xy[0], a.xy[1]);
    if (a.press) await page.keyboard.press(a.press);
    if (a.dump) console.log(redactText(await page.innerText("body")).slice(0, a.dump)); // redact THEN truncate
    if (a.inputs) console.log(redactText(await page.$$eval("input,button", (els) => els.map((e) => `${e.tagName}|${e.type}|${e.name}|${e.placeholder || ""}|${(e.innerText || "").slice(0, 40)}`).join("\n"))));
    await page.waitForTimeout(a.wait ?? 2500);
  }
}

// Sets one "<Area> permissions" section to an access level on the new-secret-key form.
async function setPermission(page, area, level) {
  const row = page.locator(`xpath=//*[normalize-space(text())="${area} permissions"]/ancestor::*[contains(normalize-space(.),"Permissions:")][1]`);
  await row.getByText("No access", { exact: true }).first().click({ timeout: 15000 });
  await page.waitForTimeout(800);
  await page.getByRole("option", { name: level, exact: true }).first().click({ timeout: 15000 });
  await page.waitForTimeout(1000);
}

async function cmdCreateProject(page, name) {
  const category = arg("--category", "Health");
  const platform = arg("--platform", "Capacitor");
  await page.goto(`${BASE}/projects/add`, { waitUntil: "load", timeout: 90000 });
  await page.locator("input[name=app-search-name]").first().waitFor({ timeout: 60000 });
  await page.locator("input[name=app-search-name]").first().fill(name);
  await page.keyboard.press("Escape");
  await page.locator("input[placeholder='Select a category']").first().click();
  await page.getByText(category, { exact: true }).first().click();
  await page.locator("input[placeholder='Select platforms']").first().click();
  await page.getByText(platform, { exact: true }).first().click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.waitForTimeout(8000);
  const m = page.url().match(/\/projects\/([a-z0-9]+)\//);
  if (!m) throw new Error(`project create did not land on a project page: ${page.url()}`);
  console.log(`created project "${name}" -> v2 id proj${m[1]}`);
}

async function cmdNewSecretKey(page, projectId) {
  const pid = dashboardProjectId(projectId);
  const label = arg("--label", "fleet-provisioning");
  const ssmName = arg("--ssm");
  const dryRun = process.argv.includes("--dry-run");
  if (!ssmName && !dryRun) throw new Error("--ssm <secret-name> is required (the key goes straight to SSM, never to stdout)");
  await page.goto(`${BASE}/projects/${pid}/api-keys/new`, { waitUntil: "load", timeout: 90000 });
  await page.locator("input[name=label]").first().waitFor({ timeout: 60000 });
  await page.locator("input[name=label]").first().fill(label);
  // The API-version control is a custom dropdown whose <input> is not clickable; click its box.
  const ver = page.locator("input[name=api_version]").first();
  const box = await ver.evaluateHandle((el) => el.closest("div[class]") || el.parentElement);
  await box.asElement().click({ timeout: 15000 });
  await page.getByText("V2", { exact: true }).first().click({ timeout: 15000 });
  await page.waitForTimeout(1500);
  await setPermission(page, "Project configuration", "Read & write");
  await setPermission(page, "Customer information", "Read & write");
  await setPermission(page, "Charts metrics", "Read only");
  if (dryRun) {
    await page.screenshot({ path: arg("--shot", "rc-new-key-dry-run.png") });
    console.log("dry run: form filled, NOT generated; screenshot written");
    return;
  }
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await page.waitForTimeout(8000);
  if (!/api-keys$/.test(page.url())) await page.goto(`${BASE}/projects/${pid}/api-keys`, { waitUntil: "load" });
  await page.waitForTimeout(6000);
  // Reveal only this key's row (the eye button is the first button in the row).
  const row = page.locator("tr", { hasText: label }).first();
  await row.locator("button").first().click({ timeout: 15000 });
  await page.waitForTimeout(2500);
  const key = extractSecretKey(await row.innerText());
  if (!key) throw new Error("generated, but the secret key was not visible in its row; reveal it in the dashboard");
  // Verify BEFORE storing: only a key the v2 API actually accepts may replace what SSM holds.
  const check = await fetch("https://api.revenuecat.com/v2/projects", { headers: { Authorization: `Bearer ${key}` } });
  if (!check.ok) throw new Error(`new key ${redactKey(key)} was rejected by GET /v2/projects (${check.status}); NOT stored in SSM`);
  await ssmSecretSet(ssmName, key);
  if ((await ssmSecret(ssmName)) !== key) throw new Error(`SSM read-back of /otchealth/${ssmName} does not match the new key`);
  console.log(`secret key ${redactKey(key)} verified (GET /v2/projects ${check.status}) and stored in SSM /otchealth/${ssmName}`);
}

async function main() {
  const [cmd, a1, a2] = process.argv.slice(2);
  if (!cmd || cmd === "help") {
    console.log(readFileSync(new URL(import.meta.url)).toString().split("\n").slice(13, 20).join("\n"));
    return;
  }
  const { browser, ctx, page } = await openBrowser();
  try {
    console.log(`session: ${await ensureLogin(page)}`);
    if (cmd === "login") {
      const text = await page.innerText("body");
      console.log("signed in; dashboard shows:", text.slice(0, 200).replace(/\s+/g, " "));
    } else if (cmd === "create-project") await cmdCreateProject(page, a1);
    else if (cmd === "new-secret-key") await cmdNewSecretKey(page, a1);
    else if (cmd === "run") {
      await page.goto(a1, { waitUntil: "load", timeout: 90000 });
      await page.waitForTimeout(6000);
      await runActions(page, JSON.parse(readFileSync(a2, "utf8")));
      if (arg("--shot")) await page.screenshot({ path: arg("--shot") });
      console.log("url", page.url());
    } else if (cmd === "shot") {
      await page.goto(a1, { waitUntil: "load", timeout: 90000 });
      await page.waitForTimeout(8000);
      await page.screenshot({ path: a2 });
      console.log("wrote", a2);
    } else throw new Error(`unknown command ${cmd}`);
    await saveState(ctx);
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(`[rc-dashboard] ${e.message}`); process.exit(1); });
