# 07 - the low-level helpers, run for real (no fakes): starting programs with captured output and a time limit, Windows
# command-line quoting, strict UTF-8 file reading, hashes, backups, line endings, the PATH cleaner, the log appender,
# the real web download, the real self-check programs. It runs on the Linux test machine AND on Windows PowerShell 5.1
# (the GitHub Windows job): the "other programs" it starts come from ChildKit.ps1 (/bin/sh on Linux, a tiny compiled
# program on Windows), and the checks that only make sense on one kind of machine say so on screen when they are skipped.
. (Join-Path $PSScriptRoot 'TestHelpers.ps1')
. (Join-Path $PSScriptRoot 'ChildKit.ps1')
. $script:ScriptUnderTest -TestMode
$script:Quiet = $true
$script:NoPauseMode = $true

function B64 { param([byte[]]$Bytes) return [Convert]::ToBase64String($Bytes) }

$isWin = ($env:OS -eq 'Windows_NT')
$kitDir = New-TempDir
$kit = $null
$kitError = ''
try { $kit = Initialize-ChildKit -Dir $kitDir }
catch { $kitError = $_.Exception.Message }
if ($kit -and $kit.Kind -eq 'none') { Write-Host ('  (no child programs in this run: ' + $kit.Why + ')') -ForegroundColor Yellow }

Test-Case 'the helper program for the process tests is ready (Windows: it is compiled here; Linux: /bin/sh)' {
    if ($kitError) { throw ('the helper program could not be prepared: ' + $kitError) }
}

function Invoke-Child {
    param([string]$Behavior, [string[]]$Params = @(), [int]$TimeoutSec = 60, [hashtable]$ExtraEnv)
    $c = Get-ChildCall $Behavior $Params
    if ($ExtraEnv) { return (Invoke-ProcessCapture -FilePath $c.File -Arguments $c.Arguments -TimeoutSec $TimeoutSec -ExtraEnv $ExtraEnv) }
    return (Invoke-ProcessCapture -FilePath $c.File -Arguments $c.Arguments -TimeoutSec $TimeoutSec)
}

Test-Case 'the helper program source is valid C# 5 (the language level of the compiler in Windows PowerShell 5.1)' {
    $r = Test-ChildKitSource
    if (-not $r.Checked) { Skip-Test 'this PowerShell has no Roslyn to check the C# with' }
    Assert-Eq @($r.Errors).Count 0 (@($r.Errors) -join '; ')
}

Test-Case 'ConvertTo-CmdArg: the quoting rules of Windows command lines' {
    $cases = @(
        @('abc', 'abc'),
        @('', '""'),
        @('a b', '"a b"'),
        @('a"b', '"a\"b"'),
        @('a\', 'a\'),
        @('a b\', '"a b\\"'),
        @('a\"b', '"a\\\"b"'),
        @('C:\Program Files\x y\', '"C:\Program Files\x y\\"'),
        @('--metadata', '--metadata'),
        @('INSTALL_SOURCE=aws-cli', 'INSTALL_SOURCE=aws-cli'),
        @('https://aws-mcp.us-east-1.api.aws/mcp', 'https://aws-mcp.us-east-1.api.aws/mcp'),
        @("tab`there", "`"tab`there`"")
    )
    foreach ($c in $cases) { Assert-Eq (ConvertTo-CmdArg $c[0]) $c[1] ('input [' + $c[0] + ']') }
    Assert-Eq (ConvertTo-CmdLine @('configure', 'set', 'region', 'us-east-1', '--profile', 'otchealth')) 'configure set region us-east-1 --profile otchealth'
    Assert-Eq (ConvertTo-CmdLine @()) ''
    Assert-Eq (ConvertTo-CmdLine $null) ''
}

Test-Case 'Invoke-ProcessCapture: output, error output and the exit code are captured separately' {
    Assert-ChildKitReady 'the capture check'
    $r = Invoke-Child 'out-err-exit' @('3')
    Assert-Eq $r.ExitCode 3
    Assert-Eq $r.StdOut "out`n"
    Assert-Eq $r.StdErr "err`n"
    Assert-True (-not $r.TimedOut)
    Assert-True ($null -eq $r.Error)
}

Test-Case 'Invoke-ProcessCapture: a program that waits for typing does not hang (its input is closed)' {
    Assert-ChildKitReady 'the closed-input check'
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $r = Invoke-Child 'cat-then-done'
    $sw.Stop()
    Assert-Eq $r.ExitCode 0
    Assert-Eq $r.StdOut "done`n"
    Assert-True ($sw.Elapsed.TotalSeconds -lt 30) 'must not wait for input'
}

Test-Case 'Invoke-ProcessCapture: the time limit stops a program that runs too long' {
    Assert-ChildKitReady 'the time limit check'
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $r = Invoke-Child 'sleep' @('60') -TimeoutSec 2
    $sw.Stop()
    Assert-True $r.TimedOut 'TimedOut expected'
    Assert-True ($null -eq $r.ExitCode) 'no exit code for a killed program'
    Assert-True ($sw.Elapsed.TotalSeconds -lt 45) ('took ' + $sw.Elapsed.TotalSeconds + ' s')
}

Test-Case 'Invoke-ProcessCapture: a lot of output on both streams does not deadlock and is complete' {
    Assert-ChildKitReady 'the large output check'
    $r = Invoke-Child 'flood' @('30000') -TimeoutSec 120
    Assert-Eq $r.ExitCode 0
    Assert-Eq (([regex]::Matches($r.StdOut, "`n")).Count) 30000
    Assert-Eq (([regex]::Matches($r.StdErr, "`n")).Count) 30000
    Assert-Contains $r.StdOut 'line 29999 of standard output'
}

Test-Case 'Invoke-ProcessCapture: a missing program is an Error value, not an exception' {
    $gone = Join-Path $kitDir 'definitely-not-here-program'
    $r = Invoke-ProcessCapture -FilePath $gone -Arguments @('x') -TimeoutSec 10
    Assert-True ($null -ne $r.Error -and $r.Error.Length -gt 0) 'Error expected'
    Assert-True ($null -eq $r.ExitCode)
}

Test-Case 'Invoke-ProcessCapture: UTF-8 output is decoded, extra environment variables arrive, and the safe defaults are set' {
    Assert-ChildKitReady 'the encoding and environment check'
    $r = Invoke-Child 'utf8'
    Assert-Eq $r.StdOut ('caf' + [char]0x00e9 + ' ' + [char]0x4e2d + "`n")
    $r2 = Invoke-Child 'env' @() -ExtraEnv @{ FOO = 'bar'; AWS_CLI_AGENT_TOOLKIT_HINT_DISABLED = 'true' }
    Assert-Eq $r2.StdOut "bar||off|utf-8|true`n"
}

Test-Case 'Invoke-ProcessCapture: tricky arguments reach the program exactly as given (quotes, spaces, backslashes, empty)' {
    Assert-ChildKitReady 'the argument check'
    $args1 = @('a b', 'a"b', 'a\', 'a b\', 'C:\Program Files\x y\', '--metadata', 'INSTALL_SOURCE=aws-cli', 'https://x.example/y?z=1&w=2', '"quoted"', "'single'", 'trailing space ', 'x\"y', '', 'plain')
    $r = Invoke-Child 'args' $args1
    Assert-Eq $r.ExitCode 0 $r.StdErr
    $expected = (@($args1) -join "`n") + "`n"
    Assert-Eq $r.StdOut $expected
}

Test-Case 'Invoke-LiveCommand: the program runs in this window and its exit code comes back' {
    Assert-ChildKitReady 'the live command check'
    $c0 = Get-ChildCall 'echo' @('live-command-test')
    Assert-Eq (Invoke-LiveCommand -FilePath $c0.File -Arguments $c0.Arguments) 0
    $c5 = Get-ChildCall 'fail' @('live-command-test-failure', '5')
    Assert-Eq (Invoke-LiveCommand -FilePath $c5.File -Arguments $c5.Arguments) 5
}

Test-Case 'Test-ProgramStartProbe: passes when ANY small program works, fails (with the reasons) when none does, is skipped when there is none' {
    Assert-ChildKitReady 'the program-start probe check'
    $good = Get-ChildCall 'echo' @('selfcheck-ok')
    $other = Get-ChildCall 'echo' @('something-else')
    $broken = Get-ChildCall 'fail' @('oops', '5')
    $script:probeSets = @{
        good   = @([pscustomobject]@{ Name = 'p-good'; File = $good.File; Args = $good.Arguments })
        second = @([pscustomobject]@{ Name = 'p-bad'; File = $other.File; Args = $other.Arguments }, [pscustomobject]@{ Name = 'p-good'; File = $good.File; Args = $good.Arguments })
        wrong  = @([pscustomobject]@{ Name = 'p-wrong'; File = $other.File; Args = $other.Arguments })
        fails  = @([pscustomobject]@{ Name = 'p-fails'; File = $broken.File; Args = $broken.Arguments })
        gone   = @([pscustomobject]@{ Name = 'p-gone'; File = (Join-Path $kitDir 'no-such-program'); Args = @('x') })
        none   = @()
    }
    foreach ($case in @('good', 'second', 'wrong', 'fails', 'gone', 'none')) {
        $script:probeCase = $case
        $r = & {
            function Get-SelfCheckPrograms { return $script:probeSets[$script:probeCase] }
            Test-ProgramStartProbe
        }
        if ($case -eq 'good' -or $case -eq 'second') { Assert-True $r.Ok ($case + ' must pass'); Assert-True (-not $r.Skipped) }
        elseif ($case -eq 'none') { Assert-True ($r.Ok -and $r.Skipped) 'no program at all: skipped, not failed' }
        else { Assert-True (-not $r.Ok) ($case + ' must fail'); Assert-True (-not $r.Skipped) }
    }
    $script:probeCase = 'wrong'
    $w = & { function Get-SelfCheckPrograms { return $script:probeSets[$script:probeCase] }; Test-ProgramStartProbe }
    Assert-Contains $w.Detail 'p-wrong: something-else'
    $script:probeCase = 'fails'
    $f = & { function Get-SelfCheckPrograms { return $script:probeSets[$script:probeCase] }; Test-ProgramStartProbe }
    Assert-Contains $f.Detail 'p-fails'
    Assert-Contains $f.Detail 'oops'
    Assert-Contains $f.Detail 'exit 5'
    $script:probeCase = 'gone'
    $g = & { function Get-SelfCheckPrograms { return $script:probeSets[$script:probeCase] }; Test-ProgramStartProbe }
    Assert-Contains $g.Detail 'p-gone'
}

Test-Case 'Test-ScriptSelfCheck: only the parts this PC needs are checked; a failing part is reported and the rest still run; only the program start check is fatal' {
    $none = Test-ScriptSelfCheck -Need @()
    Assert-Eq @($none.Fatal).Count 0 (@($none.Fatal) -join '; ')
    Assert-Eq @($none.Failed).Count 0
    Assert-Eq @($none.Passed).Count 0
    Assert-Eq (@($none.Skipped) -join ',') 'sha256,toml,json,rules'
    $all = Test-ScriptSelfCheck
    Assert-Eq @($all.Fatal).Count 0 (@($all.Fatal) -join '; ')
    Assert-Eq @($all.Failed).Count 0 ((@($all.Failed) | ForEach-Object { $_.Engine + ': ' + $_.Problem }) -join '; ')
    Assert-Eq (@($all.Passed) -join ',') 'sha256,toml,json,rules'
    Assert-Eq @($all.Skipped).Count 0
    $only = Test-ScriptSelfCheck -Need @('toml')
    Assert-Eq (@($only.Passed) -join ',') 'toml'
    Assert-Eq (@($only.Skipped) -join ',') 'sha256,json,rules'
    # a part that fails (by a wrong answer or by crashing) is listed, and the parts after it are still checked
    $r = & {
        function Test-EngineToml { return 'simulated wrong answer' }
        function Test-EngineJson { throw 'simulated crash' }
        Test-ScriptSelfCheck
    }
    Assert-Eq @($r.Fatal).Count 0 'a failing engine is never fatal'
    Assert-Eq (@($r.Failed | ForEach-Object { $_.Engine }) -join ',') 'toml,json'
    Assert-Eq (@($r.Failed | Where-Object { $_.Engine -eq 'toml' })[0].Problem) 'simulated wrong answer'
    Assert-Contains (@($r.Failed | Where-Object { $_.Engine -eq 'json' })[0].Problem) 'simulated crash'
    Assert-Eq (@($r.Passed) -join ',') 'sha256,rules'
    # a failing engine that this PC does not need is not even run
    $r2 = & {
        function Test-EngineJson { throw 'must not run' }
        Test-ScriptSelfCheck -Need @('toml')
    }
    Assert-Eq @($r2.Failed).Count 0
    # the program start check is the only fatal one
    $r3 = & {
        function Test-ProgramStartProbe { return [pscustomobject]@{ Ok = $false; Skipped = $false; Detail = 'simulated: nothing starts' } }
        Test-ScriptSelfCheck -Need @('toml')
    }
    Assert-Eq @($r3.Fatal).Count 1
    Assert-Contains (@($r3.Fatal)[0]) 'simulated: nothing starts'
    Assert-Eq (@($r3.Passed) -join ',') 'toml' 'the parts are still checked'
    $r4 = & {
        function Test-ProgramStartProbe { throw 'simulated crash of the probe' }
        Test-ScriptSelfCheck -Need @()
    }
    Assert-Eq @($r4.Fatal).Count 1
    Assert-Contains (@($r4.Fatal)[0]) 'simulated crash of the probe'
}

Test-Case 'Windows only: the real small programs of the self-check (cmd.exe and powershell.exe) start, answer, and the real probe passes' {
    if (-not $isWin) { Skip-Test 'this is not Windows' }
    $progs = @(Get-SelfCheckPrograms)
    Assert-Eq $progs.Count 2 ((@($progs) | ForEach-Object { $_.Name }) -join ',')
    foreach ($p in $progs) {
        $r = Invoke-ProcessCapture -FilePath $p.File -Arguments $p.Args -TimeoutSec 90
        Assert-True ($null -eq $r.Error) ($p.Name + ': ' + $r.Error)
        Assert-Eq $r.ExitCode 0 ($p.Name + ' ' + $r.StdErr)
        Assert-Eq $r.StdOut.Trim() 'selfcheck-ok' $p.Name
    }
    $probe = Test-ProgramStartProbe
    Assert-True ($probe.Ok -and -not $probe.Skipped) $probe.Detail
    $ps = Get-PowerShellExe
    Assert-True ($ps -and (Test-Path -LiteralPath $ps) -and $ps.ToLowerInvariant().EndsWith('powershell.exe')) ('Get-PowerShellExe gave [' + $ps + ']')
}

Test-Case 'Windows only: the AWS installer command runs the signed file by its full path (even with a quote and spaces in the path), switches on TLS 1.2, and passes the exit code on' {
    if (-not $isWin) { Skip-Test 'this is not Windows; the command is for Windows PowerShell' }
    $dir = New-TempDir
    try {
        $weird = Join-Path $dir "o'brien dir"
        [void](New-Item -ItemType Directory -Path $weird -Force)
        $fake = Join-Path $weird 'awscli-install-test.ps1'
        Save-Text $fake ("Write-Output ('installer-ran tls=' + [Net.ServicePointManager]::SecurityProtocol)" + "`r`n" + 'exit 7' + "`r`n")
        $ps = Get-PowerShellExe
        $cmd = Get-InstallerRunCommand $fake
        $r = Invoke-ProcessCapture -FilePath $ps -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $cmd) -TimeoutSec 120
        Assert-True ($null -eq $r.Error) $r.Error
        Assert-Eq $r.ExitCode 7 ($r.StdOut + ' ' + $r.StdErr)
        Assert-Contains $r.StdOut 'installer-ran'
        Assert-Contains $r.StdOut 'Tls12'
    }
    finally { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }
}

Test-Case 'Get-InstallerRunCommand: the text of the installer command (single quotes in the path are doubled, TLS 1.2, exit code)' {
    $cmd = Get-InstallerRunCommand "C:\Users\o'brien\AppData\Local\Temp\awscli-install-1.ps1"
    Assert-Eq $cmd "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; & 'C:\Users\o''brien\AppData\Local\Temp\awscli-install-1.ps1'; exit `$LASTEXITCODE"
}

Test-Case 'Resolve-Exe finds programs on the PATH and returns $null for unknown ones' {
    $known = 'sh'
    if ($isWin) { $known = 'cmd' }
    $p = Resolve-Exe $known
    Assert-True ($p -and (Test-Path -LiteralPath $p)) ($known + ' should be found')
    Assert-True ($null -eq (Resolve-Exe 'definitely-not-a-program-xyz'))
}

Test-Case 'the AWS CLI finder: lists every copy once, reads each version, and picks the newest' {
    Assert-ChildKitReady 'the AWS CLI finder check'
    $tmp = New-TempDir
    $savedPath = $env:PATH
    $savedLocal = $env:LOCALAPPDATA
    $savedPf = $env:ProgramFiles
    try {
        $binA = Join-Path $tmp 'binA'
        $binB = Join-Path $tmp 'binB'
        $exeA = Save-FakeAwsProgram -Dir $binA -Text 'aws-cli/2.10.0 Python/3.11.4 Windows/10 exe/AMD64'
        $exeB = Save-FakeAwsProgram -Dir $binB -Text 'aws-cli/2.35.9 Python/3.13.9 Windows/11 exe/AMD64' -OnError   # (an old CLI prints its version on the error stream)
        # the per-user install location the installer uses: <LOCALAPPDATA>\Programs\Amazon\AWSCLIV2\aws.exe
        $local = Join-Path $tmp 'local'
        $userExe = Save-FakeAwsProgram -Dir (Join-Rel $local 'Programs\Amazon\AWSCLIV2') -Text 'aws-cli/2.35.9 Python/3.13.9 Windows/11 exe/AMD64' -OnError -FileName 'aws.exe'
        if ($isWin) { $env:PATH = $binA + ';' + $binB + ';' + (Join-Path $env:SystemRoot 'System32') }
        else { $env:PATH = $binA + ':' + $binB + ':/usr/bin:/bin' }
        $env:LOCALAPPDATA = $local
        $env:ProgramFiles = Join-Path $tmp 'nope'
        $cands = @(Get-AwsExeCandidates)
        Assert-True ($cands -contains $exeA) 'binA copy missing'
        Assert-True ($cands -contains $exeB) 'binB copy missing'
        Assert-True ($cands -contains $userExe) 'per-user copy missing'
        Assert-Eq @($cands | Group-Object { $_.ToLowerInvariant() } | Where-Object { $_.Count -gt 1 }).Count 0 'each copy only once'
        $vA = Get-AwsCliVersion $exeA
        Assert-Eq ([string]$vA) '2.10.0'
        $vB = Get-AwsCliVersion $exeB
        Assert-Eq ([string]$vB) '2.35.9' 'version printed on the error stream must be read too'
        $best = Find-BestAwsCli
        Assert-Eq ([string]$best.Version) '2.35.9'
        Assert-True ($best.Exe -ne $exeA) 'the old copy that comes first on the PATH must not win'
        [void](Save-FakeAwsProgram -Dir $binA -Text 'something else entirely')
        Assert-True ($null -eq (Get-AwsCliVersion $exeA)) 'unreadable version gives $null'
    }
    finally {
        $env:PATH = $savedPath
        $env:LOCALAPPDATA = $savedLocal
        $env:ProgramFiles = $savedPf
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Test-Case 'Get-PathWithoutProgram: takes out every folder that holds the program (any ending), keeps the order and the other folders' {
    $tmp = New-TempDir
    try {
        $sep = [string][System.IO.Path]::PathSeparator
        $names = @('hasExe', 'hasCmd', 'hasBare', 'hasPs1', 'hasBat', 'hasCom', 'other', 'lookalike', 'two')
        $dirs = @{}
        foreach ($n in $names) { $dirs[$n] = Join-Path $tmp $n; [void](New-Item -ItemType Directory -Path $dirs[$n] -Force) }
        Save-Text (Join-Path $dirs['hasExe'] 'codex.exe') 'x'
        Save-Text (Join-Path $dirs['hasCmd'] 'codex.cmd') 'x'
        Save-Text (Join-Path $dirs['hasBare'] 'codex') 'x'
        Save-Text (Join-Path $dirs['hasPs1'] 'codex.ps1') 'x'
        Save-Text (Join-Path $dirs['hasBat'] 'codex.bat') 'x'
        Save-Text (Join-Path $dirs['hasCom'] 'codex.com') 'x'
        Save-Text (Join-Path $dirs['other'] 'node.exe') 'x'
        Save-Text (Join-Path $dirs['lookalike'] 'codex2.exe') 'x'
        Save-Text (Join-Path $dirs['lookalike'] 'notcodex.cmd') 'x'
        Save-Text (Join-Path $dirs['two'] 'codex.cmd') 'x'
        Save-Text (Join-Path $dirs['two'] 'codex.exe') 'x'
        $pathText = (@($dirs['other'], $dirs['hasExe'], $dirs['lookalike'], $dirs['hasCmd'], '', $dirs['hasBare'], $dirs['two'], $dirs['hasPs1'], $dirs['hasBat'], $dirs['hasCom'], (Join-Path $tmp 'does-not-exist')) -join $sep)
        $r = Get-PathWithoutProgram -Name 'codex' -PathValue $pathText
        $left = @($r.Path -split [regex]::Escape($sep))
        Assert-Eq ($left -join '|') ((@($dirs['other'], $dirs['lookalike']) + @('') + @((Join-Path $tmp 'does-not-exist'))) -join '|') 'only the folders without codex stay, in the same order (an empty piece is kept as it was)'
        $expectRemoved = @($dirs['hasExe'], $dirs['hasCmd'], $dirs['hasBare'], $dirs['two'], $dirs['hasPs1'], $dirs['hasBat'], $dirs['hasCom'])
        Assert-Eq (@($r.Removed) -join '|') ($expectRemoved -join '|') 'the removed folders are listed in PATH order'
        # nothing to remove: the text stays as it was
        $r2 = Get-PathWithoutProgram -Name 'codex' -PathValue ($dirs['other'] + $sep + $dirs['lookalike'])
        Assert-Eq $r2.Path ($dirs['other'] + $sep + $dirs['lookalike'])
        Assert-Eq @($r2.Removed).Count 0
        # an empty or missing PATH is handled
        Assert-Eq (Get-PathWithoutProgram -Name 'codex' -PathValue '').Path ''
        Assert-Eq @((Get-PathWithoutProgram -Name 'codex' -PathValue $null).Removed).Count 0
        # quotes around a folder are understood
        $q = Get-PathWithoutProgram -Name 'codex' -PathValue ('"' + $dirs['hasExe'] + '"' + $sep + $dirs['other'])
        Assert-Eq $q.Path $dirs['other']
        Assert-Eq (@($q.Removed)[0]) $dirs['hasExe']
    }
    finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}

Test-Case 'Get-ShortText: one line, runs of spaces and line breaks become one space, long text is cut with "..."' {
    Assert-Eq (Get-ShortText "  a`r`n   b`t c  ") 'a b c'
    Assert-Eq (Get-ShortText '') ''
    Assert-Eq (Get-ShortText $null) ''
    Assert-Eq (Get-ShortText ('x' * 50) 50) ('x' * 50)
    $cut = Get-ShortText ('word ' * 100) 40
    Assert-True ($cut.Length -le 40) ('length ' + $cut.Length)
    Assert-True ($cut.EndsWith('...')) 'must end with ...'
    Assert-True (-not $cut.Contains("`n"))
}

Test-Case 'Get-Sha256Hex: known test vectors' {
    Assert-Eq (Get-Sha256Hex ([byte[]]@())) 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    Assert-Eq (Get-Sha256Hex ([System.Text.Encoding]::ASCII.GetBytes('abc'))) 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
}

Test-Case 'Get-DominantNewline: LF, CRLF, mixed and empty' {
    Assert-Eq (Get-DominantNewline '') "`n"
    Assert-Eq (Get-DominantNewline $null) "`n"
    Assert-Eq (Get-DominantNewline "a`nb`nc") "`n"
    Assert-Eq (Get-DominantNewline "a`r`nb`r`n") "`r`n"
    Assert-Eq (Get-DominantNewline "a`r`nb`nc`n") "`n"
    Assert-Eq (Get-DominantNewline "a`r`nb`r`nc`n") "`r`n"
    Assert-Eq (Get-DominantNewline 'no newline') "`n"
}

$tmpRoot = New-TempDir
try {
    $null = New-TestContext $tmpRoot

    Test-Case 'Read-TextFile: missing, empty, BOM, plain, UTF-16, binary and invalid UTF-8' {
        $d = Join-Path $tmpRoot 'read'
        [void](New-Item -ItemType Directory -Path $d)
        $m = Read-TextFile (Join-Path $d 'missing.txt')
        Assert-True ($m.Ok -and -not $m.Exists)
        [System.IO.File]::WriteAllBytes((Join-Path $d 'empty.txt'), [byte[]]@())
        $e1 = Read-TextFile (Join-Path $d 'empty.txt')
        Assert-True ($e1.Ok -and $e1.Exists -and $e1.Text -eq '' -and -not $e1.HasBom)
        Save-Text (Join-Path $d 'bom.txt') ('caf' + [char]0x00e9) -Bom
        $b1 = Read-TextFile (Join-Path $d 'bom.txt')
        Assert-True ($b1.Ok -and $b1.HasBom)
        Assert-Eq $b1.Text ('caf' + [char]0x00e9)
        Save-Text (Join-Path $d 'plain.txt') ('na' + [char]0x00ef + 've ' + [char]0x4e2d)
        $p1 = Read-TextFile (Join-Path $d 'plain.txt')
        Assert-True ($p1.Ok -and -not $p1.HasBom)
        Assert-Eq $p1.Text ('na' + [char]0x00ef + 've ' + [char]0x4e2d)
        [System.IO.File]::WriteAllBytes((Join-Path $d 'u16le.txt'), [byte[]](@(255, 254) + [System.Text.Encoding]::Unicode.GetBytes('hi')))
        [System.IO.File]::WriteAllBytes((Join-Path $d 'u16be.txt'), [byte[]](@(254, 255) + [System.Text.Encoding]::BigEndianUnicode.GetBytes('hi')))
        [System.IO.File]::WriteAllBytes((Join-Path $d 'bin.txt'), [byte[]](65, 0, 66))
        [System.IO.File]::WriteAllBytes((Join-Path $d 'bad.txt'), [byte[]](65, 195, 40, 66))
        foreach ($n in @('u16le.txt', 'u16be.txt', 'bin.txt', 'bad.txt')) {
            $r = Read-TextFile (Join-Path $d $n)
            Assert-True (-not $r.Ok) ($n + ' must be refused')
            Assert-True ($r.Error.Length -gt 3) 'an error text is needed'
        }
    }

    Test-Case 'Write-TextFile: UTF-8 without BOM, a BOM only when asked, the folder is created' {
        $p = Join-Path (Join-Path $tmpRoot 'write\deeper') 'a.txt'
        Write-TextFile -Path $p -Text ('x' + [char]0x00e9)
        $b = Get-FileBytes $p
        Assert-Eq (($b | ForEach-Object { $_.ToString('x2') }) -join ' ') '78 c3 a9'
        Write-TextFile -Path $p -Text 'y' -Bom $true
        $b2 = Get-FileBytes $p
        Assert-Eq (($b2 | ForEach-Object { $_.ToString('x2') }) -join ' ') 'ef bb bf 79'
    }

    Test-Case 'New-BackupCopy: byte-identical copy next to the file, never overwrites an earlier backup' {
        $p = Join-Path $tmpRoot 'back.txt'
        Save-Text $p "one`n"
        $b1 = New-BackupCopy -Path $p -Tag 'bak'
        Save-Text $p "two`n"
        $b2 = New-BackupCopy -Path $p -Tag 'bak'
        Assert-True ($b1 -ne $b2) 'two different backup names'
        Assert-Eq (Get-FileText $b1) "one`n"
        Assert-Eq (Get-FileText $b2) "two`n"
        Assert-Contains $b1 'back.txt.bak-'
        Assert-True ($script:Ctx.Backups.Contains($b1) -and $script:Ctx.Backups.Contains($b2)) 'backups are listed for the summary'
    }

    Test-Case 'Add-LogText: appends in the encoding the file already has (UTF-8 with and without BOM, UTF-16 both ways); false when it cannot' {
        $d = Join-Path $tmpRoot 'log'
        [void](New-Item -ItemType Directory -Path $d)
        $more = 'details: caf' + [char]0x00e9 + "`r`nsecond line"
        # a UTF-8 file without BOM
        $u8 = Join-Path $d 'u8.txt'
        Save-Text $u8 "first`r`n"
        Assert-True (Add-LogText -Path $u8 -Text $more)
        $b = Get-FileBytes $u8
        Assert-True (-not ($b[0] -eq 239 -and $b[1] -eq 187)) 'no BOM may appear'
        Assert-Eq (Get-FileText $u8) ("first`r`n" + $more)
        # a UTF-8 file with a BOM: the BOM stays once, at the front
        $u8b = Join-Path $d 'u8bom.txt'
        Save-Text $u8b "first`r`n" -Bom
        Assert-True (Add-LogText -Path $u8b -Text $more)
        $bb = Get-FileBytes $u8b
        Assert-True ($bb[0] -eq 239 -and $bb[1] -eq 187 -and $bb[2] -eq 191 -and -not ($bb[3] -eq 239 -and $bb[4] -eq 187)) 'one BOM at the front, none in the middle'
        Assert-Eq (Get-FileText $u8b) ("first`r`n" + $more)
        # UTF-16 little endian and big endian (a transcript could be written like that): the text is appended the same way and reads back
        foreach ($case in @(@('le', [System.Text.Encoding]::Unicode), @('be', [System.Text.Encoding]::BigEndianUnicode))) {
            $p = Join-Path $d ('u16' + $case[0] + '.txt')
            $enc = $case[1]
            $bytes = [byte[]](@($enc.GetPreamble()) + @($enc.GetBytes("first`r`n")))
            [System.IO.File]::WriteAllBytes($p, $bytes)
            Assert-True (Add-LogText -Path $p -Text $more) $case[0]
            $raw = [System.IO.File]::ReadAllBytes($p)
            $text = $enc.GetString($raw, 2, $raw.Length - 2)
            Assert-Eq $text ("first`r`n" + $more) ('utf-16 ' + $case[0])
        }
        # a file that is not there, and a path that is a folder: false, no exception
        Assert-True (-not (Add-LogText -Path (Join-Path $d 'missing.txt') -Text 'x')) 'a missing file cannot be appended to'
        Assert-True (-not (Add-LogText -Path $d -Text 'x')) 'a folder cannot be appended to'
    }

    Test-Case 'Start-SetupLog: writes a transcript next to the script, and falls back to the temporary folder when that folder cannot be used' {
        $d = Join-Path $tmpRoot 'transcripts'
        [void](New-Item -ItemType Directory -Path $d)
        $first = Start-SetupLog -ScriptDir $d -Stamp 'unit-1' -UserHome $tmpRoot
        try {
            Assert-Eq $first (Join-Path $d 'aws-toolkit-setup-log-unit-1.txt')
            Write-Host 'a line that is written while the transcript runs' | Out-Null
        }
        finally { Stop-Transcript | Out-Null }
        Assert-True (Test-Path -LiteralPath $first) 'the transcript file must exist'
        # the first candidate is below a FILE, so it cannot be created: the temporary folder is used instead.
        # (Windows PowerShell 5.1 starts a transcript there WITHOUT an error, found on a real Windows machine,
        # which is why Start-SetupLog creates the log file first as a test.)
        $blocker = Join-Path $tmpRoot 'not-a-folder.txt'
        Save-Text $blocker 'x'
        $second = Start-SetupLog -ScriptDir (Join-Path $blocker 'sub') -Stamp 'unit-2' -UserHome $tmpRoot
        try {
            Assert-Eq $second (Join-Path ([System.IO.Path]::GetTempPath()) 'aws-toolkit-setup-log-unit-2.txt')
            Assert-True (Test-Path -LiteralPath $second) 'the log file must exist where the closing screen says it is'
        }
        finally {
            if ($second) { Stop-Transcript | Out-Null }
            if ($second) { Remove-Item -LiteralPath $second -Force -ErrorAction SilentlyContinue }
        }
        # a folder that does not exist: the same, and the missing folder is not created
        $missing = Join-Path $tmpRoot 'no-such-folder'
        $third = Start-SetupLog -ScriptDir $missing -Stamp 'unit-3' -UserHome $tmpRoot
        try {
            Assert-Eq $third (Join-Path ([System.IO.Path]::GetTempPath()) 'aws-toolkit-setup-log-unit-3.txt')
            Assert-True (Test-Path -LiteralPath $third) 'the log file must exist where the closing screen says it is'
        }
        finally {
            if ($third) { Stop-Transcript | Out-Null }
            if ($third) { Remove-Item -LiteralPath $third -Force -ErrorAction SilentlyContinue }
        }
        Assert-True (-not (Test-Path -LiteralPath $missing)) 'a missing folder must not be created'
    }

    Test-Case 'Start-SetupLog: a folder that cannot take the log file is skipped even when Start-Transcript does not complain (as in Windows PowerShell 5.1)' {
        $blocker2 = Join-Path $tmpRoot 'not-a-folder-2.txt'
        Save-Text $blocker2 'x'
        $expected = Join-Path ([System.IO.Path]::GetTempPath()) 'aws-toolkit-setup-log-unit-4.txt'
        try {
            $got = & {
                # stands in for the 5.1 behaviour that was found on a real Windows machine: no error, and no file either
                function Start-Transcript { [CmdletBinding()] param([string]$Path) }
                Start-SetupLog -ScriptDir (Join-Path $blocker2 'sub') -Stamp 'unit-4' -UserHome $tmpRoot
            }
            Assert-Eq $got $expected
            Assert-True (Test-Path -LiteralPath $expected) 'the log file must exist where the closing screen says it is'
        }
        finally { Remove-Item -LiteralPath $expected -Force -ErrorAction SilentlyContinue }
    }

    Test-Case 'Get-WebBytes: downloads to a temporary file, returns the bytes, and cleans up (also when the download fails)' {
        $src = Join-Path $tmpRoot 'served.bin'
        [System.IO.File]::WriteAllBytes($src, [byte[]](1, 2, 3, 250, 255))
        $before = @(Get-ChildItem -LiteralPath ([System.IO.Path]::GetTempPath()) -Filter 'aws-toolkit-*.tmp' -ErrorAction SilentlyContinue).Count
        $r = & {
            function Get-WebFile { param([string]$Url, [string]$OutFile) Copy-Item -LiteralPath $src -Destination $OutFile }
            Get-WebBytes 'https://example.invalid/x'
        }
        Assert-Eq (B64 $r) (B64 ([byte[]](1, 2, 3, 250, 255)))
        $threw = $false
        try {
            & {
                function Get-WebFile { param([string]$Url, [string]$OutFile) [System.IO.File]::WriteAllBytes($OutFile, [byte[]](9)); throw 'boom' }
                Get-WebBytes 'https://example.invalid/x'
            }
        }
        catch { $threw = $true }
        Assert-True $threw 'the failure must reach the caller'
        $after = @(Get-ChildItem -LiteralPath ([System.IO.Path]::GetTempPath()) -Filter 'aws-toolkit-*.tmp' -ErrorAction SilentlyContinue).Count
        Assert-Eq $after $before 'no temporary file may be left behind'
    }

    Test-Case 'Get-WebFile and Get-WebBytes really download over http (the real Invoke-WebRequest, from a tiny local server) and fail cleanly when nothing answers' {
        $savedNoProxy = $env:NO_PROXY
        $env:NO_PROXY = '127.0.0.1,localhost'
        $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
        $listener.Start()
        $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
        $body = New-Object byte[] 300
        for ($i = 0; $i -lt $body.Length; $i++) { $body[$i] = [byte]($i % 256) }
        $server = [powershell]::Create()
        try {
            [void]$server.AddScript({
                param($Listener, [byte[]]$Body)
                $client = $Listener.AcceptTcpClient()
                try {
                    $stream = $client.GetStream()
                    $buf = New-Object byte[] 8192
                    $got = ''
                    while ($got.IndexOf("`r`n`r`n", [StringComparison]::Ordinal) -lt 0) {
                        $n = $stream.Read($buf, 0, $buf.Length)
                        if ($n -le 0) { break }
                        $got += [System.Text.Encoding]::ASCII.GetString($buf, 0, $n)
                    }
                    $head = [System.Text.Encoding]::ASCII.GetBytes("HTTP/1.1 200 OK`r`nContent-Type: application/octet-stream`r`nContent-Length: " + $Body.Length + "`r`nConnection: close`r`n`r`n")
                    $stream.Write($head, 0, $head.Length)
                    $stream.Write($Body, 0, $Body.Length)
                    $stream.Flush()
                }
                finally { $client.Close() }
            }).AddArgument($listener).AddArgument($body)
            $async = $server.BeginInvoke()
            $url = 'http://127.0.0.1:' + $port + '/file.bin'
            $out = Join-Path $tmpRoot 'downloaded.bin'
            Get-WebFile $url $out
            Assert-Eq (B64 (Get-FileBytes $out)) (B64 $body) 'the downloaded file must be identical'
            [void]$async.AsyncWaitHandle.WaitOne(15000)
        }
        finally {
            $listener.Stop()
            $server.Dispose()
        }
        # nothing listens on that port any more: the download fails with an exception, and Get-WebBytes leaves nothing behind
        $before = @(Get-ChildItem -LiteralPath ([System.IO.Path]::GetTempPath()) -Filter 'aws-toolkit-*.tmp' -ErrorAction SilentlyContinue).Count
        $threw = $false
        try { [void](Get-WebBytes ('http://127.0.0.1:' + $port + '/nothing-here')) } catch { $threw = $true }
        $env:NO_PROXY = $savedNoProxy
        Assert-True $threw 'a refused connection must throw'
        $after = @(Get-ChildItem -LiteralPath ([System.IO.Path]::GetTempPath()) -Filter 'aws-toolkit-*.tmp' -ErrorAction SilentlyContinue).Count
        Assert-Eq $after $before 'no temporary file may be left behind'
    }
}
finally {
    Remove-Item -LiteralPath $tmpRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Test-Case 'Test-TcpPort: true for an open local port, false for a closed one (and quickly)' {
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try {
        $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
        Assert-True (Test-TcpPort '127.0.0.1' $port 3000) 'open port'
    }
    finally { $listener.Stop() }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    Assert-True (-not (Test-TcpPort '127.0.0.1' $port 3000)) 'closed port'
    Assert-True ($sw.Elapsed.TotalSeconds -lt 15) 'must answer quickly'
}

Test-Case 'Test-AwsInstallerSignature: only a VALID signature by Amazon Web Services, Inc. passes (stand-in for Get-AuthenticodeSignature)' {
    $cases = @(
        @{ Status = 'Valid'; Subject = 'CN="Amazon Web Services, Inc.", O="Amazon Web Services, Inc.", L=Seattle, S=Washington, C=US'; Expect = $true },
        @{ Status = 'Valid'; Subject = 'CN=Some Other Company'; Expect = $false },
        @{ Status = 'NotSigned'; Subject = ''; Expect = $false },
        @{ Status = 'HashMismatch'; Subject = 'CN="Amazon Web Services, Inc."'; Expect = $false },
        @{ Status = 'UnknownError'; Subject = 'CN="Amazon Web Services, Inc."'; Expect = $false }
    )
    foreach ($c in $cases) {
        $script:sigCase = $c
        $r = & {
            function Get-AuthenticodeSignature {
                param([string]$FilePath)
                $cert = $null
                if ($script:sigCase.Subject) { $cert = [pscustomobject]@{ Subject = $script:sigCase.Subject } }
                return [pscustomobject]@{ Status = $script:sigCase.Status; SignerCertificate = $cert }
            }
            Test-AwsInstallerSignature 'C:\x\install.ps1'
        }
        Assert-Eq $r.Ok $c.Expect ($c.Status + ' / ' + $c.Subject)
        Assert-Eq $r.Status $c.Status
    }
}

Test-Case 'Windows only: the real Get-AuthenticodeSignature says an unsigned file is not valid' {
    if (-not $isWin) { Skip-Test 'this is not Windows' }
    $d = New-TempDir
    try {
        $f = Join-Path $d 'unsigned.ps1'
        Save-Text $f "Write-Output 'hello'`r`n"
        $r = Test-AwsInstallerSignature $f
        Assert-True (-not $r.Ok) 'an unsigned file must not pass'
        Assert-Eq $r.Status 'NotSigned'
    }
    finally { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue }
}

Test-Case 'Windows only: Update-SessionPath keeps this window''s own folders, adds the ones from Windows, and lists nothing twice' {
    if (-not $isWin) { Skip-Test 'this is not Windows' }
    $saved = $env:Path
    try {
        $mine = 'C:\w3-unit-test-folder-one;C:\w3-unit-test-folder-two\;c:\W3-UNIT-TEST-FOLDER-ONE'
        $env:Path = $mine
        Update-SessionPath
        $parts = @($env:Path -split ';')
        $lower = @($parts | ForEach-Object { $_.TrimEnd('\').ToLowerInvariant() })
        Assert-Eq @($lower | Where-Object { $_ -eq 'c:\w3-unit-test-folder-one' }).Count 1 'no folder twice (case and a final backslash do not matter)'
        Assert-Eq @($lower | Where-Object { $_ -eq 'c:\w3-unit-test-folder-two' }).Count 1
        $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
        $firstMachine = ($machine -split ';' | Where-Object { $_.Trim().Length -gt 0 } | Select-Object -First 1)
        Assert-True ($lower -contains $firstMachine.Trim().TrimEnd('\').ToLowerInvariant()) 'the machine-wide folders must be there'
        Assert-True ($lower.IndexOf($firstMachine.Trim().TrimEnd('\').ToLowerInvariant()) -lt $lower.IndexOf('c:\w3-unit-test-folder-one')) 'the order is: machine, user, then this window''s own'
    }
    finally { $env:Path = $saved }
}

Test-Case 'Get-RunningAgentApps: names the AI tools that are open (stand-in for Get-Process)' {
    $r = & {
        function Get-Process {
            param([string]$ErrorAction)
            foreach ($n in @('notepad', 'Codex', 'codex', 'chrome', 'claude', 'Cursor', 'explorer', 'windsurf-helper', 'myclaude')) { [pscustomobject]@{ ProcessName = $n } }
        }
        Get-RunningAgentApps
    }
    $list = @($r)
    Assert-Eq (($list | ForEach-Object { $_.ToLowerInvariant() }) -join ',') 'claude,codex,cursor,windsurf-helper' 'case-insensitive names, listed once, sorted'
}

Remove-Item -LiteralPath $kitDir -Recurse -Force -ErrorAction SilentlyContinue
Complete-Tests '07-process-and-file-helpers'
