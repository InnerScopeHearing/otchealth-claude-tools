# Shared helpers for the test files (each test file dot-sources this one).
# The tests run in PowerShell 7 (pwsh, on Linux) and in Windows PowerShell 5.1 (the GitHub Windows job
# .github/workflows/pc-toolkit-ps51.yml). Everything here must therefore stay valid in 5.1 (test 02 checks the test files too).
# Strict mode is on in the tests (not in the shipped script) so that typos and unset variables show up.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:TestFailures = New-Object 'System.Collections.Generic.List[string]'
$script:TestCount = 0
$script:TestSkipped = 0
$script:ToolkitDir = Split-Path -Parent $PSScriptRoot
$script:ScriptUnderTest = Join-Path $script:ToolkitDir 'setup-aws-agent-toolkit.ps1'
$script:PyDir = Join-Path $PSScriptRoot 'py'
$script:FixtureDir = Join-Path $PSScriptRoot 'fixtures'
$script:FixtureRules = Join-Path $script:FixtureDir 'aws-agent-rules.pinned.md'

function Skip-Test {
    # Ends a test case early because this kind of machine cannot run it (for example a Windows only check on Linux).
    # It is shown as "skip" with the reason and counted separately, so a skipped check is never mistaken for a passed one.
    param([string]$Reason)
    throw ('W3-SKIP:' + $Reason)
}

function Test-Case {
    param([string]$Name, [scriptblock]$Body)
    $script:TestCount++
    try {
        & $Body
        Write-Host ('  ok    ' + $Name)
    }
    catch {
        $msg = [string]$_.Exception.Message
        if ($msg.StartsWith('W3-SKIP:', [StringComparison]::Ordinal)) {
            $script:TestSkipped++
            Write-Host ('  skip  ' + $Name + ' (' + $msg.Substring(8) + ')') -ForegroundColor Yellow
        }
        else {
            $script:TestFailures.Add($Name + ' :: ' + $msg)
            Write-Host ('  FAIL  ' + $Name + ' :: ' + $msg) -ForegroundColor Red
        }
    }
}

function Show-Visible {
    param([string]$Text)
    if ($null -eq $Text) { return '<null>' }
    return ($Text -replace "`r", '\r' -replace "`n", '\n')
}

function Assert-True {
    param($Condition, [string]$Message = 'condition is false')
    if (-not $Condition) { throw $Message }
}

function Assert-Eq {
    # Case-sensitive comparison with a readable message (CR and LF are made visible).
    param($Actual, $Expected, [string]$Message = '')
    $a = [string]$Actual
    $e = [string]$Expected
    if (-not ($a -ceq $e)) {
        throw ('expected [{0}] but got [{1}] {2}' -f (Show-Visible $e), (Show-Visible $a), $Message)
    }
}

function Assert-Contains {
    param([string]$Text, [string]$Part, [string]$Message = '')
    if ($Text.IndexOf($Part, [StringComparison]::Ordinal) -lt 0) {
        throw ('expected the text to contain [{0}] {1}; text was [{2}]' -f (Show-Visible $Part), $Message, (Show-Visible $Text))
    }
}

function Assert-NotContains {
    param([string]$Text, [string]$Part, [string]$Message = '')
    if ($Text.IndexOf($Part, [StringComparison]::Ordinal) -ge 0) {
        throw ('expected the text NOT to contain [{0}] {1}' -f (Show-Visible $Part), $Message)
    }
}

function New-TempDir {
    $base = [System.IO.Path]::GetTempPath()
    $p = Join-Path $base ('w3test-' + [guid]::NewGuid().ToString('N'))
    [void](New-Item -ItemType Directory -Path $p -Force)
    return $p
}

function Save-Text {
    # Writes a test file as UTF-8 without BOM (optionally with one), byte for byte as given.
    param([string]$Path, [string]$Text, [switch]$Bom)
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { [void](New-Item -ItemType Directory -Path $dir -Force) }
    $enc = New-Object System.Text.UTF8Encoding($false)
    $bytes = $enc.GetBytes($Text)
    if ($Bom) { $bytes = [byte[]](@(239, 187, 191) + $bytes) }
    [System.IO.File]::WriteAllBytes($Path, $bytes)
}

function Get-FileBytes { param([string]$Path) return , [System.IO.File]::ReadAllBytes($Path) }

function Get-FileText {
    param([string]$Path)
    $b = [System.IO.File]::ReadAllBytes($Path)
    $start = 0
    if ($b.Length -ge 3 -and $b[0] -eq 239 -and $b[1] -eq 187 -and $b[2] -eq 191) { $start = 3 }
    return [System.Text.Encoding]::UTF8.GetString($b, $start, $b.Length - $start)
}

function ConvertTo-Crlf { param([string]$Text) return ($Text -replace "`r`n", "`n" -replace "`n", "`r`n") }

function Test-PythonUsable {
    # $true when this program really is Python 3.11 or newer. (On a Windows PC "python3" can be a Microsoft Store stub that
    # only prints a hint, so being found on the PATH is not enough.)
    param([string]$Exe)
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $Exe
        $psi.Arguments = '-I -c "import sys, tomllib; sys.exit(0 if sys.version_info >= (3, 11) else 3)"'
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.RedirectStandardInput = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $p = [System.Diagnostics.Process]::Start($psi)
        $outTask = $p.StandardOutput.ReadToEndAsync()
        $errTask = $p.StandardError.ReadToEndAsync()
        $p.StandardInput.Close()
        if (-not $p.WaitForExit(30000)) { try { $p.Kill() } catch { } ; return $false }
        [void]$p.WaitForExit(5000)
        $code = $p.ExitCode
        $p.Dispose()
        return ($code -eq 0)
    }
    catch { return $false }
}

function Find-PythonExe {
    # python3, python or the Windows launcher "py" (the cross-checks in tests/py need Python 3.11 or newer for tomllib).
    foreach ($n in @('python3', 'python', 'py')) {
        foreach ($c in @(Get-Command $n -All -CommandType Application -ErrorAction SilentlyContinue)) {
            if (Test-PythonUsable $c.Source) { return $c.Source }
        }
    }
    return $null
}

$script:PythonExe = Find-PythonExe
$script:PythonSkipped = 0

function Invoke-Py {
    # Runs a checker from tests/py with Python in isolated mode (-I). Returns Output and ExitCode (99 = no Python found).
    param([string]$Script, [string[]]$Arguments)
    if (-not $script:PythonExe) { return [pscustomobject]@{ Output = 'python not available'; ExitCode = 99 } }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $script:PythonExe
    $parts = New-Object 'System.Collections.Generic.List[string]'
    foreach ($a in (@('-I', '-X', 'utf8', (Join-Path $script:PyDir $Script)) + @($Arguments))) {
        if ($a -match '[\s"]' -or $a.Length -eq 0) { $parts.Add('"' + ($a -replace '"', '\"') + '"') } else { $parts.Add($a) }
    }
    $psi.Arguments = ($parts.ToArray() -join ' ')
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.RedirectStandardInput = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    $outTask = $p.StandardOutput.ReadToEndAsync()
    $errTask = $p.StandardError.ReadToEndAsync()
    $p.StandardInput.Close()
    if (-not $p.WaitForExit(120000)) { try { $p.Kill() } catch { } }
    [void]$p.WaitForExit(5000)
    $text = ($outTask.Result + $errTask.Result).Trim()
    $code = $p.ExitCode
    $p.Dispose()
    return [pscustomobject]@{ Output = $text; ExitCode = $code }
}

function Skip-PythonCrossCheck {
    # Called when no Python is installed: the independent check is skipped, visibly, and counted in the final line.
    # Set W3_REQUIRE_PYTHON=1 to make a missing Python a failure instead.
    if ($env:W3_REQUIRE_PYTHON -eq '1') { throw 'Python 3 is required for the independent cross-checks (W3_REQUIRE_PYTHON=1) but was not found' }
    if ($script:PythonSkipped -eq 0) { Write-Host '        (no Python found: the independent Python cross-checks are skipped in this run)' -ForegroundColor Yellow }
    $script:PythonSkipped++
}

function Assert-TomlPatchedOk {
    # Independent check with Python's tomllib: both files parse, the env is there, and nothing else changed.
    param([string]$OriginalText, [string]$NewText)
    $dir = New-TempDir
    try {
        Save-Text (Join-Path $dir 'orig.toml') $OriginalText
        Save-Text (Join-Path $dir 'new.toml') $NewText
        $r = Invoke-Py 'check_toml.py' @((Join-Path $dir 'orig.toml'), (Join-Path $dir 'new.toml'))
        if ($r.ExitCode -eq 99) { Skip-PythonCrossCheck; return }
        if ($r.ExitCode -ne 0) { throw ('python tomllib check failed: ' + $r.Output) }
    }
    finally { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }
}

function Assert-TomlEntryAddedOk {
    # Independent check with Python's tomllib for the case where the whole aws-mcp entry was added:
    # the entry equals the standard AWS one (with the otchealth profile) and nothing else in the data changed.
    param([string]$OriginalText, [string]$NewText)
    $dir = New-TempDir
    try {
        Save-Text (Join-Path $dir 'orig.toml') $OriginalText
        Save-Text (Join-Path $dir 'new.toml') $NewText
        $r = Invoke-Py 'check_toml_entry.py' @((Join-Path $dir 'orig.toml'), (Join-Path $dir 'new.toml'))
        if ($r.ExitCode -eq 99) { Skip-PythonCrossCheck; return }
        if ($r.ExitCode -ne 0) { throw ('python tomllib check failed: ' + $r.Output) }
    }
    finally { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }
}

function Assert-JsonPatchedOk {
    param([string]$OriginalText, [string]$NewText, [string]$Parent = 'mcpServers', [string]$EnvKey = 'env')
    $dir = New-TempDir
    try {
        Save-Text (Join-Path $dir 'orig.json') $OriginalText
        Save-Text (Join-Path $dir 'new.json') $NewText
        $r = Invoke-Py 'check_json.py' @((Join-Path $dir 'orig.json'), (Join-Path $dir 'new.json'), $Parent, 'aws-mcp', $EnvKey)
        if ($r.ExitCode -eq 99) { Skip-PythonCrossCheck; return }
        if ($r.ExitCode -ne 0) { throw ('python json check failed: ' + $r.Output) }
    }
    finally { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }
}

function Load-ScriptUnderTest {
    # Not usable as a function (dot-sourcing inside a function would hide the definitions);
    # every test file does this itself:  . $script:ScriptUnderTest -TestMode
    throw 'dot-source the script directly in the test file'
}

function New-TestContext {
    # A context over a temporary "home" folder; returns the context (also stored in $script:Ctx).
    param([string]$HomeDir)
    $script:Quiet = $true
    $script:NoPauseMode = $true
    $script:Ctx = New-SetupContext -UserHome $HomeDir -ScriptDir $HomeDir -IsTest
    return $script:Ctx
}

function Complete-Tests {
    param([string]$Title)
    Write-Host ''
    if ($script:TestFailures.Count -gt 0) {
        Write-Host ('{0}: {1} of {2} checks FAILED' -f $Title, $script:TestFailures.Count, $script:TestCount) -ForegroundColor Red
        foreach ($f in $script:TestFailures) { Write-Host ('  - ' + $f) -ForegroundColor Red }
        exit 1
    }
    $passed = $script:TestCount - $script:TestSkipped
    if ($script:TestSkipped -gt 0) { Write-Host ('{0}: all {1} checks passed, {2} skipped here' -f $Title, $passed, $script:TestSkipped) -ForegroundColor Green }
    else { Write-Host ('{0}: all {1} checks passed' -f $Title, $passed) -ForegroundColor Green }
    if ($script:PythonSkipped -gt 0) { Write-Host ('  note: {0} independent Python cross-checks were skipped (no Python found)' -f $script:PythonSkipped) -ForegroundColor Yellow }
    exit 0
}
