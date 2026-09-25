// lib.mjs -- pure, network-free helpers for rc-dashboard.mjs (unit-tested directly).

// A RevenueCat v2 secret key as rendered in the dashboard once revealed.
const SECRET_RE = /\bsk_[A-Za-z0-9]{20,}\b/;
// A public SDK key: App Store (appl_), Play (goog_), Amazon (amzn_), Stripe/web (strp_/rcb_), Test Store (test_).
const PUBLIC_RE = /\b(appl|goog|amzn|strp|rcb|test)_[A-Za-z0-9]{16,}\b/g;

export function extractSecretKey(text) {
  const m = String(text || "").match(SECRET_RE);
  return m ? m[0] : null;
}

export function extractPublicKeys(text) {
  return [...String(text || "").matchAll(PUBLIC_RE)].map((m) => ({ kind: m[1], key: m[0] }));
}

// Never print a key: show its prefix and length only.
export function redactKey(key) {
  const s = String(key || "");
  const i = s.indexOf("_");
  return i > 0 ? `${s.slice(0, i + 1)}*** (len ${s.length})` : `*** (len ${s.length})`;
}

// Mask every secret (sk_) and public SDK key in text before it is printed. Used on all page-text
// output (`run` dump/inputs) so a revealed key on an authenticated page can never reach stdout.
export function redactText(text) {
  return String(text ?? "")
    .replace(/\bsk_[A-Za-z0-9]{20,}\b/g, (m) => redactKey(m))
    .replace(/\b(appl|goog|amzn|strp|rcb|test)_[A-Za-z0-9]{16,}\b/g, (m) => redactKey(m));
}

// Dashboard project ids appear in URLs without the "proj" prefix the v2 API uses.
export function dashboardProjectId(id) {
  return String(id || "").replace(/^proj/, "");
}

const ACTION_KEYS = ["click", "role", "css", "fill", "label", "xy", "press", "dump", "inputs", "wait"];

// Validate an actions file for `run`. Each step is one object; unknown keys are rejected so a typo
// fails loudly instead of silently doing nothing on a live account.
export function validateActions(actions) {
  if (!Array.isArray(actions)) throw new Error("actions must be a JSON array");
  actions.forEach((a, i) => {
    if (!a || typeof a !== "object") throw new Error(`action ${i} is not an object`);
    const unknown = Object.keys(a).filter((k) => !ACTION_KEYS.includes(k) && !["exact", "name", "value"].includes(k));
    if (unknown.length) throw new Error(`action ${i} has unknown key(s): ${unknown.join(", ")}`);
    if ((a.fill || a.label) && typeof a.value !== "string") throw new Error(`action ${i}: fill/label needs a string value`);
    if (a.role && !a.name) throw new Error(`action ${i}: role needs a name`);
    if (a.xy && !(Array.isArray(a.xy) && a.xy.length === 2 && a.xy.every(Number.isFinite))) throw new Error(`action ${i}: xy must be [x, y]`);
  });
  return actions;
}
