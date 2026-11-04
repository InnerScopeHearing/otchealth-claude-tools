import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { connect } from '../skills/kb-memory/pg-wire.mjs';

// Synthetic protocol peer: no database, credentials, cloud, or production data.
async function peer({ reply = true } = {}) {
  const sockets = new Set();
  let startups = 0;
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    const ready = () => {
      startups++;
      socket.write(Buffer.from('5200000008000000005a0000000549', 'hex'));
    };
    socket.once('data', data => {
      if (!reply) return;
      if (data.length >= 8 && data.readInt32BE(4) !== 80877103) { ready(); return; }
      socket.write('N');
      socket.once('data', ready);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    options: { host: '127.0.0.1', port: server.address().port, database: 'synthetic', user: 'fixture', password: 'synthetic-only', connectTimeoutMs: 50 },
    get startups() { return startups; },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); },
  };
}

test('verified TLS refuses server plaintext fallback before PostgreSQL startup', async () => {
  const p = await peer();
  let conn;
  try {
    await assert.rejects(connect({ ...p.options, ssl: true, sslVerify: true }).then(c => (conn = c)), /TLS|required|declined/i);
    assert.equal(p.startups, 0);
  } finally { await conn?.end(); await p.close(); }
});

test('explicit unverified legacy TLS mode retains its existing fallback contract', async () => {
  const p = await peer();
  let conn;
  try {
    conn = await connect({ ...p.options, ssl: true, sslVerify: false });
    assert.equal(p.startups, 1);
  } finally { await conn?.end(); await p.close(); }
});

test('requesting certificate verification with TLS disabled is refused', async () => {
  const p = await peer();
  let conn;
  try {
    await assert.rejects(connect({ ...p.options, ssl: false, sslVerify: true }).then(c => (conn = c)), /TLS|required/i);
    assert.equal(p.startups, 0);
  } finally { await conn?.end(); await p.close(); }
});

test('connection deadline also bounds a peer that stalls SSL negotiation', async () => {
  const p = await peer({ reply: false });
  let timer;
  try {
    const result = await Promise.race([
      connect({ ...p.options, ssl: true, sslVerify: true }).then(c => { c.end(); return 'connected'; }, () => 'rejected'),
      new Promise(resolve => { timer = setTimeout(() => resolve('unbounded'), 400); }),
    ]);
    assert.equal(result, 'rejected');
  } finally { clearTimeout(timer); await p.close(); }
});
