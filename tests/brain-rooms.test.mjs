// Unit tests for the company-brain attorney-privilege wall. legal-personal (Matt's privileged personal
// legal room) must be reachable ONLY by the CLO with an explicit --include-personal opt-in. Every other
// path excludes it. This proves the wall without any Azure AI Search call (pure selectRooms()).
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectRooms } from "../skills/company-brain/brain.mjs";

const hasPersonal = (targets) => targets.some(t => t.room === "personal" || t.index === "legal-personal");

test("default (no flags): legal-personal is NOT in the target rooms", () => {
  const t = selectRooms({});
  assert.equal(hasPersonal(t), false);
  assert.ok(t.length > 0, "default still selects the standard non-privileged rooms");
});

test("ONLY --include-personal AND --agent clo includes legal-personal", () => {
  assert.equal(hasPersonal(selectRooms({ agent: "clo", includePersonal: true })), true);
});

test("--include-personal WITHOUT the clo agent still excludes legal-personal", () => {
  for (const agent of ["", "cto", "cfo", "commerce", "growth", "plantid"]) {
    assert.equal(hasPersonal(selectRooms({ agent, includePersonal: true })), false,
      `agent='${agent}' must never reach the privileged personal room`);
  }
});

test("the clo WITHOUT --include-personal still excludes it (explicit opt-in required)", () => {
  assert.equal(hasPersonal(selectRooms({ agent: "clo", includePersonal: false })), false);
});

test("agent match is case-insensitive (CLO == clo)", () => {
  assert.equal(hasPersonal(selectRooms({ agent: "CLO", includePersonal: true })), true);
});

test("naming 'personal' in --rooms cannot smuggle in the privileged room", () => {
  // 'personal' is not a key in ROOMS, so it is filtered out; only the clo+flag path can ever add it.
  const t = selectRooms({ rooms: "memory,personal,legal", agent: "cfo", includePersonal: false });
  assert.equal(hasPersonal(t), false);
});
