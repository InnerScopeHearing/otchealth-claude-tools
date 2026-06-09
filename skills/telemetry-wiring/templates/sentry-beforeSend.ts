// sentry-beforeSend.ts — strip PHI/PII before any event leaves the device.
// Wire as Sentry.init({ beforeSend, beforeSendTransaction: beforeSend, ... }).
// Defense in depth: pair with server-side Advanced Data Scrubbing + (PHI app) Relay.

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const TOKENISH = /\b(sk-|phx_|r8_|sntry|nfp_|cfut_|dtn_)[A-Za-z0-9_\-]+/g;
// App-specific PHI keys to drop entirely (extend per app):
const PHI_KEYS = ['name', 'firstName', 'lastName', 'dob', 'mrn', 'audiogram', 'medication', 'diagnosis', 'address', 'phone'];

function redact(s: string): string {
  return s.replace(EMAIL, '[email]').replace(TOKENISH, '[redacted]');
}

function scrub(obj: any, depth = 0): any {
  if (obj == null || depth > 6) return obj;
  if (typeof obj === 'string') return redact(obj);
  if (Array.isArray(obj)) return obj.map((v) => scrub(v, depth + 1));
  if (typeof obj === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = PHI_KEYS.includes(k) ? '[phi]' : scrub(v, depth + 1);
    }
    return out;
  }
  return obj;
}

export function beforeSend(event: any): any {
  try {
    if (event.request?.cookies) delete event.request.cookies;
    if (event.user) { delete event.user.email; delete event.user.ip_address; delete event.user.username; }
    return scrub(event);
  } catch {
    return event; // never drop telemetry due to a scrub bug; fail open on shape, closed on fields above
  }
}
