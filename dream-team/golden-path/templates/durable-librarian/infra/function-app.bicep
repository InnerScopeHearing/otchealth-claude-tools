// ============================================================================
// DRAFT — Flex Consumption Function App + Durable Task Scheduler (Consumption SKU) + one
// shared task hub, for the librarian fan-out orchestrator (and any future Durable Functions
// workload — this scheduler/task-hub pair is meant to be SHARED across the fleet, not
// per-app; Consumption SKU quota is 10 schedulers / 5 task hubs per region per subscription,
// so minting a new scheduler per workload burns that budget fast for no benefit).
//
// Resource shapes verified against Microsoft Learn during this research pass:
//   - Microsoft.DurableTask/schedulers@2025-11-01
//     https://learn.microsoft.com/azure/templates/microsoft.durabletask/2025-11-01/schedulers
//   - Microsoft.DurableTask/schedulers/taskHubs@2025-11-01
//     https://learn.microsoft.com/azure/templates/microsoft.durabletask/2025-11-01/schedulers/taskhubs
//   - Flex Consumption Microsoft.Web/sites functionAppConfig shape
//     https://learn.microsoft.com/azure/azure-functions/functions-infrastructure-as-code
//
// NOT executed. Fill in params and run `az deployment group create` when ready to pilot.
// ============================================================================

@description('Azure region.')
param location string = resourceGroup().location

@description('Durable Task Scheduler resource name (SHARED — one per subscription, not per app).')
param schedulerName string = 'sched-otchealth-jobs'

@description('Task hub name inside the scheduler (SHARED across every Durable Functions workload).')
param taskHubName string = 'fleet-orchestration'

@description('Function App name for this specific workload (one Flex Consumption plan supports exactly one app).')
param functionAppName string = 'fn-fleet-librarian'

@description('Existing storage account for the Function App runtime + deployment package container.')
param storageAccountName string

@description('Deployment package blob container name.')
param deploymentContainerName string = 'deploymentpackage'

// ── Durable Task Scheduler (Consumption SKU — pay-per-action, no idle cost). ──
resource scheduler 'Microsoft.DurableTask/schedulers@2025-11-01' = {
  name: schedulerName
  location: location
  properties: {
    ipAllowlist: ['0.0.0.0/0'] // tighten to a specific CIDR/VNet range once the Function App's
    // outbound IPs are known; left open here to match the documented quickstart pattern, NOT a
    // final production posture — narrow this before relying on it for anything beyond the pilot.
    sku: {
      name: 'Consumption'
    }
  }
}

resource taskHub 'Microsoft.DurableTask/schedulers/taskHubs@2025-11-01' = {
  parent: scheduler
  name: taskHubName
  properties: {}
}

// ── Storage account reference (existing — the Function App needs its own runtime storage;
//    reuse an existing fleet storage account rather than minting a new one if one already
//    fits the naming/region requirements). ──
resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' existing = {
  name: storageAccountName
}

resource deploymentContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  name: '${storageAccountName}/default/${deploymentContainerName}'
}

// ── Flex Consumption App Service plan. ──
resource plan 'Microsoft.Web/serverfarms@2024-11-01' = {
  name: '${functionAppName}-plan'
  location: location
  sku: {
    name: 'FC1'
    tier: 'FlexConsumption'
  }
  properties: {
    reserved: true // Flex Consumption is Linux-only
  }
}

// ── The Function App itself. System-assigned identity resolves both the deployment-storage
//    blob container (via role assignment below) AND the Durable Task Scheduler connection (via
//    the "Durable Task Data Contributor" role assignment — see infra/README.md step 3, NOT
//    modeled inline here because it needs the scheduler's principal-agnostic role-definition ID
//    resolved at deploy time; do it as a follow-up `az role assignment create` per the
//    README.md, or extend this Bicep with a Microsoft.Authorization/roleAssignments resource
//    once the exact role-definition GUID is confirmed for this subscription). ──
resource functionApp 'Microsoft.Web/sites@2024-11-01' = {
  name: functionAppName
  location: location
  kind: 'functionapp,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: plan.id
    siteConfig: {
      appSettings: [
        {
          name: 'AzureWebJobsStorage__accountName'
          value: storageAccountName // managed-identity-based storage connection, no connection string
        }
        {
          name: 'FUNCTIONS_EXTENSION_VERSION'
          value: '~4'
        }
        {
          name: 'DURABLE_TASK_SCHEDULER_CONNECTION_STRING'
          // System-assigned identity, no ClientID segment (Learn: "If you use a system-assigned
          // managed identity, omit the ClientID segment from the connection string"). The
          // scheduler resource's endpoint is exposed as `properties.endpoint` (confirmed against
          // the @azure/arm-durabletask / Azure.ResourceManager.DurableTask SDK reference:
          // DurableTaskSchedulerProperties.Endpoint, "URL of the durable task scheduler").
          value: 'Endpoint=${scheduler.properties.endpoint};Authentication=ManagedIdentity'
        }
      ]
    }
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          // Resolved from the `storageAccount existing` resource's own primaryEndpoints.blob
          // rather than hardcoding the public-cloud "blob.core.windows.net" suffix — the linter
          // (no-hardcoded-env-urls) flags a literal host here because a hardcoded suffix would
          // silently break in a sovereign/Gov cloud; this also puts the `existing` resource to
          // actual use (it was declared-but-unreferenced in the original draft).
          value: '${storageAccount.properties.primaryEndpoints.blob}${deploymentContainerName}'
          authentication: {
            type: 'SystemAssignedIdentity'
          }
        }
      }
      scaleAndConcurrency: {
        maximumInstanceCount: 40 // small ceiling; this workload is 4 rooms fanned out, not a
        // high-QPS product surface — keep this low so a runaway retry loop cannot silently burn
        // the shared free grant. Raise only with telemetry justifying it.
        instanceMemoryMB: 2048
      }
      runtime: {
        name: 'node'
        version: '22'
      }
    }
  }
}

// AcrPull / storage role assignments for the Function App's system-assigned identity would go
// here as Microsoft.Authorization/roleAssignments resources once the target storage account's
// resource ID and the "Storage Blob Data Owner" (or narrower "Storage Blob Data Contributor")
// role-definition ID are confirmed — omitted in this draft to avoid guessing a role-definition
// GUID; use `az role assignment create --assignee <principalId> --role "Storage Blob Data
// Contributor" --scope <storageAccountId>` as a manual follow-up step, matching the pattern the
// README.md's step 3 already documents for the Durable Task Data Contributor grant.

output functionAppPrincipalId string = functionApp.identity.principalId
output schedulerResourceId string = scheduler.id
output taskHubResourceId string = taskHub.id
output schedulerEndpoint string = scheduler.properties.endpoint
// The free operator dashboard — pause/resume/terminate/raise-events on any orchestration
// instance, no custom tooling required. Requires the "Durable Task Data Contributor" role on
// the caller's own identity, scoped to this scheduler (or the task hub for narrower access):
//   az role assignment create --assignee <your-email-or-principal-id> \
//     --role "Durable Task Data Contributor" --scope <schedulerResourceId output above>
output dashboardUrl string = 'https://dashboard.durabletask.io/?endpoint=${scheduler.properties.endpoint}&taskhub=${taskHubName}'
