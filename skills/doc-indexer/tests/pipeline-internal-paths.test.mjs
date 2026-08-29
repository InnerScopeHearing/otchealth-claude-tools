// Tests for pipeline-paths.mjs isPipelineInternal() -- which catalog rows are pipeline bookkeeping
// rather than documents to enrich.
//
// WHY THIS EXISTS. The predicate was a blanket `!path.startsWith("_")`. Its intent was to skip the
// directories the doc-indexer pipeline writes for itself (_TEXT/ sidecars, _CATALOG/, _REVIEW/), but
// the commons room uses an underscore prefix as a NAMING CONVENTION for real content, so it also
// excluded the company's own written knowledge. Measured live on 2026-08-19: 4,143 of 4,218 commons
// rows were skipped, including 3,234 _NOTION pages, 322 _RESEARCH, 231 _DOCS and 222 _JOURNAL. The
// knowledge-graph enrichment covered ~2% of that room and reported itself complete.
//
// These cases are taken from that real catalog, so a regression fails against production shapes
// rather than invented ones.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPipelineInternal, isLegalPersonalRoom } from "../pipeline-paths.mjs";

test("pipeline bookkeeping is excluded", () => {
  for (const p of [
    "_TEXT/shopify-library/00-index.md.txt",   // a sidecar; enriching it would enrich a sidecar of a sidecar
    "_CATALOG/catalog.jsonl",
    "_CATALOG/.enrich.lock",
    "_REVIEW/metadata-review-queue.csv",
    "_MEMORY/_exec/cto.jsonl",                 // append-only ledger, separately indexed as a memory room
    "_STATE/last-run.json",
    "_ARCHIVE/otchealth-brain-snapshot-2026-07-14.jsonl", // 3.12 GB in one file
  ]) {
    assert.equal(isPipelineInternal(p), true, `${p} is pipeline bookkeeping and must be skipped`);
  }
});

test("underscore-prefixed CONTENT is NOT excluded -- the regression this predicate exists for", () => {
  // Every one of these is a real commons path that the old blanket startsWith("_") silently dropped.
  for (const p of [
    "_NOTION/some-company-page.md",
    "_RESEARCH/cro/2026-07-15/report.md",
    "_DOCS/platform-connectivity/chatgpt.md",
    "_JOURNAL/2026-08-01.md",
    "_RECOVERY/DAY-2026-07-15-CTO-SESSION.md",
    "_DAILY/2026-08-18-digest.md",
    "_FLEET-WATCH/2026-08-18.md",
    "_HEARTBEAT/2026-08-18T11.md",
    "_MEDIC/2026-08-18-scan.md",
  ]) {
    assert.equal(isPipelineInternal(p), false, `${p} is real content and must be enriched`);
  }
});

test("ordinary paths are never excluded", () => {
  for (const p of [
    "shopify-library/00-index.md",
    "RESEARCH/cro/2026-07-15/report.md",
    "qbo-export/2024/invoice.pdf",
  ]) {
    assert.equal(isPipelineInternal(p), false);
  }
});

test("a bare prefix without its slash is not treated as bookkeeping", () => {
  // "_TEXTBOOK/..." must not match "_TEXT/". The prefixes are matched WITH their trailing slash
  // precisely so a longer folder name that merely starts with the same letters is safe.
  assert.equal(isPipelineInternal("_TEXTBOOK/chapter-1.md"), false);
  assert.equal(isPipelineInternal("_CATALOGUE/2026-spring.pdf"), false);
  assert.equal(isPipelineInternal("_MEMORABILIA/photo.jpg"), false);
});

test("null/undefined/empty are handled without throwing", () => {
  assert.equal(isPipelineInternal(null), false);
  assert.equal(isPipelineInternal(undefined), false);
  assert.equal(isPipelineInternal(""), false);
});

test("fail-on-old-code proof: the OLD blanket rule disagrees on the content cases", () => {
  // The predicate this replaced, verbatim. If someone reverts to it, the cases above stop being
  // hypothetical -- this documents exactly which inputs change behavior, so the test is not just
  // asserting the current implementation back to itself.
  const oldRule = (p) => String(p || "").startsWith("_");
  const contentThatOldRuleWronglyExcluded = [
    "_NOTION/some-company-page.md",
    "_RESEARCH/cro/2026-07-15/report.md",
    "_DOCS/platform-connectivity/chatgpt.md",
    "_JOURNAL/2026-08-01.md",
  ];
  for (const p of contentThatOldRuleWronglyExcluded) {
    assert.equal(oldRule(p), true, "the old rule excluded this");
    assert.equal(isPipelineInternal(p), false, "the new rule includes it");
  }
  // and both agree on genuine bookkeeping, so the change is a narrowing, not a loosening of intent
  for (const p of ["_TEXT/a.txt", "_CATALOG/catalog.jsonl", "_REVIEW/q.csv"]) {
    assert.equal(oldRule(p), true);
    assert.equal(isPipelineInternal(p), true);
  }
});

// ============================================================================================
// isLegalPersonalRoom (2026-08-29): enrich.mjs's --container override can point ANY profile at
// ANY container, including `--profile legal --container personal` (attorney-client-privileged).
// This predicate is the hard, code-enforced gate enrich.mjs checks BEFORE any LLM call, for every
// provider (openai/azure/bedrock) -- see enrich.mjs's cmdRun() and PILOT-bedrock-enrich.md.
// ============================================================================================

test("isLegalPersonalRoom: exact match on profile=legal + container=personal is excluded", () => {
  assert.equal(isLegalPersonalRoom("legal", "personal"), true);
});

test("isLegalPersonalRoom: case-insensitive on both profile and container", () => {
  assert.equal(isLegalPersonalRoom("LEGAL", "PERSONAL"), true);
  assert.equal(isLegalPersonalRoom("Legal", "Personal"), true);
});

test("isLegalPersonalRoom: legal's default container (company) is NOT excluded", () => {
  assert.equal(isLegalPersonalRoom("legal", "company"), false);
});

test("isLegalPersonalRoom: 'personal' under any OTHER profile is not excluded by this predicate (it is legal-profile-specific)", () => {
  assert.equal(isLegalPersonalRoom("finance", "personal"), false);
  assert.equal(isLegalPersonalRoom("commerce", "personal"), false);
  assert.equal(isLegalPersonalRoom("commons", "personal"), false);
});

test("isLegalPersonalRoom: an exact match only -- a container that merely CONTAINS 'personal' does not false-positive", () => {
  assert.equal(isLegalPersonalRoom("legal", "personal-archive"), false);
  assert.equal(isLegalPersonalRoom("legal", "personal2"), false);
  assert.equal(isLegalPersonalRoom("legal", "not-personal"), false);
});

test("isLegalPersonalRoom: a profile that merely CONTAINS 'legal' does not false-positive", () => {
  assert.equal(isLegalPersonalRoom("legal-archive", "personal"), false);
  assert.equal(isLegalPersonalRoom("legalese", "personal"), false);
});

test("isLegalPersonalRoom: null/undefined/empty are handled without throwing", () => {
  assert.equal(isLegalPersonalRoom(null, null), false);
  assert.equal(isLegalPersonalRoom(undefined, undefined), false);
  assert.equal(isLegalPersonalRoom("", ""), false);
  assert.equal(isLegalPersonalRoom("legal", null), false);
  assert.equal(isLegalPersonalRoom(null, "personal"), false);
});
