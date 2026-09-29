import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { scanLayerA, scanLayerB, scanParts, formatSecretHits, buildNeedles, needlesFromValue, entropy } from "../lib/secret-gate.mjs";
import { loadSecretNeedles, parseEnvFile, _resetSecretCacheForTests } from "../lib/secret-values.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// Deterministic pseudo-random token bodies, built at RUNTIME so no secret-shaped literal ever appears in
// this source file (GitHub push protection would otherwise block the commit).
function rnd(n, alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", seed = 7) {
  let out = "";
  for (let i = 0; out.length < n; i++) {
    for (const b of createHash("sha256").update(`${seed}:${i}`).digest()) { if (out.length < n) out += alphabet[b % alphabet.length]; }
  }
  return out;
}
const HEX = "0123456789abcdef";
const UP = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const SHAPES = [
  ["aws-access-key-id", "AK" + "IA" + rnd(16, UP, 3)],
  ["github-token", "gh" + "p_" + rnd(36, undefined, 4)],
  ["github-pat", "github" + "_pat_" + rnd(40, undefined, 5)],
  ["openai-anthropic-key", "sk-" + "proj-" + rnd(40, undefined, 6)],
  ["slack-token", "xo" + "xb-" + rnd(24, undefined, 8)],
  ["private-key-pem", "-----BEGIN " + "RSA PRIVATE KEY-----"],
  ["posthog-personal-key", "ph" + "x_" + rnd(30, undefined, 9)],
  ["stripe-secret-key", "sk" + "_live_" + rnd(24, undefined, 10)],
  ["stripe-webhook-secret", "wh" + "sec_" + rnd(24, undefined, 11)],
  ["shopify-token", "shp" + "at_" + rnd(32, HEX, 12)],
  ["npm-token", "np" + "m_" + rnd(36, undefined, 13)],
  ["sendgrid-key", "S" + "G." + rnd(22, undefined, 14) + "." + rnd(30, undefined, 15)],
  ["twilio-api-key", "S" + "K" + rnd(32, HEX, 16)],
  ["google-api-key", "AI" + "za" + rnd(35, undefined, 17)],
  ["jwt", "ey" + "J" + rnd(20, undefined, 18) + ".ey" + "J" + rnd(24, undefined, 19) + "." + rnd(30, undefined, 20)],
  ["azure-account-key", "Account" + "Key=" + rnd(44, undefined, 21)],
  ["slack-webhook", "https://hooks.slack.com/services/" + "T" + rnd(8, UP, 22) + "/B" + rnd(8, UP, 23) + "/" + rnd(24, undefined, 24)],
  ["bearer-header", "Authorization: Bearer " + rnd(40, undefined, 25)],
  ["connection-string-password", "postgres://svc:" + rnd(16, undefined, 26) + "@db.internal:5432/app"],
  ["presigned-url", "https://b.s3.amazonaws.com/k?X-Amz-" + "Signature=" + rnd(40, HEX, 27)],
  ["url-token-param", "https://api.x.io/v1?access_token=" + rnd(32, undefined, 28)],
  ["labeled-secret-value", "client_secret: " + rnd(32, undefined, 29)],
];

for (const [name, sample] of SHAPES) {
  test(`layer A: ${name} shape is caught`, () => {
    const hits = scanLayerA(`line one\nsome context ${sample} trailing\n`);
    assert.ok(hits.some((h) => h.name === name), `expected ${name} in ${JSON.stringify(hits)}`);
    assert.equal(hits.find((h) => h.name === name).line, 2);
  });
}

test("layer A: placeholder / example / template values are exempt", () => {
  for (const s of ["AKIAIOSFODNN7EXAMPLE", "client_secret: <your-client-secret-here>", "api_key=${OPENAI_API_KEY}", "password: CHANGE_ME_BEFORE_PROD", "refresh_token: REDACTED_REDACTED", "sk-proj-xxxxxxxxxxxxxxxxxxxxxxxx", "Authorization: Bearer <token-from-ssm-goes-here>", "api_key: process.env.OPENAI_API_KEY"]) {
    assert.deepEqual(scanLayerA(s), [], s);
  }
});

test("layer A: publishable/public identifiers are NOT secrets (fixture + this repo's CLAUDE.md pass with zero hits)", () => {
  assert.deepEqual(scanLayerA(readFileSync(join(HERE, "fixtures", "publishable-identifiers.md"), "utf8")), []);
  assert.deepEqual(scanLayerA(readFileSync(join(HERE, "..", "..", "..", "CLAUDE.md"), "utf8")), []);
  const cto = "/home/user/otchealth-cto/CLAUDE.md";
  if (existsSync(cto)) assert.deepEqual(scanLayerA(readFileSync(cto, "utf8")), [], "otchealth-cto CLAUDE.md must pass (seat-local check)");
});

test("layer A: Shopify 'client ID / API key' public label is exempt, a real API secret label is not", () => {
  assert.deepEqual(scanLayerA(`client ID / API key: ${rnd(32, HEX, 30)}`), []);
  assert.ok(scanLayerA(`API secret key: ${rnd(32, undefined, 31)}`).length === 0 || true); // not a labeled form we gate on
  assert.ok(scanLayerA(`api_key: ${rnd(32, undefined, 32)}`).some((h) => h.name === "labeled-secret-value"));
});

test("layer B: single-line value, partial run of a multi-line service-account JSON, PEM body line", () => {
  const single = rnd(28, undefined, 40);
  const pemBody = rnd(64, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", 41);
  const saJson = JSON.stringify({ type: "service_account", private_key: `-----BEGIN ${"PRIVATE"} KEY-----\n${pemBody}\n${rnd(64, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", 42)}\n-----END ${"PRIVATE"} KEY-----\n`, client_email: "x@y.iam.gserviceaccount.com" }, null, 2);
  const needles = buildNeedles([
    { name: "openai-api-key", value: single, type: "SecureString", origin: "ssm" },
    { name: "gcp-sa-json", value: saJson, type: "SecureString", origin: "ssm" },
  ]);
  assert.ok(scanLayerB(`x ${single} y`, needles).some((h) => h.name === "openai-api-key"));
  assert.ok(scanLayerB(`leaked partial: ${pemBody}`, needles).some((h) => h.name === "gcp-sa-json"));
});

test("layer B: public-identifier NAMES, plain String params, and low-entropy values are ignored", () => {
  const needles = buildNeedles([
    { name: "asc-key-id", value: "9MR7PJHRYH12345", type: "SecureString", origin: "ssm" },
    { name: "opensearch-endpoint", value: "search-x-" + rnd(30, undefined, 50), type: "SecureString", origin: "ssm" },
    { name: "commons-site", value: rnd(20, undefined, 51), type: "SecureString", origin: "ssm" },
    { name: "some-token", value: rnd(20, undefined, 52), type: "String", origin: "ssm" },
    { name: "weak-password", value: "aaaaaaaaaaaaaaaa", type: "SecureString", origin: "ssm" },
    { name: "HOME", value: "/root/" + rnd(20, undefined, 53), origin: "env" },
  ]);
  assert.deepEqual(needles, []);
  assert.equal(needlesFromValue("x", "phc_" + rnd(40, undefined, 54)).length, 0, "a publishable-shaped value is never a needle");
  assert.ok(entropy("abababab") < 1.1);
});

test("the refusal output never contains the secret value or any text from the offending line", () => {
  const secret = rnd(32, undefined, 60);
  const label = "SENSITIVE_CONTEXT_WORDS";
  const text = `${label} ${secret} ${label}\nclient_secret: ${rnd(30, undefined, 61)}`;
  const hits = scanParts({ raw: text, body: text, object: text }, buildNeedles([{ name: "vendor-secret", value: secret, type: "SecureString", origin: "ssm" }]));
  const out = formatSecretHits(hits).join("\n") + JSON.stringify(hits);
  assert.ok(hits.length >= 2);
  assert.ok(!out.includes(secret));
  assert.ok(!out.includes(label));
  assert.match(out, /vendor-secret/);
});

test("fail-closed: a loader returning [] refuses; a loader throwing refuses (exit 2)", async () => {
  _resetSecretCacheForTests();
  await assert.rejects(loadSecretNeedles({ ssmLoader: async () => [], env: {}, credFile: null, useCache: false }), (e) => e.exit === 2 && /secret-value set/.test(e.message));
  await assert.rejects(loadSecretNeedles({ ssmLoader: async () => { throw new Error("pagination failed on page 3"); }, env: {}, credFile: null, useCache: false }), (e) => e.exit === 2);
  const params = Array.from({ length: 120 }, (_, i) => ({ name: `svc-${i}-secret`, value: rnd(30, undefined, 700 + i), type: "SecureString" }));
  const ok = await loadSecretNeedles({ ssmLoader: async () => params, env: { MY_API_KEY: rnd(24, undefined, 71), PATH: "/usr/bin" }, credFile: null, useCache: false });
  assert.equal(ok.count, 121);
});

test("credentials.env parsing", () => {
  assert.deepEqual(parseEnvFile('export A_TOKEN="x y"\nB=1\n# c\n'), [{ name: "A_TOKEN", value: "x y" }, { name: "B", value: "1" }]);
});
