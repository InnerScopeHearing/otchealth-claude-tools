// Regression lock: gh-app.mjs must never lose stdout to a process.exit() race.
//
// THE BUG (2026-09-02). On POSIX, Node's process.stdout is SYNCHRONOUS when it points at a file or
// a TTY but ASYNCHRONOUS when it points at a PIPE. process.exit() does not wait for a pending async
// write, so a large payload written with console.log immediately before process.exit() is truncated
// at the pipe buffer -- in practice a clean 65536 bytes.
//
// WHY IT MATTERED HERE. Agents consume this tool through pipes (`gh-app.mjs request ... | grep`).
// `... > file.json` wrote all 306506 bytes of a large PR listing while `... | wc -c` returned
// exactly 65536: a truncated PREFIX that still looks like plausible output. Counting PRs through
// the pipe reported 1 open PR on a repo that had 8, and that wrong number was used in a
// fleet-wide report before the suspiciously round byte count gave it away. JSON.parse at least
// fails loudly on a truncated document; grep-based counting fails silently.
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

test("gh-app.mjs never calls process.exit() on a path that has written to stdout", () => {
  const src = readFileSync(new URL("../gh-app.mjs", import.meta.url), "utf8");
  const lines = src.split("\n");
  const offenders = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/process\.exit\(/.test(lines[i])) continue;
    // A usage/error path that only writes to stderr is safe: nothing is pending on stdout.
    if (/console\.error\(/.test(lines[i]) && !/console\.log\(/.test(lines[i])) continue;
    // Otherwise, look back a few lines for a stdout write that this exit would race.
    const window = lines.slice(Math.max(0, i - 4), i + 1).join("\n");
    if (/console\.log\(|process\.stdout\.write\(/.test(window)) offenders.push(`${i + 1}: ${lines[i].trim()}`);
  }
  assert.deepEqual(offenders, [], `use process.exitCode instead -- process.exit() here truncates the piped write above it:\n${offenders.join("\n")}`);
});
