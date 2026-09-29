// claims.mjs -- calls the OTCHealth gateway `claims_check` tool on every published string.
//
// claims_check (read-only) input:  {text, channel:'ad', productClass:'PSAP'|'OTC_hearing_aid'|'AWARE'|'general', context?}
// It returns a verdict pass|revise|block, a risk score, the violating phrases and a compliant rewrite.
// UNVERIFIED: the exact response nesting. parseVerdict() accepts structuredContent.result, structuredContent,
// content[0].text (JSON) and a plain-text "verdict: X" fallback. Anything unparseable is treated as a FAILURE.
//
// FAIL CLOSED: an unreachable gateway, a non-200, a missing token, or an unparseable answer is an ERROR that
// blocks spend. There is no offline "assume pass" path.
export const GATEWAY_MCP = 'https://mcp.otchealth.app/mcp';

/** Extract the last JSON object from an SSE or plain-JSON MCP response body. */
export function parseMcpBody(text) {
  const cleaned = String(text).replace(/^event:.*$/gm, '').replace(/^data: ?/gm, '').trim();
  const lines = cleaned.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch { /* try previous */ }
  }
  try { return JSON.parse(cleaned); } catch { return null; }
}

/** Normalize a tools/call result into {verdict, riskScore, violations[], rewrite, raw}. Throws if no verdict is found. */
export function parseVerdict(rpc) {
  const result = rpc?.result;
  if (!result) throw new Error('claims_check returned no result');
  if (result.isError) throw new Error('claims_check reported an error: ' + JSON.stringify(result.content ?? '').slice(0, 300));
  let payload = result.structuredContent?.result ?? result.structuredContent ?? null;
  if (!payload || typeof payload !== 'object') {
    const t = result.content?.find?.((c) => c?.type === 'text')?.text;
    if (t) { try { payload = JSON.parse(t); } catch { const m = t.match(/verdict\W+(pass|revise|block)/i); if (m) payload = { verdict: m[1] }; } }
  }
  const verdict = String(payload?.verdict ?? '').toLowerCase();
  if (!['pass', 'revise', 'block'].includes(verdict)) throw new Error('claims_check response had no recognizable verdict');
  return {
    verdict,
    riskScore: payload.risk_score ?? payload.riskScore ?? null,
    violations: payload.violations ?? payload.violating_phrases ?? [],
    rewrite: payload.compliant_rewrite ?? payload.rewrite ?? null,
    raw: payload,
  };
}

/** Build a callTool function against the gateway. Token: opts.token -> AD_STUDIO_GATEWAY_TOKEN -> minted for opts.lane
 *  (default env AD_STUDIO_GATEWAY_LANE or 'cto') via skills/gateway-connect. */
export function gatewayCaller({ token, lane = process.env.AD_STUDIO_GATEWAY_LANE || 'cto', fetchImpl = globalThis.fetch, mint } = {}) {
  let tokenPromise;
  const getToken = async () => {
    if (token) return token;
    if (process.env.AD_STUDIO_GATEWAY_TOKEN) return process.env.AD_STUDIO_GATEWAY_TOKEN;
    tokenPromise ??= (mint ? mint(lane) : import('../gateway-connect/connect.mjs').then((m) => m.mintToken(lane))).then((r) => r.token);
    return tokenPromise;
  };
  return async function callTool(name, args) {
    const bearer = await getToken();
    const res = await fetchImpl(GATEWAY_MCP, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`gateway HTTP ${res.status} calling ${name}`);
    const rpc = parseMcpBody(await res.text());
    if (!rpc) throw new Error('gateway returned an unparseable body');
    if (rpc.error) throw new Error(`gateway error: ${JSON.stringify(rpc.error).slice(0, 200)}`);
    return rpc;
  };
}

/**
 * Run claims_check over a list of {id, text, where}. Returns {ok, results[], errors[]}.
 * `callTool(name,args)` is injectable (tests). Each string is checked on its own, plus (if >1) the joined
 * voiceover + on-screen copy as ONE net-impression check.
 */
export async function checkClaims(items, { productClass, callTool, channel = 'ad', includeNetImpression = true, context }) {
  const errors = [];
  const results = [];
  const seen = new Map();
  const one = async (text) => {
    if (seen.has(text)) return seen.get(text);
    const p = (async () => parseVerdict(await callTool('claims_check', { text, channel, productClass, ...(context ? { context } : {}) })))();
    seen.set(text, p);
    return p;
  };
  const list = [...items];
  if (includeNetImpression && items.length > 1) list.push({ id: 'net-impression', where: 'all copy joined', text: items.map((i) => i.text).join(' ') });
  for (const it of list) {
    try {
      const v = await one(it.text);
      results.push({ ...it, verdict: v.verdict, riskScore: v.riskScore, violations: v.violations, rewrite: v.rewrite });
      if (v.verdict !== 'pass') {
        const phrases = (v.violations || []).map((x) => (typeof x === 'string' ? x : x.phrase || x.text || JSON.stringify(x))).slice(0, 3).join('; ');
        errors.push(`claims_check ${v.verdict.toUpperCase()} on ${it.where}: "${it.text.slice(0, 80)}"${phrases ? ` (${phrases})` : ''}${v.rewrite ? ` -> suggested: "${String(v.rewrite).slice(0, 100)}"` : ''}`);
      }
    } catch (e) {
      // fail closed
      results.push({ ...it, verdict: 'error', error: e.message });
      errors.push(`claims_check could not run on ${it.where} (${e.message}); failing closed`);
    }
  }
  return { ok: errors.length === 0, results, errors };
}
