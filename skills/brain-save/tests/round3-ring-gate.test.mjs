// Adjudication round 3 (2026-09-29): ring-gate bypasses. #5 banners, #9 declarations, #10 content
// heuristics, #11 path/source denies, #15 PHI labels, #17 linear HTML views. Each block pins the reproduced
// bypasses AND the fleet-corpus false positives found while tuning (fleet CLAUDE.md / runbooks gain no new
// refusals; see the round-3 corpus scan in test-results.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRing, bannerSignals, heuristicSignals, pathDenies, phiSignals, parseRepo, checkOverrideReason, htmlRawView, declaredSignals } from "../lib/ring-gate.mjs";
import { normalizeInput, parseFrontmatter, jsonDeclarations, htmlDeclarations } from "../lib/normalize.mjs";
import { prepareDoc } from "../lib/pipeline.mjs";
import { htmlToMarkdown } from "../lib/html-to-md.mjs";

const codes = (r) => [...r.hard, ...r.heuristic].map((s) => s.code);
const OPTS = { kind: "research", app: "fleet", title: "Round three ring probe document about widget sprockets", agent: "cto", ring: "commons" };
const TEXT = "Ordinary engineering prose about widget sprockets and gizmos, long enough to count as text.\n";
const prep = (ext, text, input = {}, extra = {}) => prepareDoc({ localPath: "", displayPath: `probe${ext}`, bytes: Buffer.from(text), ext, ...input }, { ...OPTS, ...extra }, { needles: [] });
const refused = (fn) => { try { fn(); return false; } catch (e) { if (e.exit === 2) return true; throw e; } };

test("round 3 #5: banner variants refuse (repeated separators, Unicode dashes, draft / communication / counsel-review tails, leading CONFIDENTIAL / DRAFT)", () => {
  for (const [line, ring] of [
    ["CONFIDENTIAL - ATTORNEY-CLIENT COMMUNICATION", "legal"], ["ATTORNEY-CLIENT COMMUNICATION", "legal"],
    ["PRIVILEGED & CONFIDENTIAL // ATTORNEY-CLIENT", "legal"], ["PRIVILEGED & CONFIDENTIAL - DRAFT", "legal"],
    ["Privileged and Confidential - For Counsel Review", "legal"], ["Draft - Attorney Client Privileged", "legal"],
    ["ATTORNEY–CLIENT PRIVILEGED", "legal"], ["ATTORNEY‑CLIENT PRIVILEGED", "legal"], ["ATTORNEY−CLIENT PRIVILEGED", "legal"],
    ["PROTECTED HEALTH INFORMATION", "phi"], ["NOT FOR DISTRIBUTION: MNPI", "innd-mnpi"], ["Not for release - contains MNPI", "innd-mnpi"],
    ["PRIVILEGED", "legal"], ["**Privileged**", "legal"], ["PHI", "phi"], ["**PHI**", "phi"],
    // controls that always hit
    ["PRIVILEGED & CONFIDENTIAL", "legal"], ["ATTORNEY-CLIENT PRIVILEGED", "legal"], ["**ATTORNEY-CLIENT PRIVILEGED**", "legal"], ["MNPI - DO NOT DISTRIBUTE", "innd-mnpi"], ["CONTAINS PHI", "phi"],
  ]) {
    const s = bannerSignals(`intro line\n${line}\nbody`);
    assert.equal(s.length, 1, line);
    assert.equal(s[0].ring, ring, line);
  }
});

test("round 3 #5: prose and headings are not banners (the fleet's `## PHI` sections, sentences using the words)", () => {
  for (const line of ["## PHI", "### Privileged", "# Protected Health Information", "Phi", "privileged", "- PHI", "| PHI |",
    "Attorney-client privileged material never goes to commons.", "## MNPI: what it is and how the fleet handles it",
    "PHI stays inside the MedReview BAA environment.", "Protected health information is defined by HIPAA as follows."]) {
    assert.equal(bannerSignals(line).length, 0, line);
  }
});

test("round 3 #9: declarations in every YAML form refuse; lists and repeated keys are judged per value", () => {
  for (const fm of [
    "classification: [Attorney-Client Privileged]", "classification:\n  - Attorney-Client Privileged", "classification:\n- Internal\n- Privileged",
    "ring:\n  legal-personal", "privilege: work product", "meta:\n  ring: legal-personal", "ring: >\n  attorney work\n  product",
    "sensitivity: {level: restricted}",
  ]) {
    assert.ok(refused(() => prep(".md", `---\n${fm}\n---\n${TEXT}`)), fm);
  }
  for (const fm of ["ring: commons", "classification: [public, internal]", "phi:\n  - false\n  - no", "ring: non-phi", "tags: [phi-free, research]"]) {
    assert.doesNotThrow(() => prep(".md", `---\n${fm}\n---\n${TEXT}`), fm);
  }
  const f = parseFrontmatter("---\nclassification: [a, \"b c\"]\ntitle: X\nnested:\n  title: Y\n---\nbody\n").frontmatter;
  assert.deepEqual(f.classification, ["a", "b c"]);
  assert.equal(f.title, "X", "a nested ordinary key never replaces a top-level one");
});

test("round 3 #9: JSON declarations at ANY depth (arrays and array roots included) refuse; rule contexts do not", () => {
  for (const v of [{ meta: { ring: "legal-personal" }, notes: TEXT }, { metadata: { classification: "attorney-client privileged" }, notes: TEXT }, { flags: { contains_phi: true }, notes: TEXT }, [{ ring: "legal-personal", notes: TEXT }], { doc: { header: { classification: ["internal", "privileged"] } }, notes: TEXT }]) {
    assert.ok(refused(() => prep(".json", JSON.stringify(v))), JSON.stringify(v).slice(0, 80));
  }
  // A governance charter DESCRIBES rings in classifier rules; that is not this document's own declaration.
  const charter = { agent: "cto", prohibited_actions: [{ id: "phi-ring", classifier: { ring: "phi", tools: ["x"] } }], notes: TEXT };
  assert.doesNotThrow(() => prep(".json", JSON.stringify(charter)));
  assert.deepEqual(jsonDeclarations(charter), {});
  // A negated declaration whose commentary repeats its own family stays allowed; another family still refuses.
  assert.equal(declaredSignals({ ring: "non-PHI (keeps it outside HIPAA; the PHI ring is a hard wall)" }).length, 0);
  assert.equal(declaredSignals({ ring: "non-PHI; attorney-client privileged" }).length, 1);
  assert.deepEqual(htmlDeclarations('<meta name="classification" content="internal"><meta name="classification" content="privileged">').classification, ["internal", "privileged"]);
});

test("round 3 #10: a ledger refuses whatever the entity spelling; INND events with a not-yet-public marker refuse; personal family-law memos refuse", () => {
  const rows = Array.from({ length: 25 }, (_, i) => `| 6${100 + i} | Vendor ${i} | ${(1000 + i * 37.13).toFixed(2)} |`).join("\n");
  for (const ent of ["OTCHealth", "OTC Health", "Hearing Assist", "HearingAssist", "OTCHealth Inc."]) {
    const t = `# Q3 general ledger extract\n\n${ent} general ledger, trial balance and journal entries; accounts payable reconciliation.\n\n| GL account | Memo | Amount |\n|---|---|---|\n${rows}\n`;
    assert.ok(heuristicSignals(t).some((s) => s.code === "FINANCE_LEDGER"), ent);
  }
  const eight = "# Draft 8-K\n\nDRAFT - Item 1.01 Entry into a Material Definitive Agreement. InnerScope Hearing Technologies (INND) has entered into a definitive agreement to acquire a distributor for $4.2 million; the Form 8-K will be filed after the board vote. INND shareholders have not been told.\n";
  const preview = "# INND Q3 earnings preview\n\nInnerScope (INND) Q3 revenue will come in at $1.9M, up 40% quarter over quarter; guidance raised. The earnings release is embargoed until November 14.\n";
  const custody = "# Custody memo\n\nMemo re: Moore v. Moore, Superior Court of California, County of Orange, family law. Proposed custody schedule for the minor children, spousal support calculation and the settlement position.\n";
  assert.deepEqual(codes(classifyRing({ text: eight })), ["INND_EVENT"]);
  assert.deepEqual(codes(classifyRing({ text: preview })), ["INND_EVENT"]);
  const c = classifyRing({ text: custody });
  assert.deepEqual(codes(c), ["PERSONAL_LEGAL"]);
  assert.equal(c.routes[0].ring, "legal-personal");
  // corpus false positives that must stay allowed
  for (const t of [
    "InnerScope (INND) acquisition accounting follows ASC 805 guidance; the QC reviewer checks the draft financial statements.",
    "The IR team files the INND 8-K within four business days; earnings calls are scheduled by Capital. Draft PRs only.",
    "INND user acquisition guidance for the growth team: preview builds ship to TestFlight.",
    "The CLO tracks matter types: custody of company assets and dissolution of the old LLC.",
    "Research on family law practice software: custody calendars.",
  ]) assert.equal(heuristicSignals(t).length, 0, t);
});

test("round 3 #3: checkOverrideReason gates INND codes on the SEAT only", () => {
  const h = [{ code: "INND_EVENT" }];
  const reason = "INND_EVENT: the release went out on the wire at 8am today";
  assert.equal(checkOverrideReason(reason, h, "cto").ok, false);
  assert.equal(checkOverrideReason(reason, h, "").ok, false);
  for (const seat of ["clo", "capital", "exec", "CLO"]) assert.equal(checkOverrideReason(reason, h, seat).ok, true, seat);
  assert.equal(checkOverrideReason("FINANCE_LEDGER: synthetic fixture rows for the tests", [{ code: "FINANCE_LEDGER" }], "cto").ok, true, "non-INND heuristics are unchanged");
});

test("round 3 #11: path and source deny variants refuse; ledger prefixes stay whole-segment", () => {
  const deny = (x) => pathDenies(x).map((d) => d.ring);
  assert.ok(deny({ localPath: "/x/medreview/notes.md" }).includes("phi"));
  assert.ok(deny({ source: "https://github.com/InnerScopeHearing/medreview/blob/main/docs/x.md" }).includes("phi"));
  assert.ok(deny({ source: "git@github.com:InnerScopeHearing/medreview.git" }).includes("phi"));
  assert.ok(deny({ source: "finance-cfo-source-docs/2026/q3.md" }).includes("finance"));
  for (const d of ["legalpersonal", "LegalPersonal", "legal.personal", "Legal_Personal"]) assert.ok(deny({ localPath: `/x/${d}/a.md` }).includes("legal-personal"), d);
  assert.ok(deny({ localPath: "/x/legal-personal.md" }).includes("legal-personal"));
  assert.equal(parseRepo("git@github.com:InnerScopeHearing/medreview.git"), "medreview");
  assert.equal(parseRepo("https://github.com/org/innd-website/tree/main"), "innd-website");
  assert.equal(parseRepo("medreview@abc:x"), "medreview");
  assert.equal(parseRepo("https://example.org/medreview:x"), "");
  // the repo of a --source counts for heuristics too
  assert.deepEqual(codes(classifyRing({ text: "x", source: "innd-website@abc123:index.html" })), ["INND_IR_SOURCE"]);
  // ledger prefixes: whole directory segment only (a drizzle meta/_journal.json and a memory/ folder are fine)
  assert.equal(deny({ localPath: "/repo/packages/db/drizzle/meta/_journal.json" }).length, 0);
  assert.equal(deny({ localPath: "/home/x/.claude/memory/notes.md" }).length, 0);
  assert.ok(deny({ source: "_JOURNAL/cfo/2026/x.md" }).includes("ledger"));
});

test("round 3 #15: PHI label variants refuse; data dictionaries do not", () => {
  const phi = (s) => phiSignals(`Patient intake notes.\n${s}\nFollow up next week.`).map((x) => x.detail);
  assert.deepEqual(phi("SS# 219-09-9998"), ["labeled SSN"]);
  assert.deepEqual(phi("Social: 219-09-9998"), ["labeled SSN"]);
  assert.deepEqual(phi("| SSN | 219-09-9998 |"), ["labeled SSN"]);
  assert.deepEqual(phi("| MRN | 00482913 |"), ["labeled medical record number"]);
  for (const d of ["| DOB | 03/03/1962 |", "DOB: March 3rd, 1962", "DOB 3 March 1962", "Date of birth: 3rd of March, 1962", "Born: 1962-03-03"]) assert.deepEqual(phi(d), ["labeled date of birth"], d);
  for (const ok of ["| MRN | Medical record number |", "the `SYN-` MRN prefix", "She was born in 1962 in Ohio.", "Social media posts on 2026-09-29"]) assert.deepEqual(phi(ok), [], ok);
});

test("round 3 #17: HTML views are linear on crafted input and unchanged on normal pages", () => {
  for (const [unit, n] of [["<!--", 100000], ["<script ", 50000], ["<pre>", 80000], ["<a href=x>", 40000], ["<", 400000], ["<meta ", 60000], ["<h2>", 80000], ["<code>", 80000], ['srcset="', 50000]]) {
    const s = unit.repeat(n);
    const t0 = Date.now();
    htmlToMarkdown(s);
    htmlRawView(s);
    htmlDeclarations(s);
    assert.ok(Date.now() - t0 < 1500, `${unit} x${n}: ${Date.now() - t0} ms`);
  }
  const page = `<html><head><title>Brain save usage notes</title><style>.x{}</style></head><body><h2>Plan</h2><p>Use <code>brain-save</code> and <a href="https://example.org/doc">the doc</a>, <b>bold</b>.</p><pre>line 1\nline 2</pre><script>x()</script><ul><li>one</li><li>two</li></ul></body></html>`;
  assert.equal(htmlToMarkdown(page).markdown, "## Plan\n\nUse `brain-save` and the doc (https://example.org/doc), **bold**.\n\n```\nline 1\nline 2\n```\n\n- one\n- two");
  // an unclosed <head> no longer swallows the body; an unclosed <script> drops the rest (as a browser would)
  assert.match(htmlToMarkdown("<html><head><title>T</title><body><p>Body survives.</p></body></html>").markdown, /Body survives\./);
  assert.equal(htmlToMarkdown("<p>Kept.</p><script>let a = 1; <p>not text</p>").markdown, "Kept.");
  assert.match(normalizeInput({ ext: ".html", text: page }).body, /\n\nPage title: Brain save usage notes\n$/);
  assert.doesNotMatch(normalizeInput({ ext: ".html", text: "<title>Plan</title><h2>Plan</h2><p>Body text here.</p>" }).body, /Page title/, "not repeated when the body already says it");
});
