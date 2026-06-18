---
name: pdf
description: The fleet PDF toolkit for every agent. Two jobs - (1) READ/REVIEW any PDF with high-grade OCR, including scanned or photographed documents, statements, contracts, and forms (a vision LLM does the OCR for table/multi-column/handwriting accuracy, with a local tesseract fallback for offline or PHI documents); (2) CREATE polished PDFs from Markdown or HTML (reports, memos, letters, statements). Use this whenever you need to extract text from a PDF you cannot read, or produce a PDF document. Auto-installs its own tools (poppler, weasyprint, tesseract). Non-PHI cloud OCR by default; use the tesseract engine for any PHI document.
---

# pdf - read (OCR) and create PDFs

A shared skill so any agent can reliably get text OUT of a PDF (even a scanned image
of one) and put a document INTO a PDF. It replaces the ad hoc, often-failing attempts
agents make at PDF work.

## When to use it
- An agent has a PDF it needs to read but the text will not copy, or it is a scan/photo.
- You need to review a statement, contract, invoice, or form and act on its contents.
- You need to PRODUCE a PDF (a report, memo, letter, summary) from Markdown or HTML.

## Commands
```
node skills/pdf/pdf.mjs read   <file.pdf> [--pages 1-3] [--ocr] [--out out.md]
node skills/pdf/pdf.mjs ocr    <file.pdf|image> [--pages 1-3] [--engine vision|tesseract] [--out out.md]
node skills/pdf/pdf.mjs create <input.md|.html> <out.pdf> [--title "Title"] [--css style.css]
node skills/pdf/pdf.mjs images <file.pdf> [outDir] [--dpi 200]
node skills/pdf/pdf.mjs info   <file.pdf>
```

- **read** - extracts text as Markdown. It uses the PDF's own text layer when present
  (fast, exact) and AUTOMATICALLY OCRs any page that is scanned/has no text. Add `--ocr`
  to force OCR on every page. Prints to stdout, or `--out` to a file.
- **ocr** - forces high-grade OCR on a PDF or an image (png/jpg/tiff). Default engine is
  the vision LLM; `--engine tesseract` runs the local, offline engine.
- **create** - turns a Markdown or HTML file into a clean, professionally styled PDF.
  Pass `--css` for custom styling; otherwise a readable default is applied.
- **images** - renders pages to PNGs (useful for visual review or feeding elsewhere).
- **info** - page count, metadata, and whether the PDF is scanned (no text layer).

## OCR quality + engines
High-grade OCR uses a vision LLM (OpenAI `gpt-4o` by default, or an Azure OpenAI vision
deployment) which handles tables, multi-column layouts, poor scans, and handwriting far
better than classic OCR. If no vision key is available it falls back to **tesseract**
(local, free, offline). Credentials are read from the environment
(`OPENAI_API_KEY`, or `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_ENDPOINT` +
`AZURE_OPENAI_VISION_DEPLOYMENT`); both hydrate automatically in a normal session.
Override the OpenAI model with `PDF_OCR_MODEL`.

## PHI / compliance
The default OCR path sends page images to a cloud vision model. For any PHI document
(MedReview, anything with patient data), pass `--engine tesseract` so OCR stays local and
no PHI leaves the machine. The cloud path is for non-PHI documents only.

## Dependencies (auto-installed on first run)
- `poppler-utils` (pdftotext, pdftoppm, pdfinfo) - text extraction + page rendering.
- `weasyprint` (pip) - HTML/CSS to PDF; Chromium headless is the fallback.
- `tesseract-ocr` - local OCR fallback.
- `marked` (npm, in this skill dir) - Markdown to HTML for `create`.
The script installs what is missing on first use (apt + pip + npm), so the first call may
take a minute; later calls are fast.

## Examples
```
# review a scanned bank statement
node skills/pdf/pdf.mjs read statement.pdf --out statement.md

# OCR just pages 2-4 of a contract, locally (no cloud), for a PHI doc
node skills/pdf/pdf.mjs ocr contract.pdf --pages 2-4 --engine tesseract --out contract.md

# build a PDF report from a Markdown file
node skills/pdf/pdf.mjs create monthly-report.md monthly-report.pdf --title "Monthly Report"
```
