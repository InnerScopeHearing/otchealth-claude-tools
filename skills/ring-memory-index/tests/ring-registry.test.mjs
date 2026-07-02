// Config-integrity tests for ring-memory-index: the RINGS registry is the safety-critical part (each
// row must point ONLY at its own index — never cross into another agent's index, even when rows share
// a store), so pin its shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RINGS, indexRing, run } from "../index-ring-memory.mjs";

const COMMONS_AGENTS = ["coo", "cco", "cro", "cpo", "developer"];

test("RINGS registry has the expected ledgers with all required fields", () => {
  assert.ok(Array.isArray(RINGS) && RINGS.length >= 2 + COMMONS_AGENTS.length);
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
});

test("every row has a distinct target index (no two agents share an index)", () => {
  const idxs = RINGS.map((r) => r.index);
  assert.equal(new Set(idxs).size, idxs.length, "each ring must have a distinct target index");
});

test("non-privileged commons agents (coo/cco/cro/cpo/developer) are all registered, in-store, in-index", () => {
  for (const label of COMMONS_AGENTS) {
    const r = RINGS.find((x) => x.label === label);
    assert.ok(r, `${label} missing from RINGS`);
    assert.equal(r.storeAcctSecret, "azure-commons-storage-account", `${label} must read the commons account secret`);
    assert.equal(r.storeKeySecret, "azure-commons-storage-key", `${label} must read the commons key secret`);
    assert.equal(r.container, "company-journal", `${label} must target the company-journal container`);
    assert.equal(r.ledger, `_MEMORY/${label}.jsonl`, `${label} must read its own private ledger, not another agent's`);
    assert.equal(r.index, `commons-${label}-memory`, `${label} must write to its own commons-<agent>-memory index`);
  }
});

test("commons agents share a STORE but never a target index, and never touch clo-personal/cfo indexes", () => {
  const commonsRows = RINGS.filter((r) => COMMONS_AGENTS.includes(r.label));
  assert.equal(commonsRows.length, COMMONS_AGENTS.length, "all commons agents must be present");
  // all share the same account+container (that's expected — one shared store)
  for (const r of commonsRows) {
    assert.equal(r.storeAcctSecret, "azure-commons-storage-account");
    assert.equal(r.container, "company-journal");
  }
  // but distinct index + distinct ledger per agent, and never the same index as another commons agent
  const idxs = commonsRows.map((r) => r.index);
  const ledgers = commonsRows.map((r) => r.ledger);
  assert.equal(new Set(idxs).size, commonsRows.length, "commons agents must not share an index with each other");
  assert.equal(new Set(ledgers).size, commonsRows.length, "commons agents must not share a ledger with each other");
  // and must never collide with the ring-isolated CLO/CFO indexes
  const cloIdx = RINGS.find((r) => r.label === "clo-personal").index;
  const cfoIdx = RINGS.find((r) => r.label === "cfo").index;
  for (const idx of idxs) {
    assert.notEqual(idx, cloIdx);
    assert.notEqual(idx, cfoIdx);
  }
});

test("no two rows anywhere in the registry share a target index (global distinct-index invariant)", () => {
  const idxs = RINGS.map((r) => r.index);
  assert.equal(new Set(idxs).size, idxs.length);
});

test("exports the run + indexRing entry points", () => {
  assert.equal(typeof run, "function");
  assert.equal(typeof indexRing, "function");
});
