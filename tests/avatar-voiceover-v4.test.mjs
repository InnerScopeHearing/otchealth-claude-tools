// avatar-pipeline/voiceover.py: the ElevenLabs request now follows the current model rules
// (eleven_v4 has ONLY stability + similarity_boost). Runs the real python module with requests.post stubbed:
// no network, no credits. Skipped when python3 or requests is unavailable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PIPE = join(dirname(fileURLToPath(import.meta.url)), '..', 'avatar-pipeline');
const probe = spawnSync('python3', ['-c', 'import requests'], { encoding: 'utf8' });
const T = { skip: probe.status === 0 ? false : 'python3 with requests not available' };

const py = (model) => `
import json, os, sys, tempfile
os.environ['ELEVENLABS_API_KEY']='k'; os.environ['ELEVENLABS_VOICE_ID']='vid'
${model ? `os.environ['ELEVENLABS_MODEL']='${model}'` : ''}
sys.path.insert(0, ${JSON.stringify(PIPE)})
import config, voiceover, requests
seen = {}
class R:
    status_code = 200
    content = b'AUDIO'
    ok = True
def fake_post(url, **kw):
    seen['url'] = url; seen['json'] = kw['json']; return R()
requests.post = fake_post
voiceover.synthesize_segment('hello', os.path.join(tempfile.mkdtemp(), 'o.mp3'))
print(json.dumps({'model': config.ELEVENLABS_MODEL, 'body': seen['json'], 'url': seen['url']}))
`;
const run = (model) => { const r = spawnSync('python3', ['-c', py(model)], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout.trim().split('\n').pop()); };

test('avatar-pipeline voiceover: default model is eleven_v4 and voice_settings drops style/speaker boost', T, () => {
  const r = run(null);
  assert.equal(r.model, 'eleven_v4');
  assert.equal(r.body.model_id, 'eleven_v4');
  assert.deepEqual(Object.keys(r.body.voice_settings).sort(), ['similarity_boost', 'stability']);
  assert.equal(r.url, 'https://api.elevenlabs.io/v1/text-to-speech/vid');
});
test('avatar-pipeline voiceover: an older model set through ELEVENLABS_MODEL keeps the legacy four-field settings', T, () => {
  const r = run('eleven_v3');
  assert.equal(r.body.model_id, 'eleven_v3');
  assert.equal(r.body.voice_settings.style, 0.3);
});
