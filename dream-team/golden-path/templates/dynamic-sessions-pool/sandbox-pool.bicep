// ============================================================================
// DRAFT — Azure Container Apps Dynamic Sessions, CUSTOM CONTAINER pool, for the
// browser-agent / doc-indexer OCR / any LLM-generated-code execution surface. Hyper-V-isolated,
// ephemeral, OUTBOUND NETWORK DISABLED BY DEFAULT (EgressDisabled), no managed identity with
// fleet-secret access baked into the pool.
//
// Resource shape verified against Microsoft Learn during this research pass:
//   - Microsoft.App/sessionPools@2025-07-01 property values
//     https://learn.microsoft.com/azure/templates/microsoft.app/2025-07-01/sessionpools
//   - Custom container session pools (probes, network, custom images)
//     https://learn.microsoft.com/azure/container-apps/sessions-custom-container
//   - `az containerapp sessionpool create --network-status EgressDisabled` reference
//     https://learn.microsoft.com/azure/container-apps/session-pool#custom-container-session-pool
//
// PREREQUISITE (verify before deploying, flagged as a top risk in DESIGN.md): custom container
// session pools require a WORKLOAD-PROFILES-ENABLED Container Apps environment. Confirm the
// target environment (`cae-otchealth-apps` or `otchealth-jobs-env`) has workload profiles
// enabled; if not, this pool needs its own new environment — see DESIGN.md §2.1/§6 risk 2.
//
// NOT executed. Fill in params and run `az deployment group create` when ready to pilot.
// ============================================================================

@description('Azure region — must be one of the documented Dynamic Sessions regions (see Learn: Supported regions, e.g. westus2, eastus, etc. — verify the target RG region qualifies).')
param location string = resourceGroup().location

@description('Resource id of an EXISTING, workload-profiles-enabled Container Apps managed environment.')
param managedEnvironmentId string

@description('Session pool name.')
param poolName string = 'sp-fleet-sandbox'

@description('Custom container image, e.g. <acr>/fleet-sandbox@sha256:... (ALWAYS pin by digest, matching the golden-path convention in templates/golden-path/ — the platform caches images at pool-create/update time and does not detect a same-tag repush, so digest pinning is the only way to guarantee an update is actually picked up).')
param image string

@description('Port the custom container listens on for session HTTP traffic.')
param targetPort int = 8080

@description('CPU cores per session container.')
param cpu string = '0.5'

@description('Memory per session container, e.g. "1Gi".')
param memory string = '1Gi'

@minValue(1)
@description('Maximum concurrent sessions allowed (documented ceiling: 600).')
param maxConcurrentSessions int = 20

@minValue(0)
@description('Target number of warm, ready-to-allocate sessions kept in the pool at all times. Keep SMALL (1-2) — billing is based on resources consumed by the pool, so a large warm floor is an always-on cost even though the platform itself is consumption-shaped at the infra level. Revisit with real call-volume telemetry before raising.')
param readySessionInstances int = 1

@minValue(300)
@maxValue(3600)
@description('Seconds of idle time before an allocated session is torn down (allowed range 300-3600 per Learn).')
param cooldownPeriodInSeconds int = 300

resource sessionPool 'Microsoft.App/sessionPools@2025-07-01' = {
  name: poolName
  location: location
  properties: {
    environmentId: managedEnvironmentId
    poolManagementType: 'Dynamic'
    containerType: 'CustomContainer'
    scaleConfiguration: {
      maxConcurrentSessions: maxConcurrentSessions
      readySessionInstances: readySessionInstances
    }
    // ── THE HARD REQUIREMENT FROM THE TASK BRIEF: outbound network DISABLED by default. ──
    // EgressDisabled is also the documented DEFAULT, but set explicitly here so a future Bicep
    // edit cannot silently drop this by omitting the property. Do NOT flip to EgressEnabled on
    // this pool — if a future workload genuinely needs egress (e.g. an OAuth-consent flow), that
    // is a SEPARATE, explicitly-named pool (e.g. sp-browser-agent-egress), never a widened
    // default on the shared sandbox pool. See DESIGN.md §2.2 for the full reasoning.
    sessionNetworkConfiguration: {
      status: 'EgressDisabled'
    }
    dynamicPoolConfiguration: {
      // VERIFIED against Microsoft.App/sessionPools@2025-07-01 (Learn resource reference):
      // cooldownPeriodInSeconds/lifecycleType/maxAlivePeriodInSeconds nest under
      // lifecycleConfiguration — they are NOT direct properties of dynamicPoolConfiguration
      // (fixed a real compile error here; the original draft had them flat).
      lifecycleConfiguration: {
        cooldownPeriodInSeconds: cooldownPeriodInSeconds
        lifecycleType: 'Timed' // sessions live until cooldown expires with no activity — the
        // documented alternative, OnContainerExit, is for containers that intentionally run to
        // completion and exit on their own (e.g. a one-shot script); doc-indexer OCR / LLM-code
        // runs are closer to that shape, so OnContainerExit + maxAlivePeriodInSeconds is worth
        // revisiting once the actual session-container entrypoint behavior is finalized — left as
        // Timed here since it is the safer, more conservative default for a first pilot.
      }
    }
    customContainerTemplate: {
      containers: [
        {
          name: 'fleet-sandbox'
          image: image
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          // NO env vars baked in here. Per-run secrets (e.g. a scoped Azure AI Search key for
          // one specific doc-indexer OCR call) are passed by the CALLER at session-invocation
          // time (via the session's own request payload / the code-interpreter execution API),
          // never as a pool-wide environment variable. This is a deliberate hardening beyond
          // what the platform requires — see DESIGN.md §2.3.
          env: []
          // CORRECTION (verified against the live Microsoft.App/sessionPools@2025-07-01 schema,
          // Learn resource reference): SessionContainer does NOT expose a `probes` property in
          // this API version — its only fields are args/command/env/image/name/resources. The
          // original draft's Liveness/Startup probe block does not compile (BCP037, property not
          // allowed). Left OUT here rather than guessing an unverified shape from a preview API
          // version; if container health probing on session pools becomes available/needed,
          // re-check the schema at deploy time (`az provider show --namespace Microsoft.App` /
          // the latest sessionPools Learn page) before re-adding this.
        }
      ]
      ingress: {
        targetPort: targetPort
      }
    }
    // NO managedIdentitySettings block — the pool gets NO managed identity with fleet-secret
    // access. If a caller-scoped role assignment is ever needed for the platform's own
    // image-pull path (e.g. pulling from a private ACR requiring identity-based auth rather than
    // admin credentials), add a managedIdentitySettings entry scoped to ONLY AcrPull on the
    // sandbox image's own registry — never a broader identity. See DESIGN.md §2.3.
  }
}

output poolManagementEndpoint string = sessionPool.properties.poolManagementEndpoint
