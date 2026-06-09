#!/usr/bin/env node
// render-n8n.mjs — render the n8n automation map to a Miro board.
// Data: the live n8n Cloud workflow inventory (29 workflows), grouped by the
// keep-on-n8n vs Make-candidate decision and colored by active/inactive.
// Usage:  MIRO_TOKEN=<token> node render-n8n.mjs
// Non-PHI content only.

import { createBoard, text, sticky, shape } from "./_miro.mjs";

// [name, active]
const COLUMNS = [
  {
    title: "Keep on n8n — Health / Regulated",
    items: [
      ["WF02 Adverse Event Logger", false],
      ["Voice Intake — Post-Call Pipeline", true],
      ["Helen — iHEAR Specialist Line", true],
      ["iHEARtest Customer.io Proxy", true],
      ["iHEARtest TTS Proxy", true],
      ["WF03 HSA/FSA Receipt Gen", false],
    ],
  },
  {
    title: "Keep on n8n — Proxy / Dev / Agent",
    items: [
      ["WF08 Nightly Backup -> GitHub", false],
      ["iHEARtest Send to Segment", true],
      ["MCP cio_update_newsletter", true],
      ["MCP cio_duplicate_newsletter", true],
      ["Front Desk Graph Actions", true],
      ["AWARE Signup Webhook", true],
      ["AWARE ElevenLabs Proxy", true],
      ["AWARE Lifecycle Emails", true],
    ],
  },
  {
    title: "Make-candidates — non-PHI glue (active)",
    items: [
      ["Shopify -> Customer.io Router", true],
      ["iHEARtest Weekly Digest", true],
      ["iHEARtest Daily Tip Push", true],
      ["iHEARtest CareNow Trigger", true],
      ["iHEARtest SaveRx Trigger", true],
      ["INND Shareholder Signup", true],
      ["iHEARtest Beta Signup", true],
      ["SMS -> Email Forwarder", true],
    ],
  },
  {
    title: "Make-candidates — held / low-freq",
    items: [
      ["WF04 Order Status Webhook", false],
      ["WF06 IR Newsletter Reminder", false],
      ["WF07 INND Filing Reminder", false],
      ["Flow 1 Abandoned Checkout", false],
      ["Flow 2 Welcome", false],
      ["Flow 3 Order Confirmation", false],
      ["Flow 4 Review Request", false],
    ],
  },
];

const COLX = [-1050, -350, 350, 1050];
const TOPY = -640;
const STEP = 120;

async function main() {
  const b = await createBoard(
    "OTCHealth — n8n Automation Map",
    "Auto-generated from the live n8n inventory by the diagrammer. Non-PHI."
  );
  const board = b.id;
  console.log("Board created:", b.viewLink);

  await text(board, "<p><strong>OTCHealth n8n Automation Map</strong></p>", { x: 0, y: -780, font: "34" });
  await text(board, "<p>29 workflows · green = active · gray = inactive/held</p>", { x: 0, y: -720, font: "16" });

  for (let c = 0; c < COLUMNS.length; c++) {
    const col = COLUMNS[c];
    await text(board, `<p><strong>${col.title}</strong></p>`, { x: COLX[c], y: TOPY, w: 560, font: "16" });
    for (let i = 0; i < col.items.length; i++) {
      const [name, active] = col.items[i];
      await sticky(board, `<p>${name}</p>`, {
        x: COLX[c],
        y: TOPY + 90 + i * STEP,
        w: 540,
        fill: active ? "light_green" : "gray",
      });
    }
  }

  await shape(
    board,
    "<p><strong>Reality check (last ~8 days):</strong> iHEARtest Customer.io Proxy (889) + AWARE Signup (212) = 98.6% of all executions, and that is build/test traffic, not production. True production baseline today = the cron jobs only. Plan the self-host-on-Azure move when production crosses ~8-10k/mo OR the first PHI flow goes live.</p>",
    { x: 0, y: 700, w: 2400, h: 140, fill: "#fff4e6" }
  );

  console.log("Done. Open:", b.viewLink);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
