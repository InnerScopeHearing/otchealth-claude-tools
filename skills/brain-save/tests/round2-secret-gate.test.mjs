// Adjudication round 2 (2026-09-29): live credentials passed BOTH secret layers. One test per confirmed
// bypass, each asserting the refusal AND (where a false-positive risk exists) that the neighbouring
// harmless shape still passes. Secret-shaped values are generated at RUNTIME (GitHub push protection).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { scanLayerA, scanLayerB, buildNeedles, needlesFromValue, isPublicName, PUBLIC_NAME_RE, looksLikeReference, valueLooksSecret, SHINGLE_LEN, NEEDLE_MAX_WHOLE } from "../lib/secret-gate.mjs";
import { loadSecretNeedles, MIN_SECURE_PARAMS, MIN_NEEDLES } from "../lib/secret-values.mjs";

function rnd(n, alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", seed = 7) {
  let out = "";
  for (let i = 0; out.length < n; i++) for (const b of createHash("sha256").update(`r2:${seed}:${i}`).digest()) { if (out.length < n) out += alphabet[b % alphabet.length]; }
  return out;
}
const LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const HEX = "0123456789abcdef";
const names = (text) => scanLayerA(text).map((h) => h.name);

test("round 2 layer A: every confirmed labeled-value bypass is now caught", () => {
  const cases = {
    "env REVENUECAT_SECRET_KEY (letters only)": `REVENUECAT_SECRET_KEY=${rnd(32, LETTERS, 1)}\n`,
    "env GRAPH_ONEDRIVE_REFRESH_TOKEN (300 chars)": `GRAPH_ONEDRIVE_REFRESH_TOKEN=${rnd(300, LETTERS + "0123456789._-", 2)}\n`,
    "env SESSION_SECRET (hex)": `SESSION_SECRET=${rnd(64, HEX, 3)}\n`,
    "env OPENAI_API_KEY (hex)": `OPENAI_API_KEY=${rnd(40, HEX, 4)}\n`,
    "bold markdown label": `- **Secret key:** ${rnd(40, undefined, 5)}\n`,
    "auth token label": `auth token: ${rnd(32, HEX, 6)}\n`,
    "password with parentheses": `password: Pa55(word)${rnd(12, undefined, 7)}\n`,
    "uppercase client_secret": `client_secret: ${rnd(20, "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 8)}\n`,
    "backtick label": `\`client_secret\`: ${rnd(30, undefined, 9)}\n`,
    "export env": `export STRIPE_WEBHOOK_TOKEN="${rnd(36, undefined, 10)}"\n`,
  };
  for (const [what, text] of Object.entries(cases)) assert.ok(names(`intro\n${text}`).some((n) => n === "labeled-secret-value" || n === "env-secret-assignment"), `${what}: ${JSON.stringify(names(text))}`);
});

test("round 2 layer A: references and prose next to a label still pass (no new false positives)", () => {
  const ok = [
    "OPENAI_API_KEY=\nGEMINI_API_KEY=\n",                                         // .env template: the next line is not a value
    "CIO_FLY_SERVICE_ACCOUNT_TOKEN=secretref:cio-fly-service-account-token",   // Container Apps secretref
    "--update-secrets=NEW_SECRET=MY_GCP_SECRET_NAME:latest",                   // GCP version reference
    "Canonical Key Vault secret: `kv-otc-55c84f6bef/cio-fly-service-account-token`.", // vault/name path
    "secret: `oauth-lane-cro-secret`",                                          // SSM parameter NAME
    "Auth method (bearer token = GATEWAY_BEARER_TOKEN)",                        // env var NAME + ")"
    'X-Shopify-Access-Token: {shop_token}',                                     // template
    "const token = crypto.randomBytes(32);",                                   // call expression
    "access token: configurable",                                               // a word
    "Cloudflare Token: AccountWideEditName",                                    // short CamelCase name
    "- `--password`: Certificate/keystore password",                            // prose
    "the root cause is a secret: ledger.mjs:120-135 shows it",                  // file:line reference
    "refreshToken: 'your-refresh-token',",                                     // placeholder
    "api_key: OPENAI_API_KEY",                                                  // env NAME
    'key_ref: "' + rnd(40, HEX, 11) + '"',                                      // brain-save's own header field
  ];
  for (const t of ok) assert.deepEqual(scanLayerA(t), [], t);
});

test("round 2 looksLikeReference: an uppercase value is a NAME only with '_' or <= 12 chars; '()' only for a call shape", () => {
  assert.equal(looksLikeReference("OPENAI_API_KEY"), true);
  assert.equal(looksLikeReference("HOME"), true);
  assert.equal(looksLikeReference(rnd(20, "ABCDEFGHJKLMNPQRSTUVWXYZ", 12)), false);
  assert.equal(looksLikeReference("getPassword()"), true);
  assert.equal(looksLikeReference("crypto.randomBytes(32)"), true);
  assert.equal(looksLikeReference(`Pa55(word)${rnd(8, undefined, 13)}`), false);
  assert.equal(valueLooksSecret(`Pa55(word)${rnd(8, undefined, 13)}`, { password: true }), true);
});

test("round 2 layer B: letters-only secrets (RevenueCat keys) become needles; publishable phc_ keys never do", () => {
  const key = rnd(32, LETTERS, 20);
  const n = buildNeedles([{ name: "revenuecat-heymillie-secret-key", value: key, type: "SecureString", origin: "ssm" }]);
  assert.equal(n.length, 1);
  assert.ok(scanLayerB(`the key was ${key} yesterday`, n).length);
  assert.equal(needlesFromValue("posthog-fleet-ingest-key", "phc_" + rnd(44, undefined, 21)).length, 0);
  assert.equal(needlesFromValue("x", "short-words-only").length, 0, "low-entropy / short values are not needles");
});

test("round 2 layer B: values over 512 chars (refresh tokens, a PFX) are shingled, so a PARTIAL leak still matches", () => {
  const token = rnd(1600, LETTERS + "0123456789._-", 30);
  const needles = needlesFromValue("graph-onedrive-refresh-token", token);
  assert.ok(needles.length > 50, `shingles: ${needles.length}`);
  assert.ok(needles.every((x) => x.needle.length === SHINGLE_LEN));
  assert.ok(token.length > NEEDLE_MAX_WHOLE);
  // any contiguous run of >= 71 chars from anywhere in the value is caught, including the tail
  for (const start of [0, 333, 777, token.length - 80]) assert.ok(scanLayerB(`log: ${token.slice(start, start + 80)} end`, needles).length, `start ${start}`);
  assert.equal(scanLayerB(`nothing here ${rnd(200, undefined, 31)}`, needles).length, 0);
  const pfx = rnd(3460, LETTERS + "0123456789+/", 32);
  assert.ok(scanLayerB(pfx.slice(1000, 1100), needlesFromValue("exo-app-only-cert-pfx-base64", pfx)).length);
});

test("round 2 layer B: ebay-cert-id and *-database-url are secrets, not public names; base-url is anchored", () => {
  for (const n of ["ebay-cert-id", "fourvault-ebay-cert-id", "neon-database-url", "fourvault-neon-database-url", "fourvault-neon-database-url-direct"]) assert.equal(isPublicName(n), false, n);
  for (const n of ["ebay-app-id", "asc-key-id", "posthog-host", "daytona-api-url", "n8n-base-url", "iheartest-sentry-dsn", "graph-mail-client-id"]) assert.equal(isPublicName(n), true, n);
  assert.equal(PUBLIC_NAME_RE.test("neon-database-url"), true, "the raw name regex alone still matches (-url), which is why isPublicName adds NEVER_PUBLIC");
  const pw = rnd(24, undefined, 40);
  const url = `postgresql://app_user:${pw}@ep-x.us-east-2.aws.neon.tech/db?sslmode=require`;
  const n = buildNeedles([{ name: "neon-database-url", value: url, type: "SecureString", origin: "ssm" }]);
  assert.ok(n.some((x) => x.needle === url), "the whole URL");
  assert.ok(scanLayerB(`password is ${pw}`, n).length, "and its password alone");
});

test("round 2 fail-closed floor: a String-only or truncated SSM enumeration refuses instead of arming 0 needles", async () => {
  const few = Array.from({ length: 3 }, (_, i) => ({ name: `s-${i}-secret`, value: rnd(30, undefined, 50 + i), type: "SecureString" }));
  await assert.rejects(loadSecretNeedles({ ssmLoader: async () => [{ name: "a", value: "x", type: "String" }, { name: "b", value: "y", type: "String" }], env: {}, credFile: null, useCache: false }), (e) => e.exit === 2 && e.code === "SECRET_SET_UNAVAILABLE");
  await assert.rejects(loadSecretNeedles({ ssmLoader: async () => few, env: {}, credFile: null, useCache: false }), (e) => e.exit === 2 && /SecureString/.test(e.message));
  // 120 SecureStrings but all public/low-entropy -> too few needles -> refuse
  const pub = Array.from({ length: 120 }, (_, i) => ({ name: `svc-${i}-client-id`, value: rnd(30, undefined, 60 + i), type: "SecureString" }));
  await assert.rejects(loadSecretNeedles({ ssmLoader: async () => pub, env: {}, credFile: null, useCache: false }), (e) => e.exit === 2 && /needle/.test(e.message));
  assert.equal(MIN_SECURE_PARAMS, 100);
  assert.equal(MIN_NEEDLES, 100);
});

test("round 2 performance: the scanner is linear on the inputs that were quadratic", () => {
  const cases = [
    ["sk- repeated to the 400k cap", "sk-".repeat(133333)],
    ["129k kebab-case list", Array.from({ length: 20000 }, (_, i) => "a" + i).join("-")],
    ["13,000 PEM headers", ("-----BEGIN RSA " + "PRIVATE KEY-----\n").repeat(13000)],
    ["scheme://user:pass runs", ("a://b:" + "c".repeat(300) + " ").repeat(1300)],
    ["a label followed by 50 spaces, repeated", ("password" + " ".repeat(50)).repeat(7000)],
  ];
  for (const [what, t] of cases) {
    const t0 = Date.now();
    scanLayerA(t);
    const ms = Date.now() - t0;
    assert.ok(ms < 1500, `${what}: ${ms}ms`);
  }
  const pem = ("x\n".repeat(5) + "-----BEGIN RSA " + "PRIVATE KEY-----\n").repeat(3);
  assert.equal(scanLayerA(pem).find((h) => h.name === "private-key-pem").line, 6, "line numbers stay exact with the offset table");
});
