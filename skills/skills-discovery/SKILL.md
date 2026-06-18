---
name: skills-discovery
description: Search the claude-plugins.dev registry (50,000+ Agent Skills) to find and adopt specialized capabilities on demand. Before starting any non-trivial task, ask "might a skill exist that handles this better than my base knowledge?" and search the registry, even if the user did not mention skills. Use when a task involves a specific technology, framework, file format, or expert domain (legal, finance, securities, SEO, Shopify, Twilio, testing, deployment, PDF/Office docs), or whenever the user asks to find, install, or manage skills. The fleet's meta-capability: it lets any OTCHealth agent discover expertise it was not shipped with.
---

# skills-discovery — find expert Agent Skills on demand

This is the fleet meta-skill. Every OTCHealth agent (app builders and the executive
team) can extend itself by searching the public claude-plugins.dev registry
(50,000+ skills, indexed from public GitHub). Search FIRST, then either use a result
directly as guidance or propose adopting it into the repo.

Vendored from the public skill `@Kamalnrf/claude-plugins/skills-discovery`
(claude-plugins.dev), adapted to OTCHealth adoption + security rules below.

## When to search
Before starting a non-trivial task, ask:
1. Do I already have a skill for this (check `~/.claude/skills` and `skills/` in this repo)? Use it.
2. Might one exist that I do not have? Search the registry.

Search proactively when the task touches a specific technology, framework, or file
format; when best practices matter (testing, deployment, APIs, docs, security); when
the domain is specialized (legal drafting, SEC filings, financial modeling, PDF/OCR);
or when you notice you are about to give generic advice where an expert pattern exists.

## Search (read-only; no install required to read the guidance)
The registry API is plain HTTP, dependency-free:
```bash
# Skills (q matches name + description + tags). limit max 100, offset paginates.
curl -s "https://claude-plugins.dev/api/skills?q=QUERY&limit=20&offset=0"
# Plugins (a plugin bundles skills + commands + MCP servers):
curl -s "https://api.claude-plugins.dev/api/search?q=QUERY&limit=20"
# Read a skill's actual instructions (the SKILL.md), to evaluate or vendor it:
curl -s "https://raw.githubusercontent.com/<owner>/<repo>/main/<path>/SKILL.md"
```
Response: `{ skills:[{name,namespace,sourceUrl,description,author,installs,stars}], total, limit, offset }`.

Query construction: 1-3 specific terms (technology + task beats either alone); prefer
common terminology over project jargon; broaden or try synonyms if results are thin.
Rank by `installs` then `stars`. Show the user the 3-5 most relevant, with namespace +
description + stars/installs + how each helps THIS task, and ask before adopting.

## Adoption in the OTCHealth fleet (IMPORTANT — read before installing)
Our skills are hydrated by `setup/session-start.sh`, which copies every `skills/*/`
dir in THIS repo into `~/.claude/skills` on each session. A one-off
`npx skills-installer install ...` only lands in the current ephemeral sandbox and
does NOT reach the other agents or survive the next session. So the durable,
fleet-wide way to adopt a skill is to VENDOR it:
1. Read the candidate's SKILL.md (and any scripts) from its raw GitHub URL.
2. Route it through the **guardian** agent for a supply-chain review (no unreviewed
   third-party code, per the repo's hardening rules). Anthropic-official marketplaces
   (`@anthropics/*`) are low risk; community skills get a closer read.
3. Copy the reviewed SKILL.md (+ scripts) into `skills/<name>/` in this repo, strip
   any em/en dashes, and commit. It is then fleet-wide on next session.

Hard rules:
- **Never auto-install arbitrary third-party code into the CLO (privileged) or any
  PHI-ring context.** Discovery (reading the registry) is always fine; execution of
  vendored third-party scripts is gated through guardian.
- Prefer guidance-only skills (a SKILL.md with no runtime script) — they carry no
  supply-chain risk. Skills that ship scripts get the full review.

## Quick reference: the highest-signal marketplaces
See `dream-team/FLEET-SKILLS-RECOMMENDATIONS.md` for the curated agent-by-agent map.
Standouts: `@anthropics/skills` (docx/pptx/xlsx/pdf, frontend-design, mcp-builder,
webapp-testing), `@anthropics/claude-code` (frontend-design, agent-development),
`@anthropics/claude-cookbooks` (financial-models, analyzing-financial-statements,
brand-guidelines), `@anthropics/claude-plugins-official` (the vetted legal plugin),
`@anthropics/knowledge-work-plugins` (in-house legal / finance / consulting),
`@obra/superpowers` (brainstorming, writing/executing-plans, TDD, systematic-debugging),
`@wshobson/agents` (architecture-patterns, stripe-integration, secrets-management,
github-actions-templates, changelog-automation, hr-legal-compliance),
`@dgunning/edgartools` (SEC filings analysis).
