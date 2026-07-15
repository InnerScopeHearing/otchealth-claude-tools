// kb-memory / entity-graph.mjs, pure dependency-free helpers for the entity-RELATIONSHIP (edge) layer.
//
// Phase 4D: the smallest viable extension so the ledger can answer "what depends on X" with a 1-2 hop
// walk, without standing up a graph database (explicit anti-goal: no new data store). A link is just
// another ledger row (type "entity_link", {ekey: from, relation, evalue: to}), so it rides the exact
// same append/publish/index plumbing every other entry uses (see mem.mjs entityCmd). This module holds
// only the PURE, IO-free pieces: building a link row's content fields, and walking rows already loaded
// by mem.mjs's load(). mem.mjs supplies the Azure Blob glue (load/commitAppend), alias resolution
// (resolveAlias), and the CLI wiring. Per mem.mjs's own doc comment, the entity layer is "a thin keyed
// VIEW over the flat ledger, NOT a knowledge-graph service" -- this module keeps that spirit: thin
// edges, not a graph engine.

// Mirrors mem.mjs's normKey() (also mirrored in skills/signal-radar/detectors/contradiction-staleness.mjs
// for the same reason) so a relation label collapses casing/punctuation the same way entity keys do
// ("Depends On" and "depends-on" both become "depends_on"), keeping edges consistent no matter how a
// caller phrases the relation.
export function normRelation(s) {
  return (s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

// The content fields of an entity_link ledger row. Pure: takes already-RESOLVED keys (the caller runs
// fromKey/toKey through mem.mjs's resolveAlias first, exactly like `entity set` resolves its key before
// writing), so this function never touches the ledger or knows about aliasing. mem.mjs's commitAppend
// callback spreads {id, ts, by, tags, source} around the fields returned here.
export function linkFields(fromKey, relation, toKey) {
  const rel = normRelation(relation);
  return { type: "entity_link", ekey: fromKey, relation: rel, evalue: toKey, text: `${fromKey} -> ${rel} -> ${toKey}` };
}

// Human-readable rendering of one discovered edge: "<from-key> -> <relation> -> <to-key>".
export function formatEdge(e) {
  return `${e.from} -> ${e.relation} -> ${e.to}`;
}

// A bounded walk over the entity_link rows already in `rows` (the same array mem.mjs's load() returns;
// no separate fetch, no index, no new store). Starts at `startKey` (already alias-resolved by the
// caller, exactly like `entity get`) and expands outward up to `hops` (clamped 1-2 on purpose: this is
// deliberately NOT a general graph engine) hops, following each edge in EITHER direction so a query for
// X surfaces both "X depends_on Y" (X is the source, ekey) and "Y depends_on X" (X is the target,
// evalue) -- the second case is exactly "what depends on X". Cycles terminate via a visited-node set; a
// missing/unknown start key, or a ledger with no links at all, returns an empty edges/nodes result
// without throwing. Duplicate discovery of the same physical edge (crossed again from the other side on
// a later hop, or reachable via two paths) is deduped by the (from, relation, to) triple.
export function walkGraph(rows, startKey, opts = {}) {
  const hops = Math.max(1, Math.min(2, Number(opts.hops) || 2));
  const links = (rows || []).filter((r) => r && r.type === "entity_link" && r.ekey && r.relation && r.evalue);
  const result = { start: startKey || "", hops, edges: [], nodes: [] };
  if (!startKey) return result;

  const visited = new Set([startKey]);
  const edgeSeen = new Set();
  const pushEdge = (l, depth) => {
    const k = `${l.ekey} ${l.relation} ${l.evalue}`;
    if (edgeSeen.has(k)) return;
    edgeSeen.add(k);
    result.edges.push({ from: l.ekey, relation: l.relation, to: l.evalue, depth });
  };

  let frontier = [startKey];
  for (let depth = 1; depth <= hops && frontier.length; depth++) {
    const next = [];
    for (const node of frontier) {
      for (const l of links) {
        const isSource = l.ekey === node, isTarget = l.evalue === node;
        if (!isSource && !isTarget) continue;
        pushEdge(l, depth);
        const other = isSource ? l.evalue : l.ekey;
        if (!visited.has(other)) { visited.add(other); next.push(other); }
      }
    }
    frontier = next;
  }
  result.nodes = [...visited];
  return result;
}
