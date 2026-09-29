// deadline.mjs -- bound every network call brain-save makes (adjudication round 3).
//
// Nothing had a deadline: only undici's ~300 s default applied, and the verify retries multiplied it, so
// one black-holed dependency (S3, OpenSearch, OpenAI embeddings, the gateway, the token mint) could hang a
// workflow's final step for tens of minutes. Every backend method now races a per-call timer
// (BRAIN_SAVE_CALL_TIMEOUT_MS, default 30 s) and, for `put`, an overall budget (BRAIN_SAVE_DEADLINE_MS,
// default 15 min). A timeout rejects with DeadlineError; the pipeline maps it like any dependency failure:
// before anything is stored -> exit 1, after the object is stored -> exit 3. The real backend also passes
// an AbortSignal to the gateway fetch so its socket is released, and the CLI exits once its output has
// flushed, so a hung socket cannot hold the process open after the answer is known.

export const DEFAULT_CALL_TIMEOUT_MS = 30000;
export const DEFAULT_PUT_DEADLINE_MS = 15 * 60 * 1000;
export const DEFAULT_SSM_TIMEOUT_MS = 90000;

export class DeadlineError extends Error {
  constructor(message) { super(message); this.name = "DeadlineError"; this.deadline = true; }
}

function envMs(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
export const callTimeoutMs = () => envMs("BRAIN_SAVE_CALL_TIMEOUT_MS", DEFAULT_CALL_TIMEOUT_MS);
export const putDeadlineMs = () => envMs("BRAIN_SAVE_DEADLINE_MS", DEFAULT_PUT_DEADLINE_MS);
export const ssmTimeoutMs = () => envMs("BRAIN_SAVE_SSM_TIMEOUT_MS", DEFAULT_SSM_TIMEOUT_MS);

/** Race `promise` against `ms`. The loser's eventual rejection is swallowed (never an unhandled rejection);
 *  the timer is always cleared, so it never holds the event loop open. */
export function withTimeout(promise, ms, label) {
  const p = Promise.resolve(promise);
  p.catch(() => {});
  if (!(ms > 0) || !Number.isFinite(ms)) return p;
  let timer;
  const t = new Promise((_, reject) => { timer = setTimeout(() => reject(new DeadlineError(`${label} timed out after ${Math.round(ms)} ms`)), ms); });
  t.catch(() => {});
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/** Wrap every method of a backend in a per-call deadline, capped by an overall `deadlineAt` (epoch ms).
 *  Non-function properties pass through unchanged (a Proxy), so test fakes keep their counters. */
export function withDeadlines(backend, { callMs = callTimeoutMs(), deadlineAt = 0 } = {}) {
  if (!backend || backend.__deadlines) return backend;
  return new Proxy(backend, {
    get(target, prop, receiver) {
      if (prop === "__deadlines") return true;
      if (prop === "deadlineAt") return deadlineAt;
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      return (...args) => {
        const remaining = deadlineAt ? deadlineAt - Date.now() : Infinity;
        if (remaining <= 0) return Promise.reject(new DeadlineError(`the overall brain-save deadline passed before ${String(prop)}`));
        let r;
        try { r = v.apply(target, args); } catch (e) { return Promise.reject(e); }
        return withTimeout(r, Math.min(callMs, remaining), `${String(prop)}()`);
      };
    },
  });
}
