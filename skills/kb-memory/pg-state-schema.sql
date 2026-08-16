-- pg-state-schema.sql -- RDS Postgres schema for the two non-gateway Cosmos writers:
--   skills/decision-clock/cosmos-client.mjs  (container `decisions_pending`)
--   skills/signal-radar/common.mjs           (container `signals`)
--
-- NOT APPLIED by this migration. RDS is PubliclyAccessible=false (VPC-internal only), so this file is
-- applied by the CTO via a Fargate task, the same way otchealth-mcp-server's own agent-state tables
-- were created. Idempotent (IF NOT EXISTS throughout) so re-running it is always safe.
--
-- Document model matches otchealth-mcp-server's src/agentstate/postgres.ts and this skill's
-- skills/kb-memory/pg-state.mjs exactly: one table per container, (pk, id, doc jsonb, etag),
-- primary key (pk, id). Table names follow the SAME agentstate_<container> convention the gateway's
-- own tableFor() uses, in the SAME "agentstate" database, even though the gateway itself never reads
-- or writes these two containers -- only these two standalone skills do.
--
-- Both containers are pgcrypto-free (no vector columns, no UUID generation needed here -- ids are
-- minted client-side by newId()/signalId()), so this file adds no extensions.

CREATE TABLE IF NOT EXISTS agentstate_decisions_pending (
  pk text NOT NULL,
  id text NOT NULL,
  doc jsonb NOT NULL,
  etag text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pk, id)
);

CREATE TABLE IF NOT EXISTS agentstate_signals (
  pk text NOT NULL,
  id text NOT NULL,
  doc jsonb NOT NULL,
  etag text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pk, id)
);

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- Indexes, derived from the REAL query shapes issued by the two callers (grep-verified against
-- decision.mjs, digest-section.mjs, radar.mjs, and common.mjs -- see the migration report; nothing
-- below is speculative).
-- ─────────────────────────────────────────────────────────────────────────────────────────────────

-- agentstate_decisions_pending: NO additional index. Every real query is one of exactly two shapes:
--   (a) queryOwnerRows(): "SELECT * FROM c WHERE c.owner = @owner" scoped with pk=@owner (decision.mjs)
--       -- pk IS the owner (createDoc(CONTAINER, owner, doc) partitions by owner), so this translates
--       to `WHERE doc->>'owner' = $1 AND pk = $2` with $1 == $2. The `pk = $2` half is already served
--       by the PRIMARY KEY's leading column, which is as selective as this query gets; a secondary
--       expression index on (doc->>'owner') would only add write overhead for zero read benefit.
--   (b) queryAllRows(): "SELECT * FROM c" with NO predicate at all (decision.mjs, digest-section.mjs)
--       -- a full scan is unavoidable for a query with no WHERE clause (Cosmos's own cross-partition
--       fan-out does the equivalent full-container scan), so no index changes that cost.
--   readDoc/replaceDoc (pk+id equality) and createDoc/upsertDoc (pk+id uniqueness) are all served
--   directly by PRIMARY KEY (pk, id). This table is small (open decision-clock gates across roughly a
--   dozen agents), so a sequential scan for shape (b) is cheap regardless.

-- agentstate_signals: ONE additional index. The real query (radar.mjs's cooldown/consecutive-escalate
-- lookup, via common.mjs's cosmosQuerySignals) is:
--   "SELECT c.ts FROM c WHERE c.id = @id"  scoped with pk=@owner
-- which translates to `WHERE doc->>'id' = $1 AND pk = $2`. Unlike the decisions_pending case, this
-- filters through the JSONB `doc->>'id'` expression (the translator always maps `c.field` generically
-- through the doc column, it never assumes a Cosmos document's own "id" property is redundant with a
-- physical column, even though in practice it is here -- see below), which the plain PRIMARY KEY
-- (pk, id) index does NOT cover as a single index scan: Postgres can use the PK to narrow to the
-- `pk = $2` partition, then must still filter that partition's rows for `doc->>'id' = $1` sequentially.
-- A composite expression index on (pk, (doc->>'id')) makes the exact WHERE clause this query issues a
-- single index scan instead of PK-range-then-filter. This is run on every signal-radar `scan` tick, so
-- it is worth the one extra index (unlike (a) above, which decision-clock issues far less often and
-- which the PK already serves optimally).
CREATE INDEX IF NOT EXISTS idx_agentstate_signals_pk_docid
  ON agentstate_signals (pk, (doc ->> 'id'));
