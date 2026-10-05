#!/usr/bin/env node
import { validateCurrentClosePacket, validateHistoricalReconstructionPlan } from './finance_status.mjs';

const validators = { current: validateCurrentClosePacket, historical: validateHistoricalReconstructionPlan };
let output;
try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--mode' || !Object.hasOwn(validators, args[1])) {
    throw new Error('Use --mode current or --mode historical; supply status/reference JSON on stdin.');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw new Error('Status metadata exceeds the 1 MiB input limit.');
    chunks.push(chunk);
  }
  let input;
  try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Input must be valid JSON status/reference metadata.'); }
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).length !== 2 || !Object.hasOwn(input, 'value') || !Object.hasOwn(input, 'expected')) {
    throw new Error('Input must contain exactly value and expected metadata objects.');
  }
  const result = validators[args[1]](input.value, input.expected);
  output = { draft_validation: true, live_authorization: false, mode: args[1], ...result };
} catch (error) {
  output = { draft_validation: true, live_authorization: false, ok: false,
    errors: [error.message] };
}
process.stdout.write(JSON.stringify(output) + '\n');
process.exitCode = output.ok ? 0 : 2;
