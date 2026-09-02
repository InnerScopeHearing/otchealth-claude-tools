// Regression lock: gh-app.mjs must never lose stdout to a process.exit() race.
//
// THE BUG (2026-09-02). On POSIX, Node's process.stdout is SYNCHRONOUS when it points at a file or
// a TTY but ASYNCHRONOUS when it points at a PIPE. process.exit() does not wait for a pending async
// write, so a large payload written with console.log immediately before process.exit() is truncated
// at the pipe buffer -- in practice a clean 65536 bytes.
//
// WHY IT MATTERED HERE. Agents consume this tool through pipes (`gh-app.mjs request ... | grep`).
// Measured on the same large PR listing: `... > file.json` wrote 306506 bytes; `... | wc -c`
// returned exactly 65536. The pipe therefore delivered a truncated PREFIX that still looks like
// plausible output, so anything counted or grepped out of it is silently wrong and gives no
// indication that it is. JSON.parse at least fails loudly on a truncated document; grep-based
// counting does not.
//
// The first test proves the MECHANISM is real on this Node build rather than assuming it, so this
// file cannot quietly stop testing anything if the runtime's buffering behaviour changes. The
// second pins gh-app.mjs itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const BIG = 400_000;

function pipedBytes(script) {
  // `| cat` forces stdout to be a pipe rather than inheriting a file/TTY.
  return execFileSync("sh", ["-c", `node -e ${JSON.stringify(script)} | wc -c`], { encoding: "utf8" }).trim();
}

test("the failure mode is real on this runtime: console.log + process.exit() truncates a piped write", () => {
  const truncated = Number(pipedBytes(`console.log("x".repeat(${BIG})); process.exit(0);`));
  const whole = Number(pipedBytes(`console.log("x".repeat(${BIG})); process.exitCode = 0;`));
  assert.equal(whole, BIG + 1, "setting exitCode must let the full payload drain");
  assert.ok(
    truncated < whole,
    `process.exit() must be shown to truncate, otherwise this file is testing nothing. got exit()=${truncated} exitCode=${whole}`,
  );
});

test("gh-app.mjs contains no process.exit() call at all -- an absolute rule, not a per-path judgement", () => {
  // REWRITTEN after review. The first version of this test allowed process.exit() on paths it
  // judged stderr-only, and looked back four lines for a stdout write to decide. Both halves were
  // weak: the judgement is only as good as the window (a stdout write five lines up, or one behind
  // a helper call, is invisible to it), and permitting ANY exception is what let the rule rot in
  // the first place -- the source comment claimed every exit used exitCode while three argument
  // guards still called process.exit(2).
  //
  // So the invariant is now total: zero call sites. That is checkable exactly rather than
  // heuristically, and it means a future stdout write cannot be added above a surviving exit(),
  // because there is no surviving exit(). The cost is one structural change in gh-app.mjs -- the
  // dispatch is a function so its argument guards can `return` -- and that is the whole reason it
  // is one.
  const src = readFileSync(new URL("../gh-app.mjs", import.meta.url), "utf8");
  const offenders = [];
  src.split("\n").forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, ""); // prose in comments may name process.exit(); code may not call it
    if (/process\.exit\s*\(/.test(code)) offenders.push(`${i + 1}: ${line.trim()}`);
  });
  assert.deepEqual(
    offenders,
    [],
    `gh-app.mjs must use process.exitCode (plus \`return\` where execution has to stop). Found:\n${offenders.join("\n")}`,
  );
});
