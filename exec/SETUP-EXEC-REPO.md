# Set up the otchealth-exec repo — step by step (Matt action)

This is the private home repo for the four business chiefs: CRO, CFO, CCO, CPO.
Do this once, then launch each chief session on it.

## Step 1 — Create the repo (60 seconds)

1. GitHub > New repository
2. Owner: `InnerScopeHearing`
3. Name: `otchealth-exec`
4. **Private** (must be private; holds business strategy, compliance findings, financial notes)
5. Initialize with README
6. Click **Create repository**

## Step 2 — Create the folder structure

Once created, add these empty placeholder files (GitHub won't show empty folders).
You can use the GitHub UI ("Add file" > "Create new file") or the CTO can do it:

- `cro/.keep`
- `cfo/.keep`
- `cco/.keep`
- `cpo/.keep`

## Step 3 — Launch each chief session in Claude Code

Each chief is a SEPARATE Claude Code session pointing at `InnerScopeHearing/otchealth-exec`.

**Recommended launch order (fastest cash first):**

### 1. CRO (Rainmaker) — launch first
- Environment repo: `InnerScopeHearing/otchealth-exec`
- Paste prompt from: `exec/CRO-PROMPT.md` in otchealth-claude-tools
- First task: pick up the reactivation cadence + get the Shopify real numbers

### 2. CFO (Finance) — launch second
- Environment repo: `InnerScopeHearing/otchealth-exec`
- Paste prompt from: `exec/CFO-PROMPT.md`
- First task: build the cash scoreboard (bank, burn, runway, grant burn rates, vendor watchlist)

### 3. CCO (Compliance) — launch third
- Environment repo: `InnerScopeHearing/otchealth-exec`
- Paste prompt from: `exec/CCO-PROMPT.md`
- First task: review the 85K reactivation copy + Gumroad listings; clear or flag

### 4. CPO (Product) — launch last (lowest urgency at $0 runway)
- Environment repo: `InnerScopeHearing/otchealth-exec`
- Paste prompt from: `exec/CPO-PROMPT.md`
- First task: triage the 8-app portfolio; recommend 1-2 to keep active, pause the rest

## Step 4 — Set GitHub access for each chief session

In each session's environment settings on claude.ai/code:
- **Repository access:** `InnerScopeHearing/otchealth-exec` (write) + read access to all
  other repos (the chiefs need to read across the portfolio but write goes to their home repo)

The COO scope model (`coo/ACCESS-MODEL.md`) applies here too: business chiefs ingest
untrusted input (email, market data), so broad write access is not needed. Narrow is safer.

## Step 5 — Fast-follow: per-role mailboxes

Once any chief is live, provision its mailbox to mirror the COO pattern:
- `cro@innd.com`, `cfo@innd.com`, `cco@innd.com`, `cpo@innd.com`
- Set display names: "Chief Revenue Officer", "Chief Financial Officer", etc.
- Add an inbound-wake n8n loop for each (same pattern as the COO loop, `B0bYgelXujDmO7WC`)
- Until then: CC/BCC `coo@innd.com`; the COO routes items to the right chief

## What the COO can do from here

All four chiefs are already wired into the Notion loop:
- **Dispatch DOWN:** COO Tasks DB, title prefix `DISPATCH -> CRO:` / `CFO:` / `CCO:` / `CPO:`
- **Briefings UP:** Bucket Briefings DB, Bucket = "CRO / Revenue" / "CFO / Finance" / etc.

The COO already has opening dispatch packets ready for each chief in the COO Tasks DB.
Each chief reads those on first launch.
