# Container Apps probe audit — A10-PROBES (gateway)

2026-07-05. Scope: `otchealth-mcp-gateway` (repo `/tmp/mcpsrv`), the fleet's Container App (not a
Container Apps Job — this is the long-running ingress-facing app A10 also covers). Read-only review;
no infra/deploy files in the gateway repo were edited per instructions — findings + a recommended
config are captured here for the gateway repo's own maintainers to apply.

## What exists today

**No `probes` configuration exists anywhere in the gateway's Container Apps definition.**

- `infra/gateway.bicep` — the IaC template described in its own header comment as "the reviewable
  source-of-truth for the gateway's Azure shape" — defines `template.containers[0]` (name, image,
  resources, env) and `template.scale` (min/maxReplicas) but has **no `probes` array** on the
  container object at all (checked the full `Microsoft.App/containerApps@2024-03-01` resource body,
  lines 55–106 of that file). Per the ARM schema, `containers[].probes` is optional; omitting it
  entirely means Container Apps falls back to its own platform default behavior rather than anything
  this repo has explicitly reasoned about.
- `.github/workflows/deploy.yml` never calls `az containerapp update`/`create` with `--probes` (or
  the YAML-manifest equivalent) either — the deploy pipeline's own health assertions
  (`/health` polling at lines ~102–121, `/health/deep` at lines ~130–158) are CI-side gates run
  *after* the GREEN revision is already up and *before* traffic is shifted; they are not the
  platform-level probes Container Apps itself would use to manage the revision's own replica
  lifecycle (restart a wedged container, hold traffic back from a still-booting one, etc).
- The **application itself already exposes exactly what a probe config would need**, just not wired
  into Container Apps:
  - `GET /health` (`src/server/health.ts`, `buildHealthPayload()`) — deliberately dependency-free
    (no Cosmos/Search/Foundry calls), fast, returns `{status:"ok", tool_count, ...}`. This is the
    right target for both liveness and readiness probes (see recommendation below) — its own code
    comment says as much: *"This route stays dependency-free on purpose (LB/uptime probes hit it),
    so it must never grow a Cosmos/Search/Foundry call."*
  - `GET /health/deep` (`src/server/deep-health.ts`) — makes real, timeout-capped (2s) reachability
    calls to Cosmos/Search/Foundry, but is **admin-token-gated** (`validateAdminToken`) and explicitly
    NOT meant for public/platform polling (comment: *"gated to internal/CI callers ... rather than
    left open to public polling, which would let an outside caller hammer Cosmos/Search/Foundry for
    free"*). This is unsuitable for a Container Apps probe as-is (Container Apps HTTP probes do
    support custom headers, so an Authorization header *could* be added, but doing so would mean
    every replica's probe interval — by default every few seconds — becomes a paid/rate-limited
    downstream call multiplied by replica count; not recommended without redesigning `/health/deep`
    to be probe-safe first).
  - `Dockerfile`'s own `HEALTHCHECK` (line ~74) already polls `curl -fsS http://127.0.0.1:8080/health`
    every 30s with a 5s timeout, 10s start period, 3 retries — this is Docker's own healthcheck
    mechanism, informative for `docker run` locally but **not consulted by Azure Container Apps at
    all** (Container Apps has its own separate probe mechanism at the ARM/platform level; the Docker
    `HEALTHCHECK` instruction is inert in that environment). It is useful evidence for what
    parameters this team already considers reasonable (30s interval, 5s timeout, 10s start period),
    which is exactly why the recommendation below reuses those same numbers rather than inventing new
    ones.

**Net finding: the gateway currently ships with zero explicit Container Apps probes.** Without an
explicit `probes` array, Container Apps applies its own default TCP-connect check against the
ingress target port for readiness (does the container accept a TCP connection), and has no dedicated
liveness probe distinct from that. That means:
- A replica that accepts TCP connections but is wedged/deadlocked internally (event loop blocked,
  stuck request holding the process open, e.g. — hypothetically — an unbounded `/health/deep`-style
  call if one were ever added to the request path) would still show ready and continue receiving
  traffic; nothing today would restart it.
- A slow-starting replica (npm cold start + Datadog serverless-init wrapping the process, per the
  Dockerfile's own `ENTRYPOINT`) has no dedicated startup grace window distinct from the steady-state
  liveness check, which is exactly the scenario Container Apps' `startupProbe` exists for.

## Microsoft's documented best practice (Container Apps HTTP probes)

Per Microsoft's Container Apps health probes documentation, the three probe types map onto Kubernetes
semantics:
- **Startup probe**: gates the other two probes until it succeeds once; intended for apps with a
  slow/variable boot sequence, so liveness doesn't kill a container that's still legitimately
  starting up. Recommended for anything wrapped by an init process (this app is wrapped by Datadog
  `serverless-init` when `DD_API_KEY` is set — see Dockerfile `ENTRYPOINT`), or with a boot-time
  dependency check.
- **Readiness probe**: gates traffic — a replica that fails readiness stops receiving new requests
  but is not killed. This is what should protect against a replica that's up but not yet warmed up
  (or, transiently, one whose immediate dependencies are flapping) without triggering a restart storm.
- **Liveness probe**: restarts the container on repeated failure — the backstop for a wedged/deadlocked
  process that is still accepting TCP connections but not actually serving.
- Guidance: HTTP probes should hit a **cheap, dependency-light** endpoint (exactly the role
  `/health` already plays here) — never a probe path that itself makes slow/paid downstream calls,
  since probe failures compound under load exactly when the app is already struggling. `failureThreshold`
  and `periodSeconds` should be tuned so a single slow response doesn't false-positive a restart, but
  a genuinely wedged replica is caught within roughly 30–60 seconds of total detection latency.

## Recommendation

Route all three probes at `GET /health` (never `/health/deep` — it's admin-gated and makes live
downstream calls, exactly what Microsoft's guidance says to avoid on a probe path). Suggested
`containers[].probes` block for `infra/gateway.bicep`'s `app` resource
(`template.containers[0]`), values chosen to be consistent with the Dockerfile's own existing
`HEALTHCHECK` cadence (30s interval / 5s timeout / 10s start-period / 3 retries) so CI-side, local
`docker run`, and platform-side probing all agree on what "healthy" means and how patient to be
during startup:

```bicep
probes: [
  {
    type: 'Startup'
    httpGet: {
      path: '/health'
      port: targetPort
      scheme: 'HTTP'
    }
    // Slow-boot allowance: npm/node cold start + Datadog serverless-init wrapping the process.
    // Checked every 5s, allowed up to ~60s (12 x 5s) before the replica is considered failed to
    // start — generous relative to the Dockerfile HEALTHCHECK's 10s start-period because platform
    // cold starts (image pull + scheduler placement) add latency the local docker-run case doesn't have.
    periodSeconds: 5
    failureThreshold: 12
    initialDelaySeconds: 0
  }
  {
    type: 'Readiness'
    httpGet: {
      path: '/health'
      port: targetPort
      scheme: 'HTTP'
    }
    // Gates traffic only (no restart). Runs only after Startup succeeds once. A couple of
    // consecutive misses (10s) pulls the replica out of rotation without flapping on one slow tick.
    periodSeconds: 5
    failureThreshold: 2
    successThreshold: 1
  }
  {
    type: 'Liveness'
    httpGet: {
      path: '/health'
      port: targetPort
      scheme: 'HTTP'
    }
    // Restart backstop for a wedged-but-TCP-alive process. Matches the Dockerfile HEALTHCHECK's
    // 30s interval / 3-retries cadence (~90s to confirmed-dead), long enough that a transient GC
    // pause or brief event-loop stall under load doesn't trigger a restart storm, short enough that
    // a genuinely wedged replica is cycled within about a minute and a half.
    periodSeconds: 30
    timeoutSeconds: 5
    failureThreshold: 3
    initialDelaySeconds: 15
  }
]
```

Notes for whoever applies this:
- `port: targetPort` reuses the module's existing `targetPort` param (default `8080`) rather than a
  hardcoded literal, consistent with the rest of `gateway.bicep`.
- This is additive to the existing `template.containers[0]` object (sits alongside `resources`/`env`);
  it does not require touching `configuration.ingress` or the scale rules.
- Because `/health` is already dependency-free by explicit design (per its own code comment), none
  of these three probes risk cascading Cosmos/Search/Foundry load under a partial outage — they will
  correctly keep reporting healthy/ready even while `/health/deep` would report a downstream `down`,
  which is the intended division of labor (probes = "is this replica itself alive and serving",
  deploy-gate's `/health/deep` call = "is this whole rollout's dependency graph healthy before we
  shift traffic").
- **Needs live verification / a real rollout before trusting the exact numbers**: these thresholds
  are derived from the existing Dockerfile `HEALTHCHECK` cadence and Microsoft's general guidance, not
  from an observed cold-start time or observed steady-state latency distribution for this specific
  app in this specific Container Apps environment. Recommend a canary rollout (the pipeline's own
  blue-green GREEN-at-0%-traffic step is a natural place to also watch replica start-to-ready timing
  before flipping traffic) to confirm the Startup probe's ~60s allowance is neither too tight (false
  restart during a real cold start) nor unnecessarily loose.
