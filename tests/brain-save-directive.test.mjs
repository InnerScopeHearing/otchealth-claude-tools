// Regression lock for Matt's 2026-09-29 directive ("all research and any other documents ... are saved
// in the brains and searchable"). A standing rule lives only as long as nobody silently edits it away,
// so this pins: the CLAUDE.md standing-rules bullet + its command, the fleet bulletin line, the
// Developer agent's section, the user-scope Stop-hook reminder registration, and the nightly push gate
// (every commons push-search is allow-listed; SKIP_PUSH_SEARCH=1 still skips).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const CMD = "node /tmp/octools/skills/brain-save/brain-save.mjs put";

test("CLAUDE.md standing rules carry the brain-save directive and its one command", () => {
  const s = read("CLAUDE.md");
  const start = s.indexOf("## Standing rules");
  assert.ok(start >= 0);
  const rules = s.slice(start, s.indexOf("\n## ", start + 5));
  assert.match(rules, /\*\*Every document goes into the brain, proven searchable \(Matt directive 2026-09-29\)\.\*\*/);
  assert.ok(rules.replace(/\s+/g, " ").includes(CMD), "the exact command must be in the rule");
  assert.match(rules, /only\s+exit 0 means saved/);
  assert.match(rules, /Never work around a refusal with a raw S3 write/);
});

test("FLEET-BULLETIN.md announces brain-save", () => {
  assert.match(read("FLEET-BULLETIN.md"), /^- \d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z \| brain-save \(new, Matt directive 2026-09-29\)/m);
});

test("dream-team: Developer has the section; ring agents get the ring-aware variant, never the commons command alone", () => {
  assert.match(read("dream-team/agents/developer.md"), /## Save what you make to the brain \(Matt directive 2026-09-29\)/);
  for (const a of ["architect", "builder", "qa", "release-captain", "creative", "growth", "growth-exposure", "commerce", "digital-products", "cro", "compliance-officer", "coach", "lifecycle"]) {
    assert.match(read(`dream-team/agents/${a}.md`), /Save documents to the brain \(Matt directive 2026-09-29\)/, a);
  }
  for (const a of ["clo", "finance-ops", "capital"]) {
    const s = read(`dream-team/agents/${a}.md`);
    assert.match(s, /Save documents to the brain, in YOUR ring/, a);
    assert.match(s, /never goes to brain-save/, a);
  }
});

test("install-octools-hook registers the brain-save Stop reminder exactly once (idempotent)", () => {
  const home = mkdtempSync(join(tmpdir(), "bs-home-"));
  try {
    const env = { ...process.env, HOME: home };
    execFileSync(process.execPath, [join(ROOT, "setup", "install-octools-hook.mjs")], { env, stdio: "ignore" });
    execFileSync(process.execPath, [join(ROOT, "setup", "install-octools-hook.mjs")], { env, stdio: "ignore" });
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    const stop = JSON.stringify(settings.hooks.Stop);
    assert.equal(stop.split("brain-save/hooks/unsaved-reminder.mjs").length - 1, 2, "one entry (the path appears twice in its guarded command)");
    assert.match(stop, /\|\| true/, "guarded + fail-open");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("nightly.sh: every commons push-search is allow-listed (--prefixes + --require-live-object); SKIP_PUSH_SEARCH=1 still skips; unset prefixes skip", () => {
  const s = read("skills/doc-indexer/job/nightly.sh");
  const live = s.split("\n").filter((l) => !/^\s*#/.test(l));
  const pushes = live.filter((l) => /indexer\.mjs["'\s]+push-search/.test(l));
  assert.equal(pushes.length, 1);
  assert.match(pushes[0], /--prefixes "\$COMMONS_PUSH_PREFIXES"/);
  assert.match(pushes[0], /--require-live-object/);
  const body = live.join("\n");
  assert.match(body, /if \[ "\$SKIP_PUSH_SEARCH" = "1" \]; then\s*\n\s*echo[^\n]*skipping/);
  assert.match(body, /elif \[ -z "\$COMMONS_PUSH_PREFIXES" \]; then\s*\n\s*echo[^\n]*skipping/);
  const ifAt = body.indexOf('if [ "$SKIP_PUSH_SEARCH" = "1" ]');
  const pushAt = body.indexOf(pushes[0]);
  const fiAt = body.indexOf("\nfi", pushAt);
  assert.ok(ifAt >= 0 && ifAt < pushAt && pushAt < fiAt, "the push must sit inside the gate");
});
