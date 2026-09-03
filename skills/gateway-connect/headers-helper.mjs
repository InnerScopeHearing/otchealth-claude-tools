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
// inside Claude Code's own MCP config, refreshed by re-running `claude mcp add`). Before a cached
// token is reused it is VALIDATED against the gateway with one cheap authenticated MCP ping
// (probeToken): Claude Code gives this helper no signal for WHY it was invoked, so a token the server
// has stopped accepting (revoked, invalidated, expired server-side) is replaced instead of replayed --
// that is how the automatic 401/403 re-run actually recovers.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mintToken, hasLane, laneClaim, GATEWAY_MCP } from './connect.mjs';

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const AGENT_ID_SH = join(SELF_DIR, '..', 'kb-memory', 'agent-id.sh');

/** Reuse a cached token only while it has MORE than this much life left. */
export const MIN_LIFE_MS = 10 * 60 * 1000; // 10 minutes
/** Budget for the ONE cheap authenticated probe (probeToken below) that decides whether a cached
 *  token is still ACCEPTED by the gateway before it is handed back to Claude Code. */
export const VALIDATE_TIMEOUT_MS = 2500;
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
  const dir = dirname(cachePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdirSync's `mode` applies only when it CREATES the directory; a pre-existing one keeps whatever
  // permissions it had. Tighten it explicitly every time so the owner-only guarantee holds for a
  // cache dir that was created earlier (or by something else) with looser bits.
  try { chmodSync(dir, 0o700); } catch { /* not the owner: nothing to tighten */ }
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
export async function getBearerHeaders({ lane, cacheDir, mint, now = Date.now(), minLifeMs = MIN_LIFE_MS, validate = null }) {
  const cachePath = cachePathFor(cacheDir, lane);
  const cached = readTokenCache(cachePath);
  const alive = hasSufficientLife(cached, now, minLifeMs);
  if (alive) {
    // A cached token with life left is REUSED only when the gateway itself confirms it still accepts
    // it. Claude Code gives this helper no signal for WHY it was invoked (session start, reconnect,
    // or the automatic re-run after a 401/403), so instead of guessing from timing the helper asks
    // the only party that knows: `validate` (probeToken in main()) makes one cheap authenticated
    // request with the cached token.
    //   true  = accepted -> reuse ("cache").
    //   false = rejected (revoked, invalidated, expired server-side) -> mint fresh ("mint-rejected");
    //           this is what makes the 401/403 re-run actually recover.
    //   null  = could not tell (no HTTP response, or a 5xx from in front of auth) -> ALSO mint fresh
    //           ("mint-unverified"), because this invocation may be the one retry Claude Code gives a
    //           rejected credential and replaying a token nobody could vouch for would burn it. Only if
    //           that mint itself fails does the still-alive cached token get returned
    //           ("cache-unverified") -- a valid-looking token beats no token when the network is down.
    let verdict = true;
    if (validate) { try { verdict = await validate(cached.token); } catch { verdict = null; } }
    if (verdict === true) {
      return { headers: { Authorization: `Bearer ${cached.token}` }, source: 'cache', cachePath };
    }
    if (verdict === null) {
      try {
        const { token, expiresIn } = await mint(lane);
        writeTokenCache(cachePath, { token, expiresAt: now + expiresIn * 1000, mintedAt: now });
        return { headers: { Authorization: `Bearer ${token}` }, source: 'mint-unverified', cachePath };
      } catch {
        return { headers: { Authorization: `Bearer ${cached.token}` }, source: 'cache-unverified', cachePath };
      }
    }
  }
  const { token, expiresIn } = await mint(lane);
  writeTokenCache(cachePath, { token, expiresAt: now + expiresIn * 1000, mintedAt: now });
  return { headers: { Authorization: `Bearer ${token}` }, source: alive ? 'mint-rejected' : 'mint', cachePath };
}

/**
 * Ask the gateway whether `token` is still accepted: an MCP `ping` is the smallest authenticated
 * request the stateless /mcp endpoint answers (every POST /mcp is authorized from the bearer alone,
 * so no session/initialize handshake is needed). Returns false on 401/403 (rejected -- the caller
 * should mint fresh), null on a 5xx or no HTTP response at all (a load balancer with no healthy
 * target, a crash, a timeout: inconclusive), and true on ANY other HTTP status. That last rule is
 * deliberate and is what makes the probe robust to protocol details: the gateway evaluates the
 * bearer (auth/bearer.ts validateBearer()) BEFORE any JSON-RPC handling, so a 200, and equally a 400
 * or 404 from the MCP layer complaining about the ping itself, can only be reached by a request whose
 * bearer already passed auth. A future gateway that stopped answering bare pings would therefore
 * still validate correctly; only an actual auth rejection reads as rejection. Never throws.
 * `fetchImpl` is injectable for tests.
 *
 * LIVE-VERIFIED 2026-09-03 against https://mcp.otchealth.app/mcp from the CTO seat, exactly this
 * request shape (no initialize, no session id): a freshly minted cto-lane token -> true, a bogus
 * bearer -> false, an empty bearer -> false. The gateway rejects a bad bearer with 401 BEFORE any
 * JSON-RPC handling (auth/bearer.ts validateBearer() runs per request), so an invalid token can
 * never surface as a protocol error that this function would read as "inconclusive".
 */
export async function probeToken(token, { url = GATEWAY_MCP, timeoutMs = VALIDATE_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  try {
    const r = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (r.status === 401 || r.status === 403) return false;
    if (r.status >= 500) return null;
    return true;
  } catch {
    return null;
  }
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
      getBearerHeaders({ lane, cacheDir: defaultCacheDir(), mint: mintToken, validate: (t) => probeToken(t) }),
      remainingMs,
      `timed out resolving a gateway token for lane "${lane}" within the ${OVERALL_TIMEOUT_MS}ms overall budget ` +
        '(SSM or the gateway token endpoint unreachable?)',
    );
    const claim = laneClaim(headers.Authorization.slice('Bearer '.length));
    console.error(
      `[gateway-connect headers-helper] lane=${lane} agent=${claim || '?'} server=${serverName} ` +
        `${source === 'cache' ? 're-used cached token (gateway accepted it)' : source === 'cache-unverified' ? 're-used cached token (probe inconclusive AND a fresh mint failed)' : source === 'mint-unverified' ? 'minted a fresh token (probe inconclusive, not replaying the cached one)' : source === 'mint-rejected' ? 'minted a fresh token (gateway rejected the cached one)' : 'minted a fresh token'}`,
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
  defaultCacheDir, withTimeout, probeToken, MIN_LIFE_MS, OVERALL_TIMEOUT_MS, RESOLVE_TIMEOUT_MS, VALIDATE_TIMEOUT_MS,
};
