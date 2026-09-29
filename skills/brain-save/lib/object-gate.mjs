// object-gate.mjs -- the secret + ring gate over an ALREADY STORED object (or a catalog row's sidecar text).
// PURE (no I/O, no CLI side effects), so `brain-save audit` and the doc-indexer's commons push-search run the
// SAME check: adjudication round 4 found that audit --repair re-pushed an object after flagging it, and that
// `indexer.mjs push-search --profile commons` had no content gate of its own (the rows it embeds are readable by
// every lane, external connectors included).
//
// A finding names only the kind, the rule / SSM parameter NAME and (for a secret) the line: never a value.
import { splitObject } from "./provenance.mjs";
import { scanParts, formatSecretHits } from "./secret-gate.mjs";
import { classifyRing, formatRingRefusal } from "./ring-gate.mjs";
import { parseFrontmatter } from "./normalize.mjs";

/** The seat an override was accepted from is recorded in the header: "(by <agent>, seat <seat>, signals: ...)". */
const seatOf = (override) => (String(override || "").match(/, seat ([^,\s)]+)/) || [])[1] || "";

/**
 * Gate a stored object. `text` is the stored object (brain-save header + body) or a plain sidecar text.
 * Returns { findings: [{kind: "secret"|"ring", detail, rules: string[]}], hasHeader, fields }.
 * `needles` may be [] only for the ring half; a caller that needs the secret half must pass the live set.
 */
export function gateStoredObject({ key = "", text, needles = [], secrets = true, ring = true }) {
  const findings = [];
  const { fields, body } = splitObject(text);
  if (secrets) {
    const hits = scanParts({ object: text }, needles);
    if (hits.length) findings.push({ kind: "secret", detail: formatSecretHits(hits).join("; "), rules: [...new Set(hits.map((h) => (h.layer === "B" ? `layer-B:${h.name}` : `layer-A:${h.name}`)))] });
  }
  if (ring) {
    let res;
    if (fields) {
      const ov = fields.ring_override || "";
      res = classifyRing({ text: body, source: fields.source || "", artifactUrl: fields.artifact_url || "", sourceRepo: (String(fields.source || "").match(/^([A-Za-z0-9._-]+)@/) || [])[1] || "", override: ov, overrideSeat: seatOf(ov) });
    } else {
      // A sidecar / plain document without the brain-save header: declarations live in its own front matter.
      const { frontmatter } = parseFrontmatter(String(text || ""));
      res = classifyRing({ text: String(text || ""), frontmatter, localPath: key });
    }
    if (!res.allowed) findings.push({ kind: "ring", detail: formatRingRefusal(res).join("; "), rules: [...res.hard, ...res.heuristic].map((s) => s.code) });
  }
  return { findings, hasHeader: Boolean(fields), fields };
}

/** True when the stored object carries brain-save's provenance header (`saved_by: "brain-save ..."`). */
export function hasBrainSaveProvenance(text) {
  const { fields } = splitObject(text);
  return Boolean(fields && /^brain-save\b/.test(String(fields.saved_by || "")));
}
