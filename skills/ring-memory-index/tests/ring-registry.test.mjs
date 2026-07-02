// Config-integrity tests for ring-memory-index: the RINGS registry is the safety-critical part (each
// ring must point ONLY at its own store + its own index — never cross rings), so pin its shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RINGS, indexRing, run } from "../index-ring-memory.mjs";

test("RINGS registry has the expected ring-isolated ledgers with all required fields", () => {
  assert.ok(Array.isArray(RINGS) && RINGS.length >= 2);
  for (const r of RINGS) {
    for (const f of ["label", "storeAcctSecret", "storeKeySecret", "container", "ledger", "index", "idPrefix"]) {
      assert.ok(typeof r[f] === "string" && r[f].length > 0, `ring ${r.label} missing ${f}`);
    }
  }
});

test("rings stay in-ring: legal ledger -> legal index, finance ledger -> finance index (no crossing)", () => {
  const clo = RINGS.find((r) => r.label === "clo-personal");
  const cfo = RINGS.find((r) => r.label === "cfo");
  assert.ok(clo && /legal/.test(clo.storeAcctSecret) && /legal/.test(clo.index), "CLO must use the legal store + a legal-* index");
  assert.ok(cfo && /cfo/.test(cfo.storeAcctSecret) && /finance/.test(cfo.index), "CFO must use the cfo store + a finance-* index");
  // no two rings share a target index
  const idxs = RINGS.map((r) => r.index);
  assert.equal(new Set(idxs).size, idxs.length, "each ring must have a distinct target index");
});

test("exports the run + indexRing entry points", () => {
  assert.equal(typeof run, "function");
  assert.equal(typeof indexRing, "function");
});
