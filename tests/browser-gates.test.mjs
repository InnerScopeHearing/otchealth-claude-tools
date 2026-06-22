// Unit tests for the browser-agent unattended-consent rails. These are the safety regexes that STOP an
// autonomous browser run before it can submit payment/KYC/e-signature (HARD_GATE) or burn through a 2FA
// step (TWOFA), plus the domain allowlist (off-list host -> refuse). Importing browser.mjs runs no
// browser (playwright is lazy-loaded inside run()), so this is a pure, fast unit test of the rails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HARD_GATE, TWOFA, allowed } from "../skills/browser-agent/browser.mjs";

test("HARD_GATE matches payment / KYC / e-signature copy", () => {
  for (const s of [
    "Please enter your Card number and CVV",
    "Enter your Social Security number",
    "What is your bank account number and routing number?",
    "Sign here with DocuSign to continue",
    "Provide your passport number",
    "Enter your date of birth",
  ]) assert.ok(HARD_GATE.test(s), `should HARD_GATE: ${s}`);
});

test("HARD_GATE does NOT trip on ordinary login / OAuth-consent copy", () => {
  for (const s of [
    "Welcome back. Please enter your email and password.",
    "Connect your Xero organisation to continue.",
    "Authorize this app to access your data.",
  ]) assert.ok(!HARD_GATE.test(s), `should NOT HARD_GATE: ${s}`);
});

test("TWOFA matches one-time-code / approve-on-phone copy", () => {
  for (const s of [
    "Enter the verification code we sent you",
    "We texted you a code",
    "Open your authenticator app",
    "Approve this request on your phone",
    "Enter your one-time passcode",
  ]) assert.ok(TWOFA.test(s), `should TWOFA: ${s}`);
});

test("TWOFA does NOT trip on an ordinary username prompt", () => {
  assert.ok(!TWOFA.test("Enter your username to sign in"));
});

test("allowed() permits the exact host and true sub-domains only", () => {
  assert.ok(allowed("xero.com", ["xero.com"]));
  assert.ok(allowed("login.xero.com", ["xero.com"]));
  assert.ok(allowed("identity.xero.com", ["xero.com", "stripe.com"]));
});

test("allowed() rejects off-list and suffix-confusion hosts", () => {
  assert.ok(!allowed("evil.com", ["xero.com"]));
  assert.ok(!allowed("notxero.com", ["xero.com"]), "suffix confusion must be rejected");
  assert.ok(!allowed("xero.com.evil.com", ["xero.com"]), "domain-in-prefix must be rejected");
});
