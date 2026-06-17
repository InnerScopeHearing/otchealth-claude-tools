#!/usr/bin/env node
// Plaid banking helper for the CFO data pipelines (OTCHealth Inc. + InnerScope/INND).
// Aggregates every bank + card so the CFO sees balances, transactions, and statements.
// Dependency-free (Node 18+ global fetch). NON-PHI commerce/finance data only.
//
// Auth: client_id + secret in each request body (no OAuth header). Per-institution
// access tokens are minted once via the Link flow, then reused.
//
// HISTORY LIMITS (Plaid hard facts):
//   - TRANSACTIONS max history = 730 days (24 months). This is Plaid's ceiling; you
//     cannot get 3-4 years of transactions from Plaid. We request the max (730).
//   - For history older than 24 months, use STATEMENTS (PDF, institution-dependent,
//     often 2+ years) or the QBO/Xero exports in the cfo-store bucket.
//   - days_requested applies at link time; to extend an ALREADY-linked item you must
//     re-run it through update mode (see `update-link`) so Plaid backfills.
//
// Credentials from env (hydrated from otchealth-shared-prod via setup/fetch-secrets.mjs):
//   PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV (sandbox | production; default sandbox)
// Access tokens are stored as plaid-access-token-<inst> and passed as an argument.
//
// Usage:
//   node plaid.mjs link-token <userId> [statements]      # new connection (730d history; +statements if enabled)
//   node plaid.mjs hosted-link <userId> [statements]     # same, Plaid-hosted browser URL
//   node plaid.mjs update-link <accessToken> [statements]# RE-LINK an existing item: backfill 730d (+add statements)
//   node plaid.mjs get-link <linkToken>                  # retrieve a completed Hosted Link (public_token)
//   node plaid.mjs exchange <publicToken>                # public_token -> durable access_token (store in vault)
//   node plaid.mjs item <accessToken>                    # item config: products, institution
//   node plaid.mjs accounts <accessToken>                # accounts on the item (name, mask, type)
//   node plaid.mjs balances <accessToken>                # current balances
//   node plaid.mjs sync <accessToken> [cursor]           # transaction delta (cursor-based)
//   node plaid.mjs transactions <accessToken> [days]     # pull a date window (default 730, max 730)
//   node plaid.mjs statements-list <accessToken>         # available PDF statements (needs Statements product)
//   node plaid.mjs statements-download <accessToken> <statementId> [outFile]

import { writeFileSync } from "node:fs";

const ENV = (process.env.PLAID_ENV || "sandbox").toLowerCase();
const HOST = ENV === "production" ? "https://production.plaid.com" : "https://sandbox.plaid.com";

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing env ${name}. Store the Plaid creds in Secret Manager and hydrate them first.`);
    process.exit(2);
  }
  return v;
}
function creds() { return { client_id: need("PLAID_CLIENT_ID"), secret: need("PLAID_SECRET") }; }

async function call(path, body) {
  const res = await fetch(`${HOST}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...creds(), ...body }),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  console.error(`HTTP ${res.status} ${path}`);
  console.log(JSON.stringify(json, null, 2));
  if (!res.ok) process.exit(1);
  return json;
}

// Build the transactions config: always request Plaid's maximum history (730 days).
const TX_MAX_DAYS = 730;
// Plaid Statements also caps at 2 years (730 days), same as transactions ("Statements
// product only supports a maximum of 2 years of data"). For older history use the
// QBO/Xero exports in the cfo-store bucket, not Plaid.
const STMT_LOOKBACK_DAYS = Math.min(parseInt(process.env.PLAID_STATEMENTS_DAYS || "730", 10), 730);
function ymd(d) { return d.toISOString().slice(0, 10); }
function statementsConfig() {
  return { start_date: ymd(new Date(Date.now() - STMT_LOOKBACK_DAYS * 86400000)), end_date: ymd(new Date()) };
}

const [cmd, a1, a2, a3] = process.argv.slice(2);

if (cmd === "link-token" || cmd === "hosted-link") {
  const products = ["transactions"];
  const body = {
    user: { client_user_id: a1 || "cfo-otchealth" },
    client_name: "OTCHealth CFO",
    products,
    country_codes: ["US"],
    language: "en",
    transactions: { days_requested: TX_MAX_DAYS },
  };
  if (a2 === "statements") { products.push("statements"); body.statements = statementsConfig(); }
  if (cmd === "hosted-link") body.hosted_link = {};
  await call("/link/token/create", body);
} else if (cmd === "update-link") {
  // Update mode: re-auth an EXISTING item to backfill the full 730 days and/or add
  // the statements product. Returns a hosted_link_url the user opens to re-consent.
  if (!a1) { console.error("usage: plaid.mjs update-link <accessToken> [statements]"); process.exit(2); }
  const body = {
    user: { client_user_id: "cfo-otchealth" },
    client_name: "OTCHealth CFO",
    country_codes: ["US"],
    language: "en",
    access_token: a1,
    transactions: { days_requested: TX_MAX_DAYS },
    hosted_link: {},
  };
  if (a2 === "statements") { body.products = ["statements"]; body.statements = statementsConfig(); } // add-product-to-existing-item flow
  await call("/link/token/create", body);
} else if (cmd === "get-link") {
  if (!a1) { console.error("usage: plaid.mjs get-link <linkToken>"); process.exit(2); }
  await call("/link/token/get", { link_token: a1 });
} else if (cmd === "exchange") {
  if (!a1) { console.error("usage: plaid.mjs exchange <publicToken>"); process.exit(2); }
  await call("/item/public_token/exchange", { public_token: a1 });
} else if (cmd === "item") {
  if (!a1) { console.error("usage: plaid.mjs item <accessToken>"); process.exit(2); }
  await call("/item/get", { access_token: a1 });
} else if (cmd === "accounts") {
  if (!a1) { console.error("usage: plaid.mjs accounts <accessToken>"); process.exit(2); }
  await call("/accounts/get", { access_token: a1 });
} else if (cmd === "balances") {
  if (!a1) { console.error("usage: plaid.mjs balances <accessToken>"); process.exit(2); }
  await call("/accounts/balance/get", { access_token: a1 });
} else if (cmd === "sync") {
  const accessToken = a1 || process.env.PLAID_ACCESS_TOKEN;
  if (!accessToken) { console.error("usage: plaid.mjs sync <accessToken> [cursor]"); process.exit(2); }
  const body = { access_token: accessToken };
  if (a2) body.cursor = a2;
  await call("/transactions/sync", body);
} else if (cmd === "transactions") {
  // Pull a fixed date window via /transactions/get (paginated). Default + max = 730 days.
  if (!a1) { console.error("usage: plaid.mjs transactions <accessToken> [days]"); process.exit(2); }
  const days = Math.min(parseInt(a2 || TX_MAX_DAYS, 10) || TX_MAX_DAYS, TX_MAX_DAYS);
  const end = new Date();
  const start = new Date(Date.now() - days * 86400000);
  let offset = 0, total = null, all = [];
  do {
    const r = await call("/transactions/get", {
      access_token: a1, start_date: ymd(start), end_date: ymd(end),
      options: { count: 500, offset },
    });
    total = r.total_transactions;
    all = all.concat(r.transactions || []);
    offset += (r.transactions || []).length;
    if (!r.transactions || r.transactions.length === 0) break;
  } while (offset < total);
  console.error(`pulled ${all.length}/${total} transactions over ${days} days (${ymd(start)}..${ymd(end)})`);
} else if (cmd === "statements-list") {
  if (!a1) { console.error("usage: plaid.mjs statements-list <accessToken>"); process.exit(2); }
  await call("/statements/list", { access_token: a1 });
} else if (cmd === "statements-download") {
  if (!a1 || !a2) { console.error("usage: plaid.mjs statements-download <accessToken> <statementId> [outFile]"); process.exit(2); }
  // /statements/download returns the raw PDF (not JSON). Write it to disk.
  const res = await fetch(`${HOST}/statements/download`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...creds(), statement_id: a2 }),
  });
  if (!res.ok) {
    console.error(`HTTP ${res.status} /statements/download`);
    console.log((await res.text()).slice(0, 400));
    process.exit(1);
  }
  const out = a3 || `statement-${a2}.pdf`;
  writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  console.error(`saved statement -> ${out}`);
} else {
  console.error("commands: link-token <userId> [statements] | hosted-link <userId> [statements] | update-link <accessToken> [statements] | get-link <linkToken> | exchange <publicToken> | item <accessToken> | accounts <accessToken> | balances <accessToken> | sync <accessToken> [cursor] | transactions <accessToken> [days] | statements-list <accessToken> | statements-download <accessToken> <statementId> [outFile]");
  process.exit(2);
}
