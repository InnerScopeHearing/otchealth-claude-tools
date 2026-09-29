// _spend.mjs -- routes the single-shot ElevenLabs generators (gen-voiceover, gen-music, gen-sfx) through the ad-studio
// credit ledger. Backward compatible: these scripts still SPEND BY DEFAULT (--dry-run is their preview flag), but every real
// call now writes a before/after balance entry to ~/.cache/ad-studio/credit-ledger.jsonl, and if --max-credits N is given the
// estimate (or, for unmeasured rates, a conservative ceiling) must fit under it BEFORE anything is sent.
import { createClient } from '../../ad-studio/el-client.mjs';
import { formatPlan, planSpend, readLedger, SpendGuard } from '../../ad-studio/credit-guard.mjs';

/** true only for a bare flag or an explicit true/yes/1. `--flag false` / `--flag=0` are false. */
export const truthy = (v) => v === true || /^(true|yes|1)$/i.test(String(v ?? ''));

export function parseCap(args) {
    const v = args['max-credits'];
    if (v === undefined) return undefined;
    return Number(String(v).replace(/[,_]/g, ''));
}

/**
 * @param {object} o { job: credit-guard job, args: parsed CLI args, apiKey, generate: async () => Buffer }
 * Exits the process with code 2 when --max-credits is given and the plan does not fit.
 */
export async function guardedGenerate({ job, args, apiKey, generate }) {
    const cap = parseCap(args);
    if (cap !== undefined) {
        const plan = planSpend({ jobs: [job], commit: true, maxCredits: cap, allowUnknownRate: true, ledger: readLedger() });
        console.log(formatPlan(plan, { maxCredits: cap }));
        if (!plan.proceed) {
            for (const r of plan.reasons) console.error(`REFUSED: ${r}`);
            process.exit(2);
        }
    }
    const raw = createClient({ apiKey });
    // a failed balance read must never block a generation that the caller asked for; the guard then charges the bound
    const client = { balance: async () => { try { return await raw.balance(); } catch { return { used: NaN, limit: NaN, remaining: null }; } } };
    const guard = new SpendGuard({ client, maxCredits: cap, uncapped: cap === undefined, runId: `designer-${job.kind}-${Date.now()}` });
    return guard.run(job, generate);
}
