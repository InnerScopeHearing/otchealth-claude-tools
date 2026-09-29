// secret-values.mjs -- load the fleet's live secret VALUE set (secret gate layer B), in memory only.
// Never written to disk, never printed; callers only ever see the COUNT and parameter NAMES.
//
// FAIL-CLOSED: if the SSM enumeration throws (a partial pagination) or returns a TINY set, loading
// throws BrainSaveError(2): saving would be unverified. "Tiny" is a floor, not just "zero": a loader that
// returned only String parameters (or a truncated first page) used to arm the gate with 0 needles and
// save anyway (adjudication round 2). The live estate holds ~430 SecureStrings -> ~300+ needles, so the
// floor (MIN_SECURE_PARAMS / MIN_NEEDLES) is far below normal and far above any broken enumeration.
// There is no flag to skip this layer. Any seat or task role that can write the commons bucket can read SSM.
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildNeedles } from "./secret-gate.mjs";
import { BrainSaveError, EXIT } from "./errors.mjs";

/** Parse KEY=VALUE lines (optionally `export KEY=...`, quoted values) from a credentials.env file. */
export function parseEnvFile(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out.push({ name: m[1], value: v });
  }
  return out;
}

export const MIN_SECURE_PARAMS = 100;
export const MIN_NEEDLES = 100;

let _cache = null;

/**
 * Load needles. `ssmLoader` must return [{name, value, type}] for every /otchealth/* parameter.
 * Injectable for tests; defaults to kb-memory/aws-secret.mjs's ssmGetParametersByPathAllWithValues().
 */
export async function loadSecretNeedles({ ssmLoader, env = process.env, credFile = join(homedir(), ".designer", "credentials.env"), useCache = true } = {}) {
  if (useCache && _cache) return _cache;
  let loader = ssmLoader;
  if (!loader) ({ ssmGetParametersByPathAllWithValues: loader } = await import("../../kb-memory/aws-secret.mjs"));
  let params;
  try { params = await loader(); }
  catch (e) {
    throw new BrainSaveError(EXIT.REFUSED, `cannot load the fleet secret-value set (SSM enumeration failed: ${String((e && e.message) || e).slice(0, 160)}); saving would be unverified.`, { code: "SECRET_SET_UNAVAILABLE" });
  }
  if (!Array.isArray(params) || params.length === 0) {
    throw new BrainSaveError(EXIT.REFUSED, "cannot load the fleet secret-value set (SSM returned no parameters: unreachable or no AWS credentials); saving would be unverified.", { code: "SECRET_SET_UNAVAILABLE" });
  }
  const secure = params.filter((p) => p && p.type === "SecureString").length;
  if (secure < MIN_SECURE_PARAMS) {
    throw new BrainSaveError(EXIT.REFUSED, `cannot load the fleet secret-value set (SSM returned only ${secure} SecureString parameter(s) of ${params.length}; the floor is ${MIN_SECURE_PARAMS}: a truncated or wrong-account enumeration); saving would be unverified.`, { code: "SECRET_SET_UNAVAILABLE" });
  }
  const entries = params.map((p) => ({ name: p.name, value: p.value, type: p.type, origin: "ssm" }));
  for (const [name, value] of Object.entries(env || {})) entries.push({ name, value, origin: "env" });
  try {
    if (credFile && existsSync(credFile)) for (const e of parseEnvFile(readFileSync(credFile, "utf8"))) entries.push({ ...e, origin: "credentials.env" });
  } catch { /* unreadable credentials.env: SSM + env still apply */ }
  const needles = buildNeedles(entries);
  if (needles.length < MIN_NEEDLES) {
    throw new BrainSaveError(EXIT.REFUSED, `cannot arm the secret gate: only ${needles.length} live secret needle(s) from ${secure} SecureString parameter(s) (the floor is ${MIN_NEEDLES}); saving would be unverified.`, { code: "SECRET_SET_UNAVAILABLE" });
  }
  const result = { needles, count: needles.length, ssmParams: params.length, secureParams: secure };
  if (useCache) _cache = result;
  return result;
}

export function _resetSecretCacheForTests() { _cache = null; }
