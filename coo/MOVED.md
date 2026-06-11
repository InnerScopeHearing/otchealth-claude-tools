# COO operational files have moved

All files that were in this folder have moved to the PRIVATE repo:
**InnerScopeHearing/otchealth-exec/coo/**

This public repo (otchealth-claude-tools) still holds:
- `CLAUDE.md` -- the shared agent OS context, read by ALL sessions on startup
- `dream-team/` -- agent definitions and the Dream Team skill pack
- `app-kit/` -- portable app lifecycle kits
- `setup/` -- session-start installer scripts
- `exec/` -- NOTE: exec/ prompts also migrating to otchealth-exec (CTO dispatch pending)

**COO sessions now launch on `otchealth-exec`, not this repo.**

The CLAUDE.md in this repo is still the first thing every session reads (it is the
shared agent OS ground truth). Only the COO's operational state (SITUATION, PRIORITIES,
log, today, dispatch protocols) moved to the private repo.
