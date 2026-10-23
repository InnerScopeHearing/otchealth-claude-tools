import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { TLSSocket, createSecureContext } from 'node:tls';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const dir = mkdtempSync(join(tmpdir(), 'pg-wire-synthetic-ca-'));
const wire = new URL('../skills/kb-memory/pg-wire.mjs', import.meta.url).href;
const fixtures = {};
before(() => {
  for (const [name, san] of [['trusted', 'IP:127.0.0.1'], ['untrusted', 'IP:127.0.0.1'], ['wronghost', 'DNS:wrong.example.invalid']]) {
    const key = join(dir, `${name}.key`), cert = join(dir, `${name}.pem`);
    // Keys exist only in this disposable fixture directory, never in source.
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', key, '-out', cert, '-subj', '/CN=synthetic-postgres', '-addext', `subjectAltName=${san}`], { stdio: 'ignore' });
    fixtures[name] = { key: readFileSync(key), cert: readFileSync(cert), path: cert };
  }
});
after(() => rmSync(dir, { recursive: true, force: true }));

async function tlsPeer(fixture, stallAuthentication = false) {
  const sockets = new Set();
  const server = createServer(raw => {
    sockets.add(raw); raw.on('error', () => {}); raw.on('close', () => sockets.delete(raw));
    raw.once('data', () => {
      raw.write('S');
      const socket = new TLSSocket(raw, { isServer: true, secureContext: createSecureContext(fixture) });
      sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
      socket.once('secure', () => {
        if (!stallAuthentication) socket.once('data', () => socket.write(Buffer.from('5200000008000000005a0000000549', 'hex')));
      });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}

async function attempt(peer, ca) {
  const code = `import {connect} from ${JSON.stringify(wire)};
    try { const c = await connect({host:'127.0.0.1',port:${peer.port},database:'synthetic',user:'fixture',password:'synthetic-only',ssl:true,sslVerify:true,allowWeakAuth:false,connectTimeoutMs:500}); await c.end(); process.stdout.write('verified'); }
    catch { process.stdout.write('rejected'); process.exitCode=1; }`;
  try {
    const r = await run(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, NODE_EXTRA_CA_CERTS: ca, NODE_TLS_REJECT_UNAUTHORIZED: '1' }, timeout: 3000 });
    return { status: 0, stdout: r.stdout };
  } catch (e) { return { status: e.code, stdout: e.stdout }; }
}

test('verified pg-wire accepts a trusted synthetic CA and matching host', async () => {
  const peer = await tlsPeer(fixtures.trusted);
  try { assert.deepEqual(await attempt(peer, fixtures.trusted.path), { status: 0, stdout: 'verified' }); }
  finally { await peer.close(); }
});

test('verified pg-wire rejects a certificate from a different CA', async () => {
  const peer = await tlsPeer(fixtures.untrusted);
  try { assert.deepEqual(await attempt(peer, fixtures.trusted.path), { status: 1, stdout: 'rejected' }); }
  finally { await peer.close(); }
});

test('verified pg-wire rejects a trusted certificate with the wrong hostname', async () => {
  const peer = await tlsPeer(fixtures.wronghost);
  try { assert.deepEqual(await attempt(peer, fixtures.wronghost.path), { status: 1, stdout: 'rejected' }); }
  finally { await peer.close(); }
});

test('connection deadline also bounds authentication after a trusted TLS handshake', async () => {
  const peer = await tlsPeer(fixtures.trusted, true);
  try { assert.deepEqual(await attempt(peer, fixtures.trusted.path), { status: 1, stdout: 'rejected' }); }
  finally { await peer.close(); }
});
