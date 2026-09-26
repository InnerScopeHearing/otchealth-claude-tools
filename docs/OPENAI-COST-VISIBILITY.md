# OpenAI usage response receipts

`setup/openai-usage.mjs` writes an allowlisted receipt for provider usage into the existing JSONL ledger and sends usage counts to the existing Datadog metrics. It does not create another ledger.

## Receipt fields

| Field | Source |
| --- | --- |
| `ts` | UTC timestamp when the local recorder receives the response |
| `provider` | Fixed value `openai` |
| `kind` | Instrumented call path, such as `chat`, `embedding`, `batch`, or `image` |
| `model` | Model returned in the provider response body, when present |
| `requestId` | Provider response `x-request-id` header, or the Batch response `request_id` |
| `responseId` | `id` returned in the provider response body, when present |
| `httpStatus` | Fetch response status, or Batch response `status_code`, when present |
| `usage` | Allowlisted finite, nonnegative token counts returned in the provider's `usage` object, including recognized nested token-detail groups |

Missing values remain omitted. A numeric zero returned by the provider remains zero. Cost and identity fields are excluded even if they appear in a future usage object. The receipt does not estimate dollar costs. When no recognized token counts are returned, no receipt is written.

## Instrumented responses

- Synchronous chat completions and embeddings, where the parsed provider response contains usage. See the [OpenAI Chat Completions API reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) and [Embeddings API reference](https://developers.openai.com/api/reference/resources/embeddings/methods/create).
- Each output line from a completed Batch response, when its response body contains usage. Batch line content and custom IDs are not recorded. The Batch response structure is described in the [OpenAI Batch API reference](https://platform.openai.com/docs/api-reference/batch/object?api-mode=responses).
- Direct OpenAI GPT Image generation responses, when the raw response includes usage. The model is recorded only if the provider returns it. Azure image responses are not attributed to OpenAI. See the [OpenAI Image API reference](https://developers.openai.com/api/reference/cli/resources/images/methods/generate).

The ledger path defaults to `~/.otchealth/openai-usage/usage-<YYYY-MM-DD>.jsonl`. `OPENAI_USAGE_LEDGER_DIR` can point it to another directory.

## Datadog

The existing Datadog emitter receives returned input and output token counts when those fields exist, plus request counts. Metrics use only provider, kind, and returned model tags. Request and response IDs are not metric tags. No estimated dollar metric is emitted.

## Data not recorded

Receipts exclude prompts, completions, tool arguments, image bytes, revised prompts, credentials, user identity, batch custom IDs, and other response fields. The recorder copies only allowed metadata and numeric usage values from the parsed provider response; it never serializes the full response body.

This receipt is provider-returned usage telemetry, not an invoice or a cost reconciliation. It does not prove billing totals or capture a response that lacks numeric usage fields.
