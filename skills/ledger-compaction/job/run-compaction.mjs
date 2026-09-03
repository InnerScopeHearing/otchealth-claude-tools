#!/usr/bin/env node
// ledger-compaction / job/run-compaction.mjs - scheduled runner glue.
//
// This is the ONLY part of ledger-compaction that touches object storage. It reads each agent's
// ledger (_MEMORY/<agent>.jsonl), runs the PURE compact.mjs against the in-memory rows (never
// touches the source blob), and writes the compacted markdown to a SEPARATE object next to the
// ledger, in the same room kb-memory already uses for its own derived artifact
// (_MEMORY/<agent>.md): here that is _MEMORY/<agent>.compacted.md, so a human reading the agent's
// memory folder finds the compacted summary right next to the live ledger and its rendered view,
// never overwriting either.
//
// STORAGE (ported to S3, 2026-09-03; supersedes the 2026-08-18 credential-gate fix below, which
// repaired ONLY the entry gate and left this file's actual storage calls pointed at dead Azure
// Blob). This file used to hand-roll an account-key SAS and talk to
// https://${acct}.blob.core.windows.net/... directly. Azure subscription 55c84f6b -- which held
// every one of the three storage accounts this file targets (otchealthcfodata, otchealthlegalstore,
// otchealthcommons) -- was permanently deleted 2026-08-13, so every one of those calls could only
// ever fail; each agent's failure was individually caught and logged, so the job as a whole still
// exited 0 every run -- a silent-success shape for a job that was doing nothing.
//
// The three (account, container) pairs this file's AGENTS map already used are ALL THREE already
// verified rows in skills/kb-memory/s3-blob.mjs's (account,container)->(bucket,keyPrefix) MIRROR
// table, so no new bucket mapping was needed: this port is the same shape already proven twice
// elsewhere in this exact cluster (skills/xero/xero-token.mjs, 2026-08-27; the FND-20260827-bcfc
// batch). getTextFromS3/putObjectToS3 replace the hand-rolled getText/putText/buildSas entirely; the
// same "never write back to the source ledger" discipline is unchanged (see compactOneAgent below).
//
// EXIT CODE (changed, 2026-09-03): a missing AWS credential on every path is still a genuine
// fail-open (exit 0) -- there is nothing this job could have done differently, and that condition
// was already true before Azure ever existed. But an agent that DOES have a credential and still
// cannot read or write its S3 room (an unreachable bucket, a 403, a genuinely misconfigured MIRROR
// row) is a real backend problem, not a transient blip to shrug off -- exactly the class of defect
// that let this job report "Succeeded" for weeks while doing nothing. The job still processes every
// agent even after one fails (one bad room must never stop the others), but if ANY agent failed for
// a reason other than "no ledger written yet" (a genuine, expected, quiet outcome), the process now
// exits non-zero with a clear summary line naming which agents failed and why.
//
// Run: node run-compaction.mjs [--agents cfo,clo,commons] [--dry-run]
import { compactLedger, parseLedgerText, renderMarkdown } from "../compact.mjs";
import { awsCredsPresent } from "../../kb-memory/aws-secret.mjs";
import { getTextFromS3, putObjectToS3 } from "../../kb-memory/s3-blob.mjs";

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DRY_RUN = argv.includes("--dry-run");
const ONLY = (val("--agents", "") || "").split(",").map((s) => s.trim()).filter(Boolean);

// Same three rooms skills/kb-memory/mem.mjs's Azure-era config used, now expressed directly as the
// (account, container) keys skills/kb-memory/s3-blob.mjs's MIRROR table already carries a verified
// row for -- no per-agent storage-account/key secret is needed any more (S3 auth resolves via the
// ECS task role / AWS env, the same chain every other ported skill in this cluster already uses).
const AGENTS = {
  cfo:     { account: "otchealthcfodata",    container: "cfo-source-docs" },
  clo:     { account: "otchealthlegalstore", container: "company" },
  commons: { account: "otchealthcommons",    container: "company-journal" },
};

async function compactOneAgent(agent, cfg) {
  const ledgerName = `_MEMORY/${agent}.jsonl`;
  const outName = `_MEMORY/${agent}.compacted.md`;

  // getTextFromS3 returns null ONLY on a genuine 404; it THROWS on anything else (a 403, an
  // unmapped room, a transport failure), so a real backend problem can never read as "nothing to
  // compact yet" -- that distinction is exactly what the exit-code change above depends on.
  const text = await getTextFromS3(cfg.account, cfg.container, ledgerName);
  if (text == null) return { agent, skipped: true, ok: true, reason: "ledger not found in S3 yet (nothing to compact)" };

  const { rows, errors } = parseLedgerText(text);
  const result = compactLedger(rows);
  const md = renderMarkdown(result, `${agent} ledger (_MEMORY/${agent}.jsonl)`);

  if (!DRY_RUN) {
    // Write ONLY the separate compacted artifact. Never write back to ledgerName: the source ledger
    // object is read-only from this job's point of view.
    await putObjectToS3(cfg.account, cfg.container, outName, md, "text/markdown; charset=utf-8");
  }
  return { agent, skipped: false, ok: true, stats: result.stats, parseErrors: errors.length, outName, dryRun: DRY_RUN };
}

async function main() {
  const aws = awsCredsPresent();
  if (!aws.any) {
    console.error(
      "[ledger-compaction] no AWS credential on any path (no ECS task role, no AWS_ACCESS_KEY_ID/SECRET, " +
      "no OTC_AWS_ACCESS_KEY_ID/SECRET). Fail-open: exiting 0, nothing compacted this run.",
    );
    return;
  }

  const targets = ONLY.length ? ONLY.filter((a) => AGENTS[a]) : Object.keys(AGENTS);
  const failures = [];
  for (const agent of targets) {
    try {
      const outcome = await compactOneAgent(agent, AGENTS[agent]);
      console.log(`[ledger-compaction] ${agent}: ${JSON.stringify(outcome)}`);
    } catch (e) {
      // Still fail-open PER AGENT (one room's trouble never stops the others), but the failure is
      // now tracked so the process as a whole can report it truthfully instead of exiting 0 no
      // matter what happened -- see the EXIT CODE note at the top of this file.
      console.error(`[ledger-compaction] ${agent}: FAILED (${e.message}); skipping, continuing with remaining agents.`);
      failures.push({ agent, message: e.message });
    }
  }

  if (failures.length) {
    console.error(
      `[ledger-compaction] ${failures.length}/${targets.length} agent(s) FAILED -- an unreachable or ` +
      `misconfigured S3 room, not the normal "no ledger yet" case: ` +
      failures.map((f) => `${f.agent} (${f.message})`).join("; ") +
      ". Exiting non-zero: this is a real backend problem and must never report as a silent ok.",
    );
    process.exitCode = 1;
  }
}

main().catch((e) => {
  // Last-resort catch for a genuinely unexpected bug in this file's own control flow (argument
  // parsing, an import failure), NOT for a per-agent S3 failure -- those are caught and counted
  // above and exit non-zero on their own. This remains fail-open: a scheduled run should not be
  // marked failed by a bug this job cannot itself act on differently.
  console.error(`[ledger-compaction] unexpected error: ${e.message}. Fail-open: exiting 0.`);
});
