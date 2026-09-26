import { test } from "node:test";
import assert from "node:assert/strict";
import { beforeSend } from "../skills/telemetry-wiring/templates/sentry-beforeSend.ts";

test("beforeSend drops an event when scrubbing throws", () => {
  const marker = "SYNTHETIC_SECRET_MARKER SYNTHETIC_PHI_MARKER";
  const event = {};
  Object.defineProperty(event, "extra", {
    enumerable: true,
    get() {
      throw new Error(marker);
    },
  });

  assert.equal(beforeSend(event), null);
});

test("beforeSend preserves existing redaction for normal events", () => {
  const event = {
    request: { cookies: { session: "SYNTHETIC_COOKIE" } },
    user: {
      email: "synthetic@example.invalid",
      ip_address: "192.0.2.10",
      username: "SYNTHETIC_USER",
    },
    extra: {
      mrn: "SYNTHETIC_PHI_MARKER",
      message: "contact synthetic@example.invalid with token sk-SYNTHETIC_SECRET_MARKER",
    },
  };

  const result = beforeSend(event);
  assert.ok(result);
  assert.equal(result.request.cookies, undefined);
  assert.equal(result.user.email, undefined);
  assert.equal(result.user.ip_address, undefined);
  assert.equal(result.user.username, undefined);
  assert.equal(result.extra.mrn, "[phi]");
  assert.equal(result.extra.message, "contact [email] with token [redacted]");

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("SYNTHETIC_PHI_MARKER"), false);
  assert.equal(serialized.includes("SYNTHETIC_SECRET_MARKER"), false);
});
