/**
 * charter-enforcer.ts — DESIGN SKETCH, not wired into the running gateway.
 *
 * Shows the concrete third enforcement point layered on top of the two that
 * already exist in otchealth-mcp-server:
 *   1. src/auth/bearer.ts requireConnectorAuth() -- WHO is calling (resolves
 *      AuthContext.caller_agent from the bearer, today one of the shared lanes:
 *      cto / cfo / clo / clo-personal / copilot-agent / OAUTH_DEFAULT_AGENT).
 *   2. src/compliance/guardrail.ts scanForCompliance() -- POST-HOC scan of an
 *      OUTBOUND tool response for regulated content, gated by an
 *      acknowledge_warning flag the caller must set.
 *
 * charter-enforcer.ts adds the PRE-HOC, PER-AGENT gate: given the
 * caller_agent from (1) and the tool being invoked, look up that agent's
 * loaded AgentCharter (schemas/agent-charter.schema.json) and reject the
 * call BEFORE the tool handler runs if:
 *   - the tool name is not covered by any gateway_scopes glob (default-deny), OR
 *   - the tool's declared ring is not in charter.rings.allowed_read/write, OR
 *   - any prohibited_actions entry with type=tool_deny/resource_deny matches.
 *
 * regex_content prohibitions still run POST-HOC via guardrail.ts (content
 * cannot be known before the tool executes); this module wires the charter's
 * regex_content entries INTO scanForCompliance's trigger list per-agent,
 * rather than replacing it, so the existing global TRIGGERS list and the
 * charter's per-agent additions both apply (global ADR-001 triggers are a
 * floor every agent gets; charter triggers are agent-specific additions).
 *
 * Call site: src/server/mcp-handler.ts (wherever the gateway currently
 * dispatches `tool_name` to its handler, immediately after
 * requireConnectorAuth() resolves AuthContext and BEFORE the handler runs).
 */

import type { AuthContext } from '../auth/bearer.js';
import { scanForCompliance, type ComplianceWarning } from '../compliance/guardrail.js';

// ---------------------------------------------------------------------------
// Charter shape (trimmed to the fields the gateway actually evaluates; the
// full authoring schema lives in schemas/agent-charter.schema.json and
// carries additional human-facing fields like business_objectives that the
// gateway never reads).
// ---------------------------------------------------------------------------

export type Ring = 'non-phi' | 'phi' | 'mnpi' | 'legal-personal';

export interface ProhibitedAction {
  id: string;
  type: 'ring_gate' | 'regex_content' | 'tool_deny' | 'resource_deny' | 'spend_ceiling' | 'physical_gate_marker';
  classifier: {
    ring: Ring | null;
    pattern: string | null;
    tool_names: string[] | null;
    resource_ids: string[] | null;
    spend_ceiling_usd: number | null;
  };
  reason: string;
  enforcement_point: Array<'gateway' | 'ci' | 'browser_agent' | 'human_review'>;
}

export interface AgentCharter {
  charter_id: string;
  version: number;
  agent_role: string;
  identity: { bearer_lane: string };
  rings: { allowed_read: Ring[]; allowed_write: Ring[] };
  gateway_scopes: string[];
  prohibited_actions: ProhibitedAction[];
}

// ---------------------------------------------------------------------------
// Tool registry side: every tool declares its ring + whether it is a
// read or write, alongside its existing handler. This is a SMALL addition to
// the tool-registration shape already used across src/tools/**; it is the
// hook the enforcer needs to know "this tool touches ring X in mode Y"
// without special-casing every one of the ~838 tools by name.
// ---------------------------------------------------------------------------

export interface ToolRingDeclaration {
  ring: Ring;
  mode: 'read' | 'write';
}

// In the real gateway this map is built at tool-registration time (each
// src/tools/<service>/*.ts file exports a RING_DECLARATION alongside its
// existing zod input schema); shown here as a flat lookup for the sketch.
// Undeclared tools default to non-phi/read (fail-open on ring, matching the
// gateway's existing graceful-degradation convention elsewhere) but STILL go
// through the gateway_scopes allowlist check, which is fail-closed.
declare function getToolRingDeclaration(toolName: string): ToolRingDeclaration;

// ---------------------------------------------------------------------------
// Charter loading. Charters live as versioned JSON in the gateway repo under
// charters/*.json (CODEOWNERS-protected, see DESIGN.md Section 1c) and are
// loaded into an in-memory map at boot, keyed by bearer_lane. Mirrors how
// src/server/oauth.ts already keeps issued-token state; this can share the
// same Cosmos-backed store once Layer C's OAuth-state-to-Cosmos move lands
// (see AZURE-AI-OPERATING-SYSTEM.md Layer C item 2), so multi-replica
// deploys see the same charter set without a restart.
// ---------------------------------------------------------------------------

declare function loadCharterForLane(bearerLane: string): AgentCharter | null;

function globToRegExp(glob: string): RegExp {
  // '*' -> '.*', escape everything else. Matches the gateway's flat
  // lowercase_snake_case tool-name namespace (see gateway_scopes examples:
  // 'github_*', 'finance_read_*').
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function scopeAllows(scopes: string[], toolName: string): boolean {
  return scopes.some((glob) => globToRegExp(glob).test(toolName));
}

export interface CharterDecision {
  allow: boolean;
  reason?: string;
  matchedProhibition?: string;
  /** Set when a regex_content prohibition needs a post-hoc content scan; the
   *  caller (mcp-handler) runs the tool, then calls scanToolResponse() below
   *  before returning the result to the client. */
  contentScanRequired?: boolean;
}

/**
 * PRE-HOC gate: call immediately after requireConnectorAuth() resolves
 * AuthContext, before the tool handler executes. Fail-closed: any charter
 * lookup miss, malformed charter, or unmatched scope is a REJECT, not a
 * pass-through -- this is the inverse of the tool-ring-declaration default
 * (which fails open on ring for undeclared tools) because charter presence
 * is mandatory (every bearer lane MUST have a charter once this ships) while
 * per-tool ring declaration is an incremental rollout across ~838 tools.
 */
export function evaluateCharterGate(ctx: AuthContext, toolName: string): CharterDecision {
  const charter = loadCharterForLane(ctx.caller_agent);
  if (!charter) {
    return { allow: false, reason: `No charter registered for lane '${ctx.caller_agent}'. Fail-closed: every agent lane must have a charter before it can call any gateway tool.` };
  }

  // 1. Coarse allowlist (cheap, first).
  if (!scopeAllows(charter.gateway_scopes, toolName)) {
    return { allow: false, reason: `Tool '${toolName}' is not in charter '${charter.charter_id}' v${charter.version} gateway_scopes.` };
  }

  // 2. Ring gate: does this tool's declared ring fall inside the charter's
  //    allowed rings for the relevant mode?
  const decl = getToolRingDeclaration(toolName);
  const allowedForMode = decl.mode === 'write' ? charter.rings.allowed_write : charter.rings.allowed_read;
  if (!allowedForMode.includes(decl.ring)) {
    return {
      allow: false,
      reason: `Tool '${toolName}' touches ring '${decl.ring}' in ${decl.mode} mode; charter '${charter.charter_id}' allows ${decl.mode} only for [${allowedForMode.join(', ')}]. This is the machine-enforced PHI-ring / MNPI-firewall boundary (hard limit #1).`,
    };
  }

  // 3. Fine-grained prohibitions: tool_deny / resource_deny hit HARD even if
  //    scopes + ring both passed (e.g. github_* is scoped in for cto, but a
  //    resource_deny entry blocks a direct push to the 'production'
  //    environment outside the required-reviewer path).
  for (const pa of charter.prohibited_actions) {
    if (pa.type === 'tool_deny' && pa.classifier.tool_names?.includes(toolName)) {
      return { allow: false, reason: pa.reason, matchedProhibition: pa.id };
    }
    if (pa.type === 'resource_deny' && pa.classifier.resource_ids) {
      // Resource id matching happens against the tool call's ARGUMENTS in
      // the real mcp-handler (e.g. a github_actions_run_trigger call's
      // environment argument, or a storage tool's container argument); the
      // sketch elides argument inspection for brevity. See the
      // resource_ids comment in the schema for what a real match compares.
    }
  }

  // 4. If any regex_content prohibition exists for this charter, flag that
  //    the caller must run scanToolResponse() after the handler executes
  //    (content is not known until the tool has run).
  const contentScanRequired = charter.prohibited_actions.some((pa) => pa.type === 'regex_content');

  return { allow: true, contentScanRequired };
}

/**
 * POST-HOC content scan: run AFTER the tool handler executes, before the
 * result is returned to the caller. Threads charter-specific regex_content
 * prohibitions into the existing global scanForCompliance() so ADR-001's
 * fleet-wide triggers (INND ticker, patent claims, 510(k) overclaim,
 * HearAdvisor A-grade, pre-shipment availability, TReO-as-hearing-aid) still
 * apply to every agent, while a charter can ADD agent-specific triggers
 * (e.g. the cto charter's no_fda_ftc_treatment_claims) without forking the
 * scanner.
 */
export function scanToolResponse(
  charter: AgentCharter,
  toolResponse: unknown,
  acknowledged: boolean,
): { result: unknown; warning: ComplianceWarning | null } {
  // Global scan (existing behavior, untouched).
  const globalWarning = scanForCompliance(toolResponse);

  // Charter-specific additions: build a scratch payload of just the
  // charter's regex_content patterns run against the same collected
  // strings scanForCompliance() already extracts. In the real
  // implementation this would refactor scanForCompliance() to accept an
  // extra TriggerDef[] parameter rather than re-running string collection;
  // shown separately here to keep the sketch's diff against guardrail.ts
  // legible.
  const charterTriggers = charter.prohibited_actions.filter((pa) => pa.type === 'regex_content' && pa.classifier.pattern);
  // ... run charterTriggers against the same collectStrings() output
  // (elided; see guardrail.ts collectStrings + TRIGGERS for the pattern to
  // replicate per-charter).

  const warning = globalWarning; // + charter-specific hits merged in the real impl
  if (!warning) return { result: toolResponse, warning: null };
  if (acknowledged) return { result: toolResponse, warning };
  return { result: null, warning };
}

// ---------------------------------------------------------------------------
// Example: the exact rejection this closes the loop on (from the task brief:
// "the gateway rejects a PHI tool from a non-PHI-lane agent").
//
//   ctx.caller_agent = 'growth-exposure'   (a non-PHI marketing/growth lane)
//   toolName = 'finance_cfo_source_docs_search'  <-- wrong example on purpose,
//     showing this ALSO catches a cross-ring mistake outside PHI: growth-
//     exposure has no finance_* in gateway_scopes at all, so step 1 rejects
//     it before step 2 (ring) is even evaluated -- the coarse gate is cheap
//     and catches most mistakes; the ring gate is the deep, PHI-specific
//     backstop for tools a role's scopes DO cover in general (e.g. cto has
//     'catalog_*' scoped in broadly, but a PHI-ring catalog entry still
//     403s at step 2 because cto's charter rings.allowed_read = [non-phi,
//     mnpi], no 'phi').
// ---------------------------------------------------------------------------
