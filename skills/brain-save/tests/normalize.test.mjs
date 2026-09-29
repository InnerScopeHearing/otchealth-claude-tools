import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanText, parseFrontmatter, normalizeInput, resolveTitle, resolveDate, isGenericTitle, MAX_OBJECT_CHARS } from "../lib/normalize.mjs";
import { htmlToMarkdown, decodeEntities } from "../lib/html-to-md.mjs";

test("cleanText strips BOM, CRLF, control chars, collapses >2 blank lines, one trailing newline", () => {
  const out = cleanText("﻿a\r\nb\u0007c\n\n\n\n\n\nd   \n\n");
  assert.equal(out, "a\nbc\n\n\nd\n");
});

test("front matter is parsed (strings only) and re-emitted at the END of the body", () => {
  const md = '---\ntitle: "Quoted: title"\ndate: 2026-09-20\nring: commons\nlist: [a, b]\n---\n# H1 here\n\nbody text\n';
  const { frontmatter } = parseFrontmatter(md);
  assert.deepEqual(frontmatter, { title: "Quoted: title", date: "2026-09-20", ring: "commons" });
  const n = normalizeInput({ ext: ".md", text: md });
  assert.ok(n.body.startsWith("# H1 here"), "our header must stay first, so the original block moves to the end");
  assert.match(n.body, /## Original front matter\n\n```yaml\ntitle: "Quoted: title"/);
  assert.equal(n.h1, "H1 here");
});

test("title precedence: flag > front matter > H1 > <title> > filename", () => {
  const base = { frontmatter: { title: "FM" }, h1: "H1", htmlTitle: "HT", file: "/x/02-some_file-name.md" };
  assert.equal(resolveTitle({ ...base, flag: "Flag" }), "Flag");
  assert.equal(resolveTitle(base), "FM");
  assert.equal(resolveTitle({ ...base, frontmatter: {} }), "H1");
  assert.equal(resolveTitle({ ...base, frontmatter: {}, h1: "" }), "HT");
  assert.equal(resolveTitle({ file: "/x/02-some_file-name.md" }), "Some File Name");
});

test("date precedence: flag > front matter date/captured_at > today; a bad --date is exit 1", () => {
  const now = new Date("2026-09-29T12:00:00Z");
  assert.equal(resolveDate({ flag: "2026-01-02", frontmatter: { date: "2025-05-05" }, now }), "2026-01-02");
  assert.equal(resolveDate({ frontmatter: { date: "2025-05-05" }, now }), "2025-05-05");
  assert.equal(resolveDate({ frontmatter: { captured_at: "2025-06-06T01:02:03Z" }, now }), "2025-06-06");
  assert.equal(resolveDate({ frontmatter: {}, now }), "2026-09-29");
  assert.throws(() => resolveDate({ flag: "2026-13-40", now }), (e) => e.exit === 1);
});

test("generic titles are rejected; specific short titles pass", () => {
  for (const t of ["README", "index", "Notes", "untitled", "Plan", "design", ""]) assert.equal(isGenericTitle(t, { app: "fleet", kind: "doc" }), true, t);
  assert.equal(isGenericTitle("Hey Millie visual craft research", { app: "hey-millie", kind: "research" }), false);
  assert.equal(isGenericTitle("Mark packet", { app: "iheartest", kind: "packet" }), false);
  assert.equal(isGenericTitle("Random words", { app: "fleet", kind: "doc" }), true);
});

test("json: fenced pretty output; invalid JSON is exit 1", () => {
  const n = normalizeInput({ ext: ".json", text: '{"title":"Manifest of things","a":[1,2]}' });
  assert.match(n.body, /^```json\n\{\n  "title": "Manifest of things",/);
  assert.equal(n.frontmatter.title, "Manifest of things");
  assert.throws(() => normalizeInput({ ext: ".json", text: "{nope" }), (e) => e.exit === 1);
});

test("unsupported extension is exit 1; MAX_OBJECT_CHARS matches the indexer's MAXTEXT", () => {
  assert.throws(() => normalizeInput({ ext: ".pdf", text: "x" }), (e) => e.exit === 1);
  assert.equal(MAX_OBJECT_CHARS, 400000);
});

test("html-to-md: headings, lists, tables, code, absolute links; drops script/style/svg/comments/data URIs", () => {
  const html = `<!doctype html><html><head><title>Page Title</title><meta name="description" content="A lead &amp; summary."><style>:root{--x:1}</style><script>var secret=1;</script></head>
  <body><!-- hidden comment --><h1>Main &mdash; Heading</h1><p>Hello&nbsp;<b>world</b> &#39;q&#39; &#x2019;</p>
  <svg><text>SVGTEXT</text></svg><noscript>NOSCRIPT</noscript><template>TPL</template><iframe>IFR</iframe>
  <img src="data:image/png;base64,AAAA" alt="Alt text"><img srcset="a.png 1x" src="b.png">
  <ul><li>One</li><li>Two <a href="https://example.org/x">link</a> and <a href="/rel">rel</a></li></ul>
  <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
  <pre><code>line1
    line2 &lt;tag&gt;</code></pre><p>Inline <code>x = 1</code></p><canvas>CANVAS</canvas></body></html>`;
  const { markdown, title, description } = htmlToMarkdown(html);
  assert.equal(title, "Page Title");
  assert.equal(description, "A lead & summary.");
  assert.ok(markdown.startsWith("A lead & summary."), "meta description becomes the lead paragraph");
  assert.match(markdown, /^# Main - Heading$/m);
  assert.match(markdown, /Hello \*\*world\*\* 'q' \u2019/);
  assert.match(markdown, /^- One$/m);
  assert.match(markdown, /link \(https:\/\/example\.org\/x\) and rel/);
  assert.match(markdown, /^A \| B$/m);
  assert.match(markdown, /^1 \| 2$/m);
  assert.match(markdown, /```\nline1\n    line2 <tag>\n```/);
  assert.match(markdown, /Inline `x = 1`/);
  assert.match(markdown, /Alt text/);
  for (const bad of ["secret=1", "--x", "SVGTEXT", "NOSCRIPT", "TPL", "IFR", "CANVAS", "hidden comment", "data:image", "base64", "srcset", "a.png"]) assert.ok(!markdown.includes(bad), `leaked: ${bad}`);
});

test("html-to-md: a realistic Artifact page (tokens in :root, inline script) yields prose only", () => {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>AWARE Pro gate design</title>
<style>:root{--bg:#fff;--fg:#111}@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#000}}body{background:var(--bg)}</style></head>
<body><main><section><h2>Decision</h2><p>Sampler plus Week 1 free, Weeks 2 to 6 Pro.</p></section></main>
<script>document.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{}));</script></body></html>`;
  const n = normalizeInput({ ext: ".html", text: html });
  assert.equal(n.htmlTitle, "AWARE Pro gate design");
  // Round 3: the <title> differs from every heading, so it is kept searchable as a trailing line.
  assert.match(n.body, /## Decision\n\nSampler plus Week 1 free, Weeks 2 to 6 Pro\.\n\nPage title: AWARE Pro gate design\n$/);
  assert.ok(!/prefers-color-scheme|querySelectorAll|--bg/.test(n.body));
});

test("decodeEntities handles named, decimal and hex entities and leaves unknown ones", () => {
  assert.equal(decodeEntities("&amp;&lt;&gt;&quot;&#65;&#x42;&unknownent;"), "&<>\"AB&unknownent;");
});
