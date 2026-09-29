// confusables.mjs -- normalization used by the FTC and brand guards so look-alike Unicode cannot smuggle a brand name
// or a testimonial past a regex: NFKC, zero-width / bidi control removal, and Cyrillic/Greek homoglyph folding.
const MAP = {
  '\u0430': 'a',
  '\u0435': 'e',
  '\u043E': 'o',
  '\u0440': 'p',
  '\u0441': 'c',
  '\u0443': 'y',
  '\u0445': 'x',
  '\u0456': 'i',
  '\u0458': 'j',
  '\u0455': 's',
  '\u0501': 'd',
  '\u04BB': 'h',
  '\u051B': 'q',
  '\u051D': 'w',
  '\u043A': 'k',
  '\u043C': 'm',
  '\u043D': 'h',
  '\u0442': 't',
  '\u0432': 'b',
  '\u0475': 'v',
  '\u04CF': 'l',
  '\u0410': 'a',
  '\u0412': 'b',
  '\u0415': 'e',
  '\u041A': 'k',
  '\u041C': 'm',
  '\u041D': 'h',
  '\u041E': 'o',
  '\u0420': 'p',
  '\u0421': 'c',
  '\u0422': 't',
  '\u0423': 'y',
  '\u0425': 'x',
  '\u0406': 'i',
  '\u0408': 'j',
  '\u0405': 's',
  '\u03B1': 'a',
  '\u03B2': 'b',
  '\u03B5': 'e',
  '\u03B9': 'i',
  '\u03BA': 'k',
  '\u03BD': 'v',
  '\u03BF': 'o',
  '\u03C1': 'p',
  '\u03C4': 't',
  '\u03C5': 'u',
  '\u03C7': 'x',
  '\u0391': 'a',
  '\u0392': 'b',
  '\u0395': 'e',
  '\u0396': 'z',
  '\u0397': 'h',
  '\u0399': 'i',
  '\u039A': 'k',
  '\u039C': 'm',
  '\u039D': 'n',
  '\u039F': 'o',
  '\u03A1': 'p',
  '\u03A4': 't',
  '\u03A5': 'y',
  '\u03A7': 'x',
  '\u0131': 'i',
  '\u0269': 'i',
  '\u01C0': 'l',
  '\u02C1': 'l',
};
const ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u180E\uFEFF\u00AD]/g;

/** NFKC + strip invisible characters + fold common homoglyphs to Latin. Keeps case and accents (Spanish patterns need them). */
export function normalizeText(t) {
  const s = String(t ?? '').normalize('NFKC').replace(ZERO_WIDTH, '');
  let out = '';
  for (const ch of s) out += MAP[ch] !== undefined ? (ch === ch.toLowerCase() ? MAP[ch] : MAP[ch].toUpperCase()) : ch;
  return out;
}

/** Aggressive fold for brand scanning: normalizeText, accents stripped, lower case, common leet digits/symbols to letters. */
export function foldBrand(t) {
  return normalizeText(t).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't').replace(/@/g, 'a').replace(/\$/g, 's');
}
