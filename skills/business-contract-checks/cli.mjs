#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { selectEntitlement, validateFollowUp } from './entitlement.mjs';
import { evaluateGrowthAdmission } from './handoff.mjs';

const enums = new Set(['UNKNOWN','approved','open','closed','held','acknowledged','eligible','routine','late','missing','rejected','capacity_shortfall','demand_to_procurement','receiving_to_stock','stock_to_channels','wholesale_po_to_cash','physical_return_to_disposition','synthetic','N08','N10','case','physical_usable_capacity','physical_capacity','accepted_available_stock','available_stock','draft_purchase_order','proposal','received','inspected','not_requested','proposed','completed','resolved','held','week','each','unit']);
function syntheticOnly(value, path = '$') {
  if (Array.isArray(value)) return value.flatMap((item, i) => syntheticOnly(item, `${path}[${i}]`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => {
    if (/^(name|email|phone|address|body|content|message|prompt|customer|patient|order|refund)$/i.test(key)) return [`${path}.${key}: disallowed field`];
    return syntheticOnly(item, `${path}.${key}`);
  });
  const marker = typeof value === 'string' && value.length <= 80 && (/^(?:synthetic(?:-[a-z0-9]+){0,6}|(?:[a-z0-9]+-){0,5}synthetic(?:-[a-z0-9]+){0,3})$/i.test(value) || /^synthetic:\/\/(?:[a-z0-9-]+\/){1,3}[a-z0-9-]+$/i.test(value));
  if (typeof value === 'string' && value !== '' && !marker && !enums.has(value) && !/^\d{4}-\d\d-\d\d(?:T.*(?:Z|[+-]\d\d:\d\d))?$/.test(value)) return [`${path}: values must be bounded synthetic markers, timestamps, or enumerated metadata`];
  return [];
}
function main() {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.stderr.write('Input must be one JSON object on stdin.\n'); process.exit(2); }
  const safetyErrors = syntheticOnly(input);
  if (!input || input.draft_validation !== true || input.live_authorization !== false || !['N08','N10'].includes(input.workflow)) safetyErrors.push('$: require draft_validation=true, live_authorization=false, workflow N08 or N10');
  let result;
  if (safetyErrors.length) result = { kind: 'draft_validation', live_authorization: false, status: 'hold', errors: safetyErrors };
  else if (input.workflow === 'N08') {
    try {
    const selected = selectEntitlement(input.purchase, input.packs, input.now);
    const followUp = input.follow_up ? validateFollowUp(input.follow_up, { ...(input.context || {}), purchase: input.purchase, selected: selected.selection, pack: Array.isArray(input.packs) ? input.packs.find((p) => p.pack_id === selected.selection?.pack_id) : null }, input.now) : null;
    result = { kind: 'draft_validation', live_authorization: false, status: selected.status === 'eligible' && (!followUp || followUp.status === 'ready') ? 'ready' : 'hold', entitlement: selected, follow_up: followUp };
    } catch {
      result = { kind: 'draft_validation', live_authorization: false, status: 'hold', errors: ['VALIDATION_ERROR'] };
    }
  } else {
    const { handoff, context, now } = input;
    try { result = { kind: 'draft_validation', live_authorization: false, ...evaluateGrowthAdmission(handoff, context, now) }; }
    catch { result = { kind: 'draft_validation', live_authorization: false, status: 'hold', errors: ['VALIDATION_ERROR'] }; }
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === 'ready' ? 0 : 1;
}
main();
