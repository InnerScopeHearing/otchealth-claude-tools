#!/usr/bin/env node
// monitor.mjs -- the customer-safety escalation monitor. Detection and internal alerting ONLY: it
// reads Intercom conversations, tags a match with the existing "safety-escalation" tag, and publishes
// one alert to a human via AWS SNS. It never contacts a customer in any way, by any channel, under any
// condition -- see "THE HARD RULE" below and skills/safety-monitor/tests/no-customer-writes.test.mjs,
// which greps this very file for the endpoint/helper shapes that would violate it and fails the build
// if any appear.
//
// WHY THIS EXISTS. Real-time safety-escalation tagging ran on an n8n workflow that died with the
// Azure loss on 2026-08-13 and has no recoverable source anywhere -- this is a rebuild, not a restore
// (see FND-20260902-81bc). Evidence of the gap: the Intercom tag "safety-escalation" (id 15837481)
// was applied to 5 conversations in the 30 days before the loss and to exactly 1 since, while 77
// customer conversations were created in that same post-loss window.
//
// THE HARD RULE. The predecessor workflow auto-replied to a customer, and that caused real harm: a
// bare keyword-stem match on the single word "physician" hit marketing spam mentioning the brand
// "Physician's Choice", and the workflow sent a real message telling a non-customer to stop wearing a
// device they never owned. This file's job stops at detection, tagging, and alerting a human -- it
// never sends anything to a customer, by design and structurally: there is no import, no helper, and
// no endpoint call anywhere below the reply endpoint, the message-send endpoint, or any similarly
// shaped write. If a future edit ever needs one of those for a DIFFERENT feature, it belongs in a
// different file, reviewed on its own terms -- not here.
//
// CLASSIFICATION. See classify.mjs for the full design rationale (word-boundary phrases only, no bare
// common-noun triggers, brand-context suppression, precision-biased). This file only decides WHICH
// text gets classified: customer-authored content only (source message + conversation parts whose
// author type is user/lead/contact), never an admin/teammate reply or internal note -- admin apology
// boilerplate ("sorry you were hurt") would otherwise be a rich false-positive source on these exact
// rules. A staff phone-call note paraphrasing a customer's verbal report is therefore NOT scanned by
// this version; that is a known, documented limitation (see SKILL.md), not an oversight.
//
// DISCOVERY, and why it is TWO independent paths reconciled, not one. FND-20260817-64f5 (see
// ../../FINDINGS-LEDGER.md) documents /conversations/search MISSING real safety-tagged conversations
// inside the exact window a daily check queried, and separately returning an empty result set for one
// specific conversation despite a nonzero total_count on the same query -- direct GET by id always
// worked. So discovery here NEVER relies on search alone: it unions conversation ids found by the
// direct list endpoint (GET /conversations, paginated) with ids found by /conversations/search over
// the same window, logs any conversation one path found and the other did not (a live signal that the
// documented gap is still present, or has moved), and then always re-fetches full detail for every id
// in the union via direct GET -- the one path both this file's own live testing and the finding agree
// is reliable.
//
// IDEMPOTENCY. There is no separate "last run" state store. A conversation already carrying the
// safety-escalation tag is skipped outright (see alreadyTagged() below) -- so a generous, overlapping
// lookback window on every run is cheap and safe: re-scanning an already-handled conversation costs a
// few extra reads and produces no duplicate tag or alert.
//
// PRIVACY. Conversation ids, matched rule ids/categories, and action taken are logged to stdout. A
// truncated (<=120 char) quote of the matched customer text is NEVER printed to stdout -- it exists
// only inside the one SNS message built for an actual match, and only when --commit is set.
//
// Usage:
//   node monitor.mjs [sweep] [--commit] [--json] [--hours=N] [--max-pages=N]
//   node monitor.mjs verify [--json]              (auth + tag-id sanity check only, no conversation scan)
//
// --commit is required for BOTH the Intercom tag write and the SNS publish -- the default is a pure
// read: every conversation that would be tagged and alerted is reported as "WOULD TAG+ALERT (dry
// run)" and nothing is written or published.

import { kvSecret } from "../kb-memory/azure-secret.mjs";
import { awsRequest } from "../kb-memory/sigv4.mjs";
import { classify, stripHtml, truncateSnippet } from "./classify.mjs";

// ---- constants (overridable via env for testing/ops; never via CLI flags -- these identify WHICH
//      tag/topic/workspace this monitor acts on, not a per-run tuning knob) ------------------------
export const SAFETY_TAG_ID = process.env.SAFETY_MONITOR_TAG_ID || "15837481";
export const SAFETY_TAG_NAME = (process.env.SAFETY_MONITOR_TAG_NAME || "safety-escalation").toLowerCase();
export const INTERCOM_VERSION = "2.11";
export const INTERCOM_WORKSPACE_ID = process.env.SAFETY_MONITOR_WORKSPACE_ID || "budq9yib";
export const SNS_TOPIC_ARN = process.env.SAFETY_MONITOR_SNS_TOPIC_ARN || "arn:aws:sns:us-east-1:900915535335:otchealth-alerts";
export const SNS_REGION = process.env.SAFETY_MONITOR_SNS_REGION || "us-east-1";
export const DEFAULT_HOURS_BACK = Number(process.env.SAFETY_MONITOR_HOURS_BACK || 72);
export const DEFAULT_MAX_PAGES = Number(process.env.SAFETY_MONITOR_MAX_PAGES || 20);
export const DEFAULT_PER_PAGE = 50;

const CUSTOMER_AUTHOR_TYPES = new Set(["user", "lead", "contact"]);

// ---- forbidden-customer-write self-scan (constraint #1's own pin) ---------------------------------
// A small, explicit table -- each entry names an Intercom endpoint SHAPE or helper-name shape that
// would let this monitor contact a customer. scanForbiddenCustomerWrites() greps arbitrary source text
// for these; the test suite runs it against this file's OWN contents and fails the build if anything
// matches, and separately proves the scanner is not vacuous by running it against synthetic bad
// snippets built to trip each pattern. See SKILL.md for the concrete endpoint/tool names this guards
// against -- deliberately not spelled out here, so describing them does not itself trip the scan.
export const FORBIDDEN_CUSTOMER_WRITE_PATTERNS = [
  { id: "reply-path", pattern: /\/conversations\/[^"'`\s)]*\/reply\b/i, why: "a path shaped like Intercom's reply-to-a-conversation endpoint" },
  { id: "reply-fn-name", pattern: /\breply[-_]?conversation\b/i, why: "a reply-to-conversation helper or tool name" },
  { id: "new-message-path", pattern: /["'`]\/messages\b/i, why: "a path shaped like Intercom's message-creation endpoint" },
  { id: "new-conversation-helper", pattern: /\bcreate[-_]?conversation\b/i, why: "a helper or tool name that originates a new conversation" },
  { id: "outbound-message-helper", pattern: /\bsend[-_]?message\b/i, why: "a generic send-a-message helper name" },
];

export function scanForbiddenCustomerWrites(sourceText) {
  const hits = [];
  for (const p of FORBIDDEN_CUSTOMER_WRITE_PATTERNS) {
    const m = p.pattern.exec(String(sourceText || ""));
    if (m) hits.push({ id: p.id, why: p.why, match: m[0] });
  }
  return hits;
}

// ---- Intercom I/O (the one place that touches the network for Intercom) ---------------------------

let _cachedToken = null;
async function intercomToken() {
  if (_cachedToken) return _cachedToken;
  const tok = await kvSecret("intercom-access-token");
  if (!tok) throw new Error("intercom-access-token is not resolvable from the secret store (SSM /otchealth/intercom-access-token)");
  _cachedToken = tok;
  return tok;
}

/** The sole default Intercom HTTP transport. Every caller in this file goes through the injectable
 *  `intercomRequest` parameter so tests can supply canned responses with zero network access; this is
 *  simply what that parameter defaults to in real use. Never throws -- a transport-level failure comes
 *  back as { ok:false, status:0, error }, same shape as an HTTP-level failure, so callers have one
 *  branch to handle either. */
export async function defaultIntercomRequest(path, { method = "GET", body } = {}) {
  let token;
  try {
    token = await intercomToken();
  } catch (e) {
    return { ok: false, status: 0, json: null, text: null, error: String((e && e.message) || e) };
  }
  try {
    const r = await fetch(`https://api.intercom.io${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Intercom-Version": INTERCOM_VERSION,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { ok: r.ok, status: r.status, json, text, error: r.ok ? null : `http-${r.status}` };
  } catch (e) {
    return { ok: false, status: 0, json: null, text: null, error: `transport-error: ${String((e && e.message) || e)}` };
  }
}

/** Confirm the tag id we are about to apply still resolves to the expected name, per the locked
 *  design ("hardcode with a startup assertion that the id still resolves to that name") -- refuses to
 *  proceed under a possibly-repurposed or deleted tag id, rather than silently tagging under the wrong
 *  meaning. */
export async function verifySafetyTag(intercomRequest) {
  const res = await intercomRequest("/tags");
  if (!res.ok) return { ok: false, error: `GET /tags failed: ${res.error || `http-${res.status}`}` };
  const list = res.json?.data || res.json?.tags || [];
  const tag = list.find((t) => String(t.id) === String(SAFETY_TAG_ID));
  if (!tag) return { ok: false, error: `tag id ${SAFETY_TAG_ID} was not found in GET /tags -- it may have been deleted or the id is wrong` };
  if (String(tag.name || "").trim().toLowerCase() !== SAFETY_TAG_NAME) {
    return { ok: false, error: `tag id ${SAFETY_TAG_ID} now resolves to name "${tag.name}", expected "${SAFETY_TAG_NAME}" -- refusing to tag under a possibly-repurposed id` };
  }
  return { ok: true, tag };
}

/** Direct-list discovery: GET /conversations, paginated. Conversations were confirmed live (2026-09-02)
 *  to come back newest-first by created_at; this still verifies descending order as it goes rather
 *  than assuming it, and only takes the early-stop shortcut while that has held for every item seen so
 *  far in this run -- if the order is ever NOT strictly descending, it keeps paging to the max-pages
 *  cap instead of risking a silent miss. */
export async function listConversationIds({ intercomRequest, sinceEpochSeconds, maxPages = DEFAULT_MAX_PAGES, perPage = DEFAULT_PER_PAGE }) {
  const ids = new Set();
  const errors = [];
  let cursor = null;
  let pages = 0;
  let lastCreatedAt = Infinity;
  let stillDescending = true;
  let stop = "cap"; // overwritten by whichever break fires first; "cap" means the while condition ended it
  do {
    pages++;
    const qs = new URLSearchParams({ per_page: String(perPage) });
    if (cursor) qs.set("starting_after", cursor);
    const res = await intercomRequest(`/conversations?${qs.toString()}`);
    if (!res.ok) {
      errors.push(`list page ${pages}: ${res.error || `http-${res.status}`}`);
      break;
    }
    const convos = res.json?.conversations || [];
    if (convos.length === 0) break;
    let allBelowWindow = true;
    for (const c of convos) {
      if (typeof c.created_at === "number") {
        if (c.created_at > lastCreatedAt) stillDescending = false;
        lastCreatedAt = c.created_at;
      }
      if (typeof c.created_at === "number" && c.created_at >= sinceEpochSeconds) {
        ids.add(String(c.id));
        allBelowWindow = false;
      }
    }
    const next = res.json?.pages?.next;
    cursor = (next && next.starting_after) || (typeof next === "string" ? next : null);
    if (!cursor) { stop = "exhausted"; break; }
    if (allBelowWindow && stillDescending) { stop = "past-window"; break; } // safe early stop: every item on this page was older than the window, and order has held descending the whole way
  } while (pages < maxPages);
  // Warn ONLY when the cap is what cut us short. The old condition was `pages >= maxPages`, which
  // also fired when the final allowed page legitimately had no next cursor -- a complete result set
  // that happened to end exactly on the limit was reported as a failure. An explicit stop reason
  // says why the loop ended instead of inferring it from a counter.
  if (stop === "cap" && cursor) {
    errors.push(`list: hit the ${maxPages}-page safety cap with more history still to read -- the window is INCOMPLETE; raise --max-pages`);
  }
  return { ids, pages, errors };
}

/** Search discovery: POST /conversations/search over the same window, paginated. Kept as an
 *  independent SECOND path per FND-20260817-64f5 (see this file's header) -- never the sole source of
 *  discovery, always unioned with listConversationIds() above. */
export async function searchConversationIds({ intercomRequest, sinceEpochSeconds, maxPages = DEFAULT_MAX_PAGES }) {
  const ids = new Set();
  const errors = [];
  let cursor = null;
  let pages = 0;
  let stop = "cap";
  do {
    pages++;
    const body = { query: { field: "created_at", operator: ">", value: sinceEpochSeconds } };
    if (cursor) body.pagination = { per_page: DEFAULT_PER_PAGE, starting_after: cursor };
    const res = await intercomRequest("/conversations/search", { method: "POST", body });
    if (!res.ok) {
      errors.push(`search page ${pages}: ${res.error || `http-${res.status}`}`);
      break;
    }
    const convos = res.json?.conversations || [];
    for (const c of convos) ids.add(String(c.id));
    const next = res.json?.pages?.next;
    cursor = (next && next.starting_after) || (typeof next === "string" ? next : null);
    if (!cursor || convos.length === 0) { stop = "exhausted"; break; }
  } while (pages < maxPages);
  // This warning did not exist. listConversationIds had one and this path did not, so a search
  // discovery truncated by the page cap produced an otherwise clean, successful sweep -- incomplete
  // discovery on a customer-safety monitor, reported as a good run. Both discovery paths must fail
  // loud for the union to mean anything, since the whole point of running two is that either may
  // miss something (FND-20260817-64f5).
  if (stop === "cap" && cursor) {
    errors.push(`search: hit the ${maxPages}-page safety cap with more results still to read -- discovery is INCOMPLETE; raise --max-pages`);
  }
  return { ids, pages, errors };
}

/** Union list+search discovery and log any asymmetry -- the live signal that the documented search
 *  reliability gap is present on THIS run, in either direction. */
export async function discoverConversationIds({ intercomRequest, sinceEpochSeconds, maxPages, perPage, log = () => {} }) {
  const [listRes, searchRes] = await Promise.all([
    listConversationIds({ intercomRequest, sinceEpochSeconds, maxPages, perPage }),
    searchConversationIds({ intercomRequest, sinceEpochSeconds, maxPages }),
  ]);
  const ids = new Set([...listRes.ids, ...searchRes.ids]);
  const onlyInSearch = [...searchRes.ids].filter((id) => !listRes.ids.has(id));
  const onlyInList = [...listRes.ids].filter((id) => !searchRes.ids.has(id));
  if (onlyInSearch.length) {
    log(`[safety-monitor] reconciliation: ${onlyInSearch.length} conversation(s) found by search only (${onlyInSearch.join(",")}) -- both paths are consulted precisely because of this kind of gap`);
  }
  if (onlyInList.length) {
    log(`[safety-monitor] reconciliation: ${onlyInList.length} conversation(s) found by the direct list only (${onlyInList.join(",")}) -- consistent with the documented search reliability gap (FND-20260817-64f5)`);
  }
  return { ids, viaList: listRes.ids.size, viaSearch: searchRes.ids.size, errors: [...listRes.errors, ...searchRes.errors] };
}

export async function fetchConversationDetail(intercomRequest, id) {
  const res = await intercomRequest(`/conversations/${encodeURIComponent(id)}`);
  if (!res.ok) return { ok: false, error: `GET /conversations/${id} failed: ${res.error || `http-${res.status}`}` };
  return { ok: true, conversation: res.json };
}

export async function applyTag(intercomRequest, id) {
  const res = await intercomRequest(`/conversations/${encodeURIComponent(id)}/tags`, { method: "POST", body: { id: String(SAFETY_TAG_ID) } });
  if (!res.ok) return { ok: false, error: `tagging conversation ${id} failed: ${res.error || `http-${res.status}`}` };
  return { ok: true };
}

// ---- pure conversation evaluation (no I/O; unit-tested directly with fixture conversation objects) -

export function isCustomerAuthor(author) {
  return !!author && CUSTOMER_AUTHOR_TYPES.has(author.type);
}

export function isAlreadyTagged(conversation) {
  const tags = conversation?.tags?.tags || [];
  return tags.some((t) => String(t.id) === String(SAFETY_TAG_ID));
}

/** Every piece of CUSTOMER-authored text in a conversation, HTML-stripped, in the order the customer
 *  produced it (initial message, then replies). Admin/teammate/bot content is deliberately excluded --
 *  see this file's header comment. */
export function customerTexts(conversation) {
  const texts = [];
  const src = conversation?.source;
  if (src && isCustomerAuthor(src.author) && src.body) texts.push(stripHtml(src.body));
  const parts = conversation?.conversation_parts?.conversation_parts || [];
  for (const p of parts) {
    if (isCustomerAuthor(p.author) && p.body) texts.push(stripHtml(p.body));
  }
  return texts;
}

/**
 * Evaluate one already-fetched conversation detail object. Pure, synchronous, no I/O.
 * Returns { matched, alreadyTagged, matches, snippet }. `snippet` is the <=120-char truncated text of
 * the FIRST customer-authored message that matched (classify.mjs's own per-rule `.snippet` values,
 * inside `matches`, are shorter still -- just the matched phrase). Both are only ever consumed by the
 * SNS-publish step; neither is placed on the caller's persisted/printed summary.
 */
export function evaluateConversation(conversation) {
  if (isAlreadyTagged(conversation)) return { matched: false, alreadyTagged: true, matches: [], snippet: null };
  for (const text of customerTexts(conversation)) {
    const r = classify(text);
    if (r.matched) return { matched: true, alreadyTagged: false, matches: r.matches, snippet: truncateSnippet(text) };
  }
  return { matched: false, alreadyTagged: false, matches: [], snippet: null };
}

// ---- SNS alert (the only outbound side effect other than the Intercom tag write) -------------------

export function intercomConversationLink(id) {
  return `https://app.intercom.com/a/apps/${INTERCOM_WORKSPACE_ID}/conversations/${id}`;
}

function extractXmlTag(xml, tag) {
  const m = String(xml || "").match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1] : null;
}

export function buildAlertMessage({ id, matches, snippet, link }) {
  const rulesLine = matches.map((m) => `${m.id} (${m.category}): ${m.why}`).join("; ");
  return [
    "OTCHealth Safety Escalation detected -- automated, DETECTION-ONLY alert. No reply or other customer-facing action was taken.",
    "",
    `Conversation ID: ${id}`,
    `Matched rule(s): ${rulesLine}`,
    `Snippet: "${snippet}"`,
    `Intercom link: ${link}`,
    "",
    "A human should review this conversation in Intercom and decide next steps.",
  ].join("\n");
}

/** The default SNS publisher. Uses the shared sigv4.mjs signer (its first consumer, per
 *  FND-20260828-5ca1). SNS's classic Query API returns XML, not JSON -- extractXmlTag() pulls just the
 *  MessageId / error Code+Message this file needs out of it rather than adding an XML parser
 *  dependency for a two-field read. */
export async function defaultPublishSnsAlert(item) {
  const message = buildAlertMessage(item);
  const bodyStr = new URLSearchParams({
    Action: "Publish",
    Version: "2010-03-31",
    TopicArn: SNS_TOPIC_ARN,
    Subject: "OTCHealth Safety Escalation Alert",
    Message: message,
  }).toString();
  const res = await awsRequest({
    method: "POST",
    service: "sns",
    region: SNS_REGION,
    host: `sns.${SNS_REGION}.amazonaws.com`,
    path: "/",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: bodyStr,
  });
  if (res.status !== 200) {
    const code = extractXmlTag(res.text, "Code");
    const msg = extractXmlTag(res.text, "Message");
    return { ok: false, error: `SNS publish failed: ${res.reason || `http-${res.status}`}${code ? ` (${code}: ${msg || "no message"})` : ""}` };
  }
  return { ok: true, messageId: extractXmlTag(res.text, "MessageId") };
}

// ---- orchestration (dependency-injected; the default I/O implementations above are what a real
//      CLI invocation uses, but every test in tests/monitor-sweep.test.mjs supplies fakes instead) ---

/**
 * Run one sweep. Never throws (every failure becomes `errors` entries and `ok:false` on the returned
 * summary) and never calls process.exit -- the CLI entrypoint below owns that decision, exactly once,
 * from this function's `ok` field. `opts.commit` (default false) gates BOTH the Intercom tag write and
 * the SNS publish; without it this is a pure read that reports what it WOULD do.
 */
export async function runSweep(opts = {}) {
  const {
    commit = false,
    hoursBack = DEFAULT_HOURS_BACK,
    maxPages = DEFAULT_MAX_PAGES,
    perPage = DEFAULT_PER_PAGE,
    nowMs = () => Date.now(),
    intercomRequest = defaultIntercomRequest,
    publishSnsAlert = defaultPublishSnsAlert,
    // Injectable purely so tests/monitor-sweep.test.mjs can exercise the CLASSIFIER ERROR fail-loud
    // branch below deterministically (evaluateConversation() itself is designed never to throw on
    // ordinary input, so there is no natural way to trigger that branch without this seam). Every
    // real invocation uses the real evaluateConversation() from this file.
    evaluate = evaluateConversation,
    log = (msg) => console.log(msg),
  } = opts;

  const summary = { ok: true, commit, errors: [], scanned: 0, alreadyTagged: 0, matched: [], tagged: 0, alerted: 0 };

  // This function's contract is that it NEVER throws: every failure class comes back as a
  // summary.errors entry with summary.ok=false, so one broken dependency cannot abort a safety
  // sweep before the remaining conversations are examined. The per-conversation loop already
  // honours that, but the startup and discovery calls above it did not -- an injected or real
  // intercomRequest that THREW (rather than returning {ok:false}) escaped past the summary
  // entirely. The CLI's outer FATAL handler still exited non-zero, so this was never a silent
  // success, but it produced a bare stack instead of the documented per-failure report. Wrapping
  // the whole body keeps the contract true rather than merely claimed.
  try {
    return await sweepBody();
  } catch (e) {
    summary.ok = false;
    summary.errors.push(`UNEXPECTED: a dependency threw instead of returning a result: ${String((e && e.message) || e)}`);
    return summary;
  }

  async function sweepBody() {
  const tagCheck = await verifySafetyTag(intercomRequest);
  if (!tagCheck.ok) {
    summary.ok = false;
    summary.errors.push(`startup: ${tagCheck.error}`);
    return summary; // cannot proceed meaningfully without a confirmed tag id -- abort before any scan
  }

  const sinceEpochSeconds = Math.floor(nowMs() / 1000) - hoursBack * 3600;
  const discovery = await discoverConversationIds({ intercomRequest, sinceEpochSeconds, maxPages, perPage, log });
  summary.discovery = { viaList: discovery.viaList, viaSearch: discovery.viaSearch, union: discovery.ids.size, hoursBack };
  if (discovery.errors.length) {
    summary.ok = false;
    for (const e of discovery.errors) summary.errors.push(`discovery: ${e}`);
  }

  for (const id of discovery.ids) {
    summary.scanned++;
    const detail = await fetchConversationDetail(intercomRequest, id);
    if (!detail.ok) {
      summary.ok = false;
      summary.errors.push(`conversation ${id}: ${detail.error}`);
      continue;
    }

    let evalResult;
    try {
      evalResult = evaluate(detail.conversation);
    } catch (e) {
      summary.ok = false;
      summary.errors.push(`CLASSIFIER ERROR for conversation ${id}: ${String((e && e.message) || e)}`);
      continue;
    }

    // alreadyTagged must be checked BEFORE matched: evaluateConversation() returns matched:false for
    // its already-tagged short-circuit too (it never even looks at the text in that case), so testing
    // `!matched` first would swallow every already-tagged conversation into the generic "did not
    // match" path and this counter would never move -- caught by monitor-sweep.test.mjs's dry-run
    // assertion before this shipped.
    if (evalResult.alreadyTagged) {
      summary.alreadyTagged++;
      continue;
    }
    if (!evalResult.matched) continue;

    const ruleIds = evalResult.matches.map((m) => m.id);
    const link = intercomConversationLink(id);
    log(`[safety-monitor] MATCH conversation=${id} rules=${ruleIds.join(",")} action=${commit ? "TAG+ALERT" : "WOULD TAG+ALERT (dry run)"}`);
    // Deliberately no snippet field here (or anywhere in `summary`) -- see this file's header
    // "PRIVACY" note. The matched quote is used ONLY inside publishSnsAlert() below.
    summary.matched.push({ id, rules: ruleIds, link });

    if (!commit) continue;

    // ALERT FIRST, THEN TAG. This order is load-bearing; it was the other way round originally.
    //
    // The tag is what makes a conversation invisible to every future run -- isAlreadyTagged() short-
    // circuits it before the classifier ever sees the text. So if the tag lands and the alert then
    // fails, the escalation becomes permanently unalertable: marked as handled, no human ever told,
    // and every later run counting it under `alreadyTagged` exactly like one that WAS alerted. The
    // original run exits non-zero once, and after that the evidence is gone. For a customer-safety
    // monitor that is the worst available outcome, and it is silent.
    //
    // Alerting first inverts the failure into the safe direction: alert succeeds, tag fails -> the
    // conversation stays untagged, so the next run re-evaluates it, alerts AGAIN and retries the
    // tag. A human is told twice. A duplicate alert is a cheap, visible annoyance; a missed one is
    // precisely what this monitor exists to prevent. If the tag keeps failing (wrong or deleted tag
    // id) every run re-alerts and exits non-zero -- noisy and loud, the correct direction here.
    const alertRes = await publishSnsAlert({ id, matches: evalResult.matches, snippet: evalResult.snippet, link });
    if (!alertRes.ok) {
      summary.ok = false;
      summary.errors.push(`conversation ${id}: ${alertRes.error}`);
      continue; // left untagged on purpose, so the next run retries instead of burying it
    }
    summary.alerted++;

    const tagRes = await applyTag(intercomRequest, id);
    if (!tagRes.ok) {
      summary.ok = false;
      summary.errors.push(`${tagRes.error} (a human WAS alerted for conversation ${id}; the next run will alert again because the tag did not land)`);
      continue;
    }
    summary.tagged++;
  }

  return summary;
  }
}

// ---- CLI ---------------------------------------------------------------------------------------

function printReport(summary) {
  console.log(`# safety-monitor sweep -- mode=${summary.commit ? "COMMIT" : "DRY-RUN"}`);
  if (summary.discovery) {
    console.log(`  window: last ${summary.discovery.hoursBack}h -- found ${summary.discovery.viaList} via list, ${summary.discovery.viaSearch} via search, ${summary.discovery.union} unique`);
  }
  console.log(`  scanned: ${summary.scanned}  already-tagged: ${summary.alreadyTagged}  matched: ${summary.matched.length}  tagged: ${summary.tagged}  alerted: ${summary.alerted}`);
  for (const m of summary.matched) console.log(`  - conversation ${m.id}: rules=[${m.rules.join(",")}] ${m.link}`);
  if (!summary.commit && summary.matched.length) {
    console.log("  (dry-run: nothing was tagged, nothing was published. Pass --commit to act on the matches above.)");
  }
  if (summary.errors.length) {
    console.log(`  ERRORS (${summary.errors.length}):`);
    for (const e of summary.errors) console.log(`    - ${e}`);
  }
}

async function verifyOnly(json) {
  const meRes = await defaultIntercomRequest("/me");
  const tagCheck = await verifySafetyTag(defaultIntercomRequest);
  const ok = meRes.ok && tagCheck.ok;
  const result = { ok, me: meRes.ok ? { type: meRes.json?.type, app: meRes.json?.app, email: meRes.json?.email } : null, meError: meRes.ok ? null : meRes.error, tag: tagCheck.ok ? tagCheck.tag : null, tagError: tagCheck.ok ? null : tagCheck.error };
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`# safety-monitor verify`);
    console.log(`  GET /me: ${meRes.ok ? "ok" : `FAILED (${meRes.error})`}`);
    console.log(`  tag ${SAFETY_TAG_ID}: ${tagCheck.ok ? `ok (name="${tagCheck.tag.name}")` : `FAILED (${tagCheck.error})`}`);
  }
  return ok;
}

const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href;
if (isMain) {
  const argv = process.argv.slice(2);
  const cmd = argv.find((a) => !a.startsWith("--")) || "sweep";
  const json = argv.includes("--json");
  const commit = argv.includes("--commit");
  const hoursArg = argv.find((a) => a.startsWith("--hours="));
  const maxPagesArg = argv.find((a) => a.startsWith("--max-pages="));
  // VALIDATE the numeric flags rather than letting Number() hand back NaN. `--hours=abc` used to
  // yield NaN, which made sinceEpochSeconds NaN, which made discovery match nothing, which produced
  // a clean summary and exit 0. On a customer-safety monitor a typo'd flag that reports "no
  // escalations found" and succeeds is the worst kind of wrong: it looks exactly like a quiet day.
  // A bad argument is now a distinct exit 2 before any network call.
  function positiveNumber(arg, label, fallback) {
    if (!arg) return fallback;
    const raw = arg.split("=")[1];
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      console.error(`[safety-monitor] BAD ARGUMENT: ${label} must be a positive number, got ${JSON.stringify(raw)}. Refusing to run: an unusable window would scan nothing and report success.`);
      process.exit(2);
    }
    return n;
  }
  const hoursBack = positiveNumber(hoursArg, "--hours", DEFAULT_HOURS_BACK);
  const maxPages = positiveNumber(maxPagesArg, "--max-pages", DEFAULT_MAX_PAGES);

  (async () => {
    if (cmd === "verify") {
      const ok = await verifyOnly(json);
      process.exit(ok ? 0 : 1);
    }
    if (cmd !== "sweep") {
      console.error(`usage: monitor.mjs [sweep] [--commit] [--json] [--hours=N] [--max-pages=N] | verify [--json]`);
      process.exit(2);
    }
    let summary;
    try {
      // With --json, stdout must carry ONLY the JSON document. runSweep's default log writes
      // progress to stdout, so a consumer piping this into a parser previously received log lines
      // followed by JSON and could not parse it. Diagnostics go to stderr instead of being
      // discarded, so --json stays debuggable.
      summary = await runSweep({
        commit,
        hoursBack,
        maxPages,
        ...(json ? { log: (msg) => console.error(msg) } : {}),
      });
    } catch (e) {
      // Should be unreachable (runSweep is designed never to throw), but a genuinely unhandled
      // failure here must still exit non-zero with a distinct message, never a silent success.
      console.error(`[safety-monitor] FATAL, unhandled: ${String((e && e.message) || e)}`);
      process.exit(1);
    }
    if (json) console.log(JSON.stringify(summary, null, 2));
    else printReport(summary);
    if (!summary.ok) {
      console.error(`[safety-monitor] run completed WITH ERRORS (${summary.errors.length}) -- exiting non-zero. Never a silent success.`);
      process.exit(1);
    }
    process.exit(0);
  })();
}
