// The brain-freshness blind spot (2026-09-29): a room written every night always has a newest object
// inside the SLO, so "is the newest object indexed?" never ran and the commons room read OK for the
// seven weeks its push was off. A room that declares indexPrefixes is now judged by the newest text
// object under its push allow-list that is OLDER than the SLO.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickNewestDueObject, resolveRoomIndexPrefixes, BRAIN_ROOMS } from "../skills/aws-dr-canary/canary.mjs";

const NOW = Date.parse("2026-09-29T12:00:00Z");
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();

test("picks the newest indexable object OLDER than the SLO, ignoring newer ones, other prefixes, non-text and pipeline paths", () => {
  const blobs = [
    { name: "_DAILY/2026-09-29.md", lastModified: hoursAgo(2) },          // written tonight: within SLO
    { name: "_KNOWLEDGE/research/a/2026-09-20-x-11111111.md", lastModified: hoursAgo(200) },
    { name: "_KNOWLEDGE/research/a/2026-09-26-y-22222222.md", lastModified: hoursAgo(60) }, // the due one
    { name: "_KNOWLEDGE/research/a/2026-09-29-z-33333333.md", lastModified: hoursAgo(5) },
    { name: "_KNOWLEDGE/design/a/mock.png", lastModified: hoursAgo(70) },
    { name: "_TEXT/_KNOWLEDGE/research/a/y.md.txt", lastModified: hoursAgo(55) },
    { name: "_JOURNAL/cfo/x.md", lastModified: hoursAgo(80) },
  ];
  const r = pickNewestDueObject(blobs, ["_KNOWLEDGE/"], 48, NOW);
  assert.equal(r.due.name, "_KNOWLEDGE/research/a/2026-09-26-y-22222222.md");
  assert.equal(r.newest.name, "_KNOWLEDGE/research/a/2026-09-29-z-33333333.md");
  assert.equal(r.candidates, 3);
});

test("a nightly-written room with a missing older object is caught: the due object is chosen even though a fresh one exists", () => {
  const r = pickNewestDueObject([{ name: "_DAILY/2026-09-29.md", lastModified: hoursAgo(1) }, { name: "_DAILY/2026-09-26.md", lastModified: hoursAgo(73) }], ["_KNOWLEDGE/", "_DAILY/"], 48, NOW);
  assert.equal(r.due.name, "_DAILY/2026-09-26.md", "the legacy check would have looked only at 2026-09-29 (inside the SLO) and read OK");
});

test("nothing due / nothing under the allow-list", () => {
  assert.equal(pickNewestDueObject([{ name: "_KNOWLEDGE/a.md", lastModified: hoursAgo(3) }], ["_KNOWLEDGE/"], 48, NOW).due, null);
  assert.equal(pickNewestDueObject([], ["_KNOWLEDGE/"], 48, NOW).candidates, 0);
});

test("commons declares _KNOWLEDGE/ by default; an env override widens it once the nightly push is armed; other rooms keep the legacy check", () => {
  const commons = BRAIN_ROOMS.find((r) => r.name === "commons-company-journal");
  assert.deepEqual(resolveRoomIndexPrefixes(commons), ["_KNOWLEDGE/"]);
  process.env.BRAIN_FRESHNESS_PREFIXES_COMMONS_COMPANY_JOURNAL = "_KNOWLEDGE/,_DAILY/";
  try { assert.deepEqual(resolveRoomIndexPrefixes(commons), ["_KNOWLEDGE/", "_DAILY/"]); }
  finally { delete process.env.BRAIN_FRESHNESS_PREFIXES_COMMONS_COMPANY_JOURNAL; }
  assert.equal(resolveRoomIndexPrefixes(BRAIN_ROOMS.find((r) => r.name === "commerce-commerce-source-docs")), null);
});
