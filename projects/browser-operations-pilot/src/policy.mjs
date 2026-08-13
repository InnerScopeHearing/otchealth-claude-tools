#!/usr/bin/env node
/**
 * Browser Operations pilot policy. This coordinator is provider-neutral: its
 * runtime adapter targets AgentCore Browser over CDP, while preserving the
 * browser-agent safety model in a non-PHI lane.
 */
export const HARD_GATE = /(?:\b(card number|cvv|cvc|credit card|debit card|payment method|billing address|routing number|bank account number|social security|ssn\b|date of birth|driver.?s? licen|passport number|docusign|adobe sign|sign here|e-?signature|i agree and sign|notariz)\b)|card\s*#|\bcc\s+(?:number|num|#)|agree\s*(?:&|and)\s*sign|\be[\s-]?sign\b/i;
export const TWOFA = /(?:\b(verification code|one[- ]time (code|passcode)|2-step|two[- ]factor|authenticator app|approve (this )?(sign|request) on your|enter the code|we (sent|texted) you a code|security code)\b)|\b\d\s*-?\s*digit\s+(?:code|pin|passcode)|code from your (?:text|sms|phone|email|message)|\bsms code\b/i;

export const allowed = (host, allowlist) => allowlist.some((item) => {
  const candidate = String(item).toLowerCase();
  return host === candidate || host.endsWith(`.${candidate}`);
});

export const profileKey = ({ provider, role, profileId }) => `${provider}:${role}:${profileId}`;

export function validateTask(task) {
  const issues = [];
  if (!task || typeof task !== 'object') issues.push('task must be an object');
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/i.test(task?.provider || '')) issues.push('provider must be a slug');
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/i.test(task?.role || '')) issues.push('role must be a slug');
  if (!/^profile_[a-z0-9_-]{3,128}$/i.test(task?.profileId || '')) issues.push('profileId must be a named non-secret identifier');
  if (task?.persistProfile !== true) issues.push('persistProfile must be explicitly true');
  if (!Array.isArray(task?.allowlist) || task.allowlist.length === 0) issues.push('allowlist is required');
  if (!Array.isArray(task?.steps) || task.steps.length === 0) issues.push('steps are required');
  if (!Number.isInteger(task?.maxSteps) || task.maxSteps < 1 || task.maxSteps > 30) issues.push('maxSteps must be 1-30');
  if (!Number.isInteger(task?.maxSeconds) || task.maxSeconds < 1 || task.maxSeconds > 300) issues.push('maxSeconds must be 1-300');
  return { ok: issues.length === 0, issues };
}

export function pageGate(html) {
  if (HARD_GATE.test(html || '')) return 'HARD_GATE';
  if (TWOFA.test(html || '')) return 'TWOFA_GATE';
  return null;
}

export class ProfileLeaseStore {
  #active = new Set();
  acquire(task) {
    const key = profileKey(task);
    if (this.#active.has(key)) return { ok: false, reason: 'profile_in_use' };
    this.#active.add(key);
    return { ok: true, key };
  }
  release(task) { this.#active.delete(profileKey(task)); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sample = { provider: 'internal-demo', role: 'cto', profileId: 'profile_internal_demo_cto', persistProfile: true, allowlist: ['example.com'], steps: [{ goto: 'https://example.com' }], maxSteps: 5, maxSeconds: 60 };
  const verdict = validateTask(sample);
  if (!verdict.ok) throw new Error(verdict.issues.join('; '));
  console.log('Browser Operations policy self-check passed');
}
