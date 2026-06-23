// devices.mjs — the phone-size matrix (app-agnostic, shared across every app).
//
// Every journey runs against EACH of these. They span the responsive range:
//   - iPhone SE        375x667  @2x   the SMALL screen where layout breaks first
//   - iPhone 14        390x844  @3x   the modern baseline
//   - iPhone 15 Pro Max 430x932 @3x   the LARGE screen (wasted space / stretched)
//   - Pixel 7          412x915  @2.625 a non-Apple engine + Android viewport
//
// Each entry uses Playwright's real device descriptor: viewport + deviceScaleFactor
// + isMobile + hasTouch + a device user-agent. WebKit is used for the iPhones (it
// is the engine inside the iOS WKWebView a Capacitor app actually ships in); the
// Pixel can run on WebKit too for engine-parity, or Chromium for Blink coverage.
import { devices as pw } from "@playwright/test";

export const MATRIX = [
  {
    id: "iphone-se",
    label: "iPhone SE (small, 375px)",
    descriptor: pw["iPhone SE"],
    engine: "webkit",
  },
  {
    id: "iphone-14",
    label: "iPhone 14 (baseline, 390px)",
    descriptor: pw["iPhone 14"],
    engine: "webkit",
  },
  {
    id: "iphone-15-pro-max",
    label: "iPhone 15 Pro Max (large, 430px)",
    descriptor: pw["iPhone 15 Pro Max"],
    engine: "webkit",
  },
  { id: "pixel-7", label: "Pixel 7 (Android, 412px)", descriptor: pw["Pixel 7"], engine: "webkit" },
];

/** Resolve the device matrix, optionally filtered to a comma-separated id list. */
export function deviceList(only) {
  if (!only) return MATRIX;
  const want = new Set(only.split(",").map((s) => s.trim()));
  return MATRIX.filter((d) => want.has(d.id));
}
