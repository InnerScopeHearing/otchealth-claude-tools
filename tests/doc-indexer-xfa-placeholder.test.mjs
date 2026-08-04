// Regression gate for CLO brief §3 (task #53), the "mojibake/checkbox corruption" legal-correctness
// bug. Root-caused via company-brain against two concrete live paths (Broadridge NOBO Request Form,
// VStock NOBO Request Form -- both shareholder-election forms, so this is genuinely legal-correctness
// sensitive, not cosmetic). It is NOT an encoding/mojibake bug: this repo's installed poppler-utils
// already defaults `-enc` to UTF-8 (verified empirically -- a synthetic checkbox/curly-quote/em-dash
// PDF round-tripped byte-identical with and without an explicit `-enc UTF-8` flag), so an earlier
// "-enc UTF-8" fix lead was a dead end and is NOT what this test pins.
//
// The real bug: both documents are XFA (Adobe LiveCycle dynamic) forms. pdftotext's non-rendering
// content-stream extraction on an XFA-only PDF returns Adobe's standard "Please wait... if this
// message is not eventually replaced by the proper contents of the document" static placeholder
// instead of the actual (checkbox-bearing) form content -- the real data lives only in an embedded
// XFA XML stream pdftotext never reads. That placeholder is ~540 alnum characters, 18x the old
// `alnum(text) >= 30` "did we get real text" gate in indexer.mjs's extract(), so it was silently
// ACCEPTED as a successful pdftotext extraction and the DocIntel OCR fallback (which rasterizes the
// page and CAN read the visually-rendered form) never ran. A shareholder-election form indexed as if
// fully extracted while containing zero of its actual checkbox/selection data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isXfaPlaceholder } from "../skills/doc-indexer/indexer.mjs";

const REAL_ADOBE_PLACEHOLDER = `Please wait...

If this message is not eventually replaced by the proper contents of the document, your PDF viewer may not be able to display this type of document.

You can upgrade to the latest version of Adobe Reader for Windows, Mac, or Linux by visiting http://www.adobe.com/go/reader_download.

For more assistance with Adobe Reader visit http://www.adobe.com/go/acrreader.

Windows is either a registered trademark or a trademark of Microsoft Corporation in the United States and/or other countries. Mac is a trademark of Apple Inc., registered in the United States and other countries. Linux is the registered trademark of Linus Torvalds in the U.S. and other countries.`;

test("isXfaPlaceholder: detects the real Adobe XFA-form placeholder text (Broadridge/VStock NOBO shape)", () => {
  assert.equal(isXfaPlaceholder(REAL_ADOBE_PLACEHOLDER), true);
});

test("isXfaPlaceholder: regression pin -- the placeholder clears the OLD alnum>=30 gate by a wide margin (18x), proving the bug was real, not hypothetical", () => {
  const alnum = (s) => (s.match(/[a-z0-9]/gi) || []).length;
  assert.ok(alnum(REAL_ADOBE_PLACEHOLDER) >= 30 * 15, "placeholder must clear the old gate by a large margin for this to have been a real, reproducible bug");
});

test("isXfaPlaceholder: case-insensitive and tolerant of surrounding whitespace/prefix text", () => {
  assert.equal(isXfaPlaceholder("PLEASE WAIT...\n\nIF THIS MESSAGE IS NOT EVENTUALLY REPLACED BY THE PROPER CONTENTS OF THE DOCUMENT, your viewer is old."), true);
  assert.equal(isXfaPlaceholder("  \n  if this message is not eventually replaced by the proper contents of the document  \n  "), true);
});

test("isXfaPlaceholder: no false positive on ordinary, real legal-document prose (including prose that mentions 'document' or 'replaced')", () => {
  const realText = `SETTLEMENT AGREEMENT AND MUTUAL RELEASE

This Settlement Agreement is entered into by and between the parties. Any prior agreement is hereby replaced by the terms of this document. The undersigned parties agree to the following terms and conditions set forth herein, including but not limited to the release of all claims arising from the above-captioned matter.

[X] I elect to receive electronic delivery of proxy materials
[ ] I elect to receive paper delivery of proxy materials`;
  assert.equal(isXfaPlaceholder(realText), false);
});

test("isXfaPlaceholder: no false positive on empty or short text (the ordinary image-only/thin-text case)", () => {
  assert.equal(isXfaPlaceholder(""), false);
  assert.equal(isXfaPlaceholder("   "), false);
  assert.equal(isXfaPlaceholder("A"), false);
});
