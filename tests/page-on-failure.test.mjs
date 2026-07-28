// ITEM 2.2 (Wave 2, AI-OS research-pass 2026-07-21): guards the pure helpers behind
// .github/workflows/pager-selftest.yml's self-test path. The load-bearing guarantee is that a self-test
// page (subject, PostHog event name, body) can NEVER read like a real incident page: pageSubject and
// posthogEventName must diverge by mode, and buildPageBody's self-test banner must actually be present.
// Also guards runUrl/tailFile, which were exported but previously untested.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runUrl, tailFile, pageSubject, posthogEventName, buildPageBody } from "../setup/page-on-failure.mjs";

test("pageSubject: real mode says [RED] ... failed", () => {
  assert.equal(pageSubject("Nightly Azure Canary", false), "[RED] Nightly Azure Canary failed");
});

test("pageSubject: self-test mode is unmistakably a test, never [RED] or 'failed'", () => {
  const s = pageSubject("Pager Self-Test", true);
  assert.match(s, /SELF-TEST/);
  assert.match(s, /not a real incident/);
  assert.doesNotMatch(s, /\[RED\]/);
  assert.doesNotMatch(s, /\bfailed\b/);
});

test("posthogEventName: real mode emits canary_red, self-test mode emits a distinct event", () => {
  assert.equal(posthogEventName(false), "canary_red");
  assert.equal(posthogEventName(true), "pager_selftest");
  assert.notEqual(posthogEventName(true), posthogEventName(false));
});

// 2026-07-28: severity="info" exists so a notable-but-not-an-alarm notice (e.g. azure-watchdog.mjs's
// "reachability RESTORED") is never delivered/indexed with red-alert semantics. Default severity
// ("red", i.e. omitted) must stay byte-for-byte the original behavior for every existing caller.
test("severity=info: subject/event never say RED/failed/canary_red, and default (omitted) severity is unchanged", () => {
  assert.equal(pageSubject("Azure Watchdog", false, "info"), "[INFO] Azure Watchdog");
  assert.doesNotMatch(pageSubject("Azure Watchdog", false, "info"), /\[RED\]/);
  assert.doesNotMatch(pageSubject("Azure Watchdog", false, "info"), /\bfailed\b/);
  assert.equal(posthogEventName(false, "info"), "canary_info");
  assert.notEqual(posthogEventName(false, "info"), "canary_red");
  // omitted severity (no third arg) must match explicit "red" exactly -- this is the backward-
  // compatibility guarantee every other nightly-*.yml caller relies on.
  assert.equal(pageSubject("X", false), pageSubject("X", false, "red"));
  assert.equal(posthogEventName(false), posthogEventName(false, "red"));
});

test("severity=info: buildPageBody uses the supplied message verbatim, not the hardcoded 'failed' line", () => {
  const body = buildPageBody("Azure Watchdog", "https://example/run/1", ["(no --log path supplied)"], false, "info", "reachability RESTORED at T");
  assert.match(body, /reachability RESTORED at T/);
  assert.doesNotMatch(body, /failed on the nightly schedule/);
});

test("severity=info with no message supplied falls back to a clear placeholder, never throws", () => {
  const body = buildPageBody("Azure Watchdog", "https://example/run/1", ["(no --log path supplied)"], false, "info", null);
  assert.match(body, /informational notice/);
});

test("buildPageBody: real mode has no self-test banner", () => {
  const body = buildPageBody("Nightly Azure Canary", "https://example/run/1", ["(no --log path supplied)"], false);
  assert.doesNotMatch(body, /SELF-TEST/);
  assert.match(body, /Nightly Azure Canary failed on the nightly schedule/);
});

test("buildPageBody: self-test mode prepends a loud 'not a real incident' banner", () => {
  const body = buildPageBody("Pager Self-Test", "https://example/run/1", ["(no --log path supplied)"], true);
  assert.match(body, /THIS IS A PAGER SELF-TEST/);
  assert.match(body, /No real incident occurred/);
  assert.match(body, /No action is needed/);
});

test("buildPageBody: always includes the run URL and every log section, in both modes", () => {
  const sections = ["[a.log]: line one", "[b.log]: line two"];
  for (const testMode of [false, true]) {
    const body = buildPageBody("W", "https://example/run/9", sections, testMode);
    assert.match(body, /https:\/\/example\/run\/9/);
    assert.match(body, /line one/);
    assert.match(body, /line two/);
  }
});

test("runUrl: builds the run URL from GITHUB_* env vars", () => {
  const url = runUrl({ GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "org/repo", GITHUB_RUN_ID: "123" });
  assert.equal(url, "https://github.com/org/repo/actions/runs/123");
});

test("runUrl: no GITHUB_RUN_ID (not actually in a run) returns a clear placeholder, never throws", () => {
  const url = runUrl({});
  assert.match(url, /no GITHUB_RUN_ID/);
});

test("tailFile: a missing log path degrades to a clear placeholder instead of throwing", () => {
  const out = tailFile("/tmp/this-file-does-not-exist-page-on-failure-test.log", 10);
  assert.match(out, /no log file present/);
});

test("tailFile: a null path also degrades gracefully", () => {
  assert.match(tailFile(null, 10), /no log file present/);
});
