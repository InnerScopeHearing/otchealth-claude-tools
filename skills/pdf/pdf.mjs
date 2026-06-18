#!/usr/bin/env node
// pdf.mjs — fleet PDF toolkit. High-grade OCR (read / review PDFs, including
// scanned ones) + PDF creation (make polished PDFs from Markdown or HTML).
// Shared by every agent. Non-PHI tooling; do not feed PHI PDFs through the
// cloud-vision OCR path (use the local tesseract engine for any PHI document).
//
// ENGINES (auto-detected, lazy-installed on first use):
//   - text extraction:  pdftotext       (poppler-utils)
//   - PDF -> image:      pdftoppm        (poppler-utils)
//   - HIGH-GRADE OCR:    a vision LLM    (OpenAI gpt-4o by default; Azure OpenAI
//                        vision deployment as a fallback) -> excellent on tables,
//                        multi-column, handwriting, low quality scans.
//   - LOCAL OCR fallback: tesseract      (free, offline, no API; use for PHI)
//   - PDF creation:      weasyprint      (HTML/CSS -> PDF, high fidelity) with a
//                        Markdown -> HTML step; Chromium headless as a fallback.
//
// Credentials (optional, hydrated by setup/fetch-secrets.mjs):
//   OPENAI_API_KEY                         -> OpenAI vision OCR (primary)
//   AZURE_OPENAI_API_KEY + _ENDPOINT       -> Azure OpenAI vision OCR (fallback)
//   AZURE_OPENAI_VISION_DEPLOYMENT         -> the vision-capable deployment name
//   PDF_OCR_MODEL (default gpt-4o)         -> override the OpenAI vision model
//
// Security: every external tool is invoked via execFileSync with an argument
// array (NO shell), so file names cannot inject shell commands. The only shell
// strings are the static, input-free dependency installers.
//
// Usage:
//   node pdf.mjs read   <file.pdf> [--pages A-B] [--ocr] [--out FILE]   # extract text (auto-OCRs scanned pages)
//   node pdf.mjs ocr    <file.pdf|img> [--pages A-B] [--engine vision|tesseract] [--out FILE]
//   node pdf.mjs create <input.md|.html> <out.pdf> [--title "T"] [--css FILE]  # make a PDF
//   node pdf.mjs images <file.pdf> [outDir] [--dpi 200]                 # render pages to PNGs
//   node pdf.mjs info   <file.pdf>                                      # pages, metadata, scanned?

import { execFileSync, execSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, extname, resolve, dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
function fail(m){ console.error("[pdf] ERROR: " + m); process.exit(1); }
function have(cmd){ return spawnSync("sh", ["-c", `command -v "$1"`, "sh", cmd], { stdio: "ignore" }).status === 0; }
// run an external tool with an argument ARRAY (no shell). Returns stdout string.
function ex(cmd, args, opts = {}){ return execFileSync(cmd, args, { maxBuffer: 1 << 28, ...opts }).toString(); }
function exOk(cmd, args, opts = {}){ try { execFileSync(cmd, args, { stdio: "ignore", maxBuffer: 1 << 28, ...opts }); return true; } catch { return false; } }
// static, input-free shell command (installers only)
function shQuiet(s){ try { execSync(s, { stdio: "ignore", maxBuffer: 1 << 28 }); return true; } catch { return false; } }

// ---- lazy dependency install (static commands, no user input) ---------------
function apt(pkgs){
  console.error(`[pdf] installing ${pkgs} ...`);
  shQuiet(`apt-get update -qq >/dev/null 2>&1`);
  return shQuiet(`DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${pkgs} >/dev/null 2>&1`)
      || shQuiet(`sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${pkgs} >/dev/null 2>&1`);
}
function ensurePoppler(){
  if (!have("pdftotext") || !have("pdftoppm")) apt("poppler-utils");
  if (!have("pdftotext")) fail("poppler-utils (pdftotext/pdftoppm) is required and could not be installed. Install poppler-utils.");
}
function ensureTesseract(){
  if (!have("tesseract")) apt("tesseract-ocr");
  return have("tesseract");
}
function ensureWeasy(){
  if (have("weasyprint")) return true;
  console.error("[pdf] installing weasyprint ...");
  shQuiet(`pip install --break-system-packages -q weasyprint >/dev/null 2>&1`)
    || shQuiet(`pip3 install --break-system-packages -q weasyprint >/dev/null 2>&1`)
    || shQuiet(`python3 -m pip install --break-system-packages -q weasyprint >/dev/null 2>&1`);
  return have("weasyprint");
}
function loadMarked(){
  const req = createRequire(import.meta.url);
  try { return req("marked"); }
  catch {
    console.error("[pdf] installing marked (markdown -> html) ...");
    exOk("npm", ["install", "--no-audit", "--no-fund", "--silent", "marked"], { cwd: HERE });
    try { return req("marked"); } catch { return null; }
  }
}

// ---- helpers ----------------------------------------------------------------
function pageCount(pdf){
  if (!have("pdfinfo")) ensurePoppler();
  try { const m = ex("pdfinfo", [pdf]).match(/Pages:\s+(\d+)/); return m ? parseInt(m[1], 10) : 0; }
  catch { return 0; }
}
function parsePages(spec, total){
  if (!spec) return null; // null = all
  const out = new Set();
  for (const part of String(spec).split(",")){
    const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m){ for (let i = +m[1]; i <= +m[2]; i++) out.add(i); }
    else if (/^\d+$/.test(part.trim())) out.add(parseInt(part, 10));
  }
  return [...out].filter(p => p >= 1 && (!total || p <= total)).sort((a, b) => a - b);
}
function textOfPage(pdf, p){
  try { return ex("pdftotext", ["-f", String(p), "-l", String(p), "-layout", pdf, "-"], { stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return ""; }
}
function renderPage(pdf, p, dpi, dir){
  const prefix = join(dir, "pg");
  exOk("pdftoppm", ["-png", "-r", String(dpi), "-f", String(p), "-l", String(p), pdf, prefix]);
  const f = readdirSync(dir).filter(n => n.startsWith("pg") && n.endsWith(".png")).sort();
  return f.length ? join(dir, f[f.length - 1]) : null;
}

// ---- OCR engines ------------------------------------------------------------
const OCR_PROMPT = "You are a high-accuracy OCR engine. Transcribe ALL text in this document image exactly as written. Preserve reading order and structure as clean GitHub-flavored Markdown (use headings, lists, and Markdown tables where the layout calls for it). Do not summarize, translate, omit, or add any commentary. If a region is illegible, write [illegible]. Output only the transcription.";

async function visionOCRImage(pngPath){
  const dataUrl = `data:image/png;base64,${readFileSync(pngPath).toString("base64")}`;
  if (process.env.OPENAI_API_KEY){
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.PDF_OCR_MODEL || "gpt-4o",
        temperature: 0, max_tokens: 4096,
        messages: [{ role: "user", content: [{ type: "text", text: OCR_PROMPT }, { type: "image_url", image_url: { url: dataUrl, detail: "high" } }] }],
      }),
    });
    const j = await r.json();
    if (j.choices?.[0]?.message?.content != null) return j.choices[0].message.content;
    console.error("[pdf] OpenAI vision error: " + JSON.stringify(j.error || j).slice(0, 200));
  }
  if (process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_VISION_DEPLOYMENT){
    const ver = process.env.AZURE_OPENAI_API_VERSION || "2024-08-01-preview";
    const url = `${process.env.AZURE_OPENAI_ENDPOINT.replace(/\/$/, "")}/openai/deployments/${process.env.AZURE_OPENAI_VISION_DEPLOYMENT}/chat/completions?api-version=${ver}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "api-key": process.env.AZURE_OPENAI_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ temperature: 0, max_tokens: 4096, messages: [{ role: "user", content: [{ type: "text", text: OCR_PROMPT }, { type: "image_url", image_url: { url: dataUrl, detail: "high" } }] }] }),
    });
    const j = await r.json();
    if (j.choices?.[0]?.message?.content != null) return j.choices[0].message.content;
    console.error("[pdf] Azure OpenAI vision error: " + JSON.stringify(j.error || j).slice(0, 200));
  }
  return null; // signal caller to fall back
}
function tesseractOCRImage(pngPath){
  if (!ensureTesseract()) fail("no OCR engine available: set OPENAI_API_KEY (or Azure OpenAI vision) for high-grade OCR, or install tesseract-ocr.");
  try { return ex("tesseract", [pngPath, "stdout"], { stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return ""; }
}

// ---- markdown / html -> pdf -------------------------------------------------
const DEFAULT_CSS = `
@page { size: Letter; margin: 1in; }
body { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; font-size: 11pt; line-height: 1.5; color: #1a1a1a; }
h1,h2,h3,h4 { font-weight: 600; line-height: 1.25; margin: 1.2em 0 0.5em; }
h1 { font-size: 22pt; border-bottom: 2px solid #ddd; padding-bottom: .2em; }
h2 { font-size: 16pt; } h3 { font-size: 13pt; }
p { margin: 0.5em 0; }
code { font-family: "SFMono-Regular", Consolas, monospace; background: #f3f3f3; padding: .1em .3em; border-radius: 3px; font-size: 90%; }
pre { background: #f6f8fa; padding: 12px; border-radius: 6px; overflow-x: auto; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; margin: 1em 0; }
th,td { border: 1px solid #ccc; padding: 6px 10px; text-align: left; }
th { background: #f3f3f3; }
blockquote { border-left: 4px solid #ddd; margin: 1em 0; padding-left: 1em; color: #555; }
img { max-width: 100%; }
a { color: #0b66c3; }
`;
function mdToHtml(md){
  const marked = loadMarked();
  if (marked && (marked.parse || marked.marked)) return (marked.parse || marked.marked)(md);
  return md
    .replace(/^### (.*)$/gm, "<h3>$1</h3>").replace(/^## (.*)$/gm, "<h2>$1</h2>").replace(/^# (.*)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .split(/\n{2,}/).map(b => /^<h\d/.test(b) ? b : `<p>${b.replace(/\n/g, "<br>")}</p>`).join("\n");
}
function wrapHtml(body, title, css){
  const style = css && existsSync(css) ? readFileSync(css, "utf8") : DEFAULT_CSS;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title || ""}</title><style>${style}</style></head><body>${body}</body></html>`;
}
function htmlToPdf(html, out){
  const tmp = mkdtempSync(join(tmpdir(), "pdfmk-"));
  const htmlPath = join(tmp, "doc.html");
  writeFileSync(htmlPath, html);
  try {
    if (ensureWeasy()){ exOk("weasyprint", [htmlPath, resolve(out)]); return "weasyprint"; }
    for (const c of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]){
      if (have(c)){ exOk(c, ["--headless", "--no-sandbox", "--disable-gpu", `--print-to-pdf=${resolve(out)}`, "file://" + htmlPath]); return c; }
    }
    fail("no PDF engine available: could not install weasyprint and no Chromium found. Install weasyprint (pip) or chromium.");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// ---- arg parsing ------------------------------------------------------------
const argv = process.argv.slice(2);
const cmd = argv[0];
function flag(name){ const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; }
function bool(name){ return argv.includes(`--${name}`); }
const positionals = argv.slice(1).filter((a, i, arr) => !a.startsWith("--") && !(i > 0 && arr[i - 1]?.startsWith("--")));

async function main(){
  if (cmd === "read" || cmd === "ocr"){
    const pdf = positionals[0];
    if (!pdf || !existsSync(pdf)) fail(`file not found: ${pdf}`);
    const isImage = /\.(png|jpe?g|webp|tiff?)$/i.test(pdf);
    const forceOcr = cmd === "ocr" || bool("ocr");
    const engine = flag("engine") || "vision";
    ensurePoppler();

    if (isImage){
      const text = engine === "tesseract" ? tesseractOCRImage(pdf) : (await visionOCRImage(pdf)) ?? tesseractOCRImage(pdf);
      return output(text, flag("out"));
    }

    const total = pageCount(pdf);
    const pages = parsePages(flag("pages"), total) || Array.from({ length: total || 1 }, (_, i) => i + 1);
    const tmp = mkdtempSync(join(tmpdir(), "pdfocr-"));
    const out = [];
    try {
      for (const p of pages){
        const native = textOfPage(pdf, p).trim();
        const scanned = native.replace(/\s/g, "").length < 20;
        let text;
        if (!forceOcr && !scanned){ text = native; }
        else {
          const png = renderPage(pdf, p, parseInt(flag("dpi") || "200", 10), tmp);
          if (!png){ text = native; }
          else if (engine === "tesseract"){ text = tesseractOCRImage(png); }
          else { text = (await visionOCRImage(png)) ?? tesseractOCRImage(png); }
          for (const f of readdirSync(tmp)) rmSync(join(tmp, f), { force: true });
        }
        out.push(pages.length > 1 ? `\n<!-- page ${p} -->\n${text.trim()}` : text.trim());
      }
    } finally { rmSync(tmp, { recursive: true, force: true }); }
    console.error(`[pdf] ${cmd}: ${pages.length} page(s)${forceOcr ? " (OCR " + engine + ")" : ""}`);
    return output(out.join("\n").trim() + "\n", flag("out"));
  }

  if (cmd === "create"){
    const input = positionals[0], out = positionals[1];
    if (!input || !existsSync(input)) fail(`input not found: ${input}`);
    if (!out) fail("usage: pdf.mjs create <input.md|.html> <out.pdf> [--title T] [--css FILE]");
    const ext = extname(input).toLowerCase();
    const raw = readFileSync(input, "utf8");
    let html;
    if (ext === ".html" || ext === ".htm"){ html = /<html[\s>]/i.test(raw) ? raw : wrapHtml(raw, flag("title"), flag("css")); }
    else { html = wrapHtml(mdToHtml(raw), flag("title") || basename(input, ext), flag("css")); }
    const engine = htmlToPdf(html, out);
    console.error(`[pdf] created ${out} via ${engine}`);
    return;
  }

  if (cmd === "images"){
    const pdf = positionals[0];
    if (!pdf || !existsSync(pdf)) fail(`file not found: ${pdf}`);
    ensurePoppler();
    const dir = positionals[1] || `${basename(pdf, extname(pdf))}-pages`;
    mkdirSync(dir, { recursive: true });
    exOk("pdftoppm", ["-png", "-r", String(parseInt(flag("dpi") || "200", 10)), pdf, join(dir, "page")]);
    const n = readdirSync(dir).filter(f => f.endsWith(".png")).length;
    console.log(`rendered ${n} page(s) -> ${dir}/`);
    return;
  }

  if (cmd === "info"){
    const pdf = positionals[0];
    if (!pdf || !existsSync(pdf)) fail(`file not found: ${pdf}`);
    ensurePoppler();
    const total = pageCount(pdf);
    let textChars = 0;
    for (let p = 1; p <= Math.min(total, 5); p++) textChars += textOfPage(pdf, p).replace(/\s/g, "").length;
    console.log(`pages: ${total}`);
    console.log(`has text layer: ${textChars < 40 ? "NO (scanned -> `read`/`ocr` will OCR it automatically)" : "yes"}`);
    try { console.log(ex("pdfinfo", [pdf]).trim()); } catch {}
    return;
  }

  console.error("commands: read <pdf> | ocr <pdf|img> | create <in.md|.html> <out.pdf> | images <pdf> [dir] | info <pdf>");
  process.exit(2);
}
function output(text, outFile){
  if (outFile){ writeFileSync(outFile, text); console.error(`[pdf] wrote ${text.length} chars -> ${outFile}`); }
  else process.stdout.write(text);
}
main().catch(e => fail(e.message));
