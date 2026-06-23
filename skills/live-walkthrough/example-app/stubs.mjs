// example-app/stubs.mjs — a MINIMAL reference implementation of the app-specific
// stubs module, showing the exact contract the runner expects. Copy this into your
// app at qa/live-walkthrough/stubs.mjs and replace the routes with your API.
//
// CONTRACT (what the runner imports from this file):
//   export async function installStubs(page, { authenticated }) { ... }
//     Wire EVERY backend route the walk touches with Playwright route fulfill(),
//     so the app renders with NO real backend and NO secrets. Fake the signed-in
//     session here when `authenticated` is true; serve a 401 / logged-out state
//     when false (a cold-open persona then sees the real front door).
//   export const ROUTE_PATTERNS = [ /^\/$/, ... ]   // optional
//     The app's known client-side route paths (RegExp[]). The link probe flags any
//     in-app <a href> whose path matches none of these (a dead/typo link). Omit
//     (or export []) to disable that static check.
//
// Non-PHI ring: all data here is synthetic. Never use real user data or secrets.

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

export async function installStubs(page, opts = {}) {
  const authenticated = opts.authenticated !== false;

  // Fake the signed-in session the app's auth layer reads (adjust the storage key
  // to your app). For a logged-out walk, do not set it and serve /me -> 401 below.
  if (authenticated) {
    await page.addInitScript(() => {
      try {
        localStorage.setItem("example:session", "lw-session-token");
      } catch {
        /* ignore */
      }
    });
  }

  // Catch-all FIRST (Playwright matches last-registered-first, so specific routes
  // below win). Any other same-origin API-ish fetch gets an empty-but-valid JSON
  // envelope so the UI never hangs on an unmodelled endpoint. Document/asset GETs
  // are deliberately NOT swallowed so a genuinely missing asset still surfaces.
  await page.route(
    (url) =>
      url.hostname === "127.0.0.1" &&
      !/\.(html?|js|mjs|css|png|jpe?g|webp|svg|gif|ico|woff2?|ttf|mp4|webm|map|json)$/i.test(
        url.pathname,
      ) &&
      url.pathname !== "/",
    (r) => {
      const rt = r.request().resourceType();
      if (rt === "fetch" || rt === "xhr") return json(r, {});
      return r.continue();
    },
  );

  // The app-specific routes. Replace these with your real API surface.
  await page.route("**/me", (r) =>
    authenticated
      ? json(r, { user: { id: "lw-1", display_name: "Example User" } })
      : json(r, { error: "unauthorized" }, 401),
  );
  await page.route("**/items", (r) => json(r, { items: [] }));
}

// Known client-side route paths (from your router). The link probe uses these.
export const ROUTE_PATTERNS = [/^\/$/, /^\/about$/];
