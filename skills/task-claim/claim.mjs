#!/usr/bin/env node
// claim.mjs -- CLI for skills/task-claim: a typed, cross-agent exclusive claim (mutex) primitive
// built on the gateway's existing work-ledger tools. See SKILL.md for the full design and the gap
// analysis against the cto-bridge prose mutex this is meant to be a proven replacement for.
//
// USAGE:
//   node claim.mjs acquire <resource> --agent <a> [--lane cto] [--board mutex] [--created-by <who>]
//   node claim.mjs release <task-id> --agent <a> --lease-version <n> [--lane cto] [--board mutex]
//   node claim.mjs heartbeat <task-id> --agent <a> [--lease-version <n>] [--lane cto] [--board mutex]
//   node claim.mjs status <resource> [--lane cto] [--board mutex]
//
// Every subcommand prints a JSON result to stdout and sets the process exit code so a calling script
// can branch on $? without parsing JSON if it only wants a yes/no: 0 = the operation succeeded
// (acquired / released / extended / found), 1 = it did not (refused / conflict / not found), 2 = bad
// usage. --lane selects which gateway OAuth lane authenticates the call (any lane works -- task_* is
// not role-gated server-side; --lane only changes which identity's bearer is minted, default "cto").
import { createGatewayLedger } from './gateway-ledger.mjs';
import * as mutex from './mutex.mjs';

function flag(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}

function positional() {
  // The first argv[3+] token that is not itself a flag and does not immediately follow one.
  const argv = process.argv.slice(3);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      i++; // skip its value
      continue;
    }
    return argv[i];
  }
  return undefined;
}

async function main() {
  const cmd = process.argv[2];
  const lane = flag('lane', 'cto');
  const board = flag('board', 'mutex');
  const ledger = createGatewayLedger({ lane });

  if (cmd === 'acquire') {
    const resource = positional();
    const agent = flag('agent');
    if (!resource || !agent) {
      console.error('usage: acquire <resource> --agent <a> [--lane cto] [--board mutex] [--created-by <who>]');
      process.exit(2);
    }
    const res = await mutex.acquire(ledger, { resource, agent, board, createdBy: flag('created-by', agent) });
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.acquired ? 0 : 1);
    return;
  }

  if (cmd === 'release') {
    const taskId = positional();
    const agent = flag('agent');
    const leaseVersion = flag('lease-version');
    if (!taskId || !agent || leaseVersion === undefined) {
      console.error('usage: release <task-id> --agent <a> --lease-version <n> [--lane cto] [--board mutex]');
      process.exit(2);
    }
    const res = await mutex.release(ledger, { taskId, agent, board, leaseVersion: Number(leaseVersion) });
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.released ? 0 : 1);
    return;
  }

  if (cmd === 'heartbeat') {
    const taskId = positional();
    const agent = flag('agent');
    const leaseVersion = flag('lease-version');
    if (!taskId || !agent) {
      console.error('usage: heartbeat <task-id> --agent <a> [--lease-version <n>] [--lane cto] [--board mutex]');
      process.exit(2);
    }
    const res = await mutex.heartbeat(ledger, {
      taskId,
      agent,
      board,
      leaseVersion: leaseVersion === undefined ? undefined : Number(leaseVersion),
    });
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.extended ? 0 : 1);
    return;
  }

  if (cmd === 'status') {
    const resource = positional();
    if (!resource) {
      console.error('usage: status <resource> [--lane cto] [--board mutex]');
      process.exit(2);
    }
    const res = await mutex.status(ledger, { resource, board });
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.found ? 0 : 1);
    return;
  }

  console.error('task-claim: commands = acquire <resource> | release <task-id> | heartbeat <task-id> | status <resource>');
  process.exit(2);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((e) => {
    console.error('ERR', (e && e.message) || e);
    process.exit(1);
  });
}
