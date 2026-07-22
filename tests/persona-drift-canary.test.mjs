import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractPersonaBlock,
  normalizeBlock,
  firstDivergence,
  assessPersonaDrift,
  pageExitCode,
} from "../skills/persona-drift-canary/persona-drift-canary.mjs";

const CANONICAL = [
  "You are the OTCHealth AI Operating System — the single, unified intelligence running OTCHealth Inc. and InnerScope (INND): finance, legal, operations, product, revenue, compliance, and technology fused into one decisive executive. There is one persona: yours. In your lane you are that facet of the One Brain — one mind, many hands — speaking in one voice and reasoning from one shared company brain.",
  "",
  "GROUND-FIRST PROTOCOL (mandatory): For ANY question about the company, its finances, legal/personal matters, operations, product, people, customers, or INND — retrieve from the company brain FIRST (your `brain_search` tool) and answer ONLY from retrieved results, with citations; never from general knowledge, and never a generic disclaimer. For EXTERNAL public-world questions, use your `web_search` tool and cite sources. NEVER send company-confidential, personal, legal, customer, or PHI content to web search; PHI/BAA-scoped data never touches a non-BAA runtime.",
  "",
  "RING-ISOLATION (unchanged): privileged agents keep their ring gating — adopt this voice + ground-first rule, but the refusal to export privileged content to any unauthorized destination remains correct and is never overridden.",
  "",
  "Voice: decisive, precise, security-first; lead with what is true now, then the recommendation; concise and executive; cite grounded claims.",
].join("\n");
const CANONICAL_NORMALIZED = normalizeBlock(CANONICAL);

function wrapAsClaudeMd(block) {
  return `# CLAUDE.md\n\n## One Brain, Persona and Ground-First (adopt this)\n\n${block}\n\n\nSome other content below the block.\n`;
}

test("extractPersonaBlock: finds the block bounded by the start sentence and the Voice: line, inclusive", () => {
  const doc = wrapAsClaudeMd(CANONICAL);
  const block = extractPersonaBlock(doc);
  assert.ok(block != null);
  assert.ok(block.startsWith("You are the OTCHealth AI Operating System"));
  assert.ok(block.trimEnd().endsWith("cite grounded claims."));
  assert.ok(!block.includes("Some other content below the block."));
});

test("extractPersonaBlock: returns null when the start marker is absent", () => {
  assert.equal(extractPersonaBlock("# CLAUDE.md\n\nNo persona block here.\n"), null);
});

test("extractPersonaBlock: returns null when the start marker exists but no Voice: line follows within the window", () => {
  const doc = "You are the OTCHealth AI Operating System, but this doc never actually closes with a Voice: line anywhere nearby.\n" + "filler line\n".repeat(70);
  assert.equal(extractPersonaBlock(doc), null);
});

test("extractPersonaBlock: non-string input returns null (fail-open, never throws)", () => {
  assert.equal(extractPersonaBlock(null), null);
  assert.equal(extractPersonaBlock(undefined), null);
  assert.equal(extractPersonaBlock(42), null);
});

test("normalizeBlock: collapses line breaks and blank-line paragraph gaps to single spaces", () => {
  const a = "line one\n\nline two\n\n\nline three";
  const b = "line one line two line three";
  assert.equal(normalizeBlock(a), b);
});

test("normalizeBlock: is idempotent and trims leading/trailing whitespace", () => {
  const raw = "  \n  hello   world  \n  ";
  assert.equal(normalizeBlock(raw), "hello world");
  assert.equal(normalizeBlock(normalizeBlock(raw)), normalizeBlock(raw));
});

test("normalizeBlock: null/undefined input yields empty string, never throws", () => {
  assert.equal(normalizeBlock(null), "");
  assert.equal(normalizeBlock(undefined), "");
});

test("assessPersonaDrift: a repo whose extracted+normalized block matches canonical is MATCH", () => {
  const doc = wrapAsClaudeMd(CANONICAL);
  const v = assessPersonaDrift({ repoPath: "/home/user/x/CLAUDE.md", repoRawText: doc, readError: null, canonicalNormalized: CANONICAL_NORMALIZED });
  assert.equal(v.state, "MATCH");
  assert.equal(v.drifted, false);
});

test("assessPersonaDrift: purely cosmetic reflow (different line wrapping / extra blank lines) is still MATCH, not DRIFTED", () => {
  const reflowed = CANONICAL.split("\n\n").join("\n\n\n\n"); // extra blank lines between paragraphs
  const doc = wrapAsClaudeMd(reflowed);
  const v = assessPersonaDrift({ repoPath: "/home/user/x/CLAUDE.md", repoRawText: doc, readError: null, canonicalNormalized: CANONICAL_NORMALIZED });
  assert.equal(v.state, "MATCH");
});

test("assessPersonaDrift: an actual wording change (the real otchealth-cto-shaped divergence) is DRIFTED", () => {
  const drifted = CANONICAL.replace(
    "In your lane you are that facet of the One Brain",
    "In your lane (CTO / CLO / CFO / App Lead) you are that facet of the One Brain",
  );
  const doc = wrapAsClaudeMd(drifted);
  const v = assessPersonaDrift({ repoPath: "/home/user/otchealth-cto/CLAUDE.md", repoRawText: doc, readError: null, canonicalNormalized: CANONICAL_NORMALIZED });
  assert.equal(v.state, "DRIFTED");
  assert.equal(v.drifted, true);
});

test("assessPersonaDrift: an appended trailing sentence on the Voice: line is DRIFTED (content added, not just whitespace)", () => {
  const drifted = CANONICAL.replace(
    "Voice: decisive, precise, security-first; lead with what is true now, then the recommendation; concise and executive; cite grounded claims.",
    'Voice: decisive, precise, security-first; lead with what is true now, then the recommendation; concise and executive; cite grounded claims. Canonical spec: the global doc "One Brain, Canonical Persona and Ground-First Protocol".',
  );
  const doc = wrapAsClaudeMd(drifted);
  const v = assessPersonaDrift({ repoPath: "/home/user/otchealth-cto/CLAUDE.md", repoRawText: doc, readError: null, canonicalNormalized: CANONICAL_NORMALIZED });
  assert.equal(v.state, "DRIFTED");
});

test("assessPersonaDrift: a repo with no persona block at all is ABSENT, not DRIFTED", () => {
  const v = assessPersonaDrift({ repoPath: "/home/user/x/CLAUDE.md", repoRawText: "# CLAUDE.md\n\nnothing here\n", readError: null, canonicalNormalized: CANONICAL_NORMALIZED });
  assert.equal(v.state, "ABSENT");
  assert.equal(v.drifted, false);
});

test("assessPersonaDrift: a read error is NO_DATA, distinct from ABSENT and DRIFTED", () => {
  const v = assessPersonaDrift({ repoPath: "/home/user/x/CLAUDE.md", repoRawText: null, readError: "ENOENT", canonicalNormalized: CANONICAL_NORMALIZED });
  assert.equal(v.state, "NO_DATA");
  assert.equal(v.drifted, false);
  assert.equal(v.reason, "ENOENT");
});

test("firstDivergence: identical normalized strings return null", () => {
  assert.equal(firstDivergence("same text here", "same text here"), null);
});

test("firstDivergence: finds the index and context of the first mismatch", () => {
  const a = "the quick brown fox";
  const b = "the quick RED fox";
  const d = firstDivergence(a, b);
  assert.ok(d != null);
  assert.equal(d.index, 10); // "the quick " is 10 chars, divergence starts at index 10
  assert.ok(d.canonicalContext.includes("brown"));
  assert.ok(d.repoContext.includes("RED"));
});

test("firstDivergence: a suffix-only difference (one string longer) is still detected", () => {
  const a = "hello world";
  const b = "hello world and more";
  const d = firstDivergence(a, b);
  assert.ok(d != null);
  assert.equal(d.index, 11);
});

test("pageExitCode: strict + an anomaly present pages (exit 1)", () => {
  assert.equal(pageExitCode(1, true), 1);
});

test("pageExitCode: strict + zero anomalies does not page (exit 0)", () => {
  assert.equal(pageExitCode(0, true), 0);
});

test("pageExitCode: non-strict never pages, even with anomalies (report-only default)", () => {
  assert.equal(pageExitCode(3, false), 0);
  assert.equal(pageExitCode(0, false), 0);
});
