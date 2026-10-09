# 08 - the script is run as a real FILE in a child PowerShell process (the way "Run with PowerShell" runs it),
# not loaded into the test. This checks the top of the file (parameters), the bottom of the file (the start,
# the exit code, the safety net) and what the window does: it waits for Enter at the start and at the end.
# The child is the same kind of PowerShell as the one that runs this test (pwsh on Linux, Windows PowerShell 5.1 on Windows).
# The real setup must never run on a test machine, so the child is told that the operating system is not Windows
# (OS=NotWindows in its environment): the real Step 1 then stops the run at once with its plain message
# "This script is for Windows only." That is the real code path, nothing in the script is edited for that.
#
# How the waiting is checked: the "live" tests keep the child's input open, read what it prints while it runs, and look at the
# process itself (still running = still waiting for Enter). That does not depend on the text of the prompt, which matters because
# Windows PowerShell 5.1 writes the text of "Read-Host -Prompt" to the console window only: when the output is redirected, as it
# is here, that text never arrives (seen on a real windows-latest machine). The wording of the two prompts is compared here only
# where the host does pass it on. It is also checked by test 02 (the script text) and test 06 (the questions asked in the pretend PC).
. (Join-Path $PSScriptRoot 'TestHelpers.ps1')

$hostExe = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
$isWin = ($env:OS -eq 'Windows_NT')
$promptTextIsCaptured = -not ($isWin -and $PSVersionTable.PSVersion.Major -eq 5)

function ConvertTo-CmdArgForTest { param([string]$A) if ($A.Length -eq 0 -or $A -match '[\s"]') { return '"' + ($A -replace '"', '\"') + '"' } return $A }

function New-ChildStartInfo {
    # "<this PowerShell> -NoProfile -ExecutionPolicy Bypass -File <script> <args>", all three streams redirected, in a private home folder.
    param([string]$ScriptPath, [string[]]$ScriptArgs = @(), [string]$HomeDir)
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
    return $psi
}

function Invoke-ChildHost {
    # Runs "<this PowerShell> -NoProfile -ExecutionPolicy Bypass -File <script> <args>" with the given text on its input.
    # Returns ExitCode, Output (output and error output together) and TimedOut.
    param([string]$ScriptPath, [string[]]$ScriptArgs = @(), [string]$InputText = '', [string]$HomeDir, [int]$TimeoutSec = 180)
    $psi = New-ChildStartInfo -ScriptPath $ScriptPath -ScriptArgs $ScriptArgs -HomeDir $HomeDir
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

# --- a child that is watched while it runs ("live"): its input stays open, so a test can see that the window WAITS for Enter ---

function Start-LiveChild {
    # Starts the child and returns at once. What it has printed so far is collected in .Text (see Update-LiveChild).
    param([string]$ScriptPath, [string[]]$ScriptArgs = @(), [string]$HomeDir)
    $psi = New-ChildStartInfo -ScriptPath $ScriptPath -ScriptArgs $ScriptArgs -HomeDir $HomeDir
    $p = [System.Diagnostics.Process]::Start($psi)
    $outBuf = New-Object 'char[]' 4096
    $errBuf = New-Object 'char[]' 4096
    $c = [pscustomobject]@{ Process = $p; Text = (New-Object System.Text.StringBuilder); OutBuf = $outBuf; ErrBuf = $errBuf; OutTask = $null; ErrTask = $null }
    $c.OutTask = $p.StandardOutput.ReadAsync($outBuf, 0, $outBuf.Length)
    $c.ErrTask = $p.StandardError.ReadAsync($errBuf, 0, $errBuf.Length)
    return $c
}

function Update-LiveChild {
    # Moves whatever the child has printed so far into .Text. Nothing waits here.
    param($C)
    foreach ($which in @('Out', 'Err')) {
        $reader = $C.Process.StandardOutput
        $buf = $C.OutBuf
        $task = $C.OutTask
        if ($which -eq 'Err') { $reader = $C.Process.StandardError; $buf = $C.ErrBuf; $task = $C.ErrTask }
        while ($null -ne $task -and $task.IsCompleted) {
            $n = 0
            try { $n = [int]$task.Result } catch { $n = 0 }
            if ($n -le 0) { $task = $null; break }
            [void]$C.Text.Append($buf, 0, $n)
            $task = $reader.ReadAsync($buf, 0, $buf.Length)
        }
        if ($which -eq 'Err') { $C.ErrTask = $task } else { $C.OutTask = $task }
    }
}

function Wait-LiveText {
    # Waits until the child's text contains $Text. Returns $true when it does, $false after the timeout (or when the child ended without it).
    param($C, [string]$Text, [int]$TimeoutSec = 120)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSec)
    while ($true) {
        Update-LiveChild $C
        if ($C.Text.ToString().IndexOf($Text, [StringComparison]::Ordinal) -ge 0) { return $true }
        if ([DateTime]::UtcNow -gt $deadline) { return $false }
        if ($C.Process.HasExited -and $null -eq $C.OutTask -and $null -eq $C.ErrTask) { return $false }
        Start-Sleep -Milliseconds 100
    }
}

function Send-LiveLine {
    # Types one line (Enter, when the line is empty) into the child.
    param($C, [string]$Line = '')
    $C.Process.StandardInput.WriteLine($Line)
    $C.Process.StandardInput.Flush()
}

function Wait-LiveExit {
    # Waits until the child has ended and everything it printed has been read. Returns $true when it ended in time.
    param($C, [int]$TimeoutSec = 90)
    $ended = $C.Process.WaitForExit($TimeoutSec * 1000)
    $until = [DateTime]::UtcNow.AddSeconds(10)
    while ([DateTime]::UtcNow -lt $until) {
        Update-LiveChild $C
        if ($null -eq $C.OutTask -and $null -eq $C.ErrTask) { break }
        Start-Sleep -Milliseconds 50
    }
    return $ended
}

function Stop-LiveChild {
    param($C)
    if ($null -eq $C) { return }
    try { if (-not $C.Process.HasExited) { $C.Process.Kill() } } catch { }
    try { [void]$C.Process.WaitForExit(5000) } catch { }
    try { $C.Process.Dispose() } catch { }
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

    Test-Case 'attended run: the window waits for Enter at the start, prints the summary, waits for Enter again, and only then closes (exit code 1)' {
        $dir = Join-Path $tmp 'attended'
        $script = New-ScriptCopy $dir
        $homeDir = Join-Path $tmp 'home3'
        [void](New-Item -ItemType Directory -Path $homeDir)
        $c = $null
        try {
            $c = Start-LiveChild -ScriptPath $script -HomeDir $homeDir
            # 1. the opening screen is printed and then the window waits: nothing starts by itself
            Assert-True (Wait-LiveText $c 'Please close Codex now') ('the opening screen did not appear: ' + $c.Text.ToString())
            Start-Sleep -Seconds 4
            Update-LiveChild $c
            Assert-True (-not $c.Process.HasExited) ('the window closed without waiting for Enter at the start: ' + $c.Text.ToString())
            Assert-NotContains $c.Text.ToString() 'This script is for Windows only.' 'Step 1 must not start before Enter is pressed'
            # 2. Enter: the run goes on (Step 1 stops it on this test machine), the summary is printed, and the window waits again
            Send-LiveLine $c
            Assert-True (Wait-LiveText $c 'SETUP DID NOT FINISH') ('the summary did not appear: ' + $c.Text.ToString())
            Start-Sleep -Seconds 4
            Update-LiveChild $c
            Assert-True (-not $c.Process.HasExited) ('the window closed by itself at the end; it must wait for Enter so that the summary can be read: ' + $c.Text.ToString())
            $text = $c.Text.ToString()
            # what is last on the screen while it waits: the banner, a few plain lines, the log file name
            $after = @(Get-NonEmptyLinesAfter $text 'SETUP DID NOT FINISH' 'Press Enter to close')
            $after = @($after | Where-Object { -not $_.StartsWith('====') })
            Assert-True ($after.Count -ge 1 -and $after.Count -le 6) ('lines between the banner and the final wait: ' + $after.Count + ' ' + ($after -join ' | '))
            Assert-Contains $after[$after.Count - 1] 'Log file'
            if ($promptTextIsCaptured) {
                $iStart = $text.IndexOf('Press Enter to start', [StringComparison]::Ordinal)
                $iSummary = $text.IndexOf('SETUP DID NOT FINISH', [StringComparison]::Ordinal)
                $iEnd = $text.IndexOf('Press Enter to close', [StringComparison]::Ordinal)
                Assert-True ($iStart -ge 0 -and $iSummary -gt $iStart -and $iEnd -gt $iSummary) 'order: start prompt, summary, close prompt'
            }
            # 3. Enter: the window closes, and the exit code says that the run did not finish
            Send-LiveLine $c
            Assert-True (Wait-LiveExit $c) ('the window did not close after the last Enter: ' + $c.Text.ToString())
            Assert-Eq $c.Process.ExitCode 1 $c.Text.ToString()
        }
        finally { Stop-LiveChild $c }
    }

    Test-Case 'attended run whose input ends early: the summary is still printed, and the window does not crash before it' {
        $dir = Join-Path $tmp 'waits'
        $script = New-ScriptCopy $dir
        $homeDir = Join-Path $tmp 'home4'
        [void](New-Item -ItemType Directory -Path $homeDir)
        # only ONE Enter (for the start prompt) and then the input is closed: the final Read-Host gets end-of-input.
        $r = Invoke-ChildHost -ScriptPath $script -InputText "`n" -HomeDir $homeDir -TimeoutSec 90
        Assert-Contains $r.Output 'SETUP DID NOT FINISH'
        Assert-Contains $r.Output 'Log file (send it to the CTO if something went wrong)'
        if ($promptTextIsCaptured) { Assert-Contains $r.Output 'Press Enter to close' }
    }

    Test-Case 'safety net: an unexpected error before the main flow is shown in plain words, the window still waits for Enter, and the exit code is 1' {
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
        # attended: the message is shown and then the window waits for Enter (so that it can be read and photographed)
        $c = $null
        try {
            $c = Start-LiveChild -ScriptPath $script -HomeDir $homeDir
            Assert-True (Wait-LiveText $c 'Please send a screenshot of this window to the CTO.') ('the message did not appear: ' + $c.Text.ToString())
            Start-Sleep -Seconds 4
            Update-LiveChild $c
            Assert-True (-not $c.Process.HasExited) ('the window closed by itself after the error message; it must wait for Enter: ' + $c.Text.ToString())
            Assert-Contains $c.Text.ToString() 'simulated failure while preparing'
            if ($promptTextIsCaptured) { Assert-Contains $c.Text.ToString() 'Press Enter to close' }
            Send-LiveLine $c
            Assert-True (Wait-LiveExit $c) ('the window did not close after Enter: ' + $c.Text.ToString())
            Assert-Eq $c.Process.ExitCode 1 $c.Text.ToString()
        }
        finally { Stop-LiveChild $c }
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
