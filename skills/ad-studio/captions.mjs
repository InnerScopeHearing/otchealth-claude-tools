// captions.mjs -- caption timing from TTS character alignment, and ASS subtitle generation (libass burns it in).
// Senior-readable: large bold type, white on a heavy semi-opaque black box, placed above the platform UI zone.

/** Map each whitespace-separated word of `text` to {word,start,end} seconds using the per-character alignment.
 *  If the alignment does not line up with the text (normalization changed it), fall back to an even spread
 *  proportional to word length across `durationSec`. */
export function wordTimings(text, alignment, durationSec) {
  const words = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text))) words.push({ word: m[0], index: m.index });
  if (!words.length) return [];
  const chars = alignment?.characters;
  const st = alignment?.character_start_times_seconds;
  const en = alignment?.character_end_times_seconds;
  if (chars && st && en && chars.join('') === text) {
    return words.map((w) => ({
      word: w.word,
      start: st[w.index],
      end: en[Math.min(w.index + w.word.length - 1, en.length - 1)],
    }));
  }
  const total = words.reduce((a, w) => a + w.word.length + 1, 0);
  let t = 0;
  return words.map((w) => {
    const share = ((w.word.length + 1) / total) * durationSec;
    const out = { word: w.word, start: t, end: t + share };
    t += share;
    return out;
  });
}

/** Group words into caption cards: <= maxWords and <= maxChars per card, splitting after sentence punctuation. */
export function chunkWords(words, { maxWords = 4, maxChars = 24 } = {}) {
  const chunks = [];
  let cur = [];
  const flush = () => { if (cur.length) { chunks.push({ text: cur.map((w) => w.word).join(' '), start: cur[0].start, end: cur[cur.length - 1].end }); cur = []; } };
  for (const w of words) {
    const nextLen = cur.map((x) => x.word).join(' ').length + 1 + w.word.length;
    if (cur.length && (cur.length >= maxWords || nextLen > maxChars)) flush();
    cur.push(w);
    if (/[.!?]$/.test(w.word)) flush();
  }
  flush();
  // Never leave a card blank on screen for less than 0.45 s; extend into the gap that follows.
  for (let i = 0; i < chunks.length; i++) {
    const next = chunks[i + 1];
    chunks[i].end = Math.max(chunks[i].end + 0.12, chunks[i].start + 0.45);
    if (next && chunks[i].end > next.start) chunks[i].end = next.start;
  }
  return chunks;
}

// ---------- ASS ---------------------------------------------------------------------------------

export function assTime(sec) {
  const s = Math.max(0, sec);
  const cs = Math.round(s * 100);
  const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), ss = Math.floor((cs % 6000) / 100), c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}
export function assColor(hex, alpha = 0) {
  const h = String(hex).replace('#', '').padStart(6, '0');
  const r = h.slice(0, 2), g = h.slice(2, 4), b = h.slice(4, 6);
  return `&H${alpha.toString(16).toUpperCase().padStart(2, '0')}${b}${g}${r}`.toUpperCase();
}
export function assEscape(t) {
  return String(t).replace(/\\/g, '\\\\').replace(/\{/g, '(').replace(/\}/g, ')').replace(/\r?\n/g, '\\N');
}

/**
 * @param {object} o {width,height, captions:[{start,end,text}], overlays:[{start,end,text}], endCard:{start,end,headline,cta,legal,bg,fg}|null,
 *                    label:{text,start,end}|null, font}
 */
export function buildAss({ width, height, captions = [], overlays = [], endCard = null, label = null, font = 'DejaVu Sans' }) {
  const min = Math.min(width, height);
  const portrait = height > width;
  const capSize = Math.round(min * 0.085);
  const capMarginV = Math.round(height * (portrait ? 0.2 : 0.08));
  const titleSize = Math.round(min * 0.07);
  const titleMarginV = Math.round(height * (portrait ? 0.11 : 0.07));
  const sideMargin = Math.round(width * 0.06);
  const fg = endCard?.fg || '#FFFFFF';
  const accent = endCard?.accent || '#0D9488';
  const lines = [];
  lines.push('[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${width}`, `PlayResY: ${height}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '');
  lines.push('[V4+ Styles]', 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding');
  const style = (name, size, prim, box, align, mv, outline) => `Style: ${name},${font},${size},${prim},&H000000FF,${box},&H00000000,-1,0,0,0,100,100,0,0,3,${outline},0,${align},${sideMargin},${sideMargin},${mv},1`;
  lines.push(style('Caption', capSize, '&H00FFFFFF', '&HB8000000', 2, capMarginV, Math.round(capSize * 0.22)));
  lines.push(style('Title', titleSize, '&H00FFFFFF', '&HB8000000', 8, titleMarginV, Math.round(titleSize * 0.2)));
  lines.push(style('Label', Math.round(min * 0.034), '&H00FFFFFF', '&HA0000000', 7, Math.round(min * 0.03), Math.round(min * 0.01)));
  lines.push(`Style: EndHead,${font},${Math.round(min * 0.1)},${assColor(fg)},&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,5,${sideMargin},${sideMargin},0,1`);
  lines.push(`Style: EndCta,${font},${Math.round(min * 0.07)},${assColor(fg)},&H000000FF,${assColor(accent)},&H00000000,-1,0,0,0,100,100,0,0,3,${Math.round(min * 0.02)},0,5,${sideMargin},${sideMargin},0,1`);
  lines.push(`Style: EndLegal,${font},${Math.round(min * 0.034)},${assColor(fg)},&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,${sideMargin},${sideMargin},${Math.round(height * 0.05)},1`);
  lines.push('', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text');
  const ev = (style, s, e, text, fx = '') => lines.push(`Dialogue: 0,${assTime(s)},${assTime(e)},${style},,0,0,0,,${fx}${assEscape(text)}`);
  for (const c of captions) ev('Caption', c.start, c.end, c.text);
  for (const o of overlays) ev('Title', o.start, o.end, o.text, '{\\fad(200,200)}');
  if (label) ev('Label', label.start ?? 0, label.end, label.text);
  if (endCard) {
    const { start, end } = endCard;
    const cx = Math.round(width / 2);
    ev('EndHead', start, end, endCard.headline, `{\\an5\\pos(${cx},${Math.round(height * 0.4)})\\fad(250,0)}`);
    ev('EndCta', start + 0.3, end, endCard.cta, `{\\an5\\pos(${cx},${Math.round(height * 0.56)})\\fad(250,0)}`);
    ev('EndLegal', start + 0.3, end, endCard.legal, '{\\fad(250,0)}');
  }
  return lines.join('\n') + '\n';
}
