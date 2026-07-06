# az containerapp update --set-env-vars diagnostic

Run: 2026-07-06T20:03:34Z

Exact command:
```
az containerapp update -n otchealth-mcp-gateway -g rg-otchealth-apps-prod --set-env-vars "GRAPH_DRIVE_USER=matthew@innd.com"
```

## Exit code
```
1
```

## STDERR (verbatim, full)
```
/ Running ..| Running ..\ Running ..- Running ../ Running ..| Running ..ERROR: Failed to provision revision for container app 'otchealth-mcp-gateway'. Error details: Failed to fetch secret 'graph-drive-user' from Azure Key Vault 'https://kv-otc-55c84f6bef.vault.azure.net/secrets/graph-drive-user' for ContainerApp 'otchealth-mcp-gateway': Managed identity is not enabled. To reference secrets from Azure Key Vault, a managed identity must be assigned to the ContainerApp and specified in the secret configuration with identity 'system'..
```

## STDOUT (verbatim, full)
```
```

## az version
```
{
  "azure-cli": "2.87.0",
  "azure-cli-core": "2.87.0",
  "azure-cli-telemetry": "1.1.0",
  "extensions": {
    "azure-devops": "1.0.5"
  }
}
```
