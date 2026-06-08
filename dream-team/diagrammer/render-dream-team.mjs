#!/usr/bin/env node
// render-dream-team.mjs — generate a live Miro board of the Dream Team architecture
// from the design in dream-team/. Part of the `diagrammer` capability: turn a
// structured artifact into a Miro board via the REST API so docs stay current.
//
// Usage:  MIRO_TOKEN=<access-token> node render-dream-team.mjs
// Token is read from the environment only — never hardcode or commit it.
// Scopes required: boards:read, boards:write. Non-PHI content only.

const TOKEN = process.env.MIRO_TOKEN;
if (!TOKEN) {
  console.error("Set MIRO_TOKEN (Miro access token with boards:write).");
  process.exit(1);
}
const BASE = "https://api.miro.com/v2";
const H = {
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
  Accept: "application/json",
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: H,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  await sleep(150); // be gentle on rate limits
  return text ? JSON.parse(text) : {};
}

const box = (content, { x, y, w = 320, h = 110, fill = "#ffffff", color = "#1a1a2e", font = "14" }) =>
  api("POST", `/boards/${BOARD}/shapes`, {
    data: { shape: "round_rectangle", content },
    style: { fillColor: fill, color, fontSize: font, textAlign: "center", textAlignVertical: "middle" },
    position: { x, y, origin: "center" },
    geometry: { width: w, height: h },
  });

const text = (content, { x, y, w = 900, font = "24" }) =>
  api("POST", `/boards/${BOARD}/texts`, {
    data: { content },
    style: { color: "#1a1a2e", fontSize: font, textAlign: "center" },
    position: { x, y, origin: "center" },
    geometry: { width: w },
  });

const connect = (from, to) =>
  api("POST", `/boards/${BOARD}/connectors`, {
    startItem: { id: from },
    endItem: { id: to },
    shape: "elbowed",
    style: { strokeColor: "#7a7a8c", strokeWidth: "2", endStrokeCap: "arrow" },
  });

let BOARD;

const AGENTS = [
  ["Architect", "spec / plan (Spec Kit)", "#e6f0ff"],
  ["Builder", "implement (Capacitor Agent Skills, hooks)", "#e6f0ff"],
  ["QA", "tests + axe + Promptfoo (gate)", "#e6ffe6"],
  ["Release Captain", "ship (Capgo OTA / Codemagic)", "#fff4e6"],
  ["Growth", "PostHog flags / experiments / RTM", "#fff4e6"],
  ["Guardian", "supply-chain + PHI (gate veto)", "#ffe6e6"],
  ["Medic", "Sentry Seer / Daytona maintenance", "#ffe6e6"],
  ["Creative", "designer skill + avatar pipeline", "#f0e6ff"],
];

async function main() {
  const board = await api("POST", "/boards", {
    name: "OTCHealth Dream Team — Architecture",
    description: "Auto-generated from dream-team/ by the diagrammer. Non-PHI.",
  });
  BOARD = board.id;
  console.log("Board created:", board.viewLink || board.id);

  await text("<p><strong>OTCHealth Dream Team</strong></p>", { x: 0, y: -780, font: "36" });
  await text("<p>one coordinated AI org across the whole stack</p>", { x: 0, y: -710, font: "18" });

  // Coach
  const coach = await box(
    "<p><strong>COACH</strong></p><p>orchestrator / GM</p><p>reads goal + app.manifest, runs the play, owns gates + ledger</p>",
    { x: 0, y: -560, w: 420, h: 130, fill: "#1a1a2e", color: "#ffffff" }
  );

  // Agents row
  const xs = [-1400, -1000, -600, -200, 200, 600, 1000, 1400];
  const ids = [];
  for (let i = 0; i < AGENTS.length; i++) {
    const [name, role, fill] = AGENTS[i];
    const it = await box(`<p><strong>${name}</strong></p><p>${role}</p>`, {
      x: xs[i], y: -330, w: 340, h: 120, fill,
    });
    ids.push(it.id);
  }
  for (const id of ids) await connect(coach.id, id);

  // Bands
  await box(
    "<p><strong>SKILLS (equipment)</strong></p><p>designer · devkit · scaffolder · test-author · eval-runner · supply-chain-guard · telemetry-wiring · release-conductor · diagrammer</p>",
    { x: 0, y: -120, w: 3300, h: 90, fill: "#f5f5f7" }
  );
  await box(
    "<p><strong>SHARED NERVOUS SYSTEM</strong></p><p>app.manifest.json (source of truth) · handoff.json (relay) · status ledger (local + Notion) · MCP: Notion vault + GitHub</p>",
    { x: 0, y: 30, w: 3300, h: 90, fill: "#eef2ff" }
  );
  await box(
    "<p><strong>TECH STACK</strong></p><p>OpenAI · Vertex · ElevenLabs · Azure · PostHog · Sentry · RevenueCat · Customer.io · Capgo/Capawesome · Codemagic · Depot · Daytona · n8n · Cloudflare R2 · GitHub Actions · Notion</p>",
    { x: 0, y: 180, w: 3300, h: 90, fill: "#f5f5f7" }
  );

  console.log("Done. Open:", board.viewLink);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
