// commons-push-gate.mjs -- the CONTENT gate every row of a commons push-search passes before it is embedded.
// PURE + importable (no CLI side effects), so indexer.mjs and its tests share one implementation.
//
// WHY (brain-save adjudication round 4, S1): commons-company-journal is readable by EVERY gateway lane,
// external ChatGPT/Perplexity connectors included. push-search on that room selected rows by PATH only
// (SKIP_PREFIXES + the --prefixes allow-set) and embedded whatever text the sidecar held. A secret or a
// ring-restricted document that landed under an allow-listed prefix by any route other than `brain-save put`
// (a raw S3 write, an older tool) would have been embedded into the open room. Now, before each row is
// embedded, its sidecar text goes through the SAME secret gate (layers A + B) and ring gate that
// `brain-save put` and `brain-save audit` use (brain-save/lib/object-gate.mjs), and `_KNOWLEDGE/` rows must
// additionally carry brain-save's provenance header.
//
// OUTPUT RULE: a block names the path and the RULE names only (secret layer + pattern / SSM parameter NAME,
// ring signal codes, "no-brain-save-provenance"): never a value, never document text.
//
// FAIL CLOSED: if the live secret-value set cannot be loaded, the whole commons push is refused
// (CommonsGateUnavailable -> the caller exits 2 before any embedding). There is no flag to skip layer B.
import { gateStoredObject, hasBrainSaveProvenance } from "../brain-save/lib/object-gate.mjs";
import { parseKnowledgeKey } from "../brain-save/lib/provenance.mjs";
import { normalizeRelPath } from "./push-rules.mjs";

export class CommonsGateUnavailable extends Error {
  constructor(message) { super(message); this.name = "CommonsGateUnavailable"; this.exit = 2; }
}

/** Load the live secret needles through the brain-save loader (SSM + env + credentials.env). Throws
 *  CommonsGateUnavailable when they cannot be loaded (the loader itself refuses a tiny/empty set). */
export async function loadCommonsNeedles({ loader } = {}) {
  try {
    const load = loader || (await import("../brain-save/lib/secret-values.mjs")).loadSecretNeedles;
    const r = await load();
    const needles = Array.isArray(r) ? r : r && r.needles;
    if (!Array.isArray(needles) || needles.length === 0) throw new Error("no secret needles were returned");
    return needles;
  } catch (e) {
    throw new CommonsGateUnavailable(`refusing the commons push-search: the live secret-value set could not be loaded (${String((e && e.message) || e).replace(/Bearer\s+\S+/g, "Bearer [redacted]").slice(0, 200)}); pushing into the open room would be unverified. There is no flag to skip this check.`);
  }
}

/** Gate ONE row. Pure. `text` is the row's sidecar text. Returns { ok, reasons: [{kind, rules: string[]}] }. */
export function gateCommonsRow({ path, text, needles }) {
  const reasons = [];
  const t = String(text == null ? "" : text);
  const norm = normalizeRelPath(path);
  if (norm.startsWith("_KNOWLEDGE/")) {
    // Only brain-save writes _KNOWLEDGE/: a strict key shape AND its provenance header. Anything else there
    // was put by another route and never passed the put gates.
    if (norm !== path || !parseKnowledgeKey(path)) reasons.push({ kind: "provenance", rules: ["not-a-brain-save-key"] });
    else if (!hasBrainSaveProvenance(t)) reasons.push({ kind: "provenance", rules: ["no-brain-save-provenance"] });
  }
  const g = gateStoredObject({ key: path, text: t, needles, secrets: true, ring: true });
  for (const f of g.findings) reasons.push({ kind: f.kind, rules: f.rules });
  return { ok: reasons.length === 0, reasons };
}

/** One human-readable line for a blocked row: path + rule names only. */
export function formatCommonsBlock(path, reasons) {
  return `${path}: ${reasons.map((r) => `${r.kind} [${r.rules.join(", ")}]`).join("; ")}`;
}

/** The stateful gate a push loop holds: counts blocks and remembers them for the run summary / exit code. */
export function createCommonsGate({ needles, log = () => {} }) {
  if (!Array.isArray(needles) || needles.length === 0) throw new CommonsGateUnavailable("refusing the commons push-search: no secret needles are loaded (the gate would fail open)");
  const state = { checked: 0, blocked: 0, blockedPaths: [] };
  return {
    state,
    needleCount: needles.length,
    /** Returns true when the row may be embedded. A blocked row is logged (path + rules only) and counted. */
    allow(path, text) {
      state.checked++;
      const v = gateCommonsRow({ path, text, needles });
      if (v.ok) return true;
      state.blocked++;
      if (state.blockedPaths.length < 200) state.blockedPaths.push(path);
      log(`  [push-search] BLOCKED by the commons content gate -- ${formatCommonsBlock(path, v.reasons)}`);
      return false;
    },
    /** Non-zero when any row was blocked: a gate hit must never read as a clean run. */
    exitCode() { return state.blocked > 0 ? 1 : 0; },
    summary() { return `commons content gate: ${state.checked} row(s) checked, ${state.blocked} blocked${state.blocked ? " (exit non-zero: run `node skills/brain-save/brain-save.mjs audit` and review the listed paths)" : ""}`; },
  };
}
