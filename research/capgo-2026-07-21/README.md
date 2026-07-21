# Capgo research pack, 2026-07-21

Raw research reports from a Capgo (Capacitor OTA + plugin ecosystem) research
pass. Saved here per the fleet SOP: raw research findings land in the repo
under `research/<topic>-<date>/` and are also mirrored to the Azure commons
`_DOCS` store for brain indexing.

## Index

- `01-marketplace-skills-A.md`. Cap-go/capgo-skills Claude Code skill
  marketplace, first half alphabetically (`capacitor-accessibility` through
  `capgo-release-workflows`, 34 of 49 total skill directories). Full read of
  every SKILL.md plus reference files for the two skills that ship references.

- `02-marketplace-skills-B-plus-meta.md`. Same marketplace, second half
  (`cocoapods-to-spm` through `webapp-to-capacitor`, 15 skills), plus
  marketplace-level meta (manifest structure, lint scripts). Combined with
  01, this is a full skill-by-skill review of all 49 skills in the
  Cap-go/capgo-skills marketplace.

- `03-capgo-plugins-web.md`. The live capgo.app/plugins catalog: 150 plugins
  across 13 categories enumerated, 58 individually deep-dived (npm package
  name, description, platforms, install command, key API methods, caveats).
  Cross-referenced against the fleet's existing plugin usage
  (`@capgo/capacitor-updater` fleet-wide, plus iHEARtest's extra plugins).

- `04-capgo-cloud-docs.md`. Capgo's cloud platform documentation: CLI
  reference (bundle/channel/app commands), self-hosted encrypted bundles,
  custom storage for live updates, and the FAQ.

- `05-fleet-adoption-architecture.md`. The actionable synthesis. Builds a
  skill x app/exec matrix across the 8-app OTCHealth/InnerScope Capacitor
  fleet (iHEARtest, AWARE, OTCHealth Companion, FourVault, Flatstick,
  InnerEase, Fictionary, PlantID), a deployment plan, and flags for
  name/tooling collisions with the fleet's existing skill set. This is the
  file to read first if you want the "so what do we do" answer; 01-04 are
  its source material.

All five files were produced in a single research session on 2026-07-21.
No em dashes are used in any of the files (house style).
