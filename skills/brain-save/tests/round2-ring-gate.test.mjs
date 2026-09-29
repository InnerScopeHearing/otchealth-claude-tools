// Adjudication round 2 (2026-09-29): ring-gate bypasses (banners, raw views, declarations, path
// variants, finance/securities heuristics, the override). One test per confirmed defect.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRing, bannerSignals, heuristicSignals, declaredSignals, pathDenies, htmlRawView, jsonRawView, jsonFinanceSignals, checkOverrideReason, countAmounts, formatRingRefusal } from "../lib/ring-gate.mjs";
import { normalizeInput, htmlDeclarations, jsonDeclarations } from "../lib/normalize.mjs";

const codes = (r) => [...r.hard, ...r.heuristic].map((s) => s.code);

test("round 2 banners: dash / period / slash separators, the counsel tail, and standalone MNPI lines refuse", () => {
  for (const b of [
    "PRIVILEGED & CONFIDENTIAL — ATTORNEY-CLIENT COMMUNICATION",
    "PRIVILEGED & CONFIDENTIAL – ATTORNEY-CLIENT COMMUNICATION",
    "PRIVILEGED AND CONFIDENTIAL. ATTORNEY-CLIENT COMMUNICATION. DO NOT FORWARD.",
    "Privileged & Confidential / Attorney Work Product / Prepared at the direction of counsel",
    "**MNPI**", "MNPI - DO NOT DISTRIBUTE", "INND MNPI — INTERNAL ONLY", "Material Non-Public Information - Do Not Distribute",
    "<!-- PRIVILEGED & CONFIDENTIAL -->",
  ]) assert.equal(bannerSignals(`intro\n${b}\nbody`).length, 1, b);
  for (const p of ["## MNPI: what it is and how the fleet handles it", "MNPI never leaves the ring.", "INND MNPI rules for agents", "## Privileged and confidential handling rules for the CLO", "Material non-public information must never reach the commons room, per Reg FD and the CLO."]) {
    assert.equal(bannerSignals(p).length, 0, p);
  }
});

test("round 2 raw views: PHI in an HTML <script>, a banner in an HTML comment, and a JSON field refuse", () => {
  const html = `<html><head><title>Widget plan page</title></head><body><p>Widget planning notes for the quarter.</p><script>var pt={ssn:"SSN: 219-09-9999", dob:"DOB: 04/12/1961"};</script></body></html>`;
  const norm = normalizeInput({ ext: ".html", text: html });
  assert.equal(classifyRing({ text: norm.body }).allowed, true, "the normalized body alone hides it (the old gate)");
  const r = classifyRing({ text: norm.body, extraTexts: [htmlRawView(html)] });
  assert.equal(r.allowed, false);
  assert.ok(codes(r).includes("PHI_DATA"));
  const c = `<html><body><!-- PRIVILEGED & CONFIDENTIAL --><p>Widget planning notes for the quarter.</p></body></html>`;
  assert.ok(codes(classifyRing({ text: normalizeInput({ ext: ".html", text: c }).body, extraTexts: [htmlRawView(c)] })).includes("BANNER"));
  const j = { title: "Widget intake", patients: [{ ssn: "219-09-9999", name: "x" }] };
  assert.ok(codes(classifyRing({ text: normalizeInput({ ext: ".json", text: JSON.stringify(j) }).body, extraTexts: [jsonRawView(j)] })).includes("PHI_DATA"));
});

test("round 2 declarations: HTML <meta name=classification> and JSON top-level ring/classification keys are read", () => {
  assert.deepEqual(htmlDeclarations(`<head><meta name="classification" content="privileged"><meta name="description" content="x"></head>`), { classification: "privileged" });
  assert.deepEqual(jsonDeclarations({ title: "t", ring: "legal-personal", mnpi: true, other: "x" }), { ring: "legal-personal", mnpi: "true" });
  const n = normalizeInput({ ext: ".html", text: `<html><head><title>Widget plan page</title><meta name="classification" content="privileged"></head><body><p>Widget notes for the quarter.</p></body></html>` });
  assert.equal(classifyRing({ text: n.body, frontmatter: n.frontmatter }).allowed, false);
  const jn = normalizeInput({ ext: ".json", text: JSON.stringify({ title: "Widget plan json", ring: "legal-personal", notes: "widget planning" }) });
  const jr = classifyRing({ text: jn.body, frontmatter: jn.frontmatter });
  assert.equal(jr.allowed, false);
  assert.equal(jr.routes[0].ring, "legal-personal");
});

test("round 2 front matter: restricted values match by CONTAINS, and truthy PHI/MNPI/privilege flag keys declare the ring", () => {
  for (const [k, v, ring] of [["classification", "Attorney-Client Privileged", "legal"], ["confidentiality", "privileged and confidential", "legal"], ["contains_phi", "true", "phi"], ["phi", "yes", "phi"], ["privileged", "true", "legal"], ["mnpi", "yes - INND raise", "innd-mnpi"], ["classification", "HIPAA protected", "phi"], ["ring", "cfo-finance", "finance"]]) {
    const r = classifyRing({ text: "x", frontmatter: { [k]: v } });
    assert.equal(r.allowed, false, `${k}: ${v}`);
    assert.equal(r.routes[0].ring, ring, `${k}: ${v}`);
  }
  for (const [k, v] of [["classification", "public"], ["classification", "internal"], ["contains_phi", "false"], ["phi", "none"], ["mnpi", "no"], ["ring", "fleet"], ["confidentiality", "none"], ["ring", "non-phi"], ["classification", "PHI-free"], ["ring", "no-mnpi"]]) {
    assert.equal(declaredSignals({ [k]: v }).length, 0, `${k}: ${v}`);
  }
  // Round 4 (S3): the value keys are an allowlist; a non-listed value declares a restriction even without a restricted word.
  for (const [k, v] of [["classification", "philosophy notes"], ["ring", "commons-review"], ["confidentiality", "confidential"]]) {
    assert.equal(declaredSignals({ [k]: v }).length, 1, `${k}: ${v}`);
  }
});

test("round 2 paths: case, underscore and space variants of a denied segment refuse; so do --source repos and symlink targets", () => {
  for (const d of ["Legal-Personal", "LEGAL-PERSONAL", "legal_personal", "Legal Personal", "Clo-Personal", "_memory", "personal-legal", "CFO_Source_Docs"]) {
    assert.equal(classifyRing({ text: "harmless", localPath: `/tmp/x/${d}/notes.md` }).allowed, false, d);
  }
  assert.equal(classifyRing({ text: "x", localPath: "/docs/legal-personal-ring-design-notes.md" }).allowed, false, "round 3: legal entries match inside a segment (file names included)");
  const src = pathDenies({ source: "medreview@abc123:docs/notes.md" });
  assert.ok(src.some((d) => d.ring === "phi"), JSON.stringify(src));
  assert.ok(pathDenies({ source: "MedReview:docs/notes.md" }).some((d) => d.ring === "phi"), "repo:path form, any case");
  // Round 3: `medreview` is also a denied path SEGMENT (a URL naming it refuses), but the URL scheme is still
  // never parsed as a repo name.
  assert.ok(pathDenies({ source: "https://example.org/medreview:x" }).every((d) => !/source repo/.test(d.detail)), "a URL scheme is not a repo");
  assert.equal(pathDenies({ source: "https://example.org/docs:x" }).length, 0, "a URL scheme is not a repo");
  assert.ok(pathDenies({ localPath: "/tmp/link.md", realPath: "/home/user/x/_MEMORY/cfo.md" }).some((d) => d.ring === "ledger"), "the symlink-resolved path is gated too");
});

test("round 2 heuristics: bare-decimal ledgers and Xero-style JSON trial balances refuse; version strings are not amounts", () => {
  const rows = Array.from({ length: 60 }, (_, i) => `| 2026-08-${String((i % 28) + 1).padStart(2, "0")} | Vendor ${i} | ${(1234.56 + i * 17).toFixed(2)} |`).join("\n");
  const ledger = `# InnerScope general ledger export\n\nTrial balance, accounts payable and accounts receivable reconciliation for InnerScope.\n\n${rows}\n`;
  assert.ok(heuristicSignals(ledger).some((s) => s.code === "FINANCE_LEDGER"));
  assert.equal(countAmounts("builds v1.25, V2.10, 1.4.0, 10.25.1, 1.15.3, 2026.09.29 and gpt-4.1"), 0);
  assert.equal(countAmounts("paid 1234.56 and $99 and 1,234.56"), 3);
  assert.equal(countAmounts("hit@5 0.33, entropy 4.85 and 3.12, ratio 1.50"), 0, "one-digit metrics are not amounts");
  const xero = { title: "InnerScope Xero export", org: "InnerScope", ReportName: "Trial Balance", rows: Array.from({ length: 80 }, (_, i) => ({ AccountCode: 400 + i, Name: `Acct ${i}`, Debit: 1234 + i * 0.5, Credit: 0 })) };
  const fin = jsonFinanceSignals(xero);
  assert.ok(fin.amounts >= 20 && fin.terms.has("debit/credit columns") && fin.terms.has("chart of accounts"), JSON.stringify({ a: fin.amounts, t: [...fin.terms] }));
  const n = normalizeInput({ ext: ".json", text: JSON.stringify(xero) });
  const r = classifyRing({ text: n.body, extraTexts: [jsonRawView(xero)], jsonFinance: fin });
  assert.equal(r.allowed, false);
  assert.ok(codes(r).includes("FINANCE_LEDGER"));
});

test("round 2 override: the reason must name every overridden code and explain itself in 20+ characters", () => {
  const sec = "# INND raise notes\n\nINND Reg D private placement: cap table, subscription agreement, pre-money valuation and warrant coverage for InnerScope.\n";
  for (const bad of ["ok", "reviewed by counsel, public press release", "INND_SECURITIES: ok", "INND_SECURITIES"]) {
    const r = classifyRing({ text: sec, override: bad });
    assert.equal(r.allowed, false, bad);
    assert.equal(r.overrideRejected, true, bad);
    assert.match(formatRingRefusal(r).join("\n"), /--ring-override rejected/, bad);
  }
  const good = classifyRing({ text: sec, override: "INND_SECURITIES: wording copied from the public 8-K press release", overrideSeat: "capital" });
  assert.equal(good.allowed, true);
  assert.equal(checkOverrideReason("FINANCE_LEDGER: synthetic fixture data for tests", [{ code: "FINANCE_LEDGER" }, { code: "INND_SECURITIES" }]).ok, false, "every code must be named");
});
