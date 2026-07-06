# Key Vault network + RBAC diagnostic
Run: 2026-07-06T20:31:13Z

## networkAcls
```json
```
stderr:
```
```
## publicNetworkAccess
```json
"Enabled"
```
## enableRbacAuthorization
```json
true
```
## privateEndpointConnections
```json
```
## container app identity
```json
{
  "principalId": "c135b006-883e-4f0d-80c3-ba1e60204416",
  "tenantId": "4ab58580-cc9c-49f7-b5c7-a77f84fdc270",
  "type": "SystemAssigned"
}
```
identity stderr:
```
```
## role assignments on vault scope for principal
```json
[
  {
    "condition": null,
    "conditionVersion": null,
    "createdBy": "d3a27b50-5bd3-4a55-898b-1eef9ae1de6f",
    "createdOn": "2026-07-06T20:22:42.966431+00:00",
    "delegatedManagedIdentityResourceId": null,
    "description": null,
    "id": "/subscriptions/55c84f6b-ef90-4259-a58b-50835cc4cab4/resourceGroups/rg-otchealth-shared-prod/providers/Microsoft.KeyVault/vaults/kv-otc-55c84f6bef/providers/Microsoft.Authorization/roleAssignments/3aac8ef7-97b0-432c-8d32-2d067315c0fe",
    "name": "3aac8ef7-97b0-432c-8d32-2d067315c0fe",
    "principalId": "c135b006-883e-4f0d-80c3-ba1e60204416",
    "principalType": "ServicePrincipal",
    "resourceGroup": "rg-otchealth-shared-prod",
    "roleDefinitionId": "/subscriptions/55c84f6b-ef90-4259-a58b-50835cc4cab4/providers/Microsoft.Authorization/roleDefinitions/4633458b-17de-408a-b874-0445c86b69e6",
    "roleDefinitionName": "Key Vault Secrets User",
    "scope": "/subscriptions/55c84f6b-ef90-4259-a58b-50835cc4cab4/resourceGroups/rg-otchealth-shared-prod/providers/Microsoft.KeyVault/vaults/kv-otc-55c84f6bef",
    "type": "Microsoft.Authorization/roleAssignments",
    "updatedBy": "d3a27b50-5bd3-4a55-898b-1eef9ae1de6f",
    "updatedOn": "2026-07-06T20:22:42.966431+00:00"
  }
]
```
roles stderr:
```
WARNING: Failed to query c135b006-883e-4f0d-80c3-ba1e60204416 by invoking Graph API. If you don't have permission to query Graph API, please specify --assignee-object-id and --assignee-principal-type.
WARNING: Assuming c135b006-883e-4f0d-80c3-ba1e60204416 as an object ID.
```
## ALL role assignments for principal
```json
[
  {
    "condition": null,
    "conditionVersion": null,
    "createdBy": "d3a27b50-5bd3-4a55-898b-1eef9ae1de6f",
    "createdOn": "2026-07-06T20:22:42.966431+00:00",
    "delegatedManagedIdentityResourceId": null,
    "description": null,
    "id": "/subscriptions/55c84f6b-ef90-4259-a58b-50835cc4cab4/resourceGroups/rg-otchealth-shared-prod/providers/Microsoft.KeyVault/vaults/kv-otc-55c84f6bef/providers/Microsoft.Authorization/roleAssignments/3aac8ef7-97b0-432c-8d32-2d067315c0fe",
    "name": "3aac8ef7-97b0-432c-8d32-2d067315c0fe",
    "principalId": "c135b006-883e-4f0d-80c3-ba1e60204416",
    "principalType": "ServicePrincipal",
    "resourceGroup": "rg-otchealth-shared-prod",
    "roleDefinitionId": "/subscriptions/55c84f6b-ef90-4259-a58b-50835cc4cab4/providers/Microsoft.Authorization/roleDefinitions/4633458b-17de-408a-b874-0445c86b69e6",
    "roleDefinitionName": "Key Vault Secrets User",
    "scope": "/subscriptions/55c84f6b-ef90-4259-a58b-50835cc4cab4/resourceGroups/rg-otchealth-shared-prod/providers/Microsoft.KeyVault/vaults/kv-otc-55c84f6bef",
    "type": "Microsoft.Authorization/roleAssignments",
    "updatedBy": "d3a27b50-5bd3-4a55-898b-1eef9ae1de6f",
    "updatedOn": "2026-07-06T20:22:42.966431+00:00"
  }
]
```
## environmentId
```
/subscriptions/55c84f6b-ef90-4259-a58b-50835cc4cab4/resourceGroups/rg-otchealth-apps-prod/providers/Microsoft.App/managedEnvironments/cae-otchealth-apps
```
## env vnetConfiguration
```json
```
vnet stderr:
```
```
## current app secrets
```json
[
  {
    "name": "twilio-account-sid"
  },
  {
    "name": "github-app-private-key"
  },
  {
    "name": "dd-api-key"
  },
  {
    "name": "depot-token"
  },
  {
    "name": "websearch-sp-secret"
  },
  {
    "name": "di-key"
  },
  {
    "name": "graph-cid"
  },
  {
    "name": "netlify"
  },
  {
    "name": "posthog-personal-api-key"
  },
  {
    "name": "cosmos-agent-state-key"
  },
  {
    "name": "shopify-token"
  },
  {
    "name": "cs-key"
  },
  {
    "name": "acm-key"
  },
  {
    "name": "oauth-clients"
  },
  {
    "name": "cio-app-bearer"
  },
  {
    "name": "acr-pwd"
  },
  {
    "name": "cio-track-key"
  },
  {
    "name": "oauth-client-id"
  },
  {
    "name": "admin-revoke"
  },
  {
    "name": "graph-tid"
  },
  {
    "name": "agent-inbox-key"
  },
  {
    "name": "search-query-key"
  },
  {
    "name": "cio-site-id"
  },
  {
    "name": "revenuecat-secret-key"
  },
  {
    "name": "github-webhook-secret"
  },
  {
    "name": "graph-csec"
  },
  {
    "name": "copilot-agent-token"
  },
  {
    "name": "sentry-auth-token"
  },
  {
    "name": "n8n-api-key"
  },
  {
    "name": "oauth-token-signing-secret"
  },
  {
    "name": "brain-search-key"
  },
  {
    "name": "connector-token"
  },
  {
    "name": "router-key"
  },
  {
    "name": "stripe-key"
  },
  {
    "name": "n8n-webhook"
  },
  {
    "name": "oauth-client-secret"
  },
  {
    "name": "miro-token"
  },
  {
    "name": "foundry-key"
  },
  {
    "name": "twilio-auth-token"
  },
  {
    "name": "cf-token"
  }
]
```
