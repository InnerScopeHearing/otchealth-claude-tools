#!/usr/bin/env node
// headers-helper.mjs — the Claude Code `headersHelper` command for the OTCHealth gateway MCP server.
//
// WHAT THIS REPLACES: Claude Code now supports a per-server "headersHelper" — a command Claude Code
// runs itself at session start and on reconnect, and automatically re-runs (with one retry) on a
// 401/403 from the server. It must print a JSON object of string headers to stdout within 10s.
// Dynamic headers (this file's output) override any static `headers` set at registration time.
// See connect.mjs's own header comment and SKILL.md for the full mechanism + rollback.
//
// This means Claude Code itself now owns "is my gateway token about to expire / did it just expire",
// instead of the old model where octools-sync's UserPromptSubmit hook had to periodically re-mint +
// re-run `claude mcp add` before the token went stale. See register()/headersHelperEnabled() in
// connect.mjs for the registration side, and octools-sync.sh for the now-mostly-no-op refresh side.
//
// CONTRACT (read before changing anything here):
//   - stdout carries ONLY the JSON headers object, nothing else — Claude Code parses stdout as JSON.
//   - ALL logging goes to stderr.
//   - The bearer token is NEVER printed anywhere except inside that one JSON object on stdout.
//   - Must finish well inside the 10s budget Claude Code allows; a hang (e.g. SSM/network genuinely
//     unreachable) must fail FAST (non-zero exit, a clear stderr line) rather than eat the timeout.
//     OVERALL_TIMEOUT_MS (8s) is the budget for the WHOLE invocation: lane resolution (a local-files
//     bash source, capped at RESOLVE_TIMEOUT_MS) plus the mint, which gets whatever remains -- so the
//     two caps can never stack past the budget.
//   - Lane resolution mirrors session-connect.sh EXACTLY (same script, same precedence, same
//     KB_NO_AUTOCLAIM=1 — this never guesses a privileged lane): session marker
//     (~/.claude/.kb-agent) > repo .kb-agent (walked to the git root) > KB_AGENT env. No autoclaim.
//
// CACHING: mintToken() is a real network round trip (parallel SSM reads + a POST to the gateway's
// token endpoint). Claude Code can invoke this helper often (every reconnect, every 401 retry, and
// per the docs "at session start and on reconnect"), so re-minting on every single call would be
// wasteful and would hammer SSM. A per-lane on-disk cache (see defaultCacheDir()) is reused whenever
// the cached token still has more than MIN_LIFE_MS left; otherwise a fresh token is minted exactly
// the way connect.mjs's own connectOnce() path does (same mintToken(), same lane resolution, same
// SSM-backed credential source), and the cache is updated. This is a NEW cache this skill introduces
// (there was no on-disk token cache before headersHelper existed — the old model kept the token only
// inside Claude Code's own MCP config, refreshed by re-running `claude mcp add`).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mintToken, hasLane, laneClaim } from './connect.mjs';

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const AGENT_ID_SH = join(SELF_DIR, '..', 'kb-memory', 'agent-id.sh');

/** Reuse a cached token only while it has MORE than this much life left. */
export const MIN_LIFE_MS = 10 * 60 * 1000; // 10 minutes
/** TRIGGER-BLIND RETRY DETECTION. Claude Code gives the helper no signal for WHY it was invoked
 *  (session start, reconnect, or the automatic re-run after a 401/403), so a cache hit alone cannot
 *  tell "the server just rejected this exact token" from "a new session wants the same still-valid
 *  token". The one observable difference is timing: the 401/403 re-run follows the previous
 *  invocation within seconds. So a second invocation inside this window is treated as that retry
 *  and BYPASSES the cache -- a fresh token is minted even if the cached one still has life -- which
 *  is what makes a revoked/invalidated-but-unexpired token recover instead of being replayed. A
 *  session start followed by a quick reconnect pays one extra mint; that is the accepted cost. */
export const RETRY_WINDOW_MS = 60 * 1000;
/** Hard wall-clock budget for the whole resolve+mint flow, well under Claude Code's 10s allowance.
 *  Covers BOTH steps: main() measures what resolveLane() spent and gives the mint only the remainder. */
export const OVERALL_TIMEOUT_MS = 8000;
/** Cap on resolveLane()'s bash source of agent-id.sh (local file reads only; a normal run is tens of
 *  ms). Deliberately small so that even a stalled resolver leaves most of OVERALL_TIMEOUT_MS for
 *  the mint, and so the two timeouts can never sum past the overall budget. */
export const RESOLVE_TIMEOUT_MS = 1500;

/** Default on-disk cache directory: one small JSON file per lane, alongside this skill's other
 *  ~/.claude/.* state files (.kb-agent, .gateway-connect-last, ...). Tests override via `cacheDir`. */
export function defaultCacheDir() {
  return join(homedir(), '.claude', '.gateway-connect-cache');
}

/** Cache file path for one lane. Lane names come only from the code-reviewed LANES registry (never
 *  uncontrolled input), so a plain filename needs no extra escaping. */
export function cachePathFor(cacheDir, lane) {
  return join(cacheDir, `${lane}.json`);
}

/** Read a lane's cached token entry, or null if missing/unreadable/malformed. Never throws. */
export function readTokenCache(cachePath) {
  try {
    const obj = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (obj && typeof obj.token === 'string' && obj.token && Number.isFinite(obj.expiresAt)) return obj;
  } catch {
    /* no cache yet, or corrupt — treated identically to "no cache" */
  }
  return null;
}

/** True when `entry` is present and has more than `minLifeMs` of life left at time `now`. */
export function hasSufficientLife(entry, now, minLifeMs = MIN_LIFE_MS) {
  return Boolean(entry) && Number.isFinite(entry.expiresAt) && entry.expiresAt - now > minLifeMs;
}

/** Write a lane's cache entry atomically (temp file + rename) with owner-only permissions, since it
 *  holds a live bearer token — the same sensitivity class as the header connect.mjs already passes
 *  to `claude mcp add`, just now also resting on disk between invocations. */
export function writeTokenCache(cachePath, entry) {
  mkdirSync(dirname(cachePath), { recursive: true, mode: 0o700 });
  const tmp = `${cachePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 });
  renameSync(tmp, cachePath);
}

/**
 * Decide cache-vs-mint and return the bearer headers for `lane`. Pure with respect to its inputs —
 * `mint` and `now` are injected — so this is fully unit-testable with a fake mint function and a
 * temp cache dir, no network and no real SSM/gateway call.
 *
 * Returns { headers: { Authorization: "Bearer <token>" }, source: "cache"|"mint", cachePath }.
 */
export async function getBearerHeaders({ lane, cacheDir, mint, now = Date.now(), minLifeMs = MIN_LIFE_MS, retryWindowMs = RETRY_WINDOW_MS }) {
  const cachePath = cachePathFor(cacheDir, lane);
  const cached = readTokenCache(cachePath);
  // servedAt = when this cache entry was last handed to Claude Code. A second call inside the retry
  // window means the previous hand-out was just rejected (see RETRY_WINDOW_MS): bypass the cache.
  const servedRecently = Boolean(cached) && Number.isFinite(cached.servedAt) && now - cached.servedAt >= 0 && now - cached.servedAt < retryWindowMs;
  if (hasSufficientLife(cached, now, minLifeMs) && !servedRecently) {
    writeTokenCache(cachePath, { ...cached, servedAt: now });
    return { headers: { Authorization: `Bearer ${cached.token}` }, source: 'cache', cachePath };
  }
  const { token, expiresIn } = await mint(lane);
  writeTokenCache(cachePath, { token, expiresAt: now + expiresIn * 1000, mintedAt: now, servedAt: now });
  return { headers: { Authorization: `Bearer ${token}` }, source: servedRecently ? 'mint-retry' : 'mint', cachePath };
}

/**
 * Resolve THIS invocation's agent/lane the SAME way session-connect.sh does: source kb-memory's
 * agent-id.sh with KB_NO_AUTOCLAIM=1 (session marker > repo .kb-agent > KB_AGENT env; never
 * auto-claims a repo into a lane here — that would risk silently minting a privileged token for an
 * unidentified caller), then fall back to the raw KB_AGENT env var if sourcing yielded nothing
 * (belt-and-suspenders, mirroring session-connect.sh's own redundant fallback). No network; safe to
 * call from a unit test as-is (it only reads local files/env).
 */
export function resolveLane() {
  let ag = '';
  try {
    ag = execFileSync(
      'bash',
      ['-c', 'KB_NO_AUTOCLAIM=1 . "$0" 2>/dev/null; printf "%s" "$AG"', AGENT_ID_SH],
      { encoding: 'utf8', timeout: RESOLVE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
  } catch {
    ag = '';
  }
  if (!ag) ag = process.env.KB_AGENT || '';
  return ag || null;
}

/** Race `promise` against a `ms`-millisecond timer; rejects with `message` if the timer wins first.
 * Exported so the fail-fast behavior can be unit-tested with a short ms value instead of waiting out
 * the real OVERALL_TIMEOUT_MS in a test run. */
export function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function main() {
  const serverName = process.env.CLAUDE_CODE_MCP_SERVER_NAME || '?';
  const t0 = Date.now();
  const lane = resolveLane();
  if (!lane) {
    console.error(
      '[gateway-connect headers-helper] no agent/lane identity resolvable (checked the ' +
        '~/.claude/.kb-agent session marker, a repo .kb-agent file, and KB_AGENT) -- cannot mint a ' +
        `gateway token for server "${serverName}".`,
    );
    process.exit(1);
  }
  if (!hasLane(lane)) {
    console.error(
      `[gateway-connect headers-helper] agent "${lane}" has no gateway lane configured in LANES ` +
        `(connect.mjs) -- this helper should not have been registered for it.`,
    );
    process.exit(1);
  }
  try {
    // The mint gets only what lane resolution left of the overall budget (never less than a small
    // floor, so a slow-but-successful resolve still attempts the cache/mint path).
    const remainingMs = Math.max(250, OVERALL_TIMEOUT_MS - (Date.now() - t0));
    const { headers, source } = await withTimeout(
      getBearerHeaders({ lane, cacheDir: defaultCacheDir(), mint: mintToken }),
      remainingMs,
      `timed out resolving a gateway token for lane "${lane}" within the ${OVERALL_TIMEOUT_MS}ms overall budget ` +
        '(SSM or the gateway token endpoint unreachable?)',
    );
    const claim = laneClaim(headers.Authorization.slice('Bearer '.length));
    console.error(
      `[gateway-connect headers-helper] lane=${lane} agent=${claim || '?'} server=${serverName} ` +
        `${source === 'cache' ? 're-used cached token' : source === 'mint-retry' ? 'minted a fresh token (repeat call inside the retry window, cache bypassed)' : 'minted a fresh token'}`,
    );
    process.stdout.write(JSON.stringify(headers));
  } catch (e) {
    console.error(`[gateway-connect headers-helper] ERROR: ${String((e && e.message) || e)}`);
    process.exit(1);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();

export default {
  getBearerHeaders, cachePathFor, readTokenCache, writeTokenCache, hasSufficientLife, resolveLane,
  defaultCacheDir, withTimeout, MIN_LIFE_MS, OVERALL_TIMEOUT_MS, RESOLVE_TIMEOUT_MS, RETRY_WINDOW_MS,
};
