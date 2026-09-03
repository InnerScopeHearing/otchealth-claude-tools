// Wiring gate for decision-clock's pg-state (RDS Postgres) agent-state backend
// (skills/kb-memory/pg-state.mjs), which sat built-but-unconnected since PR #437 (2026-08-16) until
// 2026-09-03. Two things pinned here, with a fake backend so nothing here ever touches a real Postgres
// connection or needs AWS credentials:
//
//   1. cosmos-client.mjs really delegates its CRUD surface (isConfigured/readDoc/replaceDoc/upsertDoc/
//      queryDocs) to whatever backend is currently swapped in, and still refuses an out-of-allowlist
//      container BEFORE ever reaching that backend.
//   2. decision.mjs's runSweep() -- the scheduled job's ONLY entrypoint (job/decision-clock-sweep.sh
//      runs exactly `node decision.mjs sweep --dispatch`, nothing else) -- actually persists (the
//      terminal_policy=proceed auto-close write) and dispatches (fleet-dispatch) when the backend
//      reports configured, and FAILS LOUD (a non-zero exit code) rather than silently succeeding when
//      it does not. This is the live incident this file guards against: signal-radar's identical bug
//      ran unnoticed for days because "unconfigured" and "nothing to do" printed the same shape of
//      output and both exited 0.
//
// Every test that exercises a fail-loud path saves + restores process.exitCode around itself:
// process.exitCode is a process-global, and leaving it at 1 would poison node --test's own final exit
// code for the WHOLE run (every other test file included), not just this one assertion.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as cosmosClient from "../skills/decision-clock/cosmos-client.mjs";
import { runSweep } from "../skills/decision-clock/decision.mjs";

/** A fake pg-state.mjs: the same six-function shape cosmos-client.mjs delegates to
 *  (isConfigured/createDoc/readDoc/replaceDoc/upsertDoc/queryDocs), plus newId. Every real-network call
 *  path pg-state.mjs would take (SSM secret resolution, a TCP/TLS connection to RDS) is absent by
 *  construction -- this object never touches the network. */
function fakeBackend(overrides = {}) {
  return {
    isConfigured: async () => true,
    createDoc: async () => { throw new Error("not implemented in this fake"); },
    readDoc: async () => null,
    replaceDoc: async () => ({ status: 200, ok: true, body: null, etag: null }),
    upsertDoc: async () => ({ status: 200, ok: true, body: null, etag: null }),
    queryDocs: async () => [],
    newId: (p) => `${p}_fake`,
    ...overrides,
  };
}

// ------------------------------------------------ cosmos-client.mjs delegation ------------------------------------------------

test("cosmos-client.mjs: isConfigured() reflects the swapped backend, not a real connection", async () => {
  cosmosClient._setBackendForTests(fakeBackend({ isConfigured: async () => false }));
  try {
    assert.equal(await cosmosClient.isConfigured(), false);
  } finally {
    cosmosClient._resetBackendForTests();
  }
});

test("cosmos-client.mjs: readDoc/replaceDoc/upsertDoc/queryDocs delegate to the swapped backend with the exact same arguments", async () => {
  const calls = [];
  const fake = fakeBackend({
    readDoc: async (coll, pk, id) => { calls.push(["readDoc", coll, pk, id]); return { doc: { id, status: "open" }, etag: '"e1"' }; },
    replaceDoc: async (coll, pk, id, doc, ifMatch) => { calls.push(["replaceDoc", coll, pk, id, doc, ifMatch]); return { status: 200, ok: true, body: doc, etag: '"e2"' }; },
    upsertDoc: async (coll, pk, doc) => { calls.push(["upsertDoc", coll, pk, doc]); return { status: 200, ok: true, body: doc, etag: '"e3"' }; },
    queryDocs: async (coll, query, params, opts) => { calls.push(["queryDocs", coll, query, params, opts]); return [{ id: "dec_1" }]; },
  });
  cosmosClient._setBackendForTests(fake);
  try {
    const read = await cosmosClient.readDoc("decisions_pending", "cto", "dec_1");
    assert.deepEqual(read, { doc: { id: "dec_1", status: "open" }, etag: '"e1"' });

    await cosmosClient.replaceDoc("decisions_pending", "cto", "dec_1", { status: "closed" }, '"e1"');
    await cosmosClient.upsertDoc("decisions_pending", "clo", { id: "dec_2" });
    const rows = await cosmosClient.queryDocs("decisions_pending", "SELECT * FROM c", [], { max: 2000 });

    assert.deepEqual(rows, [{ id: "dec_1" }]);
    assert.deepEqual(calls[0], ["readDoc", "decisions_pending", "cto", "dec_1"]);
    assert.equal(calls[1][0], "replaceDoc");
    assert.equal(calls[1][3], "dec_1");
    assert.equal(calls[1][5], '"e1"');
    assert.equal(calls[2][0], "upsertDoc");
    assert.deepEqual(calls[2][3], { id: "dec_2" });
    assert.equal(calls[3][0], "queryDocs");
    assert.deepEqual(calls[3][4], { max: 2000 });
  } finally {
    cosmosClient._resetBackendForTests();
  }
});

test("cosmos-client.mjs: a container outside the decisions_pending allowlist is refused BEFORE reaching the backend", async () => {
  let backendCalled = false;
  cosmosClient._setBackendForTests(fakeBackend({ queryDocs: async () => { backendCalled = true; return []; } }));
  try {
    await assert.rejects(() => cosmosClient.queryDocs("signals", "SELECT * FROM c"), /unknown container/);
    assert.equal(backendCalled, false, "the backend must never see a disallowed container name");
  } finally {
    cosmosClient._resetBackendForTests();
  }
});

// ------------------------------------------------ decision.mjs runSweep() ------------------------------------------------

test("runSweep(): agent-state store NOT configured -> fails loud (non-zero exit code), never a silent dry-run success", async () => {
  const savedExitCode = process.exitCode;
  try {
    const dispatchCalls = [];
    const result = await runSweep({
      io: fakeBackend({ isConfigured: async () => false }),
      dispatch: async (owner, msg) => dispatchCalls.push([owner, msg]),
      dispatching: true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "not-configured");
    assert.equal(process.exitCode, 1, "an unconfigured agent-state store must set a non-zero exit code");
    assert.equal(dispatchCalls.length, 0, "nothing can be dispatched when nothing could be read");
  } finally {
    process.exitCode = savedExitCode;
  }
});

test("runSweep(): agent-state store UNREACHABLE (configured, but the real query throws) propagates -- never swallowed into a false success", async () => {
  const savedExitCode = process.exitCode;
  try {
    await assert.rejects(
      () => runSweep({ io: fakeBackend({ isConfigured: async () => true, queryDocs: async () => { throw new Error("connection refused"); } }) }),
      /connection refused/,
    );
  } finally {
    process.exitCode = savedExitCode;
  }
});

test("runSweep(): agent-state store configured -> persist (terminal_policy=proceed auto-close write) and dispatch BOTH actually happen", async () => {
  const savedExitCode = process.exitCode;
  try {
    const nowMs = Date.now();
    const overdueBy10Days = new Date(nowMs - 10 * 86400000).toISOString(); // near-due nudge, not terminal
    const overdueBy20Days = new Date(nowMs - 20 * 86400000).toISOString(); // past the terminal threshold (nearDueDays*3 = 6d)

    const rowNudge = { id: "dec_overdue_1", owner: "cto", category: "matt-gate", status: "open", expected_by: overdueBy10Days, text: "rotate the thing" };
    const rowAutoClose = { id: "dec_overdue_2", owner: "cfo", category: "rotate-secret", status: "open", expected_by: overdueBy20Days, text: "old row", terminal_policy: "proceed" };

    const readDocCalls = [];
    const replaceCalls = [];
    const dispatchCalls = [];

    const io = fakeBackend({
      isConfigured: async () => true,
      queryDocs: async () => [rowNudge, rowAutoClose],
      readDoc: async (coll, pk, id) => {
        readDocCalls.push({ coll, pk, id });
        return { doc: id === "dec_overdue_2" ? rowAutoClose : rowNudge, etag: '"row-etag"' };
      },
      replaceDoc: async (coll, pk, id, doc, ifMatch) => {
        replaceCalls.push({ coll, pk, id, doc, ifMatch });
        return { status: 200, ok: true, body: doc, etag: '"new-etag"' };
      },
    });
    const dispatch = async (owner, message) => { dispatchCalls.push({ owner, message }); };

    const result = await runSweep({ io, dispatch, dispatching: true });

    assert.equal(result.ok, true, "a fully successful sweep must report ok:true");
    assert.notEqual(process.exitCode, 1, "a fully successful sweep must not fail loud");

    // PERSIST really happened: the terminal_policy=proceed row was actually read and written closed,
    // not merely classified in memory.
    assert.equal(readDocCalls.length, 1);
    assert.equal(readDocCalls[0].id, "dec_overdue_2");
    assert.equal(replaceCalls.length, 1, "the auto-close write must actually reach the backend");
    assert.equal(replaceCalls[0].id, "dec_overdue_2");
    assert.equal(replaceCalls[0].doc.status, "closed");
    assert.equal(replaceCalls[0].ifMatch, '"row-etag"');
    assert.deepEqual(result.autoClosed, ["dec_overdue_2"]);

    // DISPATCH really happened: the overdue-but-not-terminal row produced exactly one nudge to its
    // owner's inbox, carrying its own text.
    assert.equal(dispatchCalls.length, 1, "the overdue row's owner must actually receive a dispatch call");
    assert.deepEqual(result.dispatchedOwners, ["cto"]);
    assert.equal(dispatchCalls[0].owner, "cto");
    assert.match(dispatchCalls[0].message, /rotate the thing/);
  } finally {
    process.exitCode = savedExitCode;
  }
});
