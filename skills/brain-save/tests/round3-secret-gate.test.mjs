// Adjudication round 3 (2026-09-29): secret-gate bypasses. #7 layer B exact-substring only, #8 layer A
// missed shapes, #12 public identifiers as needles. Every value below is SYNTHETIC (random or fixed junk),
// never a real credential. The fleet-corpus false-positive scans (layer A over 4,125 md/html/txt + 7,195
// json files; layer B with the live SSM needle set over 11,320 files) are recorded in test-results.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { scanLayerA, scanLayerB, scanParts, buildNeedles, isPublicName, isPublicIdentifierNeedle, normalizeForSecrets, decodedCredentials, valueLooksSecret } from "../lib/secret-gate.mjs";

const AL = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const rnd = (n, a = AL) => Array.from(randomBytes(n), (b) => a[b % a.length]).join("");
const hex = (n) => randomBytes(n).toString("hex");
const V = "Qx7vN2pL9sK4tR8wZ3mB6yH1cF5gJ0dA"; // fixed 32-char synthetic value
const hitsA = (t) => scanLayerA(t).map((h) => h.name);

test("round 3 #8: labeled and structural secrets that used to pass layer A are caught", () => {
  const cases = {
    "export STRIPE_KEY=": `export STRIPE_KEY=${V}`, "MASTER_KEY=": `MASTER_KEY=${V}`, "ENCRYPTION_KEY=": `ENCRYPTION_KEY=${hex(32)}`,
    "SIGNING_KEY=": `SIGNING_KEY=${hex(32)}`, "DD_APP_KEY=": `DD_APP_KEY=${hex(20)}`,
    "Authorization: Basic": `Authorization: Basic ${Buffer.from("api:" + V).toString("base64")}`,
    "Authorization: ApiKey": `Authorization: ApiKey ${V}`, "Authorization: Token": `authorization: Token ${V}`,
    "curl -u": `curl -u admin:${V.slice(0, 16)} https://api.vendor.io/v1`, "curl --user": `curl -s --user svc:${V.slice(4, 20)} https://x.io`,
    "rediss://:pw@": `rediss://:${V.slice(0, 24)}@cache.internal:6380`,
    "table cell": `| Name | Value |\n|---|---|\n| Client Secret | ${V} |`,
    "prose 'is'": `The API token is ${V} for the staging tenant.`,
    "JSON privateKey": `{"privateKey": "${V}"}`, "private key label": `private_key = "${V}"`,
    "meta name=api-key": `<meta name="api-key" content="${V}">`, "meta content first": `<meta content="${V}" name="x-auth-token">`,
    "11-char password": "password: Kq3vN8pLzR2", "8-char password": "passwd = hunter22",
    "real password, fake host": `postgres://app:${V.slice(0, 20)}@fakeshop-db.internal:5432/x`,
  };
  for (const [k, t] of Object.entries(cases)) assert.ok(hitsA(t).length, k);
});

test("round 3 #8: vendor prefixes and private-key headers", () => {
  for (const [name, t] of [
    ["elevenlabs-key", `sk_${hex(24)}`], ["tavily-key", `tvly-dev-${rnd(32)}`], ["perplexity-key", `pplx-${rnd(48)}`],
    ["sentry-token", `sntrys_${rnd(60)}`], ["netlify-token", `nfp_${rnd(36)}`], ["huggingface-token", `hf_${rnd(34)}`],
    ["gitlab-pat", `glpat-${rnd(20)}`], ["google-oauth-access-token", `ya29.${rnd(60)}`], ["notion-token", `ntn_${rnd(46)}`],
    ["groq-key", `gsk_${rnd(52)}`], ["datadog-pat", `ddpat_${rnd(32)}`], ["wsec-secret", `wsec_${rnd(32)}`],
    ["pgp-private-key", "-----BEGIN PGP PRIVATE KEY BLOCK-----"], ["putty-private-key", "PuTTY-User-Key-File-2: ssh-rsa\nPrivate-Lines: 14"],
  ]) assert.ok(hitsA(`see ${t} here`).includes(name), name);
});

test("round 3 #8: placeholders and ordinary prose still pass (the corpus false positives found while tuning)", () => {
  for (const t of [
    '"forgot_password": "Passwort?"', '"password": "Contraseña"', '"forgot_password": "Esqueceu-se da sua senha?"',
    "  password: 'MyPassword',", "SECRET_RE = /(api|secret|token)|(refresh|access)\\s+(token|secret)/i;",
    "| `n8n-api-key` | `/v1/workflows/list` 200 |", "the refresh token is rotated on use", "password: required",
    "postgres://user:password@db.example.com/x", "curl -u $API_USER:$API_PASS https://x.io", "curl -u api:${TOKEN} https://x.io",
    '<meta name="csrf-token" content="Qx7vN2pL9sK4tR8wZ3mB6yH1cF5gJ0dA">', "ASC_KEY_ID=9MR7PJHRYH", "TOKEN_ENDPOINT=https://auth.example.org/token",
    "SECRET_NAME=oauth-lane-cro-secret", "Authorization: Basic ${BASIC_AUTH}", "Authorization: Basic dXNlcjpwYXNzd29yZA==",
  ]) assert.deepEqual(hitsA(t), [], t);
  assert.equal(valueLooksSecret("see-vault", { password: true }), false);
  assert.equal(valueLooksSecret("aKxQzPmWnRt", { password: true }), true, "11 random letters with 3+ inner capitals");
});

test("round 3 #7: layer B finds a live value however it is written (split, escaped, invisible chars, percent-encoded, Basic, upper-case hex)", () => {
  const secret = `${rnd(32)}_${rnd(8)}`;
  const needles = [{ name: "fleet/x-secret", needle: secret }];
  const cases = {
    verbatim: `key ${secret} end`,
    "split by a newline": `key ${secret.slice(0, 20)}\n${secret.slice(20)} end`,
    "split by spaces": `key ${secret.slice(0, 10)} ${secret.slice(10)} end`,
    "markdown-escaped underscore": `key ${secret.replace(/_/g, "\\_")} end`,
    "zero-width space": `key ${secret.slice(0, 10)}​${secret.slice(10)} end`,
    "soft hyphen + BOM": `key ${secret.slice(0, 5)}­${secret.slice(5, 9)}﻿${secret.slice(9)} end`,
    "bidi control": `key ${secret.slice(0, 7)}‮${secret.slice(7)} end`,
    "fullwidth (NFKC)": `key ${[...secret].map((c) => (/[A-Za-z0-9]/.test(c) ? String.fromCharCode(c.charCodeAt(0) + 0xfee0) : c)).join("")} end`,
    "percent-encoded in a URL": `https://x.io/?q=${[...secret].map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join("")}`,
    "Authorization: Basic": `Authorization: Basic ${Buffer.from("svc:" + secret).toString("base64")}`,
    "JSON-escaped slash": `{"v": "${secret.slice(0, 12)}\\/${secret.slice(12)}"}`.replace("\\/", ""),
  };
  for (const [k, t] of Object.entries(cases)) {
    const h = scanLayerB(t, needles);
    assert.equal(h.length, 1, k);
    assert.equal(h[0].name, "fleet/x-secret", k);
    assert.ok(!JSON.stringify(h).includes(secret.slice(0, 12)), `${k}: the hit never carries the value`);
  }
  const hx = hex(24);
  assert.equal(scanLayerB(`id ${hx.toUpperCase()} end`, [{ name: "h", needle: hx }]).length, 1, "upper-case hex");
  assert.equal(scanLayerB(`id ${hx.toUpperCase().slice(0, 20)}\n${hx.toUpperCase().slice(20)}`, [{ name: "h", needle: hx }]).length, 1, "upper-case hex, split");
  assert.equal(scanLayerB("nothing to see here, ordinary prose", needles).length, 0);
  // line numbers point at the line that carries the value
  assert.equal(scanLayerB(`a\nb\nkey ${secret.slice(0, 20)}\n${secret.slice(20)}`, needles)[0].line, 3);
  assert.equal(normalizeForSecrets("a\\_b%2Fc​d"), "a_b/cd");
  assert.deepEqual(decodedCredentials(`Authorization: Basic ${Buffer.from("u:p4ss").toString("base64")}`).map((c) => c.text), ["u:p4ss"]);
  // scanParts (the pipeline's entry) sees the same views
  assert.equal(scanParts({ body: cases["zero-width space"] }, needles).length, 1);
});

test("round 3 #12: public identifiers are not needles (Twilio VA/MG SIDs, subnet/sg/vpc ids, tenant UUIDs, job-guard backups)", () => {
  for (const n of ["twilio-verify-service-sid", "xero-tenant-map", "job-guard/schedule-backups/brain-reindex/20260909-durable-repair", "schedule-backups/x"]) assert.equal(isPublicName(n), true, n);
  for (const n of ["twilio-auth-token", "xero-client-secret", "ebay-cert-id", "neon-database-url"]) assert.equal(isPublicName(n), false, n);
  const uuid = "3f2b8c1e-9a4d-4e7f-b6a2-5c8d1e0f7a93";
  assert.equal(isPublicIdentifierNeedle(uuid, "xero-config"), true);
  assert.equal(isPublicIdentifierNeedle(uuid, "vendor-api-key"), false, "a UUID-shaped API key stays a needle");
  for (const v of ["subnet-0a1b2c3d4e5f67890", "sg-0123456789abcdef0", "vpc-0a1b2c3d", `VA${hex(16)}`, `MG${hex(16)}`]) assert.equal(isPublicIdentifierNeedle(v), true, v);
  const needles = buildNeedles([
    { origin: "ssm", type: "SecureString", name: "twilio-verify-service-sid", value: `VA${hex(16)}` },
    { origin: "ssm", type: "SecureString", name: "xero-tenant-map", value: JSON.stringify({ otchealth: uuid, innd: "8e1d2c3b-4a5f-4b6c-8d7e-9f0a1b2c3d4e" }) },
    { origin: "ssm", type: "SecureString", name: "ops-config", value: JSON.stringify({ subnets: ["subnet-0a1b2c3d4e5f67890"], sid: `MG${hex(16)}`, tenant: uuid }) },
    { origin: "ssm", type: "SecureString", name: "vendor-api-key", value: uuid },
    { origin: "ssm", type: "SecureString", name: "real-secret", value: V },
  ]);
  assert.deepEqual(needles.map((n) => n.name).sort(), ["real-secret", "vendor-api-key"]);
});
