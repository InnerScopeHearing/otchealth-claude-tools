#!/usr/bin/env node
// asc.mjs — App Store Connect API client on the NEW 4.4.1 (2026-07-15) resource model.
// Version-based IAP/subscription metadata + the unified reviewSubmissions workflow.
// Dependency-free Node >= 20. Secrets from Azure Key Vault via the shared kvSecret helper
// (asc-api-key-p8 PEM, asc-key-id, asc-issuer-id, asc-team-id).
//
// IMPORTANT: this skill deliberately uses ONLY the new endpoints (v1 *Versions parents +
// v2 localizations/images + reviewSubmissions). The pre-4.4.1 resources
// (v1 inAppPurchase/subscription/subscriptionGroup localizations, images, and
// *Submissions) are DEPRECATED by Apple and slated for removal. Never add verbs that
// call them. See PROCESS.md for the migration map and per-app runbook.
//
// GUARDRAIL: `submit` (PATCH reviewSubmissions submitted=true) is a RELEASE action —
// CTO/Matt go required, same discipline as iOS build dispatch. Metadata edits
// (versions, localizations, images) are developer-lane safe: they create a NEW draft
// version and never touch what is currently live on the App Store.

import { createPrivateKey, sign, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { kvSecret } from "../kb-memory/azure-secret.mjs";

const API = "https://api.appstoreconnect.apple.com";

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function mintJwt() {
  const [p8, kid, iss] = await Promise.all([
    kvSecret("asc-api-key-p8"),
    kvSecret("asc-key-id"),
    kvSecret("asc-issuer-id"),
  ]);
  if (!p8 || !kid || !iss) throw new Error("ASC secrets missing from Key Vault (asc-api-key-p8 / asc-key-id / asc-issuer-id)");
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "ES256", kid, typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iss, iat: now, exp: now + 15 * 60, aud: "appstoreconnect-v1" }));
  const key = createPrivateKey(p8);
  const sig = sign("sha256", Buffer.from(`${header}.${payload}`), { key, dsaEncoding: "ieee-p1363" });
  return `${header}.${payload}.${b64url(sig)}`;
}

async function asc(method, path, body) {
  const jwt = await mintJwt();
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${jwt}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = json?.errors?.[0];
    throw new Error(`${method} ${path} -> HTTP ${res.status}${err ? ` ${err.code}: ${err.detail || err.title}` : ""}`);
  }
  return json;
}

const rel = (type, id) => ({ data: { type, id } });

// ---------- verbs ----------

async function verify() {
  const r = await asc("GET", "/v1/apps?limit=200&fields[apps]=bundleId,name");
  console.log(`OK — ${r.data.length} apps visible:`);
  r.data.forEach(a => console.log(`  ${a.id}  ${a.attributes.bundleId}  ${a.attributes.name}`));
}

// Create a new draft version for an IAP / subscription / subscription group.
// A version is a pure container (no attributes); metadata hangs off it via v2 endpoints.
async function createVersion(kind, parentId) {
  const map = {
    iap:   { path: "/v1/inAppPurchaseVersions",     type: "inAppPurchaseVersions",     parentRel: "inAppPurchase",     parentType: "inAppPurchases" },
    sub:   { path: "/v1/subscriptionVersions",      type: "subscriptionVersions",      parentRel: "subscription",      parentType: "subscriptions" },
    group: { path: "/v1/subscriptionGroupVersions", type: "subscriptionGroupVersions", parentRel: "subscriptionGroup", parentType: "subscriptionGroups" },
  };
  const m = map[kind];
  if (!m) throw new Error(`kind must be iap|sub|group, got '${kind}'`);
  const r = await asc("POST", m.path, {
    data: { type: m.type, relationships: { [m.parentRel]: rel(m.parentType, parentId) } },
  });
  console.log(`created ${m.type} id=${r.data.id} state=${r.data.attributes?.state ?? "?"}`);
  return r.data.id;
}

async function listVersions(kind, parentId) {
  const map = {
    iap:   `/v2/inAppPurchases/${parentId}/versions`,
    sub:   `/v1/subscriptions/${parentId}/versions`,
    group: `/v1/subscriptionGroups/${parentId}/versions`,
  };
  if (!map[kind]) throw new Error(`kind must be iap|sub|group`);
  const r = await asc("GET", map[kind]);
  r.data.forEach(v => console.log(`${v.id}  state=${v.attributes?.state ?? "?"}`));
  if (!r.data.length) console.log("(no versions)");
}

// v2 localizations, scoped to a VERSION (never to the raw product — that's the old model).
async function localize(kind, versionId, locale, name, description) {
  const map = {
    iap:   { path: "/v2/inAppPurchaseLocalizations",     type: "inAppPurchaseLocalizations",     verType: "inAppPurchaseVersions" },
    sub:   { path: "/v2/subscriptionLocalizations",      type: "subscriptionLocalizations",      verType: "subscriptionVersions" },
    group: { path: "/v2/subscriptionGroupLocalizations", type: "subscriptionGroupLocalizations", verType: "subscriptionGroupVersions" },
  };
  const m = map[kind];
  if (!m) throw new Error(`kind must be iap|sub|group`);
  const attributes = { locale, name };
  if (description !== undefined && kind !== "group") attributes.description = description;
  // subscription group localizations use name + customAppName semantics; pass description as customAppName there
  if (kind === "group" && description !== undefined) attributes.customAppName = description;
  const r = await asc("POST", m.path, {
    data: { type: m.type, attributes, relationships: { version: rel(m.verType, versionId) } },
  });
  console.log(`localized ${m.type} id=${r.data.id} locale=${locale}`);
  return r.data.id;
}

async function listLocalizations(kind, versionId) {
  const map = {
    iap:   `/v1/inAppPurchaseVersions/${versionId}/localizations`,
    sub:   `/v1/subscriptionVersions/${versionId}/localizations`,
    group: `/v1/subscriptionGroupVersions/${versionId}/localizations`,
  };
  const r = await asc("GET", map[kind]);
  r.data.forEach(l => console.log(`${l.id}  ${l.attributes?.locale}  "${l.attributes?.name}"`));
  if (!r.data.length) console.log("(no localizations)");
}

// The unified review submission flow (the whole point of 4.4.1: IAP versions ride in the
// SAME submission as an app version / in-app events / product pages / Game Center items).
async function submissionCreate(appId, platform = "IOS") {
  const r = await asc("POST", "/v1/reviewSubmissions", {
    data: { type: "reviewSubmissions", attributes: { platform }, relationships: { app: rel("apps", appId) } },
  });
  console.log(`reviewSubmission id=${r.data.id} state=${r.data.attributes?.state}`);
  return r.data.id;
}

const ITEM_TYPES = {
  "app-version": ["appStoreVersion", "appStoreVersions"],
  "iap-version": ["inAppPurchaseVersion", "inAppPurchaseVersions"],
  "sub-version": ["subscriptionVersion", "subscriptionVersions"],
  "group-version": ["subscriptionGroupVersion", "subscriptionGroupVersions"],
  "app-event": ["appEvent", "appEvents"],
  "product-page": ["appCustomProductPageVersion", "appCustomProductPageVersions"],
};

async function submissionAdd(submissionId, itemKind, itemId) {
  const t = ITEM_TYPES[itemKind];
  if (!t) throw new Error(`item kind must be one of: ${Object.keys(ITEM_TYPES).join(", ")}`);
  const r = await asc("POST", "/v1/reviewSubmissionItems", {
    data: {
      type: "reviewSubmissionItems",
      relationships: {
        reviewSubmission: rel("reviewSubmissions", submissionId),
        [t[0]]: rel(t[1], itemId),
      },
    },
  });
  console.log(`added ${itemKind} ${itemId} -> item ${r.data.id}`);
}

async function submissionStatus(appId) {
  const r = await asc("GET", `/v1/reviewSubmissions?filter[app]=${appId}&limit=10&include=items`);
  r.data.forEach(s => console.log(`${s.id}  platform=${s.attributes?.platform}  state=${s.attributes?.state}  submitted=${s.attributes?.submittedDate ?? "-"}`));
  if (!r.data.length) console.log("(no review submissions)");
}

// RELEASE ACTION — CTO/Matt go required (see header guardrail).
async function submissionSubmit(submissionId) {
  if (process.env.ASC_SUBMIT_CONFIRM !== "yes") {
    throw new Error("Refusing: submitting to App Review is a release action. Re-run with ASC_SUBMIT_CONFIRM=yes after CTO/Matt go.");
  }
  const r = await asc("PATCH", `/v1/reviewSubmissions/${submissionId}`, {
    data: { type: "reviewSubmissions", id: submissionId, attributes: { submitted: true } },
  });
  console.log(`SUBMITTED reviewSubmission ${submissionId} state=${r.data.attributes?.state}`);
}

// ---------- CLI ----------
const [, , verb, ...args] = process.argv;
const usage = `asc.mjs — App Store Connect (new 4.4.1 version-based model)
  verify                                         list visible apps (auth check)
  version create <iap|sub|group> <parentId>       new draft metadata version
  version list   <iap|sub|group> <parentId>       list versions + states
  localize <iap|sub|group> <versionId> <locale> <name> [description|customAppName]
  localizations <iap|sub|group> <versionId>       list a version's localizations
  submission create <appId> [IOS|MAC_OS|TV_OS]    open a review submission
  submission add <submissionId> <kind> <itemId>   kind: ${Object.keys(ITEM_TYPES).join("|")}
  submission status <appId>                       recent submissions + states
  submission submit <submissionId>                RELEASE ACTION (needs ASC_SUBMIT_CONFIRM=yes)
  request <METHOD> <path> [jsonFile]              raw escape hatch (any endpoint)`;

try {
  if (verb === "verify") await verify();
  else if (verb === "version" && args[0] === "create") await createVersion(args[1], args[2]);
  else if (verb === "version" && args[0] === "list") await listVersions(args[1], args[2]);
  else if (verb === "localize") await localize(args[0], args[1], args[2], args[3], args[4]);
  else if (verb === "localizations") await listLocalizations(args[0], args[1]);
  else if (verb === "submission" && args[0] === "create") await submissionCreate(args[1], args[2]);
  else if (verb === "submission" && args[0] === "add") await submissionAdd(args[1], args[2], args[3]);
  else if (verb === "submission" && args[0] === "status") await submissionStatus(args[1]);
  else if (verb === "submission" && args[0] === "submit") await submissionSubmit(args[1]);
  else if (verb === "request") {
    const body = args[2] ? JSON.parse(readFileSync(args[2], "utf8")) : undefined;
    console.log(JSON.stringify(await asc(args[0].toUpperCase(), args[1], body), null, 2));
  } else { console.log(usage); process.exit(verb ? 1 : 0); }
} catch (e) {
  console.error("ERROR:", e.message);
  process.exit(1);
}
