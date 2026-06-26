/**
 * visual-walkthrough.spec.ts — the gate FourVault's headless splash would have failed.
 *
 * Screenshots every route at iPhone 16 Pro size and FAILS any screen that is
 * mostly one flat color (blank/stuck/unmounted). The captured PNGs are persisted
 * to test-results/screens/ for the art-director vision judge (focus-group-loop),
 * which catches composition bugs the heuristic can't (occluded subject, double-
 * composited image, clipped text, wrong brand color).
 *
 * The flat-color check uses pngjs if available; otherwise it degrades to a
 * DOM-richness assertion so the spec runs with zero extra deps.
 */
import { test, expect } from "@playwright/test";

const IP16 = { width: 402, height: 874 };
test.use({ viewport: IP16 });

// Fill from the app's route list (steal from demo-eval.spec.ts). Authenticated
// routes need the app's seed-session init script — see fixtures.ts.
const SCREENS: Array<{ name: string; path: string }> = [
  { name: "splash", path: "/" },
  // { name: "signin", path: "/signin" },
  // { name: "home", path: "/home" },
  // ...
];

/** Fraction of pixels that are the single most common (quantized) color.
 *  ~1.0 == one flat color == blank/stuck/unmounted. Returns null if pngjs absent. */
async function dominantColorFraction(buf: Buffer): Promise<number | null> {
  let PNG: any;
  try {
    ({ PNG } = await import("pngjs"));
  } catch {
    return null; // pngjs not installed — caller falls back to the DOM check
  }
  const png = PNG.sync.read(buf);
  const counts = new Map<number, number>();
  for (let i = 0; i < png.data.length; i += 4) {
    // quantize to 5 bits/channel so anti-aliasing noise doesn't fragment buckets
    const key =
      ((png.data[i] >> 3) << 10) |
      ((png.data[i + 1] >> 3) << 5) |
      (png.data[i + 2] >> 3);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const total = png.data.length / 4;
  return Math.max(...counts.values()) / total;
}

for (const s of SCREENS) {
  test(`render gate: ${s.name} is not a flat blank screen`, async ({ page }) => {
    await page.goto(s.path, { waitUntil: "networkidle" });
    await page.waitForTimeout(700); // let splash settle / animations finish
    const shot = await page.screenshot({ path: `test-results/screens/${s.name}.png` });

    const frac = await dominantColorFraction(shot);
    if (frac !== null) {
      // >92% one color = almost certainly a stuck splash / unmounted screen.
      // (PlantID's green screen scores ~0.99 here.)
      expect(
        frac,
        `${s.name} is ${(frac * 100).toFixed(1)}% a single flat color — looks blank/stuck.`,
      ).toBeLessThan(0.92);
    } else {
      // Dependency-free fallback: assert the screen rendered a real UI tree.
      const nodeCount = await page.locator("#root *").count();
      expect(nodeCount, `${s.name}: #root mounted only ${nodeCount} elements.`)
        .toBeGreaterThan(5);
    }
  });
}

/*
 * THE ART-DIRECTOR JUDGE (run after this spec, over test-results/screens/):
 *   node /tmp/octools/skills/focus-group-loop/fgl.mjs round --catalog \
 *        --screens test-results/screens
 * or the designer art-director:
 *   node /tmp/octools/skills/designer/scripts/art-director.mjs \
 *        --dir test-results/screens --intent "<app> screens at 402x874"
 * Gate the build on no FAIL: a subject occluded/decapitated by an overlay, an
 * image composited over one that already contains it, clipped/overlapping text,
 * a flat background with no UI, or wrong brand color. Catalog findings to the brain.
 */
