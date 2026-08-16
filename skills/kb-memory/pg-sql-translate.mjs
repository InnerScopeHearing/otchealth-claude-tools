// pg-sql-translate.mjs -- Cosmos-SQL -> PostgreSQL translator for the agent-state plane, JS port.
//
// This is a deliberate line-for-line mirror of otchealth-mcp-server's src/agentstate/pg-sql.ts
// (its own header explains WHY this approach -- translate rather than redesign the 19 call sites --
// and WHY it is safe -- fail CLOSED, recognising only the constructs actually used and throwing on
// anything else, because a translator that guesses turns input it half-understands into SQL that is
// valid but means something different, the exact silent-wrong-answer class that produced four
// separate cutover defects on 2026-08-15).
//
// It is a PORT, not an import: otchealth-claude-tools has no build step and no TypeScript anywhere,
// so the source of truth (pg-sql.ts) cannot be required from a plain .mjs skill, and the two repos
// are independently deployed. Keep this file's grammar and behaviour identical to pg-sql.ts; if that
// file grows a new construct, port the same change here with the same test.
//
// Supported grammar, in full (identical to pg-sql.ts):
//   SELECT [TOP n] (* | c.f1, c.f2, ...) FROM c
//     [WHERE <cond> (AND <cond>)*]
//     [ORDER BY c.field [ASC|DESC]]
//
//   <cond> := c.field  = |<= |>= |< |>  @param
//           | c.field  =                'literal'
//           | CONTAINS(LOWER(c.field), @param)
//           | IS_DEFINED(c.field)
//
// Everything else throws.
//
// DOCUMENT MODEL: each container is a table of (pk text, id text, doc jsonb, etag text). Cosmos's `c`
// alias maps to the `doc` column, so `c.status` becomes `doc->>'status'`.
//
// THE INJECTION BOUNDARY: field names cannot be parameterised, so they are interpolated and must pass
// a strict identifier check (FIELD_RE below). Every value -- both @params and inline 'literals' --
// binds as $n. Getting that split backwards is where an injection would live, so the two paths are
// deliberately separate.

const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function field(name) {
  if (!FIELD_RE.test(name)) throw new Error(`unsupported field name in query: ${JSON.stringify(name)}`);
  return name;
}

/**
 * Compare a JSON field against a bound value with the right type semantics.
 *
 * `->>` always yields text, so a numeric comparison through it would sort lexicographically
 * ("10" < "9"). Every predicate either of the two callers issues today compares strings, where text
 * ordering is already correct, but binding a number must not silently become a string comparison --
 * so numbers and booleans get an explicit cast instead. Mirrors pg-sql.ts's `comparison()` exactly.
 */
function comparison(fieldName, op, value, placeholder) {
  const lhs = `doc->>'${field(fieldName)}'`;
  if (typeof value === "number") return `(${lhs})::numeric ${op} ${placeholder}::numeric`;
  if (typeof value === "boolean") return `(${lhs})::boolean ${op} ${placeholder}::boolean`;
  return `${lhs} ${op} ${placeholder}`;
}

/**
 * Translate one Cosmos SQL statement.
 *
 * input: { table, query, parameters: [{name,value}], pk, max }
 * returns: { text, values, projected }
 */
export function translate(input) {
  const { table, parameters, pk, max } = input;
  // Collapse whitespace so multi-line template literals parse identically to single-line ones.
  const sql = input.query.replace(/\s+/g, " ").trim();

  const byName = new Map((parameters || []).map((p) => [p.name, p.value]));
  const values = [];
  const bind = (v) => {
    values.push(v);
    return `$${values.length}`;
  };
  const param = (name) => {
    if (!byName.has(name)) throw new Error(`query references unbound parameter ${name}`);
    return byName.get(name);
  };

  const m = /^SELECT (?:TOP (\d+) )?(.+?) FROM c(?: WHERE (.+?))?(?: ORDER BY (.+?))?$/i.exec(sql);
  if (!m) throw new Error(`unsupported query shape (not translatable): ${sql.slice(0, 200)}`);
  const [, topRaw, selectList, whereRaw, orderRaw] = m;

  // ---- SELECT list -------------------------------------------------------------------------
  let projection = "doc";
  let projected = false;
  const list = selectList.trim();
  if (list !== "*" && list !== "c") {
    const cols = list.split(",").map((s) => s.trim());
    const pairs = [];
    for (const col of cols) {
      const cm = /^c\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(col);
      if (!cm) throw new Error(`unsupported SELECT item (only c.field projections): ${col}`);
      pairs.push(`'${field(cm[1])}', doc->'${field(cm[1])}'`);
    }
    projection = `jsonb_build_object(${pairs.join(", ")})`;
    projected = true;
  }

  // ---- WHERE -------------------------------------------------------------------------------
  const conds = [];
  if (whereRaw) {
    if (/\bOR\b/i.test(whereRaw)) throw new Error("OR is not supported by the agent-state translator");
    for (const rawCond of whereRaw.split(/\s+AND\s+/i)) {
      const cond = rawCond.trim();
      let cm;

      // CONTAINS(LOWER(c.field), @param) -> case-insensitive substring. position() rather than LIKE
      // so the bound value needs no %/_ escaping; a search term containing a wildcard would otherwise
      // silently widen the match.
      if ((cm = /^CONTAINS\(\s*LOWER\(\s*c\.([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*,\s*(@[A-Za-z0-9_]+)\s*\)$/i.exec(cond))) {
        conds.push(`position(${bind(String(param(cm[2]) ?? ""))} in lower(doc->>'${field(cm[1])}')) > 0`);
        continue;
      }

      // IS_DEFINED(c.field) -> key present. An explicit null still counts as defined in Cosmos;
      // jsonb_exists matches that, `doc->>'f' IS NOT NULL` would not.
      if ((cm = /^IS_DEFINED\(\s*c\.([A-Za-z_][A-Za-z0-9_]*)\s*\)$/i.exec(cond))) {
        conds.push(`jsonb_exists(doc, '${field(cm[1])}')`);
        continue;
      }

      // c.field <op> @param
      if ((cm = /^c\.([A-Za-z_][A-Za-z0-9_]*)\s*(=|<=|>=|<|>)\s*(@[A-Za-z0-9_]+)$/.exec(cond))) {
        const v = param(cm[3]);
        conds.push(comparison(cm[1], cm[2], v, bind(v)));
        continue;
      }

      // c.field = 'literal'  (bound as a parameter, never interpolated)
      if ((cm = /^c\.([A-Za-z_][A-Za-z0-9_]*)\s*(=|<=|>=|<|>)\s*'([^']*)'$/.exec(cond))) {
        conds.push(comparison(cm[1], cm[2], cm[3], bind(cm[3])));
        continue;
      }

      throw new Error(`unsupported WHERE predicate (not translatable): ${cond}`);
    }
  }

  // Partition scoping is applied by the adapter, not written by callers, so it is appended here
  // rather than parsed. A cross-partition query simply omits it, exactly as Cosmos does.
  if (pk !== undefined) conds.push(`pk = ${bind(pk)}`);

  // ---- ORDER BY ----------------------------------------------------------------------------
  let order = "";
  if (orderRaw) {
    const om = /^c\.([A-Za-z_][A-Za-z0-9_]*)(?:\s+(ASC|DESC))?$/i.exec(orderRaw.trim());
    if (!om) throw new Error(`unsupported ORDER BY (only c.field [ASC|DESC]): ${orderRaw}`);
    order = ` ORDER BY doc->>'${field(om[1])}' ${(om[2] || "ASC").toUpperCase()}`;
  }

  // ---- LIMIT -------------------------------------------------------------------------------
  const top = topRaw ? parseInt(topRaw, 10) : Number.POSITIVE_INFINITY;
  const limit = Math.max(1, Math.min(top, max));

  const where = conds.length ? ` WHERE ${conds.join(" AND ")}` : "";
  const text = `SELECT ${projection} AS doc FROM ${table}${where}${order} LIMIT ${limit}`;
  return { text, values, projected };
}
