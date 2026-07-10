#!/usr/bin/env node
// art-direct.mjs — The $10M design loop, one command. Generate N candidates
// from a brief, judge them head to head with the art-director, keep the
// winner, and (optionally) feed the winner's fix notes back into a second
// round to push it toward $10M. This is the orchestration layer over
// gen-image.mjs (generate) + art-director.mjs (curate).
//
//   generate N  →  art-director judges  →  winner  →  [refine round]  →  final
//
// Usage:
//   node art-direct.mjs --brief "heroic Blaze phoenix guarding a premium dark
//        vault, coins, cinematic rim light" \
//        --intent "FourVault splash hero (kids card-vault app), room for a login overlay" \
//        [--name fourvault-splash] [--variants 4] [--kind hero]
//        [--size 1024x1536] [--rounds 1] [--brand fourvault]
//        [--workdir /tmp/art-direct] [--dry-run]
//
// Final winner is copied to <workdir>/<name>-WINNER.png with the full report.

import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './_lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv);
const dryRun = Boolean(args['dry-run']);

const brief = args.brief || args.prompt;
const intent = args.intent || brief;
if (!brief) {
    console.error('Usage: art-direct.mjs --brief "<image brief>" --intent "<what this asset is for>" [--variants N] [--name slug] [--rounds 1]');
    process.exit(1);
}
const name = args.name || 'art-direct';
const variants = Math.max(2, parseInt(args.variants || '4', 10));
const kind = args.kind || 'hero';
const size = args.size || '1024x1536';
const rounds = Math.max(1, parseInt(args.rounds || '1', 10));
const workdir = args.workdir || join('/tmp', `art-direct-${name}`);
const brandArg = args.brand ? ['--brand', String(args.brand)] : [];

function run(script, scriptArgs) {
    return execFileSync('node', [join(HERE, script), ...scriptArgs], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024,
    });
}

// Pull the generated file paths out of gen-image.mjs's "OUTPUTS:" block.
function parseOutputs(stdout) {
    const lines = stdout.split('\n');
    const idx = lines.findIndex((l) => l.trim() === 'OUTPUTS:');
    if (idx < 0) return [];
    const out = [];
    for (let i = idx + 1; i < lines.length; i++) {
        const t = lines[i].trim();
        if (!t) break;
        if (/\.(png|jpg|jpeg|webp)$/i.test(t)) out.push(t);
        else break;
    }
    return out;
}

if (dryRun) {
    console.log(`Would run the $10M loop:`);
    console.log(`  brief:    ${brief}`);
    console.log(`  intent:   ${intent}`);
    console.log(`  variants: ${variants}  kind: ${kind}  size: ${size}  rounds: ${rounds}`);
    console.log(`  workdir:  ${workdir}`);
    console.log(`  brand:    ${args.brand || '(none)'}`);
    process.exit(0);
}

mkdirSync(workdir, { recursive: true });

let currentBrief = brief;
let finalWinner = null;
let finalReport = null;

for (let round = 1; round <= rounds; round++) {
    console.log(`\n========== ROUND ${round}/${rounds} ==========`);
    const roundSlug = `${name}-r${round}`;
    console.log(`Generating ${variants} candidates...`);
    const genOut = run('gen-image.mjs', [
        '--prompt', currentBrief,
        '--kind', kind,
        '--size', size,
        '--variants', String(variants),
        '--name', roundSlug,
        '--output', join(workdir, `${roundSlug}.png`),
        ...brandArg,
    ]);
    const candidates = parseOutputs(genOut);
    if (candidates.length < 2) {
        console.error(`Generation produced ${candidates.length} file(s); need >= 2 to judge. Aborting round.`);
        console.error(genOut.slice(-800));
        process.exit(2);
    }
    console.log(`Generated: ${candidates.map((p) => basename(p)).join(', ')}`);

    console.log(`Judging head to head...`);
    const reportPath = join(workdir, `${roundSlug}-report.json`);
    run('art-director.mjs', [
        '--images', candidates.join(','),
        '--intent', intent,
        '--out', reportPath,
        ...brandArg,
    ]);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    finalReport = report;
    const winnerPath = candidates.find((p) => basename(p) === report.winner.filename) || candidates[0];
    finalWinner = winnerPath;
    console.log(`Round ${round} winner: ${basename(winnerPath)} @ ${report.winner.ten_million_score}/100`);

    // If another round is coming, fold the winner's fix notes into the brief.
    if (round < rounds) {
        const fixes = [
            ...(report.to_make_winner_10m || []),
            ...((report.ranked?.[0]?.fixes) || []),
        ].filter(Boolean);
        if (fixes.length) {
            currentBrief = `${brief}\n\nApply these art-director fixes from the previous best result: ${fixes.join('; ')}`;
            console.log(`Refining brief with ${fixes.length} fix note(s) for the next round.`);
        }
    }
}

const finalPath = join(workdir, `${name}-WINNER.png`);
if (finalWinner && existsSync(finalWinner)) copyFileSync(finalWinner, finalPath);
writeFileSync(join(workdir, `${name}-FINAL-report.json`), JSON.stringify(finalReport, null, 2));

console.log(`\n========== DONE ==========`);
console.log(`WINNER: ${finalPath} @ ${finalReport?.winner?.ten_million_score}/100`);
console.log(`REPORT: ${join(workdir, `${name}-FINAL-report.json`)}`);
if (finalReport?.to_make_winner_10m?.length) {
    console.log('Next moves to reach $10M:');
    finalReport.to_make_winner_10m.forEach((m) => console.log('  - ' + m));
}
