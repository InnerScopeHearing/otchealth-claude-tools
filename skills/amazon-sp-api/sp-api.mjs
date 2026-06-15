#!/usr/bin/env node
// Amazon Selling Partner API (SP-API) helper for the OTCHealth seller account.
// LWA refresh-token -> access-token, then call SP-API with x-amz-access-token.
// NO AWS SigV4 (Amazon removed that requirement). Node built-ins only.
//
// Credentials from env (hydrated from otchealth-shared-prod via setup/fetch-secrets.mjs):
//   AMZ_LWA_CLIENT_ID, AMZ_LWA_CLIENT_SECRET, AMZ_SP_REFRESH_TOKEN  (required)
//   AMZ_SELLER_ID            (Merchant token; needed for Listings Items writes)
//   AMZ_MARKETPLACE_ID       (default ATVPDKIKX0DER = Amazon US)
//   AMZ_SP_REGION            (na | eu | fe; default na)
//
// Usage:
//   node sp-api.mjs verify
//   node sp-api.mjs orders [createdAfterISO]
//   node sp-api.mjs inventory
//   node sp-api.mjs request <METHOD> <path>        (request body, if any, on stdin)
import https from "node:https";

const REGION_HOST = {
  na: "sellingpartnerapi-na.amazon.com",
  eu: "sellingpartnerapi-eu.amazon.com",
  fe: "sellingpartnerapi-fe.amazon.com",
};
const MARKET = process.env.AMZ_MARKETPLACE_ID || "ATVPDKIKX0DER"; // US
const HOST = REGION_HOST[(process.env.AMZ_SP_REGION || "na").toLowerCase()] || REGION_HOST.na;

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing env ${name}. Store the SP-API creds in Secret Manager and hydrate them first.`);
    process.exit(2);
  }
  return v;
}

function post(host, path, headers, body) {
  return new Promise((res, rej) => {
    const r = https.request({ host, path, method: "POST", headers }, (x) => {
      let d = "";
      x.on("data", (c) => (d += c));
      x.on("end", () => res({ status: x.statusCode, headers: x.headers, body: d }));
    });
    r.on("error", rej);
    r.write(body);
    r.end();
  });
}

function callApi(method, path, accessToken, body) {
  return new Promise((res, rej) => {
    const headers = { "x-amz-access-token": accessToken, "content-type": "application/json", accept: "application/json" };
    const r = https.request({ host: HOST, path, method, headers }, (x) => {
      let d = "";
      x.on("data", (c) => (d += c));
      x.on("end", () => res({ status: x.statusCode, headers: x.headers, body: d }));
    });
    r.on("error", rej);
    if (body) r.write(body);
    r.end();
  });
}

async function getAccessToken() {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: need("AMZ_SP_REFRESH_TOKEN"),
    client_id: need("AMZ_LWA_CLIENT_ID"),
    client_secret: need("AMZ_LWA_CLIENT_SECRET"),
  }).toString();
  const r = await post("api.amazon.com", "/auth/o2/token", { "content-type": "application/x-www-form-urlencoded" }, form);
  if (r.status !== 200) {
    console.error(`LWA token exchange failed: ${r.status} ${r.body}`);
    process.exit(1);
  }
  return JSON.parse(r.body).access_token;
}

function readStdin() {
  return new Promise((res) => {
    let d = "";
    if (process.stdin.isTTY) return res("");
    process.stdin.on("data", (c) => (d += c));
    process.stdin.on("end", () => res(d));
  });
}

function out(r) {
  console.error(`HTTP ${r.status}  (RateLimit-Limit: ${r.headers["x-amzn-ratelimit-limit"] || "n/a"})`);
  try {
    console.log(JSON.stringify(JSON.parse(r.body), null, 2));
  } catch {
    console.log(r.body);
  }
  process.exit(r.status >= 200 && r.status < 300 ? 0 : 1);
}

const [cmd, a1, a2] = process.argv.slice(2);
const token = await getAccessToken();

if (cmd === "verify") {
  // Proves the connection + lists the seller's marketplaces.
  out(await callApi("GET", "/sellers/v1/marketplaceParticipations", token));
} else if (cmd === "orders") {
  const after = a1 || new Date(Date.now() - 7 * 864e5).toISOString();
  out(await callApi("GET", `/orders/v0/orders?MarketplaceIds=${MARKET}&CreatedAfter=${encodeURIComponent(after)}`, token));
} else if (cmd === "inventory") {
  out(await callApi("GET", `/fba/inventory/v1/summaries?granularityType=Marketplace&granularityId=${MARKET}&marketplaceIds=${MARKET}`, token));
} else if (cmd === "request") {
  if (!a1 || !a2) {
    console.error("usage: sp-api.mjs request <METHOD> <path>   (body on stdin for write ops)");
    process.exit(2);
  }
  const body = ["PUT", "PATCH", "POST"].includes(a1.toUpperCase()) ? await readStdin() : null;
  out(await callApi(a1.toUpperCase(), a2, token, body || null));
} else {
  console.error("commands: verify | orders [createdAfterISO] | inventory | request <METHOD> <path>");
  process.exit(2);
}
