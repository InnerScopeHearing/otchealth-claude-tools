# A pretend Windows PC for the end-to-end tests (dot-sourced by 06-mock-end-to-end.ps1 AFTER the script under test).
# The shipped script only talks to the outside world through a few small functions (Resolve-Exe, Invoke-ProcessCapture,
# Invoke-LiveCommand, Get-WebFile, Get-WebBytes, Test-TcpPort, Test-AwsInstallerSignature, Get-RunningAgentApps,
# Update-SessionPath, Get-AwsExeCandidates, Get-SelfCheckPrograms). This file REPLACES those functions with fakes that behave like the real
# aws, codex, uv and uvx programs as far as the script can see them (based on AWS's setup.md and the wizard source).
# Nothing here starts a real program, touches the network or reads or writes outside the temporary folders.

$script:Fake = $null

function New-FakeState {
    return [pscustomobject]@{
        Calls            = (New-Object 'System.Collections.Generic.List[string]')
        LiveEnv          = (New-Object 'System.Collections.Generic.List[string]')
        UvInstalled      = $true
        UvxOnPath        = $true
        AwsVersion       = '2.35.9'          # '' means the AWS CLI is not installed
        AwsInstallsAs    = '2.35.9'          # what the AWS installer leaves behind
        AwsExe           = '/fake/bin/aws'
        CodexOnPath      = $true
        SigOk            = $true
        LoggedIn         = $false
        LoginAs          = 'arn:aws:iam::900915535335:user/otchealth-ai-reader'
        LoginExit        = 0
        LoginExits       = @()               # when not empty: the exit code of each "aws login" try, one after the other
        Answers          = (New-Object 'System.Collections.Generic.Queue[string]')   # what a person types, for -Attended runs
        Config           = @{}               # what "aws configure get" can see for the profile
        WizardExit       = 0
        PrewarmExit      = 0
        SkillsOk         = $true
        RulesBytes       = $null             # set by the test (the pinned rules bytes unless a test tampers with them)
        RulesThrow       = $false
        CodexExtraServers = @()
        CodexWizardWritesNothing = $false   # a wizard that claims success but leaves Codex's config alone (unexpected)
        CodexAddCrashes  = $false           # a wizard that SEES "codex" and crashes because "codex mcp add" fails (check=True)
        LogoutExit       = 0                # exit code of "aws logout"
        LogoutStillWorks = $false           # "aws logout" says fine, but the profile still gives an identity
        ProbeMode        = 'ok'             # the small test programs of the self-check: ok | first-fails | fail | none
        WizardPaths      = (New-Object 'System.Collections.Generic.List[string]')   # the PATH each wizard run was given ('' = not changed)
        Running          = @()
        ThrowOn          = ''                # a call containing this text makes the fake crash (to test the safety net)
        PostWizard       = @{}               # path -> text of the file right after the wizard wrote it
        WizardRuns       = 0
        Downloads        = (New-Object 'System.Collections.Generic.List[string]')
        PowerShellCommands = (New-Object 'System.Collections.Generic.List[string]')
    }
}

function Get-FakeAccountOf {
    param([string]$Arn)
    $parts = $Arn -split ':'
    if ($parts.Count -ge 5) { return $parts[4] }
    return ''
}

function Remove-FakeTomlTables {
    # Removes every table whose header is [<Prefix>] or [<Prefix>.something] (what "codex mcp add" does to an entry it replaces).
    param([string]$Text, [string]$Prefix)
    $out = New-Object 'System.Collections.Generic.List[string]'
    $skip = $false
    foreach ($line in ([regex]::Split($Text, "`n"))) {
        if ($line -match '^\s*\[') { $skip = ($line -match ('^\s*\[' + [regex]::Escape($Prefix) + '(\]|\.)')) }
        if (-not $skip) { $out.Add($line) }
    }
    return ($out -join "`n")
}

function Set-FakeCodexDefault {
    $ctx = $script:Ctx
    $path = $ctx.CodexConfig
    $old = ''
    if (Test-Path -LiteralPath $path) { $old = (Read-TextFile $path).Text }
    $kept = (Remove-FakeTomlTables $old 'mcp_servers.aws-mcp').TrimEnd()
    $entry = '[mcp_servers.aws-mcp]' + "`n" + 'command = "uvx"' + "`n" + 'args = ["mcp-proxy-for-aws@latest", "' + $script:Cfg.McpUrl + '", "--metadata", "INSTALL_SOURCE=aws-cli"]'
    if ($kept.Length -gt 0) { $new = $kept + "`n`n" + $entry + "`n" } else { $new = $entry + "`n" }
    Save-Text $path $new
    $script:Fake.PostWizard[$path] = $new
}

function Add-FakeJsonDefault {
    # Like the wizard: adds mcpServers.aws-mcp unless a server of that name is already there ("already configured").
    # (Plain PSCustomObjects, so that this also runs in Windows PowerShell 5.1, which has no ConvertFrom-Json -AsHashtable.)
    param([string]$Path)
    $entry = [pscustomobject]@{ command = 'uvx'; args = @('mcp-proxy-for-aws@latest', $script:Cfg.McpUrl, '--metadata', 'INSTALL_SOURCE=aws-cli') }
    if (Test-Path -LiteralPath $Path) { $obj = (Get-FileText $Path) | ConvertFrom-Json }
    else { $obj = [pscustomobject]@{} }
    if ($null -eq $obj.PSObject.Properties['mcpServers']) { $obj | Add-Member -NotePropertyName 'mcpServers' -NotePropertyValue ([pscustomobject]@{}) }
    if ($null -ne $obj.mcpServers.PSObject.Properties['aws-mcp']) { return $false }
    $obj.mcpServers | Add-Member -NotePropertyName 'aws-mcp' -NotePropertyValue $entry
    $text = ($obj | ConvertTo-Json -Depth 20) + "`n"
    Save-Text $Path $text
    $script:Fake.PostWizard[$Path] = $text
    return $true
}

function Test-FakeCodexVisible {
    # Like the real wizard, which looks for "codex" on ITS OWN PATH: visible only when a folder on that PATH holds codex.cmd.
    param([hashtable]$ExtraEnv)
    $pathText = [Environment]::GetEnvironmentVariable('PATH')
    if ($ExtraEnv -and $ExtraEnv.ContainsKey('PATH')) { $pathText = [string]$ExtraEnv['PATH'] }
    foreach ($d in ($pathText -split [regex]::Escape([string][System.IO.Path]::PathSeparator))) {
        if ($d -and (Test-Path -LiteralPath (Join-Path $d 'codex.cmd'))) { return $true }
    }
    return $false
}

function Invoke-FakeWizard {
    param($Res, [hashtable]$ExtraEnv)
    $f = $script:Fake
    $ctx = $script:Ctx
    $f.WizardRuns++
    if ($ExtraEnv -and $ExtraEnv.ContainsKey('PATH')) { $f.WizardPaths.Add([string]$ExtraEnv['PATH']) } else { $f.WizardPaths.Add('') }
    $codexVisible = Test-FakeCodexVisible $ExtraEnv
    if ($codexVisible -and $f.CodexAddCrashes -and (Test-Path -LiteralPath $ctx.CodexDir -PathType Container)) {
        $Res.ExitCode = 1
        $Res.StdErr = "Traceback (most recent call last):`n  File ""awscli/customizations/agent_toolkit.py"", line 1, in configure`nsubprocess.CalledProcessError: Command '['codex', 'mcp', 'add', 'aws-mcp']' returned non-zero exit status 1."
        return $Res
    }
    if ($f.WizardExit -ne 0) {
        $Res.ExitCode = $f.WizardExit
        $Res.StdErr = 'Error: simulated wizard failure'
        return $Res
    }
    $lines = New-Object 'System.Collections.Generic.List[string]'
    $lines.Add('Detected AI agents:')
    foreach ($a in $ctx.AgentFolders) {
        if (-not (Test-Path -LiteralPath $a.Path -PathType Container)) { continue }
        if ($a.Name -eq 'Codex') {
            if (-not $codexVisible) { $lines.Add("  Codex: MCP skipped (requires 'codex' on PATH)"); continue }
            if ($f.CodexWizardWritesNothing) { $lines.Add('  Codex: MCP server configured'); continue }
            Set-FakeCodexDefault
            $lines.Add('  Codex: MCP server configured')
            continue
        }
        $target = @($ctx.JsonTargets | Where-Object { $_.Name -eq $a.Name })
        if ($target.Count -gt 0) {
            if (Add-FakeJsonDefault $target[0].Path) { $lines.Add('  ' + $a.Name + ': MCP server configured') }
            else { $lines.Add('  ' + $a.Name + ': aws-mcp already configured, skipped') }
        }
    }
    $lines.Add('Installing 12 default AWS skills')
    $Res.StdOut = ($lines -join "`n") + "`n"
    return $Res
}

function Get-FakeCodexMcpGet {
    param($Res)
    $ctx = $script:Ctx
    $text = ''
    if (Test-Path -LiteralPath $ctx.CodexConfig) { $text = (Read-TextFile $ctx.CodexConfig).Text }
    if ($text -notmatch '(?m)^\[mcp_servers\.aws-mcp\]') {
        $Res.ExitCode = 1
        $Res.StdErr = "Error: No MCP server named 'aws-mcp' found."
        return $Res
    }
    $envVal = $null
    $m = [regex]::Match($text, '(?ms)^\[mcp_servers\.aws-mcp\.env\][ \t]*\r?\n(?<body>.*?)(?=^\[|\z)')
    if ($m.Success) {
        $mm = [regex]::Match($m.Groups['body'].Value, '(?m)^AWS_MCP_PROXY_PROFILES\s*=\s*"([^"]*)"')
        if ($mm.Success) { $envVal = $mm.Groups[1].Value }
    }
    $transport = [ordered]@{ type = 'stdio'; command = 'uvx'; args = @('mcp-proxy-for-aws@latest'); env = $null }
    if ($null -ne $envVal) { $transport['env'] = [ordered]@{ AWS_MCP_PROXY_PROFILES = $envVal } }
    $obj = [ordered]@{ name = 'aws-mcp'; enabled = $true; transport = $transport }
    $Res.StdOut = ($obj | ConvertTo-Json -Depth 6)
    return $Res
}

function Get-FakeCodexMcpList {
    param($Res)
    $ctx = $script:Ctx
    $text = ''
    if (Test-Path -LiteralPath $ctx.CodexConfig) { $text = (Read-TextFile $ctx.CodexConfig).Text }
    $rows = New-Object 'System.Collections.Generic.List[string]'
    $rows.Add('Name       Command  Args                       Env  Cwd  Status   Auth')
    foreach ($m in [regex]::Matches($text, '(?m)^\[mcp_servers\.([A-Za-z0-9_-]+)\]')) {
        $rows.Add(($m.Groups[1].Value + '   uvx  mcp-proxy-for-aws@latest  -    -    enabled  Unsupported'))
    }
    foreach ($x in @($script:Fake.CodexExtraServers)) { $rows.Add(([string]$x + '   npx  something  -  -  enabled  Unsupported')) }
    $Res.StdOut = ($rows -join "`n") + "`n"
    return $Res
}

# ---------------- the replaced functions ----------------
function Resolve-Exe {
    param([string]$Name)
    $f = $script:Fake
    switch -CaseSensitive ($Name) {
        'uv'             { if ($f.UvInstalled) { return '/fake/bin/uv' }; return $null }
        'uvx'            { if ($f.UvInstalled -and $f.UvxOnPath) { return '/fake/bin/uvx' }; return $null }
        'codex'          { if ($f.CodexOnPath) { return '/fake/bin/codex' }; return $null }
        'aws'            { if ($f.AwsVersion) { return $f.AwsExe }; return $null }
        'powershell.exe' { return '/fake/bin/powershell.exe' }
        default          { return $null }
    }
}

function Get-AwsExeCandidates {
    $f = $script:Fake
    if ($f.AwsVersion) { return @($f.AwsExe) }
    return @()
}

function Invoke-ProcessCapture {
    param([string]$FilePath, [string[]]$Arguments = @(), [int]$TimeoutSec = 120, [switch]$Heartbeat, [hashtable]$ExtraEnv)
    $f = $script:Fake
    $a = @($Arguments)
    $exe = (Split-Path -Leaf $FilePath).ToLowerInvariant()
    $line = ($exe + ' ' + ($a -join ' ')).Trim()
    $f.Calls.Add($line)
    if ($f.ThrowOn -and $line.Contains($f.ThrowOn)) { throw (New-Object System.IO.IOException('simulated crash inside a helper')) }
    $res = [pscustomobject]@{ ExitCode = 0; StdOut = ''; StdErr = ''; TimedOut = $false; Error = $null }
    if ($exe -eq 'probe-a' -or $exe -eq 'probe-b') {
        $broken = ($f.ProbeMode -eq 'fail') -or ($f.ProbeMode -eq 'first-fails' -and $exe -eq 'probe-a')
        if ($broken) { $res.ExitCode = 1; $res.StdErr = 'simulated probe failure'; return $res }
        $res.StdOut = "selfcheck-ok`r`n"
        return $res
    }
    if ($exe -eq 'uv') {
        if ($a[0] -eq '--version') { $res.StdOut = "uv 0.9.5 (fake build)`n" }
        return $res
    }
    if ($exe -eq 'uvx') {
        $res.ExitCode = $f.PrewarmExit
        if ($f.PrewarmExit -ne 0) { $res.StdErr = 'error: simulated warm-up failure' } else { $res.StdOut = 'usage: mcp-proxy-for-aws [-h] ...' }
        return $res
    }
    if ($exe -eq 'powershell.exe') {
        $cmdText = ($a -join ' ')
        $f.PowerShellCommands.Add($cmdText)
        if ($cmdText.Contains('astral.sh/uv/install.ps1')) { $f.UvInstalled = $true; $res.StdOut = "downloading uv...`ninstalled uv`n" }
        elseif ($cmdText.Contains('awscli-install-')) { $f.AwsVersion = $f.AwsInstallsAs; $res.StdOut = "Installing AWS CLI...`nDone.`n" }
        return $res
    }
    if ($exe -eq 'codex') {
        if ($a[0] -eq 'mcp' -and $a[1] -eq 'list') { return (Get-FakeCodexMcpList $res) }
        if ($a[0] -eq 'mcp' -and $a[1] -eq 'get') { return (Get-FakeCodexMcpGet $res) }
        $res.ExitCode = 2
        $res.StdErr = 'error: unexpected codex call in the test'
        return $res
    }
    if ($exe -eq 'aws') {
        if ($a[0] -eq '--version') { $res.StdOut = 'aws-cli/' + $f.AwsVersion + ' Python/3.13.9 Windows/11 exe/AMD64'; return $res }
        if ($a[0] -eq 'configure' -and $a[1] -eq 'get') {
            if ($f.Config.ContainsKey($a[2])) { $res.StdOut = ([string]$f.Config[$a[2]]) + "`n" } else { $res.ExitCode = 1 }
            return $res
        }
        if ($a[0] -eq 'configure' -and $a[1] -eq 'set') { $f.Config[$a[2]] = $a[3]; return $res }
        if ($a[0] -eq 'configure' -and $a[1] -eq 'agent-toolkit') { return (Invoke-FakeWizard $res $ExtraEnv) }
        if ($a[0] -eq 'sts' -and $a[1] -eq 'get-caller-identity') {
            if (-not $f.LoggedIn) {
                $res.ExitCode = 253
                $res.StdErr = 'Unable to locate credentials. You can configure credentials by running "aws login".'
                return $res
            }
            $obj = [ordered]@{ UserId = 'AIDAFAKEFAKEFAKE'; Account = (Get-FakeAccountOf $f.LoginAs); Arn = $f.LoginAs }
            $res.StdOut = ($obj | ConvertTo-Json)
            return $res
        }
        if ($a[0] -eq 'logout') {
            if ($f.LogoutExit -ne 0) { $res.ExitCode = $f.LogoutExit; $res.StdErr = 'error: simulated logout failure'; return $res }
            if (-not $f.LogoutStillWorks) { $f.LoggedIn = $false; [void]$f.Config.Remove('login_session') }
            return $res
        }
        if ($a[0] -eq 'agent-toolkit' -and $a[1] -eq 'list-available-skills') {
            if (-not $f.SkillsOk) { $res.ExitCode = 254; $res.StdErr = 'An error occurred (ExpiredToken) when calling the ListAvailableSkills operation'; return $res }
            $skills = @('aws-secrets-manager', 'aws-cdk', 'aws-lambda', 'aws-s3', 'aws-iam', 'aws-cost') | ForEach-Object { [ordered]@{ name = $_; description = 'fake skill' } }
            $res.StdOut = ([ordered]@{ skills = @($skills) } | ConvertTo-Json -Depth 5)
            return $res
        }
    }
    $res.ExitCode = 2
    $res.StdErr = 'error: unexpected call in the test: ' + $line
    return $res
}

function Invoke-LiveCommand {
    param([string]$FilePath, [string[]]$Arguments = @(), [hashtable]$ExtraEnv)
    $f = $script:Fake
    $f.Calls.Add('LIVE ' + (Split-Path -Leaf $FilePath).ToLowerInvariant() + ' ' + (@($Arguments) -join ' '))
    if ($ExtraEnv) { foreach ($k in $ExtraEnv.Keys) { $f.LiveEnv.Add([string]$k + '=' + [string]$ExtraEnv[$k]) } }
    $exit = [int]$f.LoginExit
    if (@($f.LoginExits).Count -gt 0) {
        $exit = [int]@($f.LoginExits)[0]
        $f.LoginExits = @(@($f.LoginExits) | Select-Object -Skip 1)
    }
    if ($exit -ne 0) { return $exit }
    $f.LoggedIn = $true
    $f.Config['login_session'] = $f.LoginAs
    return 0
}

function Get-WebFile {
    param([string]$Url, [string]$OutFile)
    $script:Fake.Downloads.Add($Url)
    if ($Url -ceq $script:Cfg.InstallPs1Url) { [System.IO.File]::WriteAllText($OutFile, '# fake AWS installer'); return }
    throw ('unexpected download in the test: ' + $Url)
}

function Get-WebBytes {
    param([string]$Url)
    $f = $script:Fake
    $f.Downloads.Add($Url)
    if ($Url -ceq $script:Cfg.RulesUrl) {
        if ($f.RulesThrow) { throw 'simulated network failure' }
        return , $f.RulesBytes
    }
    throw ('unexpected download in the test: ' + $Url)
}

function Test-TcpPort { param([string]$HostName, [int]$Port = 443, [int]$TimeoutMs = 5000) return $true }

function Test-AwsInstallerSignature {
    param([string]$Path)
    $f = $script:Fake
    if ($f.SigOk) { return [pscustomobject]@{ Ok = $true; Status = 'Valid'; Subject = 'CN="Amazon Web Services, Inc.", O="Amazon Web Services, Inc."' } }
    return [pscustomobject]@{ Ok = $false; Status = 'HashMismatch'; Subject = '' }
}

function Get-RunningAgentApps { return @($script:Fake.Running) }

function Read-Host {
    # A person at the keyboard (only used by -Attended runs): the next prepared answer, or just Enter.
    param([string]$Prompt)
    $f = $script:Fake
    $a = ''
    if ($f -and $f.Answers.Count -gt 0) { $a = $f.Answers.Dequeue() }
    $f.Calls.Add('ASK ' + $Prompt + ' => [' + $a + ']')
    return $a
}

function Update-SessionPath { }

function Get-SelfCheckPrograms {
    # Two pretend small programs for the self-check (the real ones are cmd.exe and powershell.exe).
    $f = $script:Fake
    if ($null -eq $f -or $f.ProbeMode -eq 'none') { return @() }
    return @(
        [pscustomobject]@{ Name = 'probe-a'; File = '/fake/bin/probe-a'; Args = @('echo', 'selfcheck-ok') },
        [pscustomobject]@{ Name = 'probe-b'; File = '/fake/bin/probe-b'; Args = @('echo', 'selfcheck-ok') }
    )
}

# ---------------- scenario helpers ----------------
function New-Scenario {
    # A temporary "home" folder plus a folder for the script's log; $Setup (a scriptblock taking the home path) fills it.
    param([hashtable]$Fake = @{}, [scriptblock]$Setup = $null)
    $h = New-TempDir
    $sd = Join-Path $h '_script'
    [void](New-Item -ItemType Directory -Path $sd -Force)
    $f = New-FakeState
    $f.RulesBytes = (Get-FileBytes $script:FixtureRules)
    foreach ($k in $Fake.Keys) { $f.$k = $Fake[$k] }
    # A folder that stands for "a folder on PATH". It holds codex.cmd when Codex is installed (the real wizard finds "codex" this way).
    $bin = Join-Path $h '_bin'
    [void](New-Item -ItemType Directory -Path $bin -Force)
    if ($f.CodexOnPath) { Save-Text (Join-Path $bin 'codex.cmd') '@echo off' }
    $sc = [pscustomobject]@{ Home = $h; ScriptDir = $sd; Fake = $f; BinDir = $bin }
    if ($Setup) { & $Setup $h }
    return $sc
}

function Remove-Scenario {
    param($Sc)
    if ($Sc -and $Sc.Home) { Remove-Item -LiteralPath $Sc.Home -Recurse -Force -ErrorAction SilentlyContinue }
}

function Invoke-ScenarioRun {
    # Runs the whole script (Invoke-Main) once against the pretend PC and returns what happened.
    param($Sc, [switch]$Loud, [switch]$Attended, [string[]]$Answer = @())
    $f = $Sc.Fake
    $f.Calls.Clear()
    $f.LiveEnv.Clear()
    $f.Downloads.Clear()
    $f.PowerShellCommands.Clear()
    $f.WizardPaths.Clear()
    $script:Fake = $f
    $names = @('USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE', 'UV_INSTALL_DIR')
    $saved = @{}
    foreach ($n in $names) { $saved[$n] = [Environment]::GetEnvironmentVariable($n); [Environment]::SetEnvironmentVariable($n, $null) }
    [Environment]::SetEnvironmentVariable('USERPROFILE', $Sc.Home)
    $script:Quiet = (-not $Loud)
    $oldPath = [Environment]::GetEnvironmentVariable('PATH')
    [Environment]::SetEnvironmentVariable('PATH', $Sc.BinDir + [string][System.IO.Path]::PathSeparator + $oldPath)
    $f.Answers.Clear()
    foreach ($x in $Answer) { $f.Answers.Enqueue($x) }
    $rc = $null
    try {
        if ($Attended) { $rc = @(Invoke-Main -ScriptDir $Sc.ScriptDir)[-1] }
        else { $rc = @(Invoke-Main -ScriptDir $Sc.ScriptDir -NoPause)[-1] }
    }
    finally {
        [Environment]::SetEnvironmentVariable('PATH', $oldPath)
        foreach ($n in $names) { [Environment]::SetEnvironmentVariable($n, $saved[$n]) }
        $script:Quiet = $true
    }
    $ctx = $script:Ctx
    $logText = ''
    if ($ctx.LogPath -and (Test-Path -LiteralPath $ctx.LogPath)) { $logText = [System.IO.File]::ReadAllText($ctx.LogPath) }
    $results = @($ctx.Results | ForEach-Object { '[' + $_.Level + '] ' + $_.Step + ': ' + $_.Text })
    return [pscustomobject]@{
        Rc       = $rc
        Ctx      = $ctx
        Fake     = $f
        Said     = ($ctx.Said -join "`n")
        SaidLines = @($ctx.Said)
        LogText  = $logText
        Calls    = @($f.Calls)
        Results  = ($results -join "`n")
        Home     = $Sc.Home
        ScriptDir = $Sc.ScriptDir
    }
}

function Assert-Call {
    param($Run, [string]$Part)
    $hit = @($Run.Calls | Where-Object { $_.Contains($Part) })
    if ($hit.Count -eq 0) { throw ('expected a call containing [' + $Part + '], calls were: ' + ($Run.Calls -join ' | ')) }
}

function Assert-NoCall {
    param($Run, [string]$Part)
    $hit = @($Run.Calls | Where-Object { $_.Contains($Part) })
    if ($hit.Count -gt 0) { throw ('did not expect a call containing [' + $Part + '], but saw: ' + ($hit -join ' | ')) }
}

function Get-CallIndex {
    param($Run, [string]$Part)
    for ($i = 0; $i -lt $Run.Calls.Count; $i++) { if ($Run.Calls[$i].Contains($Part)) { return $i } }
    return -1
}

function Get-TreeSnapshot {
    # Every file under a folder with its size and content hash (to prove that nothing changed).
    param([string]$Dir, [string[]]$SkipNames = @())
    $lines = New-Object 'System.Collections.Generic.List[string]'
    foreach ($fi in @(Get-ChildItem -LiteralPath $Dir -Recurse -File -Force | Sort-Object FullName)) {
        $skip = $false
        foreach ($s in $SkipNames) { if ($fi.FullName.Contains($s)) { $skip = $true } }
        if ($skip) { continue }
        $lines.Add($fi.FullName.Substring($Dir.Length) + ' ' + (Get-Sha256Hex (Get-FileBytes $fi.FullName)))
    }
    return ($lines -join "`n")
}
