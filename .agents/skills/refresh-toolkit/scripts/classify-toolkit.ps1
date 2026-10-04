#Requires -Version 7.0
param([Parameter(Mandatory=$true)][string]$SnapshotPath)
$ErrorActionPreference = 'Stop'
$Snapshot = [IO.File]::ReadAllText([IO.Path]::GetFullPath($SnapshotPath)) | ConvertFrom-Json
if ($Snapshot.schema_version -ne 1) { throw 'Unsupported snapshot schema' }
foreach ($Key in @('client_id','session_id','seat','captured_at_utc')) {
 if ([string]::IsNullOrWhiteSpace([string]$Snapshot.$Key)) { throw "Missing target metadata: $Key" }
}
$Timestamp = [DateTimeOffset]::MinValue
if (-not [DateTimeOffset]::TryParse([string]$Snapshot.captured_at_utc,[ref]$Timestamp)) { throw 'Invalid captured_at_utc' }
$Issues = [Collections.Generic.List[object]]::new()
foreach ($Write in @($Snapshot.pending_writes)) {
 if ($null -eq $Write) { continue }
 if ([string]$Write.state -match '^(unknown|unconfirmed)$') {
  if ([string]::IsNullOrWhiteSpace([string]$Write.intent_id)) { throw 'Unknown write missing intent_id' }
  $Issues.Add([pscustomobject]@{kind='unknown_write';capability_id=[string]$Write.intent_id;next_action='reconcile_same_intent_before_refresh_or_retry'})
 }
}
foreach ($ErrorText in @($Snapshot.errors)) {
 if ([string]$ErrorText -match 'requires approval.*approval policy is never') {
  $Issues.Add([pscustomobject]@{kind='host_policy_block';capability_id=$null;next_action='owning_product_policy_control_required_no_alternate_route'})
 } elseif ([string]$ErrorText -match '(?i)\b(401|403|unauthorized|forbidden|oauth)\b' -and [string]$ErrorText -match '(?i)^provider(?:\s|:)') {
  $Issues.Add([pscustomobject]@{kind='provider_auth_block';capability_id=$null;next_action='inspect_intended_account_authorization'})
 } elseif ([string]$ErrorText -match '(?i)\b(401|403|unauthorized|forbidden|oauth)\b') {
  $Issues.Add([pscustomobject]@{kind='authorization_layer_unverified';capability_id=$null;next_action='identify_host_workspace_or_provider_origin_before_repair'})
 }
}
foreach ($Capability in @($Snapshot.capabilities)) {
 if ($null -eq $Capability) { continue }
 if ([string]::IsNullOrWhiteSpace([string]$Capability.id) -or $Capability.available -isnot [bool]) { throw 'Invalid capability metadata' }
 foreach ($Flag in @('retired','invoked','configured_enabled','loader_failed')) {
  if ($Capability.PSObject.Properties.Name -contains $Flag -and $Capability.$Flag -isnot [bool]) { throw 'Invalid capability boolean evidence' }
 }
 if ($Capability.retired -eq $true) {
  if ($Capability.available) { $Issues.Add([pscustomobject]@{kind='retired_plugin_loaded';capability_id=[string]$Capability.id;next_action='supported_retirement_then_effective_config_and_loader_readback'}) }
  elseif ($Capability.configured_enabled -eq $true -or $Capability.loader_failed -eq $true) { $Issues.Add([pscustomobject]@{kind='retired_plugin_still_configured';capability_id=[string]$Capability.id;next_action='supported_retirement_then_effective_config_and_loader_readback'}) }
  elseif ($Capability.configured_enabled -isnot [bool] -or $Capability.loader_failed -isnot [bool]) { $Issues.Add([pscustomobject]@{kind='retirement_state_unverified';capability_id=[string]$Capability.id;next_action='verify_effective_disabled_state_and_loader_cleanup'}) }
  continue
 }
 if (-not $Capability.available) {
  $Issues.Add([pscustomobject]@{kind='binding_missing';capability_id=[string]$Capability.id;next_action='supported_same_client_refresh_then_catalog_and_invocation'})
  continue
 }
 if (-not [string]::IsNullOrWhiteSpace([string]$Capability.expected_revision)) {
  if ([string]::IsNullOrWhiteSpace([string]$Capability.loaded_revision)) {
   $Issues.Add([pscustomobject]@{kind='loaded_revision_unverified';capability_id=[string]$Capability.id;next_action='read_actual_loader_revision'})
  } elseif ([string]$Capability.loaded_revision -cne [string]$Capability.expected_revision) {
   $Issues.Add([pscustomobject]@{kind='revision_mismatch';capability_id=[string]$Capability.id;next_action='supported_same_client_update_then_load_and_invoke'})
  }
 }
 if ($Capability.invoked -ne $true) { $Issues.Add([pscustomobject]@{kind='invocation_unverified';capability_id=[string]$Capability.id;next_action='harmless_same_client_invocation'}) }
}
$State = if (@($Issues | Where-Object kind -eq 'unknown_write').Count) { 'write_reconciliation_required' } elseif ($Issues.Count) { 'attention_required' } else { 'snapshot_reports_ready' }
[pscustomobject]@{schema_version=1;state=$State;client_id=[string]$Snapshot.client_id;session_id=[string]$Snapshot.session_id;seat=[string]$Snapshot.seat;captured_at_utc=[string]$Snapshot.captured_at_utc;issues=@($Issues);operation='metadata_diagnosis_only';mutated=$false;live_acceptance='UNPROVEN_BY_SNAPSHOT'} | ConvertTo-Json -Depth 6
