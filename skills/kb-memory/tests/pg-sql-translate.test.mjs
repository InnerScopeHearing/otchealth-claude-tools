// pg-sql-translate.test.mjs -- translator tests, mirroring otchealth-mcp-server's pg-sql.test.ts.
//
// Two jobs, and the second matters more than the first:
//   1. every query decision-clock and signal-radar actually issue translates to the right Postgres
//   2. everything else THROWS
//
// (2) is the safety property. A translator that guesses at input it half-understands produces valid
// SQL with different meaning, which is invisible in review and in production. So the "REJECTS" tests
// below are not defensive padding; they are the reason this approach is acceptable at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { translate } from "../pg-sql-translate.mjs";

const T = (query, parameters = [], opts = {}) =>
  translate({ table: opts.table ?? "agentstate_decisions_pending", query, parameters, pk: opts.pk, max: opts.max ?? 100 });

// ---------------------------------------------------------------------------------------------
// THE THREE REAL PRODUCTION QUERIES (grep-verified against skills/decision-clock/decision.mjs and
// skills/signal-radar/{radar,common}.mjs -- see the migration report). If one of these breaks, the
// live caller breaks with it, so each is pinned verbatim from its call site.
// ---------------------------------------------------------------------------------------------

test("decision-clock queryOwnerRows: single-partition equality, pinned verbatim from decision.mjs", () => {
  const r = T("SELECT * FROM c WHERE c.owner = @owner", [{ name: "@owner", value: "cto" }], { pk: "cto", max: 500 });
  assert.equal(r.projected, false);
  assert.match(r.text, /^SELECT doc AS doc FROM agentstate_decisions_pending WHERE doc->>'owner' = \$1 AND pk = \$2 LIMIT 500$/);
  assert.deepEqual(r.values, ["cto", "cto"]);
});

test("decision-clock queryAllRows: cross-partition, no WHERE at all, pinned verbatim from decision.mjs", () => {
  const r = T("SELECT * FROM c", [], { max: 2000 });
  assert.equal(r.text, "SELECT doc AS doc FROM agentstate_decisions_pending LIMIT 2000");
  assert.deepEqual(r.values, []);
});

test("signal-radar cosmosQuerySignals cooldown lookup: single-field projection + equality, pinned verbatim from radar.mjs", () => {
  const r = T("SELECT c.ts FROM c WHERE c.id = @id", [{ name: "@id", value: "sentry-error-spike::iheartest" }], {
    table: "agentstate_signals",
    pk: "cto",
    max: 200,
  });
  assert.equal(r.projected, true);
  assert.match(r.text, /^SELECT jsonb_build_object\('ts', doc->'ts'\) AS doc FROM agentstate_signals WHERE doc->>'id' = \$1 AND pk = \$2 LIMIT 200$/);
  assert.deepEqual(r.values, ["sentry-error-spike::iheartest", "cto"]);
});

// ---------------------------------------------------------------------------------------------
// General translator correctness (ported from pg-sql.test.ts; the engine is a direct port, so it
// should behave identically on inputs neither current caller happens to send today).
// ---------------------------------------------------------------------------------------------

test("TOP + inline literal + range predicate", () => {
  const r = T(
    "SELECT TOP 25 * FROM c WHERE c.type = @type AND c.status = 'pending' AND c.due_at <= @now",
    [
      { name: "@type", value: "deindex" },
      { name: "@now", value: "2026-08-15T12:00:00Z" },
    ],
    { max: 100 },
  );
  assert.deepEqual(r.values, ["deindex", "pending", "2026-08-15T12:00:00Z"]);
  assert.match(r.text, /doc->>'status' = \$2/);
  assert.match(r.text, /doc->>'due_at' <= \$3/);
  assert.match(r.text, /LIMIT 25$/, "TOP 25 is tighter than max 100, so it wins");
});

test("CONTAINS(LOWER(..)) + ORDER BY", () => {
  const r = T(
    "SELECT * FROM c WHERE c.category = @cat AND CONTAINS(LOWER(c.text), @q) ORDER BY c.opened_at DESC",
    [
      { name: "@cat", value: "review" },
      { name: "@q", value: "rotate" },
    ],
    { pk: "cfo", max: 25 },
  );
  assert.match(r.text, /position\(\$2 in lower\(doc->>'text'\)\) > 0/);
  assert.match(r.text, /ORDER BY doc->>'opened_at' DESC/);
  assert.match(r.text, /pk = \$3/, "a single-partition query must be scoped to its pk");
  assert.deepEqual(r.values, ["review", "rotate", "cfo"]);
});

test("IS_DEFINED maps to key-exists, not to NOT NULL", () => {
  const r = T("SELECT c.owner, c.terminal_policy FROM c WHERE IS_DEFINED(c.terminal_policy)", [], { max: 5000 });
  assert.match(r.text, /jsonb_exists\(doc, 'terminal_policy'\)/);
  assert.match(r.text, /LIMIT 5000$/);
});

// ---------------------------------------------------------------------------------------------
// FAIL-CLOSED. Each of these would be a plausible thing for a future caller to write, and each must
// throw rather than be approximated.
// ---------------------------------------------------------------------------------------------

test("REJECTS a JOIN", () => {
  assert.throws(() => T("SELECT * FROM c JOIN t IN c.tags WHERE t = @x", [{ name: "@x", value: 1 }]), /unsupported/i);
});

test("REJECTS OR rather than mistranslating its precedence", () => {
  assert.throws(
    () => T("SELECT * FROM c WHERE c.a = @a OR c.b = @b", [{ name: "@a", value: 1 }, { name: "@b", value: 2 }]),
    /OR is not supported/,
  );
});

test("REJECTS an aggregate", () => {
  assert.throws(() => T("SELECT VALUE COUNT(1) FROM c"), /unsupported/i);
});

test("REJECTS an unknown scalar function", () => {
  assert.throws(() => T("SELECT * FROM c WHERE STARTSWITH(c.name, @p)", [{ name: "@p", value: "x" }]), /unsupported WHERE predicate/);
});

test("REJECTS ARRAY_CONTAINS", () => {
  assert.throws(() => T("SELECT * FROM c WHERE ARRAY_CONTAINS(c.tags, @t)", [{ name: "@t", value: "a" }]), /unsupported WHERE predicate/);
});

test("REJECTS a nested-path field", () => {
  assert.throws(() => T("SELECT * FROM c WHERE c.a.b = @p", [{ name: "@p", value: 1 }]), /unsupported WHERE predicate/);
});

test("REJECTS a parameter the caller never bound", () => {
  assert.throws(() => T("SELECT * FROM c WHERE c.owner = @nope"), /unbound parameter @nope/);
});

test("REJECTS ORDER BY on multiple fields", () => {
  assert.throws(() => T("SELECT * FROM c ORDER BY c.a DESC, c.b ASC"), /unsupported ORDER BY/);
});

// ---------------------------------------------------------------------------------------------
// Injection boundary + type semantics.
// ---------------------------------------------------------------------------------------------

test("INJECTION: a hostile field name is rejected, never interpolated", () => {
  assert.throws(
    () => T("SELECT * FROM c WHERE c.a'; DROP TABLE agentstate_signals; -- = @p", [{ name: "@p", value: 1 }]),
    /unsupported/i,
  );
});

test("INJECTION: a hostile VALUE is harmless because it binds", () => {
  const r = T("SELECT * FROM c WHERE c.owner = @a", [{ name: "@a", value: "x'; DROP TABLE agentstate_signals; --" }]);
  assert.match(r.text, /doc->>'owner' = \$1/);
  assert.deepEqual(r.values, ["x'; DROP TABLE agentstate_signals; --"]);
  assert.equal(r.text.includes("DROP TABLE"), false, "the value must never reach the SQL text");
});

test("a numeric bound value is cast, so it compares numerically not lexicographically", () => {
  const r = T("SELECT * FROM c WHERE c.n > @n", [{ name: "@n", value: 9 }]);
  assert.match(r.text, /\(doc->>'n'\)::numeric > \$1::numeric/);
});

test("a boolean bound value is cast", () => {
  const r = T("SELECT * FROM c WHERE c.innd = @d", [{ name: "@d", value: true }]);
  assert.match(r.text, /\(doc->>'innd'\)::boolean = \$1::boolean/);
});

test("the caller max wins when it is tighter than TOP", () => {
  const r = T("SELECT TOP 500 * FROM c", [], { max: 25 });
  assert.match(r.text, /LIMIT 25$/);
});

test("a cross-partition query omits the pk filter, as Cosmos does", () => {
  const r = T("SELECT * FROM c WHERE c.type = @t", [{ name: "@t", value: "memory" }]);
  assert.equal(/pk = /.test(r.text), false);
});

test("multi-line SQL parses identically to single-line", () => {
  const r = T(
    `SELECT *
      FROM c
      WHERE c.owner = @a
      ORDER BY c.opened_at DESC`,
    [{ name: "@a", value: "cto" }],
  );
  assert.match(r.text, /WHERE doc->>'owner' = \$1 ORDER BY doc->>'opened_at' DESC/);
});
