// Regression: the kb-memory availability probe must recognize the Azure-native backend, NOT hard-check
// the retired GCP claude-driver SA. Before this fix, `whoami` on a pure-Azure seat (no GCP SA, Azure SP
// present) printed "service-account: MISSING" and the sunrise/pack/team paths silently degraded, even
// though reads and writes worked fine over Azure Key Vault + Blob. The migrated Developer seat hit exactly
// this false alarm. We drive `mem.mjs whoami` with NO --agent (so it returns before any network call) and
// assert the backend line reflects the credentials actually present.
//
// Hermetic: the child env is built from scratch (PATH + a throwaway empty HOME + only the case's creds),
// so it never inherits this seat's real AZURE_SP_* / ~/.gcp_claude_driver_sa.json.
import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const MEM = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "kb-memory", "mem.mjs");
const emptyHome = () => mkdtempSync(join(tmpdir(), "kb-nohome-"));

function whoami(creds) {
  // From-scratch env: no ambient Azure/GCP creds leak in.
  const env = { PATH: process.env.PATH, HOME: emptyHome(), ...creds };
  return execFileSync("node", [MEM, "whoami"], { encoding: "utf8", env });
}

test("Azure SP creds => memory backend present (the Developer-seat false-alarm case)", () => {
  const out = whoami({ AZURE_SP_CLIENT_ID: "x", AZURE_SP_CLIENT_SECRET: "y", AZURE_SP_TENANT_ID: "z" });
  assert.match(out, /memory backend: present/, "SP-equipped Azure seat must report the backend present");
  assert.doesNotMatch(out, /MISSING/, "must not false-alarm MISSING when Azure creds exist");
});

test("Container Apps managed identity => memory backend present", () => {
  const out = whoami({ IDENTITY_ENDPOINT: "http://localhost/msi", IDENTITY_HEADER: "hdr" });
  assert.match(out, /memory backend: present/, "a managed identity must count as a reachable backend");
  assert.doesNotMatch(out, /MISSING/);
});

test("no Azure creds and no GCP SA => MISSING (the genuinely-broken case still reports honestly)", () => {
  const out = whoami({}); // empty HOME, no creds at all
  assert.match(out, /memory backend: MISSING/, "with zero credentials the probe must still fail loudly");
});

test("legacy GCP SA still honored (harmless back-compat, retired path)", () => {
  const out = whoami({ GCP_CLAUDE_DRIVER_SA_JSON: '{"client_email":"x","private_key":"y"}' });
  assert.match(out, /memory backend: present/, "a still-hydrated GCP SA must not be rejected");
});
