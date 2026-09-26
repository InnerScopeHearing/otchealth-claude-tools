import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSecretKey, extractPublicKeys, redactKey, dashboardProjectId, validateActions } from "../lib.mjs";

test("extractSecretKey finds an sk_ key and ignores public keys", () => {
  assert.equal(extractSecretKey("label fleet sk_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 2"), "sk_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
  assert.equal(extractSecretKey("appl_ABCDEFGHIJKLMNOPQRSTUVWXYZ01"), null);
  assert.equal(extractSecretKey("sk_short"), null);
  assert.equal(extractSecretKey(undefined), null);
});

test("extractPublicKeys returns kind and key for every store prefix", () => {
  const got = extractPublicKeys("a appl_AAAAAAAAAAAAAAAAAAAA b test_BBBBBBBBBBBBBBBBBBBB c sk_CCCCCCCCCCCCCCCCCCCCCC");
  assert.deepEqual(got.map((k) => k.kind), ["appl", "test"]);
});

test("redactKey never returns the key body", () => {
  const k = "sk_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
  const r = redactKey(k);
  assert.equal(r, "sk_*** (len 35)");
  assert.ok(!r.includes("ABCDEF"));
});

test("dashboardProjectId strips the v2 proj prefix", () => {
  assert.equal(dashboardProjectId("proja2cc4776"), "a2cc4776");
  assert.equal(dashboardProjectId("a2cc4776"), "a2cc4776");
});

test("validateActions rejects typos and malformed steps before touching the live account", () => {
  assert.doesNotThrow(() => validateActions([{ click: "All projects", exact: true }, { fill: "input[name=x]", value: "y" }, { xy: [1, 2] }, { wait: 100 }]));
  assert.throws(() => validateActions({}), /array/);
  assert.throws(() => validateActions([{ clik: "x" }]), /unknown key/);
  assert.throws(() => validateActions([{ fill: "input" }]), /string value/);
  assert.throws(() => validateActions([{ role: "button" }]), /needs a name/);
  assert.throws(() => validateActions([{ xy: [1] }]), /xy must be/);
});

import { redactText } from "../lib.mjs";
import { readFileSync } from "node:fs";

test("redactText masks every secret and public key in printed page text", () => {
  const page = "fleet sk_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 2\nTest Store test_ABCDEFGHIJKLMNOPQRST\nappl_ABCDEFGHIJKLMNOPQRST ok";
  const out = redactText(page);
  assert.ok(!/ABCDEFGHIJ/.test(out), out);
  assert.match(out, /sk_\*\*\* \(len 35\)/);
  assert.match(out, /appl_\*\*\*/);
  assert.equal(redactText("no keys here"), "no keys here");
});

test("new-secret-key verifies the key with the v2 API before writing SSM, and run output is redacted", () => {
  const src = readFileSync(new URL("../rc-dashboard.mjs", import.meta.url), "utf8");
  const verify = src.indexOf("if (!check.ok) throw");
  const store = src.indexOf("await ssmSecretSet(ssmName, key)");
  assert.ok(verify > 0 && store > 0 && verify < store, "the GET /v2/projects check must gate the SSM write");
  assert.match(src, /a\.dump\) console\.log\(redactText\(await page\.innerText\("body"\)\)\.slice\(/, "dump must redact the whole text before truncating");
  assert.match(src, /a\.inputs\) console\.log\(redactText\(/);
});

test("new-secret-key reveals the row via role=row + the accessible 'Show key' button, not a bare <tr> + first-button guess", () => {
  const src = readFileSync(new URL("../rc-dashboard.mjs", import.meta.url), "utf8");
  // Fails on the old code: the dashboard renders key rows as div[role=row], not <tr>, and the
  // reveal control is the accessible "Show key" button, not merely "the first button in the row"
  // (other row buttons, e.g. copy/delete, can sit ahead of it in DOM order).
  assert.match(src, /page\.locator\(\s*"\[role=row\]"\s*,\s*\{\s*hasText:\s*label\s*\}\s*\)\.first\(\)/, "must locate the key row via role=row, not a bare <tr>");
  assert.match(src, /row\.getByRole\(\s*"button"\s*,\s*\{\s*name:\s*"Show key"\s*\}\s*\)/, "must click the accessible 'Show key' button, not row.locator('button').first()");
  assert.ok(!/row\.locator\("button"\)\.first\(\)/.test(src), "must not fall back to a positional 'first button in the row' guess");
});

test("redactText masks key types that were never enumerated, and truncation after redaction leaks nothing", () => {
  const roku = "roku_ABCDEFGHIJKLMNOPQRSTUV";
  assert.ok(!redactText(`key ${roku}`).includes("ABCDEFGHIJ"));
  const page = "label sk_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 end";
  // Cutting 10 chars into the key: redacting first means no raw fragment survives the slice.
  const cut = redactText(page).slice(0, "label sk_ABCDEFGH".length);
  assert.ok(!/ABCDEFGH/.test(cut), cut);
});
