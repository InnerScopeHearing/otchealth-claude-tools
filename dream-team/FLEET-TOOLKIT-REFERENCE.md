# Fleet Toolkit Reference — the single source of truth (current 2026-06-21)

Every capability available to an OTCHealth/InnerScope agent, mapped at the TOOL level so
any future agent (including a fresh CTO) instantly knows what the toolkits are and how to
choose. Five layers:

1. **MCP connectors** — first-party hosted MCPs connected in the Claude client (live in the session).
2. **Unified gateway** — our custom MCP (`otchealth-mcp-server`), one endpoint fronting the stack.
3. **Skills** — the OTCHealth skills (`~/.claude/skills`, installed by `session-start.sh`). Includes the fleet-wide **`pdf`** skill: high-grade OCR to read/review any PDF (incl. scanned) plus PDF creation from Markdown/HTML, for every agent.
4. **Plugins** — the 13 official Claude Code marketplace plugins (agents/commands/skills).
5. **Agents** — the Dream Team subagents (`~/.claude/agents`), including the **`clo`** Chief
   Legal Officer (securities / Nevada corporate / CA family + civil / federal FLSA), which
   comes online pre-loaded from `clo/CLO-BOOTSTRAP.md` and wields the `legal` skill (citation
   verifier + case-law + SEC EDGAR + a segregated matter/docket store).

## Routing policy (which layer to use)
1. **Direct API / first-party MCP first** where one exists (this doc's Sections 1-2).
2. **Skill** for a procedural OTCHealth workflow (Section 3).
3. **Gateway** for the unified, audited, scope-gated path (Section 2) — preferred for write
   actions that need the compliance guardrail + audit log.
4. **Composio last resort** only when no direct path exists.
Never run redundant lookups. PHI is absolute: the gateway carves PHI OUT; the PostHog MCP
defaults to the MedReview PHI project (switch off it first); FourVault kid screens get no analytics.

---

## 1. MCP CONNECTORS (live this session; namespace `mcp__<server>__<tool>`)
Counts are the connected tool surface as of 2026-06-14. "R" = read-lane, "W" = write-capable.

### github (~57 tools, R/W) — primary repo/CI/PR control
- PRs: `pull_request_read`, `create_pull_request`, `update_pull_request`, `merge_pull_request`,
  `list_pull_requests`, `search_pull_requests`, `pull_request_review_write`,
  `add_comment_to_pending_review`, `add_reply_to_pull_request_comment`, `resolve_review_thread`,
  `unresolve_review_thread`, `enable/disable_pr_auto_merge`, `update_pull_request_branch`,
  `request_copilot_review`, `create_pull_request_with_copilot`.
- Issues: `issue_read`, `issue_write`, `list_issues`, `search_issues`, `add_issue_comment`,
  `sub_issue_write`, `list_issue_types`, `list_issue_fields`, `assign_copilot_to_issue`.
- Code/repo: `get_file_contents`, `create_or_update_file`, `push_files`, `delete_file`,
  `create_branch`, `list_branches`, `get_commit`, `list_commits`, `search_code`,
  `search_commits`, `search_repositories`, `create_repository`, `fork_repository`,
  `list_repository_collaborators`, `get_tag`/`list_tags`, releases (`get_latest_release`,
  `get_release_by_tag`, `list_releases`).
- Actions/CI: `actions_list`, `actions_get`, `actions_run_trigger`, `get_job_logs`,
  `run_secret_scanning`, copilot job status.
- PR-activity subscription: `subscribe_pr_activity`, `unsubscribe_pr_activity`.
- Identity: `get_me`, `get_teams`, `get_team_members`, `search_users`.

### Notion (16, R/W) — vault, COO Tasks, Bucket Briefings, bootstrap docs
`notion-search`, `notion-fetch`, `notion-create-pages`, `notion-update-page`,
`notion-duplicate-page`, `notion-move-pages`, `notion-create-database`,
`notion-update-data-source`, `notion-query-database-view`, `notion-create-view`,
`notion-update-view`, `notion-query-meeting-notes`, `notion-create-comment`,
`notion-get-comments`, `notion-get-teams`, `notion-get-users`.

### PostHog (1 meta-tool `exec`, R/W) — PRIMARY observability ($50k)
Single `mcp__PostHog__exec` over domains: insight, query, execute-sql, dashboard,
feature-flag, experiment, error-tracking, session-recording, survey, web-analytics,
persons, cohorts, llm-analytics, etc. CAUTION: active project defaults to **MedReview (PHI)
468398** — switch to a non-PHI project before any work. Per-app project ids in
`PLUGINS-MARKETPLACE-AUDIT.md` / cto CLAUDE.md.

### Stripe (11, R/W) — payments
`stripe_api_read`, `stripe_api_write`, `stripe_api_search`, `stripe_api_details`,
`search_stripe_resources`, `fetch_stripe_resources`, `get_stripe_account_info`,
`create_refund`, `stripe_implementation_planner`, `search_stripe_documentation`,
`send_stripe_mcp_feedback`.

### Shopify (25, R/W) — otchealthmart.com storefront
Products: `search_products`, `get-product`, `create-product`, `update-product`,
`bulk-update-product-status`. Collections: `search_collections`, `get-collection`,
`create-collection`, `update-collection`, `add-to-collection`. Orders/customers:
`list-orders`, `get-order`, `list-customers`. Inventory: `get-inventory-levels`,
`set-inventory`. Discounts: `create-discount`. Analytics: `run-analytics-query`.
GraphQL: `graphql_query`, `graphql_mutation`, `graphql_schema`, `validate_graphql_codeblocks`.
Store setup: `get-new-store-previews`, `get-shop-info`, `switch-shop`, `search_docs_chunks`.

### Sentry (9, R/W) — secondary observability (crash/release health, Seer autofix)
`find_organizations`, `find_projects`, `search_issues`, `search_events`, `update_issue`,
`get_sentry_resource`, `analyze_issue_with_seer`, `search_sentry_tools`, `execute_sentry_tool`.

### n8n (28, R/W) — production automation (self-host automation.otchealth.app)
Workflows: `search_workflows`, `get_workflow_details`, `create_workflow_from_code`,
`update_workflow`, `publish_workflow`, `unpublish_workflow`, `archive_workflow`,
`execute_workflow`, `test_workflow`. Build aids: `get_sdk_reference`, `get_node_types`,
`search_nodes`, `get_suggested_nodes`, `validate_node_config`, `validate_workflow`,
`prepare_test_pin_data`. Executions: `search_executions`, `get_execution`. Data tables:
`create/rename/search_data_tables`, `add/delete/rename_data_table_column`, `add_data_table_rows`.
Org: `search_projects`, `search_folders`, `list_credentials`.

### Customer_io (8, R/W) — lifecycle CRM (ws 193366)
`cio_read_api`, `cio_write_api`, `cio_delete_api`, `cio_schema`, `cio_auth_status`,
`cio_prime`, `cio_skills_list`, `cio_skills_read`. (Skill-driven; read its skills first.)

### Cloudflare_Developer_Platform (23, R/W) — D1/KV/R2/Workers/Hyperdrive
D1: `d1_databases_list`, `d1_database_get/create/delete/query`. KV: `kv_namespaces_list`,
`kv_namespace_get/create/update/delete`. R2: `r2_buckets_list`, `r2_bucket_get/create/delete`.
Hyperdrive: `hyperdrive_configs_list`, `hyperdrive_config_get/edit/delete`. Workers:
`workers_list`, `workers_get_worker`, `workers_get_worker_code`. Docs:
`search_cloudflare_documentation`, `migrate_pages_to_workers_guide`. (DNS/email routing for
the fleet is in the GATEWAY, Section 2.)

### Microsoft_365 (7, R) — COO Outlook/Teams/SharePoint nervous system
`outlook_email_search`, `outlook_calendar_search`, `find_meeting_availability`,
`chat_message_search`, `sharepoint_search`, `sharepoint_folder_search`, `read_resource`.

### Microsoft_Learn (3, R) — Azure/.NET docs (key for the Azure migration)
`microsoft_docs_search`, `microsoft_code_sample_search`, `microsoft_docs_fetch`.

### Gmail (12, R/W) — mail ops
`search_threads`, `get_thread`, `create_draft`, `list_drafts`, labels
(`list/create/update/delete_label`, `label/unlabel_message`, `label/unlabel_thread`).

### Intercom (13, R/W) — support + KB (Fin)
`search`, `fetch`, `search_conversations`, `get_conversation`, `search_contacts`,
`get_contact`, `list_companies`, `get_company`, `list_articles`, `search_articles`,
`get_article`, `create_article`, `update_article`.

### Netlify (9, R/W) — INND site + deploys (reader/updater pairs)
`get-netlify-coding-context`, `netlify-{project,deploy,extension,team}-services-reader`,
`netlify-{project,deploy,extension}-services-updater`, `netlify-user-services-reader`.

### Twilio (2, R) — procedural API knowledge for the voice/SMS fleet
`twilio__search`, `twilio__retrieve`. (Operate live flows via the voice-ops skill + n8n.)

### HeyGen (~48, R/W) — avatar/video on the SUBSCRIPTION (never the paid API)
Video: `create_video_agent`, `create_video_from_avatar/image/cinematic_avatar`,
`create_video_translation`, `list/get/delete_video(s)`, session tools
(`get/list_video_agent_session(s)`, `send_video_agent_message`, `stop_video_agent_session`,
`list_video_agent_styles`). Avatars: `create_photo_avatar`, `create_prompt_avatar`,
`create_avatar_consent`, `create_digital_twin`, avatar group/look CRUD. Voice: `clone_voice`,
`design_voice`, `create_speech`, `list/get_voice(s)`. Lipsync + assets + brand kits/glossaries.

### Hyperframes (6, R/W) — programmable HTML video (HeyGen)
`compose`, `render_video`, `list_projects`, `get_project`, `get_project_status`,
`get_render_status`. (From a CLI agent, author with the local hyperframes skill; compose/render
disabled there.)

### Canva (~38, R/W) — design automation (non-PHI ring)
Designs: `search-designs`, `get-design`, `generate-design(-structured)`, `create-design-from-*`,
`copy-design`, `merge-designs`, `resize-design`, `export-design`, `get-design-content/pages/thumbnail`.
Brand templates: `search/get-brand-template*`, `create-brand-template-draft`, `publish-brand-template`,
`list-brand-kits`. Assets/folders/comments + editing transactions (`start/commit/cancel-editing-transaction`,
`perform-editing-operations`).

### Miro (~37, R/W) — boards/diagrams
`board_create/search_boards/list_items`, `diagram_create/get_dsl`, `doc_create/get/update`,
`image_*`, `table_*`, `code_widget_*`, `connector_create`, `comment_*`, `layout_*`,
`prototype_*`, `context_get/explore`.

### Mercury (~30, R) — banking (READ-ONLY)
Accounts: `getAccounts`, `getAccount`, `getAccountCards`, `getAccountStatements`.
Transactions: `listTransactions`, `getTransaction(ById)`, `listCategories`. Recipients:
`getRecipients`, `getRecipient`. Treasury: `getTreasury`, `getTreasuryTransactions/Statements`.
Invoices/customers/credit/approvals/webhooks/org/users. Always `getCurrentDate` first; paginate fully.

### Intuit_QuickBooks (~50, R/W) — accounting + payroll
Reports: balance sheet, P&L (`profit_loss_generator`/`_quickbooks_account`), cash flow,
AR/AP aging, sales-by-customer/product, benchmarking. Sales: invoices + estimates +
payment links (get/create/update/delete/duplicate/send). Catalog: products. Contacts:
customers. Payroll: employees, payslips, deductions, pay types, time off. Transaction import.

### AWS_Marketplace (6, R) — solution research (NOT our compute; Azure/GCP is our stack)
`search_aws_marketplace_solutions`, `get/research_aws_marketplace_solution`,
`get_aws_marketplace_related_solutions`, report guidelines, feedback.

### Composio (7, R/W) — LAST-RESORT bridge to other SaaS
`COMPOSIO_SEARCH_TOOLS`, `COMPOSIO_GET_TOOL_SCHEMAS`, `COMPOSIO_MULTI_EXECUTE_TOOL`,
`COMPOSIO_MANAGE_CONNECTIONS`, `COMPOSIO_WAIT_FOR_CONNECTIONS`, `COMPOSIO_REMOTE_BASH_TOOL`,
`COMPOSIO_REMOTE_WORKBENCH`. Use only when no direct API/MCP exists.

### claude-code-remote (session/repo control)
`list_repos`, `add_repo` (expand session repo scope), `send_later` (self check-ins),
plus the GitHub PR-activity subscription tools above.

NOT connected (route via the gateway or pending operator connect): Depot (CLI/Actions +
gateway module), RevenueCat (OAuth-allowlist-gated; v2 API skill is the working layer),
Azure (portal + Microsoft Learn MCP + the azure-sp SP; ARM via REST), Firebase, Neon
(connected per Matt). See `PLUGIN-LAUNCH-PLAN.md` Wave 2.

---

## 2. UNIFIED GATEWAY — `otchealth-mcp-server` (41 tools, our custom MCP)
One endpoint (`https://mcp.otchealth.app/mcp`, OAuth) fronting the stack with strict Zod
input, a compliance guardrail, audit logging, and scope gating (READ_ONLY_MODE /
ENABLE_WRITE_TOOLS / ENABLE_HIGH_RISK_TOOLS / DRY_RUN_DEFAULT). PHI carved OUT. Full design +
add-a-module recipe: `otchealth-mcp-server/docs/UNIFIED-FLEET-GATEWAY.md`. Status: code on
main; pending Azure redeploy + env (Matt gate).

- **Customer.io (13)**: `cio_list_newsletters`, `cio_get_newsletter`, `cio_get_newsletter_metrics`,
  `cio_get_newsletter_schedule`, `cio_get_segment`, `cio_list_segment_people`, `cio_get_customer`,
  `cio_get_template_or_content`, `cio_get_broadcast_history_for_segment`, `cio_track_event` (W),
  `cio_update_customer_attributes` (W), `cio_update_newsletter_variant` (W-orchestrated),
  `cio_duplicate_newsletter` (W-orchestrated).
- **Cloudflare (6)**: `cloudflare_list_dns_records`, `cloudflare_create_dns_record` (W),
  `cloudflare_list_email_destinations`, `cloudflare_add_email_destination` (W),
  `cloudflare_list_email_rules`, `cloudflare_create_email_rule` (W).
- **Microsoft Graph (2)**: `graph_list_messages`, `graph_send_email` (W, COO send-as).
- **Stripe read (5)**: `stripe_get_balance`, `stripe_list_charges`, `stripe_list_customers`,
  `stripe_list_payment_intents`, `stripe_list_products`.
- **Shopify (4)**: `shopify_list_products`, `shopify_get_product`, `shopify_get_order`,
  `shopify_list_abandoned_checkouts`.
- **Intercom (2)**: `intercom_list_articles`, `intercom_get_article`.
- **n8n meta (2)**: `n8n_list_workflows`, `n8n_get_execution`.
- **Netlify read (2)**: `netlify_list_sites`, `netlify_list_site_deploys`.
- **Gumroad read (2)**: `gumroad_list_products`, `gumroad_list_sales` (buyer PII omitted).
- **Capability Catalog (3)**: `catalog_list_tools`, `catalog_service_capabilities`,
  `catalog_audit_unused` — the gateway self-describes (tools auto-register; audit surfaces
  un-wired surface). Run `catalog_audit_unused` to see the live backlog.
- **BACKLOG (not yet built)**: Depot (builds/cache/grant-burn), PostHog-management (PHI carve-out
  + build-failing test), RevenueCat, Twilio+ElevenLabs, GitHub passthrough, Azure/Firebase modules.

---

## 3. SKILLS (`Skill` tool; installed by session-start.sh)
aso-growth, content-engine, coo, daily-briefing, designer, devkit, digital-products,
eval-runner, grant-tracker, growth-pr, ir-support, lifecycle-crm, monetization, paid-ads,
partnerships, raise-ops, release-conductor, scaffolder, storefront-cro, supply-chain-guard,
telemetry-wiring, test-author, voice-ops. Plus the fleet utility + ops skills: **pdf**
(OCR read + create), **legal** (CLO citation verifier + Azure matter/docket store),
**skills-discovery** (search the 50k-skill claude-plugins.dev registry on demand; the
fleet meta-skill), amazon-sp-api, quickbooks, xero, cfo-store, cfo-onedrive, m365-mail,
plaid-banking, github-app, innd-stock, **datadog** (observability: Azure infra + APM + logs +
synthetics, $100k credit; site us3; PHI wall on MedReview/Companion until a Datadog BAA).
(Descriptions + which agent wields each:
`SKILLS-CAPABILITY-MAP.md`.) Plus QA sub-skills (api-qa, ios-qa, web-qa, static-qa,
phi-compliance-qa, release-readiness, test-suite-runner, persona-focus-group(-buyers)) and the
Capacitor/Ionic packs, available when their plugins/skills load.
- **FLEET INTELLIGENCE + THE SHARED SUPER-BRAIN (use these first, every session):**
  - **kb-memory** — the durable shared ledger that beats compaction. `mem.mjs remember|decision|
    correct|pitfall|status|recall|team`; `semantic.mjs recall` (recall by MEANING); `reflect.mjs`
    auto-extracts lessons at session end. RECALL before you assert; `--share` non-sensitive cross-team
    facts. The source of truth.
  - **company-brain** — `brain.mjs ask "<q>"`: one cited answer federated across every data room
    (memory-exec, legal-company, finance, commerce, journal). The Billion Dollar Brain. Ask it before
    researching. legal-personal excluded unless `--include-personal --agent clo`; answers are internal.
  - **agent-evals** + **fleet-telemetry** — golden-task quality scoring + per-session LLM observability
    into PostHog "Fleet Agents" 479484 (Fleet Intelligence #1).
  - **focus-group-loop** + **shark-tank** — 20-persona product review (10 customers, 5 pros, 5 real
    Shark-Tank AI twins) to a 90% gate; `--catalog` feeds the brain.
  - **browser-agent** — hardened headless-Chromium for OAuth consents / signups / portal clicks
    (autonomous on non-financial consents; hard gates stay human).
  - **doc-indexer** + the data-room **librarians** — index/understand/push-search any document store
    into Azure AI Search (the rooms the brain federates).
  - **THE PROTOCOL:** `dream-team/SUPER-BRAIN-PROTOCOL.md` (the paste-ready onboarding prompt: stay
    current via `setup/octools-version.sh` -> DRAW from the brain -> FEED write-through -> rings).
    Model routing: `dream-team/MODEL-ROUTING.md`. Autonomy runners: `runbooks/overnight-autonomy.md`.
- **Stay current:** a long-running session can run `bash /tmp/octools/setup/octools-version.sh` to
  detect it is on stale toolkit code, and refresh.
- **Expanding the toolkit:** `skills-discovery` lets any agent find expert skills it was
  not shipped with. The curated agent-by-agent shopping list (which registry skills to
  adopt for builders + the executive team, with risk tags + the vendor-not-npx adoption
  model) is **`FLEET-SKILLS-RECOMMENDATIONS.md`**.

## 4. PLUGINS (13; official marketplace `claude-code-plugins` = anthropics/claude-code)
Each ships agents/commands/skills (namespaced `<plugin>:<component>`):
- **code-review** — `/code-review`; multi-agent PR review.
- **pr-review-toolkit** — `/review-pr` + agents: code-reviewer, code-simplifier, comment-analyzer,
  pr-test-analyzer, silent-failure-hunter, type-design-analyzer.
- **feature-dev** — `/feature-dev` + agents: code-architect, code-explorer, code-reviewer.
- **commit-commands** — `/commit`, `/commit-push-pr`, `/clean_gone`.
- **frontend-design** — `/frontend-design` (production-grade UI).
- **hookify** — `/hookify`, `/configure`, `/list` + conversation-analyzer agent + writing-rules skill.
- **plugin-dev** — `/create-plugin` + agents (agent-creator, plugin-validator, skill-reviewer) +
  skills (plugin/agent/command/hook/mcp/skill development, plugin-settings).
- **agent-sdk-dev** — `/new-sdk-app` + verifier agents (py/ts) for the Claude Agent SDK.
- **security-guidance** — edit-time security warning hook.
- **ralph-wiggum** — iterative self-loop dev.
- **explanatory-output-style**, **learning-output-style** — available, opt-in via `/output-style`.
- **claude-opus-4-5-migration** — moot on Opus 4.8 (installed for completeness).
Curation rationale + the connector/role-pack waves: `PLUGINS-MARKETPLACE-AUDIT.md`, `PLUGIN-LAUNCH-PLAN.md`.
- **Official Anthropic Agent Skills** (marketplace `anthropic-agent-skills` = `anthropics/skills`,
  added 2026-06-18): **document-skills** (xlsx/docx/pptx/pdf, real Office authoring) +
  **example-skills** (canvas-design, mcp-builder, brand-guidelines, doc-coauthoring, webapp-testing,
  skill-creator, frontend-design, ...). These are LICENSED (not redistributable), so they install
  via the marketplace, never vendored. Wired in `.claude/settings.json` + `session-start.sh`.
- **wshobson `claude-code-workflows`** (MIT, 84 plugins, added 2026-06-18): autoUpdate OFF
  (third-party, reviewed at cc37bfd). 21 best skills vendored into `skills/`; only a curated,
  human-approved plugin set enabled: **hr-legal-compliance** (CLO: legal-advisor + hr-pro agents)
  + **security-compliance** (guardian: security-auditor agent + compliance-check). Rest install
  on demand; see `FLEET-SKILLS-RECOMMENDATIONS.md`.
- **Context7 MCP** (added 2026-06-18, user scope via `session-start.sh`): live, version-pinned
  library docs (`https://mcp.context7.com/mcp`, keyless). The top builder add - eliminates
  hallucinated package APIs. Surgical add (held the ~40-50 active-tool ceiling in mind).

## 5. DREAM TEAM AGENTS (19; `Agent` tool; installed by session-start.sh)
architect, builder, capital, coach, commerce, compliance-officer, coo, creative,
digital-products, finance-ops, growth-exposure, growth, guardian, lifecycle, medic, qa,
rainmaker, release-captain, switchboard. Plus the FourVault reviewers (coppa-kidsafety,
schema-migration, security) and the built-in Explore/Plan. Roster + interconnect:
`dream-team/` (roster + interconnect docs).

---

## Related deep docs (keep in sync with this index)
- `FLEET-CAPABILITY-MAP.md` — connector inventory + status reconciliation.
- `SKILLS-CAPABILITY-MAP.md` — per-skill detail + owning agent.
- `PLUGINS-MARKETPLACE-AUDIT.md` — the ~90-plugin marketplace audit (adopt/skip + governance).
- `PLUGIN-LAUNCH-PLAN.md` — the 3-mechanism rollout (plugins/connectors/role packs) + status.
- `otchealth-mcp-server/docs/UNIFIED-FLEET-GATEWAY.md` — gateway design + backlog.
- `otchealth-cto/runbooks/azure-migration-runbook.md` — the GCP->Azure program.

> Maintenance: regenerate connector tool lists from the live session tool registry; gateway
> tools from `otchealth-mcp-server/src/tools/`; skills from `skills/`; plugins from
> `claude plugin list`; agents from `dream-team/agents/`. Update the date line on change.
