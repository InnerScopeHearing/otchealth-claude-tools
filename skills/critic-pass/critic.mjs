// critic-pass / critic.mjs, pure dependency-free self-verification loop for deep-reasoning drafts.
//
// PROBLEM: Opus deep-reasoning calls are expensive. When one produces a draft that is subtly wrong
// (unsupported claim, missed constraint, arithmetic slip), the usual fix is "notice it later and
// re-run Opus" - the most expensive possible correction path. This module builds a CHEAP critic
// prompt (meant for a Sonnet-tier or llm_azure tier:'high' pass, not Opus) that checks the draft
// BEFORE it is committed, and parses that critic's verdict.
//
// REPORT-MODE, FAIL-SAFE BY DESIGN: this module never calls a model itself and never blocks
// anything. It only builds prompts and parses verdicts. A malformed or missing critic response
// fails safe to {verdict:"approve", malformed:true} - a broken critic pass must never brick the
// pipeline. shouldRevise() is an explicit opt-in gate the orchestrator can choose to act on (or
// simply log). The orchestrator/gateway supplies the actual model call (e.g. llm_azure
// tier:'high', or a Sonnet subagent) and feeds the raw text back into parseCriticVerdict().
//
// Pure + IO-free so it is trivially testable and safe to import anywhere.

const SEVERITY_ORDER = { low: 1, medium: 2, high: 3, critical: 4 };

/**
 * buildCriticPrompt(task, draftAnswer, opts?) -> string
 * opts: { constraints?: string[], context?: string }
 * Produces a prompt instructing a cheap critic model to check a draft against the original task,
 * looking for unsupported claims, logical gaps, missed constraints, math/factual errors, and
 * unstated assumptions. Instructs the critic to answer in STRICT JSON only.
 */
export function buildCriticPrompt(task, draftAnswer, opts = {}) {
  const t = String(task ?? "");
  const d = String(draftAnswer ?? "");
  const constraints = Array.isArray(opts.constraints) ? opts.constraints : [];
  const context = opts.context ? String(opts.context) : "";

  const constraintsBlock = constraints.length
    ? `\nKNOWN CONSTRAINTS (the draft must satisfy all of these):\n${constraints.map((c) => `- ${c}`).join("\n")}\n`
    : "";
  const contextBlock = context ? `\nADDITIONAL CONTEXT:\n${context}\n` : "";

  return [
    "You are a cheap, fast CRITIC pass reviewing a draft answer BEFORE it is committed.",
    "This is a report-mode check: your job is to catch problems early, not to rewrite the draft.",
    "",
    "ORIGINAL TASK:",
    t,
    contextBlock,
    constraintsBlock,
    "DRAFT ANSWER TO REVIEW:",
    d,
    "",
    "Check the draft for, specifically:",
    "1. Unsupported claims (assertions with no evidence, citation, or derivation in the draft)",
    "2. Logical gaps (conclusions that do not follow from the stated reasoning)",
    "3. Missed constraints (anything in the task or KNOWN CONSTRAINTS the draft ignores or violates)",
    "4. Math or factual errors (arithmetic, unit, date, or verifiable-fact mistakes)",
    "5. Unstated assumptions (the draft quietly assumes something the task never granted)",
    "",
    "Respond with STRICT JSON only, no markdown fences, no prose outside the JSON, matching exactly:",
    '{"verdict": "approve" | "revise", "issues": [{"severity": "low" | "medium" | "high" | "critical", "note": "string"}], "confidence": 0.0-1.0}',
    "",
    'If you find no material problems, respond with verdict "approve" and an empty issues array.',
    'Use verdict "revise" only when at least one issue would change the answer if fixed.',
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * parseCriticVerdict(rawModelText) -> { verdict, issues, confidence, malformed }
 * Tolerant JSON parse: strips markdown code fences, extracts the first {...} block if the model
 * added prose around it, and coerces fields defensively. Fails safe to
 * { verdict: "approve", issues: [], confidence: 0, malformed: true } on any parse failure or
 * missing/invalid verdict - a broken critic pass approves rather than blocks (report-mode).
 */
export function parseCriticVerdict(rawModelText) {
  const failSafe = () => ({ verdict: "approve", issues: [], confidence: 0, malformed: true });

  if (rawModelText == null) return failSafe();
  let text = String(rawModelText).trim();
  if (!text) return failSafe();

  // Strip ```json ... ``` or ``` ... ``` fences if present.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();

  // If there is leading/trailing prose, extract the first balanced-looking {...} block.
  if (!(text.startsWith("{") && text.endsWith("}"))) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      text = text.slice(start, end + 1);
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return failSafe();
  }

  if (!parsed || typeof parsed !== "object") return failSafe();

  const verdict = parsed.verdict === "revise" ? "revise" : parsed.verdict === "approve" ? "approve" : null;
  if (!verdict) return failSafe();

  const issuesRaw = Array.isArray(parsed.issues) ? parsed.issues : [];
  const issues = issuesRaw
    .map((it) => {
      if (!it || typeof it !== "object") return null;
      const severity = SEVERITY_ORDER[it.severity] ? it.severity : "medium";
      const note = typeof it.note === "string" ? it.note : String(it.note ?? "");
      return { severity, note };
    })
    .filter(Boolean);

  let confidence = typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence) ? parsed.confidence : 0.5;
  confidence = Math.min(1, Math.max(0, confidence));

  return { verdict, issues, confidence, malformed: false };
}

/**
 * shouldRevise(verdict, opts?) -> boolean
 * verdict: the object returned by parseCriticVerdict.
 * opts: { minSeverity?: "low" | "medium" | "high" | "critical" } (default "medium")
 * Returns true only when verdict.verdict === "revise" AND at least one issue meets or exceeds
 * minSeverity. A malformed verdict (fail-safe "approve") never triggers revise. This is an
 * advisory signal for the orchestrator - report-mode does not require acting on it.
 */
export function shouldRevise(verdict, opts = {}) {
  if (!verdict || verdict.malformed) return false;
  if (verdict.verdict !== "revise") return false;

  const minSeverity = SEVERITY_ORDER[opts.minSeverity] ? opts.minSeverity : "medium";
  const minRank = SEVERITY_ORDER[minSeverity];

  const issues = Array.isArray(verdict.issues) ? verdict.issues : [];
  if (issues.length === 0) return true; // revise verdict with no itemized issues still counts

  return issues.some((it) => (SEVERITY_ORDER[it?.severity] ?? SEVERITY_ORDER.medium) >= minRank);
}

// ---------------------------------------------------------------------------
// CLI / runner (report-mode only): builds the critic prompt and/or parses a verdict.
// This CLI does NOT call any LLM itself - it is a pure prompt-builder / verdict-parser so the
// orchestrator/gateway can supply the actual model call (e.g. llm_azure tier:'high', or a Sonnet
// subagent) and pipe the raw text back through `parse`.
//
// Usage:
//   node critic.mjs prompt --task "<task>" --draft "<draft>" [--constraints "a;b;c"] [--context "..."]
//   echo '<task>\n---\n<draft>' | node critic.mjs prompt
//   node critic.mjs parse < raw_model_output.txt
//   node critic.mjs parse --min-severity high < raw_model_output.txt
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const args = parseArgs(rest);

  if (cmd === "prompt") {
    let task = args.task;
    let draft = args.draft;
    if (!task || !draft) {
      const stdin = await readStdin();
      if (stdin && (!task || !draft)) {
        const [t, d] = stdin.split(/\n---\n/);
        task = task || t || "";
        draft = draft || d || "";
      }
    }
    const constraints = typeof args.constraints === "string" ? args.constraints.split(";").map((s) => s.trim()).filter(Boolean) : [];
    const context = typeof args.context === "string" ? args.context : "";
    const out = buildCriticPrompt(task || "", draft || "", { constraints, context });
    process.stdout.write(out + "\n");
    return;
  }

  if (cmd === "parse") {
    const raw = args.text || (await readStdin());
    const verdict = parseCriticVerdict(raw);
    const minSeverity = typeof args["min-severity"] === "string" ? args["min-severity"] : "medium";
    const revise = shouldRevise(verdict, { minSeverity });
    process.stdout.write(JSON.stringify({ ...verdict, shouldRevise: revise }, null, 2) + "\n");
    return;
  }

  process.stderr.write(
    [
      "critic-pass CLI (report-mode; does not call an LLM itself)",
      "",
      "Usage:",
      '  node critic.mjs prompt --task "<task>" --draft "<draft>" [--constraints "a;b;c"] [--context "..."]',
      "  node critic.mjs parse < raw_model_output.txt [--min-severity high]",
      "",
      "The orchestrator/gateway must supply the actual model call (e.g. llm_azure tier:'high'),",
      "then pipe the raw model text into `parse`.",
    ].join("\n") + "\n",
  );
  process.exitCode = cmd ? 1 : 0;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main();
}
