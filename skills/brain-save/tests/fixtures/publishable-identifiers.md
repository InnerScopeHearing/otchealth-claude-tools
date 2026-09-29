# Publishable identifiers and rule-stating prose (must pass the gates)

These lines mirror the kinds of identifiers the fleet's own CLAUDE.md files carry. None is a secret.

- RevenueCat public SDK key: `appl_hWXGkKMzMGoodtQjPjrFAkzfqmV` (publishable by design)
- ASC key id 9MR7PJHRYH, issuer id b3d5e801-7d26-41cd-8128-39e88e96f713, team 465UF9H72S
- Gateway OAuth client ids: `oc_cfo_3e0b8d74910a1568af` and `occ_gpt_cto_4b2a9c01d3e5f6a7` are PUBLIC halves
- Amazon seller id A2OUVRQWO8BC1S; AWS account 900915535335; Flatstick account 301001539500
- PostHog project key phc_4Qm7r2LkP9xZa1Bc3De5Fg7Hi9Jk2Lm4No6Pq8Rs0Tu (a phc_ project key is publishable)
- Stripe publishable key pk_live_51Hx9QwErTyUiOpAsDfGhJkLzXcVbNm0123456789
- Sentry DSN https://0123456789abcdef0123456789abcdef@o123456.ingest.sentry.io/4504
- Secrets live in SSM: read `/otchealth/openai-api-key` by NAME, never paste the value.
- api_key: process.env.OPENAI_API_KEY and password: ${DB_PASSWORD} and client_secret=<redacted>
- Authorization: Bearer ${token}
- postgres://user:password@localhost:5432/app is the documented local example
- The CLO lane refuses privileged exports; MNPI and PHI never leave their rings; Reg FD applies to INND.
- A test card for Stripe docs: 4242 4242 4242 4242.
