// probes.mjs — the interaction + responsive bug detectors (app-agnostic, shared).
//
// These are the assertions that catch the bug classes a STATIC screenshot misses.
// Every probe runs against a LIVE page (after the persona has navigated/scrolled/
// interacted) and returns a list of findings. A finding always names the element
// (selector + a text/role snippet) and the device, so it is a builder-ready repro.
//
// Bug classes (mapped to the named "looks fine, but..." concerns):
//   sticky-detach     a fixed/sticky bar that visually detaches from / rides the
//                     content WHEN YOU SCROLL/DRAG (looks fine at rest, breaks in motion)
//   horizontal-bleed  any element whose box extends past the viewport width (the
//                     "looks good on one phone, breaks on another" class)
//   text-clip         text truncated/overflowing its container (scrollWidth>clientWidth)
//   tap-target        an interactive control smaller than the 44x44 CSS px minimum
//   broken-link       an anchor/route that points nowhere the app handles / dead-ends
//   console-error     a JS console error or unhandled rejection during the walk (runner-collected)
//   layout-shift      cumulative layout shift above a jank threshold (runner-collected)
//
// Severity: P1 (blocks the user / breaks the screen), P2 (clearly wrong, degrades
// UX), P3 (polish). Each probe assigns a default; the reporter can re-rank.
//
// NOTE on browser injection: each probe ships ONE self-contained function body to
// page.evaluate. The element-descriptor helper is defined INLINE inside each body
// (not serialized via new Function), so there is no string-built code path.
//
// APP COUPLING: the ONLY app-specific knob is the in-page SCROLL CONTAINER
// selector, passed as `ctx.scrollSel` (default ".app-shell__scroll"). An app whose
// scrollable shell uses a different class sets it once in its journeys/runner flag;
// if the selector matches nothing, the probes fall back to the document scroller,
// so a wrong/empty value degrades gracefully rather than breaking.

const TAP_MIN = 44; // Apple HIG + WCAG 2.5.5 minimum target, CSS px.
const DEFAULT_SCROLL_SEL = ".app-shell__scroll";
const r1 = (n) => Math.round(n * 10) / 10;

/**
 * sticky/fixed-element integrity across a scroll.
 *
 * The real-world failure: a top bar / bottom tab bar / header is position:fixed
 * or sticky and looks perfect at rest, but on scroll it (a) drifts with the
 * content instead of pinning, or (b) ends up overlapping content. A screenshot
 * at rest cannot see this; we measure the bar's box BEFORE and AFTER a real
 * scroll of the actual scroller and flag drift.
 */
export async function probeStickyIntegrity(page, ctx) {
  const findings = [];
  const scrollSel = ctx.scrollSel || DEFAULT_SCROLL_SEL;

  const fixedEls = await page.evaluate(() => {
    const out = [];
    const all = Array.from(document.querySelectorAll("body *"));
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      const cs = getComputedStyle(el);
      if ((cs.position === "fixed" || cs.position === "sticky") && cs.display !== "none") {
        const rect = el.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 8) continue;
        el.setAttribute("data-lw-fixed", String(i));
        out.push({
          idx: i,
          position: cs.position,
          zIndex: cs.zIndex,
          rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
        });
      }
    }
    return out;
  });
  if (fixedEls.length === 0) return findings;

  const scroll = await page.evaluate((sel) => {
    const c = document.querySelector(sel);
    const s =
      c && c.scrollHeight > c.clientHeight + 4
        ? c
        : document.scrollingElement || document.documentElement;
    return { maxTop: Math.max(0, s.scrollHeight - s.clientHeight) };
  }, scrollSel);
  if (scroll.maxTop <= 8) return findings; // nothing to scroll, sticky can't drift

  // Drive a REAL scroll of the actual scroller to ~60% of its range, then read back.
  const after = await page.evaluate((sel) => {
    function describe(el) {
      if (!el) return null;
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : "";
      const tid = el.getAttribute("data-testid");
      const aria = el.getAttribute("aria-label");
      const role = el.getAttribute("role");
      const cls =
        typeof el.className === "string" && el.className.trim()
          ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".")
          : "";
      const txt = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40);
      return {
        sel: `${tag}${id}${cls}${tid ? `[data-testid="${tid}"]` : ""}`,
        role: role || undefined,
        aria: aria || undefined,
        text: txt || undefined,
      };
    }
    const c = document.querySelector(sel);
    const s =
      c && c.scrollHeight > c.clientHeight + 4
        ? c
        : document.scrollingElement || document.documentElement;
    s.scrollTo(0, Math.floor((s.scrollHeight - s.clientHeight) * 0.6));
    const out = {};
    document.querySelectorAll("[data-lw-fixed]").forEach((el) => {
      const idx = el.getAttribute("data-lw-fixed");
      const rect = el.getBoundingClientRect();
      out[idx] = { rect: { x: rect.x, y: rect.y }, desc: describe(el) };
    });
    return out;
  }, scrollSel);
  await page.waitForTimeout(150);

  for (const fe of fixedEls) {
    const a = after[fe.idx];
    if (!a) continue;
    const drift = Math.abs(a.rect.y - fe.rect.y) + Math.abs(a.rect.x - fe.rect.x);
    if (fe.position === "fixed" && drift > 4) {
      findings.push({
        klass: "sticky-detach",
        severity: "P1",
        device: ctx.device,
        route: ctx.route,
        element: a.desc,
        detail: `position:fixed element drifted ${r1(drift)}px during scroll (y ${r1(fe.rect.y)} -> ${r1(a.rect.y)}). A pinned bar must not move when content scrolls.`,
      });
    }
  }
  // restore
  await page.evaluate((sel) => {
    const c = document.querySelector(sel);
    const s =
      c && c.scrollHeight > c.clientHeight + 4
        ? c
        : document.scrollingElement || document.documentElement;
    s.scrollTo(0, 0);
  }, scrollSel);
  return findings;
}

/**
 * horizontal bleed: any IN-FLOW element whose box extends beyond the viewport
 * width. THE responsive bug ("looks good on one phone, breaks on another"). Also
 * flags a horizontally scrollable document (the page itself scrolls sideways).
 */
export async function probeHorizontalBleed(page, ctx) {
  const res = await page.evaluate(() => {
    function describe(el) {
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : "";
      const tid = el.getAttribute("data-testid");
      const aria = el.getAttribute("aria-label");
      const role = el.getAttribute("role");
      const cls =
        typeof el.className === "string" && el.className.trim()
          ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".")
          : "";
      const txt = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40);
      return {
        sel: `${tag}${id}${cls}${tid ? `[data-testid="${tid}"]` : ""}`,
        role: role || undefined,
        aria: aria || undefined,
        text: txt || undefined,
      };
    }
    const vw = document.documentElement.clientWidth;
    const docScroll = document.scrollingElement || document.documentElement;
    const pageScrollsX = docScroll.scrollWidth > vw + 2;
    // A DEDICATED horizontal scroller (carousel / a scorecard strip / a chip
    // row) SCROLLS on X but NOT on Y — its children are SUPPOSED to extend past
    // the viewport, so skip them. We test the actual SCROLL DIMENSIONS, not the
    // computed overflow-y: setting `overflow-x:auto` forces computed overflow-y
    // to `auto` per the CSS Overflow spec, so the property is unreliable. A
    // horizontal-only scroller has scrollWidth>clientWidth and scrollHeight~=
    // clientHeight. This does NOT skip the page's VERTICAL scroller (which scrolls
    // on Y): if its content bleeds sideways, that IS the bug.
    const inDedicatedXScroller = (el) => {
      const vw = document.documentElement.clientWidth;
      let p = el.parentElement;
      while (p && p !== document.body) {
        const pcs = getComputedStyle(p);
        const ox = pcs.overflowX;
        const canScrollX = ox === "auto" || ox === "scroll";
        const scrollsX = p.scrollWidth > p.clientWidth + 2;
        const scrollsY = p.scrollHeight > p.clientHeight + 2;
        if (canScrollX && scrollsX && !scrollsY && p.getBoundingClientRect().right <= vw + 2) {
          return true;
        }
        p = p.parentElement;
      }
      return false;
    };
    const offenders = [];
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      // Author-parked positioned layers legitimately overflow; focus on in-flow.
      if (cs.position === "fixed" || cs.position === "absolute") continue;
      if (inDedicatedXScroller(el)) continue; // legitimately scrollable content
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      const over = Math.max(rect.right - vw, -rect.left);
      if (over > 1) {
        // Report the OUTERMOST offender, not every descendant.
        let parentBleeds = false;
        let p = el.parentElement;
        while (p && p !== document.body) {
          const pr = p.getBoundingClientRect();
          if (Math.max(pr.right - vw, -pr.left) >= over - 1) {
            parentBleeds = true;
            break;
          }
          p = p.parentElement;
        }
        if (!parentBleeds)
          offenders.push({
            ...describe(el),
            overBy: Math.round(over),
            right: Math.round(rect.right),
            vw,
          });
      }
    }
    return {
      vw,
      pageScrollsX,
      docScrollWidth: docScroll.scrollWidth,
      offenders: offenders.slice(0, 25),
    };
  });

  const findings = [];
  if (res.pageScrollsX) {
    findings.push({
      klass: "horizontal-bleed",
      severity: "P1",
      device: ctx.device,
      route: ctx.route,
      element: { sel: "document", text: "page scrolls horizontally" },
      detail: `The page scrolls sideways: scrollWidth ${res.docScrollWidth}px > viewport ${res.vw}px. A mobile app screen should never scroll horizontally.`,
    });
  }
  for (const o of res.offenders) {
    findings.push({
      klass: "horizontal-bleed",
      severity: o.overBy >= 16 ? "P2" : "P3",
      device: ctx.device,
      route: ctx.route,
      element: { sel: o.sel, role: o.role, aria: o.aria, text: o.text },
      detail: `Element extends ${o.overBy}px past the ${o.vw}px viewport (right edge at ${o.right}px). Likely a fixed width / unwrapped row / long unbroken string at this screen size.`,
    });
  }
  return findings;
}

/** text clipping / overflow: a text node overflowing its container box. */
export async function probeTextClip(page, ctx) {
  const offenders = await page.evaluate(() => {
    function describe(el) {
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : "";
      const tid = el.getAttribute("data-testid");
      const aria = el.getAttribute("aria-label");
      const role = el.getAttribute("role");
      const cls =
        typeof el.className === "string" && el.className.trim()
          ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".")
          : "";
      const txt = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40);
      return {
        sel: `${tag}${id}${cls}${tid ? `[data-testid="${tid}"]` : ""}`,
        role: role || undefined,
        aria: aria || undefined,
        text: txt || undefined,
      };
    }
    // ellipsis inside a DEDICATED horizontal scroller (scrolls X, not Y) is by
    // design; the page's vertical scroller is not skipped. Uses scroll dimensions
    // (computed overflow-y is unreliable when overflow-x is set; see bleed probe).
    const inDedicatedXScroller = (el) => {
      let p = el.parentElement;
      while (p && p !== document.body) {
        const pcs = getComputedStyle(p);
        const canScrollX = pcs.overflowX === "auto" || pcs.overflowX === "scroll";
        const scrollsX = p.scrollWidth > p.clientWidth + 2;
        const scrollsY = p.scrollHeight > p.clientHeight + 2;
        if (canScrollX && scrollsX && !scrollsY) return true;
        p = p.parentElement;
      }
      return false;
    };
    const out = [];
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const txt = (el.textContent || "").trim();
      if (!txt || el.children.length > 2) continue;
      if (inDedicatedXScroller(el)) continue;
      const clipsX =
        el.scrollWidth - el.clientWidth > 2 &&
        (cs.overflowX === "hidden" || cs.textOverflow === "ellipsis" || cs.whiteSpace === "nowrap");
      const clipsY =
        el.scrollHeight - el.clientHeight > 2 &&
        cs.overflowY === "hidden" &&
        cs.maxHeight !== "none";
      if (clipsX || clipsY) {
        out.push({
          ...describe(el),
          axis: clipsX ? "x" : "y",
          over: clipsX ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight,
        });
      }
    }
    return out.slice(0, 20);
  });

  return offenders.map((o) => ({
    klass: "text-clip",
    severity: /h[1-3]/.test(o.sel) ? "P2" : "P3",
    device: ctx.device,
    route: ctx.route,
    element: { sel: o.sel, role: o.role, aria: o.aria, text: o.text },
    detail: `Text overflows its container on the ${o.axis}-axis by ${Math.round(o.over)}px and is clipped/ellipsized. Verify the full text is reachable at this screen size.`,
  }));
}

/** tap targets: interactive controls smaller than 44x44 CSS px. */
export async function probeTapTargets(page, ctx) {
  const small = await page.evaluate((min) => {
    function describe(el) {
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : "";
      const tid = el.getAttribute("data-testid");
      const aria = el.getAttribute("aria-label");
      const role = el.getAttribute("role");
      const cls =
        typeof el.className === "string" && el.className.trim()
          ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".")
          : "";
      const txt = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40);
      return {
        sel: `${tag}${id}${cls}${tid ? `[data-testid="${tid}"]` : ""}`,
        role: role || undefined,
        aria: aria || undefined,
        text: txt || undefined,
      };
    }
    const sel =
      'a[href], button, [role="button"], input:not([type="hidden"]), select, textarea, [role="link"], [role="tab"], [role="switch"], [onclick]';
    const out = [];
    const seen = new Set();
    for (const el of Array.from(document.querySelectorAll(sel))) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.pointerEvents === "none")
        continue;
      if (el.disabled) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      const vh = document.documentElement.clientHeight;
      const vw = document.documentElement.clientWidth;
      // Must be genuinely on-screen and tappable: top/left edges inside the
      // viewport. This excludes focus-revealed a11y affordances parked off-screen
      // (e.g. a .skip-link translated above the top edge) which are NOT a real
      // touch target until focused.
      if (rect.top < 0 || rect.left < -1 || rect.top > vh || rect.left > vw) continue;
      const w = Math.floor(rect.width);
      const h = Math.floor(rect.height);
      if (w < min || h < min) {
        const d = describe(el);
        const key = d.sel + "|" + d.text + "|" + Math.round(rect.x) + "," + Math.round(rect.y);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ ...d, w: Math.round(rect.width), h: Math.round(rect.height) });
      }
    }
    return out.slice(0, 30);
  }, TAP_MIN);

  return small.map((s) => ({
    klass: "tap-target",
    severity: Math.min(s.w, s.h) < 32 ? "P2" : "P3",
    device: ctx.device,
    route: ctx.route,
    element: { sel: s.sel, role: s.role, aria: s.aria, text: s.text },
    detail: `Tap target is ${s.w}x${s.h}px, under the 44x44 minimum (Apple HIG / WCAG 2.5.5). Harder to hit on a phone; the control may feel "dead" to a real finger.`,
  }));
}

/**
 * Static link audit on the current screen: in-app anchors whose path matches no
 * known route are flagged (they fall through to the catch-all). Complements the
 * LIVE click-navigation checks the journey performs. Pass the app's known route
 * patterns (an array of RegExp); with an empty list the probe is a no-op.
 */
export async function probeLinks(page, ctx, knownRoutePatterns = []) {
  const links = await page.evaluate(() => {
    function describe(el) {
      const tag = el.tagName.toLowerCase();
      const cls =
        typeof el.className === "string" && el.className.trim()
          ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".")
          : "";
      const txt = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40);
      return {
        sel: `${tag}${cls}`,
        aria: el.getAttribute("aria-label") || undefined,
        text: txt || undefined,
      };
    }
    return Array.from(document.querySelectorAll("a[href]"))
      .map((a) => ({ ...describe(a), href: a.getAttribute("href") }))
      .filter((a) => a.href && !a.href.startsWith("#"));
  });

  const findings = [];
  for (const l of links) {
    const href = l.href;
    if (/^https?:\/\//i.test(href) || href.startsWith("mailto:") || href.startsWith("tel:"))
      continue;
    const path = href.split(/[?#]/)[0];
    if (knownRoutePatterns.length && !knownRoutePatterns.some((re) => re.test(path))) {
      findings.push({
        klass: "broken-link",
        severity: "P2",
        device: ctx.device,
        route: ctx.route,
        element: { sel: l.sel, text: l.text, aria: l.aria },
        detail: `Link points to "${path}", which matches no known app route and will fall through to the catch-all redirect.`,
      });
    }
  }
  return findings;
}
