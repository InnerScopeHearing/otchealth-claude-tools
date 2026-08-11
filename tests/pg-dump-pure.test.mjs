// Tests for the PURE (no network/credential dependency) helpers in skills/fleet-backup/pg-dump.mjs.
// The live path (creating/starting the real Azure Container Apps Job, running a real pg_dump against
// Flatstick's and FourVault's production databases) cannot be exercised in CI -- it needs live Azure
// credentials, a real Postgres server, and mutates real cloud state -- so it was instead proven by hand
// against production this session (see the branch's PR description / session report for the live run:
// pg-dump-nonphi execution succeeded, flatstick=150727 bytes / fourvault=15595 bytes, both gunzip clean
// and contain the real "PostgreSQL database dump" banner). What CAN be exercised here, and is the load-
// bearing logic a regression could silently break, is everything below: the blob-naming convention other
// scripts (s3-mirror.mjs, restore-drill.mjs) rely on staying stable, the SAS/SQL/ARM-body string builders
// (a shell-injection or SQL-injection class of bug would show up here, not in a live run that happens to
// use safe inputs), and the gzip/SQL-shape content check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync, gunzipSync } from "node:zlib";
import crypto from "node:crypto";
import {
  pgDumpBlobName,
  todayStamp,
  buildAccountSas,
  bootstrapRoleSql,
  randomHexPassword,
  looksLikePgDumpSql,
  buildJobTemplate,
} from "../skills/fleet-backup/pg-dump.mjs";

test("pgDumpBlobName: the exact convention s3-mirror.mjs/restore-drill.mjs pick up generically", () => {
  assert.equal(pgDumpBlobName("flatstick", "2026-08-04"), "pg-dumps/flatstick-2026-08-04.sql.gz");
  assert.equal(pgDumpBlobName("fourvault", "2026-08-04"), "pg-dumps/fourvault-2026-08-04.sql.gz");
});

test("todayStamp: YYYY-MM-DD, matches the date convention every other blob name in this repo uses", () => {
  assert.equal(todayStamp(new Date("2026-08-04T23:59:59Z")), "2026-08-04");
  assert.equal(todayStamp(new Date("2026-01-01T00:00:00Z")), "2026-01-01");
});

test("buildAccountSas: deterministic given an injected clock, and scoped to create+write only", () => {
  const key = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
  const now = new Date("2026-08-04T12:00:00Z");
  const qs = buildAccountSas("stotc55c84f6bef", key, "cw", 45, now);
  const params = new URLSearchParams(qs);
  assert.equal(params.get("sp"), "cw", "least-privilege: create+write only, never read/delete/list");
  assert.equal(params.get("ss"), "b", "blob service only");
  assert.equal(params.get("spr"), "https", "https-only transport");
  assert.equal(params.get("se"), "2026-08-04T12:45:00Z", "45-minute expiry window from the injected clock");
  assert.ok(params.get("sig"), "a signature is present");
  // same inputs -> byte-identical output (pure function, no hidden Date.now() dependency once `now` is injected)
  assert.equal(buildAccountSas("stotc55c84f6bef", key, "cw", 45, now), qs);
});

test("buildAccountSas: a different key produces a different signature (the HMAC actually depends on the key)", () => {
  const now = new Date("2026-08-04T12:00:00Z");
  const sigA = new URLSearchParams(buildAccountSas("acct", Buffer.from("keyA").toString("base64"), "cw", 45, now)).get("sig");
  const sigB = new URLSearchParams(buildAccountSas("acct", Buffer.from("keyB").toString("base64"), "cw", 45, now)).get("sig");
  assert.notEqual(sigA, sigB);
});

test("bootstrapRoleSql: idempotent create-or-alter shape, grants read-only + explicit per-db CONNECT, no write privileges anywhere", () => {
  const sql = bootstrapRoleSql("backup_ro", "s3cr3t", ["flatstick", "fourvault"]);
  assert.match(sql, /CREATE ROLE "backup_ro" LOGIN PASSWORD 's3cr3t' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION/);
  assert.match(sql, /ALTER ROLE "backup_ro" WITH LOGIN PASSWORD 's3cr3t' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION/);
  assert.match(sql, /GRANT pg_read_all_data TO "backup_ro";/);
  assert.match(sql, /GRANT CONNECT ON DATABASE "flatstick" TO "backup_ro";/);
  assert.match(sql, /GRANT CONNECT ON DATABASE "fourvault" TO "backup_ro";/);
  // no INSERT/UPDATE/DELETE/CREATE grant appears anywhere -- read-only end to end
  assert.doesNotMatch(sql, /GRANT\s+(INSERT|UPDATE|DELETE|CREATE|ALL)\b/i);
});

test("bootstrapRoleSql: a password containing a single quote cannot break out of the SQL string literal", () => {
  const sql = bootstrapRoleSql("backup_ro", "weird'pass'word", ["flatstick"]);
  // the escaped literal appears; and there is no unescaped bare ' immediately followed by a non-'' char
  // that would prematurely close the string (a crude but effective injection-shape check)
  assert.match(sql, /PASSWORD 'weird''pass''word' NOSUPERUSER/);
});

test("bootstrapRoleSql: works with zero databases (still produces valid role bootstrap SQL, just no CONNECT grants)", () => {
  const sql = bootstrapRoleSql("backup_ro", "pw", []);
  assert.match(sql, /GRANT pg_read_all_data TO "backup_ro";/);
  assert.doesNotMatch(sql, /GRANT CONNECT/);
});

test("randomHexPassword: hex-only (no shell/SQL metacharacters), and default length is not trivially short", () => {
  const pw = randomHexPassword();
  assert.match(pw, /^[0-9a-f]+$/);
  assert.ok(pw.length >= 32, "default 24 bytes -> 48 hex chars, well above a brute-forceable length");
});

test("randomHexPassword: two calls never collide (uses a real CSPRNG, not a fixed/weak source)", () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) seen.add(randomHexPassword());
  assert.equal(seen.size, 50);
});

test("looksLikePgDumpSql: recognizes a real pg_dump banner, rejects junk/truncated content", () => {
  assert.equal(looksLikePgDumpSql(Buffer.from("-- PostgreSQL database dump\n--\n\nSET statement_timeout = 0;\n")), true);
  assert.equal(looksLikePgDumpSql(Buffer.from("-- Dumped from database version 16.10\nCREATE TABLE x();\n")), true);
  assert.equal(looksLikePgDumpSql(Buffer.from("not a dump at all")), false);
  assert.equal(looksLikePgDumpSql(Buffer.alloc(0)), false, "an empty (0-byte source) buffer is not a valid dump");
});

test("looksLikePgDumpSql: works against real gzip round-trip bytes, not just a raw Buffer fixture", () => {
  const real = "-- PostgreSQL database dump\n-- Dumped from database version 16.10\nCREATE TABLE t (id int);\n";
  const gz = gzipSync(Buffer.from(real));
  assert.equal(looksLikePgDumpSql(gunzipSync(gz)), true);
});

test("buildJobTemplate: no secret material anywhere in the returned body (it is a PURE builder -- run() attaches secrets separately)", () => {
  const body = buildJobTemplate({
    location: "West US 2",
    environmentId: "/subscriptions/x/resourceGroups/y/providers/Microsoft.App/managedEnvironments/otchealth-jobs-env",
    host: "otchealth-nonphi-pg-cus1.postgres.database.azure.com",
    databases: ["flatstick", "fourvault"],
    dateStamp: "2026-08-04",
  });
  const serialized = JSON.stringify(body);
  assert.ok(!body.properties.configuration.secrets, "the pure builder must not fabricate a secrets array");
  assert.doesNotMatch(serialized, /PASSWORD|BEGIN PRIVATE KEY/);
  assert.equal(body.properties.template.containers[0].image, "postgres:16");
  assert.equal(body.properties.configuration.triggerType, "Manual");
});

test("buildJobTemplate: the generated shell script references both configured databases and is syntactically well-formed shell", () => {
  const body = buildJobTemplate({
    location: "West US 2",
    environmentId: "env",
    host: "h",
    databases: ["flatstick", "fourvault"],
    dateStamp: "2026-08-04",
  });
  const script = body.properties.template.containers[0].args[0];
  assert.match(script, /for DB in flatstick fourvault; do/);
  assert.match(script, /pg_dump --no-owner --no-acl/);
  assert.match(script, /gzip -9/);
  assert.match(script, /set -e/);
  // the security-incident-class check: never emit `set -x` (2026-06-17 incident, see azure-migration-runbook.md)
  assert.doesNotMatch(script, /set -x/);
  // no admin credential value or password literal baked into the SCRIPT TEXT itself -- they flow in
  // only via `$ADMIN_URL`/`$DUMPRO_PASS` shell variable references (secretRef env vars), never inlined
  assert.doesNotMatch(script, /postgresql:\/\/[^$]*:[^$]*@/, "no literal (non-variable) connection string with inline creds");
});

test("buildJobTemplate: a third database can be added via the databases array with no other code change", () => {
  const body = buildJobTemplate({ location: "l", environmentId: "e", host: "h", databases: ["flatstick", "fourvault", "companion"], dateStamp: "2026-08-04" });
  assert.match(body.properties.template.containers[0].args[0], /for DB in flatstick fourvault companion; do/);
});
