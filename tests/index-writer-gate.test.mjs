// THE otchealth-brain FAILURE, ENCODED AS A TEST.
//
// On 2026-07-13 an index with 67,645 documents and NO WRITER ANYWHERE was the fleet's designated source
// of truth for ~12 days. These tests make that state unshippable: the real registry must pass, and a
// registry containing an orphan index must FAIL. The second test is the one that matters -- a gate that
// has never been proven to fail is not a gate.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { auditIndexWriters } from "../setup/index-writer-gate.mjs";

const registry = JSON.parse(readFileSync(new URL("../setup/expected-indexes.json", import.meta.url), "utf8"));
const resources = JSON.parse(readFileSync(new URL("../setup/expected-resources.json", import.meta.url), "utf8"));

test("the LIVE registry passes: every queryable index has a real, tracked writer", () => {
  assert.deepEqual(auditIndexWriters(registry, resources), []);
});

test("every live index declares a MEASURABLE freshness mechanism (timestamp field OR pull-indexer)", () => {
  // The room indexes carried no time field of any kind until 2026-07-13, which is why staleness was
  // structurally undetectable. You cannot monitor what you did not instrument. Post-Phase-3 (2026-07-20)
  // the S1 chunked doc rooms carry NO doc timestamp, so their freshness signal is the pull-indexer's
  // newest successful run (writer_indexer / writer_indexer_prefix) rather than a doc field. Either is
  // measurable; an index with NEITHER can freeze silently forever.
  for (const ix of registry.indexes) {
    assert.ok(ix.timestamp_field || ix.writer_indexer || ix.writer_indexer_prefix, `${ix.index} has no freshness mechanism (timestamp_field or writer_indexer)`);
    assert.ok(ix.max_age_h > 0, `${ix.index} has no staleness SLO`);
  }
});

test("REGRESSION: an index with NO freshness mechanism FAILS the gate", () => {
  // A tracked writer is not enough -- without a measurable freshness signal, a frozen index looks alive.
  const bad = { indexes: [{ index: "memory-exec", service: "s", writer_job: "brain-reindex", max_age_h: 24 }], decommissioning: [] };
  const v = auditIndexWriters(bad, resources);
  assert.ok(v.some((m) => /no freshness mechanism/.test(m)), "an index with neither timestamp_field nor writer_indexer must fail the gate");
});

test("REGRESSION: an index with NO writer FAILS the gate (this is otchealth-brain)", () => {
  const bad = { indexes: [{ index: "otchealth-brain", service: "otchealth-brain-search", writer_job: null, timestamp_field: "ts", max_age_h: 24 }], decommissioning: [] };
  const v = auditIndexWriters(bad, resources);
  assert.equal(v.length, 1);
  assert.match(v[0], /NO WRITER DECLARED/);
});

test("REGRESSION: a writer that is not a tracked containerAppJob FAILS the gate", () => {
  // A writer_job that isn't in expected-resources.json is a writer that can silently go absent from ARM
  // without resource-reconcile.mjs ever noticing -- a second-order version of the same disease.
  const bad = { indexes: [{ index: "memory-exec", service: "s", writer_job: "ghost-reindex", timestamp_field: "ts", max_age_h: 24 }], decommissioning: [] };
  const v = auditIndexWriters(bad, resources);
  assert.equal(v.length, 1);
  assert.match(v[0], /NOT a containerAppJob/);
});

test("REGRESSION: an index with no measurable timestamp FAILS (a frozen index emits no error)", () => {
  const bad = { indexes: [{ index: "commons-company-journal", service: "s", writer_job: "librarian-commerce", timestamp_field: "", max_age_h: 48 }], decommissioning: [] };
  const v = auditIndexWriters(bad, resources);
  assert.equal(v.length, 1);
  assert.match(v[0], /UNMEASURABLE/);
});

test("a tombstoned index cannot be re-adopted as a live source of truth", () => {
  const bad = {
    indexes: [{ index: "otchealth-brain", service: "s", writer_job: "brain-reindex", timestamp_field: "ts", max_age_h: 24 }],
    decommissioning: [{ index: "otchealth-brain", writer_job: null, status: "ORPHAN" }],
  };
  const v = auditIndexWriters(bad, resources);
  assert.ok(v.some((x) => /BOTH "indexes" and "decommissioning"/.test(x)));
});

test("otchealth-brain is tombstoned, NOT live", () => {
  assert.ok(!registry.indexes.some((i) => i.index === "otchealth-brain"), "otchealth-brain must never be a live source of truth again");
  assert.ok(registry.decommissioning.some((d) => d.index === "otchealth-brain"));
});
