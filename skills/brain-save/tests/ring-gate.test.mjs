import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { classifyRing, phiSignals, bannerSignals, heuristicSignals, luhnValid, ROUTES, formatRingRefusal } from "../lib/ring-gate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const codes = (r) => [...r.hard, ...r.heuristic].map((s) => s.code);

test("declared ring: --ring other than commons is a HARD refusal with the right route", () => {
  const r = classifyRing({ text: "plain", ringFlag: "finance" });
  assert.equal(r.allowed, false);
  assert.deepEqual(codes(r), ["RING_DECLARED"]);
  assert.equal(r.routes[0].route, ROUTES.finance);
  assert.match(formatRingRefusal(r).join("\n"), /cfo-store/);
});

test("declared ring via front matter (ring/confidentiality/classification/mnpi); commons/internal/false pass", () => {
  for (const [k, v] of [["ring", "finance"], ["confidentiality", "privileged"], ["classification", "PHI"], ["mnpi", "true"], ["ring", "legal-personal"]]) {
    assert.equal(classifyRing({ text: "x", frontmatter: { [k]: v } }).allowed, false, `${k}: ${v}`);
  }
  for (const [k, v] of [["ring", "commons"], ["classification", "internal"], ["mnpi", "false"], ["ring", "fleet"]]) {
    assert.equal(classifyRing({ text: "x", frontmatter: { [k]: v } }).allowed, true, `${k}: ${v}`);
  }
  assert.equal(classifyRing({ text: "x", frontmatter: { ring: "legal-personal" } }).routes[0].ring, "legal-personal");
  // Round 4 (S3): the value keys are an ALLOWlist now, so "commons-review" (not a ring the room can honor) refuses.
  assert.equal(classifyRing({ text: "x", frontmatter: { ring: "commons-review" } }).allowed, false);
});

test("every path deny in the reviewed denylist refuses (repo, segments, substrings, both Artifact ids)", () => {
  const cases = [
    { sourceRepo: "medreview", ring: "phi" },
    { source: "otchealthlegalstore/personal/matter.md", ring: "legal" },
    { localPath: "/data/legal-personal/x.md", ring: "legal-personal" },
    { localPath: "/data/clo-personal/x.md", ring: "legal-personal" },
    { source: "otchealthcfodata/cfo-source-docs/a.md", ring: "finance" },
    { localPath: "/Users/m/OneDrive/CFO Outgoing/tb.md", ring: "finance" },
    { localPath: "/x/CFO Processed/y.md", ring: "finance" },
    { localPath: "/x/CFO Incoming/y.md", ring: "finance" },
    { source: "commons:_MEMORY/_exec/cfo.jsonl", ring: "ledger" },
    { source: "_HANDOFF/cfo.md", ring: "ledger" },
    { source: "_DISPATCH/x.md", ring: "ledger" },
    { source: "_JOURNAL/cfo/2026/_DIGEST.md", ring: "ledger" },
    { source: "otchealth-cto@abc:projects/moore-playbook/p.md", ring: "innd-mnpi" },
    { artifactUrl: "https://claude.ai/artifact/7sK3KmDJmTLTrMik5ZGYoM", ring: "finance" },
    { artifactUrl: "https://claude.ai/code/artifact/Trx3aiGya2MkdiAHzau3eL?x=1", ring: "finance" },
  ];
  for (const c of cases) {
    const r = classifyRing({ text: "harmless", ...c });
    assert.equal(r.allowed, false, JSON.stringify(c));
    assert.ok(r.hard.some((s) => s.code === "PATH_DENY" && s.ring === c.ring), JSON.stringify(c) + " " + JSON.stringify(r.hard));
  }
  // Round 3: finance and legal entries match as a SUBSTRING of a segment (file names included), after
  // separators are removed, so `legal-personal.md`, `legalpersonal/` and this name all refuse (hard).
  assert.equal(classifyRing({ text: "x", localPath: "/docs/legal-personal-ring-design-notes.md" }).allowed, false, "round 3: legal entries match inside a segment");
  assert.equal(classifyRing({ text: "x", localPath: "/docs/memory/notes.md" }).allowed, true, "a ledger prefix (_MEMORY) never matches a plain memory/ folder");
});

test("banners: each closed-set full-line banner refuses; prose using the same words does not", () => {
  for (const b of ["PRIVILEGED AND CONFIDENTIAL", "**Privileged & Confidential - Attorney-Client Communication**", "ATTORNEY-CLIENT PRIVILEGED", "> Attorney Work Product", "CONTAINS PHI", "Contains Protected Health Information", "HIPAA-PROTECTED", "CONFIDENTIAL - CONTAINS MNPI", "Confidential: material nonpublic information"]) {
    assert.equal(bannerSignals(`intro\n${b}\nbody`).length, 1, b);
  }
  for (const p of ["Attorney-client privileged material never goes to commons.", "The CLO lane refuses privileged exports; MNPI never leaves the ring.", "PHI stays inside the BAA environment", "## Privileged and confidential handling rules for the CLO"]) {
    assert.equal(bannerSignals(p).length, 0, p);
  }
});

test("PHI data patterns: labeled SSN, 2+ unlabeled SSNs (with exclusions), DOB, MRN, MBI, Luhn card, bank account, routing", () => {
  assert.ok(phiSignals("SSN: 212-45-6789").length);
  assert.equal(phiSignals("SSN: 123-45-6789").length, 0, "123-45-6789 is excluded");
  assert.equal(phiSignals("SSN: 666-45-6789").length, 0, "area 666 excluded");
  assert.equal(phiSignals("SSN: 912-45-6789").length, 0, "9xx excluded");
  assert.equal(phiSignals("ref 212-45-6789").length, 0, "one unlabeled is not enough");
  assert.ok(phiSignals("ref 212-45-6789 and 301-22-1234").length);
  assert.ok(phiSignals("DOB: 04/12/1951").length);
  assert.ok(phiSignals("date of birth 1951-04-12").length);
  assert.ok(phiSignals("MRN: 00123456").length);
  assert.ok(phiSignals("Medicare MBI 1EG4-TE5-MK73").length);
  const card = "4539 1488 0343 6467";
  assert.ok(luhnValid(card));
  assert.ok(phiSignals(`card ${card}`).length);
  assert.equal(phiSignals("card 4242 4242 4242 4242").length, 0, "well-known test PANs are exempt");
  assert.equal(phiSignals("mtime_ms 1790650908415 and epoch 1727561234567").length, 0, "epoch ms timestamps are not cards (IIN check)");
  assert.ok(phiSignals("bank account number: 000123456789").length);
  assert.ok(phiSignals("routing number: 121000248").length);
  assert.equal(phiSignals("AWS account 900915535335 and build 1779565786").length, 0);
});

test("heuristics fire only at their co-occurrence thresholds, not one term below", () => {
  const amounts = (n) => Array.from({ length: n }, (_, i) => `$${1000 + i}.00`).join(" ");
  const ledger = (terms, n) => `InnerScope ${terms.join(" ")} ${amounts(n)}`;
  assert.ok(heuristicSignals(ledger(["general ledger", "trial balance", "reconciliation"], 20)).some((s) => s.code === "FINANCE_LEDGER"));
  assert.equal(heuristicSignals(ledger(["general ledger", "trial balance"], 20)).length, 0, "2 accounting terms is below threshold");
  assert.equal(heuristicSignals(ledger(["general ledger", "trial balance", "reconciliation"], 19)).length, 0, "19 amounts is below threshold");
  assert.equal(heuristicSignals(`general ledger trial balance reconciliation ${amounts(25)}`).length, 0, "no entity mention");
  const deal = (n, terms) => `${"INND ".repeat(n)} ${terms.join(", ")}`;
  assert.ok(heuristicSignals(deal(2, ["cap table", "term sheet", "Reg D"])).some((s) => s.code === "INND_SECURITIES"));
  assert.equal(heuristicSignals(deal(1, ["cap table", "term sheet", "Reg D"])).length, 0);
  assert.equal(heuristicSignals(deal(2, ["cap table", "term sheet"])).length, 0);
  assert.ok(heuristicSignals("x", { sourceRepo: "innd-website" }).some((s) => s.code === "INND_IR_SOURCE"));
});

test("--ring-override is accepted for heuristics only and rejected when any hard signal is present", () => {
  const text = `INND INND cap table, term sheet, Reg D`;
  assert.equal(classifyRing({ text }).allowed, false);
  // Round 3: an INND override is honored only from the clo / capital / exec SEAT.
  const ok = classifyRing({ text, override: "INND_SECURITIES: public press release wording, reviewed", overrideSeat: "clo" });
  assert.equal(ok.allowed, true);
  assert.equal(ok.overrideAccepted, true);
  const hard = classifyRing({ text: `${text}\nPRIVILEGED AND CONFIDENTIAL`, override: "trust me" });
  assert.equal(hard.allowed, false);
  assert.equal(hard.overrideRejected, true);
  assert.match(formatRingRefusal(hard).join("\n"), /never overridable/);
});

test("vocabulary in prose only WARNS: the fleet CLAUDE.md files are allowed with warnings, zero refusals", () => {
  const files = [join(HERE, "..", "..", "..", "CLAUDE.md"), join(HERE, "fixtures", "publishable-identifiers.md"), "/home/user/otchealth-cto/CLAUDE.md", "/home/user/otchealth-mcp-server/CLAUDE.md"].filter(existsSync);
  assert.ok(files.length >= 2);
  for (const f of files) {
    const r = classifyRing({ text: readFileSync(f, "utf8") });
    assert.equal(r.allowed, true, `${f}: ${JSON.stringify([...r.hard, ...r.heuristic])}`);
    assert.ok(r.warnings.length >= 1, f);
  }
});
