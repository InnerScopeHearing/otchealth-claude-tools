// The detector behind tests/public-writer-inventory.test.mjs: which files in this repo can write to a GitHub repo.
//
// THIS IS A TRIPWIRE, NOT A PROOF. It is a table of the common ways code writes to a GitHub repository, matched
// against workflows, composite actions and scripts. A hit means "a person must look at this file": it either calls
// the public write gate (setup/public-write-gate.mjs) or it is listed in setup/public-writers.json with a reason.
// A miss means only that none of these shapes were found.
//
// WHAT IT LOOKS FOR (each rule has an id, shown in failure messages and pinned in the registry):
//   git push in its common spellings (including -C and -c options, argument lists and spawn calls); the gh CLI
//   writing (pr, issue, release, gist, repo, label, workflow run, discussion, and gh api with a write method, a
//   field flag or an input file); curl, wget and httpie writes to the GitHub API; an HTTP write verb in a file that
//   talks to GitHub (fetch, axios, got, requests, urllib, Net::HTTP, Invoke-RestMethod, a method passed to a helper);
//   GraphQL mutations; octokit and PyGithub write methods (createOrUpdateFileContents, issues.create,
//   pulls.create, git.updateRef and the like); the gateway's GitHub write tools named in code; release tools that
//   push tags; the repo's own writers (the GitHub App helper's write verbs and the pager issue helper); a local
//   write to one of the public record files; and, in workflows, a write scoped
//   token (contents, issues, pull-requests and similar set to write, or write-all), a known write action, and
//   minting a GitHub App token.
//
// WHAT IT CANNOT SEE (tests/public-writer-inventory.test.mjs pins each of these in LIMITS, so this list cannot
// quietly go stale):
//   * a write whose verb or URL is built at run time or comes from another file;
//   * a new caller of a helper that is already registered (the generic GitHub App transport, the pager helper),
//     unless the caller names a write verb itself;
//   * code in a language or file type that is not scanned (Go, Java, Rust and so on);
//   * writes made from another repository, by a person, or through the gateway GitHub tools (a ring lane agent can
//     still publish to a public repo that way; only a check inside the gateway can stop it);
//   * what a workflow prints to its public logs, artifacts and job summaries.
// A new writer in any of those forms needs a human reviewer.
//
// Patterns are bounded (no unbounded nested quantifiers) so a huge or hostile file cannot make the scan slow.

export const GH_REF = /api\.github\.com|uploads\.github\.com|GITHUB_API_URL|GITHUB_GRAPHQL_URL|\/repos\/(?:\$|\{|[\w.-]+\/[\w.-]+)|\bocto(?:kit|\.)|@actions\/github|github-script|\bPyGithub\b|from github import|import github\b|\bGithub\(/i;
const OCTO_REF = /octokit|@actions\/github|github-script|\bgithub\.(?:rest|request|paginate|graphql)\b|\bPyGithub\b|from github import|import github\b|\bGithub\(/i;
const WRITE_VERB = "(?:POST|PUT|PATCH|DELETE)";

const RECORD_NAME = "(?:FLEET-BULLETIN|REGRESSION-LEDGER|FINDINGS-LEDGER)\\.md";
const FILE_WRITE = "(?:writeFileSync|appendFileSync|writeFile|appendFile|write_text|write_bytes|open)";

/** A local write to one of the public record files, which another step then commits: the name inside the write
 *  call, a shell redirect or tee onto it, or a constant that holds the name and is then written. */
function writesPublicRecordFile(t) {
  if (new RegExp(`${FILE_WRITE}\\s*\\([^)\\n]{0,200}${RECORD_NAME}`).test(t)) return true;
  if (new RegExp(`>>?\\s*["']?\\S*${RECORD_NAME}|\\btee\\s+(?:-a\\s+)?\\S*${RECORD_NAME}`).test(t)) return true;
  for (const m of t.matchAll(new RegExp(`(?:(?:const|let|var)\\s+)?(\\w+)\\s*=\\s*[^\\n;]{0,200}${RECORD_NAME}`, "g"))) {
    if (new RegExp(`${FILE_WRITE}\\s*\\(\\s*${m[1]}\\b`).test(t)) return true;
  }
  return false;
}

/** The rule table. A rule has an `id` and ONE of: `re` (a pattern), `all` (patterns that must all match the same
 *  file) or `test` (a function). `only: "workflow"` limits it to workflow files. */
export const RULES = [
  // ---- git ----
  { id: "git push", re: /\bgit(?:\s+(?:-[A-Za-z]\s*\S{0,80}|--[\w-]{1,40}(?:=\S{0,120})?)){0,8}\s+push\b/ },
  { id: "push to a named remote", re: /(?:^|[\s"'`(\[,.])push["'`]?\s*,?\s*(?:-[-\w=]+\s+)*["'`]?(?:origin|upstream)\b/m },
  { id: "git push in an argument list", all: [/["']git["']/, /\[[^\]]{0,300}["']push["'][^\]]{0,300}\]/] },
  { id: "spawned push (argument list starting with push)", re: /\[\s*["']push["']\s*,/ },
  { id: "simple-git or isomorphic-git push", re: /\bgit\.push\s*\(\s*\{[^}]{0,300}\b(?:remote|http|dir|fs)\b|(?:simpleGit|simple-git)[\s\S]{0,400}?\.push\s*\(/ },
  // ---- gh CLI and its relatives ----
  { id: "gh pr or issue write", re: /\bgh\s+(?:(?:-R|--repo)\s+\S+\s+)?(?:pr|issue)\s+(?:create|comment|edit|close|reopen|merge|review|ready|lock|unlock|transfer|delete|develop|pin|unpin)\b/ },
  { id: "gh release, gist, repo, label or workflow write", re: /\bgh\s+(?:(?:-R|--repo)\s+\S+\s+)?(?:release\s+(?:create|edit|delete|upload)|gist\s+(?:create|edit|delete)|repo\s+(?:create|edit|delete|fork|rename|archive|sync)|label\s+(?:create|edit|delete)|workflow\s+(?:run|enable|disable)|discussion\s+(?:create|comment))\b/ },
  { id: "gh api write", re: new RegExp(`\\bgh\\s+api\\b[^\\n]{0,400}?(?:(?:-X|--method)(?:\\s+|=)\\s*["']?${WRITE_VERB}\\b|\\s(?:-f|-F|--field|--raw-field|--input)\\b)`, "i") },
  { id: "gh api graphql mutation", re: /\bgh\s+api\s+graphql\b[\s\S]{0,800}?\bmutation\b/i },
  { id: "gh in an argument list", re: new RegExp(`["']gh["']\\s*,\\s*\\[[^\\]]{0,300}["'](?:create|comment|edit|merge|review|ready|close|reopen|upload|delete|${WRITE_VERB}|--method|-X|-f|-F|--field|--raw-field|--input)["']`, "i") },
  { id: "hub CLI write", re: /\bhub\s+(?:pull-request|issue\s+create|release\s+create|create|fork|ci-status\s+--create)\b/ },
  // ---- raw HTTP to GitHub ----
  { id: "curl write to GitHub", all: [GH_REF, new RegExp(`\\bcurl\\b[^\\n]{0,500}?(?:(?:-X|--request)(?:\\s+|=)\\s*["']?${WRITE_VERB}\\b|\\s(?:-d|--data|--data-raw|--data-binary|--data-urlencode|-F|--form|-T|--upload-file|--json)\\b)`, "i")] },
  { id: "wget write to GitHub", all: [GH_REF, /\bwget\b[^\n]{0,400}?(?:--method(?:\s+|=)\s*["']?(?:POST|PUT|PATCH|DELETE)\b|--post-(?:data|file)|--body-(?:data|file))/i] },
  { id: "httpie write to GitHub", all: [GH_REF, /\bhttps?\s+(?:--?[\w-]+(?:=\S+)?\s+){0,4}(?:POST|PUT|PATCH|DELETE)\s+\S*github/i] },
  { id: "HTTP write verb in a file that talks to GitHub", all: [GH_REF, new RegExp(`\\bmethod\\s*[:=]\\s*["'\`]?(?:${WRITE_VERB}|post|put|patch|delete)\\b|["'\`]${WRITE_VERB}["'\`]|\\.(?:post|put|patch|post_form)\\s*\\(|\\b(?:requests|httpx|axios|got|ky|aiohttp|urllib3|session|client)\\.delete\\s*\\(|-[Mm]ethod\\s+(?:[Pp]ost|POST|[Pp]ut|PUT|[Pp]atch|PATCH|[Dd]elete|DELETE)\\b|Net::HTTP::(?:Post|Put|Patch|Delete)\\b|\\b(?:Post|Put|Patch|Delete)AsJsonAsync\\b`)] },
  { id: "GitHub REST route string write", re: new RegExp(`["'\`]${WRITE_VERB}\\s+/(?:repos|orgs|user|users|gists|app|enterprises|projects|teams)\\b`, "i") },
  { id: "GraphQL mutation in a file that talks to GitHub", all: [GH_REF, /\bmutation\b\s*(?:\w+\s*)?[({]/] },
  // ---- SDK methods ----
  { id: "octokit write method", re: /createOrUpdateFileContents|\bissues\.(?:create|createComment|update|updateComment|addLabels|setLabels)\b|\bpulls\.(?:create|update|merge|createReview)\b|\bgit\.(?:createCommit|updateRef|createRef|createTree|createBlob)\b/ },
  { id: "octokit style write method", all: [OCTO_REF, /\b(?:issues|pulls|repos|git|gists|actions|checks|discussions|reactions|projects)\.(?:create|update|add|delete|remove|merge|submit|dismiss|lock|unlock|set|replace|upload|rerun|cancel|dispatch|mark)[A-Za-z]*\s*\(/] },
  { id: "PyGithub write method", all: [/from github import|import github\b|\bGithub\(/, /\.(?:create_file|update_file|delete_file|create_issue|create_issue_comment|create_pull|create_git_ref|create_git_commit|create_git_tree|create_git_release|create_comment|create_review|edit)\s*\(/] },
  // ---- this repo's own writers ----
  { id: "gh-app helper write verb", re: /gh-app(?:\.mjs)?["'`]?\s+(?:request|ready-pr|merge-pr|graphql)\b|["']request["']\s*,\s*["']?(?:POST|PUT|PATCH|DELETE)["']/ },
  { id: "pager issue channel", re: /--github-issue\b|(?:\bimport\b[^;\n]{0,200}|\bfrom\s+|\brequire\s*\(\s*|\bimport\s*\(\s*)["'][^"'\n]{0,200}alert-issue(?:\.mjs)?["']/ },
  { id: "gateway GitHub write tool", re: /\bgithub_(?:create_or_update_file|push_files|edit_file|create_pull_request|create_issue|comment_on_issue|issue_update|pr_update|pr_update_branch|merge_pull_request|pr_create_review|create_branch|dispatch_workflow|ref_delete)\b/ },
  { id: "release tool that pushes tags or releases", re: /\b(?:semantic-release|release-it|lerna\s+publish|changesets?\s+(?:publish|version))\b/ },
  { id: "writes a public record file", test: writesPublicRecordFile },
  // ---- workflow capability (what the job is allowed to do, whatever its steps say) ----
  { id: "workflow with a write scoped token", only: "workflow", re: /^[ \t]*(?:contents|issues|pull-requests|discussions|checks|statuses|deployments|pages)[ \t]*:[ \t]*write\b|^[ \t]*permissions[ \t]*:[ \t]*write-all\b/m },
  { id: "known GitHub write action", only: "workflow", re: /\buses:\s*(?:peter-evans\/|stefanzweifel\/git-auto-commit-action|EndBug\/add-and-commit|ad-m\/github-push-action|softprops\/action-gh-release|ncipollo\/release-action|JasonEtco\/create-an-issue|actions\/create-release|actions\/upload-release-asset|marocchino\/sticky-pull-request-comment|thollander\/actions-comment-pull-request|actions-ecosystem\/action-(?:create|add)|mshick\/add-pr-comment|cpina\/github-action-push-to-another-repository|JamesIves\/github-pages-deploy-action|peaceiris\/actions-gh-pages|devops-infra\/action-commit-push|github-actions-x\/commit|actions\/stale|actions\/labeler|actions\/deploy-pages|googleapis\/release-please-action|changesets\/action|release-drafter\/release-drafter)/ },
  { id: "workflow mints an App token", only: "workflow", re: /create-github-app-token|tibdex\/github-app-token|github-app-token|actions\/create-github-app/i },
];

/** Every rule id, for the registry check (an exemption may only be pinned to a rule that exists). */
export const RULE_IDS = Object.freeze(RULES.map((r) => r.id));

/** Evidence that a file really calls the gate, not merely mentions it in a comment or a string: the CLI call
 *  in a workflow or script, the exported functions, or a dynamic import of the module. Run on prepared text. */
export const GATE_EVIDENCE = /public-write-gate\.mjs\s+(?:files|check)\b|\bassertPublicWriteAllowed\s*\(|\bevaluatePublicWrite\s*\(|\bimport\s*\(\s*["'][^"'\n]*public-write-gate(?:\.mjs)?["']|\bimport\b[^;\n]{0,200}["'][^"'\n]*public-write-gate(?:\.mjs)?["']/;

/** The workflow form of a gate call: it must end the line with `|| exit 1`, because the default shell does not stop
 *  on a failed pipe or an ignored status, so the explicit exit is what makes a refusal real. */
export const GATE_CALL = /node\s+(?:\S*\/)?setup\/public-write-gate\.mjs\s+(?:files|check)\b[^\n]*\|\|\s*exit\s+1\b/;

const HASH_COMMENT_EXT = new Set([".yml", ".yaml", ".sh", ".bash", ".zsh", ".py", ".ps1", ".rb", ".mk", ""]);

/** Drop whole-line comments and doc comments, and join shell and PowerShell line continuations, so a command
 *  split over several lines is matched as one command and prose that merely mentions a command is not mistaken
 *  for it. A block comment that opens mid line is left alone, so a "/*" inside a string can never hide code. */
export function prepare(text, ext = "") {
  const hash = HASH_COMMENT_EXT.has(ext);
  let t = String(text).replace(hash ? /^[ \t]*#.*$/gm : /^[ \t]*\/\/.*$/gm, "");
  if (!hash) t = t.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, "");
  return t.replace(/\\\r?\n[ \t]*/g, " ").replace(/`\r?\n[ \t]*/g, " ");
}

/** Ids of every rule that matches this text. `ext` picks the comment style; `isWorkflow` enables the workflow rules. */
export function detect(text, { ext = "", isWorkflow = false } = {}) {
  const t = prepare(text, ext);
  const hits = [];
  for (const rule of RULES) {
    if (rule.only === "workflow" && !isWorkflow) continue;
    const ok = rule.test ? rule.test(t) : rule.all ? rule.all.every((re) => re.test(t)) : rule.re.test(t);
    if (ok) hits.push(rule.id);
  }
  return hits;
}

/** The patterns that match the write itself (not the "this file talks to GitHub" context), for line ordering. */
function verbPatterns() {
  const out = [];
  for (const rule of RULES) {
    if (rule.only === "workflow" || rule.test) continue;
    if (rule.re) out.push(rule.re);
    else out.push(...rule.all.filter((re) => re !== GH_REF && re !== OCTO_REF));
  }
  return out;
}
const VERBS = verbPatterns();
const LOCAL_GIT = /\bgit\s+(?:add|commit)\b/;

/** Index of the first line of a shell block that writes (or stages a commit that will be pushed), or -1. */
export function firstWriteLine(block) {
  const lines = prepare(block, "").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (LOCAL_GIT.test(lines[i]) || VERBS.some((re) => re.test(lines[i]))) return i;
  }
  return -1;
}

/** Index of the first line of a shell block that calls the gate with `|| exit 1`, or -1. */
export function gateCallLine(block) {
  const lines = prepare(block, "").split("\n");
  return lines.findIndex((l) => GATE_CALL.test(l));
}

export const CODE_EXT = new Set([".mjs", ".js", ".cjs", ".mts", ".cts", ".ts", ".tsx", ".jsx", ".sh", ".bash", ".zsh", ".py", ".ps1", ".rb", ".mk"]);
const SPECIAL_FILES = new Set(["package.json", "Makefile", "makefile", "GNUmakefile"]);

/** How the walker treats a repo relative path: "workflow" (a GitHub workflow, composite action or any YAML that
 *  has the shape of one), "code" (a script or a source file in a scanned language), or null (not scanned).
 *  Tests, fixtures and node_modules are never scanned. `shebang` is true for an extensionless file that starts
 *  with "#!". `yamlText` lets the caller pass the text of a YAML file outside .github to test its shape. */
export function scanKind(rel, { shebang = false, yamlText = "" } = {}) {
  if (/(^|\/)node_modules\//.test(rel)) return null;
  if (/\.test\.[a-z]+$/.test(rel) || /(^|\/)(?:tests?|__tests__|fixtures?)\//.test(rel)) return null;
  const base = rel.split("/").pop();
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot).toLowerCase() : "";
  if (ext === ".yml" || ext === ".yaml") {
    if (rel.startsWith(".github/") || /(^|\/)\.github\//.test(rel)) return "workflow";
    return /^jobs:\s*$/m.test(yamlText) && /^\s*steps:/m.test(yamlText) ? "workflow" : null;
  }
  if (CODE_EXT.has(ext)) return "code";
  if (SPECIAL_FILES.has(base)) return "code";
  if (ext === "" && !base.startsWith(".") && shebang) return "code";
  return null;
}

/** Shapes the detector deliberately does NOT catch. tests/public-writer-inventory.test.mjs asserts each one is
 *  still undetected, so these limits are executable documentation: if a rule is ever widened to cover one, that test
 *  fails and tells you to delete the entry here and to update the wording in CLAUDE.md and the registry. */
export const LIMITS = [
  {
    why: "the HTTP verb is a variable, so no write verb appears in the text",
    file: "limit.mjs",
    text: "const method = process.env.GH_VERB;\nawait fetch(`${base}/repos/${repo}/issues`, { method, body });",
  },
  {
    why: "the verb is handed to the generic GitHub App helper as a variable",
    file: "limit.mjs",
    text: 'execFileSync("node", [GHAPP, "request", verb, `/repos/${o}/${r}/issues`], { input });',
  },
  {
    why: "the write happens in a helper in another file; only a file that names a write verb is flagged",
    file: "limit.mjs",
    text: 'import { postIssue } from "./lib/helpers.mjs";\nawait postIssue({ title, body });',
  },
  {
    why: "the command is assembled from pieces at run time",
    file: "limit.mjs",
    text: 'const verb = ["pu", "sh"].join("");\nexecSync(`git ${verb} origin main`);',
  },
  {
    why: "the language is not scanned (the file is not read at all)",
    file: "limit.go",
    text: 'req, _ := http.NewRequest("POST", "https://api.github.com/repos/o/r/issues", body)',
    unscanned: true,
  },
];
