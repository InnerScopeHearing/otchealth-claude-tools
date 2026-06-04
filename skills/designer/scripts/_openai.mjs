// _openai.mjs — direct OpenAI media helpers. Currently: Sora 2 video via the
// OpenAI Videos API (validated live 2026-06-04). Used by gen-video.mjs as the
// primary video engine.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Create a Sora video job, poll to completion, download the MP4 bytes.
// model: sora-2 (default) | sora-2-pro. size is "WxH" (e.g. 1280x720).
// seconds is a string OpenAI accepts (sora-2: "4" | "8" | "12").
export async function openaiGenerateVideo({
    key, org, prompt, seconds, size, model = 'sora-2',
    maxPolls = 180, intervalMs = 5000, log = () => {},
}) {
    const headers = {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...(org ? { 'OpenAI-Organization': org } : {}),
    };
    const submit = await fetch('https://api.openai.com/v1/videos', {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, prompt, seconds: String(seconds), size }),
    });
    if (!submit.ok) throw new Error(`Sora submit ${submit.status}: ${await submit.text()}`);
    let job = await submit.json();
    log(`  sora job: ${job.id}`);

    for (let i = 0; i < maxPolls && job.status !== 'completed' && job.status !== 'failed'; i++) {
        await sleep(intervalMs);
        const r = await fetch(`https://api.openai.com/v1/videos/${job.id}`, { headers: { Authorization: `Bearer ${key}` } });
        if (!r.ok) continue;
        job = await r.json();
        log(`  sora ${job.status}${job.progress != null ? ` ${job.progress}%` : ''}`);
    }
    if (job.status !== 'completed') {
        throw new Error(`Sora job ${job.status}: ${JSON.stringify(job.error || job).slice(0, 300)}`);
    }
    const c = await fetch(`https://api.openai.com/v1/videos/${job.id}/content`, { headers: { Authorization: `Bearer ${key}` } });
    if (!c.ok) throw new Error(`Sora download ${c.status}: ${await c.text()}`);
    return Buffer.from(await c.arrayBuffer());
}
