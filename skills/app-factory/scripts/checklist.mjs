#!/usr/bin/env node
// checklist.mjs, print a per-layer app-factory (Medvi Playbook) readiness checklist.
// Usage:
//   node checklist.mjs --app iheartest --mode internal
//   node checklist.mjs --app aware --mode b2b-managed --status acquisition=done,distribution=pending
//   node checklist.mjs --app plantid --mode b2b-sop --out /tmp/plantid-app-factory-checklist.md
//
// Dependency-free. No em dashes or en dashes in any generated output (published-style content).

import { writeFileSync } from 'node:fs';

// Parse --key value pairs and valueless boolean flags.
const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue;
  const key = argv[i].slice(2);
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) {
    args[key] = true;
  } else {
    args[key] = next;
    i++;
  }
}

const app = args.app;
if (!app || app === true) {
  console.error('required: --app <id>');
  process.exit(1);
}

const mode = args.mode || 'internal';
if (!['internal', 'b2b-sop', 'b2b-managed'].includes(mode)) {
  console.error('--mode must be internal|b2b-sop|b2b-managed');
  process.exit(1);
}

const VALID_STATUS = new Set(['done', 'pending', 'gap']);

function parseStatus(raw) {
  const map = {};
  if (!raw || raw === true) return map;
  for (const pair of String(raw).split(',')) {
    const [k, v] = pair.split('=').map((s) => s && s.trim());
    if (!k || !v) continue;
    if (!VALID_STATUS.has(v)) {
      console.error(`invalid status "${v}" for layer "${k}", must be done|pending|gap`);
      process.exit(1);
    }
    map[k] = v;
  }
  return map;
}

const statusMap = parseStatus(args.status);

// The seven layers of the Medvi Playbook, synthesized from
// research/capgo-phase2-2026-07-21/PHASE2-SYNTHESIS.md section 5 and
// 10-crosscut-b2b-medvi-internal.md. Keep this array the single source of
// truth for the layer list, SKILL.md documents each layer in full.
const LAYERS = [
  {
    id: 'acquisition',
    name: 'Acquisition',
    internal: 'Native Market cross-promotion deep links across the shared publisher identity, plus partner-attributed Universal Links carrying a clinic or referral code.',
    b2b: 'Partner-attributed Universal Links as the referral mechanic behind a clinic rev-share or co-marketing relationship.',
  },
  {
    id: 'onboarding',
    name: 'Onboarding',
    internal: 'Document Scanner-powered clinic intake, edge-detected, perspective-corrected scan-to-PDF for forms, insurance cards, and questionnaires.',
    b2b: 'AWARE clinic document-intake product, sellable standalone and strengthens the audiologist-licensing pitch.',
  },
  {
    id: 'distribution',
    name: 'Distribution',
    internal: 'Capgo channels as a per-tenant content bundle on one shared binary, device-targeted beta channels for the Mark Moore review ritual and internal QA, staged rollout for safe paywall A/B testing.',
    b2b: 'One binary, N per-partner Capgo channels, onboarding a new clinic partner becomes an OTA channel push instead of an App Store review cycle.',
  },
  {
    id: 'trust',
    name: 'Trust',
    internal: 'SSL Pinning, an app-integrity check, Native Biometric Keychain token storage, Privacy Screen tagging on the sensitive-surface registry that already drives PostHog replay masking.',
    b2b: 'The "OTCHealth Trust and Security" one-pager answers an enterprise security questionnaire once instead of per deal, plus branded verified-call as a differentiator.',
  },
  {
    id: 'monetization',
    name: 'Monetization',
    internal: 'subscription-app-revenue MRR formulas, the 80 percent paywall-visibility diagnostic, one-change-per-release-cycle churn discipline, RevenueCat server-side entitlement enforcement.',
    b2b: 'The same doctrine repackaged as what AWARE hands an audiologist partner, "how to think about your patients subscription funnel."',
  },
  {
    id: 'reliability-audit',
    name: 'Reliability and audit',
    internal: 'Offline-durable, tamper-evident-sync local data capture, plus capsec CI security scanning mapped onto the fleet hardened rules (SEC001, CAP009, LOG001/LOG002).',
    b2b: 'Device or app attestation on the adherence-data chain makes an RTM billing claim defensible against a payer audit or clawback.',
  },
  {
    id: 'release',
    name: 'Release',
    internal: 'capacitor-apple-review-preflight as the standing CTO pre-dispatch gate, capsec as the CI gate, Depot as the signing and build backbone, Capgo Live Updates as the rapid-iteration loop.',
    b2b: 'Every AWARE clinic-facing build gets the preflight before dispatch, every time, a rejected or pulled B2B app is a partner-relationship event.',
  },
];

const MODE_LABEL = {
  internal: 'Internal fleet app',
  'b2b-sop': 'B2B offer, Shape A (licensable SOP)',
  'b2b-managed': 'B2B offer, Shape B (run-it-for-you service)',
};

const STATUS_MARK = { done: '[x]', pending: '[ ]', gap: '[!]' };

function render() {
  const lines = [];
  lines.push(`# app-factory checklist, ${app}`);
  lines.push('');
  lines.push(`Mode: ${MODE_LABEL[mode]}`);
  lines.push('');
  lines.push('Seven layers, from the Medvi Playbook (see skills/app-factory/SKILL.md for the full');
  lines.push('capability-level detail per layer). Mark a layer done, pending, or gap with --status.');
  lines.push('');
  for (const layer of LAYERS) {
    const status = statusMap[layer.id] || 'pending';
    lines.push(`## ${STATUS_MARK[status]} ${layer.name}`);
    lines.push('');
    lines.push(mode === 'internal' ? layer.internal : layer.b2b);
    lines.push('');
  }
  if (mode !== 'internal') {
    lines.push('## Ownership');
    lines.push('');
    lines.push('CRO owns the offer (pricing, partner qualification, positioning, close). CTO owns');
    lines.push('the pipeline (Depot, Capgo, capsec, RevenueCat wiring). CLO gates the contract');
    lines.push('(SOW, MSA, or licensing agreement) before signature. Any INND or investor-facing');
    lines.push('framing of this revenue line is counsel-and-Matt gated.');
    lines.push('');
  }
  lines.push('## Guardrails (inherited, do not relitigate)');
  lines.push('');
  lines.push('Depot-exclusive, CTO-only iOS build policy holds. RevenueCat is the only entitlement');
  lines.push('enforcement path. PHI and COPPA ring walls hold. The securities firewall holds, this');
  lines.push('checklist is a product and engineering artifact, never an IR claim.');
  return lines.join('\n') + '\n';
}

const out = render();
if (args.out && args.out !== true) {
  writeFileSync(args.out, out, 'utf8');
  console.log(`wrote ${args.out}`);
} else {
  process.stdout.write(out);
}
