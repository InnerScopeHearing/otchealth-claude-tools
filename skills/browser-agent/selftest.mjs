#!/usr/bin/env node
// browser-agent self-test: proves the SAFETY RAILS fire. Spins up two local servers (a consent host
// and a distinct callback host), runs four flows through browser.mjs, and asserts each verdict:
//   1) consent + redirect capture -> OK with an extracted ?code=
//   2) a payment page              -> HARD_GATE (the detector must STOP)
//   3) a 2FA / one-time-code page  -> TWOFA_GATE
//   4) an off-allowlist navigation -> DISALLOWED_HOST
// Run: PLAYWRIGHT_BROWSERS_PATH=0 node selftest.mjs   (needs playwright + chromium installed)
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const pexec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const html = (b) => `<!doctype html><html><head><meta charset="utf-8"></head><body>${b}</body></html>`;
const P1 = 8761, P2 = 8762; // consent host, callback host (distinct so capture only fires on the callback)

const consent = http.createServer((req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (req.url.startsWith("/payment")) res.end(html(`<h1>Add payment</h1><label>Card number</label><input><label>CVV</label><input>`));
  else if (req.url.startsWith("/twofa")) res.end(html(`<h1>Verify it is you</h1><p>Enter the verification code we texted you.</p><input>`));
  else res.end(html(`<h1>Authorize App</h1><input id="email"><button id="allow" onclick="location.href='http://127.0.0.1:${P2}/callback?code=LIVE_CODE_ABC&state=s1'">Allow access</button>`));
});
const callback = http.createServer((req, res) => { res.setHeader("Content-Type", "text/html"); res.end(html("<h1>ok</h1>")); });
await new Promise(r => consent.listen(P1, "127.0.0.1", r));
await new Promise(r => callback.listen(P2, "127.0.0.1", r));

const dir = mkdtempSync(join(tmpdir(), "ba-selftest-"));
const H1 = `127.0.0.1:${P1}`;
// NOTE: spawn the browser subprocess ASYNC (execFile), never execFileSync. The test HTTP servers run
// in THIS process's event loop; a synchronous spawn blocks that loop, so the browser's request never
// gets served and goto times out. Async keeps the loop free to answer the browser.
let flowN = 0;
async function runFlow(flow) {
  const f = join(dir, `flow-${flowN++}.json`); writeFileSync(f, JSON.stringify(flow));
  try { const { stdout } = await pexec("node", [join(HERE, "browser.mjs"), "run", f], { env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? "0", BROWSER_AGENT_AUDIT: join(dir, "audit") }, maxBuffer: 10 * 1024 * 1024 }); return JSON.parse(stdout); }
  catch (e) { try { return JSON.parse(e.stdout); } catch { return { status: "EXEC_ERR", raw: ((e.stdout || "") + (e.stderr || "")).slice(0, 300) }; } }
}
let pass = 0, fail = 0;
const check = (name, got, want, extra = true) => { const ok = got === want && extra; console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}: ${got}${ok ? "" : ` (wanted ${want})`}`); ok ? pass++ : fail++; };

const r1 = await runFlow({ task: "consent", allowlist: [H1], capture_redirect: `http://127.0.0.1:${P2}/callback`, steps: [{ goto: `http://${H1}/consent` }, { fill: "#email", value: "u@x.com" }, { click: "#allow" }, { capture: true }] });
check("consent + capture code", r1.status, "OK", r1.captured && r1.captured.has_code === true);
const r2 = await runFlow({ task: "payment", allowlist: [H1], steps: [{ goto: `http://${H1}/payment` }] });
check("payment -> HARD_GATE", r2.status, "HARD_GATE");
const r3 = await runFlow({ task: "twofa", allowlist: [H1], steps: [{ goto: `http://${H1}/twofa` }] });
check("2FA -> TWOFA_GATE", r3.status, "TWOFA_GATE");
const r4 = await runFlow({ task: "offlist", allowlist: ["login.xero.com"], steps: [{ goto: `http://${H1}/consent` }] });
check("off-allowlist -> DISALLOWED_HOST", r4.status, "DISALLOWED_HOST");

consent.close(); callback.close();
console.log(`\nbrowser-agent self-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
