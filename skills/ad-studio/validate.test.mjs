import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest } from './validate.mjs';
import { checkClaims, gatewayCaller, parseMcpBody, parseVerdict } from './claims.mjs';
import { goodManifest, mockFetch, passAllClaims, tmp } from './test-helpers.mjs';

const dir = tmp('val-');
const base = () => structuredClone(goodManifest(dir));
const V = (m, o = {}) => validateManifest(m, { baseDir: dir, callTool: passAllClaims, ...o });
const has = (r, re) => r.errors.some((e) => re.test(e));

test('baseline manifest passes every gate and is cleared for spend', async () => {
  const r = await V(base());
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.equal(r.cleared, true);
  assert.equal(r.claimsRan, true);
});

test('example manifest shipped with the skill: structurally valid except for the (intentionally) missing product photos', async () => {
  const { readFileSync } = await import('node:fs');
  const m = JSON.parse(readFileSync(new URL('./examples/sample-ad.json', import.meta.url), 'utf8'));
  m.locales = ['en', 'es'];
  const r = await validateManifest(m, { baseDir: dir, offline: true });
  assert.deepEqual(r.errors.filter((e) => !/start_frame file not found/.test(e)), []);
  assert.ok(r.errors.some((e) => /start_frame file not found/.test(e)), 'placeholder photos must fail validation so nothing is spent by accident');
});

// ---- brand guard -------------------------------------------------------------------------------
test('brand: an AirPods look-alike prompt is rejected', async () => {
  const m = base(); m.shots[1].prompt = 'A person puts in AirPods on a train, morning light';
  const r = await V(m);
  assert.equal(r.ok, false);
  assert.ok(has(r, /brand: shots\[1\]\.prompt names a competitor\/third-party brand "AirPods"/));
});
test('brand: counterfactual, with the brand guard disabled the same manifest is NOT stopped by it', async () => {
  const m = base(); m.shots[1].prompt = 'A person puts in AirPods on a train';
  const r = await V(m, { disable: ['brand'] });
  assert.ok(!has(r, /brand: shots\[1\]/), 'the guard, not luck, is what catches AirPods');
});
test('brand: competitor names in VO / on-screen text are rejected too', async () => {
  const m = base(); m.script[0] = 'Better than Bose or Apple.'; m.onScreenText = ['Not Phonak'];
  const r = await V(m);
  assert.ok(has(r, /voiceover line 1 names a competitor.*"Bose"/));
  assert.ok(has(r, /on-screen text 1 names a competitor.*"Phonak"/));
});
test('brand: showsProduct without a start_frame is rejected', async () => {
  const m = base(); delete m.shots[0].start_frame;
  const r = await V(m);
  assert.ok(has(r, /shows the product but has no start_frame/));
});
test('brand: start_frame must exist, be an image, and be under 25 MB', async () => {
  let m = base(); m.shots[0].start_frame = 'assets/missing.jpg';
  assert.ok(has(await V(m), /start_frame file not found/));
  m = base(); m.shots[0].start_frame = 'assets/hero.gif';
  assert.ok(has(await V(m), /jpeg\/png\/webp\/heic/));
});
test('brand: a device word in a non-product shot is rejected (Veo would invent the look-alike)', async () => {
  const m = base(); m.shots[1].prompt = 'Close-up of wireless earbuds in a charging case';
  assert.ok(has(await V(m), /mentions a device.*showsProduct/));
});

// ---- FTC ---------------------------------------------------------------------------------------
test('FTC: first-person testimonial voiceover is rejected', async () => {
  for (const line of ['I can hear again!', 'Since I started, my hearing changed.', "I've never felt better."]) {
    const m = base(); m.script[0] = line;
    const r = await V(m);
    assert.ok(has(r, /FTC: en voiceover line 1/), line);
  }
});
test('FTC: customer / star-rating / before-after framing is rejected in any published text', async () => {
  const bad = ['As a customer, I recommend it.', 'Rated 5 stars by real customers', 'Before and after results', 'Verified buyer reviews', 'Loved by 4.8 out of 5 users'];
  for (const t of bad) {
    const m = base(); m.onScreenText = [t];
    assert.ok(has(await V(m), /FTC: en on-screen text 1/), t);
  }
  const m = base(); m.endCard.headline = '★★★★★ TReO';
  assert.ok(has(await V(m), /star glyph rating/));
});
test('FTC: counterfactual, disabling the text guard lets a testimonial line through', async () => {
  const m = base(); m.script[0] = 'I can hear again!';
  const r = await V(m, { disable: ['ftcText'] });
  assert.ok(!has(r, /FTC: en voiceover/));
});
test('FTC: a person speaking to camera requires aiActor:true', async () => {
  const m = base(); m.shots[1].prompt = 'A woman speaking to the camera in a bright kitchen';
  assert.ok(has(await V(m), /speaking to camera; only allowed with aiActor:true/));
  m.shots[1].aiActor = true;
  const ok = await V(m);
  assert.ok(!has(ok, /FTC/), 'aiActor + label is allowed');
});
test('FTC: aiActor needs a configured on-screen AI-generated label', async () => {
  const m = base(); m.shots[1].prompt = 'A presenter talking to camera'; m.shots[1].aiActor = true; m.disclosures.label = '   ';
  assert.ok(has(await V(m), /aiActor requires a non-empty disclosures\.label/));
});
test('FTC: an AI actor can never be framed as a customer / patient / reviewer', async () => {
  for (const p of ['A happy customer talking to camera', 'A patient smiling at the camera and saying thanks', 'A real user talking to camera']) {
    const m = base(); m.shots[1].prompt = p; m.shots[1].aiActor = true;
    assert.ok(has(await V(m), /frames the AI actor as a customer/), p);
  }
});
test('FTC: disclosures.aiGenerated must be true', async () => {
  const m = base(); m.disclosures.aiGenerated = false;
  assert.ok(has(await V(m), /disclosures\.aiGenerated must be true/));
});

// ---- copy / PHI --------------------------------------------------------------------------------
test('copy: em dash and en dash are rejected in every published field', async () => {
  let m = base(); m.script[1] = 'Learn more \u2014 today.';
  assert.ok(has(await V(m), /copy: en voiceover line 2 contains an em or en dash/));
  m = base(); m.endCard.cta = 'Shop 9\u201310';
  assert.ok(has(await V(m), /copy: en end card cta/));
  m = base(); m.shots[0].prompt = 'A table \u2014 calm';
  assert.ok(has(await V(m), /copy: shots\[0\]\.prompt/));
});
test('copy: counterfactual, disabling the copy guard removes the dash error', async () => {
  const m = base(); m.script[1] = 'Learn more \u2014 today.';
  assert.ok(!has(await V(m, { disable: ['copy'] }), /em or en dash/));
});
test('PHI: PHI-ring field names and PHI-shaped text are rejected', async () => {
  let m = base(); m.patient = { name: 'x' };
  assert.ok(has(await V(m), /PHI: manifest field "patient"/));
  m = base(); m.script[0] = 'Your audiogram shows 40 dB HL at 4 kHz.';
  const r = await V(m);
  assert.ok(has(r, /PHI: en voiceover line 1 contains audiogram reference/));
  assert.ok(has(r, /PHI: .* contains audiometric threshold value/));
  m = base(); m.onScreenText = ['ID 123-45-6789'];
  assert.ok(has(await V(m), /SSN-shaped/));
});
test('M9: a PSAP end card without the "not a hearing aid" disclaimer is an ERROR (not a warning)', async () => {
  const m = base(); m.endCard.legal = 'Terms apply.';
  const r = await V(m);
  assert.equal(r.ok, false);
  assert.ok(has(r, /PSAP en end card legal line must say "not a hearing aid"/));
  assert.equal(r.claimsRan, true);
  // counterfactual: the disclaimer present -> passes; another productClass is not forced to carry it
  assert.equal((await V(base())).ok, true);
  const g = base(); g.productClass = 'general'; g.endCard.legal = 'Terms apply.';
  assert.equal((await V(g)).ok, true);
});
test('M9: each PSAP locale needs its own disclaimer (Spanish must say no es un audifono)', async () => {
  const m = base(); m.locales = ['en', 'es']; m.i18n = { es: { script: ['Conozca TReO.', 'Más información abajo.'] } };
  assert.ok(has(await V(m), /PSAP es end card legal line must say "no es un audífono".*missing/));
  m.i18n.es.endCard = { legal: 'Amplificador de sonido personal.' };
  assert.ok(has(await V(m), /PSAP es end card legal line must say/));
  m.i18n.es.endCard = { legal: 'Amplificador de sonido personal, no es un audífono.' };
  assert.equal((await V(m)).ok, true);
});

// ---- structure ---------------------------------------------------------------------------------
test('structure: bad duration, bad output, missing music, OTC_hearing_aid, locale without a translation', async () => {
  const m = base(); m.shots[0].duration_secs = 5; m.outputs = ['4:3']; delete m.music; m.locales = ['en', 'es'];
  const r = await V(m);
  assert.ok(has(r, /duration_secs: must be one of 4\/6\/8/));
  assert.ok(has(r, /outputs: non-empty subset/));
  assert.ok(has(r, /music:/));
  assert.ok(has(r, /i18n\.es\.script is missing/));
  assert.equal(r.claimsRan, false, 'claims_check is not spent on a manifest that cannot render');
  const o = base(); o.productClass = 'OTC_hearing_aid';
  assert.ok(has(await V(o), /gated \(Matt \+ clinical review\)/));
});
test('structure: es translation must have the same number of lines and is claims-checked too', async () => {
  const m = base(); m.locales = ['en', 'es']; m.i18n = { es: { script: ['Conozca TReO.'] } };
  assert.ok(has(await V(m), /same number of lines/));
  m.i18n.es.script = ['Conozca TReO.', 'Más información abajo.'];
  m.i18n.es.endCard = { legal: 'Amplificador de sonido personal, no es un audífono.' };
  const seen = [];
  const r = await V(m, { callTool: async (n, a) => { seen.push(a.text); return passAllClaims(); } });
  assert.equal(r.ok, true);
  assert.ok(seen.includes('Conozca TReO.'));
});

// ---- claims gate -------------------------------------------------------------------------------
test('claims: every VO line and on-screen string is sent with channel=ad and the productClass, plus one joined net-impression check', async () => {
  const calls = [];
  const m = base();
  await V(m, { callTool: async (name, args) => { calls.push({ name, args }); return passAllClaims(); } });
  assert.ok(calls.every((c) => c.name === 'claims_check' && c.args.channel === 'ad' && c.args.productClass === 'PSAP'));
  const texts = calls.map((c) => c.args.text);
  for (const t of ['Meet TReO, a personal sound amplifier.', 'Learn more at the link below.', 'Meet TReO', 'TReO', 'Learn more', 'Personal sound amplifier, not a hearing aid.']) assert.ok(texts.includes(t), t);
  assert.ok(texts.some((t) => t.includes('Meet TReO, a personal sound amplifier. Learn more at the link below.')), 'joined net-impression call');
});
test('claims: BLOCK and REVISE verdicts fail validation and quote the violation + rewrite', async () => {
  const block = async () => ({ result: { structuredContent: { result: { verdict: 'block', violations: [{ phrase: 'hearing aid' }], compliant_rewrite: 'a personal sound amplifier' } } } });
  let r = await V(base(), { callTool: block });
  assert.equal(r.ok, false); assert.equal(r.cleared, false);
  assert.ok(has(r, /claims_check BLOCK on en voiceover line 1.*hearing aid.*suggested: "a personal sound amplifier"/));
  const revise = async () => ({ result: { structuredContent: { result: { verdict: 'revise' } } } });
  r = await V(base(), { callTool: revise });
  assert.ok(has(r, /claims_check REVISE/));
});
test('claims: FAIL CLOSED when the gateway is unreachable or answers garbage', async () => {
  let r = await V(base(), { callTool: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(r.ok, false); assert.equal(r.cleared, false);
  assert.ok(has(r, /could not run.*ECONNREFUSED.*failing closed/));
  r = await V(base(), { callTool: async () => ({ result: { content: [{ type: 'text', text: 'looks fine to me' }] } }) });
  assert.ok(has(r, /no recognizable verdict/));
  r = await V(base(), { callTool: async () => ({ result: { isError: true, content: [{ type: 'text', text: 'denied' }] } }) });
  assert.equal(r.ok, false);
});
test('claims: --offline runs the static guards only and can NEVER be cleared for spend', async () => {
  const r = await validateManifest(base(), { baseDir: dir, offline: true, callTool: async () => { throw new Error('must not be called'); } });
  assert.equal(r.ok, true);
  assert.equal(r.cleared, false);
  assert.ok(r.warnings.some((w) => /NOT RUN/.test(w)));
});

// ---- claims transport --------------------------------------------------------------------------
test('parseMcpBody handles SSE framing and plain JSON; parseVerdict handles the shapes we might see', () => {
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"structuredContent":{"result":{"verdict":"PASS","risk_score":3}}}}\n\n';
  assert.equal(parseVerdict(parseMcpBody(sse)).verdict, 'pass');
  assert.equal(parseVerdict({ result: { structuredContent: { verdict: 'block' } } }).verdict, 'block');
  assert.equal(parseVerdict({ result: { content: [{ type: 'text', text: '{"verdict":"revise"}' }] } }).verdict, 'revise');
  assert.equal(parseVerdict({ result: { content: [{ type: 'text', text: 'Verdict: block. reason' }] } }).verdict, 'block');
  assert.throws(() => parseVerdict({}), /no result/);
});
test('gatewayCaller: POST tools/call with the bearer; HTTP errors throw', async () => {
  const f = mockFetch(() => ({ body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: { result: { verdict: 'pass' } } } }) }));
  const call = gatewayCaller({ token: 'TKN', fetchImpl: f });
  const rpc = await call('claims_check', { text: 'hi', channel: 'ad', productClass: 'PSAP' });
  assert.equal(parseVerdict(rpc).verdict, 'pass');
  assert.equal(f.calls[0].url, 'https://mcp.otchealth.app/mcp');
  assert.equal(f.calls[0].headers.authorization, 'Bearer TKN');
  const body = JSON.parse(f.calls[0].body);
  assert.equal(body.method, 'tools/call'); assert.equal(body.params.name, 'claims_check');
  const bad = gatewayCaller({ token: 'T', fetchImpl: mockFetch(() => ({ status: 401, body: 'no' })) });
  await assert.rejects(() => bad('claims_check', { text: 'x' }), /gateway HTTP 401/);
});
test('checkClaims dedupes identical strings but still reports every location', async () => {
  let n = 0;
  const r = await checkClaims([{ id: 'a', where: 'A', text: 'same' }, { id: 'b', where: 'B', text: 'same' }], { productClass: 'PSAP', callTool: async () => { n++; return passAllClaims(); }, includeNetImpression: false });
  assert.equal(n, 1); assert.equal(r.results.length, 2); assert.equal(r.ok, true);
});

// ---- M6: FTC guard hardening ---------------------------------------------------------------------
test('M6 FTC: first-person detection is case-insensitive and applies to on-screen text and the end card', async () => {
  for (const [field, set] of [['vo', (m, t) => { m.script[0] = t; }], ['on-screen', (m, t) => { m.onScreenText = [t]; }], ['end card', (m, t) => { m.endCard.headline = t; }], ['end card cta', (m, t) => { m.endCard.cta = t; }]]) {
    for (const t of ['i can hear again', 'MY hearing is better', 'I LOVE IT']) {
      const m = base(); set(m, t);
      assert.ok(has(await V(m), /FTC:/), `${field}: ${t}`);
    }
  }
  // counterfactual: disabling the guard removes it (so the assertion above is the guard's doing)
  const m = base(); m.endCard.headline = 'MY hearing'; 
  assert.ok(!has(await V(m, { disable: ['ftcText'] }), /FTC:/));
});
test('M6 FTC: Spanish first-person, real-customer and outcome patterns are rejected in es locale copy', async () => {
  const bad = ['Yo puedo oír de nuevo.', 'Mi audición mejoró.', 'Me cambió la vida.', 'Como cliente, lo recomiendo.', 'Clientes reales, resultados reales.', 'Antes y después.', 'Cinco estrellas 5 estrellas', 'Por fin oigo mejor.', 'Estoy feliz con TReO.'];
  for (const t of bad) {
    const m = base(); m.locales = ['en', 'es'];
    m.i18n = { es: { script: [t, 'Más información abajo.'], endCard: { legal: 'Amplificador de sonido personal, no es un audífono.' } } };
    assert.ok(has(await V(m), /FTC: es voiceover line 1/), t);
  }
  // clean Spanish copy is NOT flagged (accents and word boundaries are handled)
  const ok = base(); ok.locales = ['en', 'es'];
  ok.i18n = { es: { script: ['Conozca TReO, un amplificador de sonido personal.', 'Más información en el enlace de abajo.'], endCard: { legal: 'Amplificador de sonido personal, no es un audífono.' } } };
  assert.ok(!has(await V(ok), /FTC/), 'clean Spanish must pass');
});
test('M6 FTC: look-alike Unicode and zero-width characters cannot hide a testimonial', async () => {
  const m = base(); m.script[0] = 'm\u200By hearing is better';            // zero width space inside "my"
  assert.ok(has(await V(m), /FTC: en voiceover line 1/));
  const c = base(); c.script[0] = '\u0406 can hear again';                   // Cyrillic I
  assert.ok(has(await V(c), /FTC: en voiceover line 1/));
});

// ---- M7: brand guard hardening -------------------------------------------------------------------
test('M7 brand: NFKC, zero-width, homoglyphs, leetspeak and spacing inside a competitor name are all caught', async () => {
  const variants = ['Air Pods', 'AIRPODS', 'A\u200Bir\u200BPods', '\uFF21\uFF49\uFF52\uFF30\uFF4F\uFF44\uFF53', '\u0410irPods', 'A.i.r.P.o.d.s', 'B0se speakers', 'S o n y', 'Ph\u043Enak', 'Pho-nak', '\u00C1pple'];
  for (const v of variants) {
    const m = base(); m.shots[1].prompt = `A person wearing ${v} on a train`;
    assert.ok(has(await V(m), /brand: shots\[1\]\.prompt names a competitor/), v);
  }
  // counterfactual: innocent words are not flagged (the fold has boundaries)
  const m = base(); m.shots[1].prompt = 'A pineapple and a sonnet on a table, no people';
  assert.ok(!has(await V(m), /competitor/));
});
test('M7 brand: generic device words make it a PRODUCT shot that needs showsProduct + a real start_frame', async () => {
  for (const w of ['earbud', 'gadget', 'device', 'hearing aid', 'amplifier', 'earpiece', 'headphones', 'Ear Buds']) {
    const m = base(); m.shots[1].prompt = `Close-up of a small ${w} on a table`;
    assert.ok(has(await V(m), /mentions a device/), w);
    m.shots[1].showsProduct = true; // still no start_frame
    assert.ok(has(await V(m), /shows the product but has no start_frame/), w);
    m.shots[1].start_frame = 'assets/close.jpg';
    assert.equal((await V(m)).errors.filter((x) => /brand:/.test(x)).length, 0, w);
  }
});

// ---- M8: dash guard ------------------------------------------------------------------------------
test('M8 dash: every Unicode dash (Pd) except the plain hyphen is rejected; hyphen-minus and the minus sign stay allowed', async () => {
  const bad = ['\u2010', '\u2011', '\u2012', '\u2013', '\u2014', '\u2015', '\u2E3A', '\u2E3B', '\uFE58', '\uFE63', '\uFF0D', '\u058A', '\u1806', '\u30A0'];
  for (const d of bad) {
    const m = base(); m.script[1] = `Learn${d}more today.`;
    assert.ok(has(await V(m), /copy: en voiceover line 2/), `U+${d.codePointAt(0).toString(16)}`);
  }
  const ok = base(); ok.script[1] = 'A well-known 3-step plan, 5 \u2212 2 = 3.';
  assert.ok(!has(await V(ok), /dash/));
});

// ---- endCard colors (filter-graph injection) ----------------------------------------------------
test('endCard colors must be #RRGGBB (they are interpolated into the ffmpeg filter graph)', async () => {
  for (const bad of ['red', '#12', '#12263A;movie=/etc/passwd', '0x12263A', '#GGGGGG']) {
    const m = base(); m.endCard.background = bad;
    assert.ok(has(await V(m), /endCard\.background: must be a #RRGGBB/), bad);
  }
  const m = base(); m.endCard.background = '#12263A'; m.endCard.textColor = '#ffffff'; m.endCard.accent = '#0D9488';
  assert.equal((await V(m)).ok, true);
  const i = base(); i.i18n = { es: { endCard: { accent: 'blue' } } };
  assert.ok(has(await V(i), /i18n\.es\.endCard\.accent/));
});
