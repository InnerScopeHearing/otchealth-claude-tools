# OTChealth Icon System — 2026-07-16

Hand-authored SVG asset set for OTCHealthMart, built by Folio. All 18 files are pure vector (no raster/PNG), designed to be dropped straight into Shopify theme Liquid files or referenced as static assets.

## Palette
- Warm Bone `#F7F1E4` — canvas
- Warm Ink `#241F19` — line work, primary text
- Terracotta Clay `#B5603C` — the one accent, used once per icon, never as a large fill

## Typography (for text inside diagrams/badges)
- Fraunces (upright) — display numerals/headlines (`'Fraunces', Georgia, serif`)
- Inter — labels, category names (`'Inter', sans-serif`)
- IBM Plex Mono — data, disclosures, small caps labels (`'IBM Plex Mono', 'Courier New', monospace`)

These are fallback-safe: they degrade gracefully to the fallback fonts if the page doesn't already load the Google Fonts (OTCHealthMart's theme does).

## icons/ (11 files)
| File | Description |
|---|---|
| icon-submenu-treo-amplify.svg | iHEAR TReO — source dot + 3 radiating amplify arcs, outermost in terracotta |
| icon-submenu-ihear-certified.svg | iHEAR — BTE-style device hook + terracotta certified-check badge |
| icon-submenu-hearingassist-case.svg | HearingAssist — charging/carrying case with terracotta charge indicator |
| icon-submenu-guarantee-shield.svg | Our Guarantee — shield outline + terracotta checkmark (no person silhouette) |
| icon-submenu-help-center-chat.svg | Help Center — chat bubble + terracotta question mark (no envelope) |
| icon-submenu-hearing-test.svg | Hearing Test — 4 soundwave bars + terracotta verified badge |
| icon-faq-accordion-closed.svg | FAQ accordion — chevron down, neutral ink (collapsed state) |
| icon-faq-accordion-open.svg | FAQ accordion — chevron up, terracotta (active/expanded state) |
| icon-star-filled.svg | Star rating — fully filled, terracotta |
| icon-star-half.svg | Star rating — half filled via clip-path, terracotta + ink outline |
| icon-star-empty.svg | Star rating — outline only, ink |

All 6 submenu icons share one stroke weight (1.75px) and corner language (round caps/joins), 24×24 viewBox, and use Terracotta Clay exactly once per icon as a small accent (a badge, checkmark, dot, or single arc) — never as a dominant fill.

## badges/ (5 files) — for the Guarantee page
| File | Description |
|---|---|
| badge-guarantee-75-day.svg | 75-day money-back seal |
| badge-free-shipping.svg | Free shipping seal |
| badge-secure-checkout.svg | Secure checkout / padlock seal |
| badge-heritage-since-1947.svg | Heritage seal, "Since 1947" |
| badge-trust-rating.svg | Generic customer-rated seal — deliberately plain-circle, 5-star + wording only. Does NOT use a scalloped/ribbon edge, a torch icon, or "Accredited Business" language, so it never reads as the actual BBB mark. |

All badges: 96×96 viewBox, Warm Bone fill, Warm Ink outline, Terracotta Clay accent element.

## diagrams/ (2 files) — product-agnostic, general education
| File | Description |
|---|---|
| diagram-hearing-aid-styles.svg | BTE / RIC / ITE / CIC style guide — 4 simplified canal cross-sections with the device silhouette highlighted in terracotta at the correct depth/position for each style, labeled with abbreviation, full name, and a one-line descriptor. |
| diagram-hearing-loss-severity-scale.svg | 5-band severity scale (Normal 0–15 dB, Mild 16–40 dB, Moderate 41–60 dB, Severe 61–80 dB, Profound 81+ dB) as a single-hue terracotta ramp from light to Warm Ink, per OTCHealthMart's existing severity-band convention. Both diagrams carry a small "for general education only" footnote and make no product-specific or brand-specific claims. |

## Notes
- No AI-generated raster imagery anywhere in this set — every file is hand-authored SVG markup, chosen deliberately so nothing here is binary/uncommittable as text.
- Star, badge, and diagram geometry is original and generic (not traced from any third-party icon set or seal design).
