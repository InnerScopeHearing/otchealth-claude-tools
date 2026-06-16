#!/usr/bin/env node
// Plaid banking helper for the CFO data pipelines (OTCHealth Inc. + InnerScope/INND).
// Aggregates every bank + card so the CFO sees real-time balances + transactions.
// Dependency-free (Node 18+ global fetch). NON-PHI commerce/finance data only.
//
// Auth: client_id + secret in each request body (no OAuth header). Per-institution
// access tokens are minted once via the Link flow, then reused for sync.
//
// Credentials from env (hydrated from otchealth-shared-prod via setup/fetch-secrets.mjs):
//   PLAID_CLIENT_ID, PLAID_SECRET          (required)
//   PLAID_ENV                              (sandbox | production; default sandbox)
// Per-institution access tokens are stored in the vault as plaid-access-token-<inst>
// and passed to sync/balances as an argument (or PLAID_ACCESS_TOKEN env).
//
// Usage:
//   node plaid.mjs link-token <clientUserId>        # start a Link session (Matt links a bank)
//   node plaid.mjs exchange   <publicToken>         # Link public_token -> access_token (store it)
//   node plaid.mjs balances   <accessToken>         # current balances for one institution
//   node plaid.mjs sync       <accessToken> [cursor]# transactions delta since cursor

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

async function call(path, body) {
  const res = await fetch(`${HOST}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: need("PLAID_CLIENT_ID"), secret: need("PLAID_SECRET"), ...body }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  console.error(`HTTP ${res.status} ${path}`);
  console.log(JSON.stringify(json, null, 2));
  if (!res.ok) process.exit(1);
  return json;
}

const [cmd, a1, a2] = process.argv.slice(2);

if (cmd === "link-token") {
  // Returns a link_token; feed it to Plaid Link (browser) to connect ONE institution.
  await call("/link/token/create", {
    user: { client_user_id: a1 || "cfo-otchealth" },
    client_name: "OTCHealth CFO",
    products: ["transactions"],
    country_codes: ["US"],
    language: "en",
  });
} else if (cmd === "hosted-link") {
  // Plaid-hosted Link flow: returns a hosted_link_url the user opens in a browser to
  // connect ONE institution (no embedded SDK needed). Save the link_token to retrieve
  // the public_token afterwards with `get-link`.
  await call("/link/token/create", {
    user: { client_user_id: a1 || "cfo-otchealth" },
    client_name: "OTCHealth CFO",
    products: ["transactions"],
    country_codes: ["US"],
    language: "en",
    hosted_link: {},
  });
} else if (cmd === "get-link") {
  // After the user completes Hosted Link, retrieve the session (incl. public_token).
  if (!a1) {
    console.error("usage: plaid.mjs get-link <linkToken>");
    process.exit(2);
  }
  await call("/link/token/get", { link_token: a1 });
} else if (cmd === "exchange") {
  // Link returns a public_token; exchange it for the durable access_token (store in vault).
  if (!a1) {
    console.error("usage: plaid.mjs exchange <publicToken>");
    process.exit(2);
  }
  await call("/item/public_token/exchange", { public_token: a1 });
} else if (cmd === "balances") {
  if (!a1) {
    console.error("usage: plaid.mjs balances <accessToken>");
    process.exit(2);
  }
  await call("/accounts/balance/get", { access_token: a1 });
} else if (cmd === "sync") {
  // Cursor-based delta. First run: omit cursor. Persist next_cursor, pass it next time.
  const accessToken = a1 || process.env.PLAID_ACCESS_TOKEN;
  if (!accessToken) {
    console.error("usage: plaid.mjs sync <accessToken> [cursor]");
    process.exit(2);
  }
  const body = { access_token: accessToken };
  if (a2) body.cursor = a2;
  await call("/transactions/sync", body);
} else {
  console.error("commands: link-token <userId> | hosted-link <userId> | get-link <linkToken> | exchange <publicToken> | balances <accessToken> | sync <accessToken> [cursor]");
  process.exit(2);
}
