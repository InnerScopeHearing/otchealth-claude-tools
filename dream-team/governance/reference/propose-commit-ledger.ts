/**
 * propose-commit-ledger.ts — DESIGN SKETCH, generalizing the ALREADY-SHIPPED
 * deploy propose-vs-commit pattern to spend and to any other irreversible
 * action, on the SAME Cosmos work-ledger primitive (src/agentstate/ledger.ts,
 * src/agentstate/cosmos.ts) rather than inventing a second store.
 *
 * WHAT ALREADY EXISTS AND WORKS (verified in this repo, not hypothetical):
 *   - Deploys: .github/workflows/deploy.yml builds an immutable @sha256
 *     digest (the PROPOSE artifact), brings it up as a 0%-traffic GREEN
 *     revision, health-checks it, and only a human-gated 'production'
 *     GitHub Environment required-reviewer step (the COMMIT) shifts traffic.
 *     Separation of duties is enforced by GitHub itself (reviewer != opener).
 *   - Tasks: src/agentstate/ledger.ts completeTask() REJECTS unless
 *     artifact_uri RESOLVES (src/agentstate/resolver.ts) -- 'done' cannot be
 *     claimed without a landed, checkable artifact. This is already a
 *     propose(artifact)/commit(verify-then-mark-done) split, just not yet
 *     named that way or extended to spend.
 *
 * WHAT THIS SKETCH ADDS: a `spend_proposals` Cosmos container (same DB,
 * same createDoc/readDoc/replaceDoc/queryDocs primitives as ledger.ts) with
 * the identical claim/lease/complete shape as `tasks`, so an agent proposing
 * a $ amount and an agent committing it use the SAME mental model and the
 * SAME audit trail as an agent proposing a deploy digest and a human
 * committing traffic. One universal state machine:
 *
 *   PROPOSED --(commit, gated by charter.spend_authority)--> COMMITTED
 *            --(reject)--> REJECTED
 *
 * Every irreversible action in the fleet (deploy, spend, an INND-facing
 * publish, a DELETE against a production resource, a payment batch) is
 * modeled as a proposal in this shape. The COMMIT step's required approver
 * identity is read from the PROPOSER's AgentCharter.spend_authority
 * (schemas/agent-charter.schema.json), the same way deploy.yml's required
 * reviewer is a GitHub Environment setting rather than code -- the point in
 * both cases is that the gate lives in CONFIGURATION the proposer cannot
 * edit, not in a runtime check the proposer's own code could bypass.
 */

import { createDoc, readDoc, replaceDoc, queryDocs, newId } from '../agentstate/cosmos.js';
import type { AgentCharter } from './charter-enforcer.js';

const PROPOSALS = 'irreversible_proposals';
const EVENTS = 'irreversible_events'; // immutable audit trail, mirrors ledger.ts's EVENTS container

export type ProposalKind = 'spend' | 'deploy' | 'publish' | 'destructive_infra_change' | 'data_room_write';

export type ProposalStatus = 'proposed' | 'committed' | 'rejected' | 'expired';

export interface IrreversibleProposal {
  id: string;
  board: string; // partition key, default 'fleet' (mirrors ledger.ts Task.board)
  type: 'irreversible_proposal';
  kind: ProposalKind;
  proposer_agent: string; // charter.agent_role of the proposing agent
  proposer_charter_id: string;
  proposer_charter_version: number;
  /** The artifact under proposal. For a deploy this is the @sha256 digest ref
   *  (already produced by deploy.yml's 'Resolve immutable digest' step); for
   *  spend this is a structured { amount_usd, vendor, purpose, invoice_uri }
   *  object; for a publish it is the content URI + a diff. Always something
   *  concrete and re-checkable, never a free-text description alone --
   *  mirrors ledger.ts's rule that 'done' requires artifact_uri to RESOLVE.
   */
  artifact: Record<string, unknown>;
  amount_usd: number | null; // populated for kind='spend'; null otherwise
  status: ProposalStatus;
  /** Read from proposer's charter at proposal time and FROZEN onto the
   *  proposal (not re-read at commit time) so a later charter edit cannot
   *  retroactively change what approval a pending proposal needs -- this
   *  mirrors why deploy.yml pins the required-reviewer identity in the
   *  GitHub Environment config rather than in a mutable runtime field.
   */
  required_commit_approvers: string[];
  self_commit_ceiling_usd: number;
  proposed_at: string;
  proposed_reason: string;
  committed_by: string | null;
  committed_at: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  reject_reason: string | null;
  expires_at: string; // proposals that sit un-acted-on for too long auto-expire (mirrors ledger.ts LEASE_MINUTES, but longer -- default 72h for a spend/publish decision, vs 45min for a task claim)
}

async function appendEvent(proposalId: string, kind: string, actor: string, detail: string): Promise<void> {
  try {
    await createDoc(EVENTS, proposalId, {
      id: newId('ie'),
      type: 'event',
      proposal_id: proposalId,
      kind,
      actor,
      detail,
      ts: new Date().toISOString(),
    });
  } catch {
    /* best-effort, mirrors ledger.ts appendEvent */
  }
}

/**
 * PROPOSE: any agent may always propose, regardless of its own spend
 * authority -- proposing costs nothing and is not the irreversible step.
 * This mirrors 'anyone can open a PR' vs 'only the gated Environment step
 * can deploy it.'
 */
export async function propose(input: {
  kind: ProposalKind;
  proposerCharter: AgentCharter & { spend_authority: { propose_ceiling_usd: number; commit_approvers: string[] } };
  artifact: Record<string, unknown>;
  amountUsd?: number;
  reason: string;
  board?: string;
}): Promise<IrreversibleProposal> {
  const now = new Date();
  const board = (input.board || 'fleet').trim().toLowerCase();
  const proposal: IrreversibleProposal = {
    id: newId('ip'),
    board,
    type: 'irreversible_proposal',
    kind: input.kind,
    proposer_agent: input.proposerCharter.agent_role,
    proposer_charter_id: input.proposerCharter.charter_id,
    proposer_charter_version: input.proposerCharter.version,
    artifact: input.artifact,
    amount_usd: input.amountUsd ?? null,
    status: 'proposed',
    required_commit_approvers: input.proposerCharter.spend_authority.commit_approvers,
    self_commit_ceiling_usd: input.proposerCharter.spend_authority.propose_ceiling_usd,
    proposed_at: now.toISOString(),
    proposed_reason: input.reason,
    committed_by: null,
    committed_at: null,
    rejected_by: null,
    rejected_at: null,
    reject_reason: null,
    expires_at: new Date(now.getTime() + 72 * 3600_000).toISOString(),
  };
  await createDoc(PROPOSALS, board, proposal as unknown as Record<string, unknown>);
  await appendEvent(proposal.id, 'proposed', proposal.proposer_agent, `${input.kind}: ${input.reason}`);
  return proposal;
}

/**
 * COMMIT: the load-bearing gate. Rejects unless:
 *   (a) amount_usd (if kind='spend') is <= self_commit_ceiling_usd, in which
 *       case the PROPOSER may commit its own proposal (routine, budgeted,
 *       small spend -- e.g. finance-ops auto-committing a sub-$50 overage
 *       per its charter), OR
 *   (b) committerAgent is in required_commit_approvers AND committerAgent
 *       !== proposer_agent (separation of duties -- self-approval above the
 *       ceiling is STRUCTURALLY rejected here, the same invariant
 *       ci-sketch/charter-lint.mjs checks statically at charter-authoring
 *       time by refusing a charter that lists its own agent_role as a
 *       commit_approver).
 * This is the ONE function every irreversible action in the fleet should
 * route through once this ships -- deploy.yml's GitHub Environment reviewer
 * click is the DEPLOY-SPECIFIC instance of this same rule, enforced by
 * GitHub instead of this Cosmos container because a deploy's commit step
 * needs to gate an actual `az containerapp` traffic shift, not just record a
 * decision; spend/publish/destructive-infra proposals that do NOT already
 * have a purpose-built gate (like GitHub Environments) use this ledger as
 * their gate directly.
 */
export async function commit(
  proposalId: string,
  committerAgent: string,
  board = 'fleet',
): Promise<{ proposal?: IrreversibleProposal; rejected?: boolean; reason?: string }> {
  const hit = await readDoc(PROPOSALS, board, proposalId);
  if (!hit) return { rejected: true, reason: 'not found' };
  const proposal = hit.doc as unknown as IrreversibleProposal;

  if (proposal.status !== 'proposed') {
    return { rejected: true, reason: `proposal already ${proposal.status}` };
  }
  if (new Date(proposal.expires_at) < new Date()) {
    return { rejected: true, reason: 'proposal expired; re-propose with current facts' };
  }

  const amount = proposal.amount_usd ?? 0;
  const selfCommitOk =
    committerAgent === proposal.proposer_agent && amount <= proposal.self_commit_ceiling_usd;
  const gatedCommitOk =
    committerAgent !== proposal.proposer_agent && proposal.required_commit_approvers.includes(committerAgent);

  if (!selfCommitOk && !gatedCommitOk) {
    return {
      rejected: true,
      reason:
        amount > proposal.self_commit_ceiling_usd
          ? `Amount $${amount} exceeds proposer's self-commit ceiling $${proposal.self_commit_ceiling_usd}; commit must come from one of [${proposal.required_commit_approvers.join(', ')}] and must not be the proposer.`
          : `Committer '${committerAgent}' is not an authorized approver for this proposal (or is the proposer attempting self-approval outside its ceiling).`,
    };
  }

  const now = new Date().toISOString();
  proposal.status = 'committed';
  proposal.committed_by = committerAgent;
  proposal.committed_at = now;
  const res = await replaceDoc(PROPOSALS, board, proposalId, proposal as unknown as Record<string, unknown>, hit.etag ?? undefined);
  if (res.status === 412) return { rejected: true, reason: 'conflict, re-read and retry' };
  if (!res.ok) return { rejected: true, reason: `commit failed: ${res.status}` };
  await appendEvent(proposalId, 'committed', committerAgent, `amount=${amount}`);
  return { proposal };
}

export async function reject(
  proposalId: string,
  rejectorAgent: string,
  reason: string,
  board = 'fleet',
): Promise<{ proposal?: IrreversibleProposal; error?: string }> {
  const hit = await readDoc(PROPOSALS, board, proposalId);
  if (!hit) return { error: 'not found' };
  const proposal = hit.doc as unknown as IrreversibleProposal;
  if (proposal.status !== 'proposed') return { error: `already ${proposal.status}` };
  proposal.status = 'rejected';
  proposal.rejected_by = rejectorAgent;
  proposal.rejected_at = new Date().toISOString();
  proposal.reject_reason = reason;
  const res = await replaceDoc(PROPOSALS, board, proposalId, proposal as unknown as Record<string, unknown>, hit.etag ?? undefined);
  if (!res.ok) return { error: `reject failed: ${res.status}` };
  await appendEvent(proposalId, 'rejected', rejectorAgent, reason);
  return { proposal };
}

/** Escalation queue: what is waiting on a human/gated approver right now.
 *  This is the artifact the Coach / a daily-digest job reads to show Matt
 *  "N proposals pending your commit," instead of Matt having to remember to
 *  ask -- the same durable-state-over-chatter principle as cto-bridge and
 *  the portfolio status board. */
export async function listPendingCommits(approverAgent: string, board = 'fleet'): Promise<IrreversibleProposal[]> {
  const query = `SELECT * FROM c WHERE c.board = @board AND c.type = 'irreversible_proposal' AND c.status = 'proposed' AND ARRAY_CONTAINS(c.required_commit_approvers, @approver) ORDER BY c.proposed_at ASC`;
  const rows = await queryDocs(PROPOSALS, query, [{ name: '@board', value: board.trim().toLowerCase() }, { name: '@approver', value: approverAgent }], { pk: board, max: 100 });
  return rows as unknown as IrreversibleProposal[];
}
