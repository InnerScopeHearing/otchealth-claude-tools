#!/usr/bin/env node
// report.mjs — turn findings.json into a prioritized, builder-ready Markdown report
// (app-agnostic, shared skill).
//
// Mirrors the persona-focus-group output shape (per-persona walk + a consolidated,
// prioritized change list) but grounded in REAL interaction: every bug is a click
// path + screenshot + element selector + device = a reproduction the builder can act
// on. Dedupes the same defect seen on multiple devices into one row that lists where.
//
// The app name in the title is read from findings.json (`appName`, set by the runner
// via --app-name), so the same report generator serves every app.
//
// Usage: node skills/live-walkthrough/report.mjs [--in DIR] [--out FILE]
// Defaults: --in qa/live-walkthrough/out  --out qa/live-walkthrough/out/REPORT.md

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

function parseArgs(argv) {
  const a = { in: "qa/live-walkthrough/out" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--in") a.in = argv[++i];
    else if (argv[i] === "--out") a.out = argv[++i];
  }
  a.in = resolve(a.in);
  a.out = a.out ? resolve(a.out) : join(a.in, "REPORT.md");
  return a;
}

const SEV_ORDER = { P1: 0, P2: 1, P3: 2 };
const KLASS_LABEL = {
  "sticky-detach": "Sticky/fixed bar detaches on scroll",
  "horizontal-bleed": "Horizontal overflow (off-screen / sideways scroll)",
  "text-clip": "Text clipped / overflowing its container",
  "tap-target": "Tap target under 44x44px",
  "broken-link": "Broken navigation / dead control / failed request",
  "console-error": "JavaScript console / runtime error",
  "layout-shift": "Layout shift (content jumps while loading)",
  "probe-error": "Harness probe error",
};

// A stable dedup key: same bug class + element + detail-shape, across devices.
function dedupeKey(f) {
  const el = f.element || {};
  const detailShape = (f.detail || "").replace(/\d+(\.\d+)?/g, "#").slice(0, 120);
  return [f.klass, el.sel, el.text, el.aria, detailShape].join("||");
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const data = JSON.parse(readFileSync(join(opts.in, "findings.json"), "utf8"));
  const appName = data.appName || "App";

  // ---- consolidate findings across devices/journeys -----------------------
  const groups = new Map();
  for (const f of data.findings) {
    if (f.klass === "probe-error") continue; // internal noise
    const key = dedupeKey(f);
    if (!groups.has(key))
      groups.set(key, { ...f, devices: new Set(), journeys: new Set(), count: 0 });
    const g = groups.get(key);
    g.devices.add(f.device);
    if (f.journey) g.journeys.add(f.journey);
    g.count++;
    // keep the most severe rating seen
    if (SEV_ORDER[f.severity] < SEV_ORDER[g.severity]) g.severity = f.severity;
  }
  const consolidated = [...groups.values()].sort(
    (a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || b.count - a.count,
  );

  const counts = { P1: 0, P2: 0, P3: 0 };
  for (const g of consolidated) counts[g.severity]++;
  const byClass = {};
  for (const g of consolidated) byClass[g.klass] = (byClass[g.klass] || 0) + 1;

  const L = [];
  L.push(`# ${appName} — Live Persona Walkthrough: Interaction Bug Report`);
  L.push("");
  L.push(
    `Generated ${new Date().toISOString()} from a live, multi-device interaction walkthrough.`,
  );
  L.push("");
  L.push(`- App under test: \`${data.url}\``);
  L.push(`- Engine: ${data.engineNote}`);
  L.push(`- Walks: ${data.walks.length} (device x persona-journey)`);
  L.push(
    `- Distinct issues: **${consolidated.length}** — P1 ${counts.P1}, P2 ${counts.P2}, P3 ${counts.P3}`,
  );
  L.push("");
  L.push(`> Each issue below was found by a persona actually USING the app (tap / scroll / drag /`);
  L.push(
    `> navigate), not by looking at a screenshot. Every row names the element, the device(s),`,
  );
  L.push(`> and the persona whose walk hit it, with a screenshot path = a builder-ready repro.`);
  L.push("");

  L.push(`## Issue mix`);
  L.push("");
  L.push(`| Bug class | Distinct issues |`);
  L.push(`| --- | --- |`);
  for (const [k, n] of Object.entries(byClass).sort((a, b) => b[1] - a[1])) {
    L.push(`| ${KLASS_LABEL[k] || k} | ${n} |`);
  }
  L.push("");

  // ---- prioritized consolidated list --------------------------------------
  L.push(`## Prioritized fix list (consolidated across devices)`);
  L.push("");
  let i = 0;
  for (const g of consolidated) {
    i++;
    const el = g.element || {};
    const elName = el.aria || el.text || el.sel || "(element)";
    const devices = [...g.devices].join(", ");
    const journeys = [...g.journeys].join(", ");
    L.push(`### ${i}. [${g.severity}] ${KLASS_LABEL[g.klass] || g.klass}`);
    L.push("");
    L.push(`- Element: \`${el.sel || "?"}\`${elName !== el.sel ? ` — "${elName}"` : ""}`);
    L.push(`- What happens: ${g.detail}`);
    L.push(`- Seen on: ${devices}`);
    if (journeys) L.push(`- Hit by persona walk(s): ${journeys}`);
    L.push(`- Occurrences: ${g.count}`);
    L.push("");
  }
  if (consolidated.length === 0) L.push(`_No interaction or responsive defects detected._`);
  L.push("");

  // ---- per-persona walk narrative -----------------------------------------
  L.push(`## Per-persona walk transcripts`);
  L.push("");
  // Group walks by journey, list the device coverage + the step narration + that
  // walk's findings. Use the first device's walk for the narration (same script).
  const byJourney = new Map();
  for (const w of data.walks) {
    if (!byJourney.has(w.journey)) byJourney.set(w.journey, []);
    byJourney.get(w.journey).push(w);
  }
  for (const [jid, walks] of byJourney) {
    const w0 = walks[0];
    L.push(`### ${jid} — ${w0.group}`);
    L.push("");
    L.push(`Persona: ${w0.persona}`);
    L.push("");
    L.push(`Goal: ${w0.goal}`);
    L.push("");
    L.push(`Devices walked: ${walks.map((w) => w.device).join(", ")}`);
    L.push("");
    L.push(`Walk (start \`${w0.start}\`):`);
    for (const s of w0.steps) {
      const r = s.result || {};
      let line = `${s.n}. \`${s.kind}\``;
      if (s.step[s.kind] && typeof s.step[s.kind] !== "object")
        line += ` ${JSON.stringify(s.step[s.kind])}`;
      if (r.navigated) line += ` -> navigated to ${r.after ? new URL(r.after).pathname : "?"}`;
      if (r.ok === false) line += ` -> **NO EFFECT** (${r.reason || "dead"})`;
      if (r.ok === false && r.expectPath) line += ` (expected ${r.expectPath})`;
      if (s.narration) line += `  _"${s.narration}"_`;
      L.push(line);
    }
    L.push("");
    const wFindings = walks.flatMap((w) => w.findings.map((f) => ({ ...f, device: w.device })));
    if (wFindings.length) {
      const distinct = new Map();
      for (const f of wFindings) if (!distinct.has(dedupeKey(f))) distinct.set(dedupeKey(f), f);
      L.push(
        `Issues on this walk: ${distinct.size} (${[...distinct.values()]
          .map((f) => f.severity)
          .sort()
          .join(", ")})`,
      );
    } else {
      L.push(`Issues on this walk: none`);
    }
    L.push("");
  }

  // ---- artifacts index -----------------------------------------------------
  L.push(`## Artifacts`);
  L.push("");
  L.push(
    `- Screenshots: \`out/shots/\` (one per step per walk: \`<device>__<journey>__NN-<kind>.png\`)`,
  );
  L.push(
    `- Video: \`out/video/<device>__<journey>/*.webm\` (the full session as the persona walked it)`,
  );
  L.push(
    `- Playwright trace: \`out/trace/<device>__<journey>.zip\` (open with \`npx playwright show-trace\`)`,
  );
  L.push(`- Raw findings: \`out/findings.json\``);
  L.push("");

  writeFileSync(opts.out, L.join("\n"));
  // brief stdout summary
  console.log(`REPORT -> ${opts.out}`);
  console.log(
    `Distinct issues: ${consolidated.length} (P1 ${counts.P1}, P2 ${counts.P2}, P3 ${counts.P3})`,
  );
}

main();
