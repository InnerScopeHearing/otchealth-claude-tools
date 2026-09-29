// Preloaded with `node --import` by elevenlabs-scripts.test.mjs. Replaces globalThis.fetch so the designer scripts
// (which run their work at import time and call process.exit) can be exercised end to end with ZERO network and ZERO
// credits. Every request is appended to $MOCK_LOG as one JSON line (the API key value is masked).
import { appendFileSync } from 'node:fs';

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const headers = { ...(init.headers || {}) };
  const sawKey = headers['xi-api-key'] === process.env.ELEVENLABS_API_KEY;
  delete headers['xi-api-key'];
  appendFileSync(process.env.MOCK_LOG, JSON.stringify({ url: u, method: init.method || 'GET', headers, sawKey, body: init.body ? JSON.parse(init.body) : null }) + '\n');
  if (u.includes('/v1/user/subscription')) return new Response(JSON.stringify({ tier: 'grant', character_count: 12, character_limit: 100 }), { status: 200, headers: { 'content-type': 'application/json' } });
  if (u === 'https://api.elevenlabs.io/v1/flows/video') return new Response(JSON.stringify({ id: 'gen_test', status: 'pending' }), { status: 200, headers: { 'content-type': 'application/json' } });
  if (u === 'https://api.elevenlabs.io/v1/flows/video/gen_test') return new Response(JSON.stringify({ status: 'completed', id: 'gen_test', content_url: 'https://cdn.example.test/video.mp4?sig=SECRET', content_mime_type: 'video/mp4' }), { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.startsWith('https://cdn.example.test/')) return new Response(Buffer.from('FAKE-MP4'), { status: 200 });
  if (u.includes('api.elevenlabs.io')) return new Response(Buffer.from('FAKE-AUDIO-BYTES'), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  return new Response('not mocked', { status: 500 });
};
