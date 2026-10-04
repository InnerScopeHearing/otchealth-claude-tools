#Requires -Version 7.0
param([string]$PackRoot=(Split-Path -Parent $PSScriptRoot),[Parameter(Mandatory=$true)][string]$TestRoot)
$ErrorActionPreference='Stop'
if (Test-Path -LiteralPath $TestRoot) { throw 'Use a fresh test directory' }
New-Item -ItemType Directory -Path $TestRoot | Out-Null
$Classifier=Join-Path $PackRoot 'skills/refresh-toolkit/scripts/classify-toolkit.ps1'
function Run-Snapshot([string]$Name,[hashtable]$Delta) {
 $Snapshot=@{schema_version=1;client_id='synthetic-work';session_id='fixture-session';seat='cto';captured_at_utc='2026-10-04T01:46:40Z';capabilities=@();errors=@();pending_writes=@()}
 foreach($Key in $Delta.Keys){$Snapshot[$Key]=$Delta[$Key]}
 $Path=Join-Path $TestRoot ($Name+'.json')
 [IO.File]::WriteAllText($Path,($Snapshot | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
 $Before=(Get-FileHash -LiteralPath $Path).Hash
 $Result=& $Classifier -SnapshotPath $Path | ConvertFrom-Json
 if($Result.mutated -ne $false -or (Get-FileHash -LiteralPath $Path).Hash -cne $Before -or $Result.live_acceptance -ne 'UNPROVEN_BY_SNAPSHOT'){throw 'Classifier side-effect/acceptance contract failed'}
 return $Result
}
$Results=[Collections.Generic.List[string]]::new()
$Healthy=Run-Snapshot 'healthy' @{capabilities=@(@{id='refresh-toolkit';available=$true;expected_revision='0.2.0';loaded_revision='0.2.0';invoked=$true})}
if($Healthy.state -ne 'snapshot_reports_ready' -or @($Healthy.issues).Count -ne 0){throw 'Healthy metadata classification failed'}
$Results.Add('ready metadata remains non-live proof')
$Blocked=Run-Snapshot 'host-block' @{errors=@('MCP tool call requires approval, but approval policy is never')}
if(@($Blocked.issues | Where-Object kind -eq 'host_policy_block').Count -ne 1){throw 'Host policy classification failed'}
$Results.Add('host approval block classified without permission change')
$Stale=Run-Snapshot 'stale' @{capabilities=@(@{id='reliability';available=$true;expected_revision='0.2.0';loaded_revision='0.1.0';invoked=$true},@{id='missing-action';available=$false})}
if(@($Stale.issues | Where-Object kind -eq 'revision_mismatch').Count -ne 1 -or @($Stale.issues | Where-Object kind -eq 'binding_missing').Count -ne 1){throw 'Stale/binding classification failed'}
$Results.Add('revision mismatch and missing binding remain separate')
$Retired=Run-Snapshot 'retired' @{capabilities=@(@{id='azure@claude-plugins-official';available=$true;retired=$true},@{id='removed-retired';available=$false;retired=$true;configured_enabled=$false;loader_failed=$false})}
if(@($Retired.issues).Count -ne 1 -or $Retired.issues[0].kind -ne 'retired_plugin_loaded'){throw 'Retirement classification failed'}
$Results.Add('retired package is cleanup, not capability restoration')
$RetiredMissing=Run-Snapshot 'retired-missing' @{capabilities=@(@{id='retired-unverified';available=$false;retired=$true},@{id='retired-enabled';available=$false;retired=$true;configured_enabled=$true;loader_failed=$true})}
if(@($RetiredMissing.issues | Where-Object kind -eq 'retirement_state_unverified').Count -ne 1 -or @($RetiredMissing.issues | Where-Object kind -eq 'retired_plugin_still_configured').Count -ne 1){throw 'Absent retired binding wrongly accepted'}
$Results.Add('absent retired binding does not prove disabled or clean')
$Unknown=Run-Snapshot 'unknown-write' @{pending_writes=@(@{intent_id='synthetic-intent-1';state='UNCONFIRMED'})}
if($Unknown.state -ne 'write_reconciliation_required' -or $Unknown.issues[0].capability_id -ne 'synthetic-intent-1'){throw 'Unknown-write preservation failed'}
$Results.Add('unknown write preserves exact intent and pauses refresh')
$NoRevision=Run-Snapshot 'unverified-revision' @{capabilities=@(@{id='skill';available=$true;expected_revision='0.2.0'})}
if(@($NoRevision.issues | Where-Object kind -eq 'loaded_revision_unverified').Count -ne 1 -or @($NoRevision.issues | Where-Object kind -eq 'invocation_unverified').Count -ne 1){throw 'Unknown revision/invocation failed'}
$Results.Add('missing version and invocation stay unverified')
$Auth=Run-Snapshot 'auth' @{errors=@('Provider returned 403 Forbidden')}
if($Auth.issues[0].kind -ne 'provider_auth_block'){throw 'Provider auth classification failed'}
$Results.Add('provider authorization distinguished from host policy')
$Unattributed=Run-Snapshot 'unattributed-denial' @{errors=@('403 Forbidden')}
if($Unattributed.issues[0].kind -ne 'authorization_layer_unverified'){throw 'Unattributed denial wrongly assigned to provider'}
$Results.Add('unattributed denial origin stays unverified')
$Refused=$false
try{Run-Snapshot 'wrong-schema' @{schema_version=2} | Out-Null}catch{$Refused=$_.Exception.Message -eq 'Unsupported snapshot schema'}
if(-not $Refused){throw 'Unknown schema was accepted'}
$Results.Add('unknown snapshot schema refused')
[pscustomobject]@{status='PASS';count=$Results.Count;tests=$Results.ToArray();test_root=$TestRoot;live_refresh='NOT_EXECUTED'} | ConvertTo-Json -Depth 6
