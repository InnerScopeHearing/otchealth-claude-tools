import assert from 'node:assert/strict';
import { ProfileLeaseStore, allowed, pageGate, validateTask } from '../src/policy.mjs';

const valid = {
  provider: 'internal-demo',
  role: 'cto',
  profileId: 'profile_internal_demo_cto',
  persistProfile: true,
  allowlist: ['example.com'],
  steps: [{ goto: 'https://example.com' }],
  maxSteps: 5,
  maxSeconds: 60,
};

assert.equal(validateTask(valid).ok, true);
assert.equal(validateTask({ ...valid, profileId: '' }).ok, false);
assert.equal(validateTask({ ...valid, persistProfile: false }).ok, false);
assert.equal(validateTask({ ...valid, maxSteps: 31 }).ok, false);
assert.equal(allowed('app.example.com', valid.allowlist), true);
assert.equal(allowed('example.com.evil.test', valid.allowlist), false);
assert.equal(pageGate('<input aria-label="Credit Card Number">'), 'HARD_GATE');
assert.equal(pageGate('<p>Enter the verification code we texted you</p>'), 'TWOFA_GATE');
assert.equal(pageGate('<p>Allow access to the internal demo</p>'), null);

const leases = new ProfileLeaseStore();
assert.equal(leases.acquire(valid).ok, true);
assert.equal(leases.acquire(valid).ok, false);
leases.release(valid);
assert.equal(leases.acquire(valid).ok, true);
console.log('Browser Operations policy tests passed');
