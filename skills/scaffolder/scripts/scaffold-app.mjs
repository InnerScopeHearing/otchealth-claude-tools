#!/usr/bin/env node
// scaffold-app.mjs — write a validated app.manifest.json for a repo.
// Usage:
//   node scaffold-app.mjs --app iheartest --ring non-phi --type capacitor-hybrid --brand iheartest [--out .]
// Conforms to dream-team/schemas/app.manifest.schema.json.

import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Parse --key value pairs and valueless boolean flags (e.g. --force).
const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue;
  const key = argv[i].slice(2);
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) {
    args[key] = true; // boolean flag
  } else {
    args[key] = next;
    i++;
  }
}

const app = args.app;
if (!app) { console.error('required: --app <id>'); process.exit(1); }
const ring = args.ring || 'non-phi';
const type = args.type || 'capacitor-hybrid';
const brand = args.brand || app;
const owner = args.owner || 'matthew@innd.com';
const workspace = args.workspace || 'otchealth';
const out = args.out || '.';

if (!['phi', 'non-phi'].includes(ring)) { console.error('--ring must be phi|non-phi'); process.exit(1); }

const G = () => 'na';
const manifest = {
  app,
  displayName: app.charAt(0).toUpperCase() + app.slice(1),
  ring,
  type,
  brandProfile: brand,
  stack: type === 'capacitor-hybrid'
    ? { capacitor: '8.0.0', node: '22', plugins: ['app', 'haptics', 'preferences', 'local-notifications', 'status-bar', 'splash-screen'] }
    : { node: '22' },
  services: {
    sentry: { project: app, baa: ring === 'phi', relay: ring === 'phi' },
    posthog: { project: app, baa: ring === 'phi', selfHosted: false },
    revenuecat: { app },
    customerio: { workspace },
    ota: { provider: type === 'capacitor-hybrid' ? 'capgo' : 'none', channel: 'production', rollbackOnCrashRate: 99.0 },
  },
  kits: { startup: true, build: false, testing: false, prelaunch: false, launch: false, maintenance: false, marketing: false, devkit: false },
  gates: { tests: G(), axe: G(), visual: G(), lighthouse: G(), evals: G(), supplyChain: 'fail', phiReview: ring === 'phi' ? 'running' : 'na' },
  owners: { human: owner },
  updatedBy: 'scaffolder',
  updatedAt: new Date().toISOString(),
};

const path = join(out, 'app.manifest.json');
if (existsSync(path) && !args.force) { console.error(`${path} exists; pass --force to overwrite`); process.exit(1); }
writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
console.log(`wrote ${path} (ring=${ring}, type=${type})`);
