// Regression gate for the Wave 4 fleet-medic CLASSIFIER - the brain that decides which agent is
// "off the rails" and gets the medic auto-dispatched. Pure functions, so fully hermetic (no Azure /
// PostHog). The load-bearing guarantees: (1) an ACTIVE session with memory OFF (fresh DARK beacon)
// dispatches; (2) a merely-idle agent does NOT (no crying wolf); (3) cooldown suppresses re-spam;
// (4) persistent DARK escalates to the human. If these regress, the medic either misses real fires or
// spams healthy agents.
import { test } from "node:test";
import assert from "node:assert";
import { classify, remediationFor, sm } from "../skills/fleet-medic/medic.mjs";

// ---------------------------------------------------------------------------------------------------
// sm() auth-fallback hardening (Wave 3, 3.6): the CTO auto-remediation review of fleet-medic + the
// fleet-secret-custodian skill found no auto-merge mechanism in fleet-medic at all (it only ever writes
// a self-heal directive blob + a PostHog event; see SKILL.md / medic.mjs comments). It DID find that
// sm()'s legacy GCP Secret Manager fallback built a token-mint request from saJwt() without ever
// checking whether saJwt() actually returned a JWT -- when no GCP service-account credential was
// available, the pre-fix code called encodeURIComponent(null), sending a request body containing the
// literal string "assertion=null" and relying on Google's OAuth endpoint to reject it correctly. That
// happened to fail safe in practice (a 401 upstream -> sm() still returned null), but it was an
// accidental safety net, not an explicit fail-closed check in our own code -- exactly the "all auth
// paths failed" class this hardening pass closes. These tests pin the NOW-explicit behavior: every
// auth path exhausted (Key Vault unreachable/stubbed to fail, AND no usable GCP SA) resolves to a
// clean `null`, and sm() never again constructs a request around a missing credential.
async function withStubbedFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await run(); } finally { globalThis.fetch = original; }
}

test("sm(): every auth path failing (Key Vault stubbed to deny, no GCP SA in this environment) resolves to null, never throws", async () => {
  const result = await withStubbedFetch(
    async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => "" }),
    () => sm("fleet-medic-selftest-guaranteed-missing-secret-xyz"),
  );
  assert.strictEqual(result, null);
});

test("sm(): regression pin -- never sends a token-mint request built from a null/missing JWT assertion (the pre-fix bug: encodeURIComponent(null) => 'assertion=null')", async () => {
  const seenBodies = [];
  const result = await withStubbedFetch(
    async (url, init) => {
      if (init && typeof init.body === "string") seenBodies.push(init.body);
      return { ok: false, status: 401, json: async () => ({}), text: async () => "" };
    },
    () => sm("fleet-medic-selftest-guaranteed-missing-secret-xyz"),
  );
  assert.strictEqual(result, null);
  assert.ok(!seenBodies.some((b) => b.includes("assertion=null")), "must never build a token request from a null JWT assertion");
});

const NOW = Date.parse("2026-06-25T12:00:00Z");
const OPTS = { beaconFreshMin: 120, staleWatchMin: 10080, cooldownMin: 360, escalateAfter: 3, roster: [] };
const byAgent = (rows) => Object.fromEntries(rows.map((r) => [r.agent, r]));

test("a FRESH beacon with hooks unwired = active-but-broken -> DISPATCH (the real fire)", () => {
  const r = byAgent(classify([], { developer: { status: "DARK", age_min: 5, hooks_wired: false, ledger_size: 0 } }, {}, NOW, OPTS));
  assert.strictEqual(r.developer.condition, "DARK");
  assert.strictEqual(r.developer.dispatch, true);
});

test("a fresh LIVE beacon = memory functioning -> HEALTHY, no dispatch", () => {
  const r = byAgent(classify([{ agent: "cfo", status: "LIVE", last_shared_age_min: 30 }], { cfo: { status: "LIVE", age_min: 10, hooks_wired: true, ledger_size: 200 } }, {}, NOW, OPTS));
  assert.strictEqual(r.cfo.condition, "HEALTHY");
  assert.strictEqual(r.cfo.dispatch, false);
});

test("NO-DATA (never wrote a shared entry) + no beacon -> NO-MEMORY -> DISPATCH a gentle claim", () => {
  const r = byAgent(classify([{ agent: "growth", status: "NO-DATA", last_shared_age_min: null }], {}, {}, NOW, OPTS));
  assert.strictEqual(r.growth.condition, "NO-MEMORY");
  assert.strictEqual(r.growth.dispatch, true);
});

test("a merely-IDLE agent (stale, no fresh beacon) is WATCH, NOT dispatched (no crying wolf)", () => {
  // stale within the 7d watch window AND well beyond it both stay WATCH/no-dispatch: idle != broken.
  const idle = classify([{ agent: "capital", status: "STALE", last_shared_age_min: 3 * 1440 }], {}, {}, NOW, OPTS);
  const veryIdle = classify([{ agent: "capital", status: "STALE", last_shared_age_min: 9 * 1440 }], {}, {}, NOW, OPTS);
  assert.strictEqual(idle[0].dispatch, false);
  assert.strictEqual(veryIdle[0].condition, "WATCH");
  assert.strictEqual(veryIdle[0].dispatch, false);
});

test("a STALE beacon (older than the fresh window) is NOT treated as an active fire", () => {
  // beacon says DARK but it is 5h old -> the agent is not active now -> fall through to health (LIVE) = HEALTHY.
  const r = byAgent(classify([{ agent: "coo", status: "LIVE", last_shared_age_min: 20 }], { coo: { status: "DARK", age_min: 300, hooks_wired: false, ledger_size: 0 } }, {}, NOW, OPTS));
  assert.strictEqual(r.coo.condition, "HEALTHY", "a stale DARK beacon must not override a healthy recent write");
});

test("cooldown suppresses a re-dispatch within the window", () => {
  const recent = new Date(NOW - 60 * 60000).toISOString(); // dispatched 60m ago, cooldown is 360m
  const r = byAgent(classify([], { developer: { status: "DARK", age_min: 5, hooks_wired: false, ledger_size: 0 } },
    { developer: { last_dispatch_ts: recent, consecutive_dark: 1 } }, NOW, OPTS));
  assert.strictEqual(r.developer.dispatch, false, "still in cooldown");
  assert.strictEqual(r.developer.cooled_down, true);
});

test("persistent DARK across the threshold ESCALATES to the human", () => {
  const old = new Date(NOW - 10 * 3600 * 1000).toISOString(); // past cooldown
  const r = byAgent(classify([], { developer: { status: "DARK", age_min: 5, hooks_wired: false, ledger_size: 0 } },
    { developer: { last_dispatch_ts: old, consecutive_dark: 2 } }, NOW, OPTS)); // this dispatch makes it 3
  assert.strictEqual(r.developer.dispatch, true);
  assert.strictEqual(r.developer.consecutive_dark, 3);
  assert.strictEqual(r.developer.escalate, true);
});

test("remediationFor names the agent and gives the exact 3 activation steps", () => {
  const md = remediationFor("clo", { reason: "ledger empty" }, "2026-06-25T12:00:00Z");
  assert.match(md, /MEDIC DIRECTIVE for CLO/);
  assert.match(md, /mem\.mjs use clo/);
  assert.match(md, /whoami --agent clo/);
  assert.match(md, /ledger empty/);
});
