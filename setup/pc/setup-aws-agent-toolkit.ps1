#Requires -Version 5.1
<#
.SYNOPSIS
    Sets up the "Agent Toolkit for AWS" for the AWS profile "otchealth" on this Windows PC.

.DESCRIPTION
    Follows AWS's official setup.md (Steps 1 to 7) in order:
      1  check this PC and make sure "uv" is installed
      2  install the AWS command line tool (AWS CLI v2) if it is missing or too old
      3  sign in to AWS in the browser (profile otchealth, Region us-east-1)
      4  verify who you are signed in as (stops if it is the root user)
      5  run AWS's Agent Toolkit wizard, then point the AWS MCP server at the otchealth profile
      6  check the AWS skill catalog
      7  add AWS's agent rules to the global instructions of Codex (and Claude, if it is present)

    It is safe to run again. Every file it changes is backed up first, and a log file is written
    next to the script. It never asks for or handles AWS keys or passwords.

    Run it by right-clicking the file and choosing "Run with PowerShell", or from a PowerShell window:
        powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\setup-aws-agent-toolkit.ps1
    It needs Windows PowerShell 5.1 (the one built into Windows). In PowerShell 7 it stops with a clear message.

.PARAMETER TestMode
    Loads the functions only and runs nothing (used by the automated tests).

.PARAMETER NoPause
    Does not wait for Enter at the end and does not ask questions (for automated runs).
#>
param(
    [switch]$TestMode,
    [switch]$NoPause
)

# ======================================================================================
# Settings (everything that is decided in advance lives here)
# ======================================================================================
$script:Cfg = @{
    ScriptVersion  = '2026-10-08.1'
    ProfileName    = 'otchealth'
    Region         = 'us-east-1'
    ToolkitRegion  = 'us-east-1'      # setup.md Steps 5 and 6: the toolkit service is us-east-1 only
    AccountId      = '900915535335'
    ExpectedUser   = 'otchealth-ai-reader'
    ExpectedArn    = 'arn:aws:iam::900915535335:user/otchealth-ai-reader'
    MinAwsCli      = '2.35.9'         # first version with "aws configure agent-toolkit --yes"
    ServerName     = 'aws-mcp'
    EnvName        = 'AWS_MCP_PROXY_PROFILES'
    ProxyPackage   = 'mcp-proxy-for-aws'
    McpUrl         = 'https://aws-mcp.us-east-1.api.aws/mcp'
    RulesRepo      = 'https://github.com/aws/agent-toolkit-for-aws'
    RulesCommit    = '188af2f810ce4df1b699cb55dd02f28bfa8eb2c8'
    RulesSha256    = '11b87c6758be781e367dc961f7b3c80a2c2b978d0d9e287c4920741c91069a39'
    RulesUrl       = 'https://raw.githubusercontent.com/aws/agent-toolkit-for-aws/188af2f810ce4df1b699cb55dd02f28bfa8eb2c8/rules/aws-agent-rules.md'
    BeginMarker    = '<!-- BEGIN AWS Agent Toolkit rules -->'
    EndMarker      = '<!-- END AWS Agent Toolkit rules -->'
    PrecedenceNote = "Note: where a project's own instructions conflict with these AWS rules, the project's instructions win."
    InstallPs1Url  = 'https://awscli.amazonaws.com/v2/install.ps1'
    UvInstallUrl   = 'https://astral.sh/uv/install.ps1'
}

$script:TestModeFlag = [bool]$TestMode   # true when the file is only being loaded by the automated tests
$script:Ctx = $null          # filled in by New-SetupContext
$script:Quiet = $false       # tests set this to $true to silence the screen output
$script:NoPauseMode = $false # set from -NoPause

# ======================================================================================
# Small helpers: paths, screen output, results
# ======================================================================================
function Join-Rel {
    # Join a base folder and a relative path written with \ or /, using the native separator.
    param([string]$Base, [string]$Rel)
    $out = $Base
    foreach ($part in ($Rel -split '[\\/]')) {
        if ($part.Length -gt 0) { $out = Join-Path $out $part }
    }
    return $out
}

function Out-Say {
    # All screen output goes through here (tests can silence or capture it).
    param([string]$Text = '', [string]$Kind = 'Info', [switch]$NoNewline)
    if ($script:Ctx -and $null -ne $script:Ctx.Said) { $script:Ctx.Said.Add([string]$Text) }
    if ($script:Quiet) { return }
    $color = 'Gray'
    switch ($Kind) {
        'Good'  { $color = 'Green' }
        'Warn'  { $color = 'Yellow' }
        'Bad'   { $color = 'Red' }
        'Head'  { $color = 'Cyan' }
        'Plain' { $color = 'White' }
    }
    if ($NoNewline) { Write-Host $Text -ForegroundColor $color -NoNewline }
    else { Write-Host $Text -ForegroundColor $color }
}

function Read-Answer {
    # Asks a question on the screen. Returns '' when running unattended.
    param([string]$Prompt)
    if ($script:NoPauseMode) { return '' }
    return [string](Read-Host $Prompt)
}

function Get-Excerpt {
    # Last few non-empty lines of a text block, for short error messages.
    param([string]$Text, [int]$MaxLines = 8)
    if ([string]::IsNullOrEmpty($Text)) { return '' }
    $lines = @($Text -split "\r?\n" | Where-Object { $_.Trim().Length -gt 0 })
    if ($lines.Count -gt $MaxLines) { $lines = @($lines | Select-Object -Last $MaxLines) }
    return ($lines -join [Environment]::NewLine)
}

function Get-ShortText {
    # One line of at most $Max characters (line breaks and runs of spaces become one space), for the closing screen.
    param([string]$Text, [int]$Max = 400)
    $t = ([string]$Text -replace '\s+', ' ').Trim()
    if ($t.Length -le $Max) { return $t }
    return ($t.Substring(0, $Max - 3).TrimEnd() + '...')
}

function Add-Result {
    # Levels: OK (done), NOTE (for information), ACTION (needs a person), FAIL (a step failed).
    param([string]$Level, [string]$Step, [string]$Text)
    $script:Ctx.Results.Add([pscustomobject]@{ Level = $Level; Step = $Step; Text = $Text })
    $kind = 'Info'
    switch ($Level) {
        'OK'     { $kind = 'Good' }
        'ACTION' { $kind = 'Warn' }
        'FAIL'   { $kind = 'Bad' }
    }
    Out-Say ('  [{0}] {1}' -f $Level, $Text) $kind
}

function Add-Manual {
    # A file that still needs a hand edit, with exact instructions.
    param([string]$File, [string]$Why, [string]$Fix)
    $script:Ctx.Manual.Add([pscustomobject]@{ File = $File; Why = $Why; Fix = $Fix })
    Add-Result 'ACTION' 'hand-edit' ("Needs a hand edit: {0} ({1})" -f $File, $Why)
}

function Add-Detail {
    # One line for the "details for the CTO" block at the end (never put secrets here).
    param([string]$Text)
    $script:Ctx.Details.Add([string]$Text)
}

function Stop-Setup {
    # Ends the current step with a plain-English reason.
    param([string]$Text)
    throw (New-Object System.InvalidOperationException($Text))
}

function Show-StepHeader {
    param([int]$Number, [string]$Title)
    Out-Say ''
    Out-Say ('=== Step {0} of 7: {1} ===' -f $Number, $Title) 'Head'
}

# ======================================================================================
# Context: every path and counter the run needs (tests build one over a temporary "home")
# ======================================================================================
function New-SetupContext {
    param(
        [string]$UserHome,
        [string]$ScriptDir,
        [string]$ClaudeConfigDir = '',
        [string]$CodexHome = '',
        [string]$AwsConfigFile = '',
        [string]$AwsCredentialsFile = '',
        [switch]$IsTest
    )
    $claudeDir = Join-Rel $UserHome '.claude'
    $claudeJson = Join-Rel $UserHome '.claude.json'
    if ($ClaudeConfigDir -and (Test-Path -LiteralPath $ClaudeConfigDir -PathType Container)) {
        $claudeDir = $ClaudeConfigDir.TrimEnd('\', '/')
        $claudeJson = Join-Path $claudeDir '.claude.json'
    }
    $codexDir = Join-Rel $UserHome '.codex'
    if ($CodexHome -and (Test-Path -LiteralPath $CodexHome -PathType Container)) {
        $codexDir = $CodexHome.TrimEnd('\', '/')
    }
    $awsDir = Join-Rel $UserHome '.aws'
    $awsConfig = Join-Path $awsDir 'config'
    if ($AwsConfigFile) { $awsConfig = $AwsConfigFile }
    $awsCreds = Join-Path $awsDir 'credentials'
    if ($AwsCredentialsFile) { $awsCreds = $AwsCredentialsFile }

    $agents = @(
        [pscustomobject]@{ Name = 'Claude Code'; Path = $claudeDir },
        [pscustomobject]@{ Name = 'Cline'; Path = (Join-Rel $UserHome '.cline') },
        [pscustomobject]@{ Name = 'Codex'; Path = $codexDir },
        [pscustomobject]@{ Name = 'Cursor'; Path = (Join-Rel $UserHome '.cursor') },
        [pscustomobject]@{ Name = 'Gemini CLI'; Path = (Join-Rel $UserHome '.gemini') },
        [pscustomobject]@{ Name = 'Kiro'; Path = (Join-Rel $UserHome '.kiro') },
        [pscustomobject]@{ Name = 'OpenClaw'; Path = (Join-Rel $UserHome '.openclaw') },
        [pscustomobject]@{ Name = 'OpenCode'; Path = (Join-Rel $UserHome '.config\opencode') },
        [pscustomobject]@{ Name = 'Pi'; Path = (Join-Rel $UserHome '.pi\agent') },
        [pscustomobject]@{ Name = 'Windsurf'; Path = (Join-Rel $UserHome '.codeium\windsurf') }
    )
    # MCP settings files that the wizard writes as JSON (same list and paths as the wizard uses).
    $json = @(
        [pscustomobject]@{ Name = 'Claude Code'; Path = $claudeJson },
        [pscustomobject]@{ Name = 'Cline'; Path = (Join-Rel $UserHome '.cline\mcp.json') },
        [pscustomobject]@{ Name = 'Cursor'; Path = (Join-Rel $UserHome '.cursor\mcp.json') },
        [pscustomobject]@{ Name = 'Gemini CLI'; Path = (Join-Rel $UserHome '.gemini\settings.json') },
        [pscustomobject]@{ Name = 'Kiro'; Path = (Join-Rel $UserHome '.kiro\settings\mcp.json') },
        [pscustomobject]@{ Name = 'Windsurf'; Path = (Join-Rel $UserHome '.codeium\mcp_config.json') }
    )
    $ctx = [pscustomobject]@{
        IsTest        = [bool]$IsTest
        UserHome      = $UserHome
        ScriptDir     = $ScriptDir
        Stamp         = (Get-Date -Format 'yyyyMMdd-HHmmss')
        LogPath       = ''
        AwsDir        = $awsDir
        AwsConfig     = $awsConfig
        AwsCreds      = $awsCreds
        ClaudeDir     = $claudeDir
        ClaudeJson    = $claudeJson
        ClaudeMd      = (Join-Path $claudeDir 'CLAUDE.md')
        CodexDir      = $codexDir
        CodexConfig   = (Join-Path $codexDir 'config.toml')
        CodexAgents   = (Join-Path $codexDir 'AGENTS.md')
        CodexOverride = (Join-Path $codexDir 'AGENTS.override.md')
        AgentFolders  = $agents
        JsonTargets   = $json
        OpenCodeDir   = (Join-Rel $UserHome '.config\opencode')
        OpenCodeJson  = (Join-Rel $UserHome '.config\opencode\opencode.json')
        Results       = (New-Object 'System.Collections.Generic.List[object]')
        Manual        = (New-Object 'System.Collections.Generic.List[object]')
        Backups       = (New-Object 'System.Collections.Generic.List[string]')
        Details       = (New-Object 'System.Collections.Generic.List[string]')
        Said          = (New-Object 'System.Collections.Generic.List[string]')
        Fatal         = $false
        FatalText     = ''
        AwsExe        = $null
        AwsVersion    = ''
        UvExe         = $null
        CodexExe      = $null
        Identity      = $null
        CodexPatched  = $false
        RulesApplied  = $false
        UvJustInstalled = $false
        EngineProblems = @{}      # building blocks that failed their self-check on this PC: name -> problem text
        CodexHidden   = $false    # true when "codex" was hidden from the AWS wizard's PATH
    }
    return $ctx
}

# ======================================================================================
# Running other programs and talking to the network. These are the only places that do it,
# so the automated tests can replace them with fakes.
# ======================================================================================
function Resolve-Exe {
    # Full path of a program on PATH (an .exe or .cmd), or $null.
    param([string]$Name)
    $cmd = Get-Command -Name $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return [string]$cmd.Source }
    return $null
}

function ConvertTo-CmdArg {
    # Quotes one argument the way Windows programs expect on a command line.
    param([string]$Arg)
    if ($null -eq $Arg -or $Arg.Length -eq 0) { return '""' }
    if ($Arg -notmatch '[\s"]') { return $Arg }
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('"')
    $backslashes = 0
    foreach ($ch in $Arg.ToCharArray()) {
        if ($ch -eq [char]92) { $backslashes++; continue }
        if ($ch -eq [char]34) {
            [void]$sb.Append([string]('\' * ($backslashes * 2 + 1)))
            [void]$sb.Append('"')
            $backslashes = 0
            continue
        }
        if ($backslashes -gt 0) { [void]$sb.Append([string]('\' * $backslashes)); $backslashes = 0 }
        [void]$sb.Append($ch)
    }
    if ($backslashes -gt 0) { [void]$sb.Append([string]('\' * ($backslashes * 2))) }
    [void]$sb.Append('"')
    return $sb.ToString()
}

function ConvertTo-CmdLine {
    param([string[]]$Arguments)
    if (-not $Arguments -or $Arguments.Count -eq 0) { return '' }
    $parts = New-Object 'System.Collections.Generic.List[string]'
    foreach ($a in $Arguments) { $parts.Add((ConvertTo-CmdArg $a)) }
    return ($parts -join ' ')
}

function Get-TaskText {
    param($Task, [int]$WaitMs = 15000)
    try {
        if ($Task.Wait($WaitMs)) { return [string]$Task.Result }
    }
    catch { }
    return ''
}

function Set-ChildEnv {
    # Puts safe defaults and any extra variables into a child process's environment.
    param($StartInfo, [hashtable]$ExtraEnv)
    $StartInfo.EnvironmentVariables['PYTHONIOENCODING'] = 'utf-8'
    $StartInfo.EnvironmentVariables['AWS_PAGER'] = ''
    $StartInfo.EnvironmentVariables['AWS_CLI_AUTO_PROMPT'] = 'off'
    if ($ExtraEnv) {
        foreach ($k in $ExtraEnv.Keys) { $StartInfo.EnvironmentVariables[[string]$k] = [string]$ExtraEnv[$k] }
    }
}

function Invoke-ProcessCapture {
    # Runs a program, captures its output, never lets it wait for typing, and enforces a time limit.
    # Returns an object: ExitCode, StdOut, StdErr, TimedOut, Error.
    param(
        [string]$FilePath,
        [string[]]$Arguments = @(),
        [int]$TimeoutSec = 120,
        [switch]$Heartbeat,
        [hashtable]$ExtraEnv
    )
    $res = [pscustomobject]@{ ExitCode = $null; StdOut = ''; StdErr = ''; TimedOut = $false; Error = $null }
    $p = $null
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $FilePath
        $psi.Arguments = (ConvertTo-CmdLine $Arguments)
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.RedirectStandardInput = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        $psi.StandardOutputEncoding = $utf8
        $psi.StandardErrorEncoding = $utf8
        Set-ChildEnv $psi $ExtraEnv
        $p = New-Object System.Diagnostics.Process
        $p.StartInfo = $psi
        [void]$p.Start()
        $outTask = $p.StandardOutput.ReadToEndAsync()
        $errTask = $p.StandardError.ReadToEndAsync()
        try { $p.StandardInput.Close() } catch { }
        $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSec)
        $lastBeat = [DateTime]::UtcNow
        $beats = 0
        while (-not $p.WaitForExit(2000)) {
            if ($Heartbeat -and (([DateTime]::UtcNow - $lastBeat).TotalSeconds -ge 5)) {
                Out-Say '.' 'Info' -NoNewline
                $beats++
                $lastBeat = [DateTime]::UtcNow
            }
            if ([DateTime]::UtcNow -gt $deadline) {
                $res.TimedOut = $true
                try { $p.Kill() } catch { }
                break
            }
        }
        if ($beats -gt 0) { Out-Say '' }
        try { [void]$p.WaitForExit(5000) } catch { }
        $res.StdOut = (Get-TaskText $outTask)
        $res.StdErr = (Get-TaskText $errTask)
        if (-not $res.TimedOut) { $res.ExitCode = [int]$p.ExitCode }
    }
    catch {
        $res.Error = $_.Exception.Message
    }
    finally {
        if ($p) { try { $p.Dispose() } catch { } }
    }
    return $res
}

function Invoke-LiveCommand {
    # Runs a program attached to this window (so a person can interact with it). Returns the exit code.
    # Used only for "aws login", which needs the browser flow and may ask a question.
    param([string]$FilePath, [string[]]$Arguments = @(), [hashtable]$ExtraEnv)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FilePath
    $psi.Arguments = (ConvertTo-CmdLine $Arguments)
    $psi.UseShellExecute = $false
    Set-ChildEnv $psi $ExtraEnv
    $p = [System.Diagnostics.Process]::Start($psi)
    $p.WaitForExit()
    $code = [int]$p.ExitCode
    $p.Dispose()
    return $code
}

function Get-WebFile {
    # Downloads a URL to a file. Throws when it fails.
    param([string]$Url, [string]$OutFile)
    Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing -ErrorAction Stop | Out-Null
}

function Get-WebBytes {
    # Downloads a URL and returns the raw bytes. Throws when it fails.
    param([string]$Url)
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('aws-toolkit-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        Get-WebFile $Url $tmp
        $bytes = [System.IO.File]::ReadAllBytes($tmp)
        return , $bytes
    }
    finally {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }
}

function Test-TcpPort {
    param([string]$HostName, [int]$Port = 443, [int]$TimeoutMs = 5000)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $client.BeginConnect($HostName, $Port, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) { return $false }
        try { $client.EndConnect($iar) } catch { return $false }
        return [bool]$client.Connected
    }
    catch { return $false }
    finally { $client.Close() }
}

function Test-AwsInstallerSignature {
    # Checks that a downloaded install.ps1 carries a valid AWS code signature.
    param([string]$Path)
    $sig = Get-AuthenticodeSignature -FilePath $Path
    $subject = ''
    if ($sig.SignerCertificate) { $subject = [string]$sig.SignerCertificate.Subject }
    $ok = (([string]$sig.Status -eq 'Valid') -and ($subject -match 'Amazon Web Services, Inc\.'))
    return [pscustomobject]@{ Ok = $ok; Status = [string]$sig.Status; Subject = $subject }
}

function Get-RunningAgentApps {
    $names = New-Object 'System.Collections.Generic.List[string]'
    foreach ($proc in @(Get-Process -ErrorAction SilentlyContinue)) {
        if ($proc.ProcessName -match '^(codex|claude|chatgpt|cursor|windsurf|kiro|opencode)') { $names.Add([string]$proc.ProcessName) }
    }
    return @($names | Sort-Object -Unique)
}

function Update-SessionPath {
    # Re-reads PATH from Windows (so a program installed a moment ago is found), keeping its order.
    $seen = @{}
    $parts = New-Object 'System.Collections.Generic.List[string]'
    $sources = @(
        [Environment]::GetEnvironmentVariable('Path', 'Machine'),
        [Environment]::GetEnvironmentVariable('Path', 'User'),
        $env:Path
    )
    foreach ($src in $sources) {
        if (-not $src) { continue }
        foreach ($piece in ($src -split ';')) {
            $t = $piece.Trim()
            if ($t.Length -eq 0) { continue }
            $key = $t.TrimEnd('\').ToLowerInvariant()
            if ($seen.ContainsKey($key)) { continue }
            $seen[$key] = $true
            $parts.Add($t)
        }
    }
    $env:Path = ($parts -join ';')
}

function Add-PathFirst {
    # Puts a folder at the front of PATH for this run only.
    param([string]$Dir)
    if (-not $Dir) { return }
    $sep = [string][System.IO.Path]::PathSeparator
    $env:Path = $Dir + $sep + $env:Path
}

function Get-PathWithoutProgram {
    # PATH text with every folder taken out that holds a program called $Name (name.exe, name.cmd and so on), so that
    # a child process started with this PATH cannot find the program. Returns Path (the new text) and Removed (the folders).
    param([string]$Name, [string]$PathValue)
    $res = [pscustomobject]@{ Path = [string]$PathValue; Removed = @() }
    if ([string]::IsNullOrEmpty($PathValue)) { return $res }
    $sep = [System.IO.Path]::PathSeparator
    $keep = New-Object 'System.Collections.Generic.List[string]'
    $removed = New-Object 'System.Collections.Generic.List[string]'
    $endings = @('', '.exe', '.cmd', '.bat', '.com', '.ps1')
    foreach ($piece in ($PathValue -split [regex]::Escape([string]$sep))) {
        $dir = $piece.Trim().Trim('"')
        $has = $false
        if ($dir.Length -gt 0) {
            try {
                $real = [Environment]::ExpandEnvironmentVariables($dir)
                foreach ($e in $endings) {
                    if (Test-Path -LiteralPath (Join-Path $real ($Name + $e)) -PathType Leaf) { $has = $true; break }
                }
            }
            catch { $has = $false }
        }
        if ($has) { $removed.Add($dir) } else { $keep.Add($piece) }
    }
    $res.Path = ($keep.ToArray() -join [string]$sep)
    $res.Removed = $removed.ToArray()
    return $res
}

# ======================================================================================
# Files: strict UTF-8 reading, writing without a BOM, backups, hashes, line endings
# ======================================================================================
function Get-Sha256Hex {
    param([byte[]]$Bytes)
    $h = [System.Security.Cryptography.SHA256]::Create()
    try { $hash = $h.ComputeHash($Bytes) }
    finally { $h.Dispose() }
    $sb = New-Object System.Text.StringBuilder
    foreach ($b in $hash) { [void]$sb.Append($b.ToString('x2')) }
    return $sb.ToString()
}

function Read-TextFile {
    # Reads a text file as strict UTF-8. Ok=$false (with Error) means "do not touch this file".
    param([string]$Path)
    $r = [pscustomobject]@{ Ok = $false; Exists = $false; Text = ''; HasBom = $false; Error = $null }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { $r.Ok = $true; return $r }
    $r.Exists = $true
    try { $bytes = [System.IO.File]::ReadAllBytes($Path) }
    catch { $r.Error = 'cannot be read: ' + $_.Exception.Message; return $r }
    $start = 0
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) {
        $r.HasBom = $true
        $start = 3
    }
    elseif ($bytes.Length -ge 2 -and (($bytes[0] -eq 255 -and $bytes[1] -eq 254) -or ($bytes[0] -eq 254 -and $bytes[1] -eq 255))) {
        $r.Error = 'is saved as UTF-16, not UTF-8'
        return $r
    }
    if ([Array]::IndexOf($bytes, [byte]0) -ge 0) { $r.Error = 'contains binary data'; return $r }
    try {
        $enc = New-Object System.Text.UTF8Encoding($false, $true)
        $r.Text = $enc.GetString($bytes, $start, $bytes.Length - $start)
    }
    catch { $r.Error = 'is not valid UTF-8 text'; return $r }
    $r.Ok = $true
    return $r
}

function Write-TextFile {
    # Writes text as UTF-8 WITHOUT a BOM (adds one only when asked), creating the folder if needed.
    param([string]$Path, [string]$Text, [bool]$Bom = $false)
    $enc = New-Object System.Text.UTF8Encoding($false)
    $body = $enc.GetBytes($Text)
    if ($Bom) { $bytes = [byte[]](@(239, 187, 191) + $body) } else { $bytes = $body }
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { [void](New-Item -ItemType Directory -Path $dir -Force) }
    [System.IO.File]::WriteAllBytes($Path, $bytes)
}

function New-BackupCopy {
    # Copies a file to "<name>.<tag>-<timestamp>" next to it. Returns the backup path.
    param([string]$Path, [string]$Tag = 'bak')
    $target = '{0}.{1}-{2}' -f $Path, $Tag, $script:Ctx.Stamp
    $n = 1
    while (Test-Path -LiteralPath $target) { $n++; $target = '{0}.{1}-{2}-{3}' -f $Path, $Tag, $script:Ctx.Stamp, $n }
    Copy-Item -LiteralPath $Path -Destination $target -Force -ErrorAction Stop
    $script:Ctx.Backups.Add($target)
    return $target
}

function Get-DominantNewline {
    # The line ending a text file mostly uses (LF for an empty file).
    param([string]$Text)
    if ([string]::IsNullOrEmpty($Text)) { return "`n" }
    $crlf = ([regex]::Matches($Text, "`r`n")).Count
    $lf = ([regex]::Matches($Text, "(?<!`r)`n")).Count
    if ($crlf -gt 0 -and $crlf -ge $lf) { return "`r`n" }
    return "`n"
}

function Add-LogText {
    # Appends text to the end of the log file (after the transcript has ended), in the encoding the file already has.
    # Returns $true when it worked.
    param([string]$Path, [string]$Text)
    try {
        $enc = New-Object System.Text.UTF8Encoding($false)
        $head = New-Object byte[] 3
        $n = 0
        $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try { $n = $fs.Read($head, 0, 3) }
        finally { $fs.Dispose() }
        if ($n -ge 2 -and $head[0] -eq 255 -and $head[1] -eq 254) { $enc = [System.Text.Encoding]::Unicode }
        elseif ($n -ge 2 -and $head[0] -eq 254 -and $head[1] -eq 255) { $enc = [System.Text.Encoding]::BigEndianUnicode }
        [System.IO.File]::AppendAllText($Path, $Text, $enc)
        return $true
    }
    catch { return $false }
}

# ======================================================================================
# Codex settings file (config.toml): a careful reader and an insert-only editor.
#
# Codex keeps its MCP servers in %USERPROFILE%\.codex\config.toml as
#     [mcp_servers.aws-mcp]
#     command = "uvx"
#     args = [ ... ]
# and a per-server environment as a sub-table
#     [mcp_servers.aws-mcp.env]
#     AWS_MCP_PROXY_PROFILES = "otchealth"
# (documented at https://developers.openai.com/codex/mcp, key "env"; this is also exactly what
# "codex mcp add --env KEY=VALUE" writes). We only ever INSERT that sub-table. Nothing else in
# the file is rewritten, and the result is verified before it is kept.
# ======================================================================================
function New-TomlReader {
    param([string]$Text)
    return [pscustomobject]@{ T = $Text; P = 0; N = $Text.Length; Err = $null }
}

function Set-TomlError {
    param($R, [string]$Msg)
    if (-not $R.Err) {
        $upto = [Math]::Min($R.P, $R.N)
        $line = 1
        for ($i = 0; $i -lt $upto; $i++) { if ([int]$R.T[$i] -eq 10) { $line++ } }
        $R.Err = ('{0} (line {1})' -f $Msg, $line)
    }
    return $false
}

function Skip-TomlSpace {
    param($R)
    while ($R.P -lt $R.N) {
        $c = [int]$R.T[$R.P]
        if ($c -eq 32 -or $c -eq 9) { $R.P++ } else { break }
    }
}

function Skip-TomlBlank {
    # spaces, tabs, line breaks and comments
    param($R)
    while ($R.P -lt $R.N) {
        $c = [int]$R.T[$R.P]
        if ($c -eq 32 -or $c -eq 9 -or $c -eq 10 -or $c -eq 13) { $R.P++ }
        elseif ($c -eq 35) {
            $nl = $R.T.IndexOf([char]10, $R.P)
            if ($nl -lt 0) { $R.P = $R.N } else { $R.P = $nl }
        }
        else { break }
    }
}

function Read-TomlBasicString {
    # P is on the opening double quote. Returns the unescaped text, or $null when the string is bad.
    param($R)
    $sb = New-Object System.Text.StringBuilder
    $R.P++
    while ($R.P -lt $R.N) {
        $c = $R.T[$R.P]
        $ci = [int]$c
        if ($ci -eq 34) { $R.P++; return $sb.ToString() }
        if ($ci -eq 10) { [void](Set-TomlError $R 'a string is not closed'); return $null }
        if ($ci -eq 92) {
            if ($R.P + 1 -ge $R.N) { break }
            $e = [string]$R.T[$R.P + 1]
            $adv = 2
            switch -CaseSensitive ($e) {
                'n' { [void]$sb.Append([char]10) }
                't' { [void]$sb.Append([char]9) }
                'r' { [void]$sb.Append([char]13) }
                'b' { [void]$sb.Append([char]8) }
                'f' { [void]$sb.Append([char]12) }
                '"' { [void]$sb.Append('"') }
                '\' { [void]$sb.Append('\') }
                'u' {
                    if ($R.P + 6 -gt $R.N) { [void](Set-TomlError $R 'a bad escape in a string'); return $null }
                    $hex = $R.T.Substring($R.P + 2, 4)
                    if ($hex -notmatch '^[0-9A-Fa-f]{4}$') { [void](Set-TomlError $R 'a bad escape in a string'); return $null }
                    [void]$sb.Append([char][Convert]::ToInt32($hex, 16))
                    $adv = 6
                }
                'U' {
                    if ($R.P + 10 -gt $R.N) { [void](Set-TomlError $R 'a bad escape in a string'); return $null }
                    $hex = $R.T.Substring($R.P + 2, 8)
                    if ($hex -notmatch '^[0-9A-Fa-f]{8}$') { [void](Set-TomlError $R 'a bad escape in a string'); return $null }
                    try { [void]$sb.Append([char]::ConvertFromUtf32([Convert]::ToInt32($hex, 16))) }
                    catch { [void](Set-TomlError $R 'a bad escape in a string'); return $null }
                    $adv = 10
                }
                default { [void](Set-TomlError $R 'a bad escape in a string'); return $null }
            }
            $R.P += $adv
            continue
        }
        [void]$sb.Append($c)
        $R.P++
    }
    [void](Set-TomlError $R 'a string is not closed')
    return $null
}

function Read-TomlLiteralString {
    # P is on the opening single quote.
    param($R)
    $end = $R.T.IndexOf([char]39, $R.P + 1)
    $nl = $R.T.IndexOf([char]10, $R.P + 1)
    if ($end -lt 0 -or ($nl -ge 0 -and $nl -lt $end)) { [void](Set-TomlError $R 'a string is not closed'); return $null }
    $s = $R.T.Substring($R.P + 1, $end - $R.P - 1)
    $R.P = $end + 1
    return $s
}

function Skip-TomlMultiline {
    # P is on the first of three quote characters of a multi-line string.
    param($R, [int]$QuoteCode)
    $i = $R.P + 3
    while ($i -lt $R.N) {
        $ci = [int]$R.T[$i]
        if ($QuoteCode -eq 34 -and $ci -eq 92) { $i += 2; continue }
        if ($ci -eq $QuoteCode -and ($i + 3) -le $R.N -and [int]$R.T[$i + 1] -eq $QuoteCode -and [int]$R.T[$i + 2] -eq $QuoteCode) {
            $i += 3
            $extra = 0
            while ($extra -lt 2 -and $i -lt $R.N -and [int]$R.T[$i] -eq $QuoteCode) { $i++; $extra++ }
            $R.P = $i
            return $true
        }
        $i++
    }
    $R.P = $R.N
    return (Set-TomlError $R 'a multi-line string is not closed')
}

function Read-TomlKey {
    # Reads a (dotted) key such as  a.b."c d"  and returns its parts as a string array, or $null.
    param($R)
    $parts = New-Object 'System.Collections.Generic.List[string]'
    while ($true) {
        Skip-TomlSpace $R
        if ($R.P -ge $R.N) { [void](Set-TomlError $R 'a key was expected'); return $null }
        $ci = [int]$R.T[$R.P]
        if ($ci -eq 34) {
            $k = Read-TomlBasicString $R
            if ($null -eq $k) { return $null }
        }
        elseif ($ci -eq 39) {
            $k = Read-TomlLiteralString $R
            if ($null -eq $k) { return $null }
        }
        else {
            $start = $R.P
            while ($R.P -lt $R.N) {
                $cc = [int]$R.T[$R.P]
                if (($cc -ge 48 -and $cc -le 57) -or ($cc -ge 65 -and $cc -le 90) -or ($cc -ge 97 -and $cc -le 122) -or $cc -eq 95 -or $cc -eq 45) { $R.P++ } else { break }
            }
            if ($R.P -eq $start) { [void](Set-TomlError $R 'a key was expected'); return $null }
            $k = $R.T.Substring($start, $R.P - $start)
        }
        $parts.Add([string]$k)
        Skip-TomlSpace $R
        if ($R.P -lt $R.N -and [int]$R.T[$R.P] -eq 46) { $R.P++; continue }
        break
    }
    return , $parts.ToArray()
}

function Skip-TomlValue {
    # Moves P past one value (string, number, array, inline table ...). Returns $false on a syntax problem.
    param($R, [int]$Depth = 0)
    if ($Depth -gt 40) { return (Set-TomlError $R 'values are nested too deeply') }
    if ($R.P -ge $R.N) { return (Set-TomlError $R 'a value was expected') }
    $ci = [int]$R.T[$R.P]
    if ($ci -eq 34 -or $ci -eq 39) {
        if (($R.P + 3) -le $R.N -and [int]$R.T[$R.P + 1] -eq $ci -and [int]$R.T[$R.P + 2] -eq $ci) {
            return (Skip-TomlMultiline $R $ci)
        }
        if ($ci -eq 34) { $s = Read-TomlBasicString $R } else { $s = Read-TomlLiteralString $R }
        return ($null -ne $s)
    }
    if ($ci -eq 91) {
        $R.P++
        while ($true) {
            Skip-TomlBlank $R
            if ($R.P -ge $R.N) { return (Set-TomlError $R 'an array is not closed') }
            if ([int]$R.T[$R.P] -eq 93) { $R.P++; return $true }
            if (-not (Skip-TomlValue $R ($Depth + 1))) { return $false }
            Skip-TomlBlank $R
            if ($R.P -ge $R.N) { return (Set-TomlError $R 'an array is not closed') }
            $d = [int]$R.T[$R.P]
            if ($d -eq 44) { $R.P++; continue }
            if ($d -eq 93) { $R.P++; return $true }
            return (Set-TomlError $R 'unexpected text inside an array')
        }
    }
    if ($ci -eq 123) {
        $R.P++
        while ($true) {
            Skip-TomlBlank $R
            if ($R.P -ge $R.N) { return (Set-TomlError $R 'an inline table is not closed') }
            if ([int]$R.T[$R.P] -eq 125) { $R.P++; return $true }
            $k = Read-TomlKey $R
            if ($null -eq $k) { return $false }
            Skip-TomlSpace $R
            if ($R.P -ge $R.N -or [int]$R.T[$R.P] -ne 61) { return (Set-TomlError $R 'an equals sign was expected') }
            $R.P++
            Skip-TomlSpace $R
            if (-not (Skip-TomlValue $R ($Depth + 1))) { return $false }
            Skip-TomlBlank $R
            if ($R.P -ge $R.N) { return (Set-TomlError $R 'an inline table is not closed') }
            $d = [int]$R.T[$R.P]
            if ($d -eq 44) { $R.P++; continue }
            if ($d -eq 125) { $R.P++; return $true }
            return (Set-TomlError $R 'unexpected text inside an inline table')
        }
    }
    $start = $R.P
    while ($R.P -lt $R.N) {
        $cc = [int]$R.T[$R.P]
        if ($cc -eq 32 -or $cc -eq 9 -or $cc -eq 10 -or $cc -eq 13 -or $cc -eq 44 -or $cc -eq 93 -or $cc -eq 125 -or $cc -eq 35) { break }
        $R.P++
    }
    if ($R.P -eq $start) { return (Set-TomlError $R 'a value was expected') }
    return $true
}

function Test-TomlLineTail {
    # After a header or a value only spaces and a comment may follow on the same line.
    param($R)
    Skip-TomlSpace $R
    if ($R.P -ge $R.N) { return $true }
    $c = [int]$R.T[$R.P]
    if ($c -eq 10 -or $c -eq 13) { return $true }
    if ($c -eq 35) {
        $nl = $R.T.IndexOf([char]10, $R.P)
        if ($nl -lt 0) { $R.P = $R.N } else { $R.P = $nl }
        return $true
    }
    return (Set-TomlError $R 'unexpected text after a value')
}

function Get-LineContentEnd {
    # Index just after the last visible character of the line that contains position $Pos.
    param([string]$Text, [int]$Pos)
    $nl = $Text.IndexOf([char]10, $Pos)
    if ($nl -lt 0) { return $Text.Length }
    if ($nl -gt 0 -and [int]$Text[$nl - 1] -eq 13) { return ($nl - 1) }
    return $nl
}

function Read-TomlStructure {
    # Lists every table header and key/value line of a TOML text with exact positions.
    # Ok=$false means the text is not something we can edit safely.
    param([string]$Text)
    $R = New-TomlReader $Text
    $items = New-Object 'System.Collections.Generic.List[object]'
    $out = [pscustomobject]@{ Ok = $false; Error = $null; Items = $items }
    while ($true) {
        Skip-TomlBlank $R
        if ($R.P -ge $R.N) { break }
        $start = $R.P
        if ([int]$R.T[$R.P] -eq 91) {
            $isArr = ($R.P + 1 -lt $R.N -and [int]$R.T[$R.P + 1] -eq 91)
            if ($isArr) { $R.P += 2 } else { $R.P += 1 }
            $path = Read-TomlKey $R
            if ($null -eq $path) { $out.Error = $R.Err; return $out }
            Skip-TomlSpace $R
            $need = 1
            if ($isArr) { $need = 2 }
            for ($k = 0; $k -lt $need; $k++) {
                if ($R.P -lt $R.N -and [int]$R.T[$R.P] -eq 93) { $R.P++ }
                else { [void](Set-TomlError $R 'a table header is not closed'); $out.Error = $R.Err; return $out }
            }
            $end = $R.P
            if (-not (Test-TomlLineTail $R)) { $out.Error = $R.Err; return $out }
            $kind = 'table'
            if ($isArr) { $kind = 'array' }
            $items.Add([pscustomobject]@{ Kind = $kind; Path = $path; Start = $start; End = $end; LineEnd = (Get-LineContentEnd $Text $end); ValueText = '' })
        }
        else {
            $path = Read-TomlKey $R
            if ($null -eq $path) { $out.Error = $R.Err; return $out }
            Skip-TomlSpace $R
            if ($R.P -ge $R.N -or [int]$R.T[$R.P] -ne 61) {
                [void](Set-TomlError $R 'an equals sign was expected')
                $out.Error = $R.Err
                return $out
            }
            $R.P++
            Skip-TomlSpace $R
            $vs = $R.P
            if (-not (Skip-TomlValue $R)) { $out.Error = $R.Err; return $out }
            $end = $R.P
            if (-not (Test-TomlLineTail $R)) { $out.Error = $R.Err; return $out }
            $items.Add([pscustomobject]@{ Kind = 'kv'; Path = $path; Start = $start; End = $end; LineEnd = (Get-LineContentEnd $Text $end); ValueText = $Text.Substring($vs, $end - $vs) })
        }
    }
    $out.Ok = $true
    return $out
}

function Test-PathEq {
    param([string[]]$A, [string[]]$B)
    if ($A.Count -ne $B.Count) { return $false }
    for ($i = 0; $i -lt $A.Count; $i++) { if ($A[$i] -cne $B[$i]) { return $false } }
    return $true
}

function Test-PathPrefix {
    # $true when $Path starts with all the parts of $Prefix.
    param([string[]]$Path, [string[]]$Prefix)
    if ($Path.Count -lt $Prefix.Count) { return $false }
    for ($i = 0; $i -lt $Prefix.Count; $i++) { if ($Path[$i] -cne $Prefix[$i]) { return $false } }
    return $true
}

function Get-TomlStringValue {
    # "abc" or 'abc' (raw value text) -> abc. Returns $null for anything else.
    param([string]$Raw)
    $t = $Raw.Trim()
    if ($t.Length -ge 2) {
        $q = $t[0]
        if (($q -eq [char]34 -or $q -eq [char]39) -and $t[$t.Length - 1] -eq $q -and -not $t.StartsWith(($t.Substring(0, 1) * 3), [StringComparison]::Ordinal)) {
            return $t.Substring(1, $t.Length - 2)
        }
    }
    return $null
}

function Get-TomlServerInfo {
    # Looks at the [mcp_servers.<Server>] entry of a config.toml text.
    # State: NotFound | Ready (can add the env sub-table) | AlreadyOk | Refused (do not edit; see Reason)
    param(
        [string]$Text,
        [string]$Server = 'aws-mcp',
        [string]$EnvName = 'AWS_MCP_PROXY_PROFILES',
        [string]$ProfileName = 'otchealth',
        [string]$ProxyPackage = 'mcp-proxy-for-aws'
    )
#@@W3-CHUNK-CONTINUES@@