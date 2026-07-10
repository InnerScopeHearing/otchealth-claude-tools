// ============================================================================
// TEMPLATE — a per-app Container App (Infrastructure as Code), parameterized
// from otchealth-mcp-server/infra/gateway.bicep. This is the golden-path IaC
// template every backend repo's `infra/app.bicep` should start from.
//
// It models the TARGET posture (Layer E of the Azure AI OS design):
//   - system-assigned managed identity + AcrPull  (no ACR admin password secret)
//   - secrets as Key Vault references              (GCP Secret Manager stays store-of-record;
//                                                    Key Vault is the CI/CD-readable Azure mirror)
//   - immutable @sha256 image digest, never a tag
//   - blue-green: multiple-revision mode + git-sha revision suffix
//
// ADOPT: copy this file into your repo as infra/app.bicep, keep the resource shape as-is, and
// pass your own values for appName / acrLoginServer / image / plainEnv / secretEnv / secretRefs
// at deploy time (or set repo-specific defaults on the params below). If your app ALREADY has a
// live Container App with different settings (ACR admin-password auth, inline secrets, no
// identity), do NOT blind-apply a Deployment Stack over it — follow the same staged migration
// the gateway's own infra/README.md documents: (1) grant system-assigned identity + AcrPull,
// (2) migrate inline secrets to Key Vault + repoint as keyVaultUrl refs, (3) `az deployment
// group what-if` until the diff against the live resource is empty, (4) THEN wrap it in a
// Deployment Stack with denyWriteAndDelete excluding your app's own CI deploy identity.
// ============================================================================

@description('Azure region (must match the managed environment).')
param location string = resourceGroup().location

@description('Resource id of the existing Container Apps managed environment.')
param managedEnvironmentId string

@description('Container app name.')
param appName string

@description('ACR login server, e.g. acrotc55c84f6bef.azurecr.io')
param acrLoginServer string

@description('Full immutable image reference, e.g. <acr>/<image-repo>@sha256:...')
param image string

@description('Ingress target port.')
param targetPort int = 8080

@minValue(1)
param minReplicas int = 1
@minValue(1)
param maxReplicas int = 3

param cpu string = '0.5' // right-size small; every non-gateway app should stay scale-to-zero-friendly
param memory string = '1Gi'

@description('Non-secret environment variables: [{ name, value }].')
param plainEnv array = []

@description('Secret-backed env: [{ name, secretRef }] where secretRef names an entry in secretRefs.')
param secretEnv array = []

@description('Secrets as Key Vault references: [{ name, keyVaultUrl }]. Resolved by the managed identity.')
param secretRefs array = []

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  identity: {
    // System-assigned identity: used for AcrPull (image pulls) + Key Vault secret resolution.
    // NOTE: this is the RUNTIME identity (what the container itself runs as). It is SEPARATE
    // from the CI/CD deploy-time UAMI (id-<app>-deployer) that GitHub Actions authenticates as
    // via OIDC — do not conflate the two. This app identity never leaves Azure; the deploy UAMI
    // is what GitHub's OIDC token exchanges for.
    type: 'SystemAssigned'
  }
  properties: {
    managedEnvironmentId: managedEnvironmentId
    configuration: {
      activeRevisionsMode: 'Multiple'
      ingress: {
        external: true
        targetPort: targetPort
        transport: 'Auto'
        allowInsecure: false
      }
      registries: [
        {
          server: acrLoginServer
          // Pull with the app's managed identity (AcrPull), not an admin username/password secret.
          identity: 'system'
        }
      ]
      secrets: [
        for s in secretRefs: {
          name: s.name
          keyVaultUrl: s.keyVaultUrl
          identity: 'system'
        }
      ]
    }
    template: {
      containers: [
        {
          name: appName
          image: image
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          // plainEnv = [{ name, value }], secretEnv = [{ name, secretRef }]; both are valid env entries.
          env: concat(plainEnv, secretEnv)
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
      }
    }
  }
}

output principalId string = app.identity.principalId
output fqdn string = app.properties.configuration.ingress.fqdn
