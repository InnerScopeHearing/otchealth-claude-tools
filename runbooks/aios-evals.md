# Bounded local evaluator report

`tools/aios-eval-report.mjs` normalizes one local evaluator JSON document into `EvalRunV1`. It performs no network calls, model calls, ledger access, or writes except an explicitly requested new report file. Use synthetic inputs for local validation and preserve the original evaluator output outside the normalized report according to its own data policy.

The input has `schemaVersion: 1`, nonempty metadata fields `suite`, `model`, `prompt`, `tool`, and `sourceVersion`, plus a `cases` array capped at 500. `sourceIndexGeneration` and each case's `category` are optional nullable labels; missing values are reported as `null`, not inferred. `prompt` is treated as opaque text and hashed; it is never copied into the report. Each case has a unique local `id`, one of `answered`, `no_evidence`, or `dependency_failed`, nullable correctness and citation booleans, a required boolean `abstained`, and nullable nonnegative `latencyMs` and `costUsd`. Unknown fields are rejected so prompts, response bodies, and arbitrary source data cannot silently enter the output. See `tests/aios-eval-report.test.mjs` for the accepted fixture shape.

Run from the fleet repository root:

```sh
node tools/aios-eval-report.mjs /path/to/local-eval.json --out /path/to/EvalRunV1.json
```

For the gateway's sanitized `EVAL_BASELINE_V1` output, also pass the exact case artifact bytes used for that run:

```sh
node tools/aios-eval-report.mjs /path/to/baseline.json --cases /path/to/cases.json --out /path/to/EvalRunV1.json
```

This mode validates one-based contiguous ordinals and kind agreement, then binds every case to the SHA-256 of the exact case artifact bytes. It emits category pass denominators from the pinned case artifact without copying case IDs, query text, or expected bodies. Gateway baseline `pass` means the runner's fixed check passed; it does not establish answer correctness, ranked retrieval, citation validity, or source currentness. The current producer exposes no model/prompt/tool/source/index generation, evidence pointers, ranks, citation-to-claim observations, latency, or cost, so these remain null or have zero observed denominator. The output is a wrapper candidate, not a frozen owner-reviewed Task35 holdout receipt.

The output includes suite/model/tool/source and optional source-index generation, a prompt hash, input hash, per-case hashes, counts and metric denominators, and latency/cost observation coverage. It omits case IDs. Per-category results are grouped by the supplied category, with uncategorized cases retained as `category: null`; each group reports its observed case, answer, citation, and dependency-failure denominators. `dependencyFailures`, `wrongAnswers`, and `noEvidence` are separate counts. Correctness is measured only over answered cases; citation rates use cases marked `citationExpected: true`. A citation only counts as valid when it is also present, and the normalized per-case flag cannot claim a missing citation is valid. Empty metric denominators produce a null rate. Cost reports the sum of observed case costs and separately gives `observedCaseCount`, total denominator, and `complete`; if no costs were supplied, the sum is null, never zero. A partial sum is explicitly incomplete and must not be described as total run cost. Timings use only observed latency values and include their denominator.

`inputSha256` in CLI mode is the digest of the exact input file bytes. Each `caseSha256` hashes that case's JSON serialization, and `promptSha256` hashes the prompt field. Hashes support fixture identity and change detection; they do not establish truth, privacy, or quality. Output metadata is not a quality average and must not be compared across different suites, models, prompts, tools, source versions, or index generations without a separately defined evaluation design. The CLI resolves its invoked script path through the platform URL conversion, including paths with spaces or URL-reserved characters.

This wrapper does not calculate Recall@k, source-version correctness, currentness/supersession error, or independently verified citation-to-claim coverage because the accepted input shape does not contain those observations. It does not prove live retrieval quality or cost. Synthetic fixture output validates normalization only; the frozen owner-reviewed holdout and repeat comparison belong to AIOS-35/36, and live quality remains unmeasured until those authorized inputs are run. A source artifact hash pins bytes but does not establish immutability, owner review, or holdout separation.

## Focused verification

```sh
node --test tests/aios-eval-report.test.mjs
node --test tests/recall-evals-scoring.test.mjs tests/recall-evals-pager.test.mjs
node --test tests/browser-gates.test.mjs projects/browser-operations-pilot/test/policy.test.mjs
```

The related-suite commands cover existing recall scoring and browser policy checks. They do not make live gateway/model calls. For a root integration, write the bounded synthetic/local evaluator result to a JSON file and run the normalizer command above; retain the generated `EvalRunV1` report and its hashes as the integration evidence. Never substitute a missing price or cost field with zero, and never use a dependency failure as an incorrect-answer result.
