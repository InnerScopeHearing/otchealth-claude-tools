// _azure.mjs — Azure media engines for the designer skill (data-plane,
// key-auth). Two engines:
//   - soraGenerateVideo()   → Sora 2 video via Azure OpenAI (gen-video --engine sora)
//   - ttsAvatarSynthesize() → photoreal talking avatar via Azure AI Speech
//                             batch synthesis (gen-avatar --engine azure)
//
// ⚠️ SCAFFOLD — these are wired to the documented contracts but have NOT been
// run against a live resource yet (no Azure keys in the vault at build time).
// Azure's Sora video API in particular is mid-transition (the old `sora` model
// retires Feb 2026; the path is migrating to /openai/v1/videos), so the Sora
// endpoint + model are configurable. Validate end-to-end when keys land.
//
// Note: these use the Azure *resource keys* (data-plane), NOT the Contributor
// service principal — the SP is for provisioning resources, not calling them.

import { randomUUID } from 'node:crypto';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Sora 2 video via Azure OpenAI async jobs API ─────────────────────
export async function soraGenerateVideo({
    creds, prompt, seconds, width, height, deployment,
    jobsPath = '/openai/v1/video/generations/jobs', maxPolls = 120, intervalMs = 5000,
    log = () => {},
}) {
    const base = creds.azureOpenAIEndpoint.replace(/\/+$/, '');
    const ver = creds.azureOpenAIApiVersion;
    const submitUrl = `${base}${jobsPath}?api-version=${ver}`;
    const submit = await fetch(submitUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': creds.azureOpenAIKey },
        body: JSON.stringify({
            model: deployment,
            prompt,
            height: String(height),
            width: String(width),
            n_seconds: String(seconds),
            n_variants: '1',
        }),
    });
    if (!submit.ok) throw new Error(`Sora submit ${submit.status}: ${await submit.text()}`);
    let result = await submit.json();
    const jobId = result.id;
    log(`  sora job: ${jobId}`);

    const done = (s) => ['succeeded', 'failed', 'cancelled'].includes(String(s || '').toLowerCase());
    let status = result.status;
    for (let i = 0; i < maxPolls && !done(status); i++) {
        await sleep(intervalMs);
        const pr = await fetch(`${base}${jobsPath}/${jobId}?api-version=${ver}`, {
            headers: { 'api-key': creds.azureOpenAIKey },
        });
        if (!pr.ok) continue;
        result = await pr.json();
        status = result.status;
        log(`  sora ${status}`);
    }
    if (String(status).toLowerCase() !== 'succeeded') {
        throw new Error(`Sora job ${status}: ${JSON.stringify(result).slice(0, 400)}`);
    }
    const genId = result.generations?.[0]?.id;
    if (!genId) throw new Error('Sora succeeded but no generation id in response.');
    const dl = await fetch(`${base}/openai/v1/video/generations/${genId}/content/video?api-version=${ver}`, {
        headers: { 'api-key': creds.azureOpenAIKey },
    });
    if (!dl.ok) throw new Error(`Sora download ${dl.status}: ${await dl.text()}`);
    return Buffer.from(await dl.arrayBuffer());
}

// ─── Photoreal talking avatar via Azure AI Speech batch synthesis ─────
export async function ttsAvatarSynthesize({
    creds, text, voice, character, style, background = '#FFFFFFFF',
    apiVersion = '2024-08-01', maxPolls = 120, intervalMs = 5000, log = () => {},
}) {
    const region = creds.azureSpeechRegion;
    const key = creds.azureSpeechKey;
    const jobId = randomUUID();
    const url = `https://${region}.api.cognitive.microsoft.com/avatar/batchsyntheses/${jobId}?api-version=${apiVersion}`;
    const body = {
        inputKind: 'PlainText',
        inputs: [{ content: text }],
        synthesisConfig: { voice },
        avatarConfig: {
            talkingAvatarCharacter: character,
            talkingAvatarStyle: style,
            videoFormat: 'mp4',
            backgroundColor: background,
        },
    };
    const create = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Ocp-Apim-Subscription-Key': key },
        body: JSON.stringify(body),
    });
    if (!create.ok) throw new Error(`TTS-Avatar create ${create.status}: ${await create.text()}`);
    let result = await create.json();
    let status = result.status;
    log(`  avatar job: ${jobId}`);

    for (let i = 0; i < maxPolls && !['Succeeded', 'Failed'].includes(status); i++) {
        await sleep(intervalMs);
        const pr = await fetch(url, { headers: { 'Ocp-Apim-Subscription-Key': key } });
        if (!pr.ok) continue;
        result = await pr.json();
        status = result.status;
        log(`  avatar ${status}`);
    }
    if (status !== 'Succeeded') {
        throw new Error(`TTS-Avatar ${status}: ${JSON.stringify(result).slice(0, 400)}`);
    }
    const out = result.outputs?.result;
    if (!out) throw new Error('TTS-Avatar succeeded but no output URL in response.');
    const dl = await fetch(out);
    if (!dl.ok) throw new Error(`TTS-Avatar download ${dl.status}`);
    return Buffer.from(await dl.arrayBuffer());
}
