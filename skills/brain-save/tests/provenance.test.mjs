import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify, yamlQuote, buildHeader, buildObject, parseHeader, splitObject, contentSha256, brainIdFor, identityFor, keyFor, sourceIdentity, HEADER_FIELDS, KIND3, KNOWLEDGE_PREFIX, META_PREFIX } from "../lib/provenance.mjs";
import { SKIP_PREFIXES, isSkippedPath, selectPushRows, parsePrefixList } from "../../doc-indexer/push-rules.mjs";

test("yamlQuote escapes backslash first, then quotes, and removes newlines", () => {
  assert.equal(yamlQuote('a\\b "c"\nd'), '"a\\\\b \\"c\\" d"');
});

test("header round-trips through parseHeader/splitObject and carries every field", () => {
  const f = { brain_id: "KN-RES-0123456789", version: "2", title: 'Title with "quotes" and \\ slash', kind: "research", app: "hey-millie", source: "repo@abc:docs/x.md", artifact_url: "", author_agent: "cto", session: "s1", doc_date: "2026-09-26", saved_at: "2026-09-29T01:02:03Z", content_sha256: "f".repeat(64), supersedes: "", ring: "commons", ring_warnings: "mentions-mnpi-vocabulary", ring_override: "", tags: "a,b", saved_by: "brain-save 1" };
  const header = buildHeader(f);
  for (const k of HEADER_FIELDS) assert.match(header, new RegExp(`^${k}: "`, "m"), k);
  assert.match(header, /^# Title with "quotes" and \\ slash$/m);
  assert.match(header, /^> Company brain doc KN-RES-0123456789 v2 \(research, hey-millie\), saved 2026-09-29 by cto from repo@abc:docs\/x\.md\.$/m);
  const obj = buildObject(header, "# Body\n\ntext\n");
  const parsed = parseHeader(obj);
  assert.equal(parsed.title, f.title);
  assert.equal(parsed.brain_id, f.brain_id);
  const { fields, body } = splitObject(obj);
  assert.equal(fields.version, "2");
  assert.equal(body, "# Body\n\ntext\n");
});

test("content_sha256 excludes the header and is deterministic", () => {
  const body = "same body\n";
  assert.equal(contentSha256(body), contentSha256(body));
  const h1 = buildHeader({ brain_id: "KN-DOC-a", version: "1", title: "t", kind: "doc", app: "fleet", saved_at: "2026-01-01T00:00:00Z" });
  const h2 = buildHeader({ brain_id: "KN-DOC-a", version: "9", title: "t", kind: "doc", app: "fleet", saved_at: "2027-01-01T00:00:00Z" });
  assert.notEqual(buildObject(h1, body), buildObject(h2, body));
  assert.equal(contentSha256(body), contentSha256(splitObject(buildObject(h2, body)).body));
});

test("brain_id format and identity rules (--id > repo path > artifact url > kind/app/slug)", () => {
  assert.match(brainIdFor("research", "x"), /^KN-RES-[0-9a-f]{10}$/);
  for (const [k, c] of Object.entries(KIND3)) assert.match(brainIdFor(k, "x"), new RegExp(`^KN-${c}-`));
  assert.equal(identityFor({ id: "stable", source: "r@1:p" }), "id:stable");
  assert.equal(identityFor({ source: "otchealth-cto@8c1d2e3+dirty:runbooks/a.md", artifactUrl: "https://claude.ai/artifact/x" }), "otchealth-cto:runbooks/a.md");
  assert.equal(identityFor({ artifactUrl: "https://claude.ai/artifact/abc?x=1#y", kind: "artifact", app: "fleet", slug: "s" }), "https://claude.ai/artifact/abc");
  assert.equal(identityFor({ kind: "doc", app: "fleet", slug: "s" }), "doc/fleet/s");
  // same repo path, different commit or title -> same identity -> same brain_id (supersede, not duplicate)
  assert.equal(brainIdFor("runbook", identityFor({ source: "otchealth-cto@aaa:runbooks/a.md" })), brainIdFor("runbook", identityFor({ source: "otchealth-cto@bbb:runbooks/a.md" })));
  assert.equal(sourceIdentity("https://x.org/a/?q=1"), "https://x.org/a");
});

test("slug rules: lowercase ascii, collapsed dashes, <= 60 at a word boundary", () => {
  assert.equal(slugify("Hey Millie: Visual Craft -- Research!"), "hey-millie-visual-craft-research");
  assert.equal(slugify("Café déjà vu"), "cafe-deja-vu");
  const long = slugify("one two three four five six seven eight nine ten eleven twelve thirteen fourteen");
  assert.ok(long.length <= 60 && !long.endsWith("-"), long);
  assert.equal(slugify("!!!"), "untitled");
});

test("key format", () => {
  assert.equal(keyFor({ kind: "research", app: "hey-millie", date: "2026-09-26", slug: "s", contentSha: "a1b2c3d4ffff" }), "_KNOWLEDGE/research/hey-millie/2026-09-26-s-a1b2c3d4.md");
});

test("prefix safety: _KNOWLEDGE/ is never skipped by the indexer; _KNOWLEDGE-META/ always is; neither prefixes the other", () => {
  assert.ok(!SKIP_PREFIXES.some((p) => KNOWLEDGE_PREFIX.startsWith(p) || p.startsWith(KNOWLEDGE_PREFIX)), "no SKIP_PREFIXES entry may cover _KNOWLEDGE/");
  assert.ok(SKIP_PREFIXES.includes(META_PREFIX));
  assert.ok(!META_PREFIX.startsWith(KNOWLEDGE_PREFIX) && !KNOWLEDGE_PREFIX.startsWith(META_PREFIX));
  assert.equal(isSkippedPath("_KNOWLEDGE/research/x.md"), false);
  assert.equal(isSkippedPath("_KNOWLEDGE-META/src/x.html"), true);
  for (const p of ["_MEMORY/", "_HANDOFF/", "_DISPATCH/", "_ARCHIVE/", "_TEXT/", "_CATALOG/"]) assert.ok(SKIP_PREFIXES.includes(p), p);
});

test("selectPushRows: prefix filtering, multiple prefixes, empty allow-list selects NOTHING, null = legacy", () => {
  const rows = ["_KNOWLEDGE/a.md", "_DAILY/2026-09-01.md", "_JOURNAL/cfo/x/_DIGEST.md", "_RESEARCH/r.md", "_KNOWLEDGE-META/src/a.html", "_MEMORY/x.jsonl"].map((path) => ({ path }));
  assert.deepEqual(selectPushRows(rows, ["_KNOWLEDGE/"]).map((r) => r.path), ["_KNOWLEDGE/a.md"]);
  assert.deepEqual(selectPushRows(rows, "_KNOWLEDGE/,_DAILY/").map((r) => r.path), ["_KNOWLEDGE/a.md", "_DAILY/2026-09-01.md"]);
  assert.deepEqual(selectPushRows(rows, []), []);
  assert.deepEqual(selectPushRows(rows, ""), []);
  // (round 2) the privileged lanes' journals (_JOURNAL/cfo/ ...) are SKIP_PREFIXES now: never pushed, scoped or not.
  assert.deepEqual(selectPushRows(rows, null).map((r) => r.path), ["_KNOWLEDGE/a.md", "_DAILY/2026-09-01.md", "_RESEARCH/r.md"], "legacy unscoped still never includes SKIP_PREFIXES rows");
  assert.deepEqual(selectPushRows(rows, ["_JOURNAL/"]).map((r) => r.path), [], "a _JOURNAL/ scope still never reaches a privileged lane");
  assert.deepEqual(parsePrefixList(" a/ , ,b/ "), ["a/", "b/"]);
});
