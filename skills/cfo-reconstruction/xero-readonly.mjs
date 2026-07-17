#!/usr/bin/env node
// xero-readonly.mjs -- the SOLE chokepoint cfo-reconstruction uses to reach Xero, and it is
// STRUCTURALLY incapable of writing. Every Xero-touching call anywhere in this skill goes through
// callXeroReadOnly() below, which checks the requested gateway tool name against a hardcoded
// allowlist BEFORE any network call is made. The allowlist contains only tool names the gateway's
// own tool description labels "Read-only." The gateway's one write-capable Xero tool (method
// POST/PUT/DELETE against any Xero endpoint, the tool a caller would use to create/update/void a
// record) is deliberately never imported, never named as an allowed value, and never reachable from
// this file or anywhere else in this skill -- see tests/reconstruct.test.mjs's source-scan test,
// which fails the build if that changes.
//
// WHY this exists: this job's entire purpose is nightly ANALYSIS, never POSTING. Per Matt's
// 2026-07 directive, the CFO's multi-year financial-reconstruction analysis runs autonomously
// between check-ins so it keeps rolling forward, but every actual write to the books (anything that
// creates/changes/voids an INND, HearingAssist, OTCHealth, or personal financial record) stays
// gated to Matt's per-step sign-off through the CFO's own EXISTING, SEPARATE Xero-posting skill and
// its own already-scheduled Container Apps Job, both of which live in a DIFFERENT resource group
// from this job's otchealth-automation-rg (exact names are in runbooks/cfo-reconstruction-job.md,
// deliberately not spelled out in this file's source -- see the note below). Nothing in this file,
// this skill, or its Container Apps Job calls those, imports them, or shells out to them, and there
// is no flag or environment variable anywhere in this skill that turns a read into a write. If a
// future task genuinely needs this skill to post, that is a new, explicit, separately-reviewed code
// change to a NEW file, not a flag flip on this one.
//
// NOTE ON THIS COMMENT'S PHRASING: the posting skill's and posting job's literal names are
// intentionally never spelled out anywhere in this skill's own .mjs/.sh source (only in
// runbooks/cfo-reconstruction-job.md and SKILL.md, which are prose, not code this skill executes).
// tests/reconstruct.test.mjs's source-scan test asserts their exact substrings never appear in this
// skill's source, so a future edit that starts naming (and therefore inviting a call to) the posting
// path fails the build immediately, rather than relying on a human reviewer to notice.
//
// Auth: mints a short-lived "cfo" lane bearer via the fleet-shared gateway-connect client_credentials
// helper, then calls the gateway's JSON-RPC tools/call endpoint over HTTPS. Every allowlisted tool
// name below carries the gateway's own "Read-only." label in its tool description (verified against
// the live gateway tool schemas while building this skill):
//   xero_orgs, xero_accounts, xero_contacts, xero_invoices, xero_bank_transactions,
//   xero_credit_notes, xero_payments, xero_manual_journals, xero_attachments, xero_report,
//   xero_get (explicitly GET-only -- "so no path can mutate the books").
import { mintToken, GATEWAY_MCP } from "../gateway-connect/connect.mjs";

/** The complete, hardcoded allowlist. Adding a tool here is a deliberate source-code change (a PR a
 *  human reviews), never a runtime flag or env var. Frozen so it cannot be mutated at runtime. */
export const READ_ONLY_XERO_TOOLS = Object.freeze([
  "xero_orgs",
  "xero_accounts",
  "xero_contacts",
  "xero_invoices",
  "xero_bank_transactions",
  "xero_credit_notes",
  "xero_payments",
  "xero_manual_journals",
  "xero_attachments",
  "xero_report",
  "xero_get",
]);

/** Pure: true only for a tool name on the hardcoded read-only allowlist. No I/O, no exceptions. */
export function isReadOnlyXeroTool(name) {
  return typeof name === "string" && READ_ONLY_XERO_TOOLS.includes(name);
}

/** Low-level JSON-RPC call to the gateway. NOT exported -- every caller (inside or outside this
 *  file) must go through callXeroReadOnly() below so the allowlist check can never be bypassed by
 *  importing this helper directly. */
async function callGatewayTool(bearer, name, args) {
  const body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } };
  const r = await fetch(GATEWAY_MCP, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  let j;
  try { j = JSON.parse(txt); } catch { const m = txt.match(/data: (\{[\s\S]*\})/); j = m ? JSON.parse(m[1]) : { raw: txt.slice(0, 400) }; }
  const isError = !!(j && j.result && j.result.isError);
  const text = (j && j.result && j.result.content && j.result.content[0] && j.result.content[0].text) ?? JSON.stringify((j && j.result) || j);
  return { status: r.status, ok: r.ok && !isError, text };
}

/**
 * THE single entry point this skill uses to reach Xero. Throws (before any network call) for any
 * tool name not on READ_ONLY_XERO_TOOLS -- this is the structural enforcement of "this job never
 * writes to Xero", not a convention callers have to remember. `bearer` is a cfo-lane token from
 * cfoBearer()/mintToken("cfo"). `args` is forced to carry acknowledge_warning:true because this
 * skill's whole purpose is reading MNPI-flagged internal financial data for the CFO's own analysis
 * (Matt-approved automation, never sent externally, never leaves the cfo-ring data room) -- a
 * caller-supplied acknowledge_warning is always overridden, on purpose, not accidentally.
 */
export async function callXeroReadOnly(bearer, name, args = {}) {
  if (!isReadOnlyXeroTool(name)) {
    throw new Error(
      `REFUSED (read-only rail): "${name}" is not on the cfo-reconstruction read-only allowlist. ` +
      `This job never writes to Xero -- see skills/cfo-reconstruction/xero-readonly.mjs.`,
    );
  }
  const res = await callGatewayTool(bearer, name, { ...args, acknowledge_warning: true });
  if (!res.ok) throw new Error(`gateway tool ${name} failed: HTTP ${res.status} ${String(res.text).slice(0, 300)}`);
  try { return JSON.parse(res.text); } catch { return res.text; }
}

/** Mint the cfo-lane bearer this whole skill authenticates with. Thin re-export so every caller in
 *  this skill imports auth from this one file rather than reaching into gateway-connect directly. */
export async function cfoBearer() {
  const { token } = await mintToken("cfo");
  return token;
}
