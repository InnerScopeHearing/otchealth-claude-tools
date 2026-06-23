#!/usr/bin/env node
// selftest.mjs — prove each probe CATCHES its target bug class, and does NOT
// false-positive on the by-design cases (horizontal scroller, off-screen a11y
// skip link). Runs against synthetic pages with KNOWN defects, so it validates
// the detectors independent of any app. Exit 0 = all probes behave.
//
// This is what `run-tests.sh` invokes as the skill's selftest. It needs a browser
// engine (webkit OR chromium) installed; in the toolkit gate it is skipped unless
// RUN_BROWSER_TESTS=1 (browsers are a heavy download), exactly like browser-agent.
//
// Usage: node skills/live-walkthrough/selftest.mjs
// Requires webkit OR chromium installed (npx playwright install webkit chromium).

import { webkit, chromium } from "@playwright/test";
import {
  probeStickyIntegrity,
  probeHorizontalBleed,
  probeTextClip,
  probeTapTargets,
} from "./lib/probes.mjs";

const PASS = "\x1b[32mPASS\x1b[0m";
const FAIL = "\x1b[31mFAIL\x1b[0m";
let failures = 0;
const check = (name, cond, info = "") => {
  console.log(`  ${cond ? PASS : FAIL}  ${name}${info ? "  — " + info : ""}`);
  if (!cond) failures++;
};

// A page that (a) has a position:fixed bar inside a transformed ancestor, which
// WebKit/Blink scope to that ancestor so it DRIFTS on scroll (the real "fixed bar
// breaks on scroll" bug), (b) an in-flow row that bleeds 200px past the viewport
// inside the VERTICAL scroller (must be flagged), (c) a dedicated horizontal strip
// whose children legitimately overflow (must NOT be flagged), (d) a clipped-text
// label in normal flow (flagged), (e) a 24px tap target, (f) an off-screen a11y
// skip link (must NOT be flagged). The scroller uses the default ".app-shell__scroll"
// class the probes look for (apps with a different shell pass --scroll-sel).
const BUGGY = `<!doctype html><html><head><meta name=viewport content="width=device-width">
<style>
 html,body{margin:0}
 .app-shell__scroll{height:100vh;overflow:auto}
 /* a transformed ancestor: position:fixed inside it is scoped to it and DRIFTS */
 .xform{transform:translateZ(0);will-change:transform}
 .content{height:3000px;padding-top:60px}
 .badbar{position:fixed;top:0;left:0;right:0;height:50px;background:#a00;color:#fff}
 /* BUG: in-flow element wider than viewport (inside the vertical scroller) */
 .bleeder{width:200%;height:40px;background:#0a0}
 /* by-design: DEDICATED horizontal scroller. Only overflow-x is set (as a real
    app does); the browser forces computed overflow-y to auto, so the probe must
    distinguish by SCROLL DIMENSIONS (scrolls X, not Y), not the overflow property. */
 .strip{display:flex;overflow-x:auto;gap:8px}
 .strip .col{flex:0 0 80px;height:60px;background:#06c;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
 /* BUG: clipped text in normal flow */
 .clip{width:80px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:#333;color:#fff}
 /* BUG: tiny tap target */
 .tiny{width:24px;height:24px}
 /* by-design: off-screen a11y skip link */
 .skip{position:absolute;top:0;left:50%;transform:translateX(-50%) translateY(-100%)}
</style></head><body>
 <div class="app-shell__scroll">
   <div class="xform">
     <div class="badbar">fixed bar that rides content (bug)</div>
   </div>
   <a class="skip" href="#m">Skip to content</a>
   <div class="content">
     <div class="bleeder">row bleeding past the edge (bug)</div>
     <div class="strip">${Array.from({ length: 20 }, (_, i) => `<div class="col">Hole ${i + 1} par 4 long label</div>`).join("")}</div>
     <div class="clip">a very long clipped label that does not fit</div>
     <button class="tiny">x</button>
   </div>
 </div>
</body></html>`;

// A clean page: a CORRECT fixed bar (on body, not the scroller) + no bleed.
const CLEAN = `<!doctype html><html><head><meta name=viewport content="width=device-width">
<style>html,body{margin:0}.app-shell__scroll{height:100vh;overflow:auto}.c{height:3000px;padding-top:60px}
 .goodbar{position:fixed;top:0;left:0;right:0;height:50px;background:#060}
 button{min-width:48px;min-height:48px}</style></head><body>
 <div class="goodbar">pinned bar</div>
 <div class="app-shell__scroll"><div class="c"><button>OK button</button></div></div>
</body></html>`;

async function pickEngine() {
  for (const [n, e] of [
    ["webkit", webkit],
    ["chromium", chromium],
  ]) {
    try {
      const b = await e.launch({ headless: true });
      await b.close();
      return [n, e];
    } catch {
      /* try next */
    }
  }
  throw new Error("no browser engine available (install webkit or chromium)");
}

async function run() {
  const [name, engine] = await pickEngine();
  console.log(`live-walkthrough selftest (engine: ${name})`);
  const ctxOpts = {
    viewport: { width: 320, height: 640 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  };
  const browser = await engine.launch({ headless: true });
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  const C = { device: "selftest", route: "/buggy" };

  // ---- buggy page: each probe must fire -----------------------------------
  await page.setContent(BUGGY);
  await page.waitForTimeout(100);

  const sticky = await probeStickyIntegrity(page, C);
  check(
    "sticky-detach fires on a fixed bar nested in the scroller",
    sticky.some((f) => f.klass === "sticky-detach"),
    `${sticky.length} finding(s)`,
  );

  const bleed = await probeHorizontalBleed(page, C);
  check(
    "horizontal-bleed fires on the 200% row",
    bleed.some(
      (f) =>
        f.klass === "horizontal-bleed" &&
        /bleeder|document/.test(f.element.sel + (f.element.text || "")),
    ),
    `${bleed.length} finding(s)`,
  );
  check(
    "horizontal-bleed does NOT flag the .strip scroller children (by design)",
    !bleed.some((f) => /\.col\b/.test(f.element.sel)),
  );

  const clip = await probeTextClip(page, C);
  check(
    "text-clip fires on the clipped label",
    clip.some((f) => /\.clip/.test(f.element.sel)),
    `${clip.length} finding(s)`,
  );
  check(
    "text-clip does NOT flag the .strip ellipsis cols (by design)",
    !clip.some((f) => /\.col\b/.test(f.element.sel)),
  );

  const taps = await probeTapTargets(page, C);
  check(
    "tap-target fires on the 24px button",
    taps.some((f) => /\.tiny/.test(f.element.sel)),
    `${taps.length} finding(s)`,
  );
  check(
    "tap-target does NOT flag the off-screen .skip link",
    !taps.some((f) => /\.skip/.test(f.element.sel)),
  );

  // ---- clean page: the structural probes must be quiet --------------------
  await page.setContent(CLEAN);
  await page.waitForTimeout(100);
  const cleanSticky = await probeStickyIntegrity(page, { device: "selftest", route: "/clean" });
  check("sticky-detach is quiet on a correctly-pinned bar", cleanSticky.length === 0);
  const cleanBleed = await probeHorizontalBleed(page, { device: "selftest", route: "/clean" });
  check(
    "horizontal-bleed is quiet on a clean page",
    cleanBleed.length === 0,
    `${cleanBleed.length} finding(s)`,
  );
  const cleanTaps = await probeTapTargets(page, { device: "selftest", route: "/clean" });
  check("tap-target is quiet when controls are >= 48px", cleanTaps.length === 0);

  await browser.close();
  console.log(failures === 0 ? `\nAll probe checks passed.` : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error("selftest error:", e);
  process.exit(1);
});
