---
name: cutover-preflight
description: The GO / NO-GO gate for moving the company brain off Azure to AWS. Runs eight checks against LIVE systems (ECS, OpenSearch, S3, the embeddings provider, the running task definition, EventBridge, Cloudflare DNS) and refuses to say GO unless every dependency is proven, not merely configured. Read-only and safe to run at any time. Exits 0 only on GO, so it can gate an automated cutover directly. Use before any DNS flip, after any migration step, and whenever someone believes the cutover is ready.
---

# cutover-preflight

```bash
node skills/cutover-preflight/preflight.mjs          # full report
node skills/cutover-preflight/preflight.mjs --json   # machine-readable, for a CI gate
```

Exit code: **0 = GO**, **1 = NO-GO**. Any check that cannot complete counts as a FAIL.

## Why it exists

On 2026-08-15 the cutover was believed ready. Four independent blockers were found in a single day,
and every existing check had missed all four:

- memory **writes** still went to Azure while reads came from OpenSearch, which would have presented
  as fleet-wide amnesia (write succeeds, recall fails, nothing errors)
- documents were mirrored to S3, but no code path could read them
- query embeddings still ran through Azure Foundry
- Azure writes could not authenticate from AWS, making rollback one-way for memory

The common cause was not carelessness. Every check in use inspected **configuration** and reported
what the system *intended*, while all four failures lived in what it *did*. An env var reading
`SEARCH_BACKEND=opensearch` looks like proof and is not.

So every check here queries a live system and asserts on an observable effect.

## The checks

| id | proves |
|---|---|
| `AWS-COMPUTE` | the ECS service is actually running its tasks |
| `BRAIN-PARITY` | every OpenSearch room is within 2% of its Azure twin |
| `DOCS-S3` | a real document **and** its extracted-text sidecar read from the mirror |
| `EMBEDDINGS` | the non-Azure provider returns the same 3072-dim vector space |
| `DUAL-WRITE` | writes reach both backends, and the Azure leg can authenticate |
| `AZURE-DEPS` | no runtime dependency on Azure remains |
| `JOBS` | the jobs that keep the brain fresh are scheduled (advisory) |
| `DNS` | where traffic currently goes, and how fast rollback is |

## Design rules

**Fail closed.** A check that throws is recorded as FAIL, and a crash exits non-zero. During a
migration an unverifiable dependency is indistinguishable from a broken one, and a preflight that
crashed into a GO would be worse than no preflight at all.

**No check passes on a setting.** `DUAL-WRITE` reads the *running* task definition, not the repo.
`DOCS-S3` fetches real bytes. `EMBEDDINGS` asks the provider for a real vector and checks its
dimensionality against what the index requires.

**Read-only.** Nothing here mutates anything.

## Two traps this tool itself hit

Both produced a *plausible empty result* rather than an error, which is the same failure shape it
exists to catch. They are fixed here and worth knowing before writing any AWS probe:

- `fetch()` **forbids setting the `Host` header**. A request to the load balancer's own hostname
  therefore carries the wrong Host, matches no routing rule, and returns an upstream error that
  looks exactly like a dead service. Ask ECS for service state instead.
- SigV4 canonicalises the query string **sorted by key**, S3 requires a **signed**
  `x-amz-content-sha256`, and ECS requires `X-Amz-Target` plus `application/x-amz-json-1.1`. Miss
  any of them and the call fails in a way that reads as "no data".

## Interpreting a NO-GO

`BRAIN-PARITY` failing on `memory-exec` by a small margin is expected right up until the flip:
agent memory is written continuously, so any bulk copy is stale the moment it finishes. That room
must be re-synced **at** the cutover, not before it. Every other room should reach parity and stay
there.
