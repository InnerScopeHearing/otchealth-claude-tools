import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { buildSchemaWitness, collectSchemaWitness, resolveWitnessConfig } from '../skills/doc-indexer/job/agentstate-schema-witness.mjs';

const capturedAt = '2026-10-23T00:00:00.000Z';
const input = () => ({
  database: 'agentstate', capturedAt,
  tables: [{ name: 'agentstate_tasks' }],
  columns: [{ table: 'agentstate_tasks', name: 'pk', dataType: 'text', nullable: false, ordinal: 1 }],
  indexes: [{ table: 'agentstate_tasks', accessMethod: 'btree', unique: true, primary: true, valid: true, ready: true, partial: false, hasExpressions: false, columns: [{ name: 'pk', position: 1, descending: false }] }],
});

test('witness emits fixed metadata only and reports missing allowlisted tables explicitly', () => {
  const w = buildSchemaWitness(input());
  assert.equal(w.schema, 'agentstate-schema-witness-v1');
  assert.equal(w.status, 'ok');
  assert.equal(w.database, 'agentstate');
  assert.equal(w.namespace, 'public');
  assert.deepEqual(w.tables, [
    { name: 'agentstate_tasks', present: true }, { name: 'agentstate_memory', present: false },
    { name: 'agentstate_events', present: false }, { name: 'agentstate_oauthcodes', present: false },
    { name: 'agentstate_cache', present: false }, { name: 'agentstate_turns', present: false },
    { name: 'agentstate_decisions_pending', present: false }, { name: 'agentstate_signals', present: false },
  ]);
  assert.deepEqual(Object.keys(w).sort(), ['capturedAt', 'columns', 'database', 'indexes', 'namespace', 'schema', 'status', 'tables']);
});

for (const field of ['rowCount', 'doc', 'password', 'comment', 'default', 'predicate', 'indexSql']) {
  test(`witness refuses unexpected ${field} instead of serializing provider metadata`, () => {
    const fixture = input(); fixture.columns[0][field] = 'synthetic-private-sentinel';
    assert.throws(() => buildSchemaWitness(fixture), /WITNESS_INVALID_METADATA/);
  });
}

test('unknown tables, inconsistent columns, malformed types and duplicate catalog keys fail closed', () => {
  const cases = [
    x => { x.tables.push({ name: 'customer_records' }); },
    x => { x.columns[0].table = 'agentstate_events'; },
    x => { x.columns[0].dataType = 'text; SELECT secret'; },
    x => { x.columns.push({ ...x.columns[0] }); },
    x => { x.indexes[0].columns[0].name = 'missing'; },
    x => { x.database = 'another_database'; },
    x => { x.capturedAt = 'not-a-date'; },
  ];
  for (const mutate of cases) { const x = input(); mutate(x); assert.throws(() => buildSchemaWitness(x), /WITNESS_INVALID_METADATA/); }
});

function catalogDb({ fail = false } = {}) {
  const calls = [];
  let ended = false;
  return {
    calls, get ended() { return ended; },
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (fail && sql.startsWith('SELECT')) throw new Error('provider secret synthetic-private-sentinel');
      if (/current_database/.test(sql)) return { rows: [['agentstate', 'on']] };
      if (/pg_index/.test(sql)) return { rows: [['agentstate_tasks', '123', 't', 't', 't', 't', 'f', 'f', '1', 'pk', 'f', 'btree']] };
      if (/pg_attribute/.test(sql)) return { rows: [['agentstate_tasks', 'pk', 'text', 'f', '1']] };
      if (/pg_class/.test(sql)) return { rows: [['agentstate_tasks']] };
      return { rows: [] };
    },
    async end() { ended = true; },
  };
}

test('collector uses a read-only transaction and fixed catalog queries, never application rows', async () => {
  const db = catalogDb();
  const w = await collectSchemaWitness({ db, capturedAt });
  assert.equal(w.status, 'ok');
  assert.deepEqual(w.columns, [{ table: 'agentstate_tasks', name: 'pk', dataType: 'text', nullable: false, ordinal: 1 }]);
  assert.match(db.calls[0].sql, /^BEGIN.*READ ONLY$/);
  assert.ok(db.calls.some(c => /statement_timeout.*3000/.test(c.sql)));
  for (const call of db.calls.filter(c => c.sql.startsWith('SELECT') && !c.sql.includes('current_database'))) {
    assert.match(call.sql, /pg_catalog\./);
    assert.doesNotMatch(call.sql, /FROM\s+(?:public\.)?agentstate_/i);
    assert.deepEqual(call.params, ['{agentstate_tasks,agentstate_memory,agentstate_events,agentstate_oauthcodes,agentstate_cache,agentstate_turns,agentstate_decisions_pending,agentstate_signals}']);
  }
  assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
  assert.equal(db.ended, true);
});

test('collector distinguishes B-tree ordering from non-ordered index access methods', async () => {
  for (const method of ['hash', 'gin', 'gist', 'spgist', 'brin']) {
    const db = catalogDb(), query = db.query;
    db.query = async (sql, params) => /pg_index/.test(sql) ? { rows: [['agentstate_tasks', '123', 'f', 'f', 't', 't', 'f', 'f', '1', 'pk', null, method]] } : query(sql, params);
    const witness = await collectSchemaWitness({ db, capturedAt });
    assert.equal(witness.status, 'ok');
    assert.equal(witness.indexes[0].accessMethod, method);
    assert.equal(witness.indexes[0].columns[0].descending, null);
  }
});

test('unknown access methods and fabricated ordering flags fail closed', async () => {
  for (const [method, direction] of [['custom_am', null], ['hash', 'f'], ['btree', null]]) {
    const db = catalogDb(), query = db.query;
    db.query = async (sql, params) => /pg_index/.test(sql) ? { rows: [['agentstate_tasks', '123', 'f', 'f', 't', 't', 'f', 'f', '1', 'pk', direction, method]] } : query(sql, params);
    assert.equal((await collectSchemaWitness({ db, capturedAt })).status, 'unknown');
  }
});

test('query failure emits only an unknown envelope and always closes, never partial absence or raw errors', async () => {
  const db = catalogDb({ fail: true });
  assert.deepEqual(await collectSchemaWitness({ db, capturedAt }), { schema: 'agentstate-schema-witness-v1', status: 'unknown', code: 'WITNESS_QUERY_FAILED' });
  assert.equal(db.ended, true);
  assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
});

test('configuration requires exact reviewed CA path, required runtime config and verified TLS', () => {
  for (const env of [{}, { NODE_EXTRA_CA_CERTS: '/tmp/wrong.pem' }, { NODE_EXTRA_CA_CERTS: '/app/certs/rds-global-bundle.pem', PG_SSL_VERIFY: 'false' }]) {
    assert.throws(() => resolveWitnessConfig(env), /WITNESS_CONFIG_INVALID/);
  }
});

test('valid runtime configuration forces verified TLS and rejects invalid DB, port and TLS overrides', () => {
  // Only the external fixed-file existence boundary is replaced. The real resolver
  // and every field validation execute in a clean subprocess, with no connection.
  const witnessUrl = new URL('../skills/doc-indexer/job/agentstate-schema-witness.mjs', import.meta.url).href;
  const script = `import assert from 'node:assert/strict'; import {registerHooks} from 'node:module';
    registerHooks({resolve(s,c,next){if(s==='node:fs'&&c.parentURL===${JSON.stringify(witnessUrl)})return{url:'data:text/javascript,export const existsSync=()=>true;export const statSync=()=>({isFile:()=>true});',shortCircuit:true};return next(s,c);}});
    const {resolveWitnessConfig}=await import(${JSON.stringify(witnessUrl)});
    const env={NODE_EXTRA_CA_CERTS:'/app/certs/rds-global-bundle.pem',PG_HOST:'synthetic.invalid',PG_USER:'fixture',PG_PASSWORD:'synthetic-only'};
    const {host,user,password,...safe}=resolveWitnessConfig(env); console.log(JSON.stringify(safe));
    for(const change of [{PG_PORT:'5432junk'},{PG_PORT:'0'},{PG_PORT:'65536'},{PG_DATABASE:'other'},{PG_SSL:'false'},{PG_SSL_VERIFY:'false'},{PG_PASSWORD:''},{NODE_EXTRA_CA_CERTS:'/tmp/other.pem'}])assert.throws(()=>resolveWitnessConfig({...env,...change}),/WITNESS_CONFIG_INVALID/);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 2000 });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { port: 5432, database: 'agentstate', ssl: true, sslVerify: true, allowWeakAuth: false, connectTimeoutMs: 5000 });
});

test('wrong database, writable transaction and malformed catalog results never produce a successful witness', async () => {
  for (const identity of [[['other', 'on']], [['agentstate', 'off']], []]) {
    const db = catalogDb(), query = db.query;
    db.query = async (sql, params) => /current_database/.test(sql) ? { rows: identity } : query(sql, params);
    const w = await collectSchemaWitness({ db, capturedAt });
    assert.equal(w.status, 'unknown'); assert.equal(db.ended, true);
  }
  const db = catalogDb(), query = db.query;
  db.query = async (sql, params) => /pg_attribute/.test(sql) ? { rows: [['agentstate_tasks', 'pk']] } : query(sql, params);
  assert.equal((await collectSchemaWitness({ db, capturedAt })).status, 'unknown');
});

test('failed rollback or connection cleanup prevents an apparently successful witness', async () => {
  for (const phase of ['rollback', 'end']) {
    const db = catalogDb(), query = db.query;
    if (phase === 'end') db.end = async () => { throw new Error('synthetic-private-sentinel'); };
    else db.query = async (sql, params) => { if (sql === 'ROLLBACK') throw new Error('synthetic-private-sentinel'); return query(sql, params); };
    assert.deepEqual(await collectSchemaWitness({ db, capturedAt }), { schema: 'agentstate-schema-witness-v1', status: 'unknown', code: 'WITNESS_CLEANUP_FAILED' });
  }
});

test('real CLI refuses missing or wrong CA before any TCP attempt and suppresses credential values', async () => {
  let connections = 0;
  const server = createServer(socket => { connections++; socket.destroy(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const ca of ['', '/tmp/no-reviewed-ca.pem']) {
      const env = { ...process.env, PG_HOST: '127.0.0.1', PG_PORT: String(server.address().port), PG_USER: 'fixture', PG_PASSWORD: 'synthetic-private-sentinel', PG_DATABASE: 'agentstate', NODE_EXTRA_CA_CERTS: ca };
      const child = spawnSync(process.execPath, ['skills/doc-indexer/job/agentstate-schema-witness.mjs'], { env, encoding: 'utf8', timeout: 2000 });
      assert.equal(child.status, 1);
      assert.equal(child.stdout, '');
      assert.doesNotMatch(child.stderr, /synthetic-private-sentinel/);
      assert.ok(child.stderr.includes('WITNESS_CONFIG_INVALID'));
    }
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('../skills/doc-indexer/job/agentstate-schema-witness.mjs', import.meta.url).href)})`], { env: { ...process.env, NODE_EXTRA_CA_CERTS: '' }, encoding: 'utf8', timeout: 2000 });
    assert.equal(imported.status, 0); assert.equal(imported.stdout, ''); assert.equal(imported.stderr, '');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(connections, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
