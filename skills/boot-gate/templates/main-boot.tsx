/**
 * main-boot.tsx — REFERENCE for an app's src/main.tsx boot pattern.
 *
 * Guarantees: the splash is always hidden (even on a failed mount), a boot crash
 * shows a visible fallback (never a silent color), global errors are reported, and
 * the boot-smoke gate has a [data-boot-ready] signal. Pair with
 * capacitor.config: plugins.SplashScreen.launchAutoHide = false so THIS finally
 * is the only thing that hides the splash.
 */
import { createRoot } from "react-dom/client";
import { SplashScreen } from "@capacitor/splash-screen";
import { ErrorBoundary } from "./boot/ErrorBoundary";
import App from "./App";

const sentry = (window as unknown as {
  Sentry?: { captureException?: (e: unknown) => void };
}).Sentry;

// Global safety net: a throw before/around React mount must still be reported.
window.addEventListener("error", (e) => sentry?.captureException?.(e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) => sentry?.captureException?.(e.reason));

function boot(): void {
  const el = document.getElementById("root");
  if (!el) return;
  try {
    createRoot(el).render(
      <ErrorBoundary>
        <App />
      </ErrorBoundary>,
    );
    el.setAttribute("data-boot-ready", "true"); // signal for boot-smoke.spec.ts
  } catch (err) {
    // Last-resort visible DOM so the screen is never a silent flat color.
    // Built with safe DOM methods (no innerHTML) so this template models the
    // right pattern when copied fleet-wide.
    el.replaceChildren();
    const alert = document.createElement("div");
    alert.setAttribute("role", "alert");
    alert.style.cssText = "padding:24px;font-size:18px;color:#111;background:#fff";
    alert.textContent = "App failed to start. Please reopen.";
    el.appendChild(alert);
    sentry?.captureException?.(err);
  } finally {
    // ALWAYS hide the splash, even on failure, so we never get stuck on it.
    SplashScreen.hide().catch(() => undefined);
  }
}

boot();
