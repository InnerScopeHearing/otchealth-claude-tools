# CLO Triage Log

Append-only session log for the Chief Legal Officer agent. Records the durable
state of the matter book (which itself lives in the Azure legal store, off git),
verified authorities, and the open action items. Confidential personal-matter
FACTS are never written here, only the matter exists + jurisdiction + non-sensitive
action items (the same level already in CLO-BOOTSTRAP.md).

---

## 2026-06-18 — Bootstrap session (matter book initialized)

The Azure legal store (`otchealthlegalstore`, containers `company` / `personal`)
was empty on come-online. Opened the matter files for the known/expected matters
from the bootstrap. No court deadlines were fabricated: every dated docket entry
below is a clearly-labeled SELF-SET ACTION tickler, not a statutory or court
deadline. Real deadlines get calendared only after the docket / source documents
are pulled.

### Company matters (container: company)
- `corp-sec-ainnova` — OTCHealth / INND. Ainnova Tech acquisition (announced
  2025-10-22) disclosure + materiality timing; INND public-co reporting; Reg FD /
  Section 16 / 17(b) hygiene. Securities firewall: PSLRA safe harbor unavailable
  (penny stock) -> bespeaks-caution; not a shell -> Rule 144(i) n/a.
- `ga-flsa-backwage` — OTCHealth (defendant). FLSA back-wage / overtime collective,
  N.D. Ga. Gainesville, likely 29 U.S.C. 216(b) opt-in. Exposure = back wages +
  equal liquidated damages + mandatory plaintiff fees; SOL 2yr / 3yr if willful
  (29 U.S.C. 255(a)). Litigation hold + payroll reconstruction (Mark OneDrive + CFO).
- `corp-housekeeping` — OTCHealth / INND / HearingAssist. NV annual lists (NRS 78),
  minutes, consents, related-party / due-to-officer agreements (coordinate w/ CFO).
- `legacy-settlements` — tracking Shennib / Naylor / Bender standstill/tolling +
  settlement agreements (source docs in Mark Moore's OneDrive). No deadlines until
  the source agreements are read.

### Personal matters (container: personal — CONFIDENTIAL, never committed)
- `ca-divorce` — CA Family Code dissolution + community-property division.
- `ca-civil` — CA civil (CCP / Evidence Code).
(Facts held only in the personal Azure container.)

### Verified authority (CourtListener, this session)
- Hoffmann-La Roche Inc. v. Sperling, 493 U.S. 165 (1989) — courts may facilitate
  216(b) opt-in notice. VERIFIED exists.
- McLaughlin v. Richland Shoe Co., 486 U.S. 128 (1988) — "willful" under
  29 U.S.C. 255(a) = knew or reckless disregard (3-yr SOL trigger). VERIFIED exists.
  (Confirm holdings remain good law before any brief.)

### Open action items (next session) — all routed to counsel + Matt
1. GA FLSA: pull the N.D. Ga. Gainesville docket (CourtListener / RECAP / PACER);
   capture case no., parties, service date, responsive-pleading deadline +
   scheduling order; THEN docket the real deadlines. Confirm a written litigation
   hold has issued to all custodians.
2. CORP/SEC: confirm with counsel whether an 8-K / required disclosure issued for
   the Ainnova transaction; reconstruct the materiality + disclosure-timing
   chronology; review Section 16 / Reg FD hygiene since 2025-10-22.
3. CORP housekeeping: confirm Nevada SOS annual-list due dates + good-standing for
   OTCHealth, INND, HearingAssist.
4. Personal: collect case numbers, courts, posture, and any pending dates from Matt
   for both the divorce and the civil matter; then docket real deadlines.
5. Legacy settlements: retrieve Shennib / Naylor / Bender agreements from OneDrive;
   index; confirm any tolling expirations / standstill milestones.
