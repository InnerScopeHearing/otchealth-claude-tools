// pipeline.mjs -- the `put` pipeline. ORDER IS LOAD-BEARING:
//   normalize -> header -> SECRET GATE -> RING GATE (both before ANY network write and before ANY
//   embedding call: OpenAI is a non-BAA processor) -> idempotency (registry / by-hash) -> [dry-run
//   stops] -> create-only object write -> chunk+embed+push -> one refresh -> VERIFY (room + gateway)
//   -> registry live + by-hash + override audit -> supersede the previous version (only after the new
//   one verified, so there is never a window with nothing searchable) -> local receipt.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, basename } from "node:path";
import { normalizeInput, resolveTitle, resolveDate, isGenericTitle, MAX_OBJECT_CHARS, MIN_TEXT_CHARS, decodeTextInput, textChars, base64Share, MAX_BASE64_SHARE, BASE64_RUN_MIN } from "./normalize.mjs";
import {
  KINDS, isKind, isAppSlug, slugify, contentSha256, identityFor, identityKindFor, brainIdFor, keyFor, srcKeyFor, buildHeader,
  buildObject, sha256, sha1, TOOL_VERSION, registryKey, keyRefFor, oneLine, isTitleIdentity, parseKnowledgeKey, isBrainId, sourceIdentity,
} from "./provenance.mjs";
import { scanParts, formatSecretHits } from "./secret-gate.mjs";
import { classifyRing, formatRingRefusal, htmlRawView, jsonRawView, jsonFinanceSignals } from "./ring-gate.mjs";
import { BrainSaveError, EXIT } from "./errors.mjs";
import { readRegistry, readByHash, updateRegistry, createObject, writeByHash, archiveObject, writeOverrideAudit, liveVersion, latestVersion } from "./store.mjs";
import { pushObject, parentIdFor } from "./push.mjs";
import { verifyInRoom, verifyViaGateway } from "./verify.mjs";
import { writeReceipt, writeRefusal } from "./local.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let _apps = null;
export function appsConfig() { return (_apps ||= JSON.parse(readFileSync(join(HERE, "..", "config", "apps.json"), "utf8"))); }

/** Infer a kind from a path/title when --kind auto. Order matters (a build-review packet is a packet). */
export function inferKind(pathLike, title = "", artifactUrl = "") {
  const s = `${pathLike || ""} ${title || ""}`.toLowerCase();
  if (artifactUrl && !pathLike) return "artifact";
  const rules = [
    ["packet", /build-review|\bpacket\b|mark-review/], ["runbook", /runbooks?\b/], ["receipt", /receipt/],
    ["research", /research/], ["audit", /audit/], ["spec", /\bspecs?\b|spec-of-record/], ["design", /design|mockup|redesign|wireframe/],
    ["deploy", /deploy/], ["build", /\bbuild\b/], ["review", /review/], ["decision", /decision|\badr\b/], ["report", /report/],
  ];
  for (const [k, re] of rules) if (re.test(s)) return k;
  return "doc";
}

export function resolveApp(flag, sourceRepo) {
  const f = String(flag || "").trim();
  if (f && f !== "auto") return f;
  const repos = appsConfig().repos || {};
  if (sourceRepo && repos[sourceRepo]) return repos[sourceRepo];
  if (sourceRepo && isAppSlug(sourceRepo)) return sourceRepo;
  return "";
}

/** Verify retry spacing (2s in production; BRAIN_SAVE_VERIFY_DELAY_MS lets tests run without sleeping). */
function verifyDelay() { const n = Number(process.env.BRAIN_SAVE_VERIFY_DELAY_MS); return Number.isFinite(n) && n >= 0 ? n : 2000; }

const refused = (message, extra) => new BrainSaveError(EXIT.REFUSED, message, extra);

/**
 * Stage 1 (no network writes, no embedding): normalize, identify, and run BOTH gates.
 * input: { localPath, realPath, displayPath, bytes (Buffer), ext, git (gitInfo|null), source, sourceRepo }
 * Throws BrainSaveError (1 = bad input, 2 = refused).
 */
export function prepareDoc(input, opts, ctx) {
  const ext = String(input.ext || extname(input.localPath || input.displayPath || "")).toLowerCase();
  const file = input.displayPath || input.localPath || "input";
  // Binary / NUL / non-UTF-8 input is refused here (exit 1): it used to be embedded as U+FFFD garbage.
  const raw = decodeTextInput(input.bytes, file);
  const rawSha = sha256(input.bytes);
  const norm = normalizeInput({ ext, text: raw, file });
  const title = resolveTitle({ flag: opts.title, frontmatter: norm.frontmatter, h1: norm.h1, htmlTitle: norm.htmlTitle, file });
  // One-line provenance values: a newline in --source used to inject lines into the stored doc.
  const source = oneLine(input.source || opts.source || "");
  const sourceRepo = input.sourceRepo || "";
  const artifactUrl = oneLine(opts.artifactUrl || "");
  const kind = !opts.kind || opts.kind === "auto" ? inferKind(file, title, artifactUrl) : opts.kind;
  if (!isKind(kind)) throw new BrainSaveError(EXIT.ERROR, `--kind must be one of ${KINDS.join("|")} or auto (got "${opts.kind}")`);
  const app = resolveApp(opts.app, sourceRepo);
  if (!app) throw new BrainSaveError(EXIT.ERROR, "--app is required (the file is not in a git repo that maps to an app); e.g. --app fleet");
  if (!isAppSlug(app)) throw new BrainSaveError(EXIT.ERROR, `--app must be a lowercase slug like hey-millie (got "${app}")`);
  if (isGenericTitle(title, { app, kind })) throw new BrainSaveError(EXIT.ERROR, `title "${title}" is too generic to find later; pass --title "<what this document is>"`);
  const date = resolveDate({ flag: opts.date, frontmatter: norm.frontmatter, now: ctx.now || new Date() });
  const body = norm.body;
  const contentSha = contentSha256(body);
  const slug = slugify(title);
  const identity = identityFor({ id: opts.id, source, artifactUrl, kind, app, slug });
  // "title": the identity is kind/app/<title slug> (no --id, no source, no Artifact URL). Two DIFFERENT
  // documents that share a title share this identity, so resolveVersion refuses to let one replace the
  // other without --supersedes / --id (adjudication round 3: build receipts 57 and 58 replaced each other).
  const identityKind = identityKindFor({ id: opts.id, source, artifactUrl });
  const brainId = brainIdFor(kind, identity);
  const key = keyFor({ kind, app, date, slug, contentSha });
  const tags = [...new Set((opts.tags || []).map((t) => oneLine(t)).filter(Boolean))];

  // Ring gate over the normalized body AND raw views of what is persisted (html/json raw originals are
  // stored under _KNOWLEDGE-META/src/, even with --store-only), plus every declaration (front matter,
  // HTML <meta>, JSON top-level keys) and every path we know (including the symlink-resolved one).
  const extraTexts = [];
  let jsonFinance = null;
  if (ext === ".html" || ext === ".htm") extraTexts.push(htmlRawView(raw));
  if (ext === ".json") { extraTexts.push(jsonRawView(norm.json)); jsonFinance = jsonFinanceSignals(norm.json); }
  const ring = classifyRing({ text: body, extraTexts, jsonFinance, frontmatter: norm.frontmatter, ringFlag: opts.ring || "commons", source, localPath: input.localPath || input.displayPath || "", realPath: input.realPath || "", artifactUrl, sourceRepo, override: opts.ringOverride || "", overrideSeat: opts.seat || "" });

  const base = {
    brain_id: brainId, version: "1", title, kind, app, source, artifact_url: artifactUrl,
    author_agent: opts.agent || "unknown", session: opts.session || "", doc_date: date,
    saved_at: (ctx.now || new Date()).toISOString().replace(/\.\d{3}Z$/, "Z"), content_sha256: contentSha, key_ref: keyRefFor(key), supersedes: "",
    ring: "commons", ring_warnings: ring.warnings.join(","),
    ring_override: ring.overrideAccepted ? `${opts.ringOverride} (by ${opts.agent || "unknown"}, seat ${opts.seat || "unknown"}, signals: ${ring.heuristic.map((s) => s.code).join("+")})` : "",
    tags: tags.join(","), saved_by: TOOL_VERSION,
  };
  const provisional = buildObject(buildHeader(base), body);
  if (!opts.storeOnly && provisional.length > MAX_OBJECT_CHARS) throw new BrainSaveError(EXIT.ERROR, `document is ${provisional.length} chars after normalization; the brain indexes at most ${MAX_OBJECT_CHARS}. Split it and save the parts.`);

  // SECRET GATE (fail-closed) -- raw input, normalized body, the final object including header fields,
  // and every option value that is persisted anywhere (--id lands in the registry `identity`,
  // --supersedes in the next header, --ring-override in the header and the override audit record).
  const options = [opts.id, opts.supersedes, opts.ringOverride, opts.title, tags.join(","), source, artifactUrl, opts.agent, opts.session].filter((v) => v != null && v !== "").map(String).join("\n");
  const hits = scanParts({ raw, body, object: provisional, options }, ctx.needles || []);
  if (hits.length) throw refused(`REFUSED (secret): nothing written, nothing embedded.\n${formatSecretHits(hits).join("\n")}\n  route: Remove the value and reference the SSM parameter NAME (/otchealth/<name>), then re-run.`, { codes: ["SECRET"], secretHits: hits });
  if (!ring.allowed) throw refused(`REFUSED (ring): nothing written, nothing embedded.\n${formatRingRefusal(ring).join("\n")}`, { codes: [...ring.hard, ...ring.heuristic].map((s) => s.code), ring });
  // Empty-document floor AFTER both gates (a tiny privileged or secret-bearing file is a refusal, exit 2,
  // not an error). --store-only keeps the RAW bytes (a mockup can be all markup): its floor is on raw.
  const chars = opts.storeOnly ? textChars(raw) : (norm.textChars ?? MIN_TEXT_CHARS);
  if (chars < MIN_TEXT_CHARS) throw new BrainSaveError(EXIT.ERROR, `${file} has only ${chars} character(s) of ${opts.storeOnly ? "content" : "text"} (minimum ${MIN_TEXT_CHARS}): an empty document is not knowledge; nothing saved`);
  // An embedded image / binary blob (a wrapped data URI, a fenced base64 dump) is not text: it used to be
  // embedded as ~115 chunks of noise (adjudication round 3). --store-only keeps raw bytes without embedding.
  if (!opts.storeOnly) {
    const share = base64Share(body);
    if (share > MAX_BASE64_SHARE) throw new BrainSaveError(EXIT.ERROR, `${file} is ${Math.round(share * 100)}% base64 (runs of ${BASE64_RUN_MIN}+ characters: an embedded image or binary blob, not text); remove the blob, or keep the raw file with --store-only; nothing saved`);
  }

  return {
    input, ext, raw, rawSha, norm, kind, app, title, date, body, contentSha, slug, identity, identityKind, brainId, key, source, sourceRepo, artifactUrl, ring, base,
    tags, tagsKey: [...tags].sort().join(","), explicitTitle: Boolean(opts.title), explicitTags: tags.length > 0,
  };
}

/** A title/tags/app/source correction with an identical body is a NEW version (adjudication round 2: title and
 *  tags used to be "unchanged"/"alias" with exit 0 while the stored header kept the old value; round 4: so did
 *  --app, and a corrected source). Only EXPLICIT title/tags count (a re-put that merely omits them keeps what
 *  is stored); the app, kind and source IDENTITY (repo:path or URL, the commit sha is ignored) count whenever
 *  they are known and differ from what is stored. A changed app re-keys the document (the key embeds it). */
function metaChanged(live, reg, p) {
  if (p.explicitTitle && p.title !== (live.title ?? (reg && reg.title))) return true;
  if (p.explicitTags && p.tagsKey !== String(live.tags ?? "")) return true;
  if (reg && reg.app && p.app !== reg.app) return true;
  if (reg && reg.kind && p.kind !== reg.kind) return true;
  if (p.source && sourceIdentity(p.source) !== sourceIdentity(live.source || "")) return true;
  if (p.artifactUrl && sourceIdentity(p.artifactUrl) !== sourceIdentity(live.artifact_url || "")) return true;
  return false;
}

/** Resolve what this save means against the registry: unchanged | alias | retry | new.
 *  opts.noAlias skips the identical-content alias (used when the alias target proved NOT searchable). */
export async function resolveVersion(backend, p, opts) {
  const { doc: reg } = await readRegistry(backend, p.brainId);
  const live = liveVersion(reg);
  const latest = latestVersion(reg);
  if (live && live.content_sha256 === p.contentSha && !opts.supersedes && !metaChanged(live, reg, p)) return { mode: "unchanged", reg, key: live.key, version: live.version, title: (reg && reg.title) || p.title };
  if (latest && latest.status === "stored-unverified" && latest.content_sha256 === p.contentSha && !metaChanged(latest, reg, p)) return { mode: "retry", reg, key: latest.key, version: latest.version, supersedesKey: live && live.key !== latest.key ? live.key : "" };
  const prevId = (p.input && p.input.previousBrainId) || "";
  const explicit = Boolean(opts.supersedes || opts.id);
  // TITLE identities (no --id, no source, no Artifact URL) are kind/app/<title slug>: two DIFFERENT files
  // with the same title share one. Replacing a live version is allowed only for the SAME file (its local
  // receipt names this identity) or with an explicit --supersedes / --id (adjudication round 3: build
  // receipts 57 and 58 had the same H1, both exited 0, and receipt 57 silently left the brain).
  if (p.identityKind === "title" && live && !explicit && prevId !== p.brainId) {
    throw new BrainSaveError(EXIT.ERROR, `identity collision: "${p.title}" is already live as ${p.brainId} from a different file; nothing saved. A newer version of THAT document: --supersedes ${p.brainId}. A DIFFERENT document: give it a distinct title (H1 or --title) or a stable --id. (live: ${live.key})`);
  }
  let supersedesKey = live ? live.key : "";
  let supersedesBrainId = live ? p.brainId : "";
  // The SAME local file re-saved under a new title (or kind/app): its previous identity (local receipt)
  // is superseded, so the old draft does not stay searchable next to the new one. Only a title identity
  // is ever superseded this way, never a sourced / --id document.
  let fromReceipt = false;
  if (!live && p.identityKind === "title" && prevId && prevId !== p.brainId && !explicit) {
    const { doc: prev } = await readRegistry(backend, prevId);
    if (prev && prev.live_key && isTitleIdentity(prev.identity)) { supersedesKey = prev.live_key; supersedesBrainId = prevId; fromReceipt = true; }
  }
  if (!opts.id && !opts.supersedes && !opts.noAlias) {
    const { doc: alias } = await readByHash(backend, p.contentSha);
    // Identical content under ANOTHER identity is an alias -- unless that other identity is this same
    // file's previous title (a --title correction of an unchanged body), which is superseded instead.
    if (alias && alias.brain_id && alias.brain_id !== p.brainId && !(fromReceipt && alias.brain_id === supersedesBrainId)) {
      const { doc: other } = await readRegistry(backend, alias.brain_id);
      if (other && other.live_key === alias.key) return { mode: "alias", reg: other, key: alias.key, version: (liveVersion(other) || {}).version, aliasOf: alias.brain_id, title: other.title || p.title };
    }
  }
  if (opts.supersedes) {
    const t = String(opts.supersedes);
    if (t.startsWith("_KNOWLEDGE/")) {
      if (!parseKnowledgeKey(t)) throw new BrainSaveError(EXIT.ERROR, `--supersedes "${t.slice(0, 120)}" is not a valid stored key (expected _KNOWLEDGE/<kind>/<app>/<yyyy-mm-dd>-<slug>-<sha8>.md); nothing saved`);
      supersedesKey = t; supersedesBrainId = opts.supersedesBrainId || "";
    } else {
      if (!isBrainId(t)) throw new BrainSaveError(EXIT.ERROR, `--supersedes "${t.slice(0, 60)}" is neither a stored key nor a brain_id (KN-<KIND>-<10 hex>); nothing saved`);
      const { doc: other } = await readRegistry(backend, t);
      if (!other || !other.live_key) throw new BrainSaveError(EXIT.ERROR, `--supersedes ${t}: no live document with that brain_id`);
      supersedesKey = other.live_key; supersedesBrainId = t;
    }
  }
  const version = ((latest && Number(latest.version)) || 0) + 1;
  return { mode: "new", reg, key: p.key, version, supersedesKey, supersedesBrainId };
}

function baseResult(p, extra = {}) {
  return { file: p.input.displayPath || p.input.localPath, status: "", exit: 0, brain_id: p.brainId, key: p.key, version: null, chunks: 0, ranks: { id: 0, title: 0, gateway: "skipped" }, warnings: p.ring.warnings.slice(), ...extra };
}

function receiptFor(p, result) {
  if (!p.input.localPath) return;
  writeReceipt({ local_path: p.input.localPath, size: p.input.size ?? p.input.bytes.length, mtime_ms: p.input.mtimeMs ?? null, raw_sha256: p.rawSha, brain_id: result.brain_id, own_brain_id: p.brainId, key: result.key, status: result.status, saved_at: new Date().toISOString() });
}

const errText = (e) => String((e && e.message) || e).replace(/Bearer\s+\S+/g, "Bearer [redacted]");

/** Room proof that never throws: a search-backend failure is "not proven", with the reason kept (verifyInRoom
 *  itself retries through exceptions and reports the final attempt's `error` / `cleanMiss`). */
async function safeVerifyInRoom(backend, args) {
  try { return { error: "", cleanMiss: false, ...(await verifyInRoom(backend, args)) }; }
  catch (e) { return { ok: false, idRank: 0, titleRank: 0, top3: [], error: errText(e).slice(0, 200), cleanMiss: false }; }
}

/**
 * Stage 2: save a batch of prepared docs. Returns one result per doc. One document's failure (a thrown
 * search, a gateway network error) never aborts the batch: every doc gets its own result and exit code.
 * opts: { dryRun, storeOnly, gateway ("auto"|"on"|"off"), gatewayEvery (N: prove every Nth + last),
 *         supersedes, id, retries, delayMs }
 */
export async function saveBatch(backend, prepared, opts = {}, ctx = {}) {
  const results = [];
  const work = [];
  for (const p of prepared) {
    const r = baseResult(p);
    let plan;
    try { plan = await resolveVersion(backend, p, opts); }
    catch (e) { results.push({ ...r, status: "error", exit: e.exit || EXIT.ERROR, message: errText(e).slice(0, e instanceof BrainSaveError ? 1000 : 300) }); continue; }
    if (plan.mode === "unchanged" || plan.mode === "alias") {
      const res = { ...r, status: plan.mode, key: plan.key, brain_id: plan.mode === "alias" ? plan.aliasOf : p.brainId, version: plan.version, message: plan.mode === "alias" ? `identical content already saved as ${plan.aliasOf}` : "identical content already live" };
      if (opts.dryRun) { results.push(res); continue; }
      // ALWAYS prove it (adjudication round 2): "unchanged" used to exit 0 without any brain check, even
      // after the room lost its chunks and the S3 object was gone. Keyword-only (no embedding call): the
      // content-unique id query is the strong proof; an identical re-put stays zero-write, zero-embed.
      const v = await safeVerifyInRoom(backend, { key: plan.key, brainId: res.brain_id, title: plan.title || p.title, contentSha: p.contentSha, retries: opts.existingRetries ?? 2, delayMs: opts.delayMs ?? verifyDelay() });
      res.ranks = { id: v.idRank, title: v.titleRank, gateway: "skipped" };
      if (v.error) { results.push({ ...res, status: "not-searchable", exit: EXIT.NOT_SEARCHABLE, message: `${res.message}, but the brain could not be checked (${v.error}); not proven searchable` }); continue; }
      // The S3 object is the document of record: chunks alone are not "saved" (adjudication round 3: a
      // re-put after the live object was deleted printed UNCHANGED, exit 0, and never restored it).
      let objectPresent;
      try { objectPresent = (await backend.get(plan.key)).text != null; }
      catch (e) { results.push({ ...res, status: "not-searchable", exit: EXIT.NOT_SEARCHABLE, message: `${res.message}, but its stored object could not be checked (${errText(e).slice(0, 160)}); not proven saved` }); continue; }
      if (v.ok && objectPresent) {
        if (plan.mode === "alias") {
          // The alias records THIS document's identity metadata (adjudication round 4): it used to leave no
          // trace of the new title / app / source / tags anywhere while exiting 0.
          try { await recordAlias(backend, p, plan); }
          catch (e) { results.push({ ...res, status: "error", exit: EXIT.ERROR, message: `${res.message}, but recording this document's identity (${p.brainId}) failed: ${errText(e).slice(0, 200)}; not saved as its own identity` }); continue; }
        }
        receiptFor(p, res); results.push(res); continue;
      }
      // NOT searchable, or the object is gone: fall through to a re-push (no receipt unless it verifies).
      const why = [...(v.ok ? [] : [`was NOT searchable (id rank ${v.idRank}, title rank ${v.titleRank})`]), ...(objectPresent ? [] : ["had NO stored S3 object"])].join(" and ");
      r.warnings.push(`${plan.mode === "alias" ? `alias target ${plan.aliasOf}` : "the live version"} ${plan.key} ${why}; ${plan.mode === "alias" ? "saving this document under its own identity" : objectPresent ? "re-pushing" : "recreating and re-pushing it"}`);
      if (plan.mode === "unchanged") plan = { ...plan, mode: "repair", supersedesKey: "", supersedesBrainId: "" };
      else {
        try { plan = await resolveVersion(backend, p, { ...opts, noAlias: true }); }
        catch (e) { results.push({ ...r, status: "error", exit: e.exit || EXIT.ERROR, message: errText(e).slice(0, 300) }); continue; }
      }
    }
    const key = plan.key;
    const fields = { ...p.base, version: String(plan.version), supersedes: plan.supersedesKey && plan.supersedesKey !== key ? plan.supersedesKey : "", key_ref: keyRefFor(key) };
    const object = buildObject(buildHeader(fields), p.body);
    const hits = scanParts({ object }, ctx.needles || []);
    if (hits.length) { results.push({ ...r, status: "refused", exit: EXIT.REFUSED, refused: { codes: ["SECRET"] }, message: formatSecretHits(hits).join("\n") }); continue; }
    const reused = plan.mode === "retry" || plan.mode === "repair";
    if (opts.dryRun) {
      results.push({ ...r, key, version: plan.version, status: "planned", message: `${reused ? `would ${plan.mode} push+verify of` : "would save"} ${key} (v${plan.version}${plan.supersedesKey && plan.supersedesKey !== key ? `, superseding ${plan.supersedesKey}` : ""}); nothing written, nothing embedded` });
      continue;
    }
    if (opts.storeOnly) {
      let stored = false;
      try {
        await createObject(backend, srcKeyFor(key, p.ext === ".md" || p.ext === ".markdown" ? ".md" : p.ext), p.input.bytes, contentTypeFor(p.ext));
        stored = true;
        await updateRegistry(backend, p.brainId, (doc) => addVersion(doc, p, { version: plan.version, key, status: "stored-only", searchable: false, src_key: srcKeyFor(key, p.ext) }));
        const res = { ...r, key, version: plan.version, status: "stored-only", exit: EXIT.STORED_ONLY, message: `raw source stored under ${srcKeyFor(key, p.ext)}; NOT searchable, by request (--store-only): exit ${EXIT.STORED_ONLY} means "stored, not in the brain's search"` };
        receiptFor(p, res);
        results.push(res);
      } catch (e) { results.push({ ...r, key, status: "error", exit: EXIT.ERROR, message: `${stored ? "raw source stored but the registry update failed" : "nothing stored"}: ${errText(e).slice(0, 300)}` }); }
      continue;
    }
    // `stored` = the searchable object exists in S3 (so a failure below leaves a retryable
    // stored-unverified version). A failure BEFORE that is "nothing stored" (exit 1), never exit 3.
    let stored = false;
    try {
      let objectText = object;
      if (reused) {
        const got = await backend.get(key);
        if (got.text == null) await createObject(backend, key, object); // recreate: identical body by construction
        else objectText = got.text;
        stored = true;
      } else {
        const c = await createObject(backend, key, objectText);
        stored = true;
        // PENDING registry entry BEFORE any chunk exists (adjudication round 3): a process killed between
        // the push and the "live" registry write used to leave a searchable object no registry knew about,
        // so the next version never retired it and audit reported 0 findings. Now the crash leaves a
        // stored-unverified version that retireOrphans / audit --repair find. Skipped when this key already
        // has an entry (a same-key header rewrite of the live version must not demote it first).
        if (!((plan.reg && plan.reg.versions) || []).some((x) => x.key === key)) {
          await updateRegistry(backend, p.brainId, (doc) => addVersion(doc, p, { version: plan.version, key, status: "stored-unverified", pending: true, supersedes: plan.supersedesKey && plan.supersedesKey !== key ? plan.supersedesKey : "" }));
        }
        if (!c.created) {
          // The key already exists: identical BODY by construction (the key embeds its hash), but the
          // header can differ (a same-day title/tags correction, or a crashed earlier attempt). Rewrite it
          // so S3, the room and the registry all carry the new header; pushObject prunes stale chunks.
          const cur = await backend.get(key);
          if (cur.text !== objectText) await backend.put(key, objectText, "text/markdown; charset=utf-8");
        }
        if (!(p.ext === ".md" || p.ext === ".markdown")) await createObject(backend, srcKeyFor(key, p.ext), p.input.bytes, contentTypeFor(p.ext));
      }
      const { chunks } = await pushObject(backend, key, objectText);
      work.push({ p, plan, key, chunks, r });
    } catch (e) {
      if (!stored) { results.push({ ...r, key, version: plan.version, status: "error", exit: EXIT.ERROR, message: `nothing stored: ${errText(e).slice(0, 300)}` }); continue; }
      try { await updateRegistry(backend, p.brainId, (doc) => addVersion(doc, p, { version: plan.version, key, status: "stored-unverified", error: errText(e).slice(0, 200) })); } catch { /* registry is best-effort here */ }
      results.push({ ...r, key, version: plan.version, status: "not-searchable", exit: EXIT.NOT_SEARCHABLE, message: `stored but NOT searchable: ${errText(e).slice(0, 300)}` });
    }
  }
  if (work.length) {
    try { await backend.refresh(); } catch { /* verify retries cover a slow refresh */ }
  }
  const every = Math.max(1, Number(opts.gatewayEvery) || 1);
  for (let i = 0; i < work.length; i++) {
    const { p, plan, key, chunks, r } = work[i];
    const res = { ...r, key, version: plan.version, chunks };
    const v = await safeVerifyInRoom(backend, { key, brainId: p.brainId, title: p.title, contentSha: p.contentSha, retries: opts.retries ?? 3, delayMs: opts.delayMs ?? verifyDelay(), embedTitle: ctx.embedTitle });
    res.ranks = { id: v.idRank, title: v.titleRank, gateway: "skipped" };
    let gatewayFail = "";
    let gatewayCouldNotRun = false;
    let gatewayUnproven = "";
    if (v.ok && opts.gateway !== "off" && (i % every === 0 || i === work.length - 1)) {
      let g;
      try { g = await verifyViaGateway(backend, { key, brainId: p.brainId, title: p.title, contentSha: p.contentSha, retries: opts.gatewayRetries ?? 2, delayMs: opts.delayMs ?? verifyDelay() }); }
      catch (e) { g = { status: "error", rank: 0, query: "", reason: errText(e).slice(0, 200) }; }
      res.ranks.gateway = g.status === "ok" ? `${g.rank} (${g.query} query)` : g.status;
      if (g.status === "missing") gatewayFail = g.reason;
      else if (g.status === "error") {
        // ATTEMPTED and it did not pass (round 4, C2): never a warning. The room proof stands, so the document
        // stays live, but the exit code is the distinct GATEWAY_UNPROVEN, not 0.
        if (opts.gateway === "on") { gatewayFail = `gateway proof required (--gateway on) but ${g.status}: ${g.reason || ""}`.trim(); gatewayCouldNotRun = true; }
        else gatewayUnproven = `gateway proof ${g.status}: ${g.reason || ""}`.trim();
      } else if (g.status !== "ok") {
        // "skipped": the proof was never attempted (no lane token). --gateway on makes it REQUIRED.
        if (opts.gateway === "on") { gatewayFail = `gateway proof required (--gateway on) but ${g.status}: ${g.reason || ""}`.trim(); gatewayCouldNotRun = true; }
        else res.warnings.push(`gateway proof ${g.status}: ${g.reason || ""}`.trim());
      }
    }
    if (!v.ok || gatewayFail) {
      // A proof that COULD NOT RUN is not a proven miss (round 4, C1): the document was stored and pushed, so
      // its chunks are KEPT and the exit is non-zero ("stored + pushed, proof could not run"). Chunks are
      // deleted only after a proven clean miss.
      const proofCouldNotRun = (!v.ok && Boolean(v.error)) || gatewayCouldNotRun;
      const why = v.error ? `room proof could not run: ${v.error}` : gatewayFail || `room proof failed: id rank ${v.idRank}, title rank ${v.titleRank}; top hits ${v.top3.join(" , ")}`;
      if (proofCouldNotRun) {
        try { await updateRegistry(backend, p.brainId, (doc) => setVersion(doc, p, plan, key, { status: "stored-unverified", chunks, ranks: res.ranks, proof: "could-not-run" })); } catch { /* best-effort */ }
        results.push({ ...res, status: "not-searchable", exit: EXIT.NOT_SEARCHABLE, message: `stored + pushed, proof could not run (${why}); its ${chunks} chunk(s) were LEFT in place (nothing proves it is NOT searchable); re-run \`brain-save put\` on the same file to verify it, or \`brain-save audit --repair\`` });
        continue;
      }
      // A same-key header rewrite shares its chunks with the live version: leave them (identical body).
      const sameKeyAsLive = plan.mode === "new" && plan.supersedesKey === key;
      let removed = false;
      let delErr = "";
      if (!sameKeyAsLive) {
        try { await backend.deleteByParent(parentIdFor(key)); removed = true; } catch (e) { delErr = errText(e).slice(0, 160); }
        try { await updateRegistry(backend, p.brainId, (doc) => setVersion(doc, p, plan, key, { status: "stored-unverified", chunks: removed ? 0 : chunks, ranks: res.ranks })); } catch { /* best-effort */ }
      }
      const tail = sameKeyAsLive ? "the live version shares this key, so its chunks were left in place; re-run to retry"
        : removed ? "its chunks were removed so no half-searchable doc remains"
        : `removing its chunks FAILED (${delErr}), so it may be PARTIALLY searchable until a re-run or \`brain-save audit --repair\``;
      results.push({ ...res, status: "not-searchable", exit: EXIT.NOT_SEARCHABLE, message: `stored but NOT searchable (${why}); ${tail}` });
      continue;
    }
    let regAfterLive = null;
    try {
      regAfterLive = await updateRegistry(backend, p.brainId, (doc) => setVersion(doc, p, plan, key, { status: "live", chunks, ranks: res.ranks, verified_at: new Date().toISOString(), supersede_pending: Boolean(plan.supersedesKey && plan.supersedesKey !== key) }));
      await writeByHash(backend, p.contentSha, { brain_id: p.brainId, key });
      if (p.ring.overrideAccepted) await writeOverrideAudit(backend, { brainId: p.brainId, sha8: p.contentSha.slice(0, 8), record: { brain_id: p.brainId, key, reason: p.base.ring_override, signals: p.ring.heuristic, agent: p.base.author_agent, at: new Date().toISOString() } });
    } catch (e) {
      results.push({ ...res, status: "error", exit: EXIT.ERROR, message: `searchable, but registry update failed: ${errText(e).slice(0, 200)} (run audit --repair)` });
      continue;
    }
    res.status = "saved";
    // A failed earlier attempt (exit 3) leaves its object under _KNOWLEDGE/ as "stored-unverified". Once a
    // newer version of the same identity is live, that orphan must not stay indexable: the armed nightly
    // push (or audit --repair) would resurrect stale content next to the live version (found in verify
    // round 1). Retire every other stored-unverified version of this identity, best-effort and reported.
    // A FAILED cleanup leaves a stale, still-indexable object behind: exit 4, not a warning (round 4).
    try { await retireOrphans(backend, p.brainId, key, regAfterLive); }
    catch (e) { res.status = "supersede-pending"; res.exit = EXIT.SUPERSEDE_PENDING; res.message = `saved and verified, but orphan cleanup is incomplete: ${errText(e).slice(0, 160)} (a stale stored-unverified object may still be indexable; run audit --repair)`; }
    // Concurrent saves of ONE identity (adjudication round 2): two parallel v2 saves both went live and
    // both stayed searchable. The registry this save just wrote is authoritative (ETag-guarded): any other
    // version still marked live there is superseded now. The last registry writer always wins.
    const concurrent = ((regAfterLive && regAfterLive.versions) || []).filter((x) => x.status === "live" && x.key && x.key !== key && x.key !== plan.supersedesKey);
    for (const x of concurrent) {
      try { await supersede(backend, { oldKey: x.key, oldBrainId: p.brainId, newKey: key }); res.warnings.push(`superseded concurrent live version ${x.key}`); }
      catch (e) { res.status = "supersede-pending"; res.exit = EXIT.SUPERSEDE_PENDING; res.message = `saved and verified, but superseding concurrent live version ${x.key} failed: ${errText(e).slice(0, 160)} (run audit --repair)`; }
    }
    if (plan.supersedesKey && plan.supersedesKey !== key) {
      try {
        await supersede(backend, { oldKey: plan.supersedesKey, oldBrainId: plan.supersedesBrainId || p.brainId, newKey: key });
        await updateRegistry(backend, p.brainId, (doc) => { doc.supersede_pending = false; return doc; });
        res.superseded = plan.supersedesKey;
      } catch (e) {
        res.status = "supersede-pending";
        res.exit = EXIT.SUPERSEDE_PENDING;
        res.message = `saved and verified, but superseding ${plan.supersedesKey} failed: ${errText(e).slice(0, 200)} (registry supersede_pending; run audit --repair)`;
      }
    }
    if (gatewayUnproven && res.exit === EXIT.OK) {
      res.status = "gateway-unproven"; res.exit = EXIT.GATEWAY_UNPROVEN;
      res.message = `stored and room-verified (id rank ${res.ranks.id}, title rank ${res.ranks.title}), but the GATEWAY proof did not pass: ${gatewayUnproven.replace(/^gateway proof /, "")}; not proven searchable through mcp.otchealth.app. Re-check with \`brain-save verify "<title>" --expect ${p.brainId}\``;
    } else if (gatewayUnproven) res.warnings.push(gatewayUnproven);
    receiptFor(p, res);
    results.push(res);
  }
  return results;
}

/** Record an alias: this document's identity (title/app/source/tags) points at the identical content already
 *  live under another identity. Written only when it is new or changed (an identical re-put stays zero-write). */
async function recordAlias(backend, p, plan) {
  const { doc: cur } = await readRegistry(backend, p.brainId);
  const same = cur && cur.alias_of === plan.aliasOf && cur.alias_key === plan.key && cur.title === p.title && cur.app === p.app && cur.kind === p.kind && cur.tags === (p.tagsKey ?? "") && (!p.source || cur.source === p.source) && (!p.artifactUrl || cur.artifact_url === p.artifactUrl);
  if (same) return;
  await updateRegistry(backend, p.brainId, (doc) => {
    const d = doc || emptyRegistry(p);
    Object.assign(d, { identity: p.identity, kind: p.kind, app: p.app, title: p.title, tags: p.tagsKey ?? "", source: p.source, artifact_url: p.artifactUrl, alias_of: plan.aliasOf, alias_key: plan.key, aliased_at: new Date().toISOString() });
    if (!d.live_key) d.status = "alias";
    return d;
  });
}

function contentTypeFor(ext) {
  return { ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".json": "application/json", ".txt": "text/plain; charset=utf-8" }[ext] || "text/markdown; charset=utf-8";
}

function emptyRegistry(p) {
  return { brain_id: p.brainId, identity: p.identity, kind: p.kind, app: p.app, title: p.title, created_at: new Date().toISOString(), status: "", live_key: "", latest_version: 0, supersede_pending: false, versions: [] };
}

/** Append a version entry. An existing entry for the SAME key is replaced when it is not a finished
 *  state (stored-unverified / abandoned / stored-only), or when it is the live entry of the SAME version
 *  (a repair re-push). A live entry of an OLDER version at the same key (a same-day title/tags header
 *  correction) is kept in the chain as superseded. */
export function addVersion(doc, p, v) {
  const d = doc || emptyRegistry(p);
  d.title = p.title; d.kind = p.kind; d.app = p.app; d.identity = p.identity;
  const now = new Date().toISOString();
  const kept = [];
  for (const x of d.versions || []) {
    if (x.key !== v.key || x.status === "superseded" || x.status === "retracted") { kept.push(x); continue; }
    if (x.status === "live" && Number(x.version) !== Number(v.version)) { kept.push({ ...x, status: "superseded", superseded_at: now, superseded_by: v.key, superseded_reason: "metadata-only update (same key)" }); continue; }
    // otherwise: replaced by the entry below
  }
  d.versions = kept;
  d.versions.push({ version: Number(v.version), key: v.key, content_sha256: p.contentSha, title: p.title, tags: p.tagsKey ?? "", saved_at: p.base.saved_at, source: p.source, artifact_url: p.artifactUrl, author_agent: p.base.author_agent, ...v });
  d.latest_version = Math.max(Number(d.latest_version) || 0, Number(v.version));
  if (!d.live_key) d.status = v.status;
  return d;
}

function setVersion(doc, p, plan, key, patch) {
  const d = addVersion(doc, p, { version: plan.version, key, supersedes: plan.supersedesKey && plan.supersedesKey !== key ? plan.supersedesKey : "", ...patch });
  if (patch.status === "live") { d.live_key = key; d.status = "live"; d.supersede_pending = Boolean(patch.supersede_pending); delete d.alias_of; delete d.alias_key; delete d.aliased_at; }
  return d;
}

/** Archive every stored-unverified version of `brainId` other than `liveKey` (chunks removed first). */
export async function retireOrphans(backend, brainId, liveKey, reg) {
  const orphans = ((reg && reg.versions) || []).filter((v) => v.status === "stored-unverified" && v.key && v.key !== liveKey);
  for (const v of orphans) {
    // Re-read first: a stored-unverified entry may be a CONCURRENT save still in flight (its pending entry is
    // written before its push); if it went live meanwhile, it is not an orphan.
    const { doc: now } = await readRegistry(backend, brainId);
    const cur = now && [...(now.versions || [])].reverse().find((y) => y.key === v.key);
    if (now && (now.live_key === v.key || (cur && !["stored-unverified", "abandoned"].includes(cur.status)))) continue;
    await backend.deleteByParent(sha1(v.key));
    const archived = await archiveObject(backend, v.key);
    await updateRegistry(backend, brainId, (doc) => {
      const x = doc || { brain_id: brainId, versions: [] };
      const mark = { status: "abandoned", pending: undefined, abandoned_at: new Date().toISOString(), archived_key: archived };
      let found = false;
      for (const y of x.versions || []) if (y.key === v.key && (y.status === "stored-unverified" || y.status === "abandoned")) { Object.assign(y, mark, { abandoned_reason: v.abandoned_reason || y.abandoned_reason || "newer version verified live" }); found = true; }
      // A version no registry listed (audit --repair of an unregistered searchable object): record it.
      if (!found && !(x.versions || []).some((y) => y.key === v.key)) (x.versions ||= []).push({ key: v.key, ...mark, abandoned_reason: v.abandoned_reason || "unregistered version" });
      return x;
    });
  }
  return orphans.length;
}

/** Remove an old version from search and move it to the archive; record it in ITS registry. */
export async function supersede(backend, { oldKey, oldBrainId, newKey }) {
  await backend.deleteByParent(sha1(oldKey));
  const archived = await archiveObject(backend, oldKey);
  if (oldBrainId) {
    await updateRegistry(backend, oldBrainId, (doc) => {
      if (!doc) return { brain_id: oldBrainId, versions: [], status: "superseded", live_key: "", latest_version: 0 };
      const v = [...(doc.versions || [])].reverse().find((x) => x.key === oldKey);
      if (v) Object.assign(v, { status: "superseded", superseded_at: new Date().toISOString(), archived_key: archived, superseded_by: newKey });
      if (doc.live_key === oldKey) { doc.live_key = doc.live_key === newKey ? newKey : ""; if (!doc.live_key) doc.status = "superseded"; }
      return doc;
    });
  }
  return archived;
}

/** Retract: out of search, kept in the archive, registry status retracted. Nothing is hard-deleted. */
export async function retract(backend, { brainId, key, reason }) {
  let id = brainId;
  let k = key;
  if (!id && k) {
    const { text } = await backend.get(k);
    const m = String(text || "").match(/^brain_id:\s*"([^"]+)"/m);
    id = m ? m[1] : "";
  }
  if (!id) throw new BrainSaveError(EXIT.ERROR, "retract: cannot resolve a brain_id for that key");
  const { doc } = await readRegistry(backend, id);
  if (!k) k = doc && doc.live_key;
  if (!k) throw new BrainSaveError(EXIT.ERROR, `retract: ${id} has no live version`);
  const removed = await backend.deleteByParent(sha1(k));
  const archived = await archiveObject(backend, k);
  await updateRegistry(backend, id, (d) => {
    const x = d || { brain_id: id, versions: [] };
    const v = [...(x.versions || [])].reverse().find((y) => y.key === k);
    if (v) Object.assign(v, { status: "retracted", retracted_at: new Date().toISOString(), archived_key: archived, reason });
    if (x.live_key === k) { x.live_key = ""; x.status = "retracted"; }
    x.retract_reason = reason;
    return x;
  });
  return { brain_id: id, key: k, archived, chunksRemoved: removed, registry: registryKey(id) };
}

/** Record a refusal locally (no content) so the Stop-hook reminder does not nag about it. */
export function recordRefusal(input, err) {
  if (!input || !input.localPath) return;
  writeRefusal({ local_path: input.localPath, raw_sha256: input.bytes ? sha256(input.bytes) : "", code: (err.codes || ["REFUSED"]).join("+"), at: new Date().toISOString() });
}
