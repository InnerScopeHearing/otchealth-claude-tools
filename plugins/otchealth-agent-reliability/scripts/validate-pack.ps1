#Requires -Version 7.0
param([string]$PackRoot = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = 'Stop'
$ExpectedNames = @('capability-preflight','brain-memory-readback','context-continuity','bounded-repair','vendor-access-proof','release-evidence','skill-distribution','source-grounding')
$PackRoot = [IO.Path]::GetFullPath($PackRoot)
$Manifest = Get-Content -Raw -LiteralPath (Join-Path $PackRoot 'plugin.json') | ConvertFrom-Json
$Overlay = Get-Content -Raw -LiteralPath (Join-Path $PackRoot '.codex-plugin/plugin.json') | ConvertFrom-Json
if ($Manifest.name -ne 'otchealth-agent-reliability' -or $Manifest.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid identity or version' }
if ($Manifest.name -ne $Overlay.name -or $Manifest.version -ne $Overlay.version) { throw 'Manifest identity mismatch' }
$Interface = $Manifest.extensions.'com.openai'.interface
if ($Interface.shortDescription.Length -gt 30) { throw 'Subtitle exceeds 30 characters' }
foreach ($Key in @('displayName','shortDescription','developerName','category','defaultPrompt')) {
 if ($Interface.$Key -cne $Overlay.interface.$Key) { throw "Manifest presentation mismatch: $Key" }
}
if ($Overlay.skills -ne './skills') { throw 'Invalid compatibility skills path' }
foreach ($Forbidden in @('skills','mcpServers','apps','interface')) {
 if ($Manifest.PSObject.Properties.Name -contains $Forbidden) { throw "Invalid portable manifest field: $Forbidden" }
}
$Links = Get-ChildItem -LiteralPath $PackRoot -Force -Recurse | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }
if ($Links) { throw 'Package contains a reparse point' }
$SkillRoot = Join-Path $PackRoot 'skills'
$ActualNames = @(Get-ChildItem -LiteralPath $SkillRoot -Directory | ForEach-Object Name)
if (@(Compare-Object $ExpectedNames $ActualNames).Count) { throw 'Unexpected skill inventory' }
$Results = foreach ($Name in $ExpectedNames) {
 $Folder = Join-Path $SkillRoot $Name
 $Path = Join-Path $Folder 'SKILL.md'
 $Text = [IO.File]::ReadAllText($Path)
 if ($Text -notmatch '(?s)^---\r?\n(.*?)\r?\n---\r?\n') { throw "Invalid frontmatter: $Name" }
 $Front = $Matches[1]
 if ($Front -notmatch "(?m)^name: $([regex]::Escape($Name))\r?$" -or $Front -notmatch '(?m)^description: .+\r?$') { throw "Missing name/description: $Name" }
 if ($Text -match '(?im)^\s*(TODO|TBD|PLACEHOLDER)\b') { throw "Unfinished scaffold: $Name" }
 foreach ($Match in [regex]::Matches($Text,'\]\(([^)]+)\)')) {
  $Ref = $Match.Groups[1].Value
  if ($Ref -match '^https?://') { continue }
  $Resolved = [IO.Path]::GetFullPath((Join-Path $Folder $Ref))
  if (-not $Resolved.StartsWith($Folder + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw "Reference escapes skill: $Name" }
  if (-not (Test-Path -LiteralPath $Resolved -PathType Leaf)) { throw "Missing reference: $Name" }
 }
 [pscustomobject]@{name=$Name;sha256=(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant();bytes=(Get-Item -LiteralPath $Path).Length}
}
[pscustomobject]@{status='PASS';name=$Manifest.name;version=$Manifest.version;skill_count=$Results.Count;skills=$Results} | ConvertTo-Json -Depth 8
