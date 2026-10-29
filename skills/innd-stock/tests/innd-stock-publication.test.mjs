import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { csvFromRows, verifyPublishedBytes, latestCompletedSessionDate, publishCfoCopies } from "../publication.mjs";
import { _resetCredsCacheForTests } from "../../kb-memory/s3-blob.mjs";

test("CSV keeps fixed-width rows and represents empty trade/event cells as empty fields", () => {
  const csv = csvFromRows([["Date", "Trades", "Event"], ["2026-01-02", "", ""], ["2026-01-05", 7, "News, update"]]);
  assert.equal(csv, 'Date,Trades,Event\r\n2026-01-02,,\r\n2026-01-05,7,"News, update"\r\n');
});

test("published workbook readback requires byte-for-byte equality and reports matching SHA-256", () => {
  const bytes = Buffer.from([0, 1, 255, 10]);
  const expectedHash = createHash("sha256").update(bytes).digest("hex");
  assert.deepEqual(verifyPublishedBytes(bytes, bytes, "target.xlsx"), { path: "target.xlsx", sha256: expectedHash, bytes: 4 });
  assert.throws(() => verifyPublishedBytes(bytes, Buffer.from([0, 1, 254, 10]), "target.xlsx"), /readback mismatch/);
});

test("session cutoff follows New York time across DST and excludes today's still-open bar", () => {
  assert.equal(latestCompletedSessionDate(new Date("2026-07-15T19:59:00Z")), "2026-07-14");
  assert.equal(latestCompletedSessionDate(new Date("2026-07-15T20:00:00Z")), "2026-07-15");
  assert.equal(latestCompletedSessionDate(new Date("2026-01-15T20:59:00Z")), "2026-01-14");
  assert.equal(latestCompletedSessionDate(new Date("2026-01-15T21:00:00Z")), "2026-01-15");
});

test("publisher writes workbook bytes and CSV to CFO source and text paths, then reads back each exact object", async () => {
  process.env.AWS_ACCESS_KEY_ID = "AKIAUNITTESTFAKE0000";
  process.env.AWS_SECRET_ACCESS_KEY = "unit-test-fake-secret-access-key-not-real";
  _resetCredsCacheForTests();
  const originalFetch = globalThis.fetch;
  const objects = new Map();
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const key = new URL(url).pathname;
    calls.push({ method: init.method || "GET", key });
    if ((init.method || "GET") === "PUT") {
      objects.set(key, Buffer.from(init.body));
      return new Response("", { status: 200 });
    }
    const bytes = objects.get(key);
    return bytes ? new Response(bytes, { status: 200 }) : new Response("missing", { status: 404 });
  };
  try {
    const workbook = Buffer.from([0, 1, 255, 42]);
    const verified = await publishCfoCopies(workbook, "Date,Trades\r\n2026-01-02,\r\n");
    assert.equal(verified.length, 2);
    assert.ok(calls.some(c => c.method === "PUT" && c.key.endsWith("cfo-source-docs/innd-stock/INND-daily-stock-history.xlsx")));
    assert.ok(calls.some(c => c.method === "PUT" && c.key.endsWith("cfo-source-docs/_TEXT/innd-stock/INND-daily-stock-history.xlsx.txt")));
    assert.equal(calls.filter(c => c.method === "GET").length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    _resetCredsCacheForTests();
  }
});

test("publisher fails on denied writes, missing readback, and corrupted bytes", async (t) => {
  process.env.AWS_ACCESS_KEY_ID = "AKIAUNITTESTFAKE0000";
  process.env.AWS_SECRET_ACCESS_KEY = "unit-test-fake-secret-access-key-not-real";
  const originalFetch = globalThis.fetch;
  const cases = [
    ["denied write", async () => new Response("denied", { status: 403 }), /s3 put 403/],
    ["missing readback", async (_url, init) => init.method === "PUT" ? new Response("", { status: 200 }) : new Response("missing", { status: 404 }), /publication readback missing/],
    ["corrupted readback", async (_url, init) => init.method === "PUT" ? new Response("", { status: 200 }) : new Response(Buffer.from("wrong"), { status: 200 }), /publication readback mismatch/],
  ];
  try {
    for (const [name, fakeFetch, expected] of cases) await t.test(name, async () => {
      _resetCredsCacheForTests();
      globalThis.fetch = fakeFetch;
      await assert.rejects(() => publishCfoCopies(Buffer.from("workbook"), "Date\r\n"), expected);
    });
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    _resetCredsCacheForTests();
  }
});
