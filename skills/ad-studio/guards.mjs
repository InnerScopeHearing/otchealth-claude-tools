// guards.mjs -- the static (no-network) ad guards: structure, FTC, brand, copy/PHI.
// Each guard takes the manifest and returns an array of human-readable error strings ([] = pass).
// The claims_check gate is network-based and lives in claims.mjs; validate.mjs runs all of them.
import { existsSync, statSync } from 'node:fs';
import { extname, isAbsolute, resolve } from 'node:path';

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

// First-person singular in a voiceover reads as a customer testimonial. Deliberately blunt: fail closed.
const FIRST_PERSON = /\b(I|I'm|I've|I'd|I'll|Ive|my|mine|myself)\b/;
const TESTIMONIAL_PATTERNS = [
  [/\bas a (real )?(customer|user|patient|buyer|client)\b/i, 'claims to speak as a customer'],
  [/\b(real|actual|verified|happy|satisfied) (customers?|users?|patients?|buyers?|reviews?|people)\b/i, 'real-user framing'],
  [/\btestimonials?\b/i, 'testimonial framing'],
  [/\b(customer|user|verified|five[- ]star|5[- ]star|star) reviews?\b/i, 'review framing'],
  [/\b\d(\.\d)?\s*(\/\s*5|out of 5)\b/i, 'invented star rating'],
  [/\b\d(\.\d)?\s*stars?\b/i, 'invented star rating'],
  [/[★⭐]/, 'star glyph rating'],
  [/\b(five|4|four)[- ]stars?\b/i, 'invented star rating'],
  [/\bbefore[ -]?(and|&|\/)[ -]?after\b/i, 'before/after outcome framing'],
  [/\b(changed|saved|transformed) my (life|marriage|hearing)\b/i, 'invented personal outcome'],
  [/\bcan hear again\b/i, 'restored-hearing outcome claim'],
  [/\bhear(ing)? (again|like (I|they) used to)\b/i, 'restored-hearing outcome claim'],
];
export function ftcTextGuard(m) {
  const e = [];
  for (const t of publishedTexts(m)) {
    if (t.role === 'vo' && FIRST_PERSON.test(t.text)) e.push(`FTC: ${t.where} uses first-person voice ("${t.text.slice(0, 60)}"), which reads as a customer testimonial`);
    for (const [re, why] of TESTIMONIAL_PATTERNS) if (re.test(t.text)) e.push(`FTC: ${t.where} ${why} ("${t.text.slice(0, 60)}")`);
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
    const p = String(s.prompt || '');
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
const COMPETITOR_RE = new RegExp(`\\b(${COMPETITOR_TERMS.map((t) => t.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|')})\\b`, 'i');
const DEVICE_WORDS = /\b(ear ?buds?|earphones?|headphones?|earpieces?|in[- ]ear|ear ?pods?|hearing (aid|device|instrument)s?|amplifier|wearable|charging case|earbud case)\b/i;

export function brandGuard(m, { baseDir = process.cwd(), exists = existsSync, size = (p) => statSync(p).size } = {}) {
  const e = [];
  const scan = (where, text) => { const mm = COMPETITOR_RE.exec(text || ''); if (mm) e.push(`brand: ${where} names a competitor/third-party brand "${mm[1]}"`); };
  (m.shots || []).forEach((s, i) => {
    scan(`shots[${i}].prompt`, s.prompt);
    const at = `shots[${i}] (${s.id})`;
    if (s.showsProduct === true) {
      if (!s.start_frame) e.push(`brand: ${at} shows the product but has no start_frame (a REAL product photo is required; an unbranded prompt makes Veo invent a look-alike)`);
      else {
        const p = isAbsolute(s.start_frame) ? s.start_frame : resolve(baseDir, s.start_frame);
        if (!IMAGE_EXT.includes(extname(p).toLowerCase())) e.push(`brand: ${at} start_frame must be jpeg/png/webp/heic (got ${extname(p) || 'no extension'})`);
        else if (!exists(p)) e.push(`brand: ${at} start_frame file not found: ${s.start_frame}`);
        else if (size(p) > 25 * 1024 * 1024) e.push(`brand: ${at} start_frame exceeds the 25 MB inline limit`);
      }
    } else if (DEVICE_WORDS.test(s.prompt || '')) {
      e.push(`brand: ${at} prompt mentions a device (earbuds/headphones/hearing device) but showsProduct is not true; set showsProduct:true with a real start_frame, or remove the device from the prompt`);
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
export function copyGuard(m) {
  const e = [];
  for (const t of publishedTexts(m)) {
    if (/[\u2013\u2014]/.test(t.text)) e.push(`copy: ${t.where} contains an em or en dash (published copy must use commas, periods or line breaks)`);
    for (const [re, why] of PHI_TEXT) if (re.test(t.text)) e.push(`PHI: ${t.where} contains ${why}`);
  }
  // Prompts render text in-frame too, so dashes there are also a risk; keep them out.
  (m.shots || []).forEach((s, i) => { if (/[\u2013\u2014]/.test(s.prompt || '')) e.push(`copy: shots[${i}].prompt contains an em or en dash (Veo can render it as on-screen text)`); });
  walk(m, (k, v, path) => { if (PHI_KEYS.test(k) && v !== undefined) e.push(`PHI: manifest field "${path}" is a PHI-ring field name and must not appear in an ad manifest`); });
  const legal = m.endCard?.legal;
  if (m.productClass === 'PSAP' && legal && !/not a hearing aid/i.test(legal)) e.push('warn: PSAP end card legal line should say "not a hearing aid" (see the claims_check acceptance test G1/G4)');
  return e;
}

export const GUARDS = { structure: structureGuard, ftcText: ftcTextGuard, ftcActor: ftcActorGuard, brand: brandGuard, copy: copyGuard };
