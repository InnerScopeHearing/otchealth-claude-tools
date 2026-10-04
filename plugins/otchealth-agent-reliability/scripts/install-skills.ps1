#Requires -Version 7.0
param(
 [Parameter(Mandatory=$true)][string]$DestinationRoot,
 [string]$PackRoot = (Split-Path -Parent $PSScriptRoot)
)
$ErrorActionPreference = 'Stop'
$PackRoot = [IO.Path]::GetFullPath($PackRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
$DestinationRoot = [IO.Path]::GetFullPath($DestinationRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
function Assert-NoReparse([string]$Path) {
 $Cursor = $Path
 while ($Cursor) {
  if (Test-Path -LiteralPath $Cursor) {
   if ((Get-Item -Force -LiteralPath $Cursor).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse target refused: $Cursor" }
  }
  $Parent = Split-Path -Parent $Cursor
  if ($Parent -eq $Cursor) { break }
  $Cursor = $Parent
 }
}
Assert-NoReparse $PackRoot
Assert-NoReparse $DestinationRoot
if ((Split-Path -Leaf $DestinationRoot) -ne 'skills' -or (Split-Path -Leaf (Split-Path -Parent $DestinationRoot)) -notin @('.agents','.claude')) { throw 'Destination must be an explicit .agents/skills or .claude/skills container' }
if ($DestinationRoot.Equals($PackRoot,[StringComparison]::OrdinalIgnoreCase) -or
    $DestinationRoot.StartsWith($PackRoot + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or
    $PackRoot.StartsWith($DestinationRoot + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Destination overlaps package source' }
$Validation = & (Join-Path $PSScriptRoot 'validate-pack.ps1') -PackRoot $PackRoot | ConvertFrom-Json
if ($Validation.status -ne 'PASS') { throw 'Source validation failed' }
$SourceRoot = Join-Path $PackRoot 'skills'
$Plan = foreach ($Skill in $Validation.skills) {
 $Folder = Join-Path $SourceRoot $Skill.name
 foreach ($File in Get-ChildItem -LiteralPath $Folder -File -Recurse) {
  $Relative = [IO.Path]::GetRelativePath($SourceRoot,$File.FullName)
  $Target = [IO.Path]::GetFullPath((Join-Path $DestinationRoot $Relative))
  if (-not $Target.StartsWith($DestinationRoot + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Target escaped destination' }
  Assert-NoReparse $Target
  $Expected = (Get-FileHash -LiteralPath $File.FullName -Algorithm SHA256).Hash
  $Exists = Test-Path -LiteralPath $Target
  if ($Exists -and ((-not (Test-Path -LiteralPath $Target -PathType Leaf)) -or (Get-FileHash -LiteralPath $Target -Algorithm SHA256).Hash -cne $Expected)) { throw "Existing differing target refused: $Relative" }
  [pscustomobject]@{source=$File.FullName;target=$Target;sha256=$Expected;exists=$Exists}
 }
}
# All conflicts are checked before the first write. No deletion or settings change.
$Copied = 0
foreach ($Entry in $Plan) {
 if (-not $Entry.exists) {
  New-Item -ItemType Directory -Path (Split-Path -Parent $Entry.target) -Force | Out-Null
  Copy-Item -LiteralPath $Entry.source -Destination $Entry.target
  $Copied++
 }
 if ((Get-FileHash -LiteralPath $Entry.target -Algorithm SHA256).Hash -cne $Entry.sha256) { throw "Readback mismatch: $($Entry.target)" }
}
[pscustomobject]@{status='copied_and_hash_verified';version=$Validation.version;destination=$DestinationRoot;skill_count=$Validation.skill_count;files_verified=@($Plan).Count;files_copied=$Copied;runtime_discovery='UNPROVEN';runtime_invocation='UNPROVEN';checked_at_utc=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Depth 5
