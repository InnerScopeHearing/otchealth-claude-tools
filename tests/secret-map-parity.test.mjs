// Drift guard for the secret-id -> env-var table.
//
// setup/fetch-secrets-azure.mjs has carried this 98-row table inline since the GCP retirement. The
// new AWS hydrator (setup/fetch-secrets-aws.mjs) needs the identical table, and it reads it from
// setup/secret-map.mjs.
//
// Two hand-maintained copies of the same mapping is a silent-divergence bug in waiting: add a
// secret to the Azure hydrator only, and a session hydrated from AWS never receives it -- with no
// error anywhere, because an absent optional secret is indistinguishable from one nobody mapped.
// The value simply stops arriving and something far downstream fails on an empty env var.
//
// Ideally fetch-secrets-azure.mjs would import the shared module and there would be nothing to
// compare. That file is outside this change's ownership, so instead this test parses its literal
// and fails the build the moment the two disagree. When the Azure hydrator is later repointed at
// secret-map.mjs, this test should be replaced by that import, not deleted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAP as SHARED } from "../setup/secret-map.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Pull the `const MAP = [ ... ];` array literal out of the Azure hydrator without executing the
 *  rest of the script (it has top-level await, network calls and a process.exit). */
function inlineAzureMap() {
  const src = readFileSync(join(ROOT, "setup", "fetch-secrets-azure.mjs"), "utf8");
  const decl = src.indexOf("const MAP = [");
  assert.notEqual(decl, -1, "fetch-secrets-azure.mjs no longer declares `const MAP = [` -- update this parser");
  const start = src.indexOf("[", decl);
  const end = src.indexOf("\n];", start);
  assert.notEqual(end, -1, "could not find the end of the MAP literal");
  // The literal is interleaved with a lot of explanatory prose, so comments are stripped first --
  // they are not data, and their English would otherwise trip the safety check below.
  const body = src
    .slice(start, end + 3)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  // What remains must be pure data: object/array/string/boolean literals only. This is checked
  // BEFORE evaluation, so a future edit to fetch-secrets-azure.mjs that introduced a call or an
  // identifier could not be executed by this test -- it would fail here instead.
  assert.equal(
    /[A-Za-z_$][A-Za-z0-9_$]*\s*\(/.test(body) || /\b(require|import|process|eval|Function|globalThis)\b/.test(body),
    false,
    "the MAP literal must stay pure data; refusing to evaluate a literal containing calls or identifiers",
  );
  return eval(body);
}

test("setup/secret-map.mjs and fetch-secrets-azure.mjs describe the SAME secrets", () => {
  const azure = inlineAzureMap();
  const key = (e) => `${e.id}|${e.env}|${e.required === true}`;
  const a = azure.map(key).sort();
  const s = SHARED.map(key).sort();

  const onlyAzure = a.filter((x) => !s.includes(x));
  const onlyShared = s.filter((x) => !a.includes(x));
  assert.deepEqual(
    { onlyAzure, onlyShared },
    { onlyAzure: [], onlyShared: [] },
    "the Azure and AWS hydrators would deliver different environments; add the entry to BOTH",
  );
  assert.equal(SHARED.length, azure.length);
});

test("the shared map is internally sane: unique ids, unique env names, no blanks", () => {
  const ids = SHARED.map((e) => e.id);
  const envs = SHARED.map((e) => e.env);
  assert.equal(new Set(ids).size, ids.length, "a duplicate id would make one mapping unreachable");
  // A duplicated env name means two secrets race to own one variable and the last write wins,
  // silently, differently per store depending on iteration order.
  assert.equal(new Set(envs).size, envs.length, "two secrets must not target the same env var");
  for (const e of SHARED) {
    assert.ok(e.id && typeof e.id === "string", `bad id: ${JSON.stringify(e)}`);
    assert.ok(e.env && typeof e.env === "string", `bad env: ${JSON.stringify(e)}`);
    assert.equal(typeof e.required, "boolean", `required must be an explicit boolean: ${e.id}`);
    // The env name is emitted into a shell-sourced file as `NAME='value'`; anything outside this
    // charset would produce a line the `set -a` sourcing cannot parse.
    assert.match(e.env, /^[A-Z][A-Z0-9_]*$/, `env var name is not shell-safe: ${e.env}`);
  }
});

test("PEM and other multiline secrets stay OUT of the flat hydration map", () => {
  // These are fetched to a file on demand via get-secret.mjs. Emitting one into credentials.env
  // would inject newlines into a KEY='value' file and corrupt every line after it.
  const suspicious = SHARED.filter((e) => /-p8$|private-key$|keystore/.test(e.id));
  assert.deepEqual(suspicious, [], "multiline/binary secrets must not be hydrated into the flat env");
});
