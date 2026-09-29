// html-to-md.mjs -- dependency-free HTML -> readable Markdown for Artifact pages, review packets and
// mockups. PURE. The goal is SEARCHABLE PROSE, not a pixel-faithful conversion: scripts, styles, SVG,
// canvases, iframes, templates, comments, data: URIs and srcset are dropped entirely (the doc-indexer's
// own stripTags extractor keeps inline script/CSS text, which is why raw HTML must never be what gets
// indexed). Headings, lists, tables, code and absolute links survive in Markdown form.

const NAMED = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "-", ndash: "-", hellip: "...",
  rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', sbquo: "'", bdquo: '"', copy: "(c)", reg: "(R)",
  trade: "(TM)", middot: "*", bull: "*", times: "x", divide: "/", laquo: '"', raquo: '"', deg: " deg",
  rarr: "->", larr: "<-", harr: "<->", uarr: "^", darr: "v", check: "v", cross: "x", minus: "-",
  shy: "", zwj: "", zwnj: "", ensp: " ", emsp: " ", thinsp: " ", euro: "EUR", pound: "GBP", cent: "c",
  frac12: "1/2", frac14: "1/4", frac34: "3/4", plusmn: "+/-", le: "<=", ge: ">=", ne: "!=", hearts: "<3",
};

/** Decode named + numeric HTML entities. Unknown named entities are left as-is. */
export function decodeEntities(s) {
  return String(s || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, ent) => {
    if (ent[0] === "#") {
      const cp = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return m;
      if (cp === 0x2014 || cp === 0x2013) return "-";
      if (cp === 0xa0) return " ";
      try { return String.fromCodePoint(cp); } catch { return m; }
    }
    const v = NAMED[ent.toLowerCase()];
    return v === undefined ? m : v;
  });
}

const DROP_BLOCKS = ["script", "style", "noscript", "template", "svg", "canvas", "iframe", "object", "embed", "head"];
// Raw-text elements run to the end of the document when unclosed (a browser treats the rest as their
// text); the others (a sloppy page may omit </head>, <embed> is void) lose only their opening tag.
const RAW_TEXT_BLOCKS = new Set(["script", "style", "noscript", "template"]);
const BLOCK_TAGS = "p|div|section|article|header|footer|main|nav|aside|ul|ol|table|thead|tbody|tfoot|blockquote|figure|figcaption|form|fieldset|details|summary|dl|dt|dd|hr|address|caption";

// ---------------- linear-time primitives (adjudication round 3) ----------------
// Every `<t\b[\s\S]*?<\/t>` / `<[^>]*>` regex pass was QUADRATIC on crafted input: each opener with no
// closer rescanned to the end of the document (390 KB of "<!--" took 48 s; a normal 2 MB page takes
// ~100 ms). The passes below scan forward once: a closer search that fails from position p means no
// closer exists after ANY later opener, so the scan stops (or drops the rest) instead of retrying.

/** Remove every tag in ONE forward pass; a "<" with no ">" after it is literal text. `repl` replaces
 *  each tag (default ""). */
export function stripTagsLinear(s, repl = "") {
  const t = String(s || "");
  let out = "";
  let pos = 0;
  for (;;) {
    const i = t.indexOf("<", pos);
    if (i < 0) break;
    const j = t.indexOf(">", i + 1);
    if (j < 0) break; // no tag can close after here
    out += t.slice(pos, i) + repl;
    pos = j + 1;
  }
  return out + t.slice(pos);
}
function stripTags(s) { return stripTagsLinear(s); }
/** "<" characters after the document's LAST ">" can never start a tag: escape them once, so every
 *  `<x\b[^>]*>` regex below terminates at a real ">" (no failed rescans to the end). */
export function neutralizeUnclosedLt(s) {
  const t = String(s || "");
  const gt = t.lastIndexOf(">");
  return gt < t.length - 1 && t.indexOf("<", gt + 1) >= 0 ? t.slice(0, gt + 1) + t.slice(gt + 1).replace(/</g, "&lt;") : t;
}

/** Replace each `<name ...>inner</name>` (case-insensitive) left to right in one pass. `fn(inner, openTag)`
 *  gives the replacement. When an opener has no closer after it:
 *    "keep"   leave everything from that opener on unchanged (stripTags removes the stray tag later),
 *    "drop"   drop everything from that opener to the end (raw-text elements: script, style, comments),
 *    "opener" remove only that opening tag, and every later opener of this name (none can close either). */
function replacePaired(s, name, fn, unclosed = "keep") {
  const t = String(s || "");
  const openRe = new RegExp(`<${name}(?![A-Za-z0-9-])`, "gi");
  const closeRe = new RegExp(`<\\/${name}\\s*>`, "gi");
  let out = "";
  let pos = 0;
  let noCloser = false;
  for (;;) {
    openRe.lastIndex = pos;
    const m = openRe.exec(t);
    if (!m) break;
    const i = m.index;
    const gt = t.indexOf(">", i + 1);
    if (gt < 0) { if (unclosed === "drop") { out += t.slice(pos, i); pos = t.length; } break; }
    let c = null;
    if (!noCloser) { closeRe.lastIndex = gt + 1; c = closeRe.exec(t); if (!c) noCloser = true; }
    if (!c) {
      if (unclosed === "drop") { out += t.slice(pos, i); pos = t.length; break; }
      if (unclosed === "opener") { out += t.slice(pos, i) + " "; pos = gt + 1; continue; }
      break;
    }
    out += t.slice(pos, i) + fn(t.slice(gt + 1, c.index), t.slice(i, gt + 1));
    pos = c.index + c[0].length;
  }
  return out + t.slice(pos);
}

/** Remove `<!-- ... -->` comments in one pass; an unclosed comment runs to the end (as in a browser). */
function dropComments(s) {
  let out = "";
  let pos = 0;
  for (;;) {
    const i = s.indexOf("<!--", pos);
    if (i < 0) break;
    const j = s.indexOf("-->", i + 4);
    if (j < 0) { out += s.slice(pos, i) + " "; pos = s.length; break; }
    out += s.slice(pos, i) + " ";
    pos = j + 3;
  }
  return out + s.slice(pos);
}

/** Remove srcset="..." attributes in one pass (an unterminated quote leaves the rest untouched). */
function dropSrcset(s) {
  const re = /\bsrcset\s*=\s*(["'])/gi;
  let out = "";
  let pos = 0;
  for (;;) {
    re.lastIndex = pos;
    const m = re.exec(s);
    if (!m) break;
    const q = s.indexOf(m[1], m.index + m[0].length);
    if (q < 0) break;
    out += s.slice(pos, m.index);
    pos = q + 1;
  }
  return out + s.slice(pos);
}
function attr(tagSrc, name) {
  const m = tagSrc.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? (m[2] ?? m[3] ?? m[4] ?? "") : null;
}

/** Convert an HTML document to Markdown. Returns { markdown, title, description }. */
export function htmlToMarkdown(html) {
  let s = neutralizeUnclosedLt(String(html || ""));
  let title = "";
  replacePaired(s, "title", (inner) => { if (!title) title = decodeEntities(stripTags(inner)).replace(/\s+/g, " ").trim(); return ""; });
  let description = "";
  for (const m of s.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const nm = (attr(tag, "name") || attr(tag, "property") || "").toLowerCase();
    if (nm === "description" || nm === "og:description") { description = decodeEntities(attr(tag, "content") || "").replace(/\s+/g, " ").trim(); if (description) break; }
  }
  s = dropComments(s);
  s = s.replace(/<!doctype[^>]*>/gi, "");
  for (const t of DROP_BLOCKS) s = replacePaired(s, t, () => " ", RAW_TEXT_BLOCKS.has(t) ? "drop" : "opener");
  for (const t of DROP_BLOCKS) s = s.replace(new RegExp(`<${t}\\b[^>]*\\/?>`, "gi"), " "); // void / self-closing leftovers
  s = s.replace(/<img\b[^>]*>/gi, (tag) => { const alt = attr(tag, "alt"); return alt && !/^data:/i.test(alt) ? ` ${alt} ` : " "; });
  s = dropSrcset(s);
  s = s.replace(/data:[a-z]+\/[a-z0-9.+-]+(;[a-z0-9=.-]+)*,[A-Za-z0-9+/=%._-]+/gi, "");

  // Protect <pre> blocks: fenced, whitespace preserved.
  const pres = [];
  s = replacePaired(s, "pre", (inner) => {
    const code = decodeEntities(stripTags(inner.replace(/<br\s*\/?>/gi, "\n"))).replace(/^\n+|\s+$/g, "");
    pres.push("```\n" + code + "\n```");
    return `\n\n@@BSPRE${pres.length - 1}@@\n\n`;
  });
  s = replacePaired(s, "code", (inner) => {
    const t = decodeEntities(stripTags(inner)).replace(/\s+/g, " ").trim();
    return t ? "`" + t.replace(/`/g, "'") + "`" : "";
  });
  for (let n = 1; n <= 6; n++) {
    s = replacePaired(s, `h${n}`, (inner) => {
      const t = decodeEntities(stripTags(inner)).replace(/\s+/g, " ").trim();
      return t ? `\n\n${"#".repeat(n)} ${t}\n\n` : "\n\n";
    });
  }
  s = replacePaired(s, "a", (inner, openTag) => {
    const text = decodeEntities(stripTags(inner)).replace(/\s+/g, " ").trim();
    const href = decodeEntities(attr(openTag, "href") || "").trim();
    if (/^https?:\/\//i.test(href) && !/^data:/i.test(href)) {
      if (!text || text === href) return href;
      return `${text} (${href})`;
    }
    return text;
  });
  for (const t of ["strong", "b"]) s = replacePaired(s, t, (inner) => { const x = stripTags(inner).trim(); return x ? `**${x}**` : ""; });
  s = s.replace(/<li\b[^>]*>/gi, "\n- ").replace(/<\/li\s*>/gi, "");
  s = s.replace(/<tr\b[^>]*>/gi, "\n").replace(/<\/tr\s*>/gi, "\n");
  s = s.replace(/<\/t[dh]\s*>/gi, " | ").replace(/<t[dh]\b[^>]*>/gi, "");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(new RegExp(`<\\/?(${BLOCK_TAGS})\\b[^>]*>`, "gi"), "\n\n");
  s = stripTags(s);
  s = decodeEntities(s);

  const lines = s.split("\n").map((ln) => ln.replace(/[ \t\f\v ]+/g, " ").trim().replace(/\s*\|\s*$/, ""));
  let md = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  md = md.replace(/@@BSPRE(\d+)@@/g, (_, i) => pres[Number(i)] || "");
  if (description && !md.includes(description)) md = description + "\n\n" + md;
  return { markdown: md, title, description };
}
