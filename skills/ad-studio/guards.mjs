// guards.mjs -- the static (no-network) ad guards: structure, FTC, brand, copy/PHI.
// Each guard takes the manifest and returns an array of human-readable error strings ([] = pass).
// The claims_check gate is network-based and lives in claims.mjs; validate.mjs runs all of them.
import { existsSync, statSync } from 'node:fs';
import { extname, isAbsolute, resolve } from 'node:path';
import { foldBrand, normalizeText } from './confusables.mjs';

export const PRODUCT_CLASSES = ['PSAP', 'OTC_hearing_aid', 'AWARE', 'general'];
export const OUTPUTS = ['9:16', '1:1', '16:9'];
export const LOCALES = ['en', 'es'];
export const SHOT_ASPECTS = ['9:16', '16:9']; // Veo only renders these two
export const SHOT_DURATIONS = [4, 6, 8];       // Veo only allows 4/6/8
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'];

// ---------- text collection -----------------------------------------------------------------------

/** Every string that is PUBLISHED (heard or read by the viewer), across all locales. */
export function publishedTexts(m) {
  const out = [];
  const add = (locale, role, id, where, text) => { if (typeof text === 'string' && text.trim()) out.push({ locale, role, id, where, text }); };
  const block = (locale, b) => {
    (b.script || []).forEach((t, i) => add(locale, 'vo', `${locale}.vo.${i}`, `${locale} voiceover line ${i + 1}`, t));
    (b.onScreenText || []).forEach((t, i) => add(locale, 'onscreen', `${locale}.os.${i}`, `${locale} on-screen text ${i + 1}`, t));
    for (const k of ['headline', 'cta', 'legal']) add(locale, 'endcard', `${locale}.end.${k}`, `${locale} end card ${k}`, b.endCard?.[k]);
  };
  block('en', m);
  for (const [loc, b] of Object.entries(m.i18n || {})) block(loc, b || {});
  add('en', 'label', 'label', 'AI disclosure label', m.disclosures?.label);
  return out;
}

const walk = (o, fn, path = '') => {
  if (Array.isArray(o)) o.forEach((v, i) => walk(v, fn, `${path}[${i}]`));
  else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { fn(k, v, path ? `${path}.${k}` : k); walk(v, fn, path ? `${path}.${k}` : k); }
};

// ---------- structure -----------------------------------------------------------------------------

export function structureGuard(m, { baseDir = process.cwd() } = {}) {
  const e = [];
  const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
  if (!m || typeof m !== 'object') return ['manifest must be a JSON object'];
  if (!isStr(m.id) || !/^[a-z0-9][a-z0-9-_]{1,60}$/i.test(m.id)) e.push('id: required, letters/digits/dash/underscore (2-61 chars)');
  if (!isStr(m.product)) e.push('product: required');
  if (!PRODUCT_CLASSES.includes(m.productClass)) e.push(`productClass: must be one of ${PRODUCT_CLASSES.join(', ')}`);
  if (m.productClass === 'OTC_hearing_aid') e.push('productClass OTC_hearing_aid is gated (Matt + clinical review); ad-studio will not render it');
  if (!isStr(m.voice?.voice_id)) e.push('voice.voice_id: required');
  if (!Array.isArray(m.script) || !m.script.length || !m.script.every(isStr)) e.push('script: non-empty array of non-empty strings');
  if (m.onScreenText !== undefined && !(Array.isArray(m.onScreenText) && m.onScreenText.every(isStr))) e.push('onScreenText: array of non-empty strings');
  if (!Array.isArray(m.shots) || !m.shots.length) e.push('shots: non-empty array');
  else {
    const ids = new Set();
    m.shots.forEach((s, i) => {
      const at = `shots[${i}]`;
      if (!isStr(s.id)) e.push(`${at}.id: required`);
      else if (ids.has(s.id)) e.push(`${at}.id: duplicate "${s.id}"`); else ids.add(s.id);
      if (!isStr(s.prompt)) e.push(`${at}.prompt: required`);
      if (!SHOT_DURATIONS.includes(s.duration_secs)) e.push(`${at}.duration_secs: must be one of ${SHOT_DURATIONS.join('/')} (Veo constraint)`);
      if (s.aspect !== undefined && !SHOT_ASPECTS.includes(s.aspect)) e.push(`${at}.aspect: must be 9:16 or 16:9 (Veo constraint; 1:1 is derived at export)`);
    });
  }
  if (!m.music || !isStr(m.music.prompt) || !(m.music.duration >= 3 && m.music.duration <= 600)) e.push('music: {prompt, duration seconds 3..600} required');
  if (!m.endCard || !isStr(m.endCard.headline) || !isStr(m.endCard.cta) || !isStr(m.endCard.legal)) e.push('endCard: {headline, cta, legal} all required');
  const hex = (v) => v === undefined || /^#[0-9a-fA-F]{6}$/.test(String(v));
  for (const [where, ec] of [['endCard', m.endCard], ...Object.entries(m.i18n || {}).map(([l, b]) => [`i18n.${l}.endCard`, b?.endCard])]) {
    for (const k of ['background', 'textColor', 'accent']) if (ec && !hex(ec[k])) e.push(`${where}.${k}: must be a #RRGGBB hex color (it is interpolated into the ffmpeg filter graph)`);
  }
  if (!Array.isArray(m.outputs) || !m.outputs.length || !m.outputs.every((o) => OUTPUTS.includes(o))) e.push(`outputs: non-empty subset of ${OUTPUTS.join(', ')}`);
  if (m.disclosures?.aiGenerated !== true) e.push('disclosures.aiGenerated must be true (this ad contains AI-generated video)');
  if (!Array.isArray(m.locales) || !m.locales.length || !m.locales.every((l) => LOCALES.includes(l))) e.push(`locales: non-empty subset of ${LOCALES.join(', ')}`);
  else if (!m.locales.includes('en')) e.push('locales must include "en" (the master)');
  else for (const l of m.locales) if (l !== 'en' && !m.i18n?.[l]?.script?.length) e.push(`locales includes "${l}" but i18n.${l}.script is missing (reviewed translated script required; machine dubbing is not auto-shipped)`);
  for (const [loc, b] of Object.entries(m.i18n || {})) {
    if (loc !== 'en' && b?.script && m.script && b.script.length !== m.script.length) e.push(`i18n.${loc}.script must have the same number of lines as script (${m.script.length}) so variants line up`);
  }
  return e;
}

// ---------- FTC / testimonial guard ---------------------------------------------------------------

// Unicode-aware boundaries (JS \b is ASCII-only and breaks on accents such as "mí" or "audífono").
const L = '(?<![\\p{L}\\p{N}])';
const R = '(?![\\p{L}\\p{N}])';
const rx = (src) => new RegExp(L + '(?:' + src + ')' + R, 'iu');
// First-person voice reads as a customer testimonial. Deliberately blunt: fail closed. Case-insensitive.
const FIRST_PERSON_EN = rx("i|my|mine|myself");
const FIRST_PERSON_ES = rx("yo|mi|mis|m[ií]o|m[ií]a|m[ií]os|m[ií]as|m[ií]|conmigo|me|estoy|soy|tengo|puedo|oigo|escucho|encontr[eé]|compr[eé]|prob[eé]|volv[ií]");
const TESTIMONIAL_PATTERNS = [
  [rx("as an? (real )?(customer|user|patient|buyer|client)"), 'claims to speak as a customer'],
  [rx("(real|actual|verified|happy|satisfied) (customers?|users?|patients?|buyers?|reviews?|people)"), 'real-user framing'],
  [rx("testimonials?"), 'testimonial framing'],
  [rx("(customer|user|verified|five[- ]star|5[- ]star|star) reviews?"), 'review framing'],
  [rx("\\d(\\.\\d)?\\s*(\\/\\s*5|out of 5)"), 'invented star rating'],
  [rx("\\d(\\.\\d)?\\s*stars?"), 'invented star rating'],
  [/[★⭐]/u, 'star glyph rating'],
  [rx("(five|4|four)[- ]stars?"), 'invented star rating'],
  [rx("before[ -]?(and|&|\\/)[ -]?after"), 'before/after outcome framing'],
  [rx("(changed|saved|transformed) my (life|marriage|hearing)"), 'invented personal outcome'],
  [rx("can hear again"), 'restored-hearing outcome claim'],
  [rx("hear(ing)? (again|like (i|they) used to)"), 'restored-hearing outcome claim'],
  // Spanish
  [rx("como (un |una )?(cliente|usuari[oa]|paciente|comprador[a]?)"), 'claims to speak as a customer (es)'],
  [rx("(clientes|usuarios|pacientes|compradores|rese[nñ]as) (reales|verificad[oa]s)"), 'real-user framing (es)'],
  [rx("usuari[oa] verificad[oa]|cliente verificad[oa]|cliente[s]? satisfech[oa]s?|cliente[s]? feliz|clientes felices"), 'real-user framing (es)'],
  [rx("testimonios?|rese[nñ]as?"), 'testimonial/review framing (es)'],
  [rx("\\d(\\.\\d)?\\s*(estrellas?|de 5|\\/\\s*5)"), 'invented star rating (es)'],
  [rx("antes y despu[eé]s"), 'before/after outcome framing (es)'],
  [rx("(me )?cambi[oó] (mi|la) vida"), 'invented personal outcome (es)'],
  [rx("(puedo|vuelvo a|volv[ií] a|por fin) (o[ií]r|escuchar)( de nuevo| otra vez)?"), 'restored-hearing outcome claim (es)'],
  [rx("(o[ií]r|escuchar) de nuevo"), 'restored-hearing outcome claim (es)'],
];
export function ftcTextGuard(m) {
  const e = [];
  for (const t of publishedTexts(m)) {
    if (t.role === 'label') continue;
    const n = normalizeText(t.text);
    const show = `"${t.text.slice(0, 60)}"`;
    if (FIRST_PERSON_EN.test(n)) e.push(`FTC: ${t.where} uses first-person voice (${show}), which reads as a customer testimonial`);
    else if (t.locale !== 'en' && FIRST_PERSON_ES.test(n)) e.push(`FTC: ${t.where} uses first-person voice in Spanish (${show}), which reads as a customer testimonial`);
    for (const [re, why] of TESTIMONIAL_PATTERNS) if (re.test(n)) e.push(`FTC: ${t.where} ${why} (${show})`);
  }
  return e;
}

const SPEAKING = /\b(speak(s|ing)?|talk(s|ing)?|says?|saying|addresses|addressing|tell(s|ing)?|smil(es|ing) and (speak|talk))\b[^.]{0,40}\b(to|at|into|with)\b[^.]{0,20}\b(the )?(camera|viewer|audience|lens)\b|\b(talking head|to[- ]camera|on[- ]camera|direct address|lip[- ]?sync(ed|ing)?|delivers? (a )?(monologue|line)|spokes(person|man|woman)|presenter|host(ing)?|interview(ee|er|ed)?)\b|\blooking (straight |directly )?(at|into) the (camera|lens)\b/i;
const CUSTOMER_FRAMING = /\b(customers?|patients?|users?|reviewers?|buyers?|clients?|testimonial|real (person|people|user|customer|patient)|satisfied|happy (customer|user))\b/i;
export function ftcActorGuard(m) {
  const e = [];
  const labelOk = typeof (m.disclosures?.label ?? 'AI-generated') === 'string' && String(m.disclosures?.label ?? 'AI-generated').trim().length > 0;
  (m.shots || []).forEach((s, i) => {
    const at = `shots[${i}] (${s.id})`;
    const p = normalizeText(String(s.prompt || ''));
    if (SPEAKING.test(p) && s.aiActor !== true) e.push(`FTC: ${at} depicts a person speaking to camera; only allowed with aiActor:true plus an on-screen AI-generated label`);
    if (s.aiActor === true) {
      if (!labelOk) e.push(`FTC: ${at} aiActor requires a non-empty disclosures.label ("AI-generated") to be burned on screen`);
      if (CUSTOMER_FRAMING.test(p)) e.push(`FTC: ${at} frames the AI actor as a customer/patient/reviewer; an AI actor may never be presented as a real customer`);
    }
  });
  return e;
}
/** Does this ad require the burned-in AI label? (any aiActor shot, or disclosures.showLabel) */
export function needsAiLabel(m) {
  return (m.shots || []).some((s) => s.aiActor === true) || m.disclosures?.showLabel === true;
}

// ---------- brand guard ---------------------------------------------------------------------------

export const COMPETITOR_TERMS = [
  'Apple', 'AirPods', 'AirPod', 'iPhone', 'iPad', 'Beats', 'Bose', 'Sony', 'Jabra', 'Sennheiser', 'Samsung', 'Galaxy Buds', 'JBL', 'Skullcandy',
  'Anker', 'Soundcore', 'Nuheara', 'IQbuds', 'Phonak', 'Oticon', 'Signia', 'Starkey', 'Widex', 'ReSound', 'Unitron', 'Beltone', 'Bernafon',
  'Rexton', 'Hansaton', 'Eargo', 'Lexie', 'Miracle-Ear', 'MiracleEar', 'Audicus', 'Kirkland', 'Costco', 'Lively', 'Sonova', 'Demant',
];
const NAME_RES = COMPETITOR_TERMS.map((term) => {
  const letters = [...foldBrand(term).replace(/[^a-z0-9]/g, '')];
  // optional junk (spaces, dots, dashes, stars) between any two letters: "Air Pods", "A.i.r.P.o.d.s", "b-o-s-e"
  return { term, re: new RegExp('(?<![a-z0-9])' + letters.join('[^a-z0-9]{0,2}') + '(?![a-z0-9])') };
});
export function findCompetitors(text) {
  const f = foldBrand(text);
  return NAME_RES.filter(({ re }) => re.test(f)).map(({ term }) => term);
}
// Generic device words: a shot that mentions ANY of these is a PRODUCT shot and must be anchored to a real photo,
// otherwise Veo invents a look-alike (it drew AirPods from an unbranded prompt).
const DEVICE_WORDS = /(?<![a-z])(ear ?buds?|earphones?|headphones?|headsets?|earpieces?|in[- ]ear|ear ?pods?|hearing (aid|device|instrument)s?|amplifiers?|wearables?|gadgets?|devices?|charging case|earbud case)(?![a-z])/;

export function brandGuard(m, { baseDir = process.cwd(), exists = existsSync, size = (p) => statSync(p).size } = {}) {
  const e = [];
  const scan = (where, text) => {
    const hits = findCompetitors(text || '');
    if (hits.length) e.push(`brand: ${where} names a competitor/third-party brand ${hits.map((h) => `"${h}"`).join(', ')}`);
  };
  (m.shots || []).forEach((s, i) => {
    scan(`shots[${i}].prompt`, s.prompt);
    const at = `shots[${i}] (${s.id})`;
    const deviceHit = DEVICE_WORDS.test(foldBrand(s.prompt || ''));
    if (deviceHit && s.showsProduct !== true) {
      e.push(`brand: ${at} prompt mentions a device (earbud/gadget/device/hearing aid/amplifier/earpiece) but showsProduct is not true; set showsProduct:true with a real start_frame, or remove the device from the prompt`);
      return;
    }
    if (s.showsProduct === true) {
      if (!s.start_frame) e.push(`brand: ${at} shows the product but has no start_frame (a REAL product photo is required; an unbranded prompt makes Veo invent a look-alike)`);
      else {
        const p = isAbsolute(s.start_frame) ? s.start_frame : resolve(baseDir, s.start_frame);
        if (!IMAGE_EXT.includes(extname(p).toLowerCase())) e.push(`brand: ${at} start_frame must be jpeg/png/webp/heic (got ${extname(p) || 'no extension'})`);
        else if (!exists(p)) e.push(`brand: ${at} start_frame file not found: ${s.start_frame}`);
        else if (size(p) > 25 * 1024 * 1024) e.push(`brand: ${at} start_frame exceeds the 25 MB inline limit`);
      }
    }
  });
  for (const t of publishedTexts(m)) scan(t.where, t.text);
  scan('music.prompt', m.music?.prompt);
  return e;
}

// ---------- copy / PHI guard ----------------------------------------------------------------------

const PHI_KEYS = /^(patient|patients|patientName|ssn|dob|dateOfBirth|mrn|medicalRecord|diagnosis|audiogram|insuranceId|memberId|hearingNumber|hearing_number|threshold|thresholds|db_hl|threshold_db_hl)$/i;
const PHI_TEXT = [
  [/\b\d{3}-\d{2}-\d{4}\b/, 'SSN-shaped number'],
  [/\b(mrn|medical record (number|no))\b/i, 'medical record number'],
  [/\b(date of birth|dob)\b/i, 'date of birth'],
  [/\b(my|your|his|her|their) audiogram\b/i, 'audiogram reference'],
  [/\bhearing number\b/i, 'Hearing Number (PHI-ring field)'],
  [/\b\d{1,3}\s?db\s?hl\b/i, 'audiometric threshold value'],
];
/** Reject EVERY dash-punctuation character (Unicode Pd: en, em, figure, hyphen U+2010/2011, minus-like, small/full-width
 *  variants, ...) except the plain hyphen-minus U+002D. U+2212 (minus sign) is not Pd and stays allowed. Checked raw and NFKC. */
export function hasBadDash(text) {
  const bad = (t) => [...String(t)].some((ch) => ch !== '-' && /\p{Pd}/u.test(ch));
  return bad(text) || bad(String(text).normalize('NFKC'));
}
export function copyGuard(m) {
  const e = [];
  for (const t of publishedTexts(m)) {
    if (hasBadDash(t.text)) e.push(`copy: ${t.where} contains an em or en dash (published copy must use commas, periods or line breaks)`);
    for (const [re, why] of PHI_TEXT) if (re.test(t.text)) e.push(`PHI: ${t.where} contains ${why}`);
  }
  // Prompts render text in-frame too, so dashes there are also a risk; keep them out.
  (m.shots || []).forEach((s, i) => { if (hasBadDash(s.prompt || '')) e.push(`copy: shots[${i}].prompt contains an em or en dash (Veo can render it as on-screen text)`); });
  walk(m, (k, v, path) => { if (PHI_KEYS.test(k) && v !== undefined) e.push(`PHI: manifest field "${path}" is a PHI-ring field name and must not appear in an ad manifest`); });
  if (m.productClass === 'PSAP') {
    const need = { en: [/not a hearing aid/i, 'not a hearing aid'], es: [/no es un (aud[i\u00ED]fono|aparato auditivo)/i, 'no es un audífono'] };
    for (const loc of m.locales || []) {
      const legal = loc === 'en' ? m.endCard?.legal : m.i18n?.[loc]?.endCard?.legal;
      const [re, phrase] = need[loc] || need.en;
      if (!legal || !re.test(normalizeText(legal))) e.push(`copy: PSAP ${loc} end card legal line must say "${phrase}" (claims_check acceptance test G1/G4)${loc !== 'en' && !legal ? `; i18n.${loc}.endCard.legal is missing` : ''}`);
    }
  }
  return e;
}

export const GUARDS = { structure: structureGuard, ftcText: ftcTextGuard, ftcActor: ftcActorGuard, brand: brandGuard, copy: copyGuard };
