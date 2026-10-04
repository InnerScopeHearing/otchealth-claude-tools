#Requires -Version 7.0
param([string]$PackRoot = (Split-Path -Parent $PSScriptRoot),[Parameter(Mandatory=$true)][string]$TestRoot)
$ErrorActionPreference = 'Stop'
$TestRoot = [IO.Path]::GetFullPath($TestRoot)
if (Test-Path -LiteralPath $TestRoot) { throw 'Use a fresh test directory' }
New-Item -ItemType Directory -Path $TestRoot | Out-Null
$Installer = Join-Path $PackRoot 'scripts/install-skills.ps1'
$Target = Join-Path $TestRoot '.agents/skills'
$First = & $Installer -PackRoot $PackRoot -DestinationRoot $Target | ConvertFrom-Json
$Again = & $Installer -PackRoot $PackRoot -DestinationRoot $Target | ConvertFrom-Json
$ExpectedFiles = @(Get-ChildItem -LiteralPath (Join-Path $PackRoot 'skills') -File -Recurse).Count
if ($First.files_copied -ne $ExpectedFiles -or $Again.files_copied -ne 0 -or $First.skill_count -ne 9) { throw 'Install/idempotence failed' }
$Conflict = Join-Path $Target 'brain-memory-readback/SKILL.md'
[IO.File]::WriteAllText($Conflict,'synthetic owner content')
$Before = (Get-FileHash -LiteralPath $Conflict).Hash
$Rejected = $false
try { & $Installer -PackRoot $PackRoot -DestinationRoot $Target | Out-Null } catch { $Rejected = $_.Exception.Message -like 'Existing differing target refused:*' }
if (-not $Rejected -or (Get-FileHash -LiteralPath $Conflict).Hash -cne $Before) { throw 'Conflict preservation failed' }
$Invalid = Join-Path $TestRoot 'outside'
$Refused = $false
try { & $Installer -PackRoot $PackRoot -DestinationRoot $Invalid | Out-Null } catch { $Refused = $_.Exception.Message -eq 'Destination must be an explicit .agents/skills or .claude/skills container' }
if (-not $Refused -or (Test-Path -LiteralPath $Invalid)) { throw 'Destination admission failed' }
$ReverseDestination = Join-Path $TestRoot 'reverse/.agents/skills'
$ReversePack = Join-Path $ReverseDestination 'capability-preflight'
New-Item -ItemType Directory -Path $ReversePack -Force | Out-Null
foreach ($Item in Get-ChildItem -LiteralPath $PackRoot -Force | Where-Object Name -ne '.git') { Copy-Item -LiteralPath $Item.FullName -Destination $ReversePack -Recurse }
$BeforeFiles = @(Get-ChildItem -LiteralPath $ReverseDestination -File -Recurse)
$RefusedReverse = $false
try { & $Installer -PackRoot $ReversePack -DestinationRoot $ReverseDestination | Out-Null } catch { $RefusedReverse = $_.Exception.Message -eq 'Destination overlaps package source' }
if (-not $RefusedReverse -or @(Get-ChildItem -LiteralPath $ReverseDestination -File -Recurse).Count -ne $BeforeFiles.Count -or (Test-Path -LiteralPath (Join-Path $ReversePack 'SKILL.md'))) { throw 'Reverse-overlap preservation failed' }
$EqualRoot = Join-Path $TestRoot 'equal/.agents/skills'
New-Item -ItemType Directory -Path $EqualRoot -Force | Out-Null
foreach ($Item in Get-ChildItem -LiteralPath $PackRoot -Force | Where-Object Name -ne '.git') { Copy-Item -LiteralPath $Item.FullName -Destination $EqualRoot -Recurse }
$EqualBefore = @(Get-ChildItem -LiteralPath $EqualRoot -File -Recurse).Count
$RefusedEqual = $false
try { & $Installer -PackRoot $EqualRoot -DestinationRoot $EqualRoot | Out-Null } catch { $RefusedEqual = $_.Exception.Message -eq 'Destination overlaps package source' }
if (-not $RefusedEqual -or @(Get-ChildItem -LiteralPath $EqualRoot -File -Recurse).Count -ne $EqualBefore) { throw 'Equal-source preservation failed' }
[pscustomobject]@{status='PASS';tests=@('fresh install exact hashes','idempotent same content','owner conflict preserved','invalid destination rejected before mutation','reverse overlap rejected before mutation','equal source target rejected before mutation');count=6;test_root=$TestRoot} | ConvertTo-Json -Depth 5
