#!/usr/bin/env node
// browser-agent — a HARDENED, AUDITED, on-demand headless browser the fleet drives to shrink the
// SOFT human gates: OAuth consents, account signups, and portal clicks (the exact Xero-OAuth friction
// we keep hitting). Matt directive 2026-06-21: fully autonomous on NON-FINANCIAL consents; the HARD
// gates (payment, KYC, legal e-signature) stay human and this tool STOPS and escalates at them.
//
// Security model (load-bearing; this is keys-to-the-kingdom so the rails are the point):
//   1) DOMAIN ALLOWLIST   - it will only navigate to hosts you explicitly allow. Off-list => refuse.
//   2) HARD-GATE DETECTOR  - after every step it scans the page for payment/KYC/e-signature signals;
//                            on a hit it STOPS, screenshots, and exits status=HARD_GATE (escalate).
//   3) 2FA DETECTOR        - a one-time-code / "approve on your phone" page exits status=TWOFA_GATE
//                            (the human approves, then you resume). 2FA on the IdP login is the real wall.
//   4) AUDIT LOG           - every action -> JSONL (ts, action, target, url, screenshot, gate). Secret
//                            VALUES are never logged (only "filled <selector> with secret <NAME>").
//   5) SECRET RESOLUTION   - $NAME fills resolve from the flow's `secrets` map (sm:<id> pulls from
//                            Secret Manager via the claude-driver SA). Values never touch chat or logs.
//   6) BOUNDS              - max steps + max wall-clock; abort if exceeded.
//   7) REDIRECT CAPTURE    - a navigation listener captures the OAuth redirect_uri (even if it errors
//                            because the callback host isn't served) and extracts ?code=, to hand to a
//                            token-exchange skill (e.g. xero).
//
// Usage:
//   node browser.mjs run <flow.json>     # execute a scripted flow with all rails; prints a JSON result
//   node browser.mjs schema              # print the flow-spec schema + an example
// Requires: playwright (npm i playwright + npx playwright install chromium). Set PLAYWRIGHT_BROWSERS_PATH=0
// if chromium was installed into node_modules. Non-PHI ring only.
import { readFileSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import crypto from "node:crypto";

const SM = "otchealth-shared-prod";
const argv = process.argv.slice(2);
const cmd = argv[0];

// ---- hard-gate + 2FA signals (case-insensitive). A hit STOPS the run. ----------------------------
const HARD_GATE = /\b(card number|cvv|cvc|credit card|debit card|payment method|billing address|routing number|bank account number|social security|ssn\b|date of birth|driver.?s? licen|passport number|docusign|adobe sign|sign here|e-?signature|i agree and sign|notariz)\b/i;
const TWOFA = /\b(verification code|one[- ]time (code|passcode)|2-step|two[- ]factor|authenticator app|approve (this )?(sign|request) on your|enter the code|we (sent|texted) you a code|security code)\b/i;

function saJwt(scope) { const sa = JSON.parse(process.env.GCP_CLAUDE_DRIVER_SA_JSON); const now = Math.floor(Date.now() / 1000); const e = (o) => Buffer.from(JSON.stringify(o)).toString("base64url"); const i = `${e({ alg: "RS256", typ: "JWT" })}.${e({ iss: sa.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`; return i + "." + crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key, "base64url"); }
async function sm(id) { const r0 = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(saJwt("https://www.googleapis.com/auth/cloud-platform"))}` }); const t = (await r0.json()).access_token; const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets/${id}/versions/latest:access`, { headers: { Authorization: `Bearer ${t}` } }); if (!r.ok) throw new Error(`secret ${id} -> ${r.status}`); return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim(); }

const hostOf = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return ""; } };
const allowed = (host, allowlist) => allowlist.some(a => host === a.toLowerCase() || host.endsWith("." + a.toLowerCase()));

function schema() {
  console.log(`browser-agent flow spec (JSON):
{
  "task": "xero-oauth-consent",                 // label for the audit dir
  "allowlist": ["login.xero.com","identity.xero.com"],   // REQUIRED. only these hosts (+subdomains)
  "capture_redirect": "https://localhost/callback",       // optional: the OAuth redirect_uri to capture
  "secrets": { "USER": "sm:xero-portal-user", "PASS": "sm:xero-portal-pass" }, // $USER/$PASS in steps
  "max_steps": 25, "max_seconds": 180,           // bounds (defaults 30 / 240)
  "steps": [
    { "goto": "https://login.xero.com/identity/connect/authorize?..." },
    { "fill": "#xl-form-email", "value": "$USER" },
    { "click": "#xl-form-submit" },
    { "fill": "#xl-form-password", "value": "$PASS" },
    { "click": "#xl-form-submit" },
    { "click": "text=Allow access" },            // the consent click (non-financial => autonomous)
    { "capture": true }                          // capture the redirect ?code=
  ]
}
RESULT statuses: OK | HARD_GATE (payment/KYC/e-sign -> human) | TWOFA_GATE (approve, then resume)
  | DISALLOWED_HOST | TIMEOUT | ERROR. Every run writes audit/<task>-<ts>/log.jsonl + step screenshots.`);
}

async function run() {
  const flowPath = argv[1];
  if (!flowPath) { console.error("need a flow.json (see: browser.mjs schema)"); process.exit(2); }
  const flow = JSON.parse(readFileSync(flowPath, "utf8"));
  if (!Array.isArray(flow.allowlist) || !flow.allowlist.length) { console.error("flow.allowlist is REQUIRED (no open browsing)"); process.exit(2); }
  const maxSteps = flow.max_steps || 30, maxMs = (flow.max_seconds || 240) * 1000;
  const auditDir = join(process.env.BROWSER_AGENT_AUDIT || join(process.cwd(), "audit"), `${(flow.task || "flow").replace(/[^\w.-]/g, "_")}-${Date.now()}`);
  mkdirSync(auditDir, { recursive: true });
  const logFile = join(auditDir, "log.jsonl");
  const audit = (o) => appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), ...o }) + "\n");
  const result = { status: "OK", task: flow.task || "flow", auditDir, steps: 0, captured: null, note: "" };

  // resolve secrets up front (values kept in a local map; NEVER logged/printed)
  const secretVals = {};
  for (const [name, ref] of Object.entries(flow.secrets || {})) {
    if (typeof ref === "string" && ref.startsWith("sm:")) { try { secretVals[name] = await sm(ref.slice(3)); audit({ action: "resolve_secret", name, source: ref }); } catch (e) { console.error("secret resolve failed: " + e.message); process.exit(1); } }
    else secretVals[name] = String(ref);
  }
  const subst = (v) => typeof v === "string" ? v.replace(/\$([A-Z0-9_]+)/g, (m, n) => (n in secretVals ? secretVals[n] : m)) : v;
  const isSecret = (v) => typeof v === "string" && /\$[A-Z0-9_]+/.test(v);

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0 Safari/537.36" });
  const page = await ctx.newPage();

  // redirect capture: watch for navigation to the callback host, grab ?code= before it errors
  let captured = null;
  if (flow.capture_redirect) {
    const cbHost = hostOf(flow.capture_redirect);
    page.on("framenavigated", (f) => { try { const u = f.url(); if (hostOf(u) === cbHost && !captured) { captured = u; } } catch {} });
    page.on("request", (req) => { try { const u = req.url(); if (hostOf(u) === cbHost && !captured) captured = u; } catch {} });
  }

  const started = Date.now();
  const shot = async (tag) => { const p = join(auditDir, `${String(result.steps).padStart(2, "0")}-${tag}.png`); try { await page.screenshot({ path: p }); } catch {} return p; };
  const gateScan = async (tag) => {
    // Scan the page HTML (page.content()), NOT innerText: innerText concatenates adjacent element
    // text without separators (e.g. "Card number"+"CVV" -> "Card numberCVV"), which breaks the \b
    // word boundary and silently misses a payment page. HTML keeps tags between words so the boundary
    // holds, and it is the SAFER choice for a hard-gate detector (it also catches hidden fields).
    let html = ""; try { html = (await page.content()) || ""; } catch {}
    if (HARD_GATE.test(html)) { result.status = "HARD_GATE"; result.note = `hard gate (payment/KYC/e-sign) detected at step ${result.steps} (${tag})`; return false; }
    if (TWOFA.test(html)) { result.status = "TWOFA_GATE"; result.note = `2FA/OTP page at step ${result.steps} (${tag}); human approves then resume`; return false; }
    return true;
  };

  try {
    for (const step of flow.steps) {
      if (result.steps >= maxSteps) { result.status = "TIMEOUT"; result.note = "max_steps exceeded"; break; }
      if (Date.now() - started > maxMs) { result.status = "TIMEOUT"; result.note = "max_seconds exceeded"; break; }
      result.steps++;
      const kind = Object.keys(step)[0];

      if (step.goto) {
        const host = hostOf(step.goto);
        if (!allowed(host, flow.allowlist)) { result.status = "DISALLOWED_HOST"; result.note = `goto ${host} not in allowlist`; audit({ action: "goto_blocked", host }); break; }
        audit({ action: "goto", url: step.goto });
        await page.goto(step.goto, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(e => { audit({ action: "goto_warn", err: e.message }); });
      } else if (step.fill !== undefined) {
        const sel = step.fill, raw = step.value;
        const val = subst(raw);
        audit({ action: "fill", selector: sel, value: isSecret(raw) ? `<secret ${raw}>` : val });
        await page.fill(sel, val, { timeout: 15000 });
      } else if (step.click !== undefined) {
        audit({ action: "click", selector: step.click });
        await page.click(step.click, { timeout: 15000 }).catch(e => { audit({ action: "click_warn", err: e.message }); });
        await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
      } else if (step.wait_ms) {
        await page.waitForTimeout(Math.min(step.wait_ms, 10000));
      } else if (step.capture) {
        // give a pending redirect a moment to fire
        await page.waitForTimeout(1500);
      } else {
        audit({ action: "unknown_step", step });
      }

      const sp = await shot(kind);
      const cont = await gateScan(kind);
      // current page host must remain allowlisted (defense vs an unexpected off-list redirect)
      const curHost = hostOf(page.url());
      if (curHost && !allowed(curHost, flow.allowlist) && !(flow.capture_redirect && curHost === hostOf(flow.capture_redirect))) {
        result.status = "DISALLOWED_HOST"; result.note = `navigated to off-allowlist host ${curHost}`; audit({ action: "offlist_nav", host: curHost, screenshot: sp }); break;
      }
      audit({ action: "step_done", kind, url: page.url(), screenshot: sp, status: result.status });
      if (!cont) break;
      if (captured) break;
    }

    if (captured) {
      try { const code = new URL(captured).searchParams.get("code"); result.captured = { url: captured, code: code ? code.slice(0, 6) + "..." : null, has_code: !!code }; } catch { result.captured = { url: captured }; }
      // write the FULL captured url (with the code) to the audit dir only, not stdout
      writeFileSync(join(auditDir, "captured-redirect.txt"), captured, { mode: 0o600 });
      result.note = result.note || "redirect captured; full URL (with code) in audit/captured-redirect.txt";
    }
  } catch (e) {
    result.status = result.status === "OK" ? "ERROR" : result.status; result.note = result.note || e.message;
    audit({ action: "error", err: e.message });
  } finally {
    await browser.close().catch(() => {});
  }
  audit({ action: "result", ...result });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status === "OK" ? 0 : (result.status === "HARD_GATE" || result.status === "TWOFA_GATE") ? 3 : 1);
}

try {
  if (cmd === "run") await run();
  else if (cmd === "schema") schema();
  else { console.error('usage: browser.mjs run <flow.json> | schema'); process.exit(2); }
} catch (e) { console.error("ERROR: " + e.message); process.exit(1); }
