# Status contract checks

Validate source-free N12 current-close status metadata or N13 finite historical
reconstruction draft metadata. Requires Node.js 20+; no packages or credentials.

```sh
node skills/status-contract-checks/validate.mjs --mode current < status-metadata.json
node skills/status-contract-checks/validate.mjs --mode historical < plan-metadata.json
```

After the existing toolkit startup/sync copy, use the same entrypoint at
`~/.claude/skills/status-contract-checks/validate.mjs`. Supply a JSON envelope
containing exactly `value` and `expected`. `expected` binds `tenantId`, `entityId`,
`sourceVersion` and `evaluatedAt`; current mode also pins `currentScopeRef` and
the existing `exporterConceptRef`. Values contain only status flags, bounded
periods and opaque references; pass no amounts, accounting records or bodies.

Results always declare `draft_validation: true` and `live_authorization: false`.
Exit 0 means the metadata passes the draft contract; exit 2 means rejection.
Approval fields are validated as supplied metadata, without authenticating an
approver or granting live authority. This package performs no native source
reads, financial writes, exports, reconstruction, correction or close operation.
It preserves the existing exporter reference and implements no duplicate exporter.

Run the combined checks with `node --test skills/status-contract-checks/*.test.mjs`.
