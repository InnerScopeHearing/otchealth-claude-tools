// DRAFT SKELETON — HTTP-triggered starter, replacing the cron trigger on the 4 Container Apps
// Jobs. Uses a deterministic, minute-scoped instance ID so a duplicate kick within the same
// minute is a no-op (single-execution-per-instance-ID semantics), which is the built-in
// replacement for the hand-rolled ACTIVE-CTO-THREAD mutex pattern used elsewhere in the fleet
// for humans. Instance ID max length 100 chars, printable ASCII, cannot start with '@' — this
// convention is well under that.

const { app } = require('@azure/functions');
const df = require('durable-functions');

app.http('librarianStarter', {
  route: 'orchestrators/librarianFanOut',
  methods: ['POST'],
  extraInputs: [df.input.durableClient()],
  handler: async (request, context) => {
    const client = df.getClient(context);
    const now = new Date();
    const minuteStamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, ''); // yyyyMMddHHmm
    const instanceId = `librarian-fanout-${minuteStamp}`;

    const existing = await client.getStatus(instanceId);
    if (existing && ['Running', 'Pending'].includes(existing.runtimeStatus)) {
      context.log(`Instance ${instanceId} already ${existing.runtimeStatus}; not starting a duplicate.`);
      return client.createCheckStatusResponse(request, instanceId);
    }

    await client.startNew('librarianFanOut', { instanceId });
    context.log(`Started librarian fan-out orchestration with ID = '${instanceId}'.`);
    return client.createCheckStatusResponse(request, instanceId);
  },
});

// NOTE ON SCHEDULING: this HTTP starter is designed to be called either (a) manually via
// workflow_dispatch / curl for the pilot phase (see README.md step 5), or (b) on a Timer trigger
// once proven — a plain `app.timer('librarianFanOutTimer', { schedule: '0 0 * * * *', handler:
// ... call the same startNew logic ... })` replaces cron identically, but is deliberately NOT
// wired in this draft so the pilot stays side-by-side with the existing Container Apps Jobs
// cron rather than racing them for the same rooms on day one.
