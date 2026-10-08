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
    $l.Add('Inside the aws-mcp braces, add this block (put a comma at the end of the line above it):')
    $l.Add('    "env": { "AWS_MCP_PROXY_PROFILES": "' + $ProfileName + '" }')
    $l.Add('If an "env" block is already there, add the line "AWS_MCP_PROXY_PROFILES": "' + $ProfileName + '" inside it instead.')
    $l.Add('Do not change any other line. Save the file and restart the app.')
    return (Join-Lines $l.ToArray())
}

function Get-OpenCodeHandEdit {
    param([string]$Path, [string]$ProfileName = 'otchealth')
    $l = New-Object 'System.Collections.Generic.List[string]'
    $l.Add('Open this file in Notepad: ' + $Path)
    $l.Add('Find "aws-mcp" inside the "mcp" section.')
    $l.Add('Inside the aws-mcp braces, add this block (put a comma at the end of the line above it):')
    $l.Add('    "environment": { "AWS_MCP_PROXY_PROFILES": "' + $ProfileName + '" }')
    $l.Add('(OpenCode calls this setting "environment", not "env".)')
    $l.Add('Do not change any other line. Save the file and restart OpenCode.')
    return (Join-Lines $l.ToArray())
}

# ======================================================================================
# Step 7: AWS agent rules inside a marked block of a global instructions file
# (Codex: ~\.codex\AGENTS.md, Claude Code: ~\.claude\CLAUDE.md).
# Only the text between the two marker lines is ever replaced; everything else is kept.
# ======================================================================================
function Get-RulesBlockText {
    # BEGIN marker, one-line precedence note, blank line, the rules, END marker.
    param([string]$Rules, [string]$Begin, [string]$End, [string]$Note, [string]$Nl)
    $body = ($Rules -replace "`r`n", "`n").Trim([char]10, [char]13)
    $lines = New-Object 'System.Collections.Generic.List[string]'
    $lines.Add($Begin)
    $lines.Add($Note)
    $lines.Add('')
    foreach ($l in ($body -split "`n")) { $lines.Add($l) }
    $lines.Add($End)
    return ($lines -join $Nl)
}

function Get-MarkerMatches {
    # The places where a marker stands ALONE on its line (only spaces or tabs around it). The same words in the middle
    # of some other text are not a marker line and are ignored. Index is where the marker text itself starts.
    param([string]$Text, [string]$Marker)
    $pattern = '(?<=^[ \t]*)' + [regex]::Escape($Marker) + '(?=[ \t]*\r?$)'
    return @([regex]::Matches($Text, $pattern, [System.Text.RegularExpressions.RegexOptions]::Multiline))
}

function Get-TextOutsideBlock {
    # The text before the BEGIN marker line and after the END marker line (the first line of each).
    param([string]$Text, [string]$Begin, [string]$End)
    $bm = @(Get-MarkerMatches -Text $Text -Marker $Begin)
    $em = @(Get-MarkerMatches -Text $Text -Marker $End)
    if ($bm.Count -eq 0 -or $em.Count -eq 0) { return $null }
    $bi = [int]$bm[0].Index
    $ei = [int]$em[0].Index
    if ($ei -lt $bi) { return $null }
    return [pscustomobject]@{
        Before = $Text.Substring(0, $bi)
        After  = $Text.Substring($ei + $End.Length)
        Block  = $Text.Substring($bi, $ei + $End.Length - $bi)
    }
}

function Set-RulesBlock {
    # Pure text function. State: Created | Appended | Replaced | Unchanged | Refused.
    param([string]$Existing, [string]$Rules, [string]$Begin, [string]$End, [string]$Note)
    $res = [pscustomobject]@{ State = ''; Text = ''; Reason = ''; Nl = ''; Block = '' }
    if ($null -eq $Existing) { $Existing = '' }
    $nl = Get-DominantNewline $Existing
    $res.Nl = $nl
    $block = Get-RulesBlockText -Rules $Rules -Begin $Begin -End $End -Note $Note -Nl $nl
    $res.Block = $block
    $bCount = @(Get-MarkerMatches -Text $Existing -Marker $Begin).Count
    $eCount = @(Get-MarkerMatches -Text $Existing -Marker $End).Count
    if ($bCount -eq 0 -and $eCount -eq 0) {
        if ($Existing.Length -eq 0) {
            $res.State = 'Created'
            $res.Text = $block + $nl
            return $res
        }
        $t = $Existing
        if (-not $t.EndsWith("`n", [StringComparison]::Ordinal)) { $t = $t + $nl }
        if ($t -notmatch '(?:\r?\n)[ \t]*\r?\n\z') { $t = $t + $nl }
        $res.State = 'Appended'
        $res.Text = $t + $block + $nl
        return $res
    }
    if ($bCount -eq 1 -and $eCount -eq 1) {
        $parts = Get-TextOutsideBlock -Text $Existing -Begin $Begin -End $End
        if ($null -eq $parts) {
            $res.State = 'Refused'
            $res.Reason = 'the END marker comes before the BEGIN marker'
            return $res
        }
        $new = $parts.Before + $block + $parts.After
        if ($new -ceq $Existing) { $res.State = 'Unchanged' } else { $res.State = 'Replaced' }
        $res.Text = $new
        return $res
    }
    $res.State = 'Refused'
    $res.Reason = ('the marker lines are unbalanced or repeated (BEGIN x{0}, END x{1})' -f $bCount, $eCount)
    return $res
}

function Update-RulesFile {
    # File wrapper: strict read, backup, write, re-read, verify that nothing outside the block moved.
    # State: Created | Appended | Replaced | Unchanged | Refused.
    param([string]$Path, [string]$Rules, [string]$Begin, [string]$End, [string]$Note)
    $out = [pscustomobject]@{ State = 'Refused'; Reason = ''; Backup = $null; Bytes = 0 }
    $f = Read-TextFile $Path
    if (-not $f.Ok) { $out.Reason = 'the file ' + $f.Error; return $out }
    $existing = ''
    if ($f.Exists) { $existing = $f.Text }
    $r = Set-RulesBlock -Existing $existing -Rules $Rules -Begin $Begin -End $End -Note $Note
    if ($r.State -eq 'Refused') { $out.Reason = $r.Reason; return $out }
    if ($r.State -eq 'Unchanged') { $out.State = 'Unchanged'; return $out }
    if ($f.Exists) { $out.Backup = New-BackupCopy -Path $Path -Tag 'bak' }
    try {
        Write-TextFile -Path $Path -Text $r.Text -Bom $f.HasBom
        $chk = Read-TextFile $Path
        if (-not $chk.Ok -or ($chk.Text -cne $r.Text)) { throw 'the saved file does not match what was intended' }
        $bCount = @(Get-MarkerMatches -Text $chk.Text -Marker $Begin).Count
        $eCount = @(Get-MarkerMatches -Text $chk.Text -Marker $End).Count
        if ($bCount -ne 1 -or $eCount -ne 1) { throw 'the saved file does not contain exactly one rules block' }
        $newParts = Get-TextOutsideBlock -Text $chk.Text -Begin $Begin -End $End
        if ($null -eq $newParts -or $newParts.Block -cne $r.Block) { throw 'the saved rules block is not the intended one' }
        if ($f.Exists) {
            if ($r.State -eq 'Replaced') {
                $oldParts = Get-TextOutsideBlock -Text $existing -Begin $Begin -End $End
                if ($newParts.Before -cne $oldParts.Before -or $newParts.After -cne $oldParts.After) { throw 'text outside the rules block changed' }
            }
            else {
                if (-not $newParts.Before.StartsWith($existing, [StringComparison]::Ordinal)) { throw 'existing text was changed' }
            }
        }
        $out.Bytes = ([System.Text.Encoding]::UTF8.GetByteCount($chk.Text))
    }
    catch {
        $why = $_.Exception.Message
        try {
            if ($out.Backup) { Copy-Item -LiteralPath $out.Backup -Destination $Path -Force }
            else { Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue }
        }
        catch { $why = $why + ' (and the restore failed: ' + $_.Exception.Message + ')' }
        $out.State = 'Refused'
        $out.Reason = 'verification failed, the original was restored (' + $why + ')'
        return $out
    }
    $out.State = $r.State
    return $out
}

function Get-PinnedRules {
    # Downloads the pinned rules file and checks its SHA-256 BEFORE it is used. Returns Ok, Text, Sha256, Error.
    $res = [pscustomobject]@{ Ok = $false; Text = ''; Sha256 = ''; Error = '' }
    try { $bytes = Get-WebBytes $script:Cfg.RulesUrl }
    catch { $res.Error = 'the download failed: ' + $_.Exception.Message; return $res }
    $hash = Get-Sha256Hex $bytes
    $res.Sha256 = $hash
    if ($hash -cne $script:Cfg.RulesSha256) {
        $res.Error = ('the downloaded file does not match the expected fingerprint (got {0}, expected {1})' -f $hash, $script:Cfg.RulesSha256)
        return $res
    }
    try {
        $enc = New-Object System.Text.UTF8Encoding($false, $true)
        $text = $enc.GetString($bytes)
    }
    catch { $res.Error = 'the downloaded file is not valid UTF-8 text'; return $res }
    if ($text.Length -gt 0 -and [int]$text[0] -eq 65279) { $text = $text.Substring(1) }
    $res.Text = ($text -replace "`r`n", "`n")
    $res.Ok = $true
    return $res
}

# ======================================================================================
# Steps 1 to 4 (setup.md): this PC, the AWS command line tool, sign in, who am I
# ======================================================================================
function Get-PowerShellExe {
    $ps = Join-Path $PSHOME 'powershell.exe'
    if (Test-Path -LiteralPath $ps) { return $ps }
    return (Resolve-Exe 'powershell.exe')
}

function Find-UvTools {
    # Finds uv and uvx, also in the folder the uv installer uses (it may not be on this window's PATH yet).
    $uv = Resolve-Exe 'uv'
    if (-not $uv) {
        $dirs = @()
        if ($env:UV_INSTALL_DIR) { $dirs += $env:UV_INSTALL_DIR }
        $dirs += (Join-Rel $script:Ctx.UserHome '.local\bin')
        foreach ($d in $dirs) {
            if ((Test-Path -LiteralPath (Join-Path $d 'uv.exe')) -or (Test-Path -LiteralPath (Join-Path $d 'uv'))) {
                Add-PathFirst $d
                $uv = Resolve-Exe 'uv'
                if ($uv) { break }
            }
        }
    }
    return $uv
}

function Install-Uv {
    $ps = Get-PowerShellExe
    if (-not $ps) { Stop-Setup 'Could not find powershell.exe to run the uv installer.' }
    Out-Say '  uv is not installed yet. Installing it now (AWS tools need it). This can take a minute.'
    $cmd = "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; irm '" + $script:Cfg.UvInstallUrl + "' | iex"
    $r = Invoke-ProcessCapture -FilePath $ps -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $cmd) -TimeoutSec 300 -Heartbeat
    if ($r.Error) { Stop-Setup ('The uv installer could not start: ' + $r.Error) }
    if ($r.TimedOut) { Stop-Setup 'The uv installer took too long (more than 5 minutes).' }
    $text = (Get-Excerpt ($r.StdOut + [Environment]::NewLine + $r.StdErr) 6)
    if ($text) { Out-Say $text }
    if ($r.ExitCode -ne 0) { Stop-Setup ('The uv installer reported an error (exit code {0}). {1}' -f $r.ExitCode, $text) }
    $script:Ctx.UvJustInstalled = $true
    Update-SessionPath
}

function Get-NeededEngines {
    # Which of the script's own building blocks THIS PC will really use, decided from the AI tool folders that exist.
    # A part that this PC never uses is not even checked (a problem in it must not stop the run).
    $ctx = $script:Ctx
    $names = @(Get-DetectedAgents | ForEach-Object { $_.Name })
    $need = New-Object 'System.Collections.Generic.List[string]'
    if ($names -contains 'Codex') { $need.Add('toml') }
    $jsonAgents = @($ctx.JsonTargets | ForEach-Object { $_.Name }) + @('OpenCode')
    foreach ($n in $names) {
        if ($jsonAgents -contains $n) { $need.Add('json'); break }
    }
    if ((Test-Path -LiteralPath $ctx.CodexDir -PathType Container) -or (Test-Path -LiteralPath $ctx.ClaudeDir -PathType Container)) {
        $need.Add('rules')
        $need.Add('sha256')
    }
    return $need.ToArray()
}

function Test-EngineOff {
    # $true when a building block failed its self-check on this PC (so the script must not use it).
    param([string]$Name)
    return [bool]($script:Ctx -and $script:Ctx.EngineProblems.ContainsKey($Name))
}

function Get-EngineLabel {
    param([string]$Name)
    switch ($Name) {
        'sha256' { return 'the fingerprint (SHA-256) calculation' }
        'toml'   { return 'the editor for Codex''s settings file' }
        'json'   { return 'the editor for JSON settings files' }
        'rules'  { return 'the editor for the AWS rules block' }
        default  { return $Name }
    }
}

function Get-EngineEffect {
    # What happens, in plain words, when a building block is switched off.
    param([string]$Name)
    switch ($Name) {
        'toml'   { return 'The script will not edit Codex''s settings file itself; it will list the exact hand edit instead.' }
        'json'   { return 'The script will not edit JSON settings files itself; it will list the exact hand edits instead.' }
        default  { return 'The script will not add the AWS rules itself (Step 7); it will list what to do instead.' }
    }
}

function Get-SelfCheckPrograms {
    # Small programs that every Windows PC has, used to prove that this script can start a program and read what it
    # prints. (A separate function so that the automated tests can replace it.)
    $list = New-Object 'System.Collections.Generic.List[object]'
    $comspec = [string]$env:ComSpec
    if ($comspec -and (Test-Path -LiteralPath $comspec)) {
        $list.Add([pscustomobject]@{ Name = 'cmd.exe'; File = $comspec; Args = @('/c', 'echo', 'selfcheck-ok') })
    }
    $ps = Get-PowerShellExe
    if ($ps) {
        $list.Add([pscustomobject]@{ Name = 'powershell.exe'; File = $ps; Args = @('-NoProfile', '-NonInteractive', '-Command', 'Write-Output selfcheck-ok') })
    }
    return $list.ToArray()
}

function Test-ProgramStartProbe {
    # Every later step starts programs and reads their answers, so this is the one check that stops the run when it fails.
    # It passes when ANY of the small test programs works (two independent tries), and is skipped when none exists.
    $res = [pscustomobject]@{ Ok = $false; Skipped = $false; Detail = '' }
    $progs = @(Get-SelfCheckPrograms)
    if ($progs.Count -eq 0) { $res.Ok = $true; $res.Skipped = $true; return $res }
    $notes = New-Object 'System.Collections.Generic.List[string]'
    foreach ($p in $progs) {
        $r = Invoke-ProcessCapture -FilePath $p.File -Arguments $p.Args -TimeoutSec 60
        if (-not $r.Error -and -not $r.TimedOut -and $r.ExitCode -eq 0 -and ([string]$r.StdOut).Trim() -ceq 'selfcheck-ok') {
            $res.Ok = $true
            return $res
        }
        $notes.Add(('{0}: {1}' -f $p.Name, (Get-ShortText (([string]$r.StdOut) + ' ' + ([string]$r.StdErr) + ' ' + ([string]$r.Error) + ' exit ' + [string]$r.ExitCode) 160)))
    }
    $res.Detail = ($notes -join '; ')
    return $res
}

function Test-EngineSha256 {
    $h = Get-Sha256Hex ([System.Text.Encoding]::ASCII.GetBytes('abc'))
    if ($h -cne 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad') { return 'it gives a wrong answer' }
    return ''
}

function Test-EngineToml {
    $cfg = $script:Cfg
    $sample = New-Object 'System.Collections.Generic.List[string]'
    $sample.Add('model = "gpt-5"')
    $sample.Add('note = """')
    $sample.Add('[mcp_servers.aws-mcp]')
    $sample.Add('"""')
    $sample.Add('')
    $sample.Add('[projects.''C:\Users\x'']')
    $sample.Add('trust_level = "trusted"')
    $sample.Add('')
    $sample.Add('[mcp_servers.aws-mcp]')
    $sample.Add('command = "uvx"')
    $sample.Add('args = ["mcp-proxy-for-aws@latest", "' + $cfg.McpUrl + '"]')
    $toml = (($sample.ToArray()) -join "`r`n") + "`r`n"
    $t = Add-TomlMcpEnv -Text $toml -Server $cfg.ServerName -EnvName $cfg.EnvName -ProfileName $cfg.ProfileName
    $want = '[mcp_servers.aws-mcp.env]' + "`r`n" + $cfg.EnvName + ' = "' + $cfg.ProfileName + '"'
    if ($t.State -ne 'Patched' -or $t.Text.IndexOf($want, [StringComparison]::Ordinal) -lt 0 -or $t.Text.IndexOf('[mcp_servers.aws-mcp.env]', [StringComparison]::Ordinal) -ne $t.Text.LastIndexOf('[mcp_servers.aws-mcp.env]', [StringComparison]::Ordinal)) {
        return ('it gave an unexpected answer (' + $t.State + ' ' + $t.Reason + ')')
    }
    $e = Add-TomlMcpEntry -Text "model = `"gpt-5`"`r`n" -Server $cfg.ServerName -EnvName $cfg.EnvName -ProfileName $cfg.ProfileName -McpUrl $cfg.McpUrl -ProxyPackage $cfg.ProxyPackage
    if ($e.State -ne 'Added' -or -not $e.Text.StartsWith("model = `"gpt-5`"`r`n", [StringComparison]::Ordinal)) {
        return ('adding a whole entry gave an unexpected answer (' + $e.State + ' ' + $e.Reason + ')')
    }
    return ''
}

function Test-EngineJson {
    $json = '{"projects":{"p":{"history":["a \"}\" b"],"mcpServers":{"aws-mcp":{"command":"node"}}}},"mcpServers":{"aws-mcp":{"command":"uvx","args":["mcp-proxy-for-aws@latest"]}}}'
    $j = Add-JsonEnvToText -Text $json -ParentKey 'mcpServers' -EnvKey 'env'
    $first = $j.Text.IndexOf('"env"', [StringComparison]::Ordinal)
    if ($j.State -ne 'Patched' -or $first -lt 0 -or $first -ne $j.Text.LastIndexOf('"env"', [StringComparison]::Ordinal) -or $first -lt $j.Text.IndexOf('"mcpServers":{"aws-mcp":{"command":"uvx"', [StringComparison]::Ordinal)) {
        return ('it gave an unexpected answer (' + $j.State + ' ' + $j.Reason + ')')
    }
    return ''
}

function Test-EngineRules {
    $cfg = $script:Cfg
    $b = Set-RulesBlock -Existing "keep`r`n" -Rules "rule one`nrule two" -Begin $cfg.BeginMarker -End $cfg.EndMarker -Note $cfg.PrecedenceNote
    $b2 = Set-RulesBlock -Existing $b.Text -Rules "rule one`nrule two" -Begin $cfg.BeginMarker -End $cfg.EndMarker -Note $cfg.PrecedenceNote
    if ($b.State -ne 'Appended' -or -not $b.Text.StartsWith("keep`r`n", [StringComparison]::Ordinal) -or $b2.State -ne 'Unchanged' -or (($b.Text -replace "`r`n", '') -match "[`r`n]")) {
        return ('it gave an unexpected answer (' + $b.State + ' / ' + $b2.State + ')')
    }
    return ''
}

function Test-ScriptSelfCheck {
    # Quick checks of the script's own building blocks on THIS PC, using small samples held in memory. Changes nothing.
    # It exists because the script was tested on another kind of machine: if something behaves differently in this
    # Windows PowerShell, it shows up here, before any real file is touched. Only the parts this PC will use are checked
    # (-Need). Returns:
    #   Fatal   problems that stop everything (the script cannot start a program and read its answer)
    #   Failed  parts that did not pass (Engine, Problem). They are switched off and replaced by a hand edit; the run goes on.
    #   Passed, Skipped  names of the parts that passed, and of the parts this PC does not use (not checked)
    param([string[]]$Need = @('sha256', 'toml', 'json', 'rules'))
    $fatal = New-Object 'System.Collections.Generic.List[string]'
    $failed = New-Object 'System.Collections.Generic.List[object]'
    $passed = New-Object 'System.Collections.Generic.List[string]'
    $skipped = New-Object 'System.Collections.Generic.List[string]'
    try {
        $probe = Test-ProgramStartProbe
        if (-not $probe.Ok) { $fatal.Add('the script could not start a small test program and read its answer (' + $probe.Detail + ')') }
    }
    catch { $fatal.Add('the script could not start a small test program: ' + $_.Exception.Message) }
    foreach ($name in @('sha256', 'toml', 'json', 'rules')) {
        if ($Need -notcontains $name) { $skipped.Add($name); continue }
        $problem = ''
        try {
            switch ($name) {
                'sha256' { $problem = [string](Test-EngineSha256) }
                'toml'   { $problem = [string](Test-EngineToml) }
                'json'   { $problem = [string](Test-EngineJson) }
                'rules'  { $problem = [string](Test-EngineRules) }
            }
        }
        catch { $problem = $_.Exception.Message }
        if ($problem) { $failed.Add([pscustomobject]@{ Engine = $name; Problem = $problem }) }
        else { $passed.Add($name) }
    }
    return [pscustomobject]@{ Fatal = $fatal.ToArray(); Failed = $failed.ToArray(); Passed = $passed.ToArray(); Skipped = $skipped.ToArray() }
}

function Invoke-Step1Environment {
    Show-StepHeader 1 'Checking this PC'
    $ctx = $script:Ctx
    if (-not $ctx.IsTest) {
        if ($env:OS -ne 'Windows_NT') { Stop-Setup 'This script is for Windows only.' }
        if ($PSVersionTable.PSVersion.Major -ne 5) {
            Stop-Setup ('This script must run in Windows PowerShell 5.1, but it is running in PowerShell {0}. Right-click the file and choose "Run with PowerShell".' -f $PSVersionTable.PSVersion)
        }
    }
    if (-not $ctx.UserHome) { Stop-Setup 'Could not find your Windows user folder.' }
    Add-Detail ('Windows: {0}; PowerShell {1}; user folder {2}' -f [Environment]::OSVersion.VersionString, $PSVersionTable.PSVersion, $ctx.UserHome)
    Add-Result 'OK' 'Step 1' 'This is Windows PowerShell 5.1 on Windows.'

    $self = Test-ScriptSelfCheck -Need @(Get-NeededEngines)
    if (@($self.Fatal).Count -gt 0) {
        Stop-Setup ('The script''s own check of how it starts programs failed on this PC, so nothing was changed. Please send the log file to the CTO. Details: ' + (@($self.Fatal) -join '; '))
    }
    foreach ($f in @($self.Failed)) {
        $ctx.EngineProblems[[string]$f.Engine] = [string]$f.Problem
        Add-Detail ('self-check FAILED for {0}: {1}' -f $f.Engine, $f.Problem)
        Add-Result 'NOTE' 'Step 1' ('The script''s own check of {0} did not pass on this PC ({1}). {2} The rest of the setup carries on.' -f (Get-EngineLabel $f.Engine), $f.Problem, (Get-EngineEffect $f.Engine))
    }
    if (@($self.Failed).Count -eq 0) {
        Add-Result 'OK' 'Step 1' 'The script''s own self-check passed (it can start programs and edit the settings files it needs, safely, on this PC).'
    }
    if (@($self.Skipped).Count -gt 0) { Add-Detail ('self-check skipped for parts this PC does not use: ' + (@($self.Skipped) -join ', ')) }

    foreach ($h in @('awscli.amazonaws.com', 'raw.githubusercontent.com')) {
        if (-not (Test-TcpPort $h 443 6000)) {
            Add-Result 'NOTE' 'Step 1' ('Could not reach {0} directly. If a later step fails, check the internet connection, VPN or company proxy.' -f $h)
        }
    }

    $uv = Find-UvTools
    if (-not $uv) {
        Install-Uv
        $uv = Find-UvTools
        if (-not $uv) { Stop-Setup 'uv was installed but this window cannot find it. Close this window and run the script again.' }
    }
    $ctx.UvExe = $uv
    $v = Invoke-ProcessCapture -FilePath $uv -Arguments @('--version') -TimeoutSec 60
    $uvVersion = ''
    if ($v.ExitCode -eq 0) { $uvVersion = $v.StdOut.Trim() }
    if (-not $uvVersion) { Stop-Setup ('uv was found at {0} but did not run correctly.' -f $uv) }
    Add-Detail ('uv: {0} at {1}' -f $uvVersion, $uv)
    Add-Result 'OK' 'Step 1' ('uv is ready ({0}).' -f $uvVersion)
}

function Get-AwsExeCandidates {
    # Every aws.exe we can find: on PATH, in the per-user folder and in Program Files.
    $found = New-Object 'System.Collections.Generic.List[string]'
    foreach ($c in @(Get-Command -Name 'aws' -All -CommandType Application -ErrorAction SilentlyContinue)) { $found.Add([string]$c.Source) }
    $extra = @()
    if ($env:LOCALAPPDATA) { $extra += (Join-Rel $env:LOCALAPPDATA 'Programs\Amazon\AWSCLIV2\aws.exe') }
    if ($env:ProgramFiles) { $extra += (Join-Rel $env:ProgramFiles 'Amazon\AWSCLIV2\aws.exe') }
    foreach ($e in $extra) { if (Test-Path -LiteralPath $e) { $found.Add($e) } }
    $seen = @{}
    $unique = New-Object 'System.Collections.Generic.List[string]'
    foreach ($p in $found) {
        $k = $p.ToLowerInvariant()
        if (-not $seen.ContainsKey($k)) { $seen[$k] = $true; $unique.Add($p) }
    }
    return $unique.ToArray()
}

function Get-AwsCliVersion {
    param([string]$Exe)
    $r = Invoke-ProcessCapture -FilePath $Exe -Arguments @('--version') -TimeoutSec 60
    $raw = (([string]$r.StdOut) + ' ' + ([string]$r.StdErr))
    $m = [regex]::Match($raw, 'aws-cli/(\d+\.\d+\.\d+)')
    if ($m.Success) { return [version]$m.Groups[1].Value }
    return $null
}

function Find-BestAwsCli {
    # The newest AWS CLI among all copies on this PC.
    $best = [pscustomobject]@{ Exe = $null; Version = $null }
    foreach ($exe in (Get-AwsExeCandidates)) {
        $v = Get-AwsCliVersion $exe
        if ($null -eq $v) { continue }
        if ($null -eq $best.Version -or $v -gt $best.Version) { $best.Exe = $exe; $best.Version = $v }
    }
    return $best
}

function Get-InstallerRunCommand {
    # The command text for the child PowerShell that runs the (already signature-checked) AWS installer file.
    # The installer runs in its own PowerShell. Tls12 is switched on there too (the installer downloads files itself),
    # then the signed installer file is run by its full path and its exit code is passed on.
    param([string]$InstallerPath)
    return "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; & '" + ($InstallerPath -replace "'", "''") + "'; exit `$LASTEXITCODE"
}

function Install-AwsCli {
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('awscli-install-' + $script:Ctx.Stamp + '.ps1')
    Out-Say '  Downloading the AWS installer from AWS...'
    try { Get-WebFile $script:Cfg.InstallPs1Url $tmp }
    catch { Stop-Setup ('Could not download the AWS installer from {0}: {1}' -f $script:Cfg.InstallPs1Url, $_.Exception.Message) }
    $sig = Test-AwsInstallerSignature $tmp
    if (-not $sig.Ok) {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        Stop-Setup ('The downloaded AWS installer did not pass the signature check (status: {0}). Nothing was installed.' -f $sig.Status)
    }
    Out-Say '  The installer is signed by Amazon Web Services. Running it (this can take a few minutes)...'
    $ps = Get-PowerShellExe
    if (-not $ps) { Stop-Setup 'Could not find powershell.exe to run the AWS installer.' }
    $installCmd = Get-InstallerRunCommand $tmp
    $r = Invoke-ProcessCapture -FilePath $ps -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $installCmd) -TimeoutSec 900 -Heartbeat
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    if ($r.Error) { Stop-Setup ('The AWS installer could not start: ' + $r.Error) }
    if ($r.TimedOut) { Stop-Setup 'The AWS installer took too long (more than 15 minutes).' }
    $text = (Get-Excerpt ($r.StdOut + [Environment]::NewLine + $r.StdErr) 8)
    if ($text) { Out-Say $text }
    if ($r.ExitCode -ne 0) { Stop-Setup ('The AWS installer reported an error (exit code {0}). {1}' -f $r.ExitCode, $text) }
    Update-SessionPath
}

function Invoke-Step2AwsCli {
    Show-StepHeader 2 'Installing the AWS command line tool (AWS CLI)'
    $ctx = $script:Ctx
    $min = [version]$script:Cfg.MinAwsCli
    $best = Find-BestAwsCli
    if ($null -ne $best.Version -and $best.Version -ge $min) {
        Add-Result 'OK' 'Step 2' ('AWS CLI {0} is already installed. Nothing to install.' -f $best.Version)
    }
    else {
        if ($null -ne $best.Version) { Out-Say ('  Found AWS CLI {0}, which is older than the {1} that AWS requires. Updating it.' -f $best.Version, $min) }
        else { Out-Say '  The AWS CLI is not installed yet. Installing it for your Windows user (no administrator rights needed).' }
        Install-AwsCli
        $best = Find-BestAwsCli
        if ($null -eq $best.Version -or $best.Version -lt $min) {
            Stop-Setup ('After installing, the newest AWS CLI found is {0} (needed {1} or newer). An older AWS CLI may be in the way; send the log file to the CTO.' -f $best.Version, $min)
        }
        Add-Result 'OK' 'Step 2' ('Installed AWS CLI {0}.' -f $best.Version)
    }
    $ctx.AwsExe = $best.Exe
    $ctx.AwsVersion = [string]$best.Version
    Add-Detail ('AWS CLI: {0} at {1}' -f $best.Version, $best.Exe)
    $first = Resolve-Exe 'aws'
    if ($first -and ($first -cne $best.Exe)) {
        Add-Result 'NOTE' 'Step 2' ('Another (older) copy of the AWS CLI comes first on this PC at {0}. This script uses the newer one at {1}. If "aws --version" in a new window shows an old number, ask the CTO to remove the old copy.' -f $first, $best.Exe)
    }
}

function Get-AwsConfigValue {
    # "aws configure get <key>" for our profile. Returns the value, or $null when it is not set.
    param([string]$Key)
    $r = Invoke-ProcessCapture -FilePath $script:Ctx.AwsExe -Arguments @('configure', 'get', $Key, '--profile', $script:Cfg.ProfileName) -TimeoutSec 60
    if ($r.ExitCode -eq 0 -and $r.StdOut.Trim().Length -gt 0) { return $r.StdOut.Trim() }
    return $null
}

function Get-CallerIdentity {
    # "aws sts get-caller-identity" for our profile, as an object (Ok, Arn, Account, Error).
    $r = Invoke-ProcessCapture -FilePath $script:Ctx.AwsExe -Arguments @('sts', 'get-caller-identity', '--profile', $script:Cfg.ProfileName, '--region', $script:Cfg.Region, '--output', 'json') -TimeoutSec 90
    $o = [pscustomobject]@{ Ok = $false; Arn = ''; Account = ''; Error = ''; ExitCode = $r.ExitCode }
    if ($r.Error) { $o.Error = $r.Error; return $o }
    if ($r.TimedOut) { $o.Error = 'The check took too long.'; return $o }
    if ($r.ExitCode -ne 0) { $o.Error = (Get-Excerpt (([string]$r.StdErr) + [Environment]::NewLine + ([string]$r.StdOut)) 6); return $o }
    try {
        $j = $r.StdOut | ConvertFrom-Json
        $o.Arn = [string]$j.Arn
        $o.Account = [string]$j.Account
        $o.Ok = ($o.Arn.Length -gt 0 -and $o.Account.Length -gt 0)
        if (-not $o.Ok) { $o.Error = 'AWS gave an empty answer.' }
    }
    catch { $o.Error = 'AWS gave an answer that could not be read: ' + (Get-Excerpt $r.StdOut 3) }
    return $o
}

function Backup-AwsFiles {
    # Only the AWS config file is changed by the sign-in steps ("aws configure set" and "aws login"), so only that one
    # is backed up. The credentials file is never touched, so it is not copied (a copy would only spread its contents).
    $ctx = $script:Ctx
    $f = $ctx.AwsConfig
    if (Test-Path -LiteralPath $f -PathType Leaf) {
        $b = New-BackupCopy -Path $f -Tag 'bak'
        Out-Say ('  Backed up {0}' -f $f)
        Add-Detail ('backup: {0}' -f $b)
    }
}

function Invoke-Step3Login {
    Show-StepHeader 3 'Signing in to AWS'
    $ctx = $script:Ctx
    $cfg = $script:Cfg
    $aws = $ctx.AwsExe
    Backup-AwsFiles

    # "aws login" refuses a profile that already holds keys, SSO or assume-role settings. Say so clearly, change nothing.
    $conflicts = New-Object 'System.Collections.Generic.List[string]'
    foreach ($key in @('aws_access_key_id', 'sso_session', 'sso_account_id', 'sso_role_name', 'sso_start_url', 'role_arn', 'credential_process', 'web_identity_token_file')) {
        if ($null -ne (Get-AwsConfigValue $key)) { $conflicts.Add($key) }
    }
    if ($conflicts.Count -gt 0) {
        Stop-Setup ('The AWS profile "{0}" on this PC already has other kinds of settings ({1}), and "aws login" will not use such a profile. Nothing was changed. Send the log file to the CTO.' -f $cfg.ProfileName, ($conflicts -join ', '))
    }

    # Already signed in from an earlier run? Then the browser step can be skipped.
    $already = $false
    if ($null -ne (Get-AwsConfigValue 'login_session')) {
        $quick = Get-CallerIdentity
        if ($quick.Ok -and $quick.Arn -ceq $cfg.ExpectedArn) {
            $already = $true
            Add-Result 'OK' 'Step 3' ('You are already signed in as {0}. Skipping the browser sign-in.' -f $cfg.ExpectedUser)
        }
    }

    $r = Invoke-ProcessCapture -FilePath $aws -Arguments @('configure', 'set', 'region', $cfg.Region, '--profile', $cfg.ProfileName) -TimeoutSec 60
    if ($r.ExitCode -ne 0) { Stop-Setup ('Could not save the Region setting. {0}' -f (Get-Excerpt (([string]$r.StdErr) + ([string]$r.StdOut)) 4)) }
    Out-Say ('  Region for profile "{0}" set to {1}.' -f $cfg.ProfileName, $cfg.Region)
    if ($already) { return }

    Out-Say ''
    Out-Say 'About the sign-in: AWS says these credentials are valid for 12 hours and can be renewed for 90 days without signing in through the browser again.' 'Plain'
    Out-Say ('If a command says the session expired, run:  aws login --profile {0}' -f $cfg.ProfileName) 'Plain'
    Out-Say ''
    Out-Say ('Have ready now: the password and the security code (MFA) device of the IAM user {0}.' -f $cfg.ExpectedUser) 'Warn'
    Out-Say 'A web browser window will open. Please:' 'Plain'
    Out-Say '  1. Choose to sign in as an IAM user (NOT the root user).' 'Plain'
    Out-Say ('  2. Account ID: {0}     IAM user name: {1}' -f $cfg.AccountId, $cfg.ExpectedUser) 'Plain'
    Out-Say '  3. Enter that user''s password, finish any security code (MFA) prompt, then approve (Allow).' 'Plain'
    Out-Say '  4. Come back to this window. It carries on by itself.' 'Plain'
    Out-Say 'If this window asks (y/n) whether to overwrite an existing login session, type y and press Enter.' 'Plain'
    Out-Say 'If the browser does not open or the sign-in fails, this window offers a no-browser method (you type R).' 'Plain'
    Out-Say 'You never type an AWS key or password into this window.' 'Plain'
    Out-Say ''

    $loginEnv = @{ AWS_CLI_AGENT_TOOLKIT_HINT_DISABLED = 'true' }   # stops the CLI's own extra setup question during login
    $attempt = 0
    $useRemote = $false
    $done = $false
    while (-not $done -and $attempt -lt 3) {
        $attempt++
        $loginArgs = @('login', '--region', $cfg.Region, '--profile', $cfg.ProfileName)
        if ($useRemote) { $loginArgs += '--remote' }
        $code = Invoke-LiveCommand -FilePath $aws -Arguments $loginArgs -ExtraEnv $loginEnv
        if ($code -eq 0) { $done = $true; break }
        Out-Say ('  The sign-in did not finish (exit code {0}).' -f $code) 'Warn'
        if ($script:NoPauseMode -or $attempt -ge 3) { break }
        $ans = (Read-Answer 'Press Enter to try again, type R to try the no-browser method, or type Q to stop').Trim().ToUpperInvariant()
        if ($ans -eq 'Q') { break }
        if ($ans -eq 'R') { $useRemote = $true }
    }
    if (-not $done) {
        Stop-Setup 'The AWS sign-in did not complete. The sign-in messages are not saved in the log file, so please send a screenshot of this window (and the log file) to the CTO. You can also run this script again and finish the sign-in in the browser.'
    }
    Add-Result 'OK' 'Step 3' 'Signed in to AWS.'
}

function Remove-LoginSession {
    # Used when the wrong person signed in: "aws logout" for our profile, then a check that the sign-in is really gone.
    # Removed is $true only when the logout worked AND the profile no longer gives an identity. Detail says what went wrong.
    $ctx = $script:Ctx
    $cfg = $script:Cfg
    $res = [pscustomobject]@{ Removed = $false; Detail = '' }
    $o = Invoke-ProcessCapture -FilePath $ctx.AwsExe -Arguments @('logout', '--profile', $cfg.ProfileName) -TimeoutSec 60
    if ($o.Error) { $res.Detail = 'the logout command could not start: ' + $o.Error; return $res }
    if ($o.TimedOut) { $res.Detail = 'the logout command took too long'; return $res }
    if ($o.ExitCode -ne 0) {
        $res.Detail = ('the logout command reported an error (exit code {0}) {1}' -f $o.ExitCode, (Get-ShortText (([string]$o.StdErr) + ' ' + ([string]$o.StdOut)) 200)).Trim()
        return $res
    }
    $chk = Get-CallerIdentity
    if ($chk.Ok) { $res.Detail = 'the logout command finished, but the profile still works'; return $res }
    $res.Removed = $true
    return $res
}

function Stop-AfterWrongIdentity {
    # Every identity guard ends here: sign the wrong identity out again, check that it worked, and stop with words that
    # say what really happened (never claiming a removal that did not happen).
    param([string]$Why)
    $cfg = $script:Cfg
    $lo = Remove-LoginSession
    $outcome = 'confirmed'
    if (-not $lo.Removed) { $outcome = 'NOT confirmed (' + $lo.Detail + ')' }
    Add-Detail ('identity guard: {0} Sign-out {1}' -f $Why, $outcome)
    $again = ('Run this script again and sign in as the IAM user {0} (account ID {1}).' -f $cfg.ExpectedUser, $cfg.AccountId)
    if ($lo.Removed) {
        Stop-Setup ('{0} The sign-in was removed again. {1}' -f $Why, $again)
    }
    Stop-Setup ('{0} The sign-in could NOT be removed automatically ({1}). Please run this command now in a PowerShell window:  aws logout --profile {2}  and tell the CTO. {3}' -f $Why, $lo.Detail, $cfg.ProfileName, $again)
}

function Invoke-Step4Identity {
    Show-StepHeader 4 'Checking who you are signed in as'
    $ctx = $script:Ctx
    $cfg = $script:Cfg
    $id = Get-CallerIdentity
    if (-not $id.Ok) {
        Stop-Setup ('AWS did not accept the sign-in: {0} If it says the session expired or credentials are missing, run this script again.' -f $id.Error)
    }
    $ctx.Identity = $id
    Add-Detail ('Signed in as {0} (account {1})' -f $id.Arn, $id.Account)
    if ($id.Arn -like '*:root') {
        Stop-AfterWrongIdentity 'You signed in as the ROOT user of the AWS account. That is not allowed here.'
    }
    if ($id.Account -cne $cfg.AccountId) {
        Stop-AfterWrongIdentity ('You are signed in to AWS account {0}, but this setup is for account {1}.' -f $id.Account, $cfg.AccountId)
    }
    if ($id.Arn -cne $cfg.ExpectedArn) {
        Stop-AfterWrongIdentity ('You are signed in as {0}, but this setup is only for the IAM user {1}.' -f $id.Arn, $cfg.ExpectedUser)
    }
    Add-Result 'OK' 'Step 4' ('Signed in as {0}. This is the right account and the right (non-root) user.' -f $id.Arn)
}

# ======================================================================================
# Step 5 (setup.md): the Agent Toolkit wizard, then the "otchealth" profile for the AWS MCP server
# ======================================================================================
function Get-DetectedAgents {
    # The AI tools whose settings folder exists (these are the ones the wizard configures).
    $list = New-Object 'System.Collections.Generic.List[object]'
    foreach ($a in $script:Ctx.AgentFolders) {
        if (Test-Path -LiteralPath $a.Path -PathType Container) { $list.Add($a) }
    }
    return $list.ToArray()
}

function Invoke-Step5Preflight {
    # Looks at every file the wizard may touch BEFORE it runs. Stops (changing nothing) if the wizard would
    # overwrite or choke on something. Returns the list of existing files to back up.
    param($Detected)
    $ctx = $script:Ctx
    $cfg = $script:Cfg
    $names = @($Detected | ForEach-Object { $_.Name })
    $backupList = New-Object 'System.Collections.Generic.List[string]'

    foreach ($t in $ctx.JsonTargets) {
        $f = Read-TextFile $t.Path
        if ($f.Ok -and -not $f.Exists) { continue }
        $agentOn = ($names -contains $t.Name)
        if (-not $f.Ok) {
            if ($agentOn) { Stop-Setup ('The settings file {0} {1}, and the AWS wizard would stop on it. Nothing was changed. Send the log file to the CTO.' -f $t.Path, $f.Error) }
            continue
        }
        if (-not $agentOn) { continue }
        $backupList.Add($t.Path)
        if (Test-EngineOff 'json') { continue }   # the self-check of the JSON reader failed: back up only, no analysis
        $info = Get-JsonServerInfo -Text $f.Text -ParentKey 'mcpServers' -Server $cfg.ServerName -EnvKey 'env' -EnvName $cfg.EnvName -ProfileName $cfg.ProfileName
        if ($info.State -eq 'Invalid' -or ($info.State -eq 'Refused' -and -not $info.HasEnv)) {
            Stop-Setup ('The settings file {0} is not in the expected format ({1}), and the AWS wizard would stop on it. Nothing was changed. Send the log file to the CTO.' -f $t.Path, $info.Reason)
        }
    }

    if ($names -contains 'OpenCode') {
        $f = Read-TextFile $ctx.OpenCodeJson
        if ($f.Exists) {
            if (-not $f.Ok) { Stop-Setup ('The settings file {0} {1}, and the AWS wizard would stop on it. Nothing was changed.' -f $ctx.OpenCodeJson, $f.Error) }
            $backupList.Add($ctx.OpenCodeJson)
            if (-not (Test-EngineOff 'json')) {
                $info = Get-JsonServerInfo -Text $f.Text -ParentKey 'mcp' -Server $cfg.ServerName -EnvKey 'environment' -EnvName $cfg.EnvName -ProfileName $cfg.ProfileName
                if ($info.State -eq 'Invalid' -or ($info.State -eq 'Refused' -and -not $info.HasEnv)) {
                    Stop-Setup ('The settings file {0} is not in the expected format ({1}), and the AWS wizard would stop on it. Nothing was changed.' -f $ctx.OpenCodeJson, $info.Reason)
                }
            }
        }
    }

    if ($names -contains 'Codex') {
        $f = Read-TextFile $ctx.CodexConfig
        if (-not $f.Ok) { Stop-Setup ('Codex''s settings file {0} {1}. Nothing was changed. Send the log file to the CTO.' -f $ctx.CodexConfig, $f.Error) }
        $cliCheck = $true
        if ($f.Exists -and (Test-EngineOff 'toml')) {
            $backupList.Add($ctx.CodexConfig)   # the self-check of the Codex settings reader failed: back up only, no analysis
        }
        elseif ($f.Exists) {
            $backupList.Add($ctx.CodexConfig)
            $info = Get-TomlServerInfo -Text $f.Text -Server $cfg.ServerName -EnvName $cfg.EnvName -ProfileName $cfg.ProfileName
            if ($info.State -eq 'Ready' -or $info.State -eq 'AlreadyOk') {
                # An "aws-mcp" entry exists already. Only the plain one from AWS may be completed automatically.
                if (-not $info.Looks) {
                    Stop-Setup ('Codex already has an "aws-mcp" entry that is not the plain one from AWS (for example it has extra settings). Per AWS''s instructions, ask the CTO how to reconcile it, so nothing was changed. File: {0}' -f $ctx.CodexConfig)
                }
                $cliCheck = $false
            }
            elseif ($info.State -eq 'Refused' -and -not $info.Reason.StartsWith('the file could not be read safely', [StringComparison]::Ordinal)) {
                Stop-Setup ('Codex''s settings file already has an "aws-mcp" entry that needs a person to look at it. Reason: {0}. Nothing was changed. Ask the CTO how to reconcile it. File: {1}' -f $info.Reason, $ctx.CodexConfig)
            }
            elseif ($info.State -eq 'Refused') {
                Add-Result 'NOTE' 'Step 5' ('This script could not fully read Codex''s settings file ({0}). The AWS wizard will still run, but the otchealth setting may need a hand edit afterwards.' -f $info.Reason)
            }
        }
        if ($cliCheck -and $ctx.CodexExe) {
            $l = Invoke-ProcessCapture -FilePath $ctx.CodexExe -Arguments @('mcp', 'list') -TimeoutSec 60
            if ($l.ExitCode -eq 0 -and ([string]$l.StdOut) -match '(?m)(^|\s)aws-mcp(\s|$)') {
                Stop-Setup 'Codex reports an "aws-mcp" server that is not in its settings file (it may come from a plugin or a project). Adding the AWS entry could clash with it, so nothing was changed. Ask the CTO how to reconcile it.'
            }
            if ($l.ExitCode -ne 0) {
                Add-Result 'NOTE' 'Step 5' 'Could not ask Codex for its list of MCP servers (the "codex mcp list" check). Continuing.'
            }
        }
    }
    return $backupList.ToArray()
}

function Invoke-Step5Wizard {
    $ctx = $script:Ctx
    $cfg = $script:Cfg
    Out-Say '  Running the AWS Agent Toolkit wizard. It installs the default AWS skills and adds the AWS MCP server. This can take a few minutes...'
    # For Codex the wizard runs "codex mcp add" and crashes if that command fails. So "codex" is hidden from the wizard's
    # PATH for this one command: the wizard then skips Codex (as it does on a PC without Codex), and this script adds the
    # standard entry afterwards, in a checked way (see Invoke-Step5PatchCodex).
    $wizardEnv = $null
    $hide = Get-PathWithoutProgram -Name 'codex' -PathValue ([Environment]::GetEnvironmentVariable('PATH'))
    if (@($hide.Removed).Count -gt 0) {
        $wizardEnv = @{ PATH = $hide.Path }
        $ctx.CodexHidden = $true
        Add-Detail ('codex hidden from the wizard (these folders were left out of its PATH): ' + (@($hide.Removed) -join '; '))
        Out-Say '  (The "codex" command is hidden from the wizard for this one step, so it cannot fail halfway through. This script adds the AWS entry to Codex''s settings itself afterwards.)'
    }
    $r = Invoke-ProcessCapture -FilePath $ctx.AwsExe -Arguments @('configure', 'agent-toolkit', '--yes', '--region', $cfg.ToolkitRegion, '--profile', $cfg.ProfileName) -TimeoutSec 900 -Heartbeat -ExtraEnv $wizardEnv
    if ($r.Error) { Stop-Setup ('The AWS wizard could not start: ' + $r.Error) }
    if ($r.TimedOut) { Stop-Setup 'The AWS wizard took too long (more than 15 minutes). Run this script again.' }
    $text = ([string]$r.StdOut).TrimEnd()
    if ($text) { Out-Say $text }
    $err = ([string]$r.StdErr).Trim()
    if ($err) { Out-Say (Get-Excerpt $err 10) 'Warn' }
    if ($r.ExitCode -ne 0) {
        Stop-Setup ('The AWS wizard stopped with an error (exit code {0}). {1} If it mentions credentials or an expired session, run: aws login --profile {2}  and then run this script again.' -f $r.ExitCode, (Get-Excerpt ($err + [Environment]::NewLine + $text) 6), $cfg.ProfileName)
    }
    $count = ''
    $m = [regex]::Match($text, 'Installing (\d+) default AWS skills')
    if ($m.Success) { $count = $m.Groups[1].Value }
    if ($count) { Add-Result 'OK' 'Step 5' ('AWS Agent Toolkit wizard finished. {0} default AWS skills installed.' -f $count) }
    else { Add-Result 'OK' 'Step 5' 'AWS Agent Toolkit wizard finished.' }
    return $r
}

function Get-JsonEngineOffHandEdit {
    # Used when the JSON reader failed its self-check on this PC: a file is not edited by the script at all.
    param([string]$Path, [string]$ProfileName = 'otchealth')
    $l = New-Object 'System.Collections.Generic.List[string]'
    $l.Add('This file was not changed by the script. If it has an "aws-mcp" entry, do the following:')
    $l.Add((Get-JsonEnvHandEdit $Path $ProfileName))
    return (Join-Lines $l.ToArray())
}

function Invoke-Step5PatchJson {
    param($Detected = $null)
    $ctx = $script:Ctx
    $cfg = $script:Cfg
    if (Test-EngineOff 'json') {
        # The JSON reader did not pass its self-check on this PC: no JSON file is edited by the script.
        $names = @($Detected | ForEach-Object { $_.Name })
        foreach ($t in $ctx.JsonTargets) {
            if ($null -ne $Detected -and $names -notcontains $t.Name) { continue }
            $f = Read-TextFile $t.Path
            if (-not $f.Exists) { continue }
            Add-Manual $t.Path 'the script''s own check of the JSON settings editor did not pass on this PC, so the file was not edited' (Get-JsonEngineOffHandEdit $t.Path $cfg.ProfileName)
        }
        return
    }
    foreach ($t in $ctx.JsonTargets) {
        $f = Read-TextFile $t.Path
        if (-not $f.Exists -or -not $f.Ok) { continue }
        $info = Get-JsonServerInfo -Text $f.Text -ParentKey 'mcpServers' -Server $cfg.ServerName -EnvKey 'env' -EnvName $cfg.EnvName -ProfileName $cfg.ProfileName
        if ($info.State -eq 'NotFound' -or $info.State -eq 'Invalid') { continue }
        if ($info.State -eq 'Ready' -and -not $info.Looks) {
            Add-Manual $t.Path 'an existing aws-mcp entry is not the standard AWS one; AWS says to ask how to reconcile it' (Get-JsonEnvHandEdit $t.Path $cfg.ProfileName)
            continue
        }
        $r = Add-ProfileEnv -Path $t.Path -ParentKey 'mcpServers' -Server $cfg.ServerName -EnvKey 'env' -EnvName $cfg.EnvName -ProfileName $cfg.ProfileName
        if ($r.State -eq 'Patched') {
            Add-Result 'OK' 'Step 5' ('{0}: added the {1} profile to the aws-mcp entry in {2}' -f $t.Name, $cfg.ProfileName, $t.Path)
            Add-Detail ('{0}: env added ({1}); backup {2}' -f $t.Name, $t.Path, $r.Backup)
        }
        elseif ($r.State -eq 'AlreadyOk') {
            Add-Result 'OK' 'Step 5' ('{0}: the aws-mcp entry already uses the {1} profile ({2})' -f $t.Name, $cfg.ProfileName, $t.Path)
        }
        elseif ($r.State -eq 'Refused' -or $r.State -eq 'Invalid') {
            Add-Manual $t.Path $r.Reason (Get-JsonEnvHandEdit $t.Path $cfg.ProfileName)
        }
    }
}

function Invoke-Step5PatchOpenCode {
    param($Detected = $null)
    $ctx = $script:Ctx
    $cfg = $script:Cfg
    $f = Read-TextFile $ctx.OpenCodeJson
    if (-not $f.Exists -or -not $f.Ok) { return }
    if (Test-EngineOff 'json') {
        $names = @($Detected | ForEach-Object { $_.Name })
        if ($null -eq $Detected -or $names -contains 'OpenCode') {
            Add-Manual $ctx.OpenCodeJson 'the script''s own check of the JSON settings editor did not pass on this PC, so the file was not edited' (Get-OpenCodeHandEdit $ctx.OpenCodeJson $cfg.ProfileName)
        }
        return
    }
    $info = Get-JsonServerInfo -Text $f.Text -ParentKey 'mcp' -Server $cfg.ServerName -EnvKey 'environment' -EnvName $cfg.EnvName -ProfileName $cfg.ProfileName
    if ($info.State -eq 'NotFound' -or $info.State -eq 'Invalid') { return }
    if ($info.State -eq 'AlreadyOk') {
        Add-Result 'OK' 'Step 5' ('OpenCode: the aws-mcp entry already uses the {0} profile' -f $cfg.ProfileName)
        return
    }
    Add-Manual $ctx.OpenCodeJson 'OpenCode uses its own settings format, so this one is left for a hand edit' (Get-OpenCodeHandEdit $ctx.OpenCodeJson $cfg.ProfileName)
}

function Test-CodexEnvViaCli {
    # Asks Codex itself what it will pass to the aws-mcp server. Returns 'yes', 'no' or 'unknown'.
    $ctx = $script:Ctx
    $cfg = $script:Cfg
    if (-not $ctx.CodexExe) { return 'unknown' }
    $r = Invoke-ProcessCapture -FilePath $ctx.CodexExe -Arguments @('mcp', 'get', $cfg.ServerName, '--json') -TimeoutSec 60
    if ($r.ExitCode -ne 0) { return 'unknown' }
    try { $j = ([string]$r.StdOut) | ConvertFrom-Json } catch { return 'unknown' }
    try {
        $v = $j.transport.env.($cfg.EnvName)
        if ($null -eq $v) { return 'no' }
        $tokens = @(([string]$v) -split '\s+' | Where-Object { $_.Length -gt 0 })
        if ($tokens -ccontains $cfg.ProfileName) { return 'yes' }
        return 'no'
    }
    catch { return 'unknown' }
}

function Get-CodexEitherHandEdit {
    # Hand edit for the case where the script did not look into config.toml at all (so it does not know whether an
    # aws-mcp entry exists): one text for each possibility.
    param([string]$ConfigPath, [string]$ProfileName = 'otchealth')
    $l = New-Object 'System.Collections.Generic.List[string]'
    $l.Add('This file was not changed by the script. First look in it for a line that says [mcp_servers.aws-mcp].')
    $l.Add('IF THERE IS NO SUCH LINE:')
    $l.Add((Get-CodexFullHandEdit $ConfigPath $ProfileName))
    $l.Add('IF THERE IS SUCH A LINE:')
    $l.Add((Get-CodexEnvHandEdit $ConfigPath $ProfileName))
    return (Join-Lines $l.ToArray())
}

function Invoke-Step5PatchCodex {
    param($Detected)
    $ctx = $script:Ctx
    $cfg = $script:Cfg
    $names = @($Detected | ForEach-Object { $_.Name })
    if ($names -notcontains 'Codex') { return }
    if (Test-EngineOff 'toml') {
        # The reader for Codex's settings file did not pass its self-check on this PC: the file is not edited by the script.
        Add-Manual $ctx.CodexConfig 'the script''s own check of the Codex settings editor did not pass on this PC, so the file was not edited' (Get-CodexEitherHandEdit $ctx.CodexConfig $cfg.ProfileName)
        return
    }
    $r = Update-CodexConfigEnv -Path $ctx.CodexConfig -Server $cfg.ServerName -EnvName $cfg.EnvName -ProfileName $cfg.ProfileName
    if ($r.State -eq 'Patched') {
        $ctx.CodexPatched = $true
        Add-Result 'OK' 'Step 5' ('Codex: added the {0} profile to the aws-mcp entry in {1}' -f $cfg.ProfileName, $ctx.CodexConfig)
        Add-Detail ('Codex config: env added ({0}); backup {1}' -f $ctx.CodexConfig, $r.Backup)
    }
    elseif ($r.State -eq 'AlreadyOk') {
        $ctx.CodexPatched = $true
        Add-Result 'OK' 'Step 5' ('Codex: the aws-mcp entry already uses the {0} profile' -f $cfg.ProfileName)
    }
    elseif ($r.State -eq 'NotFound') {
        # The wizard wrote no entry for Codex ("codex" was hidden from it, or is not installed). Add the same standard
        # entry ourselves, with the profile (insert only, then read back and checked).
        $a = Add-CodexEntryToFile -Path $ctx.CodexConfig -Server $cfg.ServerName -EnvName $cfg.EnvName -ProfileName $cfg.ProfileName -McpUrl $cfg.McpUrl -ProxyPackage $cfg.ProxyPackage
        if ($a.State -ne 'Added') {
            Add-Manual $ctx.CodexConfig ('the AWS wizard does not write Codex''s entry in this setup, and the entry could not be added safely by this script: ' + $a.Reason) (Get-CodexFullHandEdit $ctx.CodexConfig $cfg.ProfileName)
            return
        }
        $ctx.CodexPatched = $true
        $howDone = 'added to the existing file'
        if ($a.Created) { $howDone = 'created as a new file' }
        $because = 'The AWS wizard did not write it (the "codex" command was not found, so the wizard skipped Codex).'
        if ($ctx.CodexHidden) { $because = 'The AWS wizard was kept away from Codex on purpose (so that it cannot fail halfway).' }
        Add-Result 'OK' 'Step 5' ('Codex: added the standard AWS entry, with the {0} profile, to {1}. {2} This script wrote the same entry itself.' -f $cfg.ProfileName, $ctx.CodexConfig, $because)
        $detail = ('Codex config: aws-mcp entry {0} ({1})' -f $howDone, $ctx.CodexConfig)
        if ($a.Backup) { $detail = $detail + '; backup ' + $a.Backup }
        Add-Detail $detail
    }
    else {
        Add-Manual $ctx.CodexConfig $r.Reason (Get-CodexEnvHandEdit $ctx.CodexConfig $cfg.ProfileName)
        return
    }
    if (-not $ctx.CodexExe) { return }
    $viaCli = Test-CodexEnvViaCli
    if ($viaCli -eq 'yes') { Add-Result 'OK' 'Step 5' 'Codex itself reports the otchealth profile for aws-mcp ("codex mcp get").' }
    elseif ($viaCli -eq 'no') { Add-Result 'ACTION' 'Step 5' 'The settings file looks right, but "codex mcp get aws-mcp" does not show the otchealth profile. Please send the log file to the CTO.' }
    else { Add-Result 'NOTE' 'Step 5' 'Could not double-check with "codex mcp get" (this is only an extra check).' }
}

function Invoke-Step5Prewarm {
    # The first start of the AWS MCP proxy downloads it and can take longer than Codex waits (10 seconds),
    # so run it once now. Never fatal.
    $uvx = Resolve-Exe 'uvx'
    if (-not $uvx) {
        Add-Result 'NOTE' 'Step 5' 'Could not find "uvx" on the PATH of this window. Close and reopen Codex after this finishes (if it still cannot start the AWS tool, sign out of Windows and back in).'
        return
    }
    Out-Say '  Warming up the AWS MCP proxy once, so Codex does not time out the first time it starts it (up to a minute)...'
    $r = Invoke-ProcessCapture -FilePath $uvx -Arguments @('mcp-proxy-for-aws@latest', '--help') -TimeoutSec 300 -Heartbeat
    if ($r.ExitCode -eq 0) { Add-Result 'OK' 'Step 5' 'The AWS MCP proxy is downloaded and ready.' }
    else { Add-Result 'NOTE' 'Step 5' ('The warm-up of the AWS MCP proxy did not finish ({0}). The first start inside Codex may be slow.' -f (Get-Excerpt (([string]$r.StdErr) + ([string]$r.Error)) 3)) }
}

function Invoke-Step5Toolkit {
    Show-StepHeader 5 'Setting up the Agent Toolkit (AWS skills and AWS MCP server)'
    $ctx = $script:Ctx
    $detected = @(Get-DetectedAgents)
    if ($detected.Count -eq 0) {
        Stop-Setup ('No supported AI tool settings folder was found in {0} (for example .codex). The AWS wizard needs at least one, so nothing was changed. Send the log file to the CTO.' -f $ctx.UserHome)
    }
    Out-Say ('  The wizard will set up: {0}' -f ((@($detected | ForEach-Object { $_.Name })) -join ', '))
    Add-Detail ('Agents detected: {0}' -f ((@($detected | ForEach-Object { $_.Name })) -join ', '))
    $running = @(Get-RunningAgentApps)
    if ($running.Count -gt 0) {
        Out-Say ('  These apps are open right now: {0}. Please close them if you can; they can overwrite the settings this script writes.' -f ($running -join ', ')) 'Warn'
    }
    $ctx.CodexExe = Resolve-Exe 'codex'
    $namesNow = @($detected | ForEach-Object { $_.Name })
    if (($namesNow -contains 'Codex') -and -not $ctx.CodexExe) {
        Add-Result 'NOTE' 'Step 5' 'The "codex" command was not found on this PC''s PATH, so the AWS wizard will skip Codex (it will say so). This script will add the AWS tool to Codex''s settings file itself afterwards.'
    }
    elseif (($namesNow -contains 'Codex') -and $ctx.CodexExe) {
        Add-Result 'NOTE' 'Step 5' ('The "codex" command was found ({0}). It is hidden from the AWS wizard for this one step, and this script adds the AWS tool to Codex''s settings file itself afterwards.' -f $ctx.CodexExe)
    }

    $toBackup = @(Invoke-Step5Preflight $detected)
    foreach ($p in $toBackup) {
        $b = New-BackupCopy -Path $p -Tag 'bak'
        Out-Say ('  Backed up {0}' -f $p)
        Add-Detail ('backup: {0}' -f $b)
    }

    [void](Invoke-Step5Wizard)
    Invoke-Step5PatchJson $detected
    Invoke-Step5PatchOpenCode $detected
    Invoke-Step5PatchCodex $detected
    Invoke-Step5Prewarm
    # Accepted risk (recorded for the CTO): the entry that AWS's wizard writes runs "uvx mcp-proxy-for-aws@latest", which is
    # not pinned to one version. setup.md says the generated arguments must not be changed, so it is kept as AWS writes it.
    Add-Detail 'Accepted risk: the AWS MCP entry runs "uvx mcp-proxy-for-aws@latest" (not pinned to one version) with the otchealth sign-in every time Codex starts. This is exactly what AWS''s own wizard writes, and setup.md says not to change the generated arguments.'
    Out-Say ''
    Out-Say 'To use another AWS account later: run  aws login --profile <name>,  add that profile name to the space-separated AWS_MCP_PROXY_PROFILES list in each MCP configuration file, and restart your AI tool.' 'Plain'
}

# ======================================================================================
# Steps 6 and 7 (setup.md): check the skill catalog, add the AWS rules
# ======================================================================================
function Invoke-Step6Verify {
    Show-StepHeader 6 'Checking the AWS skill catalog'
    $ctx = $script:Ctx
    $cfg = $script:Cfg
    $r = Invoke-ProcessCapture -FilePath $ctx.AwsExe -Arguments @('agent-toolkit', 'list-available-skills', '--region', $cfg.ToolkitRegion, '--profile', $cfg.ProfileName) -TimeoutSec 120
    if ($r.Error -or $r.TimedOut -or $r.ExitCode -ne 0) {
        $why = (Get-Excerpt (([string]$r.StdErr) + [Environment]::NewLine + ([string]$r.StdOut) + [Environment]::NewLine + ([string]$r.Error)) 5)
        Add-Result 'ACTION' 'Step 6' ('Could not read the AWS skill catalog. {0} If it says the session expired, run: aws login --profile {1}  (then run this script again). If it says "invalid choice", the AWS CLI is too old.' -f $why, $cfg.ProfileName)
        return
    }
    $skills = $null
    try {
        $j = ([string]$r.StdOut) | ConvertFrom-Json
        if ($null -ne $j -and $j.PSObject.Properties['skills']) { $skills = @($j.skills) }
        elseif ($j -is [array]) { $skills = @($j) }
    }
    catch { $skills = $null }
    if ($null -eq $skills) {
        Add-Result 'NOTE' 'Step 6' 'The AWS skill catalog answered, but its answer could not be counted. That is fine.'
        return
    }
    $names = @($skills | Select-Object -First 5 | ForEach-Object { [string]$_.name })
    Add-Result 'OK' 'Step 6' ('The AWS skill catalog is reachable: {0} skills available (for example: {1}).' -f $skills.Count, ($names -join ', '))
}

function Get-RulesHandEdit {
    param([string]$Path, [string]$Why)
    $l = New-Object 'System.Collections.Generic.List[string]'
    $l.Add('Open this file in Notepad: ' + $Path)
    $l.Add('The AWS rules block could not be added automatically (' + $Why + ').')
    $l.Add('Make sure the file has exactly one line  ' + $script:Cfg.BeginMarker + '  followed later by exactly one line  ' + $script:Cfg.EndMarker + '  (or neither).')
    $l.Add('Then run this script again, or ask the CTO to do it.')
    return (Join-Lines $l.ToArray())
}

function Invoke-Step7Rules {
    Show-StepHeader 7 'Adding the AWS rules for your AI tools'
    $ctx = $script:Ctx
    $cfg = $script:Cfg
    foreach ($e in @('sha256', 'rules')) {
        if (Test-EngineOff $e) {
            Add-Result 'ACTION' 'Step 7' ('The AWS rules were NOT added: the script''s own check of {0} did not pass on this PC. Please ask the CTO to add them.' -f (Get-EngineLabel $e))
            return
        }
    }
    $rules = Get-PinnedRules
    if (-not $rules.Ok) {
        Add-Result 'ACTION' 'Step 7' ('The AWS rules were NOT added: {0}. Run this script again later, or ask the CTO.' -f $rules.Error)
        return
    }
    Add-Detail ('Rules: aws/agent-toolkit-for-aws commit {0}, rules/aws-agent-rules.md, sha256 {1}' -f $cfg.RulesCommit, $rules.Sha256)
    $targets = New-Object 'System.Collections.Generic.List[object]'
    if (Test-Path -LiteralPath $ctx.CodexDir -PathType Container) {
        $targets.Add([pscustomobject]@{ Name = 'Codex'; Path = $ctx.CodexAgents; IsCodex = $true })
    }
    if (Test-Path -LiteralPath $ctx.ClaudeDir -PathType Container) {
        $targets.Add([pscustomobject]@{ Name = 'Claude Code'; Path = $ctx.ClaudeMd; IsCodex = $false })
    }
    if ($targets.Count -eq 0) {
        Add-Result 'NOTE' 'Step 7' 'Neither a Codex nor a Claude Code settings folder exists, so there was nowhere to put the AWS rules.'
        return
    }
    foreach ($t in $targets) {
        $r = Update-RulesFile -Path $t.Path -Rules $rules.Text -Begin $cfg.BeginMarker -End $cfg.EndMarker -Note $cfg.PrecedenceNote
        if ($r.State -eq 'Created') {
            Add-Result 'OK' 'Step 7' ('{0}: created {1} with the AWS rules.' -f $t.Name, $t.Path)
            $ctx.RulesApplied = $true
        }
        elseif ($r.State -eq 'Appended') {
            Add-Result 'OK' 'Step 7' ('{0}: added the AWS rules block to the end of {1}. Your existing text was kept.' -f $t.Name, $t.Path)
            $ctx.RulesApplied = $true
        }
        elseif ($r.State -eq 'Replaced') {
            Add-Result 'OK' 'Step 7' ('{0}: refreshed the AWS rules block in {1}. Only the text between the marker lines changed.' -f $t.Name, $t.Path)
            $ctx.RulesApplied = $true
        }
        elseif ($r.State -eq 'Unchanged') {
            Add-Result 'OK' 'Step 7' ('{0}: the AWS rules in {1} are already up to date.' -f $t.Name, $t.Path)
            $ctx.RulesApplied = $true
        }
        else {
            Add-Manual $t.Path ('AWS rules not added: ' + $r.Reason) (Get-RulesHandEdit $t.Path $r.Reason)
            continue
        }
        if ($r.Backup) { Add-Detail ('backup: {0}' -f $r.Backup) }
        if ($r.Bytes -gt 32768 -and $t.IsCodex) {
            Add-Result 'NOTE' 'Step 7' 'AGENTS.md is now larger than 32 KiB. Codex stops reading instructions at 32 KiB by default, so the end of the file may be ignored.'
        }
    }
    $ov = Read-TextFile $ctx.CodexOverride
    if ($ov.Ok -and $ov.Exists -and $ov.Text.Trim().Length -gt 0) {
        Add-Result 'ACTION' 'Step 7' ('Codex reads {0} instead of AGENTS.md whenever that file has text in it, so the AWS rules in AGENTS.md will be ignored by Codex. Please tell the CTO.' -f $ctx.CodexOverride)
    }
}

# ======================================================================================
# The ending: plain-English summary, log handling and the main flow
# ======================================================================================
function Get-DetailBlockText {
    # Everything the CTO may want to see (no secrets). It goes into the log file only, not onto the closing screen.
    $ctx = $script:Ctx
    $cfg = $script:Cfg
    $outcome = 'complete'
    if ($ctx.Fatal) { $outcome = 'did not finish' }
    elseif (@($ctx.Results | Where-Object { $_.Level -eq 'ACTION' -or $_.Level -eq 'FAIL' }).Count -gt 0 -or $ctx.Manual.Count -gt 0) { $outcome = 'finished, but some items need attention' }
    $l = New-Object 'System.Collections.Generic.List[string]'
    $l.Add('==================== DETAILS FOR THE CTO (no secrets) ====================')
    $l.Add(('script version {0}; rules commit {1}; outcome: {2}' -f $cfg.ScriptVersion, $cfg.RulesCommit, $outcome))
    if ($ctx.Fatal) { $l.Add('What stopped the setup: ' + $ctx.FatalText) }
    foreach ($d in $ctx.Details) { $l.Add($d) }
    if ($ctx.Backups.Count -gt 0) {
        $l.Add('Backups of every file that was changed (to undo a change, copy the backup over the file):')
        foreach ($b in $ctx.Backups) { $l.Add('  ' + $b) }
    }
    else { $l.Add('No existing file needed a backup.') }
    if ($ctx.Manual.Count -gt 0) {
        $l.Add('Hand edits still to do (exact steps):')
        $n = 0
        foreach ($m in $ctx.Manual) {
            $n++
            $l.Add(('  {0}. {1}' -f $n, $m.File))
            $l.Add(('     Why: {0}' -f $m.Why))
            foreach ($line in ($m.Fix -split "\r?\n")) { $l.Add('     ' + $line) }
        }
    }
    $l.Add('Results of every step:')
    foreach ($res in $ctx.Results) { $l.Add(('  [{0}] {1}: {2}' -f $res.Level, $res.Step, $res.Text)) }
    return (Join-Lines $l.ToArray())
}

function Show-FinalSummary {
    # The closing screen is kept SHORT, so that the banner is the last thing that scrolls by: the banner, two or three
    # plain instructions, and the log file name. The details for the CTO are written to the log file instead
    # (see Invoke-Main). Only when no log file could be written are they shown here, ABOVE the banner.
    $ctx = $script:Ctx
    $attention = @($ctx.Results | Where-Object { $_.Level -eq 'ACTION' -or $_.Level -eq 'FAIL' })
    if (-not $ctx.LogPath) {
        Out-Say ''
        Out-Say 'No log file could be written (the folder was not writable), so the details for the CTO are shown here:' 'Warn'
        Out-Say (Get-DetailBlockText) 'Info'
    }
    Out-Say ''
    Out-Say '==================================================================' 'Head'
    if ($ctx.Fatal) {
        Out-Say ' SETUP DID NOT FINISH' 'Bad'
        Out-Say '==================================================================' 'Head'
        Out-Say 'What stopped it:' 'Plain'
        Out-Say ('  ' + (Get-ShortText $ctx.FatalText 500)) 'Bad'
        Out-Say 'What to do: run this script again. If it stops the same way, send the log file named below (and a screenshot of this window) to the CTO.' 'Plain'
    }
    elseif ($attention.Count -gt 0 -or $ctx.Manual.Count -gt 0) {
        Out-Say ' SETUP FINISHED, BUT SOME ITEMS NEED ATTENTION' 'Warn'
        Out-Say '==================================================================' 'Head'
        Out-Say 'Most of the work is done. These items need a person:' 'Plain'
        $shown = 0
        foreach ($a in $attention) {
            if ($shown -ge 5) { break }
            Out-Say ('  * ' + (Get-ShortText $a.Text 300)) 'Warn'
            $shown++
        }
        $more = $attention.Count - $shown
        if ($more -gt 0) { Out-Say ('  ... and {0} more (they are in the log file).' -f $more) 'Warn' }
        Out-Say '1. Send the log file named below to the CTO. It holds the exact steps for each item.' 'Plain'
        Out-Say '2. Close Codex completely and open it again (and any other AI tool that was open), so that it picks up what was installed.' 'Plain'
    }
    else {
        Out-Say ' SETUP IS COMPLETE' 'Good'
        Out-Say '==================================================================' 'Head'
        Out-Say '1. Close Codex completely and open it again (and any other AI tool that was open).' 'Plain'
        Out-Say '2. Then ask it this safe first question (it only reads):  "List the AWS skills you have, then tell me which AWS account and user you are connected as."' 'Plain'
        if ($ctx.UvJustInstalled) {
            Out-Say '3. The uv tool was installed during this run. If Codex says it cannot start the AWS tool, sign out of Windows and sign back in once, then open Codex again.' 'Plain'
        }
    }
    if ($ctx.LogPath) { Out-Say ('Log file (send it to the CTO if something went wrong): {0}' -f $ctx.LogPath) 'Plain' }
}

function Start-SetupLog {
    # Starts the transcript next to the script (or in a fallback folder). Returns the log path, or ''.
    # The empty log file is created first, as a test of the folder: Windows PowerShell 5.1 starts a transcript WITHOUT any
    # error even when the file cannot be created there (a folder that does not exist, or one that cannot be written to),
    # and the closing screen would then point at a log file that is not there.
    param([string]$ScriptDir, [string]$Stamp, [string]$UserHome)
    $name = 'aws-toolkit-setup-log-' + $Stamp + '.txt'
    foreach ($d in @($ScriptDir, [System.IO.Path]::GetTempPath(), $UserHome)) {
        if (-not $d) { continue }
        $p = Join-Path $d $name
        $created = $false
        try {
            if (-not [System.IO.File]::Exists($p)) {
                [System.IO.File]::WriteAllText($p, '')
                $created = $true
            }
            Start-Transcript -Path $p -ErrorAction Stop | Out-Null
            return $p
        }
        catch {
            if ($created) { try { [System.IO.File]::Delete($p) } catch { } }
        }
    }
    return ''
}

function Invoke-SetupStep {
    param([string]$Name, [string]$Function, [bool]$Fatal)
    try {
        & $Function
    }
    catch {
        $msg = $_.Exception.Message
        $unexpected = -not ($_.Exception -is [System.InvalidOperationException])
        if ($unexpected -and $_.InvocationInfo) { $msg = '{0} (script line {1})' -f $msg, $_.InvocationInfo.ScriptLineNumber }
        Add-Result 'FAIL' $Name $msg
        if ($Fatal) { $script:Ctx.Fatal = $true; $script:Ctx.FatalText = $msg }
    }
}

function Invoke-Main {
    param([string]$ScriptDir, [switch]$NoPause)
    $script:NoPauseMode = [bool]$NoPause
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
    $userHome = $env:USERPROFILE
    if (-not $userHome) { $userHome = $HOME }
    $script:Ctx = New-SetupContext -UserHome $userHome -ScriptDir $ScriptDir -ClaudeConfigDir ([string]$env:CLAUDE_CONFIG_DIR) -CodexHome ([string]$env:CODEX_HOME) -AwsConfigFile ([string]$env:AWS_CONFIG_FILE) -AwsCredentialsFile ([string]$env:AWS_SHARED_CREDENTIALS_FILE) -IsTest:$script:TestModeFlag
    $ctx = $script:Ctx
    $exitCode = 0
    $ctx.LogPath = Start-SetupLog -ScriptDir $ScriptDir -Stamp $ctx.Stamp -UserHome $userHome
    try {
        Out-Say '==================================================================' 'Head'
        Out-Say ' AWS Agent Toolkit setup for OTCHealth' 'Head'
        Out-Say ('   AWS profile: {0}    Region: {1}    Account: {2}' -f $script:Cfg.ProfileName, $script:Cfg.Region, $script:Cfg.AccountId) 'Head'
        Out-Say '==================================================================' 'Head'
        Out-Say ''
        Out-Say 'This sets up the AWS tools for your AI assistant (Codex). It takes about 5 to 10 minutes.' 'Plain'
        Out-Say 'It opens your web browser once, so you can sign in to AWS as the IAM user otchealth-ai-reader.' 'Plain'
        Out-Say 'Have ready: that user''s password and its security code (MFA) device. You type them in the browser only.' 'Warn'
        Out-Say 'You never type an AWS key or password into this window.' 'Plain'
        Out-Say 'Every file it changes is backed up first, and a log file is saved next to this script.' 'Plain'
        Out-Say ''
        Out-Say 'Please close Codex now (and Claude, Cursor or similar apps if they are open).' 'Warn'
        [void](Read-Answer 'Press Enter to start')

        $steps = @(
            @{ Name = 'Step 1'; Function = 'Invoke-Step1Environment'; Fatal = $true },
            @{ Name = 'Step 2'; Function = 'Invoke-Step2AwsCli'; Fatal = $true },
            @{ Name = 'Step 3'; Function = 'Invoke-Step3Login'; Fatal = $true },
            @{ Name = 'Step 4'; Function = 'Invoke-Step4Identity'; Fatal = $true },
            @{ Name = 'Step 5'; Function = 'Invoke-Step5Toolkit'; Fatal = $true },
            @{ Name = 'Step 6'; Function = 'Invoke-Step6Verify'; Fatal = $false },
            @{ Name = 'Step 7'; Function = 'Invoke-Step7Rules'; Fatal = $false }
        )
        foreach ($s in $steps) {
            if ($ctx.Fatal) { break }
            Invoke-SetupStep -Name $s.Name -Function $s.Function -Fatal $s.Fatal
        }
    }
    catch {
        $ctx.Fatal = $true
        $ctx.FatalText = 'Unexpected error: ' + $_.Exception.Message
        Add-Result 'FAIL' 'script' $ctx.FatalText
    }
    try { Show-FinalSummary }
    catch { Write-Host ('Could not print the summary: ' + $_.Exception.Message) }
    finally {
        if ($ctx.LogPath) { try { Stop-Transcript | Out-Null } catch { } }
    }
    # The details for the CTO are written to the end of the log file (the closing screen above stays short).
    if ($ctx.LogPath) {
        $detailText = ''
        try { $detailText = Get-DetailBlockText }
        catch { $detailText = 'Could not build the details block: ' + $_.Exception.Message }
        $saved = Add-LogText -Path $ctx.LogPath -Text ([Environment]::NewLine + $detailText + [Environment]::NewLine)
        if (-not $saved) {
            Out-Say ''
            Out-Say 'The details for the CTO could not be added to the log file, so they are shown here instead:' 'Warn'
            Out-Say $detailText 'Info'
        }
    }
    if ($ctx.Fatal) { $exitCode = 1 }
    elseif (@($ctx.Results | Where-Object { $_.Level -eq 'ACTION' -or $_.Level -eq 'FAIL' }).Count -gt 0 -or $ctx.Manual.Count -gt 0) { $exitCode = 2 }
    if (-not $NoPause) { [void](Read-Host 'Press Enter to close') }
    return [int]$exitCode
}

# ======================================================================================
# Start (skipped when the file is loaded with -TestMode, which only defines the functions)
# ======================================================================================
if (-not $TestMode) {
    $here = $PSScriptRoot
    if (-not $here) { $here = (Get-Location).Path }
    $rc = 1
    try { $rc = @(Invoke-Main -ScriptDir $here -NoPause:$NoPause)[-1] }
    catch {
        # Last line of defence: whatever goes wrong, the window must stay open long enough to be read.
        Write-Host ''
        Write-Host ('The setup script hit an unexpected problem and stopped: ' + $_.Exception.Message) -ForegroundColor Red
        Write-Host 'Please send a screenshot of this window to the CTO.'
        if (-not $NoPause) { [void](Read-Host 'Press Enter to close') }
    }
    if ($rc -isnot [int]) { $rc = 1 }
    exit $rc
}
