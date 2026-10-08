# 08 - the script is run as a real FILE in a child PowerShell process (the way "Run with PowerShell" runs it),
# not loaded into the test. This checks the top of the file (parameters), the bottom of the file (the start,
# the exit code, the safety net) and what the window does: it waits for Enter at the start and at the end.
# The child is the same kind of PowerShell as the one that runs this test (pwsh on Linux, Windows PowerShell 5.1 on Windows).
# The real setup must never run on a test machine, so the child is told that the operating system is not Windows
# (OS=NotWindows in its environment): the real Step 1 then stops the run at once with its plain message
# "This script is for Windows only." That is the real code path, nothing in the script is edited for that.
. (Join-Path $PSScriptRoot 'TestHelpers.ps1')

$hostExe = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
$isWin = ($env:OS -eq 'Windows_NT')

function ConvertTo-CmdArgForTest { param([string]$A) if ($A.Length -eq 0 -or $A -match '[\s"]') { return '"' + ($A -replace '"', '\"') + '"' } return $A }

function Invoke-ChildHost {
    # Runs "<this PowerShell> -NoProfile -ExecutionPolicy Bypass -File <script> <args>" with the given text on its input.
    # Returns ExitCode, Output (output and error output together) and TimedOut.
    param([string]$ScriptPath, [string[]]$ScriptArgs = @(), [string]$InputText = '', [string]$HomeDir, [int]$TimeoutSec = 180)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $hostExe
    $argList = New-Object 'System.Collections.Generic.List[string]'
    foreach ($a in @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath)) { $argList.Add((ConvertTo-CmdArgForTest $a)) }
    foreach ($a in $ScriptArgs) { $argList.Add((ConvertTo-CmdArgForTest $a)) }
    $psi.Arguments = ($argList.ToArray() -join ' ')
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.EnvironmentVariables['HOME'] = $HomeDir
    $psi.EnvironmentVariables['DOTNET_SYSTEM_GLOBALIZATION_INVARIANT'] = '1'
    if ($isWin) { $psi.EnvironmentVariables['USERPROFILE'] = $HomeDir }
    else { [void]$psi.EnvironmentVariables.Remove('USERPROFILE') }
    $psi.EnvironmentVariables['OS'] = 'NotWindows'
    $p = [System.Diagnostics.Process]::Start($psi)
    $outTask = $p.StandardOutput.ReadToEndAsync()
    $errTask = $p.StandardError.ReadToEndAsync()
    if ($InputText.Length -gt 0) { $p.StandardInput.Write($InputText) }
    $p.StandardInput.Close()
    $timedOut = $false
    if (-not $p.WaitForExit($TimeoutSec * 1000)) { $timedOut = $true; try { $p.Kill() } catch { } }
    [void]$p.WaitForExit(5000)
    $out = $outTask.Result + $errTask.Result
    $code = $null
    if (-not $timedOut) { $code = $p.ExitCode }
    $p.Dispose()
    return [pscustomobject]@{ ExitCode = $code; Output = $out; TimedOut = $timedOut }
}

function Get-HomeEntriesOtherThanHost {
    # (PowerShell itself may create .cache, .local or AppData in a fresh home folder; anything else would come from our script.)
    param([string]$Dir)
    return @(Get-ChildItem -LiteralPath $Dir -Force | Where-Object { $_.Name -ne '.cache' -and $_.Name -ne '.local' -and $_.Name -ne 'AppData' } | ForEach-Object { $_.Name })
}

function New-ScriptCopy {
    # A private copy of the script in its own folder (so the log file is written there, not next to the real script).
    param([string]$Dir, [scriptblock]$Edit = $null)
    [void](New-Item -ItemType Directory -Path $Dir -Force)
    $text = [System.IO.File]::ReadAllText($script:ScriptUnderTest)
    if ($Edit) { $text = & $Edit $text }
    $dest = Join-Path $Dir 'setup-aws-agent-toolkit.ps1'
    [System.IO.File]::WriteAllText($dest, $text, (New-Object System.Text.UTF8Encoding($false)))
    return $dest
}

function Get-NonEmptyLinesAfter {
    # The non-empty lines of a text after the LAST occurrence of a marker line, up to the line that contains $Until.
    param([string]$Text, [string]$Marker, [string]$Until)
    $all = @($Text -split "\r?\n")
    $start = -1
    for ($i = 0; $i -lt $all.Count; $i++) { if ($all[$i].Contains($Marker)) { $start = $i } }
    if ($start -lt 0) { return @() }
    $lines = New-Object 'System.Collections.Generic.List[string]'
    for ($i = $start + 1; $i -lt $all.Count; $i++) {
        if ($all[$i].Contains($Until)) { break }
        if ($all[$i].Trim().Length -gt 0) { $lines.Add($all[$i]) }
    }
    return $lines.ToArray()
}

$tmp = New-TempDir
try {
    Test-Case 'loading the file with -TestMode prints nothing, writes nothing and exits with 0' {
        $dir = Join-Path $tmp 'testmode'
        $script = New-ScriptCopy $dir
        $homeDir = Join-Path $tmp 'home1'
        [void](New-Item -ItemType Directory -Path $homeDir)
        $r = Invoke-ChildHost -ScriptPath $script -ScriptArgs @('-TestMode') -HomeDir $homeDir
        Assert-True (-not $r.TimedOut) 'timed out'
        Assert-Eq $r.ExitCode 0 $r.Output
        Assert-Eq $r.Output.Trim() '' 'no output expected'
        Assert-Eq @(Get-ChildItem -LiteralPath $dir).Count 1 'no log file in -TestMode'
        Assert-Eq @(Get-HomeEntriesOtherThanHost $homeDir).Count 0 'nothing may be written to the home folder'
    }

    Test-Case 'unattended run (-NoPause) on a machine that is not Windows: stops in Step 1 with a plain message, exit code 1, log file next to the script, short closing screen' {
        $dir = Join-Path $tmp 'nopause'
        $script = New-ScriptCopy $dir
        $homeDir = Join-Path $tmp 'home2'
        [void](New-Item -ItemType Directory -Path $homeDir)
        $r = Invoke-ChildHost -ScriptPath $script -ScriptArgs @('-NoPause') -HomeDir $homeDir
        Assert-True (-not $r.TimedOut) 'it must not wait for Enter with -NoPause'
        Assert-Eq $r.ExitCode 1 $r.Output
        Assert-Contains $r.Output 'AWS Agent Toolkit setup for OTCHealth'
        Assert-Contains $r.Output 'This script is for Windows only.'
        Assert-Contains $r.Output 'SETUP DID NOT FINISH'
        Assert-NotContains $r.Output 'Press Enter'
        $logs = @(Get-ChildItem -LiteralPath $dir -Filter 'aws-toolkit-setup-log-*.txt')
        Assert-Eq $logs.Count 1 'one log file next to the script'
        $log = [System.IO.File]::ReadAllText($logs[0].FullName)
        Assert-Contains $log 'This script is for Windows only.'
        Assert-Contains $log 'SETUP DID NOT FINISH'
        # the details block is added to the END of the log file (after the transcript ended), not shown on the screen
        Assert-Contains $log 'DETAILS FOR THE CTO (no secrets)'
        Assert-Contains $log 'Results of every step:'
        Assert-NotContains $r.Output 'DETAILS FOR THE CTO'
        Assert-True ($log.IndexOf('DETAILS FOR THE CTO', [StringComparison]::Ordinal) -gt $log.LastIndexOf('SETUP DID NOT FINISH', [StringComparison]::Ordinal)) 'the details come after the closing screen in the log'
        # the closing screen: a short plain summary and the name of the log file, and nothing else after the banner
        $after = @(Get-NonEmptyLinesAfter $r.Output 'SETUP DID NOT FINISH' 'THE-END-OF-THE-TEXT')
        $after = @($after | Where-Object { -not $_.StartsWith('====') })
        Assert-True ($after.Count -le 6) ('too many lines after the banner: ' + $after.Count + ' ' + ($after -join ' | '))
        Assert-Contains $after[$after.Count - 1] 'Log file'
        Assert-Contains $after[$after.Count - 1] $logs[0].Name
        Assert-Eq @(Get-HomeEntriesOtherThanHost $homeDir).Count 0 'nothing may be written to the home folder'
    }

    Test-Case 'attended run: the window asks for Enter at the start and again at the end (the "Press Enter to close" pause)' {
        $dir = Join-Path $tmp 'attended'
        $script = New-ScriptCopy $dir
        $homeDir = Join-Path $tmp 'home3'
        [void](New-Item -ItemType Directory -Path $homeDir)
        $r = Invoke-ChildHost -ScriptPath $script -InputText "`n`n`n" -HomeDir $homeDir
        Assert-True (-not $r.TimedOut) 'it waited forever although Enter was provided'
        Assert-Eq $r.ExitCode 1 $r.Output
        Assert-Contains $r.Output 'Press Enter to start'
        Assert-Contains $r.Output 'Press Enter to close'
        $iStart = $r.Output.IndexOf('Press Enter to start', [StringComparison]::Ordinal)
        $iEnd = $r.Output.IndexOf('Press Enter to close', [StringComparison]::Ordinal)
        $iSummary = $r.Output.IndexOf('SETUP DID NOT FINISH', [StringComparison]::Ordinal)
        Assert-True ($iStart -ge 0 -and $iSummary -gt $iStart -and $iEnd -gt $iSummary) 'order: start prompt, summary, close prompt'
        # what is last on the screen before the final prompt: the banner, a few plain lines, the log file name
        $after = @(Get-NonEmptyLinesAfter $r.Output 'SETUP DID NOT FINISH' 'Press Enter to close')
        $after = @($after | Where-Object { -not $_.StartsWith('====') })
        Assert-True ($after.Count -le 6) ('too many lines between the banner and the final prompt: ' + $after.Count)
    }

    Test-Case 'an attended run waits at the end: the summary is printed BEFORE the final prompt, so a person can read it' {
        $dir = Join-Path $tmp 'waits'
        $script = New-ScriptCopy $dir
        $homeDir = Join-Path $tmp 'home4'
        [void](New-Item -ItemType Directory -Path $homeDir)
        # only ONE Enter (for the start prompt) and then the input is closed: Read-Host at the end gets end-of-input.
        $r = Invoke-ChildHost -ScriptPath $script -InputText "`n" -HomeDir $homeDir -TimeoutSec 90
        Assert-Contains $r.Output 'SETUP DID NOT FINISH'
        Assert-Contains $r.Output 'Press Enter to close'
    }

    Test-Case 'safety net: an unexpected error before the main flow is shown in plain words, the window still pauses, and the exit code is 1' {
        $dir = Join-Path $tmp 'net'
        $script = New-ScriptCopy $dir -Edit {
            param($t)
            # inject a failure into the context builder (the very first thing Invoke-Main does)
            $marker = 'if (-not $TestMode) {'
            $i = $t.LastIndexOf($marker, [StringComparison]::Ordinal)
            return $t.Substring(0, $i) + "function New-SetupContext { throw 'simulated failure while preparing'}`n" + $t.Substring($i)
        }
        $homeDir = Join-Path $tmp 'home5'
        [void](New-Item -ItemType Directory -Path $homeDir)
        $r = Invoke-ChildHost -ScriptPath $script -ScriptArgs @('-NoPause') -HomeDir $homeDir
        Assert-True (-not $r.TimedOut)
        Assert-Eq $r.ExitCode 1 $r.Output
        Assert-Contains $r.Output 'The setup script hit an unexpected problem and stopped: simulated failure while preparing'
        Assert-Contains $r.Output 'Please send a screenshot of this window to the CTO.'
        Assert-NotContains $r.Output 'Press Enter'
        $r2 = Invoke-ChildHost -ScriptPath $script -InputText "`n`n" -HomeDir $homeDir
        Assert-True (-not $r2.TimedOut)
        Assert-Eq $r2.ExitCode 1 $r2.Output
        Assert-Contains $r2.Output 'Press Enter to close'
    }

    Test-Case 'the script file is run by the expected PowerShell (Windows PowerShell 5.1 on a Windows machine)' {
        # Not a test of the setup itself (nothing is installed or changed): it shows which PowerShell ran the file.
        $dir = Join-Path $tmp 'version'
        $script = New-ScriptCopy $dir -Edit {
            param($t)
            $marker = 'if (-not $TestMode) {'
            $i = $t.LastIndexOf($marker, [StringComparison]::Ordinal)
            return $t.Substring(0, $i) + "function New-SetupContext { throw ('PSVersion=' + `$PSVersionTable.PSVersion.Major + '.' + `$PSVersionTable.PSVersion.Minor + ' Edition=' + `$PSVersionTable.PSEdition) }`n" + $t.Substring($i)
        }
        $homeDir = Join-Path $tmp 'home6'
        [void](New-Item -ItemType Directory -Path $homeDir)
        $r = Invoke-ChildHost -ScriptPath $script -ScriptArgs @('-NoPause') -HomeDir $homeDir
        Assert-Eq $r.ExitCode 1 $r.Output
        if ($isWin -and $PSVersionTable.PSVersion.Major -eq 5) { Assert-Contains $r.Output 'PSVersion=5.1 Edition=Desktop' }
        else { Assert-Contains $r.Output 'PSVersion=' }
    }
}
finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Complete-Tests '08-run-as-file'
