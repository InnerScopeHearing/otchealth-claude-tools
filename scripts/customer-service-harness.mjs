#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMatrix, runMatrix, sha256 } from './customer-service-harness-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const valueFor = (name, fallback) => {
  const prefix = `--${name}=`;
  const arg = args.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
};
const matrixPath = path.resolve(valueFor('matrix', path.join(here, '..', 'tests', 'fixtures', 'customer-service-scenarios.json')));
const outPath = path.resolve(valueFor('out', path.join(here, '..', 'tests', 'evidence', 'customer-service-harness-report.json')));
const repeat = Math.max(1, Number.parseInt(valueFor('repeat', '1'), 10) || 1);

const matrixBytes = fs.readFileSync(matrixPath);
const matrix = JSON.parse(matrixBytes.toString('utf8'));
const report = runMatrix(matrix, { repeat });
report.matrix_path = path.relative(process.cwd(), matrixPath);
report.matrix_file_sha256 = sha256(matrixBytes);
report.runner_file_sha256 = sha256(fs.readFileSync(fileURLToPath(import.meta.url)));

fs.mkdirSync(path.dirname(outPath), { recursive: true });
const canonical = `${JSON.stringify(report, null, 2)}\n`;
fs.writeFileSync(outPath, canonical);
const receipt = {
  report_path: path.relative(process.cwd(), outPath),
  report_sha256: sha256(canonical),
  matrix_file_sha256: report.matrix_file_sha256,
  runner_file_sha256: report.runner_file_sha256,
  overall: report.overall,
  launch_decision: report.launch_decision,
  test_summary: report.test_summary,
  no_effect_counters: report.no_effect_counters,
  defect_count: report.defects.length
};
const receiptPath = path.join(path.dirname(outPath), 'customer-service-harness-receipt.json');
fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt, null, 2));
if (report.defects.length > 0) process.exitCode = 1;
