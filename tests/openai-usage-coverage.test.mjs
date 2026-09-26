// Regression guard for OpenAI usage receipts: FAILS if any file under setup/ or skills/ mentions
// "api.openai.com" (a direct OpenAI network call) without also invoking recordOpenAIUsage()
// (setup/openai-usage.mjs) unless the file is explicitly named in ALLOWLIST below, with a reason.
//
// This is a FILE-LEVEL text scan, not a call-site-level AST analysis: it proves "this file, which
// talks to api.openai.com somewhere, ALSO invokes recordOpenAIUsage somewhere," not "every individual
// fetch() call in this file is instrumented." That is a real, deliberate limitation (documented in
// docs/OPENAI-COST-VISIBILITY.md too) -- a file with two OpenAI call sites where only one is
// instrumented would pass this test. It is still the right test to have: it is what caught (and now
// prevents the regression of) the actual shape this fleet's LLM callers take -- a hardcoded literal
// URL string per file, no shared HTTP client to instrument once -- and a full AST-based call-graph
// analysis is a much larger investment for a marginal gain here.
//
// A file is skipped by ALLOWLIST only when its direct OpenAI call has no numeric provider `usage`
// values this receipt path can capture; see each entry's `reason` for the precise case. Every allowlist
// entry is a name-and-reason pair, not a wildcard glob, so
// adding a new file that legitimately needs an exception is a deliberate, reviewable, one-line change.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_DIRS = ["setup", "skills"];

const ALLOWLIST = {
  "skills/recall-evals/mine-cases.mjs":
    "its OpenAI chat call routes through the shared, instrumented setup/model-routing.mjs " +
    "fetchOpenAIWithFlexRetry() (caller label 'recall-evals-mine-cases' is already passed there); " +
    "this file's own 'api.openai.com' text is a doc comment describing that fact, not a call site.",
  "skills/recall-evals/mine-hard-negatives.mjs":
    "same reasoning as mine-cases.mjs: its OpenAI chat call routes through the shared, instrumented " +
    "setup/model-routing.mjs fetchOpenAIWithFlexRetry(); the literal string here is a doc comment.",
  "skills/designer/scripts/_openai.mjs":
    "Sora video HTTP responses do not include numeric values in a provider `usage` object, so this " +
    "usage receipt path intentionally does not record them. It does not estimate or record per-second dollars.",
  "skills/designer/scripts/healthcheck.mjs":
    "its only 'api.openai.com' call is `GET /v1/models` (a credential health probe) -- no `usage` " +
    "object, not a billable request.",
};

function listMjsFiles(absDir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(absDir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const abs = join(absDir, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...listMjsFiles(abs));
    } else if (st.isFile() && name.endsWith(".mjs") && !name.endsWith(".test.mjs") && name !== "selftest.mjs") {
      out.push(abs);
    }
  }
  return out;
}

const candidateFiles = SCAN_DIRS.flatMap((d) => listMjsFiles(join(ROOT, d)));
const scannedPaths = new Set(candidateFiles.map((abs) => relative(ROOT, abs).split(sep).join("/")));
const GPT_IMAGE_RECEIPT_PATHS = [
  "skills/designer/scripts/gen-image.mjs",
  "skills/designer/scripts/gen-app-icon-family.mjs",
  "skills/designer/scripts/gen-icon-batch.mjs",
];

// This small source lexer skips comments and literals and excludes named function declarations.
// It is intentionally narrower than a full JavaScript parser or call-graph analysis.
const REGEX_PREFIX_KEYWORDS = new Set([
  "await", "case", "delete", "do", "else", "in", "instanceof", "new", "of", "return",
  "throw", "typeof", "void", "yield",
]);
const CONTROL_PAREN_KEYWORDS = new Set(["catch", "for", "if", "switch", "while", "with"]);
const REGEX_PREFIX_PUNCTUATORS = new Set([
  "(", "[", "{", ",", ":", ";", "=", "!", "?", "&", "|", "+", "-", "*", "%", "^", "~", "<", ">",
]);
const METHOD_PREFIXES = new Set(["{", ",", "}", ";", "async", "static", "get", "set", "*", "#"]);

function isIdentifierStart(char) {
  return char !== undefined && /[A-Za-z_$]/.test(char);
}

function isIdentifierPart(char) {
  return char !== undefined && /[A-Za-z0-9_$]/.test(char);
}

function skipQuotedLiteral(source, start, quote) {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === quote) return index + 1;
    index += 1;
  }
  return index;
}

function skipRegexLiteral(source, start) {
  let index = start + 1;
  let inCharacterClass = false;
  while (index < source.length) {
    const char = source[index];
    if (char === "\n" || char === "\r" || char === "\u2028" || char === "\u2029") return start + 1;
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "[" && !inCharacterClass) inCharacterClass = true;
    else if (char === "]" && inCharacterClass) inCharacterClass = false;
    else if (char === "/" && !inCharacterClass) {
      index += 1;
      while (isIdentifierPart(source[index])) index += 1;
      return index;
    }
    index += 1;
  }
  return start + 1;
}

function isControlParenClose(tokens, closeParenIndex) {
  let depth = 0;
  for (let index = closeParenIndex; index >= 0; index -= 1) {
    if (tokens[index].value === ")") depth += 1;
    else if (tokens[index].value === "(") {
      depth -= 1;
      if (depth === 0) return CONTROL_PAREN_KEYWORDS.has(tokens[index - 1]?.value);
    }
  }
  return false;
}

function isRegexAfterStatementBlock(tokens) {
  let braceDepth = 0;
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (tokens[index].value === "}") braceDepth += 1;
    else if (tokens[index].value === "{") {
      braceDepth -= 1;
      if (braceDepth === 0) {
        const beforeBrace = tokens[index - 1]?.value;
        if (beforeBrace === ")") return isControlParenClose(tokens, index - 1);
        return ["do", "else", "finally", "try"].includes(beforeBrace);
      }
    }
  }
  return false;
}

function canStartRegexAfter(tokens) {
  if (tokens.length === 0) return true;
  const last = tokens[tokens.length - 1];
  if (last.type === "identifier") return REGEX_PREFIX_KEYWORDS.has(last.value);
  if (last.type !== "punctuator") return false;
  if (REGEX_PREFIX_PUNCTUATORS.has(last.value)) return true;
  if (last.value === ")") return isControlParenClose(tokens, tokens.length - 1);
  if (last.value === "}") return isRegexAfterStatementBlock(tokens);
  return false;
}

function tokenizeTemplateLiteral(source, start) {
  const tokens = [];
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source.charCodeAt(index) === 96) {
      tokens.push({ type: "literal", value: "template" });
      return { tokens, nextIndex: index + 1 };
    }
    if (source[index] === "$" && source[index + 1] === "{") {
      const expression = tokenizeJavaScript(source, index + 2, true);
      tokens.push(...expression.tokens);
      index = expression.nextIndex;
      continue;
    }
    index += 1;
  }
  tokens.push({ type: "literal", value: "template" });
  return { tokens, nextIndex: index };
}

function tokenizeJavaScript(source, start = 0, stopAtTemplateBrace = false) {
  const tokens = [];
  let index = start;
  let templateBraceDepth = 0;
  const push = (type, value, tokenStart = index, tokenEnd = index + 1) => tokens.push({ type, value, start: tokenStart, end: tokenEnd });

  while (index < source.length) {
    const char = source[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (stopAtTemplateBrace && char === "}") {
      if (templateBraceDepth === 0) return { tokens, nextIndex: index + 1 };
      templateBraceDepth -= 1;
      push("punctuator", char);
      index += 1;
      continue;
    }
    if (stopAtTemplateBrace && char === "{") {
      templateBraceDepth += 1;
      push("punctuator", char);
      index += 1;
      continue;
    }

    if (char === "/" && source[index + 1] === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n" && source[index] !== "\r") index += 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (char === "'" || char === '"') {
      const literalStart = index;
      index = skipQuotedLiteral(source, index, char);
      push("literal", "string", literalStart, index);
      continue;
    }
    if (source.charCodeAt(index) === 96) {
      const template = tokenizeTemplateLiteral(source, index);
      tokens.push(...template.tokens);
      index = template.nextIndex;
      continue;
    }
    if (char === "/" && canStartRegexAfter(tokens)) {
      const end = skipRegexLiteral(source, index);
      if (end > index + 1) {
        const literalStart = index;
        index = end;
        push("literal", "regex", literalStart, index);
        continue;
      }
    }
    if (isIdentifierStart(char)) {
      const tokenStart = index;
      let end = index + 1;
      while (isIdentifierPart(source[end])) end += 1;
      push("identifier", source.slice(index, end), tokenStart, end);
      index = end;
      continue;
    }
    if (/[0-9]/.test(char)) {
      const tokenStart = index;
      let end = index + 1;
      while (/[0-9_]/.test(source[end] ?? "")) end += 1;
      push("literal", source.slice(index, end), tokenStart, end);
      index = end;
      continue;
    }

    push("punctuator", char, index, index + 1);
    index += 1;
  }
  return { tokens, nextIndex: index };
}

function matchingParen(tokens, openParenIndex) {
  let depth = 0;
  for (let index = openParenIndex; index < tokens.length; index += 1) {
    if (tokens[index].value === "(") depth += 1;
    else if (tokens[index].value === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function isFunctionDeclaration(tokens, nameIndex) {
  const previous = tokens[nameIndex - 1]?.value;
  return previous === "function" || (previous === "*" && tokens[nameIndex - 2]?.value === "function");
}

function enclosingOpenBrace(tokens, beforeIndex) {
  let nestedBraceDepth = 0;
  for (let index = beforeIndex; index >= 0; index -= 1) {
    if (tokens[index].value === "}") nestedBraceDepth += 1;
    else if (tokens[index].value === "{") {
      if (nestedBraceDepth === 0) return index;
      nestedBraceDepth -= 1;
    }
  }
  return -1;
}

function isClassBody(tokens, openBraceIndex) {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  for (let index = openBraceIndex - 1; index >= 0; index -= 1) {
    const value = tokens[index].value;
    if (value === ")") parenDepth += 1;
    else if (value === "(") parenDepth = Math.max(0, parenDepth - 1);
    else if (value === "]") bracketDepth += 1;
    else if (value === "[") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (value === "}") braceDepth += 1;
    else if (value === "{") {
      if (braceDepth > 0) braceDepth -= 1;
      else if (parenDepth === 0 && bracketDepth === 0) return false;
    } else if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      if (tokens[index].type === "identifier" && value === "class" && tokens[index - 1]?.value !== ".") {
        return true;
      }
      if (value === ";") return false;
    }
  }
  return false;
}

function isObjectLiteralOrClassBody(tokens, openBraceIndex) {
  if (isClassBody(tokens, openBraceIndex)) return true;
  const previous = tokens[openBraceIndex - 1]?.value;
  if (previous === ">" && tokens[openBraceIndex - 2]?.value === "=") return false;
  return ["=", "(", "[", ":", ",", "return", "yield", "?"].includes(previous);
}

function isMethodDefinition(tokens, nameIndex, openParenIndex, source) {
  if (!METHOD_PREFIXES.has(tokens[nameIndex - 1]?.value)) return false;
  const closeParenIndex = matchingParen(tokens, openParenIndex);
  if (closeParenIndex === -1 || tokens[closeParenIndex + 1]?.value !== "{") return false;
  const gap = source.slice(tokens[closeParenIndex].end, tokens[closeParenIndex + 1].start);
  if (!/[\r\n\u2028\u2029]/.test(gap)) return true;
  const containerBraceIndex = enclosingOpenBrace(tokens, nameIndex - 1);
  return containerBraceIndex !== -1 && isObjectLiteralOrClassBody(tokens, containerBraceIndex);
}

function hasUsageRecorderInvocation(source) {
  const tokens = tokenizeJavaScript(source).tokens;
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].type !== "identifier" || tokens[index].value !== "recordOpenAIUsage") continue;
    let openParenIndex = index + 1;
    if (tokens[openParenIndex]?.value === "?" && tokens[openParenIndex + 1]?.value === ".") {
      openParenIndex += 2;
    }
    if (tokens[openParenIndex]?.value !== "(") continue;
    if (tokens[index - 1]?.value === "new") continue;
    if (isFunctionDeclaration(tokens, index)) continue;
    if (isMethodDefinition(tokens, index, openParenIndex, source)) continue;
    return true;
  }
  return false;
}

function hasUsageReceiptCoverage(rel, source) {
  return hasUsageRecorderInvocation(source) || Object.prototype.hasOwnProperty.call(ALLOWLIST, rel);
}

test("there are candidate .mjs files to scan under setup/ and skills/", () => {
  assert.ok(candidateFiles.length > 0, "expected at least one non-test .mjs file under setup/ or skills/");
});

test("an import-only recorder reference does not satisfy the usage coverage guard", () => {
  const importOnlySource = [
    'import { recordOpenAIUsage } from "../setup/openai-usage.mjs";',
    'await fetch("https://api.openai.com/v1/images/generations");',
  ].join("\n");

  assert.ok(importOnlySource.includes("recordOpenAIUsage"), "fixture retains the recorder import");
  assert.match(importOnlySource, /\bapi\.openai\.com\b/, "fixture has a direct OpenAI call path");
  assert.equal(hasUsageReceiptCoverage("fixture.mjs", importOnlySource), false);
});

test("comments, literals, and regexes do not satisfy the usage coverage guard", () => {
  const falsePositiveSources = [
    [
      "// recordOpenAIUsage();",
      'await fetch("https://api.openai.com/v1/images/generations");',
    ].join("\n"),
    [
      "/* recordOpenAIUsage(); */",
      'await fetch("https://api.openai.com/v1/images/generations");',
    ].join("\n"),
    [
      'const callText = "recordOpenAIUsage()";',
      "const callPattern = /recordOpenAIUsage\\s*\\(/;",
      'await fetch("https://api.openai.com/v1/images/generations");',
    ].join("\n"),
    [
      "if (ready) {}",
      "/recordOpenAIUsage(value)/.test(source);",
      'await fetch("https://api.openai.com/v1/images/generations");',
    ].join("\n"),
  ];

  for (const source of falsePositiveSources) {
    assert.match(source, /\bapi\.openai\.com\b/, "fixture has a direct OpenAI call path");
    assert.equal(hasUsageReceiptCoverage("fixture.mjs", source), false);
  }
});

test("function and method declarations do not satisfy the usage coverage guard", () => {
  const declarations = [
    [
      "function recordOpenAIUsage() {}",
      'await fetch("https://api.openai.com/v1/images/generations");',
    ].join("\n"),
    [
      "const unused = function recordOpenAIUsage() {};",
      'await fetch("https://api.openai.com/v1/images/generations");',
    ].join("\n"),
    [
      "function* recordOpenAIUsage() {}",
      'await fetch("https://api.openai.com/v1/images/generations");',
    ].join("\n"),
    [
      "const helper = { recordOpenAIUsage() {} };",
      'await fetch("https://api.openai.com/v1/images/generations");',
    ].join("\n"),
  ];

  for (const source of declarations) {
    assert.equal(hasUsageReceiptCoverage("fixture.mjs", source), false);
  }
});

test("a real recorder call satisfies the usage coverage guard", () => {
  const invocationSource = [
    'import { recordOpenAIUsage } from "../setup/openai-usage.mjs";',
    'await fetch("https://api.openai.com/v1/images/generations");',
    "await recordOpenAIUsage /* comments do not break token recognition */ ({ kind: 'image' });",
  ].join("\n");
  const templateInvocationSource =
    "const result = " + String.fromCharCode(96) + "usage $" + "{recordOpenAIUsage()}" + String.fromCharCode(96) + ";";
  const callBeforeBlockSource = [
    "function caller() {",
    "  if (true) {",
    "    recordOpenAIUsage()",
    "    {}",
    "  }",
    "}",
  ].join("\n");

  assert.equal(hasUsageReceiptCoverage("fixture.mjs", invocationSource), true);
  assert.equal(hasUsageRecorderInvocation(templateInvocationSource), true);
  assert.equal(hasUsageRecorderInvocation(callBeforeBlockSource), true);
});

test("direct GPT Image scripts are scanned and require usage receipt instrumentation", () => {
  for (const rel of GPT_IMAGE_RECEIPT_PATHS) {
    assert.ok(scannedPaths.has(rel), `${rel} must remain in the source coverage scan`);
    assert.equal(Object.prototype.hasOwnProperty.call(ALLOWLIST, rel), false, `${rel} must not be exempted`);
    const content = readFileSync(join(ROOT, rel), "utf8");
    assert.match(content, /\bapi\.openai\.com\b/, `${rel} must remain an explicit direct OpenAI call path`);
    assert.ok(hasUsageRecorderInvocation(content), `${rel} must invoke the provider usage recorder`);
  }
});

test("openai-usage.mjs itself is NOT in the allowlist (it doesn't need to be -- it never calls api.openai.com)", () => {
  assert.equal(Object.prototype.hasOwnProperty.call(ALLOWLIST, "setup/openai-usage.mjs"), false);
});

for (const abs of candidateFiles) {
  const rel = relative(ROOT, abs).split(sep).join("/");
  let content;
  try {
    content = readFileSync(abs, "utf8");
  } catch {
    // A file this scan cannot read (e.g. genuinely binary, like a stray build artifact) cannot be
    // making a text-literal "api.openai.com" HTTP call either -- skip rather than fail the gate on an
    // unrelated I/O quirk.
    continue;
  }
  // A source-text scan, not URL handling: match the literal host as a whole token in the file's
  // contents (a regex rather than String#includes on a hostname literal, which CodeQL's
  // js/incomplete-url-substring-sanitization would otherwise flag as if this were sanitizing a URL).
  if (!/\bapi\.openai\.com\b/.test(content)) continue;

  test(`${rel}: references api.openai.com, so it must also call recordOpenAIUsage() or be an explicitly documented exception`, () => {
    const allowReason = ALLOWLIST[rel];
    if (allowReason) {
      // An allowlisted file that STARTS calling the helper is not a failure, just stale bookkeeping --
      // still flag it so the allowlist entry gets cleaned up rather than silently rotting.
      assert.ok(
        typeof allowReason === "string" && allowReason.length > 20,
        `${rel} is allowlisted but its reason string is missing or too short to be a real justification`
      );
      return;
    }
    assert.ok(
      hasUsageReceiptCoverage(rel, content),
      `${rel} references api.openai.com but never calls recordOpenAIUsage() (setup/openai-usage.mjs) and ` +
        `is not in this test's ALLOWLIST. Either instrument it (see the fleet's existing call sites for the ` +
        `pattern) or add a named, reasoned ALLOWLIST entry explaining why this specific file's OpenAI call ` +
        `does not need its own usage-receipt instrumentation.`
    );
  });
}
