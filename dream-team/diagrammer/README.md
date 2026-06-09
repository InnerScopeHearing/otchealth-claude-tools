# diagrammer — turn structured artifacts into live Miro boards

The `diagrammer` renders a structured artifact (the Dream Team roster, an app
manifest, the n8n workflow inventory, the App-Kit lifecycle) into a Miro board
via the Miro REST API, so the diagrams stay current instead of going stale in a
README. It is the "connected" use of Miro that maximizes it beyond manual
whiteboarding.

## Auth
- Needs a Miro access token with `boards:read` + `boards:write`.
- **Token comes from the environment only** (`MIRO_TOKEN`), never hardcoded or
  committed. The token lives in the Notion API vault.

```bash
MIRO_TOKEN=<access-token> node render-dream-team.mjs
```

## Renderers
- `render-dream-team.mjs` — the Dream Team architecture (Coach + 8 agents +
  connectors + skills/interconnect/tech-stack bands). The proof-of-concept.
- (planned) `render-portfolio.mjs` — read each app's `app.manifest.json` and
  render a portfolio command-center board (ring, kits, gate status per app).
- (planned) `render-n8n.mjs` — read the n8n workflow inventory and render the
  automation map (proxies, crons, Shopify -> Customer.io).

## Rules
- **Non-PHI only.** Miro is collaborative and not BAA-covered. Architecture,
  process, journeys, and wireframes only, never patient data.
- Keep content concise; the API is rate-limited (the script paces calls).
