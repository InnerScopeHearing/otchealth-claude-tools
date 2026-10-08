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
    $info = [pscustomobject]@{
        State = 'NotFound'; Reason = ''; InsertAt = -1; Nl = (Get-DominantNewline $Text)
        Looks = $false; Keys = @(); HasEnv = $false; OtherEnv = $false; Command = ''; Args = ''; MainCount = 0
    }
    if ($Text.Length -gt 1000000) {
        # A real Codex settings file is a few KB. Anything this big is not something to edit automatically.
        $info.State = 'Refused'
        $info.Reason = 'the file could not be read safely: it is unusually large (over 1 MB)'
        return $info
    }
    $st = Read-TomlStructure $Text
    if (-not $st.Ok) {
        $info.State = 'Refused'
        $info.Reason = 'the file could not be read safely: ' + $st.Error
        return $info
    }
    $root = @('mcp_servers', $Server)
    $envPath = @('mcp_servers', $Server, 'env')
    $cur = @()
    $curIsArray = $false
    $mainCount = 0
    $lastMain = $null
    $keys = New-Object 'System.Collections.Generic.List[string]'
    $envHeaders = 0
    $subHeaders = 0
    $weird = $false
    $command = ''
    $argsRaw = ''
    $envVarRaw = $null
    $inlineEnvRaw = $null
    $dottedEnvRaw = $null
    $dottedEnv = $false
    $otherEnv = $false
    foreach ($it in $st.Items) {
        if ($it.Kind -eq 'table' -or $it.Kind -eq 'array') {
            $cur = @($it.Path)
            $curIsArray = ($it.Kind -eq 'array')
            if (Test-PathEq $cur $root) {
                if ($curIsArray) { $weird = $true } else { $mainCount++; $lastMain = $it }
            }
            elseif (Test-PathEq $cur $envPath) {
                if ($curIsArray) { $weird = $true } else { $envHeaders++ }
            }
            elseif (Test-PathPrefix $cur $root) {
                $subHeaders++
                if ($curIsArray) { $weird = $true }
            }
            continue
        }
        if ((Test-PathEq $cur $root) -and -not $curIsArray) {
            $k0 = [string]$it.Path[0]
            $keys.Add($k0)
            $lastMain = $it
            if ($k0 -ceq 'command' -and $it.Path.Count -eq 1) { $command = $it.ValueText }
            if ($k0 -ceq 'args' -and $it.Path.Count -eq 1) { $argsRaw = $it.ValueText }
            if ($k0 -ceq 'env') {
                if ($it.Path.Count -eq 1) { $inlineEnvRaw = $it.ValueText }
                else {
                    $dottedEnv = $true
                    if ($it.Path.Count -eq 2 -and $it.Path[1] -ceq $EnvName) { $dottedEnvRaw = $it.ValueText }
                    else { $otherEnv = $true }
                }
            }
        }
        elseif ((Test-PathEq $cur $envPath) -and -not $curIsArray) {
            if ($it.Path.Count -eq 1 -and $it.Path[0] -ceq $EnvName) { $envVarRaw = $it.ValueText }
            else { $otherEnv = $true }
        }
        elseif (-not (Test-PathPrefix $cur $root)) {
            $full = @($cur) + @($it.Path)
            if (Test-PathPrefix $full $root) { $weird = $true }
        }
    }
    $info.MainCount = $mainCount
    if ($weird) {
        $info.State = 'Refused'
        $info.Reason = 'the aws-mcp entry is written in an unusual way (inline table, dotted keys or an array of tables)'
        return $info
    }
    if ($mainCount -gt 1) {
        $info.State = 'Refused'
        $info.Reason = 'there is more than one [mcp_servers.aws-mcp] section'
        return $info
    }
    if ($mainCount -eq 0) {
        if ($envHeaders -gt 0 -or $subHeaders -gt 0) {
            $info.State = 'Refused'
            $info.Reason = 'the file has settings for aws-mcp but no [mcp_servers.aws-mcp] section'
        }
        return $info
    }
    if ($envHeaders -gt 1) {
        $info.State = 'Refused'
        $info.Reason = 'there is more than one [mcp_servers.aws-mcp.env] section'
        return $info
    }
    $info.Keys = @($keys | Sort-Object -Unique)
    $info.Command = $command
    $info.Args = $argsRaw
    $extra = @($info.Keys | Where-Object { $_ -cne 'command' -and $_ -cne 'args' -and $_ -cne 'env' })
    $cmdValue = Get-TomlStringValue $command
    if ($null -ne $inlineEnvRaw) {
        $stripped = [regex]::Replace($inlineEnvRaw, '(?:^|[{,\s])' + [regex]::Escape($EnvName) + '\s*=\s*("[^"\\]*"|''[^'']*'')', '')
        if ($stripped.IndexOf([char]61) -ge 0) { $otherEnv = $true }
    }
    $info.OtherEnv = $otherEnv
    $info.Looks = (($cmdValue -ceq 'uvx') -and ($argsRaw.IndexOf($ProxyPackage, [StringComparison]::Ordinal) -ge 0) -and ($extra.Count -eq 0) -and ($subHeaders -eq 0) -and (-not $otherEnv))
    $hasEnv = (($envHeaders -gt 0) -or ($null -ne $inlineEnvRaw) -or $dottedEnv)
    if ($hasEnv) {
        $info.HasEnv = $true
        $raw = $null
        if ($null -ne $envVarRaw) { $raw = $envVarRaw }
        elseif ($null -ne $dottedEnvRaw) { $raw = $dottedEnvRaw }
        elseif ($null -ne $inlineEnvRaw) {
            $m = [regex]::Match($inlineEnvRaw, '(?:^|[{,\s])' + [regex]::Escape($EnvName) + '\s*=\s*("[^"\\]*"|''[^'']*'')')
            if ($m.Success) { $raw = $m.Groups[1].Value }
        }
        $val = $null
        if ($null -ne $raw) { $val = Get-TomlStringValue $raw }
        if ($null -ne $val) {
            $tokens = @($val -split '\s+' | Where-Object { $_.Length -gt 0 })
            if ($tokens -ccontains $ProfileName) { $info.State = 'AlreadyOk'; return $info }
        }
        $info.State = 'Refused'
        if ($null -ne $val) { $info.Reason = ('the aws-mcp entry already sets {0} to "{1}"' -f $EnvName, $val) }
        else { $info.Reason = ('the aws-mcp entry already has an env section without {0}' -f $EnvName) }
        return $info
    }
    $info.State = 'Ready'
    $info.InsertAt = [int]$lastMain.LineEnd
    return $info
}

function Add-TomlMcpEnv {
    # Pure text function: returns State (Patched | AlreadyOk | NotFound | Refused), the new Text and a Reason.
    param(
        [string]$Text,
        [string]$Server = 'aws-mcp',
        [string]$EnvName = 'AWS_MCP_PROXY_PROFILES',
        [string]$ProfileName = 'otchealth'
    )
    $info = Get-TomlServerInfo -Text $Text -Server $Server -EnvName $EnvName -ProfileName $ProfileName
    $res = [pscustomobject]@{ State = $info.State; Text = $Text; Reason = $info.Reason; Info = $info }
    if ($info.State -ne 'Ready') { return $res }
    $nl = $info.Nl
    $ins = $nl + $nl + '[mcp_servers.' + $Server + '.env]' + $nl + $EnvName + ' = "' + $ProfileName + '"'
    $new = $Text.Insert($info.InsertAt, $ins)
    if ($new.Remove($info.InsertAt, $ins.Length) -cne $Text) {
        $res.State = 'Refused'; $res.Reason = 'internal check failed (insertion)'; return $res
    }
    $again = Get-TomlServerInfo -Text $new -Server $Server -EnvName $EnvName -ProfileName $ProfileName
    if ($again.State -ne 'AlreadyOk') {
        $res.State = 'Refused'; $res.Reason = 'internal check failed (re-read: ' + $again.State + ' ' + $again.Reason + ')'; return $res
    }
    $res.State = 'Patched'
    $res.Text = $new
    return $res
}

function Update-CodexConfigEnv {
    # File wrapper: backs up config.toml, inserts the env sub-table, re-reads the file to verify,
    # and restores the backup if anything is off. State: Patched | AlreadyOk | NotFound | Refused.
    param(
        [string]$Path,
        [string]$Server = 'aws-mcp',
        [string]$EnvName = 'AWS_MCP_PROXY_PROFILES',
        [string]$ProfileName = 'otchealth'
    )
    $out = [pscustomobject]@{ State = 'NotFound'; Reason = ''; Backup = $null; Info = $null }
    $f = Read-TextFile $Path
    if (-not $f.Ok) { $out.State = 'Refused'; $out.Reason = 'the file ' + $f.Error; return $out }
    if (-not $f.Exists) { $out.Reason = 'the file does not exist'; return $out }
    $r = Add-TomlMcpEnv -Text $f.Text -Server $Server -EnvName $EnvName -ProfileName $ProfileName
    $out.Info = $r.Info
    if ($r.State -ne 'Patched') { $out.State = $r.State; $out.Reason = $r.Reason; return $out }
    $out.Backup = New-BackupCopy -Path $Path -Tag 'pre-env'
    try {
        Write-TextFile -Path $Path -Text $r.Text -Bom $f.HasBom
        $chk = Read-TextFile $Path
        if (-not $chk.Ok -or ($chk.Text -cne $r.Text)) { throw 'the saved file does not match what was intended' }
        $again = Get-TomlServerInfo -Text $chk.Text -Server $Server -EnvName $EnvName -ProfileName $ProfileName
        if ($again.State -ne 'AlreadyOk') { throw 'the saved file did not read back as expected' }
    }
    catch {
        $why = $_.Exception.Message
        try { Copy-Item -LiteralPath $out.Backup -Destination $Path -Force } catch { $why = $why + ' (and the restore failed: ' + $_.Exception.Message + ')' }
        $out.State = 'Refused'
        $out.Reason = 'verification failed, the original file was restored (' + $why + ')'
        return $out
    }
    $out.State = 'Patched'
    return $out
}

function Get-CodexEntryLines {
    # The standard AWS entry for Codex with its env sub-table: the same content that AWS's wizard writes through
    # "codex mcp add aws-mcp -- uvx mcp-proxy-for-aws@latest <url> --metadata INSTALL_SOURCE=aws-cli",
    # plus the profile setting that setup.md asks for.
    param([string]$Server, [string]$EnvName, [string]$ProfileName, [string]$McpUrl, [string]$ProxyPackage)
    $l = New-Object 'System.Collections.Generic.List[string]'
    $l.Add('[mcp_servers.' + $Server + ']')
    $l.Add('command = "uvx"')
    $l.Add('args = ["' + $ProxyPackage + '@latest", "' + $McpUrl + '", "--metadata", "INSTALL_SOURCE=aws-cli"]')
    $l.Add('')
    $l.Add('[mcp_servers.' + $Server + '.env]')
    $l.Add($EnvName + ' = "' + $ProfileName + '"')
    return $l.ToArray()
}

function Add-TomlMcpEntry {
    # Pure text function for the one case where config.toml has NO aws-mcp entry at all: the AWS wizard skips Codex
    # when the "codex" command is not found. Appends the standard entry and its env sub-table at the END of the text
    # and changes nothing else. State: Added | Refused (see Reason). Never used when an aws-mcp entry exists.
    param(
        [string]$Text,
        [string]$Server = 'aws-mcp',
        [string]$EnvName = 'AWS_MCP_PROXY_PROFILES',
        [string]$ProfileName = 'otchealth',
        [string]$McpUrl = 'https://aws-mcp.us-east-1.api.aws/mcp',
        [string]$ProxyPackage = 'mcp-proxy-for-aws'
    )
    if ($null -eq $Text) { $Text = '' }
    $res = [pscustomobject]@{ State = 'Refused'; Text = $Text; Reason = '' }
    $info = Get-TomlServerInfo -Text $Text -Server $Server -EnvName $EnvName -ProfileName $ProfileName -ProxyPackage $ProxyPackage
    if ($info.State -eq 'Ready' -or $info.State -eq 'AlreadyOk') { $res.Reason = 'an aws-mcp entry already exists'; return $res }
    if ($info.State -ne 'NotFound') { $res.Reason = $info.Reason; return $res }
    # A new [mcp_servers.aws-mcp] header would clash with a file that defines "mcp_servers" in another way.
    $st = Read-TomlStructure $Text
    if (-not $st.Ok) { $res.Reason = 'the file could not be read safely: ' + $st.Error; return $res }
    $top = @('mcp_servers')
    $cur = @()
    foreach ($it in $st.Items) {
        if ($it.Kind -eq 'table' -or $it.Kind -eq 'array') {
            $cur = @($it.Path)
            if ($it.Kind -eq 'array' -and (Test-PathEq $cur $top)) { $res.Reason = 'the file defines "mcp_servers" as an array of tables'; return $res }
            continue
        }
        $full = @($cur) + @($it.Path)
        if ((Test-PathPrefix $full $top) -and -not (Test-PathPrefix $cur $top)) {
            $res.Reason = 'the file sets "mcp_servers" with a plain value or dotted keys outside its own section'
            return $res
        }
    }
    $nl = Get-DominantNewline $Text
    $entry = ((Get-CodexEntryLines -Server $Server -EnvName $EnvName -ProfileName $ProfileName -McpUrl $McpUrl -ProxyPackage $ProxyPackage) -join $nl)
    if ($Text.Length -eq 0) { $new = $entry + $nl }
    else {
        $lead = ''
        if (-not $Text.EndsWith("`n", [StringComparison]::Ordinal)) { $lead = $nl }
        if (($Text + $lead) -notmatch '(?:\r?\n)[ \t]*\r?\n\z') { $lead = $lead + $nl }
        $new = $Text + $lead + $entry + $nl
    }
    if (-not $new.StartsWith($Text, [StringComparison]::Ordinal)) {
        $res.Reason = 'internal check failed (the original text must stay in front)'
        return $res
    }
    $again = Get-TomlServerInfo -Text $new -Server $Server -EnvName $EnvName -ProfileName $ProfileName -ProxyPackage $ProxyPackage
    if ($again.State -ne 'AlreadyOk' -or -not $again.Looks -or $again.MainCount -ne 1) {
        $res.Reason = 'internal check failed (re-read: ' + $again.State + ' ' + $again.Reason + ')'
        return $res
    }
    $res.State = 'Added'
    $res.Text = $new
    return $res
}

function Add-CodexEntryToFile {
    # File wrapper for Add-TomlMcpEntry: a missing config.toml is created, an existing one is backed up first, and the
    # saved file is read back and checked. If anything is off the original is put back. State: Added | Refused.
    param(
        [string]$Path,
        [string]$Server = 'aws-mcp',
        [string]$EnvName = 'AWS_MCP_PROXY_PROFILES',
        [string]$ProfileName = 'otchealth',
        [string]$McpUrl = 'https://aws-mcp.us-east-1.api.aws/mcp',
        [string]$ProxyPackage = 'mcp-proxy-for-aws'
    )
    $out = [pscustomobject]@{ State = 'Refused'; Reason = ''; Backup = $null; Created = $false }
    $f = Read-TextFile $Path
    if (-not $f.Ok) { $out.Reason = 'the file ' + $f.Error; return $out }
    $text = ''
    if ($f.Exists) { $text = $f.Text }
    $r = Add-TomlMcpEntry -Text $text -Server $Server -EnvName $EnvName -ProfileName $ProfileName -McpUrl $McpUrl -ProxyPackage $ProxyPackage
    if ($r.State -ne 'Added') { $out.Reason = $r.Reason; return $out }
    if ($f.Exists) { $out.Backup = New-BackupCopy -Path $Path -Tag 'pre-entry' } else { $out.Created = $true }
    try {
        Write-TextFile -Path $Path -Text $r.Text -Bom $f.HasBom
        $chk = Read-TextFile $Path
        if (-not $chk.Ok -or ($chk.Text -cne $r.Text)) { throw 'the saved file does not match what was intended' }
        $again = Get-TomlServerInfo -Text $chk.Text -Server $Server -EnvName $EnvName -ProfileName $ProfileName -ProxyPackage $ProxyPackage
        if ($again.State -ne 'AlreadyOk' -or -not $again.Looks) { throw 'the saved file did not read back as expected' }
    }
    catch {
        $why = $_.Exception.Message
        try {
            if ($out.Backup) { Copy-Item -LiteralPath $out.Backup -Destination $Path -Force }
            else { Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue }
        }
        catch { $why = $why + ' (and the restore failed: ' + $_.Exception.Message + ')' }
        $out.State = 'Refused'
        $out.Reason = 'verification failed, the original file was put back (' + $why + ')'
        return $out
    }
    $out.State = 'Added'
    return $out
}

function Join-Lines {
    # Joins lines with the Windows newline. (Build text with this instead of "@( 'a' + $x, 'b' )":
    # in PowerShell the comma binds tighter than +, which silently mangles such lists.)
    param([string[]]$Lines)
    return ($Lines -join [Environment]::NewLine)
}

function Get-CodexEnvHandEdit {
    # Exact words for a person who has to add the setting by hand.
    param([string]$ConfigPath, [string]$ProfileName = 'otchealth')
    $l = New-Object 'System.Collections.Generic.List[string]'
    $l.Add('Open this file in Notepad: ' + $ConfigPath)
    $l.Add('Find the section that starts with [mcp_servers.aws-mcp].')
    $l.Add('If there is already a section called [mcp_servers.aws-mcp.env], add this one line inside it:')
    $l.Add('    AWS_MCP_PROXY_PROFILES = "' + $ProfileName + '"')
    $l.Add('Otherwise add these two lines on a new line directly below the aws-mcp section (leave a blank line above):')
    $l.Add('    [mcp_servers.aws-mcp.env]')
    $l.Add('    AWS_MCP_PROXY_PROFILES = "' + $ProfileName + '"')
    $l.Add('Save the file and restart Codex.')
    $l.Add('Shortcut (replaces the whole aws-mcp entry): codex mcp add aws-mcp --env AWS_MCP_PROXY_PROFILES=' + $ProfileName + ' -- uvx mcp-proxy-for-aws@latest https://aws-mcp.us-east-1.api.aws/mcp --metadata INSTALL_SOURCE=aws-cli')
    return (Join-Lines $l.ToArray())
}

function Get-CodexFullHandEdit {
    # For the case where the aws-mcp entry does not exist in config.toml at all.
    param([string]$ConfigPath, [string]$ProfileName = 'otchealth')
    $l = New-Object 'System.Collections.Generic.List[string]'
    $l.Add('Open (or create) this file in Notepad: ' + $ConfigPath)
    $l.Add('Add these lines at the end of the file (leave a blank line above them):')
    $l.Add('    [mcp_servers.aws-mcp]')
    $l.Add('    command = "uvx"')
    $l.Add('    args = ["mcp-proxy-for-aws@latest", "https://aws-mcp.us-east-1.api.aws/mcp", "--metadata", "INSTALL_SOURCE=aws-cli"]')
    $l.Add('')
    $l.Add('    [mcp_servers.aws-mcp.env]')
    $l.Add('    AWS_MCP_PROXY_PROFILES = "' + $ProfileName + '"')
    $l.Add('Save the file and restart Codex.')
    $l.Add('Or, once the codex command works in a PowerShell window, run: codex mcp add aws-mcp --env AWS_MCP_PROXY_PROFILES=' + $ProfileName + ' -- uvx mcp-proxy-for-aws@latest https://aws-mcp.us-east-1.api.aws/mcp --metadata INSTALL_SOURCE=aws-cli')
    return (Join-Lines $l.ToArray())
}

# ======================================================================================
# JSON settings files (Claude Code, Cline, Cursor, Gemini CLI, Kiro, Windsurf, OpenCode):
# a position-aware reader and an insert-only editor. Only the new "env" block is inserted;
# every other byte of the file stays exactly as it was. The result is verified before it is kept.
# ======================================================================================
# One regular expression finds every JSON token (string, number, true/false/null, { } [ ] : ,) natively and fast.
# Anything between two tokens must be white space, otherwise the text is not valid JSON.
$script:RegexTimeout = [TimeSpan]::FromSeconds(30)
$script:JsonTokenRe = New-Object System.Text.RegularExpressions.Regex('"(?>[^"\\]+|\\.)*"|-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null|[{}\[\]:,]', [System.Text.RegularExpressions.RegexOptions]::Singleline, $script:RegexTimeout)
# Skips one whole { ... } or [ ... ] value natively (balanced brackets, strings respected). Used for parts of a
# file we do not need to look inside, such as the big "projects" section of a Claude Code settings file.
$script:JsonSkipRe = New-Object System.Text.RegularExpressions.Regex('\G[{\[](?>(?:"(?>[^"\\]+|\\.)*"|[^"{}\[\]]+|[{\[](?<d>)|[}\]](?<-d>))*)[}\]](?(d)(?!))', [System.Text.RegularExpressions.RegexOptions]::Singleline, $script:RegexTimeout)
# One quick pass that stops at the first quoted text that is never closed. Without this check, a damaged file with a
# never-closed quote could make the token search very slow (it would retry from every later quote mark).
$script:JsonQuoteRe = New-Object System.Text.RegularExpressions.Regex('\G(?>(?:"(?>[^"\\]+|\\.)*"|[^"]+))*', [System.Text.RegularExpressions.RegexOptions]::Singleline, $script:RegexTimeout)

function Get-LineNumberAt {
    param([string]$Text, [int]$Pos)
    $line = 1
    $upto = [Math]::Min($Pos, $Text.Length)
    $i = $Text.IndexOf([char]10)
    while ($i -ge 0 -and $i -lt $upto) {
        $line++
        $i = $Text.IndexOf([char]10, $i + 1)
    }
    return $line
}

function Set-JsonScanFail {
    param($Out, [string]$Text, [int]$Pos, [string]$Msg)
    $Out.Error = ('{0} (line {1})' -f $Msg, (Get-LineNumberAt $Text $Pos))
    return $Out
}

function Read-JsonStructure {
    # Reads a JSON text and returns where things are (see Read-JsonStructureCore). If the text is so odd that the
    # search takes more than 30 seconds, the text is simply reported as unreadable instead of hanging the script.
    param([string]$Text, [string[]]$GuideKeys = @())
    try { return (Read-JsonStructureCore -Text $Text -GuideKeys $GuideKeys) }
    catch [System.Text.RegularExpressions.RegexMatchTimeoutException] {
        return [pscustomobject]@{ Ok = $false; Error = 'reading it took far too long, so the file is probably damaged'; Root = $null }
    }
}

function Read-JsonStructureCore {
    # Reads a JSON text and returns where things are: Root = Type, Start, End and, for objects, Members
    # (Key, KeyStart, ValueStart, ValueEnd, Type, Value). Only the path named by $GuideKeys is read in detail
    # (its keys at depth 1, 2, 3); every other nested value is skipped natively. Stray characters anywhere in the
    # text (comments, single quotes, NaN ...) make the whole text invalid.
    # (The loop uses plain arrays and integers on purpose: it is several times faster in PowerShell than objects.)
    param([string]$Text, [string[]]$GuideKeys = @())
    $out = [pscustomobject]@{ Ok = $false; Error = $null; Root = $null }
    $re = $script:JsonTokenRe
    $guideN = 0
    if ($GuideKeys) { $guideN = $GuideKeys.Count }
    $qm = $script:JsonQuoteRe.Match($Text, 0)
    if ($qm.Length -lt $Text.Length) { return (Set-JsonScanFail $out $Text $qm.Length 'a quoted text is never closed') }
    if ($re.Replace($Text, '') -match '[^ \t\r\n]') {
        $prev = 0
        $bad = -1
        foreach ($tm in $re.Matches($Text)) {
            if ($tm.Index -gt $prev) {
                $gap = $Text.Substring($prev, $tm.Index - $prev)
                $k = [regex]::Match($gap, '[^ \t\r\n]')
                if ($k.Success) { $bad = $prev + $k.Index; break }
            }
            $prev = $tm.Index + $tm.Length
        }
        if ($bad -lt 0) {
            $k = [regex]::Match($Text.Substring($prev), '[^ \t\r\n]')
            if ($k.Success) { $bad = $prev + $k.Index }
        }
        if ($bad -lt 0) { $bad = 0 }
        return (Set-JsonScanFail $out $Text $bad 'this is not valid JSON')
    }
    $ms = $re.Matches($Text)
    $n = $ms.Count
    # Frame = object[]: 0 isObject, 1 state, 2 start, 3 members, 4 current key, 5 current key start.
    # States: object 0 KeyOrEnd, 1 Key, 2 Colon, 3 Value, 4 CommaOrEnd; array 5 ValueOrEnd, 6 Value, 7 CommaOrEnd.
    $stack = New-Object 'System.Collections.Generic.List[object]'
    $depth = 0
    $f = $null
    $fObj = $false
    $fState = 0
    $root = $null
    $rootDone = $false
    for ($i = 0; $i -lt $n; $i++) {
        $m = $ms[$i]
        $idx = $m.Index
        $len = $m.Length
        $c = [int]$Text[$idx]
        if ($depth -eq 0) {
            if ($rootDone) { return (Set-JsonScanFail $out $Text $idx 'unexpected text after the JSON') }
            if ($c -eq 123 -or $c -eq 91) {
                $mem = New-Object 'System.Collections.Generic.List[object]'
                if ($c -eq 123) { $f = @($true, 0, $idx, $mem, '', 0) } else { $f = @($false, 5, $idx, $mem, '', 0) }
                $stack.Add($f)
                $depth = 1
                $fObj = $f[0]
                $fState = $f[1]
                continue
            }
            if ($c -eq 125 -or $c -eq 93 -or $c -eq 58 -or $c -eq 44) { return (Set-JsonScanFail $out $Text $idx 'a value was expected') }
            $st0 = 'number'
            if ($c -eq 34) { $st0 = 'string' } elseif ($c -eq 116 -or $c -eq 102 -or $c -eq 110) { $st0 = 'literal' }
            $root = [pscustomobject]@{ Type = $st0; Start = $idx; End = ($idx + $len); Members = $null }
            $rootDone = $true
            continue
        }
        if ($c -eq 125 -or $c -eq 93) {
            if ($fObj -ne ($c -eq 125)) { return (Set-JsonScanFail $out $Text $idx 'a closing bracket does not match') }
            if ($fState -ne 4 -and $fState -ne 0 -and $fState -ne 5 -and $fState -ne 7) { return (Set-JsonScanFail $out $Text $idx 'a value or name is missing before the closing bracket') }
            $stack.RemoveAt($depth - 1)
            $depth--
            $typeName = 'array'
            if ($fObj) { $typeName = 'object' }
            if ($depth -eq 0) {
                $root = [pscustomobject]@{ Type = $typeName; Start = $f[2]; End = ($idx + 1); Members = $f[3] }
                $rootDone = $true
                $f = $null
            }
            else {
                $par = $stack[$depth - 1]
                if ($par[0]) {
                    $val = [pscustomobject]@{ Type = $typeName; Start = $f[2]; End = ($idx + 1); Members = $f[3] }
                    $par[3].Add([pscustomobject]@{ Key = $par[4]; KeyStart = $par[5]; ValueStart = $f[2]; ValueEnd = ($idx + 1); Type = $typeName; Value = $val })
                    $par[1] = 4
                }
                else { $par[1] = 7 }
                $f = $par
                $fObj = $par[0]
                $fState = $par[1]
            }
            continue
        }
        $isOpen = ($c -eq 123 -or $c -eq 91)
        if ($fObj) {
            if ($fState -eq 0 -or $fState -eq 1) {
                if ($c -ne 34) { return (Set-JsonScanFail $out $Text $idx 'a quoted name was expected') }
                $f[4] = $Text.Substring($idx + 1, $len - 2)
                $f[5] = $idx
                $f[1] = 2
                $fState = 2
            }
            elseif ($fState -eq 2) {
                if ($c -ne 58) { return (Set-JsonScanFail $out $Text $idx 'a colon was expected') }
                $f[1] = 3
                $fState = 3
            }
            elseif ($fState -eq 3) {
                if ($isOpen) {
                    $descend = ($depth -le $guideN -and $f[4] -ceq $GuideKeys[$depth - 1])
                    if ($descend) {
                        $mem = New-Object 'System.Collections.Generic.List[object]'
                        if ($c -eq 123) { $nf = @($true, 0, $idx, $mem, '', 0) } else { $nf = @($false, 5, $idx, $mem, '', 0) }
                        $stack.Add($nf)
                        $depth++
                        $f = $nf
                        $fObj = $f[0]
                        $fState = $f[1]
                    }
                    else {
                        $sm = $script:JsonSkipRe.Match($Text, $idx)
                        if (-not $sm.Success) { return (Set-JsonScanFail $out $Text $idx 'a nested object or array is not closed') }
                        $endPos = $idx + $sm.Length
                        $tn = 'array'
                        if ($c -eq 123) { $tn = 'object' }
                        $val = [pscustomobject]@{ Type = $tn; Start = $idx; End = $endPos; Members = $null }
                        $f[3].Add([pscustomobject]@{ Key = $f[4]; KeyStart = $f[5]; ValueStart = $idx; ValueEnd = $endPos; Type = $tn; Value = $val })
                        $f[1] = 4
                        $fState = 4
                        $lo = $i + 1
                        $hi = $n
                        while ($lo -lt $hi) {
                            $mid = ($lo + $hi) -shr 1
                            if ($ms[$mid].Index -lt $endPos) { $lo = $mid + 1 } else { $hi = $mid }
                        }
                        $i = $lo - 1
                    }
                }
                elseif ($c -eq 58 -or $c -eq 44) { return (Set-JsonScanFail $out $Text $idx 'a value was expected') }
                else {
                    $stype = 'number'
                    if ($c -eq 34) { $stype = 'string' } elseif ($c -eq 116 -or $c -eq 102 -or $c -eq 110) { $stype = 'literal' }
                    $f[3].Add([pscustomobject]@{ Key = $f[4]; KeyStart = $f[5]; ValueStart = $idx; ValueEnd = ($idx + $len); Type = $stype; Value = $null })
                    $f[1] = 4
                    $fState = 4
                }
            }
            else {
                if ($c -ne 44) { return (Set-JsonScanFail $out $Text $idx 'a comma or closing brace was expected') }
                $f[1] = 1
                $fState = 1
            }
        }
        else {
            if ($fState -eq 7) {
                if ($c -ne 44) { return (Set-JsonScanFail $out $Text $idx 'a comma or closing bracket was expected') }
                $f[1] = 6
                $fState = 6
            }
            elseif ($isOpen) {
                $sm = $script:JsonSkipRe.Match($Text, $idx)
                if (-not $sm.Success) { return (Set-JsonScanFail $out $Text $idx 'a nested object or array is not closed') }
                $endPos = $idx + $sm.Length
                $f[1] = 7
                $fState = 7
                $lo = $i + 1
                $hi = $n
                while ($lo -lt $hi) {
                    $mid = ($lo + $hi) -shr 1
                    if ($ms[$mid].Index -lt $endPos) { $lo = $mid + 1 } else { $hi = $mid }
                }
                $i = $lo - 1
            }
            elseif ($c -eq 58 -or $c -eq 44) { return (Set-JsonScanFail $out $Text $idx 'a value was expected') }
            else {
                $f[1] = 7
                $fState = 7
            }
        }
    }
    if ($depth -gt 0) { return (Set-JsonScanFail $out $Text $Text.Length 'an object or array is not closed') }
    if (-not $rootDone) { return (Set-JsonScanFail $out $Text 0 'the file is empty') }
    $out.Root = $root
    $out.Ok = $true
    return $out
}

function Get-JsonLineIndent {
    # The spaces/tabs at the start of the line that contains position $Pos, or $null if other text comes first.
    param([string]$Text, [int]$Pos)
    $ls = $Text.LastIndexOf([char]10, $Pos) + 1
    $lead = $Text.Substring($ls, $Pos - $ls)
    if ($lead -match '^[ \t]*$') { return $lead }
    return $null
}

function Get-JsonServerInfo {
    # Looks at <ParentKey>.<Server> (for example mcpServers."aws-mcp") in a JSON text.
    # State: Invalid | NotFound | Ready | AlreadyOk | Refused
    param(
        [string]$Text,
        [string]$ParentKey = 'mcpServers',
        [string]$Server = 'aws-mcp',
        [string]$EnvKey = 'env',
        [string]$EnvName = 'AWS_MCP_PROXY_PROFILES',
        [string]$ProfileName = 'otchealth',
        [string]$ProxyPackage = 'mcp-proxy-for-aws'
    )
    $info = [pscustomobject]@{
        State = 'NotFound'; Reason = ''; InsertAt = -1; Insert = ''; Looks = $false
        Keys = @(); Command = ''; Args = ''; HasEnv = $false
    }
    $st = Read-JsonStructure -Text $Text -GuideKeys @($ParentKey, $Server, $EnvKey)
    if (-not $st.Ok) { $info.State = 'Invalid'; $info.Reason = 'it is not valid JSON: ' + $st.Error; return $info }
    if ($st.Root.Type -ne 'object') { $info.State = 'Refused'; $info.Reason = 'the top level is not a JSON object'; return $info }
    $parents = @($st.Root.Members | Where-Object { $_.Key -ceq $ParentKey })
    if ($parents.Count -eq 0) { return $info }
    if ($parents.Count -gt 1) { $info.State = 'Refused'; $info.Reason = ('"{0}" appears more than once' -f $ParentKey); return $info }
    $parent = $parents[0]
    if ($parent.Type -ne 'object') { $info.State = 'Refused'; $info.Reason = ('"{0}" is not an object' -f $ParentKey); return $info }
    $servers = @($parent.Value.Members | Where-Object { $_.Key -ceq $Server })
    if ($servers.Count -eq 0) { return $info }
    if ($servers.Count -gt 1) { $info.State = 'Refused'; $info.Reason = ('"{0}" appears more than once' -f $Server); return $info }
    $srv = $servers[0]
    if ($srv.Type -ne 'object') { $info.State = 'Refused'; $info.Reason = ('"{0}" is not an object' -f $Server); return $info }
    $members = $srv.Value.Members
    if ($members.Count -eq 0) { $info.State = 'Refused'; $info.Reason = ('"{0}" is empty' -f $Server); return $info }
    $info.Keys = @($members | ForEach-Object { $_.Key })
    foreach ($m in $members) {
        if ($m.Key -ceq 'command') { $info.Command = $Text.Substring($m.ValueStart, $m.ValueEnd - $m.ValueStart) }
        if ($m.Key -ceq 'args') { $info.Args = $Text.Substring($m.ValueStart, $m.ValueEnd - $m.ValueStart) }
    }
    $allowed = @('command', 'args', 'timeout', 'transport', $EnvKey)
    $extra = @($info.Keys | Where-Object { $allowed -cnotcontains $_ })
    $info.Looks = (($info.Command -ceq '"uvx"') -and ($info.Args.IndexOf($ProxyPackage, [StringComparison]::Ordinal) -ge 0) -and ($extra.Count -eq 0))
    $envMembers = @($members | Where-Object { $_.Key -ceq $EnvKey })
    if ($envMembers.Count -gt 1) { $info.State = 'Refused'; $info.Reason = ('"{0}" appears more than once' -f $EnvKey); return $info }
    if ($envMembers.Count -eq 1) {
        $info.HasEnv = $true
        $em = $envMembers[0]
        $val = $null
        if ($em.Type -eq 'object') {
            $vars = @($em.Value.Members | Where-Object { $_.Key -ceq $EnvName })
            if ($vars.Count -eq 1 -and $vars[0].Type -eq 'string') {
                $raw = $Text.Substring($vars[0].ValueStart, $vars[0].ValueEnd - $vars[0].ValueStart)
                $val = $raw.Substring(1, $raw.Length - 2)
            }
        }
        if ($null -ne $val -and $val.IndexOf([char]92) -lt 0) {
            $tokens = @($val -split '\s+' | Where-Object { $_.Length -gt 0 })
            if ($tokens -ccontains $ProfileName) { $info.State = 'AlreadyOk'; return $info }
        }
        $info.State = 'Refused'
        if ($null -ne $val) { $info.Reason = ('"{0}" already sets {1} to "{2}"' -f $EnvKey, $EnvName, $val) }
        else { $info.Reason = ('"{0}" already exists without {1}' -f $EnvKey, $EnvName) }
        return $info
    }
    # Work out the text to insert, in the same style as the file.
    if ($ProfileName -notmatch '^[A-Za-z0-9_.-]+$' -or $EnvName -notmatch '^[A-Za-z0-9_]+$') {
        $info.State = 'Refused'; $info.Reason = 'internal: unexpected characters in the setting names'; return $info
    }
    $nl = Get-DominantNewline $Text
    $first = $members[0]
    $last = $members[$members.Count - 1]
    $between = $Text.Substring($srv.Value.Start + 1, $first.KeyStart - $srv.Value.Start - 1)
    $memberIndent = $null
    if ($between.IndexOf([char]10) -ge 0) { $memberIndent = Get-JsonLineIndent $Text $first.KeyStart }
    if ($null -ne $memberIndent) {
        $serverIndent = Get-JsonLineIndent $Text $srv.KeyStart
        $unit = '  '
        if ($null -ne $serverIndent -and $memberIndent.Length -gt $serverIndent.Length -and $memberIndent.StartsWith($serverIndent, [StringComparison]::Ordinal)) {
            $unit = $memberIndent.Substring($serverIndent.Length)
        }
        $ins = ',' + $nl + $memberIndent + '"' + $EnvKey + '": {' + $nl + $memberIndent + $unit + '"' + $EnvName + '": "' + $ProfileName + '"' + $nl + $memberIndent + '}'
    }
    else {
        $ins = ', "' + $EnvKey + '": {"' + $EnvName + '": "' + $ProfileName + '"}'
    }
    $info.State = 'Ready'
    $info.InsertAt = [int]$last.ValueEnd
    $info.Insert = $ins
    return $info
}

function Add-JsonEnvToText {
    # Pure text function: returns State (Patched | AlreadyOk | NotFound | Invalid | Refused), the new Text and a Reason.
    param(
        [string]$Text,
        [string]$ParentKey = 'mcpServers',
        [string]$Server = 'aws-mcp',
        [string]$EnvKey = 'env',
        [string]$EnvName = 'AWS_MCP_PROXY_PROFILES',
        [string]$ProfileName = 'otchealth'
    )
    $info = Get-JsonServerInfo -Text $Text -ParentKey $ParentKey -Server $Server -EnvKey $EnvKey -EnvName $EnvName -ProfileName $ProfileName
    $res = [pscustomobject]@{ State = $info.State; Text = $Text; Reason = $info.Reason; Info = $info }
    if ($info.State -ne 'Ready') { return $res }
    $new = $Text.Insert($info.InsertAt, $info.Insert)
    if ($new.Remove($info.InsertAt, $info.Insert.Length) -cne $Text) {
        $res.State = 'Refused'; $res.Reason = 'internal check failed (insertion)'; return $res
    }
    $again = Get-JsonServerInfo -Text $new -ParentKey $ParentKey -Server $Server -EnvKey $EnvKey -EnvName $EnvName -ProfileName $ProfileName
    if ($again.State -ne 'AlreadyOk') {
        $res.State = 'Refused'; $res.Reason = 'internal check failed (re-read: ' + $again.State + ' ' + $again.Reason + ')'; return $res
    }
    $res.State = 'Patched'
    $res.Text = $new
    return $res
}

function Test-PsJsonValue {
    # Extra check with PowerShell's own JSON parser: does <ParentKey>.<Server>.<EnvKey>.<EnvName> equal $Expected?
    # Returns 'yes', 'no' or 'unknown' (PowerShell could not parse the file at all).
    param([string]$Text, [string]$ParentKey, [string]$Server, [string]$EnvKey, [string]$EnvName, [string]$Expected)
    try { $obj = $Text | ConvertFrom-Json } catch { return 'unknown' }
    try {
        $v = $obj.$ParentKey.$Server.$EnvKey.$EnvName
        if ([string]$v -ceq $Expected) { return 'yes' }
        return 'no'
    }
    catch { return 'no' }
}

function Add-ProfileEnv {
    # File wrapper. State: Patched | AlreadyOk | NoEntry | Invalid | Refused. Never leaves a half-edited file.
    param(
        [string]$Path,
        [string]$ParentKey = 'mcpServers',
        [string]$Server = 'aws-mcp',
        [string]$EnvKey = 'env',
        [string]$EnvName = 'AWS_MCP_PROXY_PROFILES',
        [string]$ProfileName = 'otchealth'
    )
    $out = [pscustomobject]@{ State = 'NoEntry'; Reason = ''; Backup = $null; Info = $null }
    $f = Read-TextFile $Path
    if (-not $f.Ok) { $out.State = 'Refused'; $out.Reason = 'the file ' + $f.Error; return $out }
    if (-not $f.Exists) { return $out }
    if ($f.Text.Length -gt 3000000) { $out.State = 'Refused'; $out.Reason = 'the file is too large to edit safely'; return $out }
    $r = Add-JsonEnvToText -Text $f.Text -ParentKey $ParentKey -Server $Server -EnvKey $EnvKey -EnvName $EnvName -ProfileName $ProfileName
    $out.Info = $r.Info
    if ($r.State -eq 'NotFound') { $out.State = 'NoEntry'; return $out }
    if ($r.State -ne 'Patched') { $out.State = $r.State; $out.Reason = $r.Reason; return $out }
    $origParses = ((Test-PsJsonValue $f.Text $ParentKey $Server $EnvKey $EnvName $ProfileName) -ne 'unknown')
    $out.Backup = New-BackupCopy -Path $Path -Tag 'pre-env'
    try {
        Write-TextFile -Path $Path -Text $r.Text -Bom $f.HasBom
        $chk = Read-TextFile $Path
        if (-not $chk.Ok -or ($chk.Text -cne $r.Text)) { throw 'the saved file does not match what was intended' }
        $again = Get-JsonServerInfo -Text $chk.Text -ParentKey $ParentKey -Server $Server -EnvKey $EnvKey -EnvName $EnvName -ProfileName $ProfileName
        if ($again.State -ne 'AlreadyOk') { throw 'the saved file did not read back as expected' }
        if ($origParses) {
            $ps = Test-PsJsonValue $chk.Text $ParentKey $Server $EnvKey $EnvName $ProfileName
            if ($ps -ne 'yes') { throw 'PowerShell could not confirm the new setting in the saved file' }
        }
    }
    catch {
        $why = $_.Exception.Message
        try { Copy-Item -LiteralPath $out.Backup -Destination $Path -Force } catch { $why = $why + ' (and the restore failed: ' + $_.Exception.Message + ')' }
        $out.State = 'Refused'
        $out.Reason = 'verification failed, the original file was restored (' + $why + ')'
        return $out
    }
    $out.State = 'Patched'
    return $out
}

function Get-JsonEnvHandEdit {
    param([string]$Path, [string]$ProfileName = 'otchealth')
    $l = New-Object 'System.Collections.Generic.List[string]'
    $l.Add('Open this file in Notepad: ' + $Path)
    $l.Add('Find "aws-mcp" inside the "mcpServers" section.')
#@@W3-CHUNK-CONTINUES@@