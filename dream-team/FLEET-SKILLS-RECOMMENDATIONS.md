# Fleet Skills Recommendations — power-ups from the claude-plugins.dev registry

A curated, agent-by-agent map of high-value **Agent Skills** (and a few plugins) from
the public claude-plugins.dev registry (50,935 skills indexed from public GitHub as of
2026-06-18). Built by querying the registry API across every agent's job, ranked by
installs then stars. This is the answer to "what would make each agent a super-agent."

How to read this: each row is `@owner/repo/skill` — what it does — (installs / stars).
The discovery + adoption mechanics live in `skills/skills-discovery/SKILL.md`.

## Adoption model (READ FIRST)
- Our skills hydrate from THIS repo via `setup/session-start.sh` (it copies every
  `skills/*/` into `~/.claude/skills`). A one-off `npx skills-installer install ...`
  only affects the current ephemeral sandbox and does NOT propagate fleet-wide or
  survive the next session. **Durable adoption = VENDOR the skill into `skills/<name>/`
  in this repo** (read its SKILL.md from raw GitHub, route through `guardian` for a
  supply-chain pass, copy in, strip em/en dashes, commit).
- Risk tags: **[official]** = `@anthropics/*` (low risk, adopt freely).
  **[community]** = third-party (guardian-review the SKILL.md + any scripts first).
  **[guidance]** = SKILL.md only, no runtime script (lowest risk).
- Hard rule: never auto-install unreviewed third-party CODE into the **CLO** (privileged)
  or any **PHI-ring** context. Discovery (reading the registry) is always safe.

---

## Cross-cutting — adopt for the WHOLE fleet
- **skills-discovery** `@Kamalnrf/claude-plugins` — search the registry on demand; the
  meta-skill. ALREADY VENDORED (`skills/skills-discovery/`). [community/guidance]
- **document suite** `@anthropics/skills/{docx,pptx,xlsx,pdf}` — native Word / PowerPoint
  / Excel / PDF create + edit + extract. We already have our own `pdf` (OCR + create);
  docx/pptx/xlsx are the additive wins (true .docx with tracked changes, real .xlsx with
  formulas, .pptx decks). (5675i/4252i/4660i) [official]
- **agent-development** `@anthropics/claude-code` — author/modify Claude Code agents
  correctly. Use when we add fleet agents. (1058i) [official]
- **skill-writer** `@pytorch/pytorch` — guided creation of new Agent Skills (so our own
  skills follow best practice). (2073i) [community/guidance]
- **brainstorming + writing-plans + executing-plans** `@obra/superpowers` — structured
  ideation and plan-then-execute discipline; force-multipliers for any agent doing
  multi-step work. (4904i / 867i / 501i) [community/guidance]

---

## APP BUILDERS

### architect (spec -> plan -> tasks)
- `@obra/superpowers/brainstorming` — mandatory pre-work ideation pass. (4904i) [guidance]
- `@obra/superpowers/writing-plans` — turn a spec into a step plan before code. (867i) [guidance]
- `@obra/superpowers/subagent-driven-development` — decompose a plan into parallel subagent tasks. (1017i) [guidance]
- `@wshobson/agents/architecture-patterns` — Clean/Hexagonal/DDD backend patterns. (1813i) [community]

### builder (Capacitor / TS / React / Swift)
- `@anthropics/skills/frontend-design` — production-grade, non-generic UI. (1990i) [official]
- `@anthropics/skills/mcp-builder` — build MCP servers correctly (we ship a gateway). (1452i) [official]
- `@nextlevelbuilder/ui-ux-pro-max-skill/ui-ux-pro-max` — 50 styles / palettes / font pairings / charts. (1627i) [community]
- `@wshobson/agents/typescript-advanced-types` + `/modern-javascript-patterns` — deep TS/JS. (176i/295i) [community]
- `@aj-geddes/useful-ai-prompts/ios-swift-development` — SwiftUI / MVVM (for native targets). (180i) [community]

### qa (web-first test stack + native smoke)
- `@anthropics/skills/webapp-testing` — Playwright-based app testing toolkit. (1232i) [official]
- `@obra/superpowers/test-driven-development` — TDD discipline, test-before-code. (414i) [guidance]
- `@obra/superpowers/systematic-debugging` — structured bug isolation. (2057i) [guidance]
- `@lackeyjb/playwright-skill/playwright-skill` — full browser automation + test scaffolding. (939i) [community]

### guardian (security / supply-chain — has release veto)
- `@Jeffallan/claude-skills/security-reviewer` — vuln scan + severity-rated audit reports. (58i) [community]
- `@Jeffallan/claude-skills/code-reviewer` — bug + injection (SQLi/XSS) review of diffs. (84i) [community]
- `@wshobson/agents/secrets-management` — Vault / cloud secret-store patterns. (54i) [community]
- `@trailofbits/skills/property-based-testing` — property tests (great for Flatstick money math). (15i) [community]

### release-captain (ship: OTA vs native build)
- `@wshobson/agents/github-actions-templates` — production CI/CD workflows (our Depot lane). (158i) [community]
- `@wshobson/agents/changelog-automation` — changelog from commits/PRs (Keep a Changelog). (57i) [community]
- `@JimLiu/baoyu-skills/release-skills` — version-file + changelog release workflow. (60i) [community]

### medic (reliability / SRE)
- `@wshobson/agents/debugging-strategies` — profiling + root-cause method. (291i) [community]
- `@wshobson/agents/sql-optimization-patterns` — EXPLAIN-driven query tuning (Neon/Azure PG). (301i) [community]
- `@wshobson/agents/grafana-dashboards` — production observability dashboards. (62i) [community]

### creative / designer
- `@anthropics/skills/canvas-design` — visual art in PNG/PDF with design philosophy. (911i) [official]
- `@anthropics/claude-cookbooks/applying-brand-guidelines` — consistent corporate branding on outputs. (509i) [official]
- `@nextlevelbuilder/ui-ux-pro-max-skill/brand` — brand voice + visual identity + messaging frameworks. (48i) [community]

---

## EXECUTIVE TEAM

### CLO — Chief Legal Officer (the headline build-out)
The CLO already has the `legal` skill (cite/caselaw/edgar + Azure matter/docket store).
These registry adds extend it. Privilege rule: read the SKILL.md, but vendor only after
a guardian pass; keep personal-matter work off any third-party runtime code.
- `@anthropics/claude-plugins-official` **legal plugin** — "Attorney guidance and legal
  tools for business AND personal needs; AI-powered document review." Official + covers
  both the companies and Matt's personal matters. The single best CLO add. (30,270★) [official]
- `@anthropics/knowledge-work-plugins` **legal plugin** — contract review, NDA triage,
  compliance workflows, draft legal briefs, precedent research, institutional knowledge.
  Built for in-house legal teams. (20,718★) [official]
- `@wshobson/claude-code-workflows` **hr-legal-compliance** — GDPR/SOC2/HIPAA templates +
  **employment contracts** (directly relevant to the GA FLSA back-wage matter). (35,777★) [community]
- `@OneWave-AI/claude-skills/contract-analyzer` — flag concerning clauses, extract key
  terms, compare against standard terms. (44i) [community]
- `@dgunning/edgartools/core` — query + analyze SEC filings/financials via EdgarTools
  (securities superpower for INND disclosure comparables; complements our `legal edgar`). (32i) [community]
- `@sickn33/antigravity-awesome-skills/legal-advisor` — draft privacy policies, ToS,
  disclaimers, GDPR notices. (4i, but 39,686★ repo) [community]
- `@diegocconsolini/ClaudeSkillCollection/gdpr-auditor` — audit code/data for GDPR. [community]

### COO (CcOO — operating cadence)
- `@anthropics/skills/{docx,pptx}` — briefings + decks for Matt. [official]
- `@obra/superpowers/writing-plans` — turn directives into trackable plans. (867i) [guidance]
- (Notion is already a native MCP; prefer it over community Notion skills.)

### finance-ops / CFO
- `@anthropics/skills/xlsx` — real spreadsheets with formulas (the CFO data room). (4660i) [official]
- `@anthropics/claude-cookbooks/creating-financial-models` — DCF + sensitivity + scenario suite. (499i) [official]
- `@anthropics/claude-cookbooks/analyzing-financial-statements` — ratios + metrics from statements. (340i) [official]
- `@davila7/claude-code-templates/excel-analysis` — pivots, charts, data analysis on .xlsx. (182i) [community]
- (QuickBooks + Mercury + Plaid are already wired as MCPs/skills; these are the analysis layer.)

### capital / IR (gated — securities firewall; prep only, counsel + Matt decide)
- `@ailabs-393/ai-labs-claude-skills/pitch-deck` — professional PowerPoint pitch decks. (68i) [community]
- `@coreyhaines31/marketingskills/sales-enablement` — pitch decks, one-pagers, objection handling. (53i) [community]
- `@affaan-m/ECC/market-research` — investor due diligence + industry intelligence. (190,073★ repo) [community]

### commerce (liquidate inventory; Shopify + Amazon)
- `@mrgoonie/claudekit-skills/shopify` — Shopify apps/extensions/themes via GraphQL/REST + CLI. (76i) [community]
- `@sickn33/antigravity-awesome-skills/shopify-automation` — products/orders/customers/inventory ops. (5i) [community]
- (Shopify + Amazon SP-API are already wired; these add app/theme + bulk-ops patterns.)

### growth / lifecycle (top of funnel + reactivation)
- `@davila7/claude-code-templates/seo-optimizer` — content strategy + technical SEO + keywords. (175i) [community]
- `@davila7/claude-code-templates/market-research-reports` — 50+ page consulting-style reports. (152i) [community]
- `@coreyhaines31/marketingskills/{content-strategy,customer-research,competitor-profiling}` — the marketing trio. [community]
- `@ComposioHQ/awesome-claude-skills/content-research-writer` — researched, cited content. (211i) [community]

### switchboard / voice (Twilio + ElevenLabs)
- `@sickn33/antigravity-awesome-skills/twilio-communications` — SMS / voice / WhatsApp via Twilio. (20i) [community]
- `@enuno/claude-command-and-control/twilio-voice` — Twilio Voice API + AI integration patterns. (12i) [community]
- (We already run a Twilio + ElevenLabs + n8n voice fleet; these are reference patterns.)

---

## LIVE STATUS (2026-06-18) - what is installed fleet-wide now

How a skill reaches every agent (new AND existing sessions):
- **New / resumed sessions:** `setup/session-start.sh` runs on every session start. It (a)
  copies every `skills/*/` in this repo into `~/.claude/skills` (the vendored MIT skills),
  and (b) headless-installs the official Anthropic marketplace plugins. A "stale" chat, when
  resumed, spins a fresh container that re-runs this, so it gets everything automatically.
- **Actively-running session:** cannot be force-updated from outside. Two paths: the
  `skills-discovery` skill (self-serve any registry skill at runtime), or re-run
  `bash setup/session-start.sh` to re-hydrate the full pack immediately.

INSTALLED (vendored, MIT, in `skills/` - see `skills/VENDORED.md`):
- Workflow meta (ALL agents): brainstorming, writing-plans, executing-plans,
  subagent-driven-development, test-driven-development, systematic-debugging,
  verification-before-completion, dispatching-parallel-agents, requesting-code-review,
  receiving-code-review.
- Finance (finance-ops/CFO/capital): creating-financial-models, analyzing-financial-statements.
- CLO: contract-analyzer, contract-redliner, edgartools (SEC structured data).
- Meta: skills-discovery (registry self-serve).

INSTALLED (official Anthropic marketplace `anthropic-agent-skills`, authorized-not-copied):
- document-skills: xlsx, docx, pptx, pdf.
- example-skills: canvas-design, mcp-builder, brand-guidelines, doc-coauthoring,
  webapp-testing, skill-creator, frontend-design, internal-comms, theme-factory,
  web-artifacts-builder.

NOT installed (LegalZoom commercial plugin): the `@anthropics/claude-plugins-official`
"legalzoom" plugin is a third-party commercial connector, not a self-contained skill;
connect it deliberately if wanted, do not auto-enable.

## WAVE 2 (2026-06-18) - wider sourcing beyond one marketplace

### wshobson `claude-code-workflows` marketplace (MIT, 84 plugins / 156 skills) - REGISTERED
The biggest single source. Registered fleet-wide (auto, on-demand). 21 best skills already
vendored (see skills/VENDORED.md). The remaining plugins install on demand:
`claude plugin install <plugin>@claude-code-workflows`. The best plugins by agent:
- **guardian:** security-scanning, security-compliance (SOC2/HIPAA/GDPR), dependency-management, reverse-engineering.
- **medic:** incident-response, observability-monitoring, error-diagnostics, distributed-debugging, application-performance.
- **release-captain:** cicd-automation, deployment-strategies, deployment-validation, kubernetes-operations.
- **builder:** javascript-typescript, frontend-mobile-development, code-refactoring, api-scaffolding, backend-development.
- **qa:** unit-testing, tdd-workflows, api-testing-observability, accessibility-compliance.
- **architect:** c4-architecture, database-design, full-stack-orchestration.
- **CLO:** hr-legal-compliance, security-compliance.
- **finance/capital:** business-analytics, startup-business-analyst, quantitative-trading.
- **commerce/monetization:** payment-processing.
- **growth/lifecycle:** seo-content-creation, seo-technical-optimization, seo-analysis-monitoring, content-marketing, social-publishing, customer-sales-automation.
- **creative:** ui-design, brand-landingpage, meigen-ai-design.
- **coo/cross-cutting:** developer-essentials, git-pr-workflows, agent-teams, context-management, conductor, pensyve (cross-session memory - evaluate; it ships a hook/runtime).

### Other MIT collections (discover-on-demand via skills-discovery; vendor after guardian pass)
- **davila7/claude-code-templates** (MIT) - seo-optimizer, market-research-reports, excel-analysis, big template lib + a components CLI.
- **VoltAgent/awesome-claude-code-subagents** (MIT) - product / legal / business specialist subagents.
- **ComposioHQ/awesome-claude-skills** - content-research-writer, changelog-generator (NOTE: no LICENSE file -> reference only, do NOT vendor until licensed).

### MCP server power-ups (a different class: LIVE tools, not instructions)
CAUTION: there is a ~40-50 active-tool ceiling; past it the model picks the wrong tool, and
we already run 25+ MCP connectors. So add SURGICALLY, not in bulk:
- **Context7** (live, version-pinned library docs) - WIRED fleet-wide 2026-06-18 via
  `session-start.sh` (`claude mcp add --transport http --scope user context7
  https://mcp.context7.com/mcp`, free remote, keyless). Kills hallucinated package APIs for
  every builder. Add a CONTEXT7_API_KEY header later for higher limits.
- **Playwright MCP** (browser automation) - qa visual/UI testing + JS-heavy scraping. Candidate.
- **Exa** or **Firecrawl** (web search / scraping) - growth + research agents. Candidate.

### Supply-chain hardening of the wshobson marketplace (security review 2026-06-18)
Third-party marketplace, so: `autoUpdate: false` (no tracking its moving default branch;
reviewed at commit `cc37bfd`); NO mass-enable and NO agent-initiated installs; only a
CURATED, human-approved set is enabled in `.claude/settings.json`. Enabled now:
`hr-legal-compliance` (CLO: legal-advisor + hr-pro agents + GDPR/employment skills) and
`security-compliance` (guardian: security-auditor agent + compliance-check command, for
SOC2/HIPAA/GDPR). Adding another wshobson plugin is a human edit + review, not an agent action.

## Rollout order (history)
1. DONE: skills-discovery (registry self-service).
2. DONE: official Anthropic docs (document-skills + example-skills) via authorized marketplace.
3. DONE: CLO batch (edgartools + contract-analyzer/redliner) + finance models, vendored MIT.
4. DONE: builder/QA/meta workflow batch (superpowers) vendored MIT; webapp-testing via marketplace.
5. DONE: wave 2 - registered the wshobson `claude-code-workflows` marketplace (84 plugins)
   + vendored 21 best skills across guardian/CLO/qa/medic/finance/commerce/cross-cutting.
6. ONGOING: the long tail is pulled on demand via `skills-discovery` + the registered
   marketplaces, and vendored (MIT + guardian pass) when it proves useful more than once.
   Next surgical MCP add: Context7 (live library docs) for the builders.
