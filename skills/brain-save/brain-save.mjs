#!/usr/bin/env node
// brain-save -- put a document into the company brain AND prove it is searchable.
// Matt directive 2026-09-29: every research report, design doc, audit, review packet, build/deploy
// receipt, runbook, and the source of every published Artifact goes into the brain, proven searchable,
// so the tokens spent making it are reusable by every agent later. Full contract: SKILL.md.
//
//   brain-save put <paths...> --kind <kind|auto> --app <slug|auto> [--title ..] [--tags a,b]
//       [--source repo@sha:path|url] [--artifact-url url] [--date YYYY-MM-DD] [--id stable-id]
//       [--supersedes brain_id|key] [--ring-override "<reason>"] [--store-only] [--agent a] [--share]
//       [--gateway auto|on|off] [--dry-run] [--json] [--verify-existing]
//   brain-save verify <query> [--expect brain_id|key] [--top 10] [--gateway auto|on|off]
//   brain-save backfill <manifest.json> [--dry-run] [--include review] [--repos-root /home/user] [--no-fetch]
//   brain-save list [--kind k] [--app a] [--since date] [--agent a] [--details] [--check] [--json]
//   brain-save audit [--secrets] [--ring] [--searchable] [--repair] [--keys k1,k2]
//   brain-save retract <brain_id|key> --reason "<why>"
//   brain-save doctor
// Exit: 0 saved+verified (or unchanged) | 1 error | 2 refused, nothing written | 3 stored but NOT
// searchable | 4 saved, supersede incomplete. Every non-zero code means "not done".
import { readFileSync, statSync, existsSync, appendFileSync, realpathSync } from "node:fs";
import { extname, resolve, dirname, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { BrainSaveError, EXIT, combineExitCodes } from "./lib/errors.mjs";
import { prepareDoc, saveBatch, retract as retractDoc, recordRefusal, inferKind } from "./lib/pipeline.mjs";
import { collectFiles, gitInfo, resolveAgent, resolveSeat, resolveSession, receiptBrainIds, seatGate } from "./lib/local.mjs";
import { loadSecretNeedles } from "./lib/secret-values.mjs";
import { scanParts, formatSecretHits } from "./lib/secret-gate.mjs";
import { classifyRing, formatRingRefusal } from "./lib/ring-gate.mjs";
import { KNOWLEDGE_PREFIX, META_PREFIX, ROOM_INDEX, roomPathFor, splitObject, registryKey, sha1, sha256 } from "./lib/provenance.mjs";
import { readRegistry, readJson } from "./lib/store.mjs";
import { pushObject } from "./lib/push.mjs";
import { rankOf } from "./lib/verify.mjs";
import { SUPPORTED_EXTS } from "./lib/normalize.mjs";
import { withDeadlines, withTimeout, callTimeoutMs, putDeadlineMs, ssmTimeoutMs } from "./lib/deadline.mjs";

/** Raw input size caps, checked with stat BEFORE a file is read (a 450 MB file used to take 6 GB of
 *  memory). A normal put is capped well above the 400,000-char searchable limit (HTML pages carry inline
 *  CSS/JS that normalization drops); --store-only keeps raw bytes and has its own cap. */
export const MAX_INPUT_BYTES = 20 * 1024 * 1024;
export const MAX_STORE_ONLY_BYTES = 50 * 1024 * 1024;

const VALUE_FLAGS = {
  put: ["--kind", "--app", "--title", "--tags", "--source", "--artifact-url", "--date", "--ring", "--id", "--supersedes", "--ring-override", "--agent", "--gateway", "--session", "--gateway-every"],
  verify: ["--expect", "--top", "--gateway"],
  backfill: ["--include", "--repos-root", "--gateway", "--agent", "--gateway-every", "--limit"],
  list: ["--kind", "--app", "--since", "--agent"],
  audit: ["--keys"],
  retract: ["--reason"],
  doctor: [],
};

export function parseArgs(argv) {
  const cmd = argv[0] || "help";
  const valueFlags = new Set(VALUE_FLAGS[cmd] || []);
  const pos = [];
  const flags = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq > 0 ? a.slice(0, eq) : a;
      if (eq > 0) flags[name] = a.slice(eq + 1);
      else if (valueFlags.has(name)) { if (i + 1 >= argv.length) throw new BrainSaveError(EXIT.ERROR, `${name} needs a value`); flags[name] = argv[++i]; }
      else flags[name] = true;
    } else pos.push(a);
  }
  return { cmd, pos, flags };
}

function makeIo(io = {}) {
  const out = io.stdout || ((s) => process.stdout.write(s + "\n"));
  const err = io.stderr || ((s) => process.stderr.write(s + "\n"));
  return { out, err };
}

/** Every backend (real or injected) is wrapped in per-call deadlines, capped by `deadlineAt` (epoch ms,
 *  0 = no overall budget). */
async function getBackend(deps, gateway, { deadlineAt = 0 } = {}) {
  if (deps.backend) return withDeadlines(deps.backend, { callMs: callTimeoutMs(), deadlineAt });
  const { createRealBackend } = await import("./lib/backend.mjs");
  return withDeadlines(await createRealBackend({ gateway: gateway || "auto", deadlineAt }), { callMs: callTimeoutMs(), deadlineAt });
}

async function getNeedles(deps, { deadlineAt = 0 } = {}) {
  if (deps.needles) return { needles: deps.needles, count: deps.needles.length };
  const ms = Math.min(ssmTimeoutMs(), deadlineAt ? Math.max(1, deadlineAt - Date.now()) : Infinity);
  try { return await withTimeout(loadSecretNeedles(deps.secretLoaderOptions || {}), ms, "SSM secret-value enumeration"); }
  catch (e) {
    if (e && e.deadline) throw new BrainSaveError(EXIT.REFUSED, `cannot load the fleet secret-value set (${e.message}); saving would be unverified.`, { code: "SECRET_SET_UNAVAILABLE" });
    throw e;
  }
}

/** Refuse privileged SEATS before any work (see lib/local.mjs seatGate): clo-personal never writes the
 *  open room; cfo / clo / capital need --share. Both the --agent flag and the KB_AGENT seat count. */
function assertSeat(agent, seat, share) {
  const g = seatGate({ agent, seat, share });
  if (g) throw new BrainSaveError(EXIT.REFUSED, `REFUSED (${g.code}): nothing written, nothing embedded. ${g.message}`, { codes: [g.code] });
}

function putOpts(flags) {
  return {
    kind: flags["--kind"], app: flags["--app"], title: flags["--title"], tags: flags["--tags"] ? String(flags["--tags"]).split(",").map((s) => s.trim()).filter(Boolean) : [],
    source: flags["--source"], artifactUrl: flags["--artifact-url"], date: flags["--date"], ring: flags["--ring"] || "commons", id: flags["--id"],
    supersedes: flags["--supersedes"], ringOverride: flags["--ring-override"] || "", storeOnly: Boolean(flags["--store-only"]),
    agent: resolveAgent(flags["--agent"]), seat: resolveSeat(), share: Boolean(flags["--share"]), session: resolveSession(flags["--session"]), gateway: flags["--gateway"] || "auto",
    dryRun: Boolean(flags["--dry-run"]), verifyExisting: Boolean(flags["--verify-existing"]), gatewayEvery: flags["--gateway-every"],
  };
}

/** Load one local file into a pipeline input. The path is resolved through symlinks BEFORE git
 *  provenance and the ring gate see it: a symlink to /home/user/medreview/README.md used to be saved
 *  (adjudication round 2) because `resolve` kept the link's own path, outside any repo. `localPath`
 *  stays the path the caller named (receipts match what the Stop hook sees); `realPath` is the target. */
export function inputFromFile(file, { git = gitInfo, maxBytes = MAX_INPUT_BYTES, storeOnly = false } = {}) {
  const abs = resolve(file);
  const real = realpathSync(abs);
  const st = statSync(real);
  if (st.size > maxBytes) throw new BrainSaveError(EXIT.ERROR, `${abs} is ${(st.size / 1048576).toFixed(1)} MB; the ${storeOnly ? "--store-only" : "put"} limit is ${(maxBytes / 1048576).toFixed(0)} MB (${storeOnly ? "split it" : "split it, or keep the raw file with --store-only up to " + (MAX_STORE_ONLY_BYTES / 1048576).toFixed(0) + " MB"}); nothing read, nothing saved`);
  const bytes = readFileSync(real);
  const gi = git(real);
  return { localPath: abs, realPath: real, displayPath: abs, bytes, ext: extname(real).toLowerCase() || extname(abs).toLowerCase(), size: st.size, mtimeMs: st.mtimeMs, git: gi, source: gi ? gi.source : "", sourceRepo: gi ? gi.repo : "" };
}

function printResult(io, r, json) {
  if (json) { io.out(JSON.stringify(r)); return; }
  const tag = { saved: "SAVED", unchanged: "UNCHANGED", alias: "ALIAS", planned: "DRY-RUN", "stored-only": "STORED-ONLY", refused: "REFUSED", error: "ERROR", "not-searchable": "NOT SEARCHABLE", "supersede-pending": "SUPERSEDE PENDING" }[r.status] || r.status.toUpperCase();
  io.out(`[${tag}] exit=${r.exit} ${r.file || ""}`);
  if (r.key) io.out(`   key=${r.key} brain_id=${r.brain_id || ""}${r.version != null ? ` v${r.version}` : ""}${r.chunks ? ` chunks=${r.chunks}` : ""}`);
  if (r.status === "saved" || (r.ranks && r.ranks.id)) io.out(`   proof: id-query rank ${r.ranks.id}, title-query rank ${r.ranks.title}, gateway ${r.ranks.gateway}`);
  if (r.superseded) io.out(`   superseded ${r.superseded} (chunks removed, archived)`);
  if (r.warnings && r.warnings.length) io.out(`   warnings: ${r.warnings.join(", ")}`);
  if (r.message) for (const line of String(r.message).split("\n")) io.out(`   ${line}`);
}

/** Two documents of ONE batch that share an identity but differ in content would silently replace each
 *  other (adjudication round 3). Returns the prepared docs to save plus one exit-1 result per collider. */
export function splitIdentityCollisions(prepared) {
  const byId = new Map();
  for (const p of prepared) { if (!byId.has(p.brainId)) byId.set(p.brainId, []); byId.get(p.brainId).push(p); }
  const keep = [];
  const errors = [];
  for (const [brainId, group] of byId) {
    if (new Set(group.map((p) => p.contentSha)).size <= 1) { keep.push(...group); continue; }
    const names = group.map((p) => p.input.displayPath || p.input.localPath);
    for (const p of group) errors.push({ file: p.input.displayPath || p.input.localPath, status: "error", exit: EXIT.ERROR, brain_id: brainId, message: `identity collision in this batch: ${names.length} files with DIFFERENT content map to one identity ${brainId} ("${p.title}"): ${names.join(", ")}. Nothing saved for them. Give each a distinct title (H1) or save them separately with --id.` });
  }
  return { keep: prepared.filter((p) => keep.includes(p)), errors };
}

async function cmdPut({ pos, flags }, deps, io) {
  if (!pos.length) throw new BrainSaveError(EXIT.ERROR, "put: give at least one file or folder");
  const deadlineAt = Date.now() + putDeadlineMs();
  const opts = putOpts(flags);
  if (!opts.kind) throw new BrainSaveError(EXIT.ERROR, "put: --kind is required (research|design|spec|audit|review|packet|build|deploy|receipt|runbook|artifact|report|decision|doc|auto)");
  assertSeat(opts.agent, opts.seat, opts.share);
  if (opts.agent === "unknown") io.err("[brain-save] warning: agent unknown (set --agent or KB_AGENT); recorded as \"unknown\"");
  const { files, skipped } = collectFiles(pos);
  for (const s of skipped) io.err(`[brain-save] skipped ${s.path}: ${s.reason}`);
  if (!files.length) throw new BrainSaveError(EXIT.ERROR, `put: no supported files found (${SUPPORTED_EXTS.join(" ")})`);
  // --title / --id name ONE document: across several files they gave every file the same identity, and all
  // but the last silently left the brain (adjudication round 3).
  if (files.length > 1 && (opts.title || opts.id)) throw new BrainSaveError(EXIT.ERROR, `put: ${opts.id ? "--id" : "--title"} names ONE document but ${files.length} files were given; put each file separately with its own ${opts.id ? "--id" : "--title"}, or drop the flag so each file keeps its own title (H1)`);
  const secretSet = await getNeedles(deps, { deadlineAt });
  const { needles } = secretSet;
  io.err(`[brain-save] secret gate armed: ${secretSet.count} live secret needle(s)${secretSet.ssmParams ? ` from ${secretSet.ssmParams} SSM parameter(s)` : ""} (values held in memory only)`);
  const results = [];
  let prepared = [];
  const previous = receiptBrainIds();
  const maxBytes = opts.storeOnly ? MAX_STORE_ONLY_BYTES : MAX_INPUT_BYTES;
  for (const f of files) {
    let input;
    try {
      input = (deps.inputFromFile || inputFromFile)(f, { maxBytes, storeOnly: opts.storeOnly });
      input.previousBrainId = previous.get(input.localPath) || "";
      prepared.push(prepareDoc(input, opts, { needles, now: deps.now }));
    } catch (e) {
      const exit = e.exit || EXIT.ERROR;
      if (exit === EXIT.REFUSED) recordRefusal(input, e);
      results.push({ file: f, status: exit === EXIT.REFUSED ? "refused" : "error", exit, refused: exit === EXIT.REFUSED ? { codes: e.codes || [] } : undefined, message: String(e.message) });
    }
  }
  const split = splitIdentityCollisions(prepared);
  prepared = split.keep;
  results.push(...split.errors);
  if (prepared.length) {
    const backend = await getBackend(deps, opts.gateway, { deadlineAt });
    const embedTitle = async (t) => (await backend.embed([t]))[0];
    results.push(...(await saveBatch(backend, prepared, opts, { needles, embedTitle })));
  }
  for (const r of results) printResult(io, r, flags["--json"]);
  return combineExitCodes(results.map((r) => r.exit));
}

async function cmdVerify({ pos, flags }, deps, io) {
  const query = pos.join(" ").trim();
  if (!query) throw new BrainSaveError(EXIT.ERROR, "verify: give a query");
  const top = Math.min(25, Math.max(1, Number(flags["--top"]) || 10));
  const backend = await getBackend(deps, flags["--gateway"]);
  let vector = null;
  try { vector = (await backend.embed([query]))[0]; } catch (e) { io.err(`[brain-save] embedding unavailable (${String(e.message).slice(0, 80)}); keyword-only`); }
  const hits = await backend.search({ queryText: query, vector, top });
  io.out(`room ${ROOM_INDEX}: ${hits.length} hit(s) for "${query}"`);
  hits.forEach((h, i) => io.out(`  ${i + 1}. ${h.path}`));
  let gw = null;
  if ((flags["--gateway"] || "auto") !== "off") {
    gw = await backend.gatewayKbSearch(query, top);
    if (gw.skipped) io.out(`gateway kb_search: skipped (${gw.reason})`);
    else if (!gw.ok) io.out(`gateway kb_search: error (${gw.reason})`);
    else { io.out(`gateway kb_search (coo lane): ${gw.matches.length} match(es)`); gw.matches.forEach((m, i) => io.out(`  ${i + 1}. ${m.path}`)); }
  }
  const expect = flags["--expect"];
  if (!expect) return EXIT.OK;
  let key = String(expect);
  if (!key.startsWith(KNOWLEDGE_PREFIX)) {
    const { doc } = await readRegistry(backend, key);
    if (!doc || !doc.live_key) { io.out(`expect ${expect}: no live document with that brain_id`); return EXIT.NOT_SEARCHABLE; }
    key = doc.live_key;
  }
  const rank = rankOf(hits, key);
  const gwRank = gw && gw.ok ? rankOf(gw.matches, key) : null;
  io.out(`expect ${key}: room rank ${rank || "not in top " + top}${gw && gw.ok ? `, gateway rank ${gwRank || "not in top " + top}` : ""}`);
  if (!rank) return EXIT.NOT_SEARCHABLE;
  if (gw && gw.ok && !gwRank) return EXIT.NOT_SEARCHABLE;
  return EXIT.OK;
}

async function cmdRetract({ pos, flags }, deps, io) {
  const target = pos[0];
  const reason = flags["--reason"];
  if (!target || !reason) throw new BrainSaveError(EXIT.ERROR, 'retract: usage: retract <brain_id|key> --reason "<why>"');
  const backend = await getBackend(deps, "off");
  const r = await retractDoc(backend, target.startsWith(KNOWLEDGE_PREFIX) ? { key: target, reason } : { brainId: target, reason });
  await backend.refresh().catch(() => {});
  io.out(`[RETRACTED] ${r.brain_id} ${r.key}: ${r.chunksRemoved} chunk(s) removed from ${ROOM_INDEX}; archived at ${r.archived}; registry ${r.registry}`);
  return EXIT.OK;
}

function parseKnowledgeKey(name) {
  const m = String(name).match(/^_KNOWLEDGE\/([a-z]+)\/([a-z0-9-]+)\/(\d{4}-\d{2}-\d{2})-(.+)-([0-9a-f]{8})\.md$/);
  return m ? { key: name, kind: m[1], app: m[2], date: m[3], slug: m[4], sha8: m[5] } : null;
}

async function cmdList({ flags }, deps, io) {
  const backend = await getBackend(deps, "off");
  let rows = (await backend.listMeta(KNOWLEDGE_PREFIX)).map((o) => ({ ...parseKnowledgeKey(o.name), lastModified: o.lastModified })).filter((r) => r.key);
  if (flags["--kind"]) rows = rows.filter((r) => r.kind === flags["--kind"]);
  if (flags["--app"]) rows = rows.filter((r) => r.app === flags["--app"]);
  if (flags["--since"]) rows = rows.filter((r) => r.date >= flags["--since"]);
  const details = flags["--details"] || flags["--agent"];
  let dark = 0;
  for (const r of rows) {
    if (details) { const { text } = await backend.get(r.key); const { fields } = splitObject(text || ""); r.brain_id = fields?.brain_id; r.title = fields?.title; r.agent = fields?.author_agent; r.version = fields?.version; }
    if (flags["--check"]) { r.chunks = await backend.countByPath(roomPathFor(r.key)); if (!r.chunks) dark++; }
  }
  if (flags["--agent"]) rows = rows.filter((r) => r.agent === flags["--agent"]);
  for (const r of rows) io.out(flags["--json"] ? JSON.stringify(r) : `${r.date} ${r.kind.padEnd(8)} ${r.app.padEnd(22)} ${r.key}${r.title ? `  "${r.title}"` : ""}${flags["--check"] ? `  chunks=${r.chunks}${r.chunks ? "" : " DARK"}` : ""}`);
  if (!flags["--json"]) io.out(`${rows.length} document(s)${flags["--check"] ? `, ${dark} dark (stored, not searchable)` : ""}`);
  return flags["--check"] && dark ? EXIT.NOT_SEARCHABLE : EXIT.OK;
}

/** Re-gate every live _KNOWLEDGE/ doc (secrets with a FRESH value set, ring with current rules,
 *  searchability), and find drift between the registry, S3 and the room:
 *    dark               stored, 0 chunks (and meant to be searchable)
 *    stale-chunks / orphan-object   superseded / failed versions still searchable or still under _KNOWLEDGE/
 *    extra-live         a version marked live that is not the registry's live_key
 *    unregistered-live  (round 3) a _KNOWLEDGE/ object WITH chunks that its registry does not know as live:
 *                       a process killed between the push and the registry write left it searchable next
 *                       to the live version with audit reporting 0 findings. --repair retires it when
 *                       another version is live, else adopts it as the live version.
 *    live-missing       (round 3) a registry live_key whose S3 object is gone (audit used to check 0 docs).
 *                       --repair restores it from _ARCHIVE/ or rebuilds it from its chunks (sha256-verified). */
export async function runAudit(backend, { needles, secrets = true, ring = true, searchable = true, repair = false, keys = null }, io) {
  const findings = [];
  let names = keys ? keys.slice() : (await backend.listMeta(KNOWLEDGE_PREFIX)).map((o) => o.name).filter((n) => n.endsWith(".md"));
  let dark = 0;
  const regCache = new Map();
  const registryOf = async (brainId) => {
    if (!brainId) return null;
    if (!regCache.has(brainId)) regCache.set(brainId, (await readRegistry(backend, brainId)).doc);
    return regCache.get(brainId);
  };
  // Keys the registry says are NOT meant to be searchable: an abandoned failed attempt, or a
  // stored-unverified version while a different version of the same identity is live. Their 0 chunks
  // are correct, so they are not "dark", and --repair must never re-push them.
  const retiredKeys = new Set();
  const registries = [];
  if (searchable && !keys) {
    for (const o of await backend.listMeta(`${META_PREFIX}registry/`)) {
      const { doc } = await readJson(backend, o.name);
      if (!doc) continue;
      registries.push(doc);
      if (doc.brain_id) regCache.set(doc.brain_id, doc);
      for (const v of doc.versions || []) if (v.key && v.key !== doc.live_key && (v.status === "abandoned" || (v.status === "stored-unverified" && doc.live_key))) retiredKeys.add(v.key);
    }
  }
  for (const key of names) {
    const { text } = await backend.get(key);
    if (text == null) { findings.push({ key, kind: "missing" }); continue; }
    const { fields, body } = splitObject(text);
    if (secrets) {
      const hits = scanParts({ object: text }, needles);
      if (hits.length) findings.push({ key, kind: "secret", detail: formatSecretHits(hits).join("; ") });
    }
    if (ring) {
      // The seat that accepted an override is recorded in it ("(by <agent>, seat <seat>, signals: ...)"): an
      // INND override is honored on re-check only if that seat could make it.
      const ov = fields?.ring_override || "";
      const seat = (ov.match(/, seat ([^,\s)]+)/) || [])[1] || "";
      const res = classifyRing({ text: body, source: fields?.source || "", artifactUrl: fields?.artifact_url || "", sourceRepo: (String(fields?.source || "").match(/^([A-Za-z0-9._-]+)@/) || [])[1] || "", override: ov, overrideSeat: seat });
      if (!res.allowed) findings.push({ key, kind: "ring", detail: formatRingRefusal(res).join("; ") });
    }
    if (searchable && !retiredKeys.has(key)) {
      const n = await backend.countByPath(roomPathFor(key));
      if (!n) {
        dark++;
        if (repair) {
          try { await pushObject(backend, key, text); await backend.refresh(); const n2 = await backend.countByPath(roomPathFor(key)); if (!n2) findings.push({ key, kind: "dark", detail: "repair push did not land" }); else io.out(`  repaired (re-pushed) ${key}`); }
          catch (e) { findings.push({ key, kind: "dark", detail: `repair failed: ${String(e.message).slice(0, 120)}` }); }
        } else findings.push({ key, kind: "dark", detail: "stored but 0 chunks in the room" });
      } else {
        // Searchable: is it the version its registry says is live?
        const brainId = fields?.brain_id || "";
        const doc = await registryOf(brainId);
        const knownLive = doc && (doc.live_key === key || (doc.versions || []).some((v) => v.key === key && v.status === "live"));
        if (!knownLive) {
          const other = doc && doc.live_key && doc.live_key !== key ? doc.live_key : "";
          if (repair) {
            try {
              if (other) {
                const { retireOrphans } = await import("./lib/pipeline.mjs");
                await retireOrphans(backend, brainId, other, { versions: [{ key, status: "stored-unverified", abandoned_reason: "unregistered searchable version (audit --repair)" }] });
                io.out(`  repaired: retired unregistered searchable version ${key} (live is ${other})`);
              } else {
                await adoptLive(backend, key, fields, n);
                io.out(`  repaired: adopted unregistered searchable version ${key} as live (${n} chunk(s))`);
              }
              regCache.delete(brainId);
            } catch (e) { findings.push({ key, kind: "unregistered-live", detail: `repair failed: ${String(e.message).slice(0, 120)}` }); }
          } else findings.push({ key, kind: "unregistered-live", detail: `${n} chunk(s) searchable but registry ${brainId || "(no brain_id)"} ${doc ? `does not list it as live${other ? ` (live is ${other})` : ""}` : "does not exist"}` });
        }
      }
    }
  }
  if (searchable && !keys) {
    for (const doc of registries) {
      if (doc.live_key && !(await backend.get(doc.live_key)).text) {
        if (repair) {
          try {
            const how = await restoreLiveObject(backend, doc);
            if (how) io.out(`  repaired: restored missing live object ${doc.live_key} (${how})`);
            else findings.push({ key: doc.live_key, kind: "live-missing", detail: `registry ${doc.brain_id}: object missing and not recoverable from _ARCHIVE/ or the room; re-put the source file` });
          } catch (e) { findings.push({ key: doc.live_key, kind: "live-missing", detail: `repair failed: ${String(e.message).slice(0, 120)}` }); }
        } else findings.push({ key: doc.live_key, kind: "live-missing", detail: `registry ${doc.brain_id} says live, but the S3 object is gone` });
      }
      for (const v of doc.versions || []) {
        // superseded / retracted / abandoned versions are never meant to be searchable; a stored-unverified
        // version is stale once a DIFFERENT version of the same identity is live (a failed earlier attempt).
        const stale = v.status === "superseded" || v.status === "retracted" || v.status === "abandoned" || (v.status === "stored-unverified" && doc.live_key);
        if (!stale) continue;
        if (v.key === doc.live_key) continue;
        const n = await backend.countByPath(roomPathFor(v.key));
        // A failed attempt's object still sitting in _KNOWLEDGE/ is indexable by the armed nightly push even
        // with 0 chunks today, so it is a finding (and archived by --repair) just like stale chunks.
        const orphanObject = (v.status === "stored-unverified" || v.status === "abandoned") && (await backend.get(v.key)).text != null;
        if (!n && !orphanObject) continue;
        if (repair) {
          if (n) { await backend.deleteByParent(sha1(v.key)); io.out(`  repaired: removed ${n} stale chunk(s) of ${v.status} ${v.key}`); }
          if (orphanObject) {
            const { retireOrphans } = await import("./lib/pipeline.mjs");
            await retireOrphans(backend, doc.brain_id, doc.live_key, { versions: [{ ...v, status: "stored-unverified" }] });
            io.out(`  repaired: archived orphan object ${v.key}`);
          }
        } else findings.push({ key: v.key, kind: n ? "stale-chunks" : "orphan-object", detail: `${v.status} version ${n ? `still has ${n} chunk(s) in the room` : "is still stored under _KNOWLEDGE/ (indexable by the nightly push)"}` });
      }
      // A version still marked live that is NOT the registry's live_key: a pending supersede (exit 4) or
      // the loser of two concurrent saves of one identity (adjudication round 2: both stayed searchable
      // and audit reported 0 findings). Flag it; --repair supersedes it in favor of live_key.
      const extraLive = (doc.versions || []).filter((v) => v.status === "live" && v.key && v.key !== doc.live_key);
      for (const v of extraLive) {
        if (repair && doc.live_key) {
          const { supersede } = await import("./lib/pipeline.mjs");
          await supersede(backend, { oldKey: v.key, oldBrainId: doc.brain_id, newKey: doc.live_key });
          io.out(`  repaired: superseded extra live version ${v.key} (live is ${doc.live_key})`);
        } else {
          const n = await backend.countByPath(roomPathFor(v.key));
          findings.push({ key: v.key, kind: "extra-live", detail: `registry ${doc.brain_id} marks it live but live_key is ${doc.live_key || "(none)"}${n ? `; ${n} chunk(s) still searchable` : ""}${doc.supersede_pending ? " (supersede pending)" : ""}` });
        }
      }
      if (repair && extraLive.length && doc.supersede_pending) {
        const { updateRegistry } = await import("./lib/store.mjs");
        await updateRegistry(backend, doc.brain_id, (d) => { d.supersede_pending = false; return d; });
      }
    }
  }
  return { checked: names.length, dark, findings };
}

/** audit --repair: make a searchable object that no registry knows as live the LIVE version of its
 *  identity (used only when no other version of that identity is live). */
async function adoptLive(backend, key, fields, chunks) {
  const brainId = fields?.brain_id;
  if (!brainId) throw new Error("no brain_id in its header");
  const { updateRegistry } = await import("./lib/store.mjs");
  const { writeByHash } = await import("./lib/store.mjs");
  const now = new Date().toISOString();
  await updateRegistry(backend, brainId, (d) => {
    const x = d || { brain_id: brainId, identity: "", kind: fields.kind || "", app: fields.app || "", title: fields.title || "", created_at: now, status: "", live_key: "", latest_version: 0, supersede_pending: false, versions: [] };
    x.versions = (x.versions || []).filter((v) => v.key !== key);
    const version = Number(fields.version) || 1;
    x.versions.push({ version, key, content_sha256: fields.content_sha256 || "", title: fields.title || "", tags: fields.tags || "", saved_at: fields.saved_at || "", source: fields.source || "", artifact_url: fields.artifact_url || "", author_agent: fields.author_agent || "", status: "live", chunks, verified_at: now, adopted: "audit --repair: searchable version no registry listed as live" });
    x.live_key = key; x.status = "live"; x.latest_version = Math.max(Number(x.latest_version) || 0, version);
    return x;
  });
  if (fields.content_sha256) await writeByHash(backend, fields.content_sha256, { brain_id: brainId, key });
}

/** audit --repair: put a missing live object back, from _ARCHIVE/ or rebuilt from its own chunks (the
 *  rebuild must hash to the chunks' content_hash, the sha256 of the exact stored object). Returns how, or "". */
async function restoreLiveObject(backend, doc) {
  const key = doc.live_key;
  const arch = await backend.get(`_ARCHIVE/${key}`);
  if (arch.text != null) { await backend.put(key, arch.text, "text/markdown; charset=utf-8"); return "from _ARCHIVE/"; }
  if (typeof backend.chunksByParent !== "function") return "";
  const chunks = await backend.chunksByParent(sha1(key));
  const text = rebuildFromChunks(chunks);
  if (!text) return "";
  await backend.put(key, text, "text/markdown; charset=utf-8");
  return `rebuilt from ${chunks.length} chunk(s), sha256 verified`;
}

/** Rebuild an object from its chunks (ids `<parent>_<n>`, contiguous slices with up to 200 chars of
 *  overlap). Returns "" unless the result hashes to the chunks' content_hash. Pure. */
export function rebuildFromChunks(chunks) {
  const list = [...(chunks || [])].map((c) => ({ ...c, n: Number(String(c.id || c.chunk_id || "").split("_").pop()) })).filter((c) => Number.isFinite(c.n) && typeof c.chunk === "string").sort((a, b) => a.n - b.n);
  if (!list.length || list.some((c, i) => c.n !== i)) return "";
  const want = list[0].content_hash || "";
  if (!/^[0-9a-f]{64}$/.test(want)) return "";
  let budget = 20000; // bounded backtracking (a highly repetitive text can match many overlap lengths)
  const solve = (i, acc) => {
    if (--budget < 0) return "";
    if (i === list.length) return sha256(acc) === want ? acc : "";
    const c = list[i].chunk;
    for (let L = Math.min(200, c.length, acc.length); L >= 0; L--) {
      if (!acc.endsWith(c.slice(0, L))) continue;
      const got = solve(i + 1, acc + c.slice(L));
      if (got) return got;
    }
    return "";
  };
  return solve(1, list[0].chunk);
}

async function cmdAudit({ flags }, deps, io) {
  const any = flags["--secrets"] || flags["--ring"] || flags["--searchable"];
  const backend = await getBackend(deps, "off");
  const secrets = any ? Boolean(flags["--secrets"]) : true;
  const { needles, count } = secrets ? await getNeedles(deps) : { needles: [], count: 0 };
  const keys = flags["--keys"] ? String(flags["--keys"]).split(",").map((s) => s.trim()).filter(Boolean) : null;
  const res = await runAudit(backend, { needles, secrets, ring: any ? Boolean(flags["--ring"]) : true, searchable: any ? Boolean(flags["--searchable"]) : true, repair: Boolean(flags["--repair"]), keys }, io);
  for (const f of res.findings) io.out(`  FINDING ${f.kind}: ${f.key}${f.detail ? ` -- ${f.detail}` : ""}`);
  io.out(`audit: ${res.checked} document(s) checked${secrets ? ` against ${count} live secret needle(s)` : ""}; ${res.findings.length} finding(s)`);
  if (res.findings.some((f) => f.kind === "secret" || f.kind === "ring")) return EXIT.REFUSED;
  if (res.findings.length) return EXIT.NOT_SEARCHABLE;
  return EXIT.OK;
}

async function cmdDoctor(parsed, deps, io) {
  const backend = await getBackend(deps, "auto");
  const checks = [];
  const run = async (name, fn) => { try { const d = await fn(); checks.push([name, true, d]); } catch (e) { checks.push([name, false, String((e && e.message) || e).replace(/Bearer\s+\S+/g, "Bearer [redacted]").slice(0, 200)]); } };
  const probe = `${META_PREFIX}_doctor/probe-${process.pid}-${Date.now()}.txt`;
  await run("s3 commons create-only put + delete", async () => { await backend.putCond(probe, "brain-save doctor probe\n", "text/plain", null); await backend.del(probe); return "ok"; });
  await run("ssm secret-value set (layer B)", async () => { const r = await getNeedles(deps); return `${r.count} needle(s) from ${r.ssmParams ?? "?"} parameter(s)`; });
  await run("openai embeddings", async () => { const v = await backend.embed(["brain-save doctor"]); return `${v[0].length} dims`; });
  await run("room mapping", async () => { const s = await backend.roomShape(); if (s !== "chunked") throw new Error(`shape ${s}`); return "chunked"; });
  await run("gateway kb_search (coo lane)", async () => { const g = await backend.gatewayKbSearch("brain-save doctor", 1); if (g.skipped || !g.ok) throw new Error(g.reason || "not ok"); return "ok"; });
  for (const [n, ok, d] of checks) io.out(`${ok ? "OK  " : "FAIL"} ${n}: ${d}`);
  return checks.every((c) => c[1]) ? EXIT.OK : EXIT.ERROR;
}

// ---------------- backfill ----------------
function readGitBlob(reposRoot, repo, ref, path, fetched, noFetch) {
  const dir = resolve(reposRoot, repo);
  if (!existsSync(dir)) throw new Error(`repo ${repo} not found under ${reposRoot}`);
  if (!noFetch && !fetched.has(repo)) { try { execFileSync("git", ["-C", dir, "fetch", "-q", "origin", "main"], { stdio: "ignore", timeout: 60000 }); } catch { /* offline: use what is there */ } fetched.add(repo); }
  const sha = execFileSync("git", ["-C", dir, "rev-parse", "--short=12", ref], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  let size = NaN;
  try { size = Number(execFileSync("git", ["-C", dir, "cat-file", "-s", `${ref}:${path}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()); } catch { /* show below reports it */ }
  if (size > MAX_STORE_ONLY_BYTES) throw new BrainSaveError(EXIT.ERROR, `${repo}@${ref}:${path} is ${(size / 1048576).toFixed(1)} MB (limit ${(MAX_STORE_ONLY_BYTES / 1048576).toFixed(0)} MB); nothing read, nothing saved`);
  const bytes = execFileSync("git", ["-C", dir, "show", `${ref}:${path}`], { stdio: ["ignore", "pipe", "ignore"], maxBuffer: MAX_STORE_ONLY_BYTES + 1024 });
  return { bytes, sha };
}

async function cmdBackfill({ pos, flags }, deps, io) {
  const manifestPath = pos[0];
  if (!manifestPath) throw new BrainSaveError(EXIT.ERROR, "backfill: give a manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const entries = Array.isArray(manifest) ? manifest : manifest.entries || [];
  const dryRun = Boolean(flags["--dry-run"]);
  const includeReview = String(flags["--include"] || "").split(",").includes("review");
  const reposRoot = flags["--repos-root"] || "/home/user";
  const resultsPath = `${manifestPath}.results.jsonl`;
  const done = new Set();
  if (!dryRun && existsSync(resultsPath)) for (const l of readFileSync(resultsPath, "utf8").split("\n")) { try { const r = JSON.parse(l); if (["saved", "unchanged", "alias", "stored-only"].includes(r.status)) done.add(r.sha256 || r.path); } catch { /* skip */ } }
  const agent = resolveAgent(flags["--agent"]);
  const seat = resolveSeat();
  assertSeat(agent, seat, Boolean(flags["--share"]));
  const { needles } = await getNeedles(deps);
  const backend = dryRun && deps.backend == null ? await getBackend(deps, "off") : await getBackend(deps, flags["--gateway"] || "auto");
  const previous = receiptBrainIds();
  const fetched = new Set();
  const summary = {};
  const bump = (k) => (summary[k] = (summary[k] || 0) + 1);
  const written = [];
  const storeGroups = new Map();
  let exits = [];
  const limit = Number(flags["--limit"]) || 0;
  let processed = 0;
  const record = (entry, r) => { if (!dryRun) appendFileSync(resultsPath, JSON.stringify({ path: entry.path, sha256: entry.sha256, include: entry.include, status: r.status, exit: r.exit, key: r.key, brain_id: r.brain_id, message: r.message ? String(r.message).slice(0, 300) : undefined, at: new Date().toISOString() }) + "\n"); };
  for (const entry of entries) {
    const inc = entry.include || "yes";
    if (inc === "hold") { bump("hold-skipped"); continue; }
    if (inc === "review" && !includeReview) { bump("review-skipped"); continue; }
    if (inc === "export-docs") { bump("export-docs-skipped"); io.out(`[SKIP] ${entry.path}: a Claude Docs doc; export it with the Docs \`export\` tool, then \`brain-save put\` the file`); continue; }
    const isUrl = /^https?:\/\//i.test(entry.path || "");
    if (inc === "refuse-commons") {
      const res = classifyRing({ text: "", artifactUrl: isUrl ? entry.path : "", source: isUrl ? "" : entry.path, localPath: isUrl ? "" : entry.path });
      if (res.allowed) { bump("refuse-commons-NOT-refused"); exits.push(EXIT.ERROR); io.out(`[GATE FAILURE] ${entry.path} is marked refuse-commons but the ring gate ALLOWED it; add it to config/ring-denylist.json`); }
      else { bump("refused-as-required"); io.out(`[REFUSED as required] ${entry.path}: ${formatRingRefusal(res)[0].trim()}`); }
      continue;
    }
    if (entry.sha256 && done.has(entry.sha256)) { bump("already-done"); continue; }
    if (limit && processed >= limit) { bump("over-limit"); continue; }
    processed++;
    let input;
    try {
      if (isUrl) {
        const res = classifyRing({ text: "", artifactUrl: entry.path });
        if (!res.allowed) { bump("refused"); io.out(`[REFUSED] ${entry.path}: ${formatRingRefusal(res)[0].trim()}`); continue; }
        bump("needs-artifact-read");
        io.out(`[NEEDS ARTIFACT READ] ${entry.path}: read it with the Artifact tool (action read), save the HTML locally, then: brain-save put <file> --kind artifact --app ${entry.app} --artifact-url ${entry.path}`);
        continue;
      }
      const m = String(entry.path).match(/^([A-Za-z0-9._-]+)@([^:]+):(.+)$/);
      if (m) {
        const { bytes, sha } = readGitBlob(reposRoot, m[1], m[2], m[3], fetched, Boolean(flags["--no-fetch"]));
        if (inc !== "store-only" && bytes.length > MAX_INPUT_BYTES) throw new BrainSaveError(EXIT.ERROR, `${entry.path} is ${(bytes.length / 1048576).toFixed(1)} MB; the put limit is ${(MAX_INPUT_BYTES / 1048576).toFixed(0)} MB (use include: store-only)`);
        input = { localPath: "", displayPath: entry.path, bytes, ext: extname(m[3]).toLowerCase(), source: `${m[1]}@${sha}:${m[3]}`, sourceRepo: m[1] };
      } else {
        input = inputFromFile(entry.path, { maxBytes: inc === "store-only" ? MAX_STORE_ONLY_BYTES : MAX_INPUT_BYTES, storeOnly: inc === "store-only" });
        input.previousBrainId = previous.get(input.localPath) || "";
      }
      const opts = { kind: entry.kind || "auto", app: entry.app, title: entry.title, tags: ["backfill"], ringOverride: entry.ring_override || "", storeOnly: inc === "store-only", agent, seat, share: Boolean(flags["--share"]), session: resolveSession(), dryRun, gateway: flags["--gateway"] || "auto", gatewayEvery: Number(flags["--gateway-every"]) || 25, artifactUrl: entry.artifact_url || "" };
      const p = prepareDoc(input, opts, { needles, now: deps.now });
      const [r] = await saveBatch(backend, [p], opts, { needles, embedTitle: async (t) => (await backend.embed([t]))[0] });
      bump(r.status);
      exits.push(r.exit);
      record(entry, r);
      if (r.status === "saved") written.push(r.key);
      if (inc === "store-only" && (r.status === "stored-only" || r.status === "planned")) {
        const gk = `${entry.app}|${dirname(m ? m[3] : entry.path)}`;
        if (!storeGroups.has(gk)) storeGroups.set(gk, { app: entry.app, folder: dirname(m ? m[3] : entry.path), kind: entry.kind || "design", items: [] });
        storeGroups.get(gk).items.push({ title: p.title, key: r.key, source: p.source || entry.path });
      }
      if (r.exit) printResult(io, r, false);
    } catch (e) {
      const exit = e.exit || EXIT.ERROR;
      if (exit === EXIT.REFUSED) { bump("refused"); recordRefusal(input, e); }
      else bump("error");
      exits.push(exit === EXIT.REFUSED && inc === "yes" ? EXIT.REFUSED : exit);
      const r = { status: exit === EXIT.REFUSED ? "refused" : "error", exit, message: String(e.message) };
      record(entry, r);
      io.out(`[${r.status.toUpperCase()}] ${entry.path}\n   ${String(e.message).split("\n").join("\n   ")}`);
    }
  }
  // One searchable collection index doc per store-only group, so the set is discoverable without
  // embedding megabytes of markup.
  for (const g of storeGroups.values()) {
    const title = `${g.app} ${basename(g.folder)} collection: ${g.items.length} stored source files`;
    const md = `# ${title}\n\nStored-only (not embedded) source files from \`${g.folder}\`. Each raw file is kept under \`_KNOWLEDGE-META/src/\` at the key shown.\n\n${g.items.map((it) => `- ${it.title} -- \`${it.key}\` (source ${it.source})`).join("\n")}\n`;
    const input = { localPath: "", displayPath: `collection:${g.app}/${g.folder}/index.md`, bytes: Buffer.from(md, "utf8"), ext: ".md", source: `collection:${g.app}/${g.folder}`, sourceRepo: "" };
    try {
      const opts = { kind: g.kind, app: g.app, title, tags: ["backfill", "collection-index"], agent, seat, session: resolveSession(), dryRun, gateway: flags["--gateway"] || "auto" };
      const p = prepareDoc(input, opts, { needles, now: deps.now });
      const [r] = await saveBatch(backend, [p], opts, { needles, embedTitle: async (t) => (await backend.embed([t]))[0] });
      bump(`collection-${r.status}`); exits.push(r.exit); if (r.status === "saved") written.push(r.key);
      printResult(io, r, false);
    } catch (e) { bump("collection-error"); exits.push(e.exit || EXIT.ERROR); io.out(`[ERROR] collection ${g.folder}: ${e.message}`); }
  }
  io.out(`backfill ${dryRun ? "(dry-run) " : ""}summary: ${JSON.stringify(summary)}`);
  if (!dryRun && written.length) {
    const res = await runAudit(backend, { needles, secrets: true, ring: true, searchable: true, repair: false, keys: written }, io);
    for (const f of res.findings) io.out(`  AUDIT FINDING ${f.kind}: ${f.key} ${f.detail || ""}`);
    io.out(`post-backfill audit: ${res.checked} written doc(s) re-checked, ${res.findings.length} finding(s)`);
    if (res.findings.length) exits.push(res.findings.some((f) => f.kind === "secret" || f.kind === "ring") ? EXIT.REFUSED : EXIT.NOT_SEARCHABLE);
  }
  // A backfill fails on any refusal of an include:yes entry (those need a human look), any error, any
  // dark doc, or a refuse-commons entry the gate let through.
  return combineExitCodes(exits);
}

const USAGE = `brain-save: put documents into the company brain and prove they are searchable.
  put <paths...> --kind <research|design|spec|audit|review|packet|build|deploy|receipt|runbook|artifact|report|decision|doc|auto> --app <slug|auto> [--title ..] [--artifact-url url] [--dry-run] [--json]
  verify <query> [--expect brain_id|key] [--top 10]
  backfill <manifest.json> [--dry-run] [--include review] [--repos-root /home/user] [--no-fetch]
  list [--kind k] [--app a] [--since YYYY-MM-DD] [--details] [--check] [--json]
  audit [--secrets] [--ring] [--searchable] [--repair]
  retract <brain_id|key> --reason "<why>"
  doctor
exit: 0 saved+verified | 1 error | 2 refused (nothing written) | 3 stored but NOT searchable | 4 supersede incomplete`;

export async function main(argv, deps = {}, ioIn = {}) {
  const io = makeIo(ioIn);
  let parsed;
  try { parsed = parseArgs(argv); } catch (e) { io.err(e.message); return e.exit || EXIT.ERROR; }
  const handlers = { put: cmdPut, verify: cmdVerify, backfill: cmdBackfill, list: cmdList, audit: cmdAudit, retract: cmdRetract, doctor: cmdDoctor };
  const h = handlers[parsed.cmd];
  if (!h) { io.out(USAGE); return parsed.cmd === "help" || parsed.cmd === "--help" ? EXIT.OK : EXIT.ERROR; }
  try { return await h(parsed, deps, io); }
  catch (e) {
    io.err(`[brain-save] ${e.exit === EXIT.REFUSED ? "REFUSED" : "ERROR"}: ${String((e && e.message) || e).replace(/Bearer\s+\S+/g, "Bearer [redacted]")}`);
    return e.exit || EXIT.ERROR;
  }
}

export { inferKind };

/** Exit once stdout and stderr have drained. A black-holed dependency's socket (undici holds it ~300s)
 *  must not keep a workflow's final step open after the answer is known, and a bare process.exit() races
 *  an async piped stdout write (the gh-app lesson), so each stream is flushed first. */
function exitAfterFlush(code) {
  process.exitCode = code;
  let pending = 2;
  const done = () => { if (--pending === 0) process.exit(code); };
  process.stdout.write("", done);
  process.stderr.write("", done);
}

/** True when this module is the entry point. `import.meta.url` is the symlink-RESOLVED, percent-encoded
 *  path, so a plain `file://${argv[1]}` compare silently did nothing (exit 0) when the CLI was launched
 *  through a symlinked directory or a path containing a space (adjudication round 3). */
export function isEntryPoint(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try { return moduleUrl === pathToFileURL(realpathSync(argv1)).href; } catch { return false; }
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => exitAfterFlush(code), (e) => { process.stderr.write(`[brain-save] ERROR: ${String((e && e.message) || e).slice(0, 300)}\n`); exitAfterFlush(1); });
}
