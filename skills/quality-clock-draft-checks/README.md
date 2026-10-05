# Quality clock draft validator

`n14-quality.mjs` is a deterministic, source-free structural checker for internal draft quality/complaint clock metadata. It checks caller-supplied identity, awareness timestamps, owner/backup metadata, acknowledgements, adopted-policy consistency, escalation state, and optional closure receipts. It assigns no policy, clock duration, actors, or live sources, and performs no I/O.

Use `validateComplaintCase(record, nowIso)` with synthetic/internal metadata only. The return value is a draft validation result (`accepted`, `state`, `reasons`); it is not legal, medical, regulatory, or operational approval. Do not pass complaint/customer bodies, PHI, source documents, or privileged content. The check does not establish qualifications, policy adoption, native receipt authenticity, or source truth; those remain with their authorized owner lanes.

Run focused tests with `node --test n14-quality.test.mjs`.
