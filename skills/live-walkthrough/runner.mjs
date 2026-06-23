#!/usr/bin/env node
// runner.mjs — the live persona walkthrough engine (app-agnostic, fleet skill).
//
// For every (device x persona-journey) it launches a REAL browser (WebKit/iPhone
// by default, the engine the iOS WKWebView ships), drives the journey with REAL
// interactions (touchscreen tap, touch drag/swipe, wheel + programmatic scroll),
// records VIDEO + a Playwright TRACE + per-step screenshots, collects console
// errors / failed requests / cumulative layout shift, and runs the probe battery
// (sticky-detach, horizontal-bleed, text-clip, tap-target, broken-link) on every
// screen the persona lands on. Output: a machine-readable findings.json + the
// artifacts, consumed by report.mjs.
//
// The probes/devices/interaction-primitives/report are SHARED (this skill). The
// two APP-SPECIFIC inputs — the API stub map and the persona journeys — are
// resolved at runtime from the target app, NOT baked in:
//   --app-dir <path>   a directory holding stubs.mjs + journeys.mjs
//                      (default: <cwd>/qa/live-walkthrough)
//   --stubs <path>     explicit path to the stubs module (overrides --app-dir)
//   --journeys-file <path>  explicit path to the journeys module (overrides --app-dir)
// The stubs module must export `installStubs(page, {authenticated})` and
// `ROUTE_PATTERNS` (array of RegExp); the journeys module must export `JOURNEYS`
// (array of journey objects). See SKILL.md / README.md for the full contract.
//
// Usage:
//   node skills/live-walkthrough/runner.mjs [--url URL] [--app-dir DIR]
//        [--stubs FILE] [--journeys-file FILE] [--devices id,id]
//        [--journeys id,id] [--engine webkit|chromium] [--out DIR] [--video on|off]
//        [--scroll-sel ".app-shell__scroll"] [--app-name "My App"]
// Defaults: --url http://127.0.0.1:4173  --out qa/live-walkthrough/out  --video on
//
// Requires: @playwright/test + the webkit (and/or chromium) browsers installed
//   (npm i -D @playwright/test && npx playwright install webkit chromium).
// Non-PHI ring; all data is stubbed by the app's stubs module; no secrets, no users.

import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { webkit, chromium } from "@playwright/test";
import { deviceList } from "./lib/devices.mjs";
import {
  probeStickyIntegrity,
  probeHorizontalBleed,
  probeTextClip,
  probeTapTargets,
  probeLinks,
} from "./lib/probes.mjs";

function parseArgs(argv) {
  const a = {
    url: "http://127.0.0.1:4173",
    out: "qa/live-walkthrough/out",
    appDir: "qa/live-walkthrough",
    stubs: null,
    journeysFile: null,
    engine: null,
    video: "on",
    scrollSel: ".app-shell__scroll",
    appName: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--url") a.url = argv[++i];
    else if (k === "--app-dir") a.appDir = argv[++i];
    else if (k === "--stubs") a.stubs = argv[++i];
    else if (k === "--journeys-file") a.journeysFile = argv[++i];
    else if (k === "--devices") a.devices = argv[++i];
    else if (k === "--journeys") a.journeys = argv[++i];
    else if (k === "--engine") a.engine = argv[++i];
    else if (k === "--out") a.out = argv[++i];
    else if (k === "--video") a.video = argv[++i];
    else if (k === "--scroll-sel") a.scrollSel = argv[++i];
    else if (k === "--app-name") a.appName = argv[++i];
  }
  return a;
}

const ENGINES = { webkit, chromium };

// Resolve a module path: explicit flag wins, else <appDir>/<file>. Returns an
// absolute path; the caller import()s it (failing loudly with a clear message).
function resolveModule(explicit, appDir, file) {
  const p = explicit || join(appDir, file);
  return isAbsolute(p) ? p : resolve(p);
}

async function loadAppInputs(opts) {
  const stubsPath = resolveModule(opts.stubs, opts.appDir, "stubs.mjs");
  const journeysPath = resolveModule(opts.journeysFile, opts.appDir, "journeys.mjs");
  for (const [label, p] of [
    ["stubs", stubsPath],
    ["journeys", journeysPath],
  ]) {
    if (!existsSync(p)) {
      throw new Error(
        `live-walkthrough: cannot find the app-specific ${label} module at ${p}.\n` +
          `  Supply it with --app-dir <dir> (holding stubs.mjs + journeys.mjs) or the explicit\n` +
          `  --${label === "stubs" ? "stubs" : "journeys-file"} <path> flag. See the skill's SKILL.md for the input contract.`,
      );
    }
  }
  const stubsMod = await import(pathToFileURL(stubsPath).href);
  const journeysMod = await import(pathToFileURL(journeysPath).href);
  if (typeof stubsMod.installStubs !== "function") {
    throw new Error(`live-walkthrough: ${stubsPath} must export a function 'installStubs(page, opts)'.`);
  }
  if (!Array.isArray(journeysMod.JOURNEYS)) {
    throw new Error(`live-walkthrough: ${journeysPath} must export an array 'JOURNEYS'.`);
  }
  return {
    installStubs: stubsMod.installStubs,
    ROUTE_PATTERNS: Array.isArray(stubsMod.ROUTE_PATTERNS) ? stubsMod.ROUTE_PATTERNS : [],
    JOURNEYS: journeysMod.JOURNEYS,
    stubsPath,
    journeysPath,
  };
}

// The CLS collector: injected before any navigation, accumulates layout-shift.
const CLS_INIT = `
window.__lwCLS = 0;
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (!e.hadRecentInput) window.__lwCLS += e.value;
    }
  }).observe({ type: "layout-shift", buffered: true });
} catch (e) { /* layout-shift unsupported (WebKit) -> stays 0 */ }
`;

async function runJourneyOnDevice(engineImpl, device, journey, opts, app, sink) {
  const tag = `${device.id}__${journey.id}`;
  const videoDir = join(opts.out, "video", tag);
  if (opts.video === "on") mkdirSync(videoDir, { recursive: true });

  const browser = await engineImpl.launch({ headless: true });
  const context = await browser.newContext({
    ...device.descriptor,
    ...(opts.video === "on" ? { recordVideo: { dir: videoDir } } : {}),
  });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  const page = await context.newPage();

  // Collectors.
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 300));
  });
  page.on("pageerror", (err) => pageErrors.push(String(err.message || err).slice(0, 300)));
  page.on("requestfailed", (req) => {
    const u = req.url();
    // Ignore the deliberately-unserved analytics/beacon noise; we care about app fetches.
    if (/posthog|sentry|google-analytics|gtag|favicon\.ico/.test(u)) return;
    failedRequests.push(`${req.method()} ${u} (${req.failure()?.errorText || "failed"})`);
  });

  await page.addInitScript(CLS_INIT);
  // A journey can opt OUT of the faked session to walk the logged-out front door
  // (cold-open personas), so the sign-in / guest path is exercised for real.
  await app.installStubs(page, { authenticated: journey.auth !== false });

  const steps = [];
  let stepNo = 0;
  const shot = async (label) => {
    const file = join(opts.out, "shots", `${tag}__${String(stepNo).padStart(2, "0")}-${label}.png`);
    mkdirSync(join(opts.out, "shots"), { recursive: true });
    try {
      await page.screenshot({ path: file, fullPage: false });
    } catch {
      /* ignore */
    }
    return file.replace(opts.out + "/", "");
  };

  // The CURRENT route (for finding context).
  const routeOf = () => {
    try {
      return new URL(page.url()).pathname + new URL(page.url()).search;
    } catch {
      return page.url();
    }
  };

  const probeCtxBase = { device: device.label, scrollSel: opts.scrollSel };
  const findings = [];
  const runProbes = async (whenLabel) => {
    const ctx = { ...probeCtxBase, route: routeOf() + ` @${whenLabel}` };
    try {
      const batches = await Promise.all([
        probeStickyIntegrity(page, ctx),
        probeHorizontalBleed(page, ctx),
        probeTextClip(page, ctx),
        probeTapTargets(page, ctx),
        probeLinks(page, ctx, app.ROUTE_PATTERNS),
      ]);
      for (const b of batches) findings.push(...b);
    } catch (e) {
      findings.push({
        klass: "probe-error",
        severity: "P3",
        device: device.label,
        route: ctx.route,
        element: { sel: "(probe)" },
        detail: `A probe threw: ${String(e.message || e).slice(0, 160)}`,
      });
    }
  };

  // --- the real-interaction primitives --------------------------------------
  const vp = device.descriptor.viewport;
  const scrollSel = opts.scrollSel;

  async function doScroll(amount) {
    const px =
      amount === "down"
        ? Math.round(vp.height * 0.8)
        : amount === "up"
          ? -Math.round(vp.height * 0.8)
          : Number(amount) || 0;
    // Real wheel scroll (fires scroll listeners) ...
    await page.mouse.wheel(0, px);
    // ... plus a programmatic scroll of the actual scroller (covers
    // touch-only scrollers a wheel won't move in some engines).
    await page.evaluate(
      ([dy, sel]) => {
        const c = document.querySelector(sel);
        const s =
          c && c.scrollHeight > c.clientHeight + 4
            ? c
            : document.scrollingElement || document.documentElement;
        s.scrollBy(0, dy);
      },
      [px, scrollSel],
    );
    await page.waitForTimeout(180);
  }

  async function doSwipe(dir) {
    const cx = vp.width / 2;
    const cy = vp.height / 2;
    const dist = Math.round((dir === "left" || dir === "right" ? vp.width : vp.height) * 0.6);
    const [ex, ey] =
      dir === "left"
        ? [cx - dist, cy]
        : dir === "right"
          ? [cx + dist, cy]
          : dir === "up"
            ? [cx, cy - dist]
            : [cx, cy + dist];
    // A real touch drag: down, several moves, up.
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) {
      await page.mouse.move(cx + ((ex - cx) * i) / 6, cy + ((ey - cy) * i) / 6);
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
    await page.waitForTimeout(180);
  }

  async function doDrag(testId, dx, dy) {
    const el = page.getByTestId(testId).first();
    const box = await el.boundingBox().catch(() => null);
    if (!box) return false;
    const sx = box.x + box.width / 2;
    const sy = box.y + box.height / 2;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) {
      await page.mouse.move(sx + (dx * i) / 6, sy + (dy * i) / 6);
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
    await page.waitForTimeout(150);
    return true;
  }

  // Tap that uses the touchscreen (not a mouse click) so :active/touch handlers fire.
  async function tap(locator, label) {
    const el = locator.first();
    const visible = await el.isVisible().catch(() => false);
    if (!visible) {
      return { ok: false, reason: `target not visible: ${label}` };
    }
    const before = page.url();
    try {
      await el.tap({ timeout: 4000 });
    } catch {
      // Some controls are mouse-click only in the harness engine; fall back.
      try {
        await el.click({ timeout: 4000 });
      } catch (e) {
        return {
          ok: false,
          reason: `tap failed: ${label} (${String(e.message || e).slice(0, 80)})`,
        };
      }
    }
    await page.waitForTimeout(120);
    return { ok: true, navigated: page.url() !== before, before, after: page.url() };
  }

  // --- execute the journey ---------------------------------------------------
  const startUrl = opts.url + (journey.start || "/");
  let navOk = true;
  try {
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(400);
  } catch (e) {
    navOk = false;
    findings.push({
      klass: "broken-link",
      severity: "P1",
      device: device.label,
      route: journey.start,
      element: { sel: "(start)", text: journey.start },
      detail: `Initial navigation to ${journey.start} failed: ${String(e.message || e).slice(0, 140)}`,
    });
  }

  if (navOk) {
    await shot("start");
    await runProbes("start");

    for (const step of journey.steps) {
      stepNo++;
      const rec = {
        n: stepNo,
        kind: Object.keys(step)[0],
        step,
        narration: step.note || null,
        result: null,
      };
      try {
        if (step.goto !== undefined) {
          await page.goto(opts.url + step.goto, { waitUntil: "domcontentloaded", timeout: 15000 });
          await page.waitForTimeout(300);
          rec.result = { route: routeOf() };
        } else if (step.tapTestId !== undefined) {
          rec.result = await tap(page.getByTestId(step.tapTestId), `testid=${step.tapTestId}`);
        } else if (step.tapText !== undefined) {
          rec.result = await tap(
            page.getByText(step.tapText, { exact: false }),
            `text=${step.tapText}`,
          );
        } else if (step.tapRole !== undefined) {
          const [role, name] = step.tapRole;
          rec.result = await tap(
            page.getByRole(role, { name, exact: false }),
            `role=${role}:${name}`,
          );
        } else if (step.type !== undefined) {
          const loc = step.type.testId
            ? page.getByTestId(step.type.testId)
            : page.getByRole(step.type.role?.[0] || "textbox", { name: step.type.role?.[1] });
          await loc.first().fill(String(step.type.value), { timeout: 4000 });
          rec.result = { typed: true };
        } else if (step.scroll !== undefined) {
          await doScroll(step.scroll);
          rec.result = { scrolled: step.scroll };
        } else if (step.swipe !== undefined) {
          await doSwipe(step.swipe);
          rec.result = { swiped: step.swipe };
        } else if (step.drag !== undefined) {
          const ok = await doDrag(step.drag.testId, step.drag.dx || 0, step.drag.dy || 0);
          rec.result = { dragged: ok };
        } else if (step.expectPath !== undefined) {
          const path = routeOf();
          const ok = step.expectPath.test(path);
          rec.result = { expectPath: String(step.expectPath), actual: path, ok };
          if (!ok) {
            findings.push({
              klass: "broken-link",
              severity: "P1",
              device: device.label,
              route: path,
              element: { sel: "(funnel)", text: journey.id },
              detail: `Funnel step did not progress: expected path ${step.expectPath}, still at "${path}". The prior tap may be a DEAD control.`,
            });
          }
        } else if (step.settle !== undefined) {
          await page.waitForTimeout(Math.min(Number(step.settle) || 0, 3000));
          rec.result = { settled: step.settle };
        } else if (step.note !== undefined) {
          rec.result = { note: true };
        }
      } catch (e) {
        rec.result = { error: String(e.message || e).slice(0, 160) };
      }

      // A dead interactive tap (visible control, no effect, no navigation) is a
      // first-class functional finding.
      if (
        (rec.kind === "tapTestId" || rec.kind === "tapText" || rec.kind === "tapRole") &&
        rec.result &&
        rec.result.ok === false
      ) {
        findings.push({
          klass: "broken-link",
          severity: "P2",
          device: device.label,
          route: routeOf(),
          element: { sel: rec.kind, text: JSON.stringify(step[rec.kind]) },
          detail: `Persona "${journey.id}" could not act on a control: ${rec.result.reason}. From a real user this is "I tapped it and nothing happened."`,
        });
      }

      rec.screenshot = await shot(rec.kind);
      await runProbes(`step${stepNo}-${rec.kind}`);
      steps.push(rec);
    }
  }

  const cls = await page.evaluate(() => window.__lwCLS || 0).catch(() => 0);

  // Console / page errors -> findings (deduped).
  for (const txt of [...new Set(pageErrors)]) {
    findings.push({
      klass: "console-error",
      severity: "P1",
      device: device.label,
      route: routeOf(),
      element: { sel: "(uncaught)" },
      detail: `Uncaught exception during the walk: ${txt}`,
    });
  }
  for (const txt of [...new Set(consoleErrors)].slice(0, 10)) {
    findings.push({
      klass: "console-error",
      severity: "P2",
      device: device.label,
      route: routeOf(),
      element: { sel: "(console.error)" },
      detail: `console.error during the walk: ${txt}`,
    });
  }
  for (const txt of [...new Set(failedRequests)].slice(0, 10)) {
    findings.push({
      klass: "broken-link",
      severity: "P2",
      device: device.label,
      route: routeOf(),
      element: { sel: "(network)" },
      detail: `Failed request during the walk: ${txt}`,
    });
  }
  if (cls > 0.1) {
    findings.push({
      klass: "layout-shift",
      severity: cls > 0.25 ? "P2" : "P3",
      device: device.label,
      route: journey.start,
      element: { sel: "(page)" },
      detail: `Cumulative Layout Shift was ${cls.toFixed(3)} over the walk (Google "good" is < 0.1). Content jumps under the user as it loads.`,
    });
  }

  // Finalize artifacts.
  const tracePath = join(opts.out, "trace", `${tag}.zip`);
  mkdirSync(join(opts.out, "trace"), { recursive: true });
  await context.tracing.stop({ path: tracePath });
  await context.close(); // flush video
  await browser.close();

  let videoFile = null;
  if (opts.video === "on") {
    try {
      const { readdirSync } = await import("node:fs");
      const f = readdirSync(videoDir).find((x) => x.endsWith(".webm"));
      if (f) videoFile = join("video", tag, f);
    } catch {
      /* ignore */
    }
  }

  sink.walks.push({
    device: device.label,
    deviceId: device.id,
    journey: journey.id,
    persona: journey.persona,
    group: journey.group,
    goal: journey.goal,
    start: journey.start,
    steps,
    cls,
    consoleErrors: [...new Set(consoleErrors)].slice(0, 10),
    pageErrors: [...new Set(pageErrors)],
    failedRequests: [...new Set(failedRequests)].slice(0, 10),
    trace: tracePath.replace(opts.out + "/", ""),
    video: videoFile,
    findings,
  });
  for (const fdg of findings)
    sink.findings.push({ ...fdg, journey: journey.id, deviceId: device.id });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  opts.out = resolve(opts.out);

  // Load the two app-specific inputs (stubs + journeys) up front; fail loud if missing.
  const app = await loadAppInputs(opts);

  if (existsSync(opts.out)) rmSync(opts.out, { recursive: true, force: true });
  mkdirSync(opts.out, { recursive: true });

  const devices = deviceList(opts.devices);
  const journeys = opts.journeys
    ? app.JOURNEYS.filter((j) =>
        opts.journeys
          .split(",")
          .map((s) => s.trim())
          .includes(j.id),
      )
    : app.JOURNEYS;

  const sink = {
    startedAt: new Date().toISOString(),
    url: opts.url,
    appName: opts.appName || null,
    stubs: app.stubsPath,
    journeysFile: app.journeysPath,
    walks: [],
    findings: [],
  };

  // Pick engine. Default: each device's preferred engine, with a Chromium
  // fallback if WebKit is unavailable. --engine forces one for all.
  const forced = opts.engine ? ENGINES[opts.engine] : null;

  console.log(
    `live-walkthrough: ${devices.length} devices x ${journeys.length} journeys = ${devices.length * journeys.length} walks against ${opts.url}`,
  );
  console.log(`  stubs:    ${app.stubsPath}`);
  console.log(`  journeys: ${app.journeysPath} (${app.JOURNEYS.length} defined)`);

  for (const device of devices) {
    let engineName = forced ? opts.engine : device.engine;
    let engineImpl = forced || ENGINES[device.engine];
    // Feasibility fallback: if WebKit can't launch here, drop to Chromium.
    try {
      const probe = await engineImpl.launch({ headless: true });
      await probe.close();
    } catch (e) {
      console.warn(
        `  [!] ${engineName} unavailable (${String(e.message || e).slice(0, 60)}); falling back to chromium for ${device.id}`,
      );
      engineImpl = chromium;
      engineName = "chromium-fallback";
    }
    for (const journey of journeys) {
      process.stdout.write(`  - ${device.id} / ${journey.id} [${engineName}] ... `);
      try {
        await runJourneyOnDevice(engineImpl, { ...device, engineName }, journey, opts, app, sink);
        const n = sink.walks[sink.walks.length - 1].findings.length;
        console.log(`${n} finding(s)`);
      } catch (e) {
        console.log(`WALK ERROR: ${String(e.message || e).slice(0, 120)}`);
        sink.findings.push({
          klass: "probe-error",
          severity: "P2",
          device: device.label,
          deviceId: device.id,
          journey: journey.id,
          route: journey.start,
          element: { sel: "(runner)" },
          detail: `The walk crashed: ${String(e.message || e).slice(0, 200)}`,
        });
      }
    }
  }

  sink.finishedAt = new Date().toISOString();
  sink.engineNote = forced
    ? `forced engine: ${opts.engine}`
    : "per-device engine (webkit primary, chromium fallback)";
  writeFileSync(join(opts.out, "findings.json"), JSON.stringify(sink, null, 2));
  console.log(`\nDONE. ${sink.findings.length} total findings across ${sink.walks.length} walks.`);
  console.log(`findings.json -> ${join(opts.out, "findings.json")}`);
}

main().catch((e) => {
  console.error("runner fatal:", e);
  process.exit(1);
});
