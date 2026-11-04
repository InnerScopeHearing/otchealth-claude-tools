// Metadata-only diagnostic. No application rows, aggregates, arbitrary SQL, secret
// lookup fallback, schema creation, or business-job invocation is permitted here.
import { existsSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { connect } from '../../kb-memory/pg-wire.mjs';

const SCHEMA = 'agentstate-schema-witness-v1';
const CA_PATH = '/app/certs/rds-global-bundle.pem';
const TABLES = Object.freeze(['agentstate_tasks', 'agentstate_memory', 'agentstate_events', 'agentstate_oauthcodes', 'agentstate_cache', 'agentstate_turns', 'agentstate_decisions_pending', 'agentstate_signals']);
const TABLE_SET = new Set(TABLES);
const INDEX_METHODS = new Set(['btree', 'hash', 'gist', 'spgist', 'gin', 'brin']);
const TABLE_PARAM = `{${TABLES.join(',')}}`;
const fail = () => { throw new Error('WITNESS_INVALID_METADATA'); };
const unknown = code => ({ schema: SCHEMA, status: 'unknown', code });
const ident = x => typeof x === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(x);
const boundedInt = (x, max) => Number.isSafeInteger(x) && x >= 1 && x <= max;

function shape(value, keys) {
  if (!value || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) fail();
}

/** Strictly rebuild safe catalog metadata instead of spreading provider fields. */
export function buildSchemaWitness(input) {
  shape(input, ['database', 'capturedAt', 'tables', 'columns', 'indexes']);
  const { database, capturedAt, tables, columns, indexes } = input;
  if (database !== 'agentstate' || typeof capturedAt !== 'string' || !Number.isFinite(Date.parse(capturedAt)) || new Date(capturedAt).toISOString() !== capturedAt) fail();
  if (!Array.isArray(tables) || tables.length > 8 || !Array.isArray(columns) || columns.length > 2048 || !Array.isArray(indexes) || indexes.length > 256) fail();
  const present = new Set();
  for (const t of tables) {
    shape(t, ['name']);
    if (!TABLE_SET.has(t.name) || present.has(t.name)) fail();
    present.add(t.name);
  }
  const names = new Set(), ordinals = new Set();
  const safeColumns = columns.map(c => {
    shape(c, ['table', 'name', 'dataType', 'nullable', 'ordinal']);
    if (!present.has(c.table) || !ident(c.name) || typeof c.dataType !== 'string' || !/^[A-Za-z_][A-Za-z0-9_ ]{0,80}(?:\[\])?$/.test(c.dataType) || typeof c.nullable !== 'boolean' || !boundedInt(c.ordinal, 2048)) fail();
    const nameKey = `${c.table}:${c.name}`, ordinalKey = `${c.table}:${c.ordinal}`;
    if (names.has(nameKey) || ordinals.has(ordinalKey)) fail();
    names.add(nameKey); ordinals.add(ordinalKey);
    return { table: c.table, name: c.name, dataType: c.dataType, nullable: c.nullable, ordinal: c.ordinal };
  });
  if ([...present].some(t => !safeColumns.some(c => c.table === t))) fail();
  const safeIndexes = indexes.map(i => {
    shape(i, ['table', 'accessMethod', 'unique', 'primary', 'valid', 'ready', 'partial', 'hasExpressions', 'columns']);
    if (!present.has(i.table) || !INDEX_METHODS.has(i.accessMethod) || ['unique', 'primary', 'valid', 'ready', 'partial', 'hasExpressions'].some(k => typeof i[k] !== 'boolean') || !Array.isArray(i.columns) || i.columns.length < 1 || i.columns.length > 32) fail();
    const keys = i.columns.map(c => {
      shape(c, ['name', 'position', 'descending']);
      if (!boundedInt(c.position, 32) || !(i.accessMethod === 'btree' ? typeof c.descending === 'boolean' : c.descending === null) || !(c.name === null && i.hasExpressions || ident(c.name) && names.has(`${i.table}:${c.name}`))) fail();
      return { name: c.name, position: c.position, descending: c.descending };
    }).sort((a, b) => a.position - b.position);
    if (keys.some((c, n) => c.position !== n + 1)) fail();
    return { table: i.table, accessMethod: i.accessMethod, unique: i.unique, primary: i.primary, valid: i.valid, ready: i.ready, partial: i.partial, hasExpressions: i.hasExpressions, columns: keys };
  });
  safeColumns.sort((a, b) => TABLES.indexOf(a.table) - TABLES.indexOf(b.table) || a.ordinal - b.ordinal);
  safeIndexes.sort((a, b) => TABLES.indexOf(a.table) - TABLES.indexOf(b.table) || JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { schema: SCHEMA, status: 'ok', capturedAt, database, namespace: 'public', tables: TABLES.map(name => ({ name, present: present.has(name) })), columns: safeColumns, indexes: safeIndexes };
}

const CATALOG_TABLES = `SELECT c.relname FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND c.relname = ANY($1::text[])
ORDER BY c.relname`;
const CATALOG_COLUMNS = `SELECT c.relname, a.attname, pg_catalog.format_type(a.atttypid, NULL), NOT a.attnotnull, a.attnum
FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND c.relname = ANY($1::text[]) AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY c.relname, a.attnum`;
const CATALOG_INDEXES = `SELECT c.relname, i.indexrelid::text, i.indisunique, i.indisprimary, i.indisvalid, i.indisready,
i.indpred IS NOT NULL, i.indexprs IS NOT NULL, k.position, a.attname,
CASE WHEN am.amname = 'btree' THEN (i.indoption[k.position::int - 1] & 1) = 1 ELSE NULL END, am.amname
FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
JOIN pg_catalog.pg_am am ON am.oid = ic.relam
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, position)
LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND c.relname = ANY($1::text[]) AND k.position <= i.indnkeyatts
ORDER BY c.relname, i.indexrelid, k.position`;

function pgBool(x) { if (x === 't') return true; if (x === 'f') return false; return fail(); }
function pgInt(x) { if (typeof x !== 'string' || !/^[1-9][0-9]{0,9}$/.test(x)) fail(); return Number(x); }
function resultRows(result, width, limit) {
  if (!result || !Array.isArray(result.rows) || result.rows.length > limit || result.rows.some(r => !Array.isArray(r) || r.length !== width)) fail();
  return result.rows;
}

/** Owns and closes the supplied connection, including all error paths. */
export async function collectSchemaWitness({ db, capturedAt = new Date().toISOString() }) {
  let began = false, result;
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); began = true;
    await db.query("SET LOCAL statement_timeout = '3000ms'");
    await db.query("SET LOCAL idle_in_transaction_session_timeout = '10000ms'");
    const identity = resultRows(await db.query("SELECT current_database(), current_setting('transaction_read_only')"), 2, 1);
    if (identity.length !== 1 || identity[0][1] !== 'on') fail();
    const tables = resultRows(await db.query(CATALOG_TABLES, [TABLE_PARAM]), 1, 8).map(r => ({ name: r[0] }));
    const columns = resultRows(await db.query(CATALOG_COLUMNS, [TABLE_PARAM]), 5, 2048).map(r => ({ table: r[0], name: r[1], dataType: r[2], nullable: pgBool(r[3]), ordinal: pgInt(r[4]) }));
    const indexRows = resultRows(await db.query(CATALOG_INDEXES, [TABLE_PARAM]), 12, 8192);
    const groups = new Map();
    for (const r of indexRows) {
      if (typeof r[1] !== 'string' || !/^[1-9][0-9]{0,9}$/.test(r[1])) fail();
      if (!INDEX_METHODS.has(r[11])) fail();
      const flags = { table: r[0], accessMethod: r[11], unique: pgBool(r[2]), primary: pgBool(r[3]), valid: pgBool(r[4]), ready: pgBool(r[5]), partial: pgBool(r[6]), hasExpressions: pgBool(r[7]) };
      if (!groups.has(r[1])) groups.set(r[1], { ...flags, columns: [] });
      const group = groups.get(r[1]);
      if (Object.keys(flags).some(k => group[k] !== flags[k])) fail();
      const descending = r[11] === 'btree' ? pgBool(r[10]) : r[10] === null ? null : fail();
      group.columns.push({ name: r[9], position: pgInt(r[8]), descending });
    }
    result = buildSchemaWitness({ database: identity[0][0], capturedAt, tables, columns, indexes: [...groups.values()] });
  } catch (error) {
    result = unknown(error?.message === 'WITNESS_INVALID_METADATA' ? 'WITNESS_INVALID_METADATA' : 'WITNESS_QUERY_FAILED');
  } finally {
    if (began) { try { await db.query('ROLLBACK'); } catch { result = unknown('WITNESS_CLEANUP_FAILED'); } }
    try { await db.end(); } catch { result = unknown('WITNESS_CLEANUP_FAILED'); }
  }
  return result;
}

/** Existing SSM references must inject these values at task launch; no lookup fallback. */
export function resolveWitnessConfig(env = process.env) {
  try {
    if (env.NODE_EXTRA_CA_CERTS !== CA_PATH || !existsSync(CA_PATH) || !statSync(CA_PATH).isFile()) throw new Error();
    if (env.PG_SSL && env.PG_SSL !== 'true' || env.PG_SSL_VERIFY && env.PG_SSL_VERIFY !== 'true') throw new Error();
    if (!env.PG_HOST || !env.PG_USER || !env.PG_PASSWORD || env.PG_DATABASE && env.PG_DATABASE !== 'agentstate') throw new Error();
    const port = env.PG_PORT ?? '5432';
    if (!/^[0-9]{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error();
    return { host: env.PG_HOST, port: Number(port), user: env.PG_USER, password: env.PG_PASSWORD, database: 'agentstate', ssl: true, sslVerify: true, allowWeakAuth: false, connectTimeoutMs: 5000 };
  } catch { throw new Error('WITNESS_CONFIG_INVALID'); }
}

async function main() {
  const timer = setTimeout(() => { process.stderr.write(`${JSON.stringify(unknown('WITNESS_DEADLINE'))}\n`); process.exit(1); }, 300000);
  try {
    const config = resolveWitnessConfig();
    const result = await collectSchemaWitness({ db: await connect(config) });
    if (result.status !== 'ok') { process.stderr.write(`${JSON.stringify(result)}\n`); process.exitCode = 1; }
    else process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = error?.message === 'WITNESS_CONFIG_INVALID' ? 'WITNESS_CONFIG_INVALID' : 'WITNESS_CONNECTION_FAILED';
    process.stderr.write(`${JSON.stringify(unknown(code))}\n`); process.exitCode = 1;
  } finally { clearTimeout(timer); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
