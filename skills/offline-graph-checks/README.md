# Offline graph and artifact checks

On-demand, deterministic internal utility for small synthetic graph fixtures and artifact reference metadata. The saved repaired evaluator and its 40 existing tests are published unchanged. It has no imports, I/O, inference jobs, provider bindings, or live action authority.

`evaluateGraphFixture(fixture)` checks typed, versioned links, bounded paths, aliases, dated findings, allegations, and conflicting evidence. `evaluateArtifactReuse(candidate)` checks immutable source-artifact fingerprints and rejects stale, deleted, changed-scope, or generated-answer reuse. Its decisions describe supplied fixture metadata; they do not authenticate sources, grant access, or authorize live reuse.

From this package directory:

```sh
node --test code/graph-contract.test.mjs evidence/adversarial.test.mjs evidence/reviewer-extra.test.mjs
node --input-type=module <<'JS'
import { evaluateGraphFixture } from './code/graph-contract.mjs';
const fixture = { query: { from: 'synthetic-a', to: 'synthetic-b', maxHops: 1 }, edges: [{ id: 'synthetic-edge', from: 'synthetic-a', to: 'synthetic-b', type: 'references', sourceId: 'synthetic-source', sourceVersion: 1 }] };
console.log(JSON.stringify({ draft_validation: true, live_authorization: false, result: evaluateGraphFixture(fixture) }));
JS
```

The existing toolkit startup/sync copies this directory to `~/.claude/skills/offline-graph-checks/`. The same exports and commands work there after that client runs its normal sync. Publication does not prove that already-running clients have synced.

Use invented fixture metadata only. This package does not connect graph routes, load protected records, or establish whole T13/T14/T62 acceptance. Existing tests cover the repaired module, including the saved adversarial cases; no new independent review approval is claimed.
