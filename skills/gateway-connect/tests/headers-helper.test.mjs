// Tests for headers-helper.mjs — the Claude Code `headersHelper` command. Offline: no network, no
// SSM, no real gateway call, no real `claude` CLI invocation. mintToken() is replaced everywhere
// with a fake function; the cache lives under a fresh temp directory per test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getBearerHeaders,
  cachePathFor,
  readTokenCache,
  writeTokenCache,
  hasSufficientLife,
  resolveLane,
  withTimeout,
  MIN_LIFE_MS,
} from '../headers-helper.mjs';

async function withTempCacheDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'gwconnect-hh-test-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

// ---- hasSufficientLife -----------------------------------------------------------------------
test('hasSufficientLife: true well before expiry, false near/at/after expiry, false for no entry', () => {
  const now = 1_000_000;
  assert.equal(hasSufficientLife({ expiresAt: now + 3600_000 }, now), true, 'an hour of life is sufficient');
  assert.equal(hasSufficientLife({ expiresAt: now + MIN_LIFE_MS + 1 }, now), true, 'just over the floor');
  assert.equal(hasSufficientLife({ expiresAt: now + MIN_LIFE_MS }, now), false, 'exactly at the floor is NOT sufficient (strict >)');
  assert.equal(hasSufficientLife({ expiresAt: now + 60_000 }, now), false, 'one minute left is not enough');
  assert.equal(hasSufficientLife({ expiresAt: now - 1 }, now), false, 'already expired');
  assert.equal(hasSufficientLife(null, now), false, 'no entry at all');
  assert.equal(hasSufficientLife({ expiresAt: Number.NaN }, now), false, 'malformed expiresAt');
});

// ---- cache read/write round trip, including corruption -------------------------------------
test('readTokenCache/writeTokenCache: round-trips a real entry; corrupt/missing files read as null', async () => {
  await withTempCacheDir(async (dir) => {
    const p = cachePathFor(dir, 'cfo');
    assert.equal(readTokenCache(p), null, 'nothing written yet');

    writeTokenCache(p, { token: 'abc.def.ghi', expiresAt: 123456, mintedAt: 1 });
    const back = readTokenCache(p);
    assert.equal(back.token, 'abc.def.ghi');
    assert.equal(back.expiresAt, 123456);

    // Corrupt the file directly; must be treated identically to "no cache", never throw.
    await writeFile(p, 'not valid json {{{', 'utf8');
    assert.equal(readTokenCache(p), null, 'corrupt JSON reads as no-cache, not a throw');

    // A well-formed object missing the required shape also reads as no-cache.
    await writeFile(p, JSON.stringify({ hello: 'world' }), 'utf8');
    assert.equal(readTokenCache(p), null, 'wrong shape reads as no-cache');
  });
});

test('cachePathFor: one file per lane under the given cache dir, distinct across lanes', async () => {
  await withTempCacheDir(async (dir) => {
    assert.equal(cachePathFor(dir, 'cfo'), join(dir, 'cfo.json'));
    assert.notEqual(cachePathFor(dir, 'cfo'), cachePathFor(dir, 'clo'));
  });
});

// ---- getBearerHeaders: output shape + the cache-reuse-vs-mint decision, via a fake mint -----
test('getBearerHeaders: output shape is exactly {Authorization: "Bearer <token>"}, JSON-round-trips', async () => {
  await withTempCacheDir(async (dir) => {
    const mint = async () => ({ token: 'SHAPE-TOKEN', expiresIn: 3600 });
    const { headers } = await getBearerHeaders({ lane: 'cfo', cacheDir: dir, mint, now: 1000 });
    assert.deepEqual(Object.keys(headers), ['Authorization'], 'exactly one header key');
    assert.equal(headers.Authorization, 'Bearer SHAPE-TOKEN');
    // What main() actually writes to stdout -- prove it parses back to the identical shape.
    const printed = JSON.stringify(headers);
    assert.deepEqual(JSON.parse(printed), { Authorization: 'Bearer SHAPE-TOKEN' });
  });
});

test('getBearerHeaders: no cache yet -> mints, writes the cache, returns source "mint"', async () => {
  await withTempCacheDir(async (dir) => {
    let calls = 0;
    const mint = async (lane) => { calls++; return { token: `TOK-${lane}-${calls}`, expiresIn: 3600 }; };
    const r = await getBearerHeaders({ lane: 'cfo', cacheDir: dir, mint, now: 1000 });
    assert.equal(r.source, 'mint');
    assert.equal(calls, 1);
    assert.equal(r.headers.Authorization, 'Bearer TOK-cfo-1');
    const cached = readTokenCache(cachePathFor(dir, 'cfo'));
    assert.equal(cached.token, 'TOK-cfo-1');
    assert.equal(cached.expiresAt, 1000 + 3600 * 1000);
  });
});

test('getBearerHeaders: a cached token with plenty of life left is reused -- mint is NOT called again', async () => {
  await withTempCacheDir(async (dir) => {
    let calls = 0;
    const mint = async (lane) => { calls++; return { token: `TOK-${lane}-${calls}`, expiresIn: 3600 }; };
    const first = await getBearerHeaders({ lane: 'cfo', cacheDir: dir, mint, now: 1000 });
    assert.equal(calls, 1);
    // A minute later, the cached token (expires in ~an hour) still has far more than MIN_LIFE_MS left.
    const second = await getBearerHeaders({ lane: 'cfo', cacheDir: dir, mint, now: 1000 + 60_000 });
    assert.equal(calls, 1, 'mint must not be called again');
    assert.equal(second.source, 'cache');
    assert.equal(second.headers.Authorization, first.headers.Authorization, 'same token reused');
  });
});

test('getBearerHeaders: a cached token with less than MIN_LIFE_MS left is treated as stale -- mints again', async () => {
  await withTempCacheDir(async (dir) => {
    let calls = 0;
    const mint = async (lane) => { calls++; return { token: `TOK-${lane}-${calls}`, expiresIn: 3600 }; };
    const start = 1000;
    await getBearerHeaders({ lane: 'cfo', cacheDir: dir, mint, now: start });
    assert.equal(calls, 1);
    // now is within MIN_LIFE_MS of the cached entry's expiry (start + 3600_000).
    const almostExpiredNow = start + 3600_000 - (MIN_LIFE_MS - 1);
    const r = await getBearerHeaders({ lane: 'cfo', cacheDir: dir, mint, now: almostExpiredNow });
    assert.equal(calls, 2, 'mint IS called again once life drops below the floor');
    assert.equal(r.source, 'mint');
    assert.equal(r.headers.Authorization, 'Bearer TOK-cfo-2');
  });
});

test('getBearerHeaders: different lanes get independent cache entries and independent mint calls', async () => {
  await withTempCacheDir(async (dir) => {
    const seen = [];
    const mint = async (lane) => { seen.push(lane); return { token: `TOK-${lane}`, expiresIn: 3600 }; };
    const cfo = await getBearerHeaders({ lane: 'cfo', cacheDir: dir, mint, now: 1000 });
    const clo = await getBearerHeaders({ lane: 'clo', cacheDir: dir, mint, now: 1000 });
    assert.deepEqual(seen, ['cfo', 'clo']);
    assert.equal(cfo.headers.Authorization, 'Bearer TOK-cfo');
    assert.equal(clo.headers.Authorization, 'Bearer TOK-clo');
    // Re-reading cfo's cache does not disturb clo's, and vice versa (a stale-cfo run should not re-mint clo).
    const cfoAgain = await getBearerHeaders({ lane: 'cfo', cacheDir: dir, mint, now: 1000 + 60_000 });
    assert.deepEqual(seen, ['cfo', 'clo'], 'no extra mint call for the still-fresh cfo cache');
    assert.equal(cfoAgain.source, 'cache');
  });
});

test('getBearerHeaders: a corrupt cache file behaves exactly like no cache -- mints instead of throwing', async () => {
  await withTempCacheDir(async (dir) => {
    await writeFile(cachePathFor(dir, 'cfo'), '{ this is not json', 'utf8');
    let calls = 0;
    const mint = async () => { calls++; return { token: 'RECOVERED', expiresIn: 3600 }; };
    const r = await getBearerHeaders({ lane: 'cfo', cacheDir: dir, mint, now: 1000 });
    assert.equal(calls, 1);
    assert.equal(r.headers.Authorization, 'Bearer RECOVERED');
  });
});

// ---- withTimeout: fail-fast mechanism, exercised with short ms values (no real 8s wait) ----
test('withTimeout: resolves with the inner value when it settles before the timer', async () => {
  const v = await withTimeout(Promise.resolve('ok'), 500, 'should not fire');
  assert.equal(v, 'ok');
});

test('withTimeout: rejects with the given message when the inner promise hangs past the timer', async () => {
  const hangsForever = new Promise(() => {}); // never settles, simulating an unreachable SSM/network
  await assert.rejects(
    () => withTimeout(hangsForever, 20, 'timed out after 20ms resolving a gateway token'),
    /timed out after 20ms/,
  );
});

// ---- resolveLane: mirrors session-connect.sh's precedence, no network -----------------------
// resolveLane() shells out to `bash -c '. agent-id.sh; ...'`, which inherits process.env by default
// (execFileSync passes no explicit `env` override) -- so overriding HOME/KB_AGENT on THIS process
// before calling resolveLane() directly reaches that child exactly as it would in real use. Matches
// the HOME-override pattern connect.test.mjs already uses for its own credential-bootstrap test.
async function withIsolatedHome(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'gwconnect-hh-home-'));
  const savedHome = process.env.HOME;
  const savedAgent = process.env.KB_AGENT;
  const savedProjectDir = process.env.CLAUDE_PROJECT_DIR;
  process.env.HOME = dir;
  // agent-id.sh's repo-.kb-agent walk starts at ${CLAUDE_PROJECT_DIR:-$PWD}; clear it so this test's
  // isolation does not depend on whatever the outer CI/session environment happens to set it to.
  delete process.env.CLAUDE_PROJECT_DIR;
  try {
    await fn(dir);
  } finally {
    process.env.HOME = savedHome;
    if (savedAgent === undefined) delete process.env.KB_AGENT; else process.env.KB_AGENT = savedAgent;
    if (savedProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = savedProjectDir;
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test('resolveLane: falls back to KB_AGENT env when there is no session marker', async () => {
  await withIsolatedHome(async () => {
    process.env.KB_AGENT = 'cfo';
    assert.equal(resolveLane(), 'cfo');
  });
});

test('resolveLane: the ~/.claude/.kb-agent session marker takes precedence over KB_AGENT', async () => {
  await withIsolatedHome(async (dir) => {
    const { mkdir, writeFile: wf } = await import('node:fs/promises');
    await mkdir(join(dir, '.claude'), { recursive: true });
    await wf(join(dir, '.claude', '.kb-agent'), 'clo\n', 'utf8');
    process.env.KB_AGENT = 'cfo';
    assert.equal(resolveLane(), 'clo', 'the session marker wins over KB_AGENT');
  });
});

test('resolveLane: returns null when nothing resolves at all (no marker, no KB_AGENT)', async () => {
  await withIsolatedHome(async () => {
    delete process.env.KB_AGENT;
    assert.equal(resolveLane(), null);
  });
});

test("headers-helper: the resolve cap sits inside the overall budget, and the overall budget sits inside Claude Code's 10s allowance (the two timeouts can never stack past 10s)", async () => {
  const mod = await import(new URL("../headers-helper.mjs", import.meta.url).href);
  assert.ok(mod.RESOLVE_TIMEOUT_MS > 0 && mod.RESOLVE_TIMEOUT_MS < mod.OVERALL_TIMEOUT_MS, "resolve cap must leave room for the mint");
  assert.ok(mod.OVERALL_TIMEOUT_MS <= 8000, "overall budget must stay well under Claude Code's 10s headersHelper allowance");
});

test("getBearerHeaders: a cached token with life is reused only when validate() accepts it; a rejection mints fresh and overwrites the cache; an inconclusive or throwing probe reuses", async () => {
  const mod = await import(new URL("../headers-helper.mjs", import.meta.url).href);
  const dir = await mkdtemp(join(tmpdir(), "hh-validate-"));
  try {
    const now = 1_700_000_000_000;
    mod.writeTokenCache(mod.cachePathFor(dir, "cto"), { token: "old", expiresAt: now + 3_600_000, mintedAt: now });
    let mints = 0;
    const mint = async () => { mints++; return { token: `fresh${mints}`, expiresIn: 86400 }; };
    const accepted = await mod.getBearerHeaders({ lane: "cto", cacheDir: dir, mint, now, validate: async () => true });
    assert.equal(accepted.source, "cache"); assert.equal(accepted.headers.Authorization, "Bearer old"); assert.equal(mints, 0);
    const unsure = await mod.getBearerHeaders({ lane: "cto", cacheDir: dir, mint, now, validate: async () => null });
    assert.equal(unsure.source, "cache-unverified"); assert.equal(unsure.headers.Authorization, "Bearer old"); assert.equal(mints, 0);
    const thrown = await mod.getBearerHeaders({ lane: "cto", cacheDir: dir, mint, now, validate: async () => { throw new Error("boom"); } });
    assert.equal(thrown.source, "cache-unverified"); assert.equal(mints, 0);
    const rejected = await mod.getBearerHeaders({ lane: "cto", cacheDir: dir, mint, now, validate: async () => false });
    assert.equal(rejected.source, "mint-rejected"); assert.equal(rejected.headers.Authorization, "Bearer fresh1"); assert.equal(mints, 1);
    assert.equal(mod.readTokenCache(mod.cachePathFor(dir, "cto")).token, "fresh1", "the rejected token must be replaced in the cache");
    const again = await mod.getBearerHeaders({ lane: "cto", cacheDir: dir, mint, now, validate: async () => true });
    assert.equal(again.source, "cache"); assert.equal(again.headers.Authorization, "Bearer fresh1"); assert.equal(mints, 1);
    const noValidator = await mod.getBearerHeaders({ lane: "cto", cacheDir: dir, mint, now });
    assert.equal(noValidator.source, "cache", "no validate() -> plain reuse, byte-identical to the pre-probe behavior");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("probeToken: 2xx -> true, 401/403 -> false, any other status or a thrown fetch -> null; sends the bearer and an MCP ping", async () => {
  const mod = await import(new URL("../headers-helper.mjs", import.meta.url).href);
  const mk = (status) => async (url, init) => { mk.last = { url, init }; return { status, ok: status >= 200 && status < 300 }; };
  assert.equal(await mod.probeToken("tok", { url: "https://x/mcp", fetchImpl: mk(200) }), true);
  assert.equal(mk.last.url, "https://x/mcp");
  assert.equal(mk.last.init.headers.Authorization, "Bearer tok");
  assert.equal(JSON.parse(mk.last.init.body).method, "ping");
  assert.equal(await mod.probeToken("tok", { url: "https://x/mcp", fetchImpl: mk(401) }), false);
  assert.equal(await mod.probeToken("tok", { url: "https://x/mcp", fetchImpl: mk(403) }), false);
  assert.equal(await mod.probeToken("tok", { url: "https://x/mcp", fetchImpl: mk(503) }), null);
  assert.equal(await mod.probeToken("tok", { url: "https://x/mcp", fetchImpl: async () => { throw new Error("net"); } }), null);
});

test("writeTokenCache tightens a PRE-EXISTING cache directory to owner-only (mkdir's mode only applies on creation)", async () => {
  const mod = await import(new URL("../headers-helper.mjs", import.meta.url).href);
  const { mkdir, stat } = await import("node:fs/promises");
  const base = await mkdtemp(join(tmpdir(), "hh-perm-"));
  try {
    const dir = join(base, "cache");
    await mkdir(dir, { mode: 0o755 });
    assert.equal((await stat(dir)).mode & 0o777, 0o755, "precondition: the dir starts world-readable");
    mod.writeTokenCache(mod.cachePathFor(dir, "cto"), { token: "t", expiresAt: Date.now() + 60_000, mintedAt: Date.now() });
    assert.equal((await stat(dir)).mode & 0o777, 0o700, "the existing dir must be tightened, not left as created");
    assert.equal((await stat(mod.cachePathFor(dir, "cto"))).mode & 0o777, 0o600, "the cache file itself is owner-only");
  } finally { await rm(base, { recursive: true, force: true }); }
});

// Opt-in LIVE integration test (never runs in CI or by default): proves the probe contract against the
// real gateway, not a mock. Needs the seat's AWS/SSM credentials to mint a real lane token.
//   GATEWAY_LIVE_PROBE=1 SECRET_BACKEND=ssm node --test skills/gateway-connect/tests/headers-helper.test.mjs
test("LIVE (opt-in, GATEWAY_LIVE_PROBE=1): probeToken returns true for a freshly minted lane token and false for a bogus or empty bearer against the real gateway", { skip: !process.env.GATEWAY_LIVE_PROBE }, async () => {
  const mod = await import(new URL("../headers-helper.mjs", import.meta.url).href);
  const { mintToken } = await import(new URL("../connect.mjs", import.meta.url).href);
  const lane = process.env.GATEWAY_LIVE_PROBE_LANE || "cto";
  const { token } = await mintToken(lane);
  assert.equal(await mod.probeToken(token), true, "a real, fresh token must be accepted");
  assert.equal(await mod.probeToken("not-a-token"), false, "a bogus bearer must be rejected as 401/403, never inconclusive");
  assert.equal(await mod.probeToken(""), false, "an empty bearer must be rejected as 401/403, never inconclusive");
});
