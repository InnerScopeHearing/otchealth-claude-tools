# Capgo Cloud Platform Documentation, Raw Research Report

Date: 2026-07-21

Sources:
- https://capgo.app/docs/ (docs home, note: docs.capgo.app subdomain does NOT resolve via DNS; the real base is capgo.app/docs/)
- https://capgo.app/docs/cli/overview/
- https://capgo.app/docs/cli/reference/ (CLI command index)
- https://capgo.app/docs/cli/reference/bundle/
- https://capgo.app/docs/cli/reference/channel/
- https://capgo.app/docs/cli/reference/app/
- https://capgo.app/docs/cli/commands/key/ (404, not found at this path)
- https://capgo.app/docs/plugins/updater/self-hosted/encrypted-bundles/
- https://capgo.app/docs/live-updates/custom-storage/
- https://capgo.app/docs/faq/
- https://capgo.app/docs/plugins/updater/local-dev/cli/
- https://capgo.app/pricing/
- https://capgo.app/docs/public-api/
- https://capgo.app/docs/public-api/statistics/
- https://capgo.app/docs/public-api/devices/
- https://capgo.app/docs/public-api/app/
- https://capgo.app/docs/live-updates/integrations/github-actions/
- https://capgo.app/docs/plugin/api/
- https://capgo.app/docs/plugin/cloud-mode/channel-system/
- https://capgo.app/docs/webapp/payment/
- https://capgo.app/docs/plugins/updater/self-hosted/handling-channels/
- https://capgo.app/skills/ (skills marketplace)
- Web search supplements (Google-indexed capgo.app/docs pages, capgo.app blog, GitHub Cap-go/capgo, Cap-go/CLI, Cap-go/capgo.app)

Note on URL structure: there is no working `docs.capgo.app` subdomain (WebFetch returned `getaddrinfo ENOTFOUND docs.capgo.app`). All real documentation lives under `capgo.app/docs/...` paths. Our own runbook/instruction text that said "docs.capgo.app" was WRONG; the correct root is `capgo.app/docs/`. Flagging this as a documentation correction to make in our own materials.

---

## 1. What Capgo Is

Capgo is a cloud platform (also offers a licensed self-hosted deployment) that enables instant, over-the-air (OTA) live updates for Capacitor (mobile) and Electron (desktop) apps, shipping JavaScript/HTML/CSS/asset changes directly to installed apps in minutes, without waiting on App Store / Play Store review. It also offers hosted native builds (Capgo Build) and a marketplace of 150+ production-ready Capacitor plugins. It is the direct successor / migration target for teams leaving Ionic Appflow (dedicated migration doc: `/docs/upgrade/from-appflow-to-capgo/`).

Capgo explicitly frames "code push" and "OTA updates" as the same thing: "Code push, also referred to as 'over-the-air updates' (OTA) is a cloud service enabling Capacitor developers to deploy updates to their apps in production."

Terminology distinction (from FAQ):
- A **release** = preparing a new native binary for the app stores.
- A **bundle** = a patch/update applied on top of a release, pushed via `bundle upload`, to update the web-layer code without a new store submission.

Backend architecture (per GitHub repo docs, corroborating the API structure): deployed on Cloudflare Workers (handles ~99% of traffic) + Supabase (internal calls/cron). The backend code splits into a **Public API** (`supabase/functions/_backend/public/`, exposed to customers for apps/channels/bundles/devices) and a **Private API** (`supabase/functions/_backend/private/`, used internally by the console web UI for admin/ops workflows). Repos: `Cap-go/capgo` (Console, Backend, CLI monorepo) and `Cap-go/CLI` (CLI specifically).

---

## 2. Core Concepts: Bundles, Channels, Rollback, notifyAppReady

### 2.1 Bundles
- A bundle is the deployable unit: your built web assets (JS/HTML/CSS/etc.), zipped, uploaded to Capgo Cloud (or external/custom storage), then attached to one or more channels.
- Version numbers for bundles must be greater than `0.0.0` and unique per app; once a version is deleted it cannot be reused (security measure).
- Bundle files, once uploaded (unencrypted), are treated by Capgo as **public web assets**: "Bundle files are public web assets intended to be downloaded by your app users." Anyone with the bundle URL can access the files unless encrypted.
- Capgo explicitly states it does **not** store your source code: "Capgo servers never see your source code" — only minified/compiled build output is stored.
- Bundles can be uploaded to Capgo's own cloud storage, to an **external URL** (`--external <url>` / `-e` flag, recommended for apps >200MB), or to **custom storage** (S3 / S3-compatible, or your own CDN with data-residency requirements).
- Delta/incremental updates are supported (`--delta`, `--delta-only`) so devices only download changed files, not the full bundle every time.

### 2.2 Channels
- A channel is a named distribution track (e.g., production, beta, staging, per-feature-branch, per-PR) that points at a specific bundle/version.
- Channel device-assignment precedence, HIGH to LOW priority (per `/docs/plugin/cloud-mode/channel-system/`):
  1. **Forced device mapping** — manual pin via dashboard (highest priority, overrides everything).
  2. **Cloud override** — a per-device dashboard/API assignment to a specific (non-public) channel; persists across reinstalls; this is the mechanism exposed by the Devices API (`POST /device/`).
  3. **Plugin `setChannel()`** — app-initiated channel switch at runtime, stored locally on device, takes effect instantly. Only works if the target channel has "Allow device self-assignment" (`--self-assign`) enabled.
  4. **Config `defaultChannel`** in `capacitor.config` — for test builds only; production builds "typically leave this unset" so the dashboard stays authoritative.
  5. **Cloud default channel** — the fallback that catches "~99% of users," i.e., the channel marked `--default` / `-d` when created.
- Recommended channel staging pattern: Development -> QA -> Staging -> Production.
- A channel can be restricted by platform (`--ios`/`--no-ios`, `--android`/`--no-android`) and by device class (`--dev`/`--no-dev`, `--prod`/`--no-prod`, `--emulator`/`--no-emulator`, `--device`/`--no-device`), letting you target production physical devices only, or dev/emulator only, for QA gating.
- Channel "state" can be set with `-s` to `default` or `normal` (only one channel per app should typically be `default`).

### 2.3 Percent Rollout & Auto-Pause
Rollout control is rich, all under `channel set`:
- `--rollout-bundle` — set the target bundle for a gradual rollout.
- `--rollout-percentage` — 0-100 percent of eligible devices get the rollout bundle.
- `--rollout-percentage-bps` — same thing but in basis points, 0-10000 (i.e., finer-grained than whole percent, e.g., 0.5% = 50 bps).
- `--rollout-enable` / `--rollout-disable` — turn the rollout mechanism on/off.
- `--rollout-pause` / `--rollout-resume` — pause/resume WITHOUT rolling back (devices already on the rollout bundle stay there; new devices stop being added).
- `--rollout-rollback` — clear the rollout and return everyone to the stable bundle.
- `--rollout-promote` — promote the rollout target to become the new stable/default bundle for the channel (i.e., graduate a canary to 100%).
- **Auto-pause policy** (automatic circuit breaker on a bad rollout):
  - `--auto-pause-enabled` / `--auto-pause-disabled`
  - `--auto-pause-window-minutes` — the stats window Capgo monitors
  - `--auto-pause-failure-rate-bps` — failure-rate threshold (in basis points) that trips the breaker
  - `--auto-pause-action` — what happens when tripped: `pause`, `rollback`, or `notify`

This auto-pause/failure-rate mechanic is notable: Capgo can auto-detect a bad rollout via device-reported failure stats and pause or roll it back without human action, if configured.

### 2.4 Rollback (device-side) & notifyAppReady
This is the client-side safety net, distinct from the server-side "rollout-rollback" above:
- `notifyAppReady()` — a plugin method the app MUST call after a new bundle boots, signaling "this bundle works."
- `appReadyTimeout` config, default **10,000 ms (10 seconds)**. If `notifyAppReady()` is not called within that window after applying a new bundle, the plugin **automatically rolls back** to the previous working bundle (or to the "builtin"/shipped bundle if none). This is the mechanism that prevents an app from getting stuck on a broken OTA update — critical for anything shipped without a human watching.
- Related settings: `autoDeleteFailed` (default true, removes bundles that failed to boot), `autoDeletePrevious` (default true, cleans old bundles after a successful update), `resetWhenUpdate` (default true, clears downloaded OTA bundles when the NATIVE app itself is updated via App Store/Play Store, since native updates supersede pending OTA bundles).
- Plugin lifecycle/config surface, in full (per `/docs/plugin/api/`):
  - **Methods:** `notifyAppReady()`, `download(options)`, `next(options)` (stage bundle for next launch), `set(options)` (apply immediately + reload), `getLatest(options)`, `list()`, `current()` (returns `'builtin'` if no OTA bundle active), `delete(id)`, `reset(options)` (revert to builtin/last-good), `reload()`, `getNextBundle()`, `setChannel()`/`unsetChannel()`/`getChannel()`/`listChannels()`, `setCustomId()`, `getDeviceId()`/`getBuiltinVersion()`/`getPluginVersion()`, `setMultiDelay(conditions)` (postpone update application on conditions: background state, app kill count, native version, specific dates), `cancelDelay()` (force immediate install), `isAutoUpdateEnabled()`/`isAutoUpdateAvailable()`, `setShakeMenu()`/`isShakeMenuEnabled()` (debug menu), `setUpdateUrl()`/`setStatsUrl()`/`setChannelUrl()` (override endpoints, if enabled — presumably for self-hosted).
  - **Config options table:**
    | Setting | Purpose | Default |
    |---|---|---|
    | `autoUpdate` | when updates apply: off, atBackground, atInstall, onLaunch, always, onlyDownload | `atBackground` |
    | `appReadyTimeout` | ms before auto-rollback if notifyAppReady() not called | 10000 |
    | `updateUrl` | update-check server endpoint | capgo.app/updates |
    | `autoDeleteFailed` | auto-remove broken bundles | true |
    | `autoDeletePrevious` | auto-remove old bundles after success | true |
    | `resetWhenUpdate` | clear OTA bundles on native app update | true |
    | `periodCheckDelay` | background check interval, min 600s | 600 (10 min) |
    | `autoSplashscreen` | auto-hide splash during instant-apply modes | false |
    | `publicKey` | enables E2E encryption v2 for updates | undefined |
  - **Events emitted:** `download`, `updateAvailable`, `downloadComplete`, `noNeedUpdate`, `downloadFailed`, `updateFailed`, `majorAvailable`, `appReady`, `appReloaded`.
- Update check default: "By default, the Capgo updater checks for updates on app startup." Per config table, `periodCheckDelay` also drives periodic background checks (min every 10 minutes). "Our implementation always sends an update specifically tailored for the device...updating the requestor always to the latest version available" — i.e., a long-absent device jumps straight to current, not incrementally.
- Bundle-level rollback (distinct from device auto-rollback): "We have added the ability to rollback patches" by re-attaching a previous bundle to a channel — i.e., pointing the channel back at an older bundle version undoes the release for everyone on that channel.

---

## 3. Self-Hosted Channel API (device <-> backend contract)

From `/docs/plugins/updater/self-hosted/handling-channels/`, the channel endpoint supports 4 HTTP methods:
- **GET** — list channels compatible with the device (filtered by platform, build type i.e. dev/prod, emulator status). Response includes channel metadata with `public` and `allow_self_set` flags.
- **PUT** — get the device's current channel assignment. Request payload: `device_id, app_id, platform, plugin_version, version_build, version_code, version_name, is_emulator, is_prod`. Response: status, assigned channel name, permissions.
- **POST** — set/assign a device to a channel; validates the channel allows self-assignment and matches device platform constraints.
- **DELETE** — unset a device's channel override, reverting to normal (public/default) channel selection.

Channel determination logic filters on: platform compatibility, device type (emulator vs physical), build environment (dev vs prod), and whether the channel is public or explicitly self-assignable.

Update retrieval integrates via `getChannelVersion(channel, appId)`, returning version, URL, and checksum for the bundle to deliver to that channel assignment.

---

## 4. End-to-End Encryption (v2) — verify our model against this

### Key generation & model
- Generate a private key via CLI: `npx @capgo/cli key create`.
- Uses **RSA + AES** hybrid cryptography: RSA for key exchange, AES for bulk-encrypting the bundle contents (standard hybrid-encryption pattern).
- The `key save` subcommand (referenced in the CLI reference index at `/docs/cli/commands/key`) stores the **public key in app configuration** — i.e., in `capacitor.config` (this matches what our fleet already does: publicKey in capacitor.config). NOTE: I could not load the dedicated `key` command doc page directly (404 at the specific path I tried, `/docs/cli/commands/key/`); this detail is inferred from the CLI reference index entries ("key create — Generate RSA key pair for end-to-end encryption," "key save — Store public key in app configuration") plus the plugin config table's `publicKey` option ("enables end-to-end encryption for updates (v2)"). Recommend a follow-up fetch of the correct key-command URL to fully verify flag-level detail.

### v2 workflow (matches our `--key-v2` usage)
1. Zip + checksum: `npx @capgo/cli bundle zip [appId] --key-v2 --json`
2. Encrypt: `npx @capgo/cli encrypt [path/to/zip] [checksum]`
3. This produces an `ivSessionKey` (in newer payloads renamed `session_key`) plus an encrypted checksum for integrity verification.
4. Upload: `bundle upload` accepts `--key-v2` / `--key-data-v2` (the latter takes the actual key data, e.g. from a CI secret, vs. `--key-v2` which presumably reads from a local key file) to sign/encrypt during upload. There's also `--iv-session-key` for supplying encryption credentials when uploading externally-hosted encrypted bundles, and `--encrypt-partial` (auto-enabled for updater plugin versions >6.14.4) to also encrypt delta/partial-update files, not just full bundles.
5. `--no-key` flag exists to explicitly send an update UNENCRYPTED (opt-out).

### On-device decryption
- The app holds the private key (embedded at build time, not fetched at runtime — consistent with E2E design).
- Flow: app uses the private key to decrypt the `session_key`, then uses the decrypted `session_key` to decrypt the actual update bundle. The separately-transmitted encrypted checksum validates bundle integrity post-decryption.

### v1 vs v2
- v1 = original RSA/AES signing (`bundle encrypt` / `bundle decrypt` — CLI reference index explicitly labels these "Encrypt bundle with v1 RSA/AES system" / "Decrypt v1 bundle for testing").
- v2 = "improved v2 signature verification" (`bundle encryptV2` / `bundle decryptV2`, described in the CLI index as adding checksum validation). The specific cryptographic delta beyond "better checksums" was NOT detailed on the encrypted-bundles doc page as fetched — the page explicitly deferred to "a deep-dive guide" it linked but did not give the deep-dive's content in the fetched text. Flag as a gap; if fully precise crypto details matter (e.g., exact AES mode, key sizes), fetch the deep-dive guide directly.
- **Action item for our fleet**: we already run signed channels with per-app RSA keys and `publicKey` in `capacitor.config`, and use `--key-v2` uploads. This matches Capgo's documented v2 model (RSA+AES hybrid, public key client-side, `key save` writing to capacitor.config, `bundle zip --key-v2` -> `encrypt` -> `bundle upload --key-v2/--key-data-v2` flow). Nothing in the docs suggests we're doing this wrong structurally. Two things worth double-checking against our actual CI: (a) whether we're using `--encrypt-partial` for delta updates if we use deltas (auto-on above updater 6.14.4, so verify our updater plugin version), and (b) whether CI stores the PRIVATE key as `CAPGO_PRIVATE_KEY` via `--key-data-v2` (recommended, avoids committing a key file) rather than a checked-in key file referenced by `--key-v2`.

### Encrypted bundles vs "external URL" vs "no-key" — three independent security postures
1. Default cloud storage, unencrypted: Capgo hosts a "public web asset."
2. `--external <url>`: you host the bundle yourself (e.g., your own S3/CDN), Capgo just points at it. All bundle URLs MUST be HTTPS ("required for mobile and Electron apps").
3. E2E encrypted (v1 or v2, `--key-v2`/`--key-data-v2`): bundle content is encrypted regardless of storage location, decryptable only by devices holding the matching private key ("trustless security" per the bundle upload doc).

---

## 5. CI/CD Integration (GitHub Actions)

Doc: `/docs/live-updates/integrations/github-actions/` (also `/docs/getting-started/cicd-integration/` covers the same ground).

### Setup
1. GitHub repo with app source.
2. Active Capgo account + app registered.
3. Node.js + npm/yarn, GitHub Actions enabled.
4. One required repo secret: `CAPGO_TOKEN`, sourced from **console.capgo.app/apikeys**. Configured via Settings -> Secrets and variables -> Actions.

### Recipe 1 — basic production deploy on push to main
```yaml
name: Deploy to Capgo
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: '24'
          cache: 'npm'
      - run: npm ci && npm run test && npm run build
      - run: |
          npm install -g @capgo/cli
          npx @capgo/cli bundle upload --channel production
        env:
          CAPGO_TOKEN: ${{ secrets.CAPGO_TOKEN }}
```

### Recipe 2 — multi-environment (dev / PR / production), build once, deploy per branch
Single `build` job produces a `dist/` artifact (`actions/upload-artifact@v6`), downloaded (`actions/download-artifact@v4`) by three conditional jobs:
- `deploy-development`: `if: github.ref == 'refs/heads/develop'`, channel `development`, uses `environment: development` (GitHub Environments).
- `deploy-pr`: `if: github.event_name == 'pull_request'`, creates a per-PR channel `pr-${{ github.event.number }}` via `channel create ... || true` (idempotent) then uploads to it.
- `deploy-production`: `if: github.ref == 'refs/heads/main'`, channel `production`, `environment: production` (supports GitHub required-reviewer protection rules).

### Recipe 3 — feature-branch channels
On push to `feature/**`, derives a sanitized channel name from the branch (`sed 's/[^a-zA-Z0-9]/-/g' | tr '[:upper:]' '[:lower:]'`), creates the channel if missing, uploads to it. Doc also lists a recommended "branch deletion -> cleanup old channels" trigger pattern (not shown as full YAML, but called out as a recommended trigger condition).

### Encryption in CI
Store the private key as a secret (`CAPGO_PRIVATE_KEY`) and pass via `--key-data-v2 "${{ secrets.CAPGO_PRIVATE_KEY }}"` appended to the upload command.

### Recommended trigger-condition table (from doc)
| Event | Branch | Target |
|---|---|---|
| Push to main | production branch | production channel |
| Push to develop | development branch | development channel |
| Pull request | any PR branch | temporary `pr-<number>` channel |
| Feature branch push | `feature/**` | feature-specific channel |
| Branch deletion | feature branches | cleanup old channel |

Note the recipes use `npx @capgo/cli bundle upload --apikey ${{ secrets.CAPGO_TOKEN }} --channel <name>` (flag-based key) in some examples and `env: CAPGO_TOKEN` in others — both are apparently accepted (flag `-a`/`--apikey` or env var / prior `login`).

---

## 6. CLI Command Surface (full index found)

Base invocation pattern: `npx @capgo/cli@latest <command> <subcommand> [app_id] [flags]`

### Top-level / onboarding
- `init` — "Onboard step by step": adds app, code, builds, uploads, and validates updates in one guided flow.
- `login [API_KEY]` — securely stores API key for reuse across commands.
- `doctor` — checks whether installed Capgo packages are up to date.

### `app` (app-level management)
- `app add` (alias `a`) — register a new app. Flags: `-n` name, `-i` icon path, `-a` API key, `--supa-host`/`--supa-anon` (custom Supabase, i.e. self-hosted target).
- `app list` (alias `l`) — list all registered apps.
- `app delete` — remove an app or a specific bundle version.
- `app debug [app-id]` — "Listen for live update events in Capgo Cloud to debug your app." Flag `-d` targets a specific device ID.
- `app setting [path]` — modify Capacitor config values programmatically via dot-notation path; flags `--bool` / `--string` to type the value.
- `app set [app-id]` (alias `s`) — update app settings: `-n`/`-i` name/icon, `-r` retention days ("Days to keep old bundles (0 = infinite, default: 0)"), `--preview`/`--no-preview` (QR code feature), `--ios-store-url`/`--android-store-url`, `--default-upload-channel`/`--default-download-channel`, `--build-timeout-minutes` (native build timeout, 5-360 min range).

### `bundle` (build artifact management)
- `bundle upload` (alias `u`) — the core deploy command. Full flag list:
  - `-p` bundle folder path (defaults to capacitor.config `webDir`)
  - `-c` target channel(s), comma-separated
  - `-b` explicit version number (else auto/from package.json)
  - `-e` external URL instead of Capgo cloud storage (for bundles >200MB)
  - `--delta` / `--delta-only` — incremental upload
  - `--iv-session-key` — encryption creds for externally-hosted encrypted bundles
  - `--key-v2` / `--key-data-v2` — v2 signing key (file path vs. inline data)
  - `--no-key` — send unencrypted
  - `--fail-on-incompatible` — reject upload if incompatible with channel's native-compatibility metadata
  - `--auto-min-update-version` — auto-set minimum required native version
  - `--tus` — use TUS resumable-upload protocol
  - `--encrypt-partial` — encrypt delta files too (auto-on for updater plugin >6.14.4)
  - `--send-update-notification` — trigger a native push notification after update
  - `--qr-preview` — print a terminal QR code after upload (for quick device testing)
  - `--rollout` — percentage rollout target (0-100) at upload time
  - `--timeout` — upload duration limit in seconds
- `bundle compatibility [app_id]` — validate bundle vs channel native-compatibility before deploy. Flags: `-c` channel, `--text` (plain-text output vs emoji), `--package-json`/`--node-modules` (monorepo support).
- `bundle releaseType [app_id]` — outputs whether the pending update is "native" or "OTA" based on compatibility vs. channel metadata. Useful for CI branching logic.
- `bundle delete BUNDLE_ID [app_id]` — remove a specific bundle.
- `bundle list [app_id]` — list all bundles for an app.
- `bundle cleanup [app_id]` — purge old bundles, keeping recent N. Flags: `-k` count to keep (example: `--bundle=1.0 --keep=3`), `-f` force, `--ignore-channel` (also delete bundles linked to channels, "use cautiously").
- `bundle encrypt <zip> <checksum>` — v1 encrypt; outputs `ivSessionKey`.
- `bundle decrypt <encrypted-zip> <checksum>` — v1 decrypt, for testing.
- `bundle encryptV2` / `bundle decryptV2` — v2 equivalents with checksum validation.
- `bundle zip [app_id]` — produce a compressed bundle archive with embedded checksum. Flags: `-j` JSON output, `--key-v2` apply v2 encryption during zip.

### `channel` (distribution channel management)
- `channel add` (alias `a`) — create channel. Example: `channel add production com.example.app --default`. Flags: `-d` set as default, `--self-assign` allow device self-assignment, `-a` API key.
- `channel delete` (alias `d`) — remove a channel. Flags: `--delete-bundle` (also deletes the associated bundle; note App-Preview-scoped keys can only delete their own unshared bundles), `--success-if-not-found`.
- `channel list` (alias `l`) — list channels for an app.
- `channel currentBundle` — get the bundle currently linked to a channel. Flags: `-c` channel name, `--quiet` (bundle version only, script-friendly).
- `channel set` (alias `s`) — the big configuration command, full flag set:
  - Bundle assignment: `-b` specific version, `--latest-remote` (latest uploaded), `--latest` (latest from package.json)
  - Update-type gating: `--disable-auto-update <major|minor|metadata|patch|none>`
  - Version-safety: `--downgrade`/`--no-downgrade` (allow going below native app version)
  - Platform targeting: `--ios`/`--no-ios`, `--android`/`--no-android`
  - Device-class targeting: `--dev`/`--no-dev`, `--prod`/`--no-prod`, `--emulator`/`--no-emulator`, `--device`/`--no-device`
  - Rollout: `--rollout-bundle`, `--rollout-percentage`, `--rollout-percentage-bps` (0-10000), `--rollout-enable`/`--rollout-disable`, `--rollout-pause`/`--rollout-resume`, `--rollout-rollback`, `--rollout-promote`
  - Auto-pause: `--auto-pause-enabled`/`--auto-pause-disabled`, `--auto-pause-window-minutes`, `--auto-pause-failure-rate-bps`, `--auto-pause-action <pause|rollback|notify>`
  - `--self-assign`/`--no-self-assign`
  - `--send-update-notification`
  - `-s` channel state (`default`|`normal`)

### `key` (encryption keys — index only, detail page 404'd for me)
- `key create` — generate RSA key pair for E2E encryption.
- `key save` — store the public key in app configuration (capacitor.config).

### Global flags (accepted broadly across commands)
- `-a` — API key
- `--supa-host` / `--supa-anon` — point CLI at a custom/self-hosted Supabase instance instead of Capgo Cloud
- `--verbose` — detailed logging

### CLI reference index full table (as scraped)
| Command | Description | Path |
|---|---|---|
| init | Onboard step by step | /docs/cli/commands/init |
| login | Store API key | /docs/cli/commands/login |
| doctor | Check package freshness | /docs/cli/commands/doctor |
| app add/set/list/delete/debug/setting | app management | /docs/cli/reference/app/ |
| bundle upload/list/delete/cleanup/encrypt/encryptV2/decrypt/decryptV2/zip/compatibility | build artifacts | /docs/cli/reference/bundle/ |
| channel add/delete/list/set | distribution channels | /docs/cli/reference/channel/ |
| key create/save | E2E encryption keys | /docs/cli/commands/key |

---

## 7. Public API (api.capgo.app)

### Base URL & auth
- Base: `https://api.capgo.app`
- Auth header: `x-api-key: <your key>` (recommended/current). Legacy `authorization` header still supported (the statistics doc's examples actually show `authorization: your-api-key`, suggesting inconsistent documentation of the two but both work).
- We already use `POST /app` with `owner_org` — confirmed against docs: `POST /app/` requires `app_id` (unique, reverse-domain, cannot be reused across ANY account, even after deletion — same "no reuse" rule as bundle versions), `name`, `owner_org` (all required), `icon` (optional). This matches our existing usage.

### Response envelope
- Success: `{"status": "ok", "data": {...}}`
- Error: `{"error": "description", "status": "KO"}`

### Rate limits
- Standard accounts: 100 requests/minute
- Enterprise accounts: 1,000 requests/minute
- Device/channel operations specifically: 5 requests/second per operation type, 60-second cooldown for duplicate assignments, 1,000 requests/minute per app/IP
- Exceeding returns HTTP 429 with a `retryAfterSeconds` field

### Endpoint families
- **Organizations** — create/manage orgs, account-level settings
- **API Keys** — generate/list/revoke
- **Members** — team roles/permissions
- **Statistics** — usage/storage/bandwidth analytics (see 7.1)
- **Channels** — update channels/deployment policies (server-side equivalent of the CLI `channel` commands)
- **Devices** — track installs + version/channel assignment (see 7.2)
- **Bundles** — upload/manage versions

### 7.1 Apps API (`/app/`)
- `GET /app/` — list apps. Query: `page`, `limit` (default 50), `org_id` filter. Response fields per app: `app_id`, `name`, `icon_url`, `last_version`, `created_at`, `updated_at`, `retention`, `owner_org`, plus other metadata.
- `GET /app/:app_id` — single app.
- `POST /app/` — create. Body: `app_id` (required, unique), `name` (required), `owner_org` (required), `icon` (optional).
- `PUT /app/:app_id` — update. Body (all optional): `name`, `icon`, `retention` (days), `block_provider_infra_requests` (boolean).
- `DELETE /app/:app_id` — permanently delete app + all associated resources.
- Errors: "App not found," "Custom ID already in use," "Invalid app configuration," "Insufficient permissions to manage app."

### 7.2 Devices API (`/device/`)
- Devices = individual app installations reporting updater metadata. Device records persist **90 days from last activity**.
- Metadata fields: device ID, platform, updater/OS versions, native build, installed bundle, production/emulator status, custom ID, channel override, `country_code` (Cloudflare-derived, "latest valid two-letter ISO 3166-1 code").
- `GET https://api.capgo.app/device/` — list/lookup. Params: `app_id` (required), `device_id` (optional, returns single device), `customIdMode` (optional, filters to devices with a non-empty custom_id), `cursor`, `limit`. Response: `data[]`, `nextCursor`, `hasMore` (cursor pagination).
- `POST https://api.capgo.app/device/` — assign device to a **private** channel override. Body: `app_id`, `device_id`, `channel` (must be an existing NON-public channel — "Public channels cannot be used as device overrides." Direct bundle overrides are not supported, only channel overrides).
- `DELETE https://api.capgo.app/device/` — remove a device's channel override, reverting it to normal channel selection. Body: `app_id`, `device_id`.
- Errors: `invalid_app_id`, `device_not_found`, `channel_not_found`, `public_channel_override`, `invalid_version_id`, permission errors.
- This is the API-level mechanism for pinning a specific tester's device to a QA/beta channel for debugging, matching the "Cloud override" tier (#2) in the channel-assignment precedence list in section 2.2.

### 7.3 Statistics API (`/statistics/...`)
Four endpoints:
1. `GET /statistics/app/:app_id/` — per-app metrics. Query: `from`, `to` (YYYY-MM-DD). Returns MAU, storage (bytes), bandwidth (bytes) — example daily response: `{"date": "2024-01-01", "mau": 1500, "storage": 536870912, "bandwidth": 1073741824}`.
2. `GET /statistics/org/:org_id/` — org-level aggregation. Query: `from`, `to`, `breakdown` (bool, default false, per-app breakdown), `noAccumulate` (bool, default false, daily non-cumulative results). Same metric set as app endpoint.
3. `GET /statistics/user/` — cross-org aggregation across everything the caller can access. Query: `from`, `to` only.
4. `GET /statistics/app/:app_id/bundle_usage` — version/bundle adoption distribution. Query: `from`, `to`. Response shape: `{"labels": [...dates], "datasets": [{"label": "<version_number>", "data": [...usage_percentages]}]}` — i.e., chart-ready time series of what % of active devices are on each bundle version. This is the tool for verifying rollout adoption over time.

MAU definition (repeated consistently across FAQ and stats docs): "A MAU is a Monthly Active Device. A distinct device that contacts Capgo during a rolling 30-day period counts as one MAU." — this is a DEVICE metric, not a human-user metric (relevant for our multi-device-per-user apps).

---

## 8. Self-Hosting

- FAQ confirms: "Yes. Enterprise supports licensed self-hosted Capgo deployments when you need to run the updater backend in your own infrastructure." I.e., self-hosting the FULL platform is an Enterprise-tier licensed feature, not something available on lower plans.
- Per GitHub repo docs (Cap-go/capgo): production Capgo itself runs on **Cloudflare Workers** (99% of traffic) + **Supabase** (internal calls, cron jobs). The `cloudflare_workers/` directory in the repo is "only needed if you want to run the Workers layer instead of, or in front of, Supabase."
- Minimal self-host path: "To self host Capgo, you just need to follow the Supabase self-hosting documentation" — i.e., Supabase alone is sufficient to stand up a self-hosted Capgo backend; Workers are optional/additive.
- Backend code organization matches this split: `supabase/functions/_backend/public/` = the customer-facing Public API (apps/channels/bundles/devices — what our CLI/API integration talks to); `supabase/functions/_backend/private/` = internal console/admin API.
- Separately, "custom storage" (S3/S3-compatible, external URLs) is available on ALL plans and is NOT the same thing as self-hosting the whole platform — it only relocates bundle STORAGE, not the update/channel/device backend. Requirements for custom S3: region, access key, secret key, bucket name; optional custom endpoint for S3-compatible providers (e.g., R2, MinIO, Backblaze B2). All bundle URLs must be HTTPS.
- The CLI's `--supa-host` / `--supa-anon` global flags exist specifically to point the CLI at a self-hosted Supabase instance instead of Capgo Cloud, confirming CLI compatibility with self-hosted deployments.
- We are documented as a **paid subscriber, org "OTCHealth Inc."** on Capgo Cloud (not self-hosted) — self-hosting is not something we currently need since Enterprise-hosted-cloud already gets us most of the same isolation/limits, but worth knowing self-host exists as an Enterprise fallback if we ever need on-prem/data-residency control beyond what custom S3 storage gives us.

---

## 9. Pricing & Plan Limits

From `/pricing/` (fetched 2026-07-21; note pricing/limits are explicitly called out as changeable, per WebFetch general guidance — reconfirm before any budget decision):

| Plan | Monthly | Annual (effective monthly) | Trial |
|---|---|---|---|
| Solo | $14 | $12/mo ($146/yr) | 14 days unlimited |
| Maker | $39 | $33/mo ($396/yr) | 14 days unlimited |
| Team | $99 | $83/mo ($998/yr) | 14 days unlimited |
| Enterprise | $249+ | $208+/mo ($2,490+/yr) | 14 days unlimited |

Resource limits by plan:

| Resource | Solo | Maker | Team | Enterprise |
|---|---|---|---|---|
| MAU (Monthly Active [Devices]) | 2,000 | 10,000 | 100,000 | 1,000,000+ |
| Bandwidth/month | 100 GiB | 1,000 GiB | 10,000 GiB | 100,000+ GiB |
| Storage | 20 GiB | 50 GiB | 100 GiB | 200+ GiB |
| Build Hours | 1 | 2 | 10 | 333+ |
| Build Concurrency | 2 | 3 | 4 | 6 |

All plans include: unlimited apps, unlimited members/teams, unlimited webhooks, native update notifications, unlimited live updates, MCP server access, delta updates, "7-continent replication," signed/encrypted updates.

Enterprise-exclusive: SSO, Custom Domain, SOC 2 Type II compliance, ISO 27001 audit completion, signed NDAs/DPAs, security questionnaires, dedicated account manager, onboarding & training, direct chat support (Team gets "priority support" but not direct chat).

Overage / pay-as-you-go pricing (used once a plan's included quota is exceeded, billed from purchased credits):
- MAU: $0.003/MAU (first 1M) declining to $0.0007/MAU (100M+ tier)
- Bandwidth: $0.06/GiB (first 1TB) declining to $0.01/GiB (130TB+ tier)
- Storage: $0.09/GiB (first 1 GiB) declining to $0.021/GiB (1TB+ tier)
- Build minutes: $0.08 (first 100 minutes) declining to $0.04 (10k+ tier)
- Credits are "prepaid, valid for 1 year," usable with or without an active subscription.

Billing/payment mechanics (`/docs/webapp/payment/`):
- Payments processed entirely by Stripe: "Capgo never gets access to your credit card details."
- "No, capgo will never change your plan [automatically]" — i.e., no silent auto-upgrade/downgrade.
- On exceeding plan limits (MAU/storage/bandwidth), the system automatically draws down purchased credits rather than cutting off service.
- Email alerts are sent when approaching usage limits.
- A refund policy exists at a separate `/return/` page (not fetched in this pass).
- Regional replication does NOT multiply storage/bandwidth cost: "A bundle is counted once for storage, regardless of the regions serving it."
- Storage counts "retained historical bundles and their Delta assets across your channels" — retention is per-app-configurable in App Settings (the `-r`/`retention` field from `app set`/`PUT /app/:app_id`, default 0 = infinite).
- Gap: I did NOT find explicit trial-expiry / non-payment-freeze behavior in the fetched payment doc content (it may exist further down the page or on a different page — flagged as unconfirmed, not "does not exist").

---

## 10. App Store / Play Store Compliance Posture (from FAQ)

- "Capgo delivers changes only to the Capacitor web layer: the HTML, CSS, JavaScript, and assets." Any native-code change requires a real store release/binary update; OTA cannot touch native code.
- Explicit guidance: "Use a native store release for every native change and for material changes" — i.e., Capgo's own docs caution against using OTA to sneak substantive/material changes past store review, which is directly relevant to our compliance posture (we already treat this as gospel per our own CLAUDE.md rules).
- "Capgo cannot guarantee an individual approval or review outcome" for App Store/Play Store — no compliance guarantee, review risk is on us regardless of OTA usage.

---

## 11. Skills Marketplace (capgo.app/skills/)

Positioning: "Open-source skills that help AI agents build better Capacitor applications" — a structured-knowledge resource for AI coding assistants (Claude Code, Cursor, Windsurf, Gemini CLI, etc.) working on Capacitor apps.

### Install commands (exact, as shown)
- Generic/recommended: `npx skills add Cap-go/capgo-skills`
- Claude Code plugin marketplace:
  ```
  claude plugin marketplace add Cap-go/capgo-skills
  claude plugin install capgo-cloud@capgo-skills
  ```
- Gemini CLI:
  ```
  gemini skills install https://github.com/Cap-go/capgo-skills
  gemini skills list
  ```

### Scale: 48 skills across 13 categories
1. **Core Development** (5): capgo-cli-usage, capgo-cloud, capacitor-plugins, capacitor-best-practices, capgo-live-updates
2. **Growth & Revenue** (1): subscription-app-revenue
3. **Security** (1): capacitor-security
4. **Testing & CI/CD** (2): capacitor-testing, capacitor-ci-cd
5. **Debugging & Tooling** (3): debugging-capacitor, ios-android-logs, capacitor-mcp
6. **UI & Design** (5): ionic-design, konsta-ui, tailwind-capacitor, safe-area-handling, capacitor-splash-screen
7. **Features** (4): capacitor-push-notifications, capacitor-deep-linking, capacitor-offline-first, capacitor-keyboard
8. **Performance & Accessibility** (2): capacitor-performance, capacitor-accessibility
9. **Deployment** (7): capgo-native-builds, capgo-release-management, capgo-release-workflows, capacitor-app-store, capacitor-apple-review-preflight, capacitor-plugin-spm-support, cocoapods-to-spm
10. **Operations** (1): capgo-organization-management
11. **Authoring** (1): skill-creator
12. **Upgrades** (11 total): capacitor-app-upgrades, capacitor-app-upgrade-v4-to-v5, -v5-to-v6, -v6-to-v7, -v7-to-v8, capacitor-plugin-upgrades, capacitor-plugin-upgrade-v4-to-v5, -v5-to-v6, -v6-to-v7, -v7-to-v8
13. **Migration** (6): cordova-to-capacitor, framework-to-capacitor, webapp-to-capacitor, ionic-appflow-migration, sqlite-to-fast-sql, ionic-enterprise-sdk-migration

### Per-skill one-line descriptions (as shown on the page)
- capgo-cloud: "Coordinate Capgo builds, releases, publishing, and organization workflows"
- capacitor-plugins: "Official Capacitor packages plus Capgo plugin recommendations"
- capgo-live-updates: "Deploy OTA updates instantly with Capgo"
- subscription-app-revenue: "Build a practical path from app idea or MVP to early subscription revenue"
- capacitor-security: "Security scanning with Capsec and mobile security rules"
- capacitor-testing: "Unit, integration, E2E, and native testing strategies"
- capacitor-ci-cd: "GitHub Actions, GitLab CI, Fastlane, signing, and release automation"
- debugging-capacitor: "Debug iOS, Android, and web builds with repeatable workflows"
- ios-android-logs: "Access native logs with Xcode, ADB, and MCP automation"
- ionic-design: "Build native-feeling UIs with Ionic components"
- konsta-ui: "iOS and Material Design components for React/Vue/Svelte"
- tailwind-capacitor: "Tailwind CSS patterns for mobile Capacitor apps"
- safe-area-handling: "Handle notches, home indicators, and status bars"
- capacitor-splash-screen: "Configure launch screens for iOS and Android"
- capacitor-push-notifications: "FCM and APNs integration for mobile push"
- capacitor-deep-linking: "Universal Links and App Links implementation"
- capacitor-offline-first: "Build apps that work without internet"
- capacitor-keyboard: "Handle keyboard events and layout shifts"
- capacitor-performance: "Optimize bundle size, rendering, bridge calls, and memory"
- capacitor-accessibility: "Screen readers, WCAG compliance, and inclusive design"
- capgo-native-builds: "Request hosted iOS and Android builds with Capgo Build"
- capgo-release-management: "Manage bundles, channels, compatibility checks, and encryption"
- capacitor-app-store: "Prepare and submit releases to Apple App Store and Google Play"
- capacitor-apple-review-preflight: "Run an Apple review preflight audit for Capacitor apps"
- capacitor-plugin-spm-support: "Add Swift Package Manager support to a Capacitor plugin"
- cocoapods-to-spm: "Migrate a Capacitor iOS app from CocoaPods to Swift Package Manager"
- capgo-organization-management: "Manage Capgo organizations, members, and security policies"
- skill-creator: "Create and validate new agent skills with progressive disclosure"
- capacitor-app-upgrades: "Upgrade a Capacitor app across major versions"
- cordova-to-capacitor: "Migrate from Cordova or PhoneGap to Capacitor"
- framework-to-capacitor: "Integrate Next.js, React, Vue, or Angular with Capacitor"
- webapp-to-capacitor: "Turn an existing web app or PWA into a store-ready Capacitor app"
- ionic-appflow-migration: "Migrate from Ionic Appflow to Capgo and repo-owned automation"
- sqlite-to-fast-sql: "Migrate SQLite or SQL plugins to Fast SQL"
- ionic-enterprise-sdk-migration: "Replace Ionic Enterprise SDK plugins with open alternatives"

### Claude Code "plugin groups" (narrower installs than the full 48-skill set)
capgo-cloud, app-growth, capacitor-core, capacitor-features, capacitor-ui, capacitor-quality, capacitor-deployment, capacitor-app-migrations, capacitor-app-upgrades, capacitor-plugin-dev, skill-authoring

No pricing/usage limits mentioned on the skills page itself — framed purely as "Open Source" and "AI Agent Ready."

### Relevance to our fleet
Given we already run `Cap-go/capgo-skills`-adjacent workflows manually across 8 apps, the `capgo-release-management` skill ("Manage bundles, channels, compatibility checks, and encryption") and `capacitor-ci-cd` skill ("GitHub Actions, GitLab CI, Fastlane, signing, and release automation") look like the two most directly applicable to formalizing what we're already doing by hand; `capacitor-apple-review-preflight` and `capacitor-app-store` are relevant to our Depot-macOS/ASC pipeline described elsewhere in our own CLAUDE.md files.

---

## 12. Gaps / Things NOT Fully Confirmed (flag for follow-up fetch)

1. `key create` / `key save` exact flags and output file format — the specific doc page 404'd for me at `/docs/cli/commands/key/`; only inferred from the CLI reference index one-liners and the plugin config table. Correct URL not found in this pass (may be `/docs/cli/reference/key/` matching the other reference pages' pattern, untested).
2. The full crypto specifics of v2 encryption beyond "RSA+AES, improved checksums" (exact AES mode/key size, exact RSA key size) — the encrypted-bundles page referenced a "deep-dive guide" whose content wasn't captured.
3. Exact trial-expiry / non-payment behavior (does the app freeze, get read-only, etc.) — not found in the payment doc content fetched.
4. `docs.capgo.app` does not resolve as a subdomain at all — confirm whether any of our internal docs/runbooks reference that host and correct them to `capgo.app/docs/`.
5. Statistics API auth header inconsistency in docs: public-api overview says `x-api-key` is recommended (legacy `authorization` still works), but the statistics-specific doc's own examples show `authorization: your-api-key` — worth testing both against our actual integration to see which our current calls use.
