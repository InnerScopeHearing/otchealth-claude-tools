<#
Runs the test files one after the other, each in its own PowerShell process, and prints a summary.

  pwsh -NoProfile -File tests/Run-Tests.ps1                                   all tests (PowerShell 7, for example on Linux)
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests\Run-Tests.ps1   all tests in Windows PowerShell 5.1
  ... -Only 01,02,05                                                           only the files whose names start with these numbers

The exit code is the number of test files that failed (0 means all passed).
Every test file runs in the same kind of PowerShell as this runner (the program that started it), so this file must stay
valid in Windows PowerShell 5.1 as well.

What these tests are:
  * 01 and 02 check the syntax of the script and of the test files, and the use of features that Windows PowerShell 5.1 lacks.
    03, 04 and 05 test the Codex TOML editor, the JSON editor and the Step 7 marker editor. 06 runs the whole script against a
    pretend PC (FakeWorld.ps1). 07 runs the low level helpers for real (real programs, real files, a real local web server, the
    real self-check programs on Windows). 08 runs the script as a file in a child PowerShell. 09 and 10 are seeded randomized
    tests of the TOML and JSON editors, checked against Python's own TOML and JSON parsers.
  * The same files run on the Linux test machine (PowerShell 7.5) and in the GitHub job "pc-toolkit-ps51" on a real Windows
    machine with Windows PowerShell 5.1 (.github/workflows/pc-toolkit-ps51.yml). A check that only makes sense on one kind of
    machine is shown as "skip" with its reason (and counted separately), never as a pass.
  * What no test can show is how the real AWS tools behave on Matt's PC (the AWS sign-in, the AWS wizard, Codex itself).
    That is listed as UNVERIFIED in the hand-over notes.
  * The independent cross-checks (tests/py) need Python 3.11 or newer. Without Python they are skipped, with a visible note.
    Set W3_REQUIRE_PYTHON=1 to turn a missing Python into a failure (the GitHub job does).
#>
[CmdletBinding()]
param([string[]]$Only = @())

$testDir = $PSScriptRoot
$hostExe = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
$env:DOTNET_SYSTEM_GLOBALIZATION_INVARIANT = '1'

$files = @(Get-ChildItem -LiteralPath $testDir -Filter '*.ps1' | Where-Object { $_.Name -match '^\d\d-' } | Sort-Object Name)
if ($Only.Count -gt 0) {
    # (with "-File" a list such as 01,02,05 arrives as ONE string, so it is split here)
    $wanted = @($Only | ForEach-Object { ([string]$_) -split '[,;\s]+' } | Where-Object { $_.Length -gt 0 } | ForEach-Object { $_.PadLeft(2, '0') })
    $files = @($files | Where-Object { $wanted -contains $_.Name.Substring(0, 2) })
}
if ($files.Count -eq 0) {
    Write-Host 'No test files matched.'
    exit 1
}

Write-Host ('Running {0} test file(s) with {1} (PowerShell {2})' -f $files.Count, $hostExe, $PSVersionTable.PSVersion)
$failed = 0
$totalChecks = 0
$totalSkipped = 0
$rows = New-Object 'System.Collections.Generic.List[string]'
$swAll = [System.Diagnostics.Stopwatch]::StartNew()
foreach ($f in $files) {
    Write-Host ''
    Write-Host ('##### ' + $f.Name)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $childOut = $null
    & $hostExe -NoProfile -ExecutionPolicy Bypass -File $f.FullName | Tee-Object -Variable childOut | Out-Host
    $code = $LASTEXITCODE
    $sw.Stop()
    $text = (@($childOut) | ForEach-Object { [string]$_ }) -join "`n"
    $checks = '?'
    $m = [regex]::Match($text, 'all (\d+) checks passed(?:, (\d+) skipped here)?')
    if ($m.Success) {
        $checks = $m.Groups[1].Value
        $totalChecks += [int]$checks
        if ($m.Groups[2].Success) { $checks = $checks + ' (+' + $m.Groups[2].Value + ' skipped)'; $totalSkipped += [int]$m.Groups[2].Value }
    }
    else {
        $m2 = [regex]::Match($text, '(\d+) of (\d+) checks FAILED')
        if ($m2.Success) { $checks = ($m2.Groups[2].Value + ' (' + $m2.Groups[1].Value + ' failed)') }
    }
    $verdict = 'PASS'
    if ($code -ne 0) { $verdict = 'FAIL'; $failed++ }
    $rows.Add(('{0}  {1,-34} checks: {2,-22} {3,5:N1} s' -f $verdict, $f.Name, $checks, $sw.Elapsed.TotalSeconds))
}
$swAll.Stop()

Write-Host ''
Write-Host '=============================== SUMMARY ==============================='
foreach ($r in $rows) { Write-Host $r }
Write-Host ('{0} test file(s), {1} passed, {2} failed, {3} checks passed in total, {4} checks skipped on this machine, {5:N0} s' -f $files.Count, ($files.Count - $failed), $failed, $totalChecks, $totalSkipped, $swAll.Elapsed.TotalSeconds)
Write-Host ('These ran in PowerShell {0} on {1}.' -f $PSVersionTable.PSVersion, [Environment]::OSVersion.VersionString)
exit $failed
