// Regression gate for the 2026-09-03 bearer leak in register() (see the redactBearer comment in
// connect.mjs). Pins three things: (1) redaction scrubs both the exact token and the `Bearer <...>`
// shape, including the JSON form `claude mcp add-json` embeds; (2) register() is idempotent across
// the "already exists in local config" collision (local scope is per-cwd, and a scope-less remove
// refuses when the name exists in more than one scope); (3) a persistent CLI failure surfaces the
// CLI's own reason and exit code, never the argv or the token. No real `claude` binary is spawned:
// the exec function is injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { redactBearer, runClaude, register, buildRegisterArgs, GATEWAY_MCP } from '../connect.mjs';

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.FAKE-PAYLOAD-FOR-THIS-TEST-ONLY.FAKE-SIG-0000';
const SRC = readFileSync(new URL('../connect.mjs', import.meta.url), 'utf8');

function cliError(stderr, status = 1, argv = []) {
  // execFileSync's real failure shape: Error.message embeds the ENTIRE argv (this is the leak).
  const e = new Error(`Command failed: claude ${argv.join(' ')}`);
  e.status = status; e.stdout = ''; e.stderr = stderr;
  return e;
}

test('redactBearer scrubs the exact value, the header shape, and the add-json JSON form', () => {
  const header = `--header Authorization: Bearer ${TOKEN}`;
  const json = JSON.stringify({ type: 'http', headers: { Authorization: `Bearer ${TOKEN}` } });
  for (const s of [header, json, `Command failed: claude mcp add x ${header}`]) {
    const out = redactBearer(s, TOKEN);
    assert.ok(!out.includes(TOKEN), 'exact token must be gone');
    assert.match(out, /Bearer \[REDACTED\]/);
  }
  // Shape-only: a DIFFERENT token than the one we know about is still caught.
  assert.equal(redactBearer('Authorization: Bearer abc.def-ghi_jkl', TOKEN), 'Authorization: Bearer [REDACTED]');
  // A short or empty "token" never degrades into a split-every-character rewrite.
  assert.equal(redactBearer('plain text', ''), 'plain text');
  assert.equal(redactBearer('plain text', 'ab'), 'plain text');
  assert.equal(redactBearer(undefined, TOKEN), '');
});

test('runClaude never throws and returns the CLI reason with the bearer scrubbed', () => {
  const args = buildRegisterArgs('gw', GATEWAY_MCP, TOKEN);
  const r = runClaude(args, TOKEN, () => { throw cliError('MCP server gw already exists in local config', 1, args); });
  assert.equal(r.ok, false);
  assert.equal(r.status, 1);
  assert.match(r.out, /already exists in local config/);
  assert.ok(!r.out.includes(TOKEN));
  assert.deepEqual(runClaude(['mcp', 'remove', 'gw'], TOKEN, () => 'removed\n'), { ok: true, status: 0, out: 'removed\n' });
  // A thrown non-Error (or one without stdout/stderr/status) is still a clean failure object.
  const bare = runClaude(['mcp', 'remove', 'gw'], TOKEN, () => { throw 'ENOENT'; });
  assert.equal(bare.ok, false);
  assert.equal(bare.status, null);
});

test('register() survives the already-exists collision with one explicit local-scope remove + retry', () => {
  const calls = [];
  let adds = 0;
  const exec = (_file, args) => {
    calls.push(args.slice(0, 4).join(' '));
    // A scope-less remove refuses when the name exists in more than one scope (verified 2026-09-03).
    if (args[1] === 'remove' && !args.includes('-s')) throw cliError('  claude mcp remove gw -s local\n  claude mcp remove gw -s project', 1, args);
    if (args[1] === 'add' || args[1] === 'add-json') { adds += 1; if (adds === 1) throw cliError('MCP server gw already exists in local config', 1, args); }
    return '';
  };
  assert.doesNotThrow(() => register('gw', TOKEN, exec));
  assert.equal(adds, 2, 'exactly one retry');
  const iRemove = calls.findIndex((c) => c.startsWith('mcp remove -s local'));
  assert.ok(iRemove >= 0, `expected an explicit local-scope remove, got: ${calls.join(' | ')}`);
  assert.ok(calls.length - 1 > iRemove, 'the retry add must come AFTER the local-scope remove');
});

test('register() does not retry on an unrelated failure and throws a REDACTED error', () => {
  const args = buildRegisterArgs('gw', GATEWAY_MCP, TOKEN);
  let adds = 0;
  const exec = (_file, a) => {
    if (a[1] === 'remove') return '';
    adds += 1;
    throw cliError(`boom: cannot write config (${a.join(' ')})`, 7, a);
  };
  assert.throws(() => register('gw', TOKEN, exec), (e) => {
    assert.match(e.message, /claude mcp (add|add-json) "gw" failed \(exit 7\)/);
    assert.match(e.message, /boom: cannot write config/);
    assert.ok(!e.message.includes(TOKEN), 'the token must never appear in the thrown error');
    assert.match(e.message, /Bearer \[REDACTED\]/, 'the echoed argv is scrubbed, not dropped silently');
    return true;
  });
  assert.equal(adds, 1, 'no retry loop on a non-collision failure');
  void args;
});

test('source scan: the add is never run with stdio ignored, and the top-level catch redacts', () => {
  const start = SRC.indexOf('export function register(');
  assert.ok(start > 0);
  const body = SRC.slice(start, SRC.indexOf('\n}\n', start) + 3);
  assert.ok(!/stdio:\s*'ignore'/.test(body), 'register() must capture the CLI output, not ignore it');
  assert.match(body, /runClaude\(/);
  assert.match(SRC, /\[gateway-connect\] ERROR:', redactBearer\(/, 'the CLI entry point must redact before printing');
});
