#!/usr/bin/env node
// Microsoft Graph mail-mining helper for the CFO (InnerScope M365 tenant, app-only).
// Reads mailboxes tenant-wide to mine financial source docs for the 2021+ reconstruction.
// Auth: client_credentials -> Graph app token. Read-only use (no writes/sends).
//
// Credentials from env (hydrated from otchealth-shared-prod via setup/fetch-secrets.mjs):
//   GRAPH_MAIL_CLIENT_ID, GRAPH_MAIL_CLIENT_SECRET, GRAPH_MAIL_TENANT_ID
//
// Strategy: scope to the FINANCE mailboxes; drive by the QBO vendor list (search each
// vendor), then a keyword gap-sweep. Stage hits in the CFO Ledger; save attachments to the
// source-doc store.
//
// Usage:
//   node m365-mail.mjs users [substr]                          # list mailboxes (filter optional)
//   node m365-mail.mjs search <mailbox> "<terms>" [top]        # $search subject+body+attachments
//   node m365-mail.mjs since <mailbox> <YYYY-MM-DD> [top]      # msgs w/ attachments since a date
//   node m365-mail.mjs attachments <mailbox> <messageId> <dir> # download a message's attachments
//   node m365-mail.mjs export <mailbox> <messageId> <dir>      # full email (headers+body html) + attachments, ready for the pdf skill
import { mkdirSync, writeFileSync } from "node:fs";

const T = need("GRAPH_MAIL_TENANT_ID"), CID = need("GRAPH_MAIL_CLIENT_ID"), SEC = need("GRAPH_MAIL_CLIENT_SECRET");
function need(n) { const v = process.env[n]; if (!v) { console.error(`Missing env ${n}`); process.exit(2); } return v; }

async function token() {
  const r = await fetch(`https://login.microsoftonline.com/${T}/oauth2/v2.0/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: CID, client_secret: SEC, scope: "https://graph.microsoft.com/.default" }),
  });
  const j = await r.json();
  if (!j.access_token) { console.error("token error: " + JSON.stringify(j).slice(0, 300)); process.exit(1); }
  return j.access_token;
}
async function gget(tok, url, extraHeaders) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}`, ...(extraHeaders || {}) } });
  const j = await r.json();
  if (j.error) { console.error(`HTTP ${r.status}: ${JSON.stringify(j.error).slice(0, 200)}`); process.exit(1); }
  return j;
}
const GBASE = "https://graph.microsoft.com/v1.0";
const enc = encodeURIComponent;

const [cmd, a1, a2, a3] = process.argv.slice(2);
const tok = await token();

if (cmd === "users") {
  let url = `${GBASE}/users?$select=displayName,mail,userPrincipalName,accountEnabled&$top=200`, all = [];
  while (url) { const j = await gget(tok, url); all = all.concat(j.value || []); url = j["@odata.nextLink"] || null; }
  const f = (a1 || "").toLowerCase();
  for (const u of all) {
    const line = `${u.accountEnabled ? "ON " : "OFF"} | ${(u.mail || u.userPrincipalName || "")} | ${u.displayName || ""}`;
    if (!f || line.toLowerCase().includes(f)) console.log(line);
  }
} else if (cmd === "search") {
  if (!a1 || !a2) { console.error('usage: m365-mail.mjs search <mailbox> "<terms>" [top]'); process.exit(2); }
  const top = a3 || "25";
  // $search hits subject, body, and attachment content. Quote the terms.
  const url = `${GBASE}/users/${enc(a1)}/messages?$search=${enc('"' + a2 + '"')}&$top=${top}&$select=subject,from,receivedDateTime,hasAttachments`;
  const j = await gget(tok, url, { ConsistencyLevel: "eventual" });
  console.log(`${(j.value || []).length} hit(s) in ${a1} for "${a2}":`);
  for (const m of j.value || []) console.log(`  ${(m.receivedDateTime || "").slice(0, 10)} | ${m.hasAttachments ? "[att] " : "      "}${(m.from && m.from.emailAddress && m.from.emailAddress.address) || "?"} | ${m.subject || ""}  <id:${m.id}>`);
} else if (cmd === "since") {
  if (!a1 || !a2) { console.error("usage: m365-mail.mjs since <mailbox> <YYYY-MM-DD> [top]"); process.exit(2); }
  const top = a3 || "50";
  const url = `${GBASE}/users/${enc(a1)}/messages?$filter=${enc(`receivedDateTime ge ${a2}T00:00:00Z and hasAttachments eq true`)}&$orderby=${enc("receivedDateTime desc")}&$top=${top}&$select=subject,from,receivedDateTime,hasAttachments`;
  const j = await gget(tok, url);
  console.log(`${(j.value || []).length} msg(s) with attachments in ${a1} since ${a2}:`);
  for (const m of j.value || []) console.log(`  ${(m.receivedDateTime || "").slice(0, 10)} | ${(m.from && m.from.emailAddress && m.from.emailAddress.address) || "?"} | ${m.subject || ""}  <id:${m.id}>`);
} else if (cmd === "attachments") {
  if (!a1 || !a2 || !a3) { console.error("usage: m365-mail.mjs attachments <mailbox> <messageId> <dir>"); process.exit(2); }
  mkdirSync(a3, { recursive: true });
  const j = await gget(tok, `${GBASE}/users/${enc(a1)}/messages/${enc(a2)}/attachments`);
  let n = 0;
  for (const att of j.value || []) {
    if (att["@odata.type"] === "#microsoft.graph.fileAttachment" && att.contentBytes) {
      const name = (att.name || `attachment-${n}`).replace(/[^\w.\- ]/g, "_");
      writeFileSync(`${a3}/${name}`, Buffer.from(att.contentBytes, "base64"));
      console.log(`saved ${a3}/${name} (${att.size || "?"} bytes)`); n++;
    }
  }
  if (!n) console.log("no file attachments on this message");
} else if (cmd === "export") {
  // Full email -> a folder ready for the pdf skill: email.html (headers + body) + attachments.
  if (!a1 || !a2 || !a3) { console.error("usage: m365-mail.mjs export <mailbox> <messageId> <dir>"); process.exit(2); }
  mkdirSync(a3, { recursive: true });
  const m = await gget(tok, `${GBASE}/users/${enc(a1)}/messages/${enc(a2)}?$select=subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments`);
  const esc = (s) => String(s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const addr = (r) => (r && r.emailAddress && r.emailAddress.address) || "";
  const to = (m.toRecipients || []).map(addr).join(", "), cc = (m.ccRecipients || []).map(addr).join(", ");
  const hdr = `<table style="border-collapse:collapse;margin-bottom:14px;font:11pt sans-serif"><tr><td style="padding:2px 10px 2px 0"><b>From</b></td><td>${esc(addr(m.from))}</td></tr><tr><td style="padding:2px 10px 2px 0"><b>To</b></td><td>${esc(to)}</td></tr>${cc ? `<tr><td style="padding:2px 10px 2px 0"><b>Cc</b></td><td>${esc(cc)}</td></tr>` : ""}<tr><td style="padding:2px 10px 2px 0"><b>Date</b></td><td>${esc(m.receivedDateTime)}</td></tr><tr><td style="padding:2px 10px 2px 0"><b>Subject</b></td><td>${esc(m.subject)}</td></tr><tr><td style="padding:2px 10px 2px 0"><b>Mailbox</b></td><td>${esc(a1)}</td></tr></table><hr>`;
  const body = m.body && m.body.contentType === "html" ? m.body.content : `<pre style="white-space:pre-wrap;font:11pt sans-serif">${esc(m.body && m.body.content)}</pre>`;
  const style = "<style>@page{size:Letter;margin:1in}body{font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:11pt;color:#1a1a1a}img{max-width:100%}table{max-width:100%}</style>";
  writeFileSync(`${a3}/email.html`, `<!doctype html><html><head><meta charset="utf-8"><title>${esc(m.subject) || "email"}</title>${style}</head><body>${hdr}${body}</body></html>`);
  console.log(`wrote ${a3}/email.html`);
  if (m.hasAttachments) {
    const j = await gget(tok, `${GBASE}/users/${enc(a1)}/messages/${enc(a2)}/attachments`);
    for (const att of j.value || []) {
      if (att["@odata.type"] === "#microsoft.graph.fileAttachment" && att.contentBytes) {
        const name = (att.name || "attachment").replace(/[^\w.\- ]/g, "_");
        writeFileSync(`${a3}/${name}`, Buffer.from(att.contentBytes, "base64"));
        console.log(`saved ${a3}/${name} (${att.size || "?"} bytes)`);
      }
    }
  }
  console.log(`-> print to PDF: node ~/.claude/skills/pdf/pdf.mjs create ${a3}/email.html ${a3}/email.pdf`);
} else {
  console.error("commands: users [substr] | search <mailbox> \"<terms>\" [top] | since <mailbox> <YYYY-MM-DD> [top] | attachments <mailbox> <messageId> <dir> | export <mailbox> <messageId> <dir>");
  process.exit(2);
}
