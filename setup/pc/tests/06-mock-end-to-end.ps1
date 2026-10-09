# 06 - the whole script (Invoke-Main: Steps 1 to 7, the summary, the log) against a PRETEND Windows PC.
# FakeWorld.ps1 replaces the few functions through which the script runs programs, downloads files and reads the
# machine (aws, codex, uv, uvx, powershell, the network). Everything else is the real shipped code.
# This proves the logic and the order of the steps. It does NOT prove how the real aws, codex or uv behave on Windows.
. (Join-Path $PSScriptRoot 'TestHelpers.ps1')
. $script:ScriptUnderTest -TestMode
. (Join-Path $PSScriptRoot 'FakeWorld.ps1')
$script:Quiet = $true
$script:NoPauseMode = $true

$cfg = $script:Cfg
$expectedArn = $cfg.ExpectedArn
$rootArn = 'arn:aws:iam::900915535335:root'
$MarkBegin = $cfg.BeginMarker
$MarkEnd = $cfg.EndMarker

$codexUser = @'
model = "gpt-5-codex"
approval_policy = "on-request"

[projects.'C:\Users\matt\code\app']
trust_level = "trusted"
'@ + "`n"

function B64 { param([byte[]]$Bytes) return [Convert]::ToBase64String($Bytes) }
function CountOf { param([string]$Text, [string]$Part) return ([regex]::Matches($Text, [regex]::Escape($Part))).Count }
function CodexConfigOf { param([string]$H) return (Join-Path (Join-Path $H '.codex') 'config.toml') }
function CodexAgentsOf { param([string]$H) return (Join-Path (Join-Path $H '.codex') 'AGENTS.md') }

function Initialize-MattHome {
    # What the brief says is on the real PC: .codex (with a config), .agents, .aws-transform-mcp, .cdk, .iam-policy-autopilot.
    param([string]$H, [switch]$NoCodexConfig)
    $codex = Join-Path $H '.codex'
    [void](New-Item -ItemType Directory -Path $codex -Force)
    foreach ($d in @('.agents', '.aws-transform-mcp', '.cdk', '.iam-policy-autopilot')) { [void](New-Item -ItemType Directory -Path (Join-Path $H $d) -Force) }
    if (-not $NoCodexConfig) { Save-Text (CodexConfigOf $H) $codexUser }
}

function Assert-NoDashes {
    param([string]$Text, [string]$What)
    $bad = [regex]::Matches($Text, '[\u2013\u2014\u2012\u2015\u2212]')
    if ($bad.Count -gt 0) { throw ('an em dash or en dash appears in what the script says (' + $What + ')') }
}

$pinnedBytes = Get-FileBytes $script:FixtureRules

function Get-LinesAfter {
    # The lines the window shows AFTER the line that holds $Part (the last such line), as an array.
    param($Run, [string]$Part)
    $lines = @($Run.SaidLines)
    $idx = -1
    for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i].Contains($Part)) { $idx = $i } }
    if ($idx -lt 0) { throw ('the screen never showed a line with [' + $Part + ']') }
    if ($idx + 1 -ge $lines.Count) { return @() }
    return @($lines[($idx + 1)..($lines.Count - 1)])
}

function Get-LogDetailsPart {
    # The block that is written to the end of the log file after the transcript has ended.
    param($Run)
    $i = $Run.LogText.IndexOf('DETAILS FOR THE CTO', [StringComparison]::Ordinal)
    if ($i -lt 0) { return '' }
    return $Run.LogText.Substring($i)
}

# ======================================================================================
# The happy path, the same way Matt will see it
# ======================================================================================
Test-Case 'happy path (Codex only): Steps 1 to 7 in order, exit code 0, files exactly as intended' {
    $sc = New-Scenario -Setup { param($h) Initialize-MattHome $h }
    try {
        $cfgPath = CodexConfigOf $sc.Home
        $orig = Get-FileBytes $cfgPath
        $origText = Get-FileText $cfgPath
        $run = Invoke-ScenarioRun $sc
        Assert-Eq $run.Rc 0 ($run.Results)
        Assert-True (-not $run.Ctx.Fatal) 'no fatal error'
        Assert-Eq $run.Ctx.Manual.Count 0
        Assert-NotContains $run.Results '[ACTION]'
        Assert-NotContains $run.Results '[FAIL]'
        Assert-Contains $run.Results 'Step 1: The script''s own self-check passed'
        # the calls, in order
        $iRegion = Get-CallIndex $run 'aws configure set region us-east-1 --profile otchealth'
        $iLogin = Get-CallIndex $run 'LIVE aws login --region us-east-1 --profile otchealth'
        $iSts = Get-CallIndex $run 'aws sts get-caller-identity --profile otchealth --region us-east-1 --output json'
        $iWiz = Get-CallIndex $run 'aws configure agent-toolkit --yes --region us-east-1 --profile otchealth'
        $iSkills = Get-CallIndex $run 'aws agent-toolkit list-available-skills --region us-east-1 --profile otchealth'
        Assert-True ($iRegion -ge 0 -and $iLogin -gt $iRegion -and $iSts -gt $iLogin -and $iWiz -gt $iSts -and $iSkills -gt $iWiz) ('order was wrong: ' + ($run.Calls -join ' | '))
        Assert-Eq $run.Fake.WizardRuns 1
        Assert-Contains ($run.Fake.LiveEnv -join ',') 'AWS_CLI_AGENT_TOOLKIT_HINT_DISABLED=true'
        Assert-NoCall $run '--profile default'
        Assert-NoCall $run 'logout'
        # the profile is only ever "otchealth"; no call without a profile except --version
        foreach ($c in $run.Calls) {
            if ($c.StartsWith('aws ') -and -not $c.StartsWith('aws --version')) { Assert-Contains $c '--profile otchealth' $c }
        }
        # Codex: "codex" is on the (pretend) PATH, so it is hidden from the wizard. The script adds the standard entry and the
        # env sub-table itself, verified by Python's own TOML reader
        $final = Get-FileText $cfgPath
        Assert-Eq (CountOf $final 'AWS_MCP_PROXY_PROFILES = "otchealth"') 1
        Assert-True (-not $run.Fake.PostWizard.ContainsKey($cfgPath)) 'the wizard must not have touched Codex''s settings (codex is hidden from it)'
        Assert-True $run.Ctx.CodexHidden 'codex should have been hidden from the wizard'
        Assert-Eq $run.Fake.WizardPaths.Count 1
        Assert-NotContains $run.Fake.WizardPaths[0] $sc.BinDir 'the folder that holds codex must be left out of the wizard''s PATH'
        Assert-TomlEntryAddedOk $origText $final
        Assert-True $final.StartsWith($codexUser.TrimEnd()) 'the user''s own settings must stay at the top'
        # backup of the config taken before anything changed
        $bak = @($run.Ctx.Backups | Where-Object { $_.Contains('config.toml.bak-') })
        Assert-Eq $bak.Count 1
        Assert-Eq (B64 (Get-FileBytes $bak[0])) (B64 $orig)
        # Step 7
        $agents = Get-FileText (CodexAgentsOf $sc.Home)
        Assert-Eq (CountOf $agents $MarkBegin) 1
        Assert-Eq (CountOf $agents $MarkEnd) 1
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $sc.Home '.claude'))) '.claude must not be created'
        # the log (a transcript) was started next to the script and is stopped
        Assert-True ($run.Ctx.LogPath -and (Test-Path -LiteralPath $run.Ctx.LogPath)) 'the log file is missing'
        Assert-Contains (Split-Path -Leaf $run.Ctx.LogPath) 'aws-toolkit-setup-log-'
        $threw = $false
        try { Stop-Transcript | Out-Null } catch { $threw = $true }
        Assert-True $threw 'the script must have stopped its transcript already'
        # what Matt reads at the end: the banner is the LAST big thing. Only the rule line, the closing instructions and the
        # log file name come after it. Everything detailed went to the log file instead.
        Assert-Contains $run.Said 'SETUP IS COMPLETE'
        $after = @(Get-LinesAfter $run 'SETUP IS COMPLETE')
        Assert-True ($after.Count -le 6) ('too many lines after the banner: ' + $after.Count + ' ' + ($after -join ' | '))
        $afterText = $after -join "`n"
        Assert-Contains $afterText '1. Close Codex completely and open it again (and any other AI tool that was open).'
        Assert-Contains $afterText 'List the AWS skills you have, then tell me which AWS account and user you are connected as.'
        Assert-Contains $after[$after.Count - 1] ('Log file (send it to the CTO if something went wrong): ' + $run.Ctx.LogPath)
        Assert-NotContains $afterText '[OK]'
        Assert-NotContains $afterText '12 hours'
        Assert-NotContains $run.Said 'DETAILS FOR THE CTO' 'the details block belongs in the log file only'
        Assert-NotContains $run.Said 'config.toml.bak-' 'the list of backups belongs in the log file only'
        Assert-NotContains $run.Said 'Details for the CTO'
        # what was said earlier, at the moment it matters
        Assert-Contains $run.Said 'About the sign-in: AWS says these credentials are valid for 12 hours and can be renewed for 90 days without signing in through the browser again.'
        Assert-Contains $run.Said 'If a command says the session expired, run:  aws login --profile otchealth'
        Assert-NotContains $run.Said 'AWS CLI documentation also gives a 12 hour maximum' 'the two lines must not read as contradictory'
        Assert-Contains $run.Said 'Have ready now: the password and the security code (MFA) device of the IAM user otchealth-ai-reader.'
        Assert-Contains $run.Said 'If this window asks (y/n) whether to overwrite an existing login session, type y and press Enter.'
        Assert-Contains $run.Said 'this window offers a no-browser method (you type R)'
        Assert-Contains $run.Said 'To use another AWS account later: run  aws login --profile <name>,  add that profile name to the space-separated AWS_MCP_PROXY_PROFILES list in each MCP configuration file, and restart your AI tool.'
        Assert-Contains $run.Said 'Signed in as arn:aws:iam::900915535335:user/otchealth-ai-reader'
        Assert-NoDashes $run.Said 'the screen text'
        Assert-True ($run.Said -notmatch 'AKIA|aws_secret|password\s*[:=]') 'no secrets on screen'
        # the details block was appended to the log file AFTER the transcript ended
        $det = Get-LogDetailsPart $run
        Assert-True ($det.Length -gt 100) 'the log file must end with the details block'
        $iEnd = $run.LogText.IndexOf('PowerShell transcript end', [StringComparison]::OrdinalIgnoreCase)
        Assert-True ($iEnd -ge 0 -and $run.LogText.IndexOf('DETAILS FOR THE CTO', [StringComparison]::Ordinal) -gt $iEnd) 'the details block comes after the end of the transcript'
        Assert-Contains $det ('script version ' + $cfg.ScriptVersion)
        Assert-Contains $det 'outcome: complete'
        Assert-Contains $det 'config.toml.bak-'
        Assert-Contains $det 'Results of every step:'
        Assert-Contains $det '[OK] Step 4: Signed in as'
        Assert-Contains $det 'Accepted risk: the AWS MCP entry runs "uvx mcp-proxy-for-aws@latest"'
        Assert-Contains $det 'codex hidden from the wizard'
        Assert-Contains $det 'self-check skipped for parts this PC does not use: json'
        Assert-NoDashes $det 'the details block'
        Assert-True ($det -notmatch '[^\x00-\x7F]') 'the details block is pure ASCII'
    }
    finally { Remove-Scenario $sc }
}

Test-Case 'running it twice: the second run skips the browser, changes nothing that matters, and ends with identical files' {
    $sc = New-Scenario -Setup { param($h) Initialize-MattHome $h }
    try {
        $run1 = Invoke-ScenarioRun $sc
        Assert-Eq $run1.Rc 0 $run1.Results
        $cfgPath = CodexConfigOf $sc.Home
        $cfg1 = Get-FileBytes $cfgPath
        $agents1 = Get-FileBytes (CodexAgentsOf $sc.Home)
        $run2 = Invoke-ScenarioRun $sc
        Assert-Eq $run2.Rc 0 $run2.Results
        Assert-NoCall $run2 'LIVE aws login'
        Assert-Contains $run2.Results 'You are already signed in as otchealth-ai-reader. Skipping the browser sign-in.'
        Assert-Eq (B64 (Get-FileBytes $cfgPath)) (B64 $cfg1) 'config.toml must end up the same after a second run'
        Assert-Eq (B64 (Get-FileBytes (CodexAgentsOf $sc.Home))) (B64 $agents1) 'AGENTS.md must be untouched by the second run'
        Assert-Contains $run2.Results 'already up to date'
        Assert-Eq (CountOf (Get-FileText $cfgPath) '[mcp_servers.aws-mcp.env]') 1
        # the second run took its own backup of config.toml, and it equals the first run's result
        $bak2 = @($run2.Ctx.Backups | Where-Object { $_.Contains('config.toml.bak-') })
        Assert-Eq $bak2.Count 1
        Assert-Eq (B64 (Get-FileBytes $bak2[0])) (B64 $cfg1)
        $agentBackups = @($run2.Ctx.Backups | Where-Object { $_.Contains('AGENTS.md') })
        Assert-Eq $agentBackups.Count 0 'no backup is needed when AGENTS.md does not change'
    }
    finally { Remove-Scenario $sc }
}

# ======================================================================================
# Step 1 and 2: a PC that has neither uv nor the AWS CLI, an old AWS CLI, an installer that fails its signature
# ======================================================================================
Test-Case 'fresh PC: uv and the AWS CLI are installed (signed installer), and Matt is told about signing out if uv is not found' {
    $sc = New-Scenario -Fake @{ UvInstalled = $false; AwsVersion = '' } -Setup { param($h) Initialize-MattHome $h }
    try {
        $run = Invoke-ScenarioRun $sc
        Assert-Eq $run.Rc 0 $run.Results
        $uvCmd = @($run.Fake.PowerShellCommands | Where-Object { $_.Contains('astral.sh/uv/install.ps1') })
        Assert-Eq $uvCmd.Count 1
        Assert-Contains $uvCmd[0] 'Tls12'
        $awsCmd = @($run.Fake.PowerShellCommands | Where-Object { $_.Contains('awscli-install-') })
        Assert-Eq $awsCmd.Count 1
        Assert-Contains $awsCmd[0] '-ExecutionPolicy Bypass'
        # the AWS installer runs in its own PowerShell: TLS 1.2 is switched on there too, the signed file is called by its full path, its exit code is passed on
        Assert-Contains $awsCmd[0] '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; & '
        Assert-Contains $awsCmd[0] ('awscli-install-' + $run.Ctx.Stamp + '.ps1')
        Assert-Contains $awsCmd[0] 'exit $LASTEXITCODE'
        Assert-NotContains $awsCmd[0] '-File' 'the installer is no longer started with -File (that child had no TLS 1.2 setting)'
        Assert-Contains ($run.Fake.Downloads -join ',') $cfg.InstallPs1Url
        Assert-Contains $run.Results 'Installed AWS CLI 2.35.9.'
        Assert-Contains $run.Said 'The uv tool was installed during this run. If Codex says it cannot start the AWS tool'
        Assert-True (-not (Test-Path -LiteralPath (Join-Path ([System.IO.Path]::GetTempPath()) ('awscli-install-' + $run.Ctx.Stamp + '.ps1')))) 'the downloaded installer must be deleted'
    }
    finally { Remove-Scenario $sc }
}

Test-Case 'an AWS installer that fails the signature check is never run (fatal, nothing installed, exit code 1)' {
    $sc = New-Scenario -Fake @{ AwsVersion = ''; SigOk = $false } -Setup { param($h) Initialize-MattHome $h }
    try {
        $before = Get-TreeSnapshot $sc.Home '_script'
        $run = Invoke-ScenarioRun $sc
        Assert-Eq $run.Rc 1
        Assert-Contains $run.Said 'did not pass the signature check'
        Assert-Contains $run.Said 'Nothing was installed'
        Assert-Contains $run.Said 'SETUP DID NOT FINISH'
        Assert-Eq @($run.Fake.PowerShellCommands | Where-Object { $_.Contains('awscli-install-') }).Count 0
        Assert-NoCall $run 'configure agent-toolkit'
        Assert-Eq (Get-TreeSnapshot $sc.Home '_script') $before 'no file may change'
    }
    finally { Remove-Scenario $sc }
}

Test-Case 'an old AWS CLI is updated; an update that does not take effect stops with a clear message' {
    $sc = New-Scenario -Fake @{ AwsVersion = '2.10.0'; AwsInstallsAs = '2.35.9' } -Setup { param($h) Initialize-MattHome $h }
    try {
        $run = Invoke-ScenarioRun $sc
        Assert-Eq $run.Rc 0 $run.Results
        Assert-Contains $run.Said 'older than the 2.35.9 that AWS requires. Updating it.'
        Assert-Contains $run.Results 'Installed AWS CLI 2.35.9.'
    }
    finally { Remove-Scenario $sc }
    $sc2 = New-Scenario -Fake @{ AwsVersion = '2.10.0'; AwsInstallsAs = '2.10.0' } -Setup { param($h) Initialize-MattHome $h }
    try {
        $run2 = Invoke-ScenarioRun $sc2
        Assert-Eq $run2.Rc 1
        Assert-Contains $run2.Said 'the newest AWS CLI found is 2.10.0 (needed 2.35.9 or newer)'
        Assert-NoCall $run2 'LIVE aws login'
    }
    finally { Remove-Scenario $sc2 }
}

# ======================================================================================
# Steps 3 and 4: the sign-in and the identity guard
# ======================================================================================
Test-Case 'ROOT sign-in: Step 4 fails, the sign-in is logged out again, nothing else runs, no file changes, exit code 1' {
    $sc = New-Scenario -Fake @{ LoginAs = 'arn:aws:iam::900915535335:root' } -Setup { param($h) Initialize-MattHome $h }
    try {
        $before = Get-TreeSnapshot $sc.Home '_script'
        $run = Invoke-ScenarioRun $sc
        Assert-Eq $run.Rc 1
        Assert-Contains $run.Said 'You signed in as the ROOT user of the AWS account. That is not allowed here'
        Assert-Contains $run.Said 'IAM user otchealth-ai-reader (account ID 900915535335)'
        Assert-Contains $run.Said 'The sign-in was removed again.'
        Assert-Contains $run.Said 'SETUP DID NOT FINISH'
        Assert-Call $run 'aws logout --profile otchealth'
        Assert-True (-not $run.Fake.LoggedIn) 'the root sign-in must be removed'
        Assert-NoCall $run 'configure agent-toolkit'
        Assert-NoCall $run 'agent-toolkit list-available-skills'
        Assert-Eq (Get-TreeSnapshot $sc.Home '_script') $before 'no file may change after a root sign-in'
        Assert-True (-not (Test-Path -LiteralPath (CodexAgentsOf $sc.Home))) 'no AGENTS.md may be written'
    }
    finally { Remove-Scenario $sc }
}

Test-Case 'another IAM user in the right account is FATAL: signed out again, nothing else runs, no file changes, exit code 1' {
    $sc = New-Scenario -Fake @{ LoginAs = 'arn:aws:iam::900915535335:user/someone-else' } -Setup { param($h) Initialize-MattHome $h }
    try {
        $before = Get-TreeSnapshot $sc.Home '_script'
        $run = Invoke-ScenarioRun $sc
        Assert-Eq $run.Rc 1 $run.Results
        Assert-Contains $run.Said 'You are signed in as arn:aws:iam::900915535335:user/someone-else, but this setup is only for the IAM user otchealth-ai-reader.'
        Assert-Contains $run.Said 'The sign-in was removed again.'
        Assert-Contains $run.Said 'SETUP DID NOT FINISH'
        Assert-NotContains $run.Said 'SETUP FINISHED, BUT SOME ITEMS NEED ATTENTION'
        Assert-Call $run 'aws logout --profile otchealth'
        Assert-True (-not $run.Fake.LoggedIn) 'the wrong sign-in must be removed'
        Assert-Eq $run.Fake.WizardRuns 0 'the wizard must not run'
        Assert-NoCall $run 'agent-toolkit'
        Assert-Eq (Get-TreeSnapshot $sc.Home '_script') $before 'no file may change'
        Assert-True (-not (Test-Path -LiteralPath (CodexAgentsOf $sc.Home))) 'no AGENTS.md may be written'
        Assert-Contains $run.LogText 'identity guard: You are signed in as arn:aws:iam::900915535335:user/someone-else'
        Assert-Contains $run.LogText 'Sign-out confirmed'
    }
    finally { Remove-Scenario $sc }
}

Test-Case 'a different AWS account stops the setup before the wizard and signs that session out too' {
    $sc = New-Scenario -Fake @{ LoginAs = 'arn:aws:iam::123456789012:user/otchealth-ai-reader' } -Setup { param($h) Initialize-MattHome $h }
    try {
        $run = Invoke-ScenarioRun $sc
        Assert-Eq $run.Rc 1
        Assert-Contains $run.Said 'You are signed in to AWS account 123456789012, but this setup is for account 900915535335.'
        Assert-Contains $run.Said 'The sign-in was removed again.'
        Assert-Call $run 'aws logout --profile otchealth'
        Assert-True (-not $run.Fake.LoggedIn) 'the wrong-account sign-in must be removed'
        Assert-NoCall $run 'configure agent-toolkit'
    }
    finally { Remove-Scenario $sc }
}

Test-Case 'EVERY identity guard checks the result of "aws logout" and never claims a removal that did not happen' {
    $cases = @(
        @{ Name = 'root'; Arn = $rootArn; Words = 'You signed in as the ROOT user of the AWS account.' },
        @{ Name = 'wrong account'; Arn = 'arn:aws:iam::123456789012:user/otchealth-ai-reader'; Words = 'You are signed in to AWS account 123456789012' },
        @{ Name = 'wrong user'; Arn = 'arn:aws:iam::900915535335:user/someone-else'; Words = 'but this setup is only for the IAM user otchealth-ai-reader' }
    )
    foreach ($c in $cases) {
        # (a) the logout command fails
        $sc = New-Scenario -Fake @{ LoginAs = $c.Arn; LogoutExit = 1 } -Setup { param($h) Initialize-MattHome $h }
        try {
            $run = Invoke-ScenarioRun $sc
            Assert-Eq $run.Rc 1 $c.Name
            Assert-Call $run 'aws logout --profile otchealth'
            Assert-Contains $run.Said $c.Words $c.Name
            Assert-Contains $run.Said 'The sign-in could NOT be removed automatically' $c.Name
            Assert-Contains $run.Said 'the logout command reported an error (exit code 1)' $c.Name
            Assert-Contains $run.Said 'run this command now in a PowerShell window:  aws logout --profile otchealth  and tell the CTO.' $c.Name
            Assert-NotContains $run.Said 'was removed again' ($c.Name + ': must not claim a removal that did not happen')
            Assert-Contains $run.LogText 'Sign-out NOT confirmed' $c.Name
            Assert-Eq $run.Fake.WizardRuns 0 $c.Name
        }
        finally { Remove-Scenario $sc }
        # (b) the logout command says fine, but the profile still gives an identity
        $sc2 = New-Scenario -Fake @{ LoginAs = $c.Arn; LogoutStillWorks = $true } -Setup { param($h) Initialize-MattHome $h }
        try {
            $run2 = Invoke-ScenarioRun $sc2
            Assert-Eq $run2.Rc 1 $c.Name
            Assert-Contains $run2.Said 'the logout command finished, but the profile still works' $c.Name
            Assert-Contains $run2.Said 'The sign-in could NOT be removed automatically' $c.Name
            Assert-NotContains $run2.Said 'was removed again' ($c.Name + ': must not claim a removal that did not happen')
        }
        finally { Remove-Scenario $sc2 }
        # (c) the logout works: the claim is made, and it is true
        $sc3 = New-Scenario -Fake @{ LoginAs = $c.Arn } -Setup { param($h) Initialize-MattHome $h }
        try {
            $run3 = Invoke-ScenarioRun $sc3
            Assert-Eq $run3.Rc 1 $c.Name
            Assert-Contains $run3.Said 'The sign-in was removed again.' $c.Name
            Assert-NotContains $run3.Said 'could NOT be removed' $c.Name
            Assert-True (-not $run3.Fake.LoggedIn) $c.Name
            Assert-Contains $run3.Said 'Run this script again and sign in as the IAM user otchealth-ai-reader (account ID 900915535335).' $c.Name
        }
        finally { Remove-Scenario $sc3 }
    }
}

Test-Case 'a sign-in that does not finish stops with a clear message (one attempt when unattended)' {
    $sc = New-Scenario -Fake @{ LoginExit = 1 } -Setup { param($h) Initialize-MattHome $h }
    try {
        $run = Invoke-ScenarioRun $sc
        Assert-Eq $run.Rc 1
        Assert-Contains $run.Said 'The AWS sign-in did not complete.'
        Assert-Contains $run.Said 'please send a screenshot of this window (and the log file) to the CTO'
        Assert-Contains $run.Said 'The sign-in messages are not saved in the log file'
        Assert-Contains (($run.SaidLines | Select-Object -Last 8) -join "`n") 'send the log file named below (and a screenshot of this window) to the CTO'
        Assert-Eq @($run.Calls | Where-Object { $_.StartsWith('LIVE aws login') }).Count 1
        Assert-NoCall $run 'sts get-caller-identity'
        Assert-NoCall $run 'configure agent-toolkit'
    }
    finally { Remove-Scenario $sc }
}

Test-Case 'a profile that already holds keys, SSO or a role is never touched; no login is attempted' {
    $sc = New-Scenario -Fake @{ Config = @{ aws_access_key_id = 'FAKE-VALUE-NOT-A-KEY' } } -Setup { param($h) Initialize-MattHome $h }
    try {
        $run = Invoke-ScenarioRun $sc
        Assert-Eq $run.Rc 1
        Assert-Contains $run.Said 'already has other kinds of settings (aws_access_key_id)'
        Assert-NotContains $run.Said 'FAKE-VALUE-NOT-A-KEY' 'a value from the AWS config must never be shown'
        Assert-NoCall $run 'LIVE aws login'
        Assert-NoCall $run 'configure set region'
    }
    finally { Remove-Scenario $sc }
}

Test-Case 'the AWS config file is backed up before Step 3 (byte for byte); the credentials file is NOT copied (it is never touched)' {
    $sc = New-Scenario -Setup { param($h) Initialize-MattHome $h; Save-Text (Join-Path (Join-Path $h '.aws') 'config') "[default]`nregion = eu-west-1`n"; Save-Text (Join-Path (Join-Path $h '.aws') 'credentials') "[other]`nnote = placeholder`n" }
    try {
        $awsDir = Join-Path $sc.Home '.aws'
        $origConfig = Get-FileBytes (Join-Path $awsDir 'config')
        $origCreds = Get-FileBytes (Join-Path $awsDir 'credentials')
        $run = Invoke-ScenarioRun $sc
        Assert-Eq $run.Rc 0 $run.Results
        $b1 = @($run.Ctx.Backups | Where-Object { $_.Contains('.aws') -and $_.Contains('config.bak-') })
        $b2 = @($run.Ctx.Backups | Where-Object { $_.Contains('credentials') })
        Assert-Eq $b1.Count 1
        Assert-Eq $b2.Count 0 'no copy of the credentials file may be made'
        Assert-Eq (B64 (Get-FileBytes $b1[0])) (B64 $origConfig)
        Assert-Eq (@(Get-ChildItem -LiteralPath $awsDir -Force | Where-Object { $_.Name -like 'credentials*' }).Count) 1 'only the original credentials file exists'
        Assert-Eq (B64 (Get-FileBytes (Join-Path $awsDir 'credentials'))) (B64 $origCreds) 'the credentials file must not change'
        Assert-NotContains $run.Said 'placeholder' 'credentials content must never be shown'
        Assert-NotContains $run.LogText 'placeholder' 'credentials content must never be logged'
    }
    finally { Remove-Scenario $sc }
}

# ======================================================================================
# Step 5: what may and may not happen to the settings files
# ======================================================================================
Test-Case 'a custom aws-mcp entry in Codex (not the plain AWS one) stops the setup BEFORE the wizard can overwrite it' {
    $custom = $codexUser + "`n" + "[mcp_servers.aws-mcp]`ncommand = `"node`"`nargs = [`"my-own-server.js`"]`nstartup_timeout_sec = 30`n"
    $sc = New-Scenario -Setup { param($h) Initialize-MattHome $h; Save-Text (CodexConfigOf $h) $custom }
    try {
        $before = Get-TreeSnapshot $sc.Home '_script'
        $run = Invoke-ScenarioRun $sc
        Assert-Eq $run.Rc 1
        Assert-Contains $run.Said 'Codex already has an "aws-mcp" entry that is not the plain one from AWS'
        Assert-Contains $run.Said 'ask the CTO how to reconcile it'
        Assert-Eq $run.Fake.WizardRuns 0 'the wizard must not run'
        Assert-Eq (Get-TreeSnapshot $sc.Home '_script') $before 'config.toml must be untouched and no backup made'
    }
    finally { Remove-Scenario $sc }
}

Test-Case 'an aws-mcp entry with other environment variables would lose them in the wizard, so the setup stops first' {
    $text = $codexUser + "`n" + "[mcp_servers.aws-mcp]`ncommand = `"uvx`"`nargs = [`"mcp-proxy-for-aws@latest`"]`n`n[mcp_servers.aws-mcp.env]`nFOO = `"bar`"`n"
    $sc = New-Scenario -Setup { param($h) Initialize-MattHome $h; Save-Text (CodexConfigOf $h) $text }
    try {
        $run = Invoke-ScenarioRun $sc
        Assert-Eq $run.Rc 1
        Assert-Contains $run.Said 'needs a person to look at it'
        Assert-Contains $run.Said 'env section without AWS_MCP_PROXY_PROFILES'
        Assert-Eq $run.Fake.WizardRuns 0
        Assert-Eq (Get-FileText (CodexConfigOf $sc.Home)) $text
    }
    finally { Remove-Scenario $sc }
}

Test-Case 'a Codex entry that is not in config.toml but is reported by "codex mcp list" (plugin or project) stops the setup' {
    $sc = New-Scenario -Fake @{ CodexExtraServers = @('aws-mcp') } -Setup { param($h) Initialize-MattHome $h }
    try {
        $run = Invoke-ScenarioRun $sc
        Assert-Eq $run.Rc 1
        Assert-Contains $run.Said 'Codex reports an "aws-mcp" server that is not in its settings file'
        Assert-Eq $run.Fake.WizardRuns 0
    }
    finally { Remove-Scenario $sc }
}

Test-Case 'a plain AWS entry already in config.toml (for example from an earlier wizard run) is accepted and ends up with the env' {
    $plain = $codexUser + "`n" + "[mcp_servers.aws-mcp]`ncommand = `"uvx`"`nargs = [`"mcp-proxy-for-aws@latest`", `"https://aws-mcp.us-east-1.api.aws/mcp`", `"--metadata`", `"INSTALL_SOURCE=aws-cli`"]`n"
    $sc = New-Scenario -Setup { param($h) Initialize-MattHome $h; Save-Text (CodexConfigOf $h) $plain }
    try {
        $run = Invoke-ScenarioRun $sc
        Assert-Eq $run.Rc 0 $run.Results
        $final = Get-FileText (CodexConfigOf $sc.Home)
        Assert-Eq (CountOf $final '[mcp_servers.aws-mcp]') 1
        Assert-Eq (CountOf $final 'AWS_MCP_PROXY_PROFILES = "otchealth"') 1
        Assert-TomlPatchedOk $plain $final
        Assert-True (-not $run.Fake.PostWizard.ContainsKey((CodexConfigOf $sc.Home))) 'codex is hidden from the wizard, so it must not write the Codex file'
    }
    finally { Remove-Scenario $sc }
}

Test-Case 'Codex is detected but "codex" is not on the PATH: the wizard skips it, the script adds the standard entry itself (checked, backed up), everything finishes (exit code 0)' {
    $sc = New-Scenario -Fake @{ CodexOnPath = $false } -Setup { param($h) Initialize-MattHome $h }
    try {
        $cfgPath = CodexConfigOf $sc.Home
        $beforeBytes = Get-FileBytes $cfgPath
        $before = Get-FileText $cfgPath
        $run = Invoke-ScenarioRun $sc
        Assert-Eq $run.Rc 0 $run.Results
        Assert-Contains $run.Results '[NOTE] Step 5: The "codex" command was not found on this PC''s PATH, so the AWS wizard will skip Codex'
        Assert-Contains $run.Results '[OK] Step 5: Codex: added the standard AWS entry, with the otchealth profile, to '
        Assert-Contains $run.Results 'The AWS wizard did not write it (the "codex" command was not found, so the wizard skipped Codex). This script wrote the same entry itself.'
        Assert-True (-not $run.Ctx.CodexHidden) 'there was no codex to hide'
        Assert-Eq $run.Fake.WizardPaths[0] '' 'the wizard''s PATH is left alone when codex is not on it'
        Assert-NotContains $run.Results '[ACTION]'
        Assert-Eq $run.Ctx.Manual.Count 0
        Assert-Contains $run.Said 'SETUP IS COMPLETE'
        Assert-True (-not $run.Fake.PostWizard.ContainsKey($cfgPath)) 'the fake wizard must not have written the Codex entry'
        $final = Get-FileText $cfgPath
        Assert-True $final.StartsWith($before.TrimEnd()) 'the user''s own settings must stay in front'
        Assert-Eq (CountOf $final '[mcp_servers.aws-mcp]') 1
        Assert-Eq (CountOf $final '[mcp_servers.aws-mcp.env]') 1
        Assert-TomlEntryAddedOk $before $final
        # backups: the wizard-time backup of the original, and the pre-entry copy taken before the script's own edit; both are byte-identical to the original
        $bak = @($run.Ctx.Backups | Where-Object { $_.Contains('config.toml.bak-') })
        Assert-Eq $bak.Count 1
        Assert-Eq (B64 (Get-FileBytes $bak[0])) (B64 $beforeBytes)
        $pre = @($run.Ctx.Backups | Where-Object { $_.Contains('config.toml.pre-entry-') })
        Assert-Eq $pre.Count 1
        Assert-Eq (B64 (Get-FileBytes $pre[0])) (B64 $beforeBytes)
        Assert-Contains $run.LogText 'Codex config: aws-mcp entry added to the existing file'
        Assert-NoCall $run 'codex '
        Assert-True (Test-Path -LiteralPath (CodexAgentsOf $sc.Home)) 'the rules (Step 7) are added'
        # a second run leaves everything as it is: the entry is recognised, nothing is added twice
        $bytes1 = Get-FileBytes $cfgPath
        $run2 = Invoke-ScenarioRun $sc
        Assert-Eq $run2.Rc 0 $run2.Results
        Assert-Eq (B64 (Get-FileBytes $cfgPath)) (B64 $bytes1) 'a second run must not change config.toml'
        Assert-Contains $run2.Results 'Codex: the aws-mcp entry already uses the otchealth profile'
        Assert-NotContains $run2.Results 'This script wrote the same entry itself.'
    }
    finally { Remove-Scenario $sc }
}

Test-Case '"codex" not on the PATH and no config.toml at all: the file is created with the standard entry' {
    $sc = New-Scenario -Fake @{ CodexOnPath = $false } -Setup { param($h) Initialize-MattHome $h -NoCodexConfig }
    try {
        $cfgPath = CodexConfigOf $sc.Home
        Assert-True (-not (Test-Path -LiteralPath $cfgPath)) 'precondition: no config.toml'
        $run = Invoke-ScenarioRun $sc
        Assert-Eq $run.Rc 0 $run.Results
        Assert-True (Test-Path -LiteralPath $cfgPath) 'config.toml should have been created'
        Assert-TomlEntryAddedOk '' (Get-FileText $cfgPath)
        Assert-Contains $run.LogText 'Codex config: aws-mcp entry created as a new file'
        Assert-Eq @($run.Ctx.Backups | Where-Object { $_.Contains('config.toml') }).Count 0 'a file that did not exist needs no backup'
    }
    finally { Remove-Scenario $sc }
}

Test-Case '"codex" not on the PATH but the entry is already in config.toml (hand-added earlier): the env is added or confirmed, no hand edit is listed' {
    $handAdded = $codexUser + "`n[mcp_servers.aws-mcp]`ncommand = `"uvx`"`nargs = [`"mcp-proxy-for-aws@latest`", `"https://aws-mcp.us-east-1.api.aws/mcp`", `"--metadata`", `"INSTALL_SOURCE=aws-cli`"]`n"
    $sc = New-Scenario -Fake @{ CodexOnPath = $false } -Setup { param($h) Initialize-MattHome $h -NoCodexConfig; Save-Text (CodexConfigOf $h) $handAdded }
    try {
        $cfgPath = CodexConfigOf $sc.Home
        $run = Invoke-ScenarioRun $sc
        Assert-Eq $run.Rc 0 $run.Results
        Assert-Eq $run.Ctx.Manual.Count 0
        Assert-Contains $run.Results 'Codex: added the otchealth profile to the aws-mcp entry'
        Assert-TomlPatchedOk $handAdded (Get-FileText $cfgPath)
        Assert-NotContains $run.Results 'Could not double-check with "codex mcp get"'
        $run2 = Invoke-ScenarioRun $sc
        Assert-Eq $run2.Rc 0 $run2.Results
        Assert-Contains $run2.Results 'Codex: the aws-mcp entry already uses the otchealth profile'
    }
    finally { Remove-Scenario $sc }
}

Test-Case '"codex" not on the PATH and a config.toml the script cannot add to safely: a hand edit with the exact lines is listed, the file is untouched (exit code 2)' {
    $inline = "mcp_servers = { other = { command = `"node`" } }`n"
    $sc = New-Scenario -Fake @{ CodexOnPath = $false } -Setup { param($h) Initialize-MattHome $h -NoCodexConfig; Save-Text (CodexConfigOf $h) $inline }
    try {
        $cfgPath = CodexConfigOf $sc.Home
        $run = Invoke-ScenarioRun $sc
        Assert-Eq $run.Rc 2 $run.Results
        Assert-Eq $run.Ctx.Manual.Count 1
        Assert-Contains $run.Ctx.Manual[0].Fix '[mcp_servers.aws-mcp]'
        Assert-Contains $run.Ctx.Manual[0].Fix 'AWS_MCP_PROXY_PROFILES = "otchealth"'
        Assert-Contains $run.Ctx.Manual[0].Why 'could not be added safely by this script'
        Assert-Contains $run.LogText 'Hand edits still to do (exact steps):'
        Assert-Contains $run.LogText '[mcp_servers.aws-mcp]'
        Assert-NotContains $run.Said 'Hand edits still to do (exact steps):' 'the exact steps are in the log file, not on the closing screen'
        Assert-Contains $run.Said 'SETUP FINISHED, BUT SOME ITEMS NEED ATTENTION'
        Assert-Contains (Get-LinesAfter $run 'SETUP FINISHED, BUT SOME ITEMS NEED ATTENTION' | Out-String) 'Needs a hand edit:'
        Assert-Eq (Get-FileText $cfgPath) $inline 'config.toml must be unchanged'
        Assert-Eq @($run.Ctx.Backups | Where-Object { $_.Contains('pre-entry') }).Count 0
        Assert-True (Test-Path -LiteralPath (CodexAgentsOf $sc.Home)) 'the rules (Step 7) are still added'
    }
    finally { Remove-Scenario $sc }
}

Test-Case '"codex" IS on the PATH (a codex.cmd shim): it is hidden from the wizard, so "codex mcp add" cannot crash it; the script adds the standard entry (exit code 0)' {
    $sc = New-Scenario -Fake @{ CodexOnPath = $true; CodexAddCrashes = $true } -Setup { param($h) Initialize-MattHome $h }
    try {
        $cfgPath = CodexConfigOf $sc.Home
        $beforeText = Get-FileText $cfgPath
        $pathBefore = [Environment]::GetEnvironmentVariable('PATH')
        $run = Invoke-ScenarioRun $sc
        Assert-Eq $run.Rc 0 $run.Results
        Assert-Eq $run.Fake.WizardRuns 1
        Assert-True $run.Ctx.CodexHidden
        # the wizard got a PATH without the folder that holds codex, and nothing else was dropped from it
        $given = $run.Fake.WizardPaths[0]
        Assert-NotContains $given $sc.BinDir
        $sep = [string][System.IO.Path]::PathSeparator
        $expected = ((([Environment]::GetEnvironmentVariable('PATH')) -split [regex]::Escape($sep)) | Where-Object { $_ -ne $sc.BinDir }) -join $sep
        Assert-Eq $given $expected 'only the folder with codex is taken out of the wizard''s PATH'
        # this window's own PATH is untouched (the hiding is for the one wizard command only)
        Assert-Eq ([Environment]::GetEnvironmentVariable('PATH')) $pathBefore
        # the script wrote the entry (insert only, checked), with the profile
        $final = Get-FileText $cfgPath
        Assert-TomlEntryAddedOk $beforeText $final
        Assert-True (-not $run.Fake.PostWizard.ContainsKey($cfgPath))
        Assert-Contains $run.Results '[OK] Step 5: Codex: added the standard AWS entry, with the otchealth profile, to '
        Assert-Contains $run.Results 'The AWS wizard was kept away from Codex on purpose (so that it cannot fail halfway). This script wrote the same entry itself.'
        Assert-Contains $run.Results '[NOTE] Step 5: The "codex" command was found (/fake/bin/codex). It is hidden from the AWS wizard for this one step'
        Assert-Contains $run.Said 'The "codex" command is hidden from the wizard for this one step, so it cannot fail halfway through.'
        Assert-Contains $run.Results 'Codex itself reports the otchealth profile for aws-mcp ("codex mcp get").'
        Assert-NotContains $run.Results '[ACTION]'
        Assert-Eq $run.Ctx.Manual.Count 0
        Assert-Contains $run.LogText 'codex hidden from the wizard (these folders were left out of its PATH): '
        Assert-Contains $run.LogText $sc.BinDir
        # the closing screen is the short, complete one
        Assert-Contains $run.Said 'SETUP IS COMPLETE'
    }
    finally { Remove-Scenario $sc }
}

Test-Case 'the same crashing wizard WITHOUT the hiding fails (so the fake really models the crash that the hiding prevents)' {
    $sc = New-Scenario -Fake @{ CodexOnPath = $true; CodexAddCrashes = $true } -Setup { param($h) Initialize-MattHome $h }
    try {
        $run = & {
            function Get-PathWithoutProgram { param([string]$Name, [string]$PathValue) return [pscustomobject]@{ Path = $PathValue; Removed = @() } }
            Invoke-ScenarioRun $sc
        }
        Assert-Eq $run.Rc 1
        Assert-Contains $run.Said 'The AWS wizard stopped with an error (exit code 1)'
        Assert-Contains $run.Said 'CalledProcessError'
        Assert-Eq $run.Fake.WizardPaths[0] '' 'without the hiding the wizard gets the unchanged PATH'
    }
    finally { Remove-Scenario $sc }
}

Test-Case 'the entry that the script writes for Codex is exactly the standard AWS one plus the otchealth env (same content "codex mcp add" would write)' {
    $sc = New-Scenario -Fake @{ CodexOnPath = $true } -Setup { param($h) Initialize-MattHome $h -NoCodexConfig }
    try {
        $run = Invoke-ScenarioRun $sc
        Assert-Eq $run.Rc 0 $run.Results
        $text = Get-FileText (CodexConfigOf $sc.Home)
        $want = '[mcp_servers.aws-mcp]' + "`n" + 'command = "uvx"' + "`n" + 'args = ["mcp-proxy-for-aws@latest", "https://aws-mcp.us-east-1.api.aws/mcp", "--metadata", "INSTALL_SOURCE=aws-cli"]' + "`n`n" + '[mcp_servers.aws-mcp.env]' + "`n" + 'AWS_MCP_PROXY_PROFILES = "otchealth"' + "`n"
        Assert-Eq $text $want
        Assert-TomlEntryAddedOk '' $text
    }
    finally { Remove-Scenario $sc }
}

Test-Case 'Claude Code present: ~/.claude.json gets the env (insert only), CLAUDE.md gets the rules, AGENTS.md too' {
    $claudeJson = '{' + "`n" + '  "numStartups": 3,' + "`n" + '  "projects": {' + "`n" + '    "C:/Users/matt/app": { "mcpServers": {}, "history": ["a \"quoted\" prompt"] }' + "`n" + '  }' + "`n" + '}' + "`n"
    $sc = New-Scenario -Setup { param($h) Initialize-MattHome $h; [void](New-Item -ItemType Directory -Path (Join-Path $h '.claude') -Force); Save-Text (Join-Path $h '.claude.json') $claudeJson; Save-Text (Join-Path (Join-Path $h '.claude') 'CLAUDE.md') "# My Claude rules`nBe brief.`n" }
    try {
        $jsonPath = Join-Path $sc.Home '.claude.json'
        $origJsonBytes = Get-FileBytes $jsonPath
        $run = Invoke-ScenarioRun $sc
        Assert-Eq $run.Rc 0 $run.Results
        $final = Get-FileText $jsonPath
        Assert-True ($run.Fake.PostWizard.ContainsKey($jsonPath)) 'the fake wizard should have written .claude.json'
        Assert-JsonPatchedOk $run.Fake.PostWizard[$jsonPath] $final
        $obj = $final | ConvertFrom-Json
        Assert-Eq $obj.mcpServers.'aws-mcp'.env.AWS_MCP_PROXY_PROFILES 'otchealth'
        Assert-Eq $obj.numStartups 3
        $claudeMd = Get-FileText (Join-Path (Join-Path $sc.Home '.claude') 'CLAUDE.md')
        Assert-True $claudeMd.StartsWith("# My Claude rules`nBe brief.`n")
        Assert-Eq (CountOf $claudeMd $MarkBegin) 1
        Assert-Eq (CountOf (Get-FileText (CodexAgentsOf $sc.Home)) $MarkBegin) 1
        $b = @($run.Ctx.Backups | Where-Object { $_.Contains('.claude.json.bak-') })
        Assert-Eq $b.Count 1
        Assert-Eq (B64 (Get-FileBytes $b[0])) (B64 $origJsonBytes) 'the backup must be the file as it was before the wizard'
        Assert-Contains $run.Results 'Claude Code: added the otchealth profile'
    }
    finally { Remove-Scenario $sc }
}

Test-Case 'a Cursor aws-mcp entry that is not the AWS one is left alone and listed as a hand edit; Codex is still done (exit code 2)' {
    $cursorJson = '{"mcpServers": {"aws-mcp": {"command": "node", "args": ["custom.js"]}}}'
    $sc = New-Scenario -Setup { param($h) Initialize-MattHome $h; Save-Text (Join-Path (Join-Path $h '.cursor') 'mcp.json') $cursorJson }
    try {
        $run = Invoke-ScenarioRun $sc
        Assert-Eq $run.Rc 2 $run.Results
        Assert-Eq (Get-FileText (Join-Path (Join-Path $sc.Home '.cursor') 'mcp.json')) $cursorJson
        Assert-Eq $run.Ctx.Manual.Count 1
        Assert-Contains $run.Ctx.Manual[0].File 'mcp.json'
        Assert-Contains $run.Ctx.Manual[0].Fix '"env": { "AWS_MCP_PROXY_PROFILES": "otchealth" }'
        Assert-Contains (Get-FileText (CodexConfigOf $sc.Home)) 'AWS_MCP_PROXY_PROFILES = "otchealth"'
    }
    finally { Remove-Scenario $sc }
}

Test-Case 'a settings file that the wizard would choke on stops the setup before the wizard (nothing changed)' {
    $sc = New-Scenario -Setup { param($h) Initialize-MattHome $h; Save-Text (Join-Path (Join-Path $h '.cursor') 'mcp.json') '{"mcpServers": {"aws-mcp": {"command": "uvx",}}}' }
    try {
        $before = Get-TreeSnapshot $sc.Home '_script'
        $run = Invoke-ScenarioRun $sc
        Assert-Eq $run.Rc 1
        Assert-Contains $run.Said 'is not in the expected format'
        Assert-Eq $run.Fake.WizardRuns 0
        Assert-Eq (Get-TreeSnapshot $sc.Home '_script') $before
    }
    finally { Remove-Scenario $sc }
}

Test-Case 'no supported AI tool folder at all: a clear stop, nothing created' {
    $sc = New-Scenario
    try {
        $before = Get-TreeSnapshot $sc.Home '_script'
        $run = Invoke-ScenarioRun $sc
        Assert-Eq $run.Rc 1
        Assert-Contains $run.Said 'No supported AI tool settings folder was found'
        Assert-Eq $run.Fake.WizardRuns 0
        Assert-Eq (Get-TreeSnapshot $sc.Home '_script') $before
    }
    finally { Remove-Scenario $sc }
}

Test-Case 'a wizard that fails stops the setup with its message; the files are as they were (apart from backups)' {
    $sc = New-Scenario -Fake @{ WizardExit = 2 } -Setup { param($h) Initialize-MattHome $h }
    try {
        $orig = Get-FileText (CodexConfigOf $sc.Home)
        $run = Invoke-ScenarioRun $sc
        Assert-Eq $run.Rc 1
        Assert-Contains $run.Said 'The AWS wizard stopped with an error (exit code 2)'
        Assert-Contains $run.Said 'simulated wizard failure'
        Assert-Eq (Get-FileText (CodexConfigOf $sc.Home)) $orig
        Assert-NoCall $run 'agent-toolkit list-available-skills'
    }
    finally { Remove-Scenario $sc }
}

Test-Case 'apps that are open are named, a failed warm-up and a failed skill check are reported but do not stop the rest' {
    $sc = New-Scenario -Fake @{ Running = @('codex'); PrewarmExit = 1; SkillsOk = $false } -Setup { param($h) Initialize-MattHome $h }
    try {
        $run = Invoke-ScenarioRun $sc
        Assert-Eq $run.Rc 2 $run.Results
        Assert-Contains $run.Said 'These apps are open right now: codex.'
        Assert-Contains $run.Results '[NOTE] Step 5: The warm-up of the AWS MCP proxy did not finish'
        Assert-Contains $run.Results '[ACTION] Step 6: Could not read the AWS skill catalog.'
        Assert-True (Test-Path -LiteralPath (CodexAgentsOf $sc.Home)) 'Step 7 still runs after a failed Step 6'
        Assert-Contains (Get-FileText (CodexConfigOf $sc.Home)) 'AWS_MCP_PROXY_PROFILES = "otchealth"'
    }
    finally { Remove-Scenario $sc }
}

Test-Case 'uvx not on the PATH after a fresh uv install: the warm-up is skipped with advice, and the summary explains it' {
    $sc = New-Scenario -Fake @{ UvxOnPath = $false } -Setup { param($h) Initialize-MattHome $h }
    try {
        $run = Invoke-ScenarioRun $sc
        Assert-Eq $run.Rc 0 $run.Results
        Assert-Contains $run.Results 'Could not find "uvx" on the PATH of this window.'
        Assert-NoCall $run 'uvx '
    }
    finally { Remove-Scenario $sc }
}

# ======================================================================================
# Step 7 in the whole flow
# ======================================================================================
Test-Case 'a CRLF AGENTS.md keeps CRLF and its own text; a second run leaves it identical (no new backup)' {
    $mine = "# My Codex rules`r`nAlways use tabs.`r`n"
    $sc = New-Scenario -Setup { param($h) Initialize-MattHome $h; Save-Text (CodexAgentsOf $h) $mine }
    try {
        $run = Invoke-ScenarioRun $sc
        Assert-Eq $run.Rc 0 $run.Results
        $p = CodexAgentsOf $sc.Home
        $t = Get-FileText $p
        Assert-True $t.StartsWith($mine)
        Assert-True (($t -replace "`r`n", '') -notmatch "[`r`n]") 'only CRLF pairs may remain'
        Assert-Eq (CountOf $t $MarkBegin) 1
        $bak = @($run.Ctx.Backups | Where-Object { $_.Contains('AGENTS.md.bak-') })
        Assert-Eq $bak.Count 1
        Assert-Eq (Get-FileText $bak[0]) $mine
        $bytes1 = Get-FileBytes $p
        $run2 = Invoke-ScenarioRun $sc
        Assert-Eq $run2.Rc 0 $run2.Results
        Assert-Eq (B64 (Get-FileBytes $p)) (B64 $bytes1)
        Assert-Eq @($run2.Ctx.Backups | Where-Object { $_.Contains('AGENTS.md') }).Count 0
    }
    finally { Remove-Scenario $sc }
}

Test-Case 'an old AWS block in AGENTS.md is refreshed in place; the text around it is untouched' {
    $old = "# Mine`nfirst`n`n" + $MarkBegin + "`nold text`n" + $MarkEnd + "`n`n## After`nlast`n"
    $sc = New-Scenario -Setup { param($h) Initialize-MattHome $h; Save-Text (CodexAgentsOf $h) $old }
    try {
        $run = Invoke-ScenarioRun $sc
        Assert-Eq $run.Rc 0 $run.Results
        $t = Get-FileText (CodexAgentsOf $sc.Home)
        Assert-True $t.StartsWith("# Mine`nfirst`n`n" + $MarkBegin)
        Assert-True $t.EndsWith($MarkEnd + "`n`n## After`nlast`n")
        Assert-NotContains $t 'old text'
        Assert-Contains $run.Results 'refreshed the AWS rules block'
    }
    finally { Remove-Scenario $sc }
}

Test-Case 'rules that do not match the pinned fingerprint (or cannot be downloaded) are NOT written; everything else is done (exit code 2)' {
    $tampered = [byte[]]$pinnedBytes.Clone()
    $tampered[20] = [byte]($tampered[20] -bxor 1)
    foreach ($variant in @(@{ RulesBytes = $tampered }, @{ RulesThrow = $true })) {
        $sc = New-Scenario -Fake $variant -Setup { param($h) Initialize-MattHome $h }
        try {
            $run = Invoke-ScenarioRun $sc
            Assert-Eq $run.Rc 2 $run.Results
            Assert-Contains $run.Results '[ACTION] Step 7: The AWS rules were NOT added'
            Assert-True (-not (Test-Path -LiteralPath (CodexAgentsOf $sc.Home))) 'AGENTS.md must not be written'
            Assert-Contains (Get-FileText (CodexConfigOf $sc.Home)) 'AWS_MCP_PROXY_PROFILES = "otchealth"'
            Assert-Contains ($run.Fake.Downloads -join ',') $cfg.RulesCommit
        }
        finally { Remove-Scenario $sc }
    }
}

Test-Case 'AGENTS.override.md with text is flagged (Codex would ignore AGENTS.md)' {
    $sc = New-Scenario -Setup { param($h) Initialize-MattHome $h; Save-Text (Join-Path (Join-Path $h '.codex') 'AGENTS.override.md') "Temporary override.`n" }
    try {
        $run = Invoke-ScenarioRun $sc
        Assert-Eq $run.Rc 2 $run.Results
        Assert-Contains $run.Results '[ACTION] Step 7: Codex reads'
        Assert-Contains $run.Results 'AGENTS.override.md'
    }
    finally { Remove-Scenario $sc }
}

# ======================================================================================
# The script checks its own building blocks on the PC before it touches anything.
# Only the parts this PC will use are checked, and a part that fails is switched off (with a hand edit instead).
# Only the one thing every later step depends on (starting a program and reading its answer) stops the run.
# ======================================================================================
function Get-NonProbeCalls { param($Run) return @($Run.Calls | Where-Object { -not $_.StartsWith('probe-') }) }

Test-Case 'the self-check passes on a healthy machine, checks only what this PC uses (Codex only: no JSON check), and is reported in Step 1 before uv' {
    $sc = New-Scenario -Setup { param($h) Initialize-MattHome $h }
    try {
        $run = Invoke-ScenarioRun $sc
        Assert-Eq $run.Rc 0 $run.Results
        $self = Test-ScriptSelfCheck -Need @('sha256', 'toml', 'rules')
        Assert-Eq @($self.Fatal).Count 0 (@($self.Fatal) -join '; ')
        Assert-Eq @($self.Failed).Count 0 ((@($self.Failed) | ForEach-Object { $_.Engine + ': ' + $_.Problem }) -join '; ')
        Assert-Eq (@($self.Passed) -join ',') 'sha256,toml,rules'
        Assert-Eq (@($self.Skipped) -join ',') 'json'
        $all = Test-ScriptSelfCheck
        Assert-Eq (@($all.Passed) -join ',') 'sha256,toml,json,rules'
        Assert-Eq @($all.Skipped).Count 0
        Assert-Eq (@(Get-NeededEngines) -join ',') 'toml,rules,sha256' 'a Codex-only PC needs the Codex, rules and fingerprint parts only'
        $iCheck = $run.Results.IndexOf('The script''s own self-check passed', [StringComparison]::Ordinal)
        $iUv = $run.Results.IndexOf('uv is ready', [StringComparison]::Ordinal)
        Assert-True ($iCheck -ge 0 -and $iUv -gt $iCheck) 'the self-check is reported in Step 1, before uv is looked at'
        Assert-Eq @($run.Calls | Where-Object { $_.StartsWith('probe-a') }).Count 1 'the program-start check ran'
        Assert-Contains $run.LogText 'self-check skipped for parts this PC does not use: json'
    }
    finally { Remove-Scenario $sc }
}

Test-Case 'which parts a PC needs follows the AI tool folders that exist' {
    $h = New-TempDir
    try {
        $null = New-TestContext $h
        Assert-Eq (@(Get-NeededEngines) -join ',') '' 'no AI tool folder: nothing is needed'
        [void](New-Item -ItemType Directory -Path (Join-Path $h '.claude'))
        Assert-Eq (@(Get-NeededEngines) -join ',') 'json,rules,sha256'
        [void](New-Item -ItemType Directory -Path (Join-Path $h '.codex'))
        Assert-Eq (@(Get-NeededEngines) -join ',') 'toml,json,rules,sha256'
        Remove-Item -LiteralPath (Join-Path $h '.claude') -Recurse -Force
        Remove-Item -LiteralPath (Join-Path $h '.codex') -Recurse -Force
        [void](New-Item -ItemType Directory -Path (Join-Path $h '.config\opencode') -Force)
        Assert-Eq (@(Get-NeededEngines) -join ',') 'json' 'OpenCode alone needs the JSON part (and no rules)'
    }
    finally { Remove-Item -LiteralPath $h -Recurse -Force -ErrorAction SilentlyContinue }
}

Test-Case 'a broken JSON part does NOT matter on a Codex-only PC: it is not even checked, and the setup is complete (exit code 0)' {
    $sc = New-Scenario -Setup { param($h) Initialize-MattHome $h }
    try {
        $run = & {
            function Add-JsonEnvToText { param([string]$Text, [string]$ParentKey, [string]$EnvKey) throw 'broken on purpose' }
            Invoke-ScenarioRun $sc
        }
        Assert-Eq $run.Rc 0 $run.Results
        Assert-NotContains $run.Results 'did not pass'
        Assert-Contains $run.Said 'SETUP IS COMPLETE'
        Assert-Eq $run.Ctx.EngineProblems.Count 0
    }
    finally { Remove-Scenario $sc }
}

Test-Case 'a failed self-check of a part this PC needs is NOT fatal: the part is switched off, the rest is done, a hand edit is listed (exit code 2)' {
    $variants = @('toml', 'sha', 'rules')
    foreach ($v in $variants) {
        $sc = New-Scenario -Setup { param($h) Initialize-MattHome $h }
        try {
            $cfgPath = CodexConfigOf $sc.Home
            $beforeText = Get-FileText $cfgPath
            $run = $null
            if ($v -eq 'sha') {
                $run = & {
                    function Get-Sha256Hex { param([byte[]]$Bytes) return 'not-the-right-fingerprint' }
                    Invoke-ScenarioRun $sc
                }
                $expect = 'the fingerprint (SHA-256) calculation did not pass on this PC (it gives a wrong answer)'
            }
            elseif ($v -eq 'toml') {
                $run = & {
                    function Add-TomlMcpEnv { param([string]$Text, [string]$Server, [string]$EnvName, [string]$ProfileName) return [pscustomobject]@{ State = 'Refused'; Text = $Text; Reason = 'broken on purpose' } }
                    Invoke-ScenarioRun $sc
                }
                $expect = 'the editor for Codex''s settings file did not pass on this PC (it gave an unexpected answer (Refused broken on purpose))'
            }
            else {
                $run = & {
                    function Set-RulesBlock { param([string]$Existing, [string]$Rules, [string]$Begin, [string]$End, [string]$Note) return [pscustomobject]@{ State = 'Created'; Text = 'x'; Reason = '' } }
                    Invoke-ScenarioRun $sc
                }
                $expect = 'the editor for the AWS rules block did not pass on this PC (it gave an unexpected answer (Created / Created))'
            }
            Assert-Eq $run.Rc 2 ($v + ': ' + $run.Results)
            Assert-True (-not $run.Ctx.Fatal) ($v + ': a failed part is not fatal')
            Assert-Contains $run.Results ('[NOTE] Step 1: The script''s own check of ' + $expect) $v
            Assert-NotContains $run.Results 'self-check passed' $v
            Assert-Contains $run.Said 'The rest of the setup carries on.' $v
            Assert-Contains $run.LogText 'self-check FAILED for' $v
            Assert-Eq $run.Fake.WizardRuns 1 ($v + ': the wizard still runs')
            Assert-Call $run 'aws agent-toolkit list-available-skills'
            if ($v -eq 'toml') {
                # Codex's settings file is not edited by the script at all; the exact hand edit (both cases) is listed
                Assert-Eq (Get-FileText $cfgPath) $beforeText 'config.toml must stay as it was'
                Assert-Eq $run.Ctx.Manual.Count 1
                Assert-Contains $run.Ctx.Manual[0].Why 'did not pass on this PC, so the file was not edited'
                Assert-Contains $run.Ctx.Manual[0].Fix 'IF THERE IS NO SUCH LINE:'
                Assert-Contains $run.Ctx.Manual[0].Fix 'IF THERE IS SUCH A LINE:'
                Assert-Contains $run.Ctx.Manual[0].Fix 'AWS_MCP_PROXY_PROFILES = "otchealth"'
                Assert-True (Test-Path -LiteralPath (CodexAgentsOf $sc.Home)) 'the rules (Step 7) are still added'
            }
            else {
                Assert-Contains $run.Results '[ACTION] Step 7: The AWS rules were NOT added: the script''s own check of' $v
                Assert-True (-not (Test-Path -LiteralPath (CodexAgentsOf $sc.Home))) ($v + ': no AGENTS.md may be written')
                Assert-Contains (Get-FileText $cfgPath) 'AWS_MCP_PROXY_PROFILES = "otchealth"' ($v + ': Codex is still set up')
            }
            Assert-Contains $run.Said 'SETUP FINISHED, BUT SOME ITEMS NEED ATTENTION' $v
        }
        finally { Remove-Scenario $sc }
    }
}

Test-Case 'a failed JSON part on a PC that HAS a JSON tool (Claude Code): the JSON file is backed up and listed as a hand edit, never edited by the script (exit code 2)' {
    $claudeJson = '{"numStartups": 3, "projects": {}}' + "`n"
    $sc = New-Scenario -Setup { param($h) Initialize-MattHome $h; [void](New-Item -ItemType Directory -Path (Join-Path $h '.claude') -Force); Save-Text (Join-Path $h '.claude.json') $claudeJson }
    try {
        $jsonPath = Join-Path $sc.Home '.claude.json'
        $run = & {
            function Add-JsonEnvToText { param([string]$Text, [string]$ParentKey, [string]$EnvKey) throw 'broken on purpose' }
            Invoke-ScenarioRun $sc
        }
        Assert-Eq $run.Rc 2 $run.Results
        Assert-Contains $run.Results '[NOTE] Step 1: The script''s own check of the editor for JSON settings files did not pass on this PC (broken on purpose)'
        Assert-True $run.Ctx.EngineProblems.ContainsKey('json')
        # the wizard ran and added its own entry; the script did not touch the JSON file after that
        Assert-Eq $run.Fake.WizardRuns 1
        Assert-Eq (Get-FileText $jsonPath) $run.Fake.PostWizard[$jsonPath] 'the file is exactly as the wizard left it'
        Assert-NotContains (Get-FileText $jsonPath) 'AWS_MCP_PROXY_PROFILES'
        $m = @($run.Ctx.Manual | Where-Object { $_.File -eq $jsonPath })
        Assert-Eq $m.Count 1
        Assert-Contains $m[0].Why 'did not pass on this PC, so the file was not edited'
        Assert-Contains $m[0].Fix 'This file was not changed by the script. If it has an "aws-mcp" entry, do the following:'
        Assert-Contains $m[0].Fix '"env": { "AWS_MCP_PROXY_PROFILES": "otchealth" }'
        # it was backed up before the wizard ran
        $b = @($run.Ctx.Backups | Where-Object { $_.Contains('.claude.json.bak-') })
        Assert-Eq $b.Count 1
        Assert-Eq (Get-FileText $b[0]) $claudeJson
        # Codex is still done by the script (its own part passed)
        Assert-Contains (Get-FileText (CodexConfigOf $sc.Home)) 'AWS_MCP_PROXY_PROFILES = "otchealth"'
    }
    finally { Remove-Scenario $sc }
}

Test-Case 'the program-start check is the one fatal self-check: it passes if ANY of its two tries works, and it is skipped when the PC has neither program' {
    # one try fails, the other works: fine
    $sc = New-Scenario -Fake @{ ProbeMode = 'first-fails' } -Setup { param($h) Initialize-MattHome $h }
    try {
        $run = Invoke-ScenarioRun $sc
        Assert-Eq $run.Rc 0 $run.Results
        Assert-Eq @($run.Calls | Where-Object { $_.StartsWith('probe-') }).Count 2 'both tries were made'
    }
    finally { Remove-Scenario $sc }
    # no test program found at all: skipped, not failed
    $sc2 = New-Scenario -Fake @{ ProbeMode = 'none' } -Setup { param($h) Initialize-MattHome $h }
    try {
        $run2 = Invoke-ScenarioRun $sc2
        Assert-Eq $run2.Rc 0 $run2.Results
        Assert-Eq @($run2.Calls | Where-Object { $_.StartsWith('probe-') }).Count 0
    }
    finally { Remove-Scenario $sc2 }
    # both fail: nothing can be started reliably, so the run stops in Step 1 before any real program or file is touched
    $sc3 = New-Scenario -Fake @{ ProbeMode = 'fail' } -Setup { param($h) Initialize-MattHome $h }
    try {
        $before = Get-TreeSnapshot $sc3.Home '_script'
        $run3 = Invoke-ScenarioRun $sc3
        Assert-Eq $run3.Rc 1 $run3.Results
        Assert-Contains $run3.Said 'The script''s own check of how it starts programs failed on this PC, so nothing was changed. Please send the log file to the CTO.'
        Assert-Contains $run3.Said 'probe-a: simulated probe failure'
        Assert-Contains $run3.Said 'probe-b: simulated probe failure'
        Assert-Contains $run3.Said 'SETUP DID NOT FINISH'
        Assert-Eq @(Get-NonProbeCalls $run3).Count 0 'no real program may be started after a failed program-start check'
        Assert-Eq (Get-TreeSnapshot $sc3.Home '_script') $before 'no file may change'
        Assert-Eq $run3.Ctx.Backups.Count 0
    }
    finally { Remove-Scenario $sc3 }
}

# ======================================================================================
# The safety nets: an unexpected crash, the log, the wording
# ======================================================================================
Test-Case 'an unexpected crash inside a step is caught: plain summary, line number, the log is closed, exit code 1' {
    $sc = New-Scenario -Fake @{ ThrowOn = 'sts get-caller-identity' } -Setup { param($h) Initialize-MattHome $h }
    try {
        $run = Invoke-ScenarioRun $sc
        Assert-Eq $run.Rc 1
        Assert-Contains $run.Said 'SETUP DID NOT FINISH'
        Assert-Contains $run.Said 'simulated crash inside a helper'
        Assert-Contains $run.Said '(script line '
        Assert-Contains $run.Said 'Log file (send it to the CTO if something went wrong):'
        $threw = $false
        try { Stop-Transcript | Out-Null } catch { $threw = $true }
        Assert-True $threw 'the transcript must have been stopped even after a crash'
        Assert-True (Test-Path -LiteralPath $run.Ctx.LogPath)
    }
    finally { Remove-Scenario $sc }
}

Test-Case 'the log file really records what the window showed (a normal run with the screen output switched on)' {
    $sc = New-Scenario -Setup { param($h) Initialize-MattHome $h }
    try {
        $run = Invoke-ScenarioRun $sc -Loud
        Assert-Eq $run.Rc 0 $run.Results
        $log = [System.IO.File]::ReadAllText($run.Ctx.LogPath)
        Assert-True ($log -match '(?i)transcript start') 'the transcript header is missing'
        Assert-Contains $log 'SETUP IS COMPLETE'
        Assert-Contains $log 'Log file (send it to the CTO if something went wrong)'
        Assert-True ($log -match '(?i)transcript end') 'the transcript was not closed properly'
        # the details block is added to the very end of the file, after the transcript's own end marker
        Assert-True ($log.LastIndexOf('DETAILS FOR THE CTO', [StringComparison]::Ordinal) -gt $log.IndexOf('PowerShell transcript end', [StringComparison]::OrdinalIgnoreCase)) 'details after the end of the transcript'
        Assert-Contains $log 'Results of every step:'
        # and the closing screen did not repeat it
        Assert-Eq (CountOf $log 'DETAILS FOR THE CTO') 1 'the details block is written once, and only to the log file'
    }
    finally { Remove-Scenario $sc }
}

Test-Case 'every sentence the script says in the happy path, the root case and the failure cases is free of em dashes and en dashes' {
    $texts = New-Object 'System.Collections.Generic.List[string]'
    foreach ($variant in @(@{}, @{ LoginAs = $rootArn }, @{ LoginAs = $rootArn; LogoutExit = 1 }, @{ LoginAs = 'arn:aws:iam::900915535335:user/x' }, @{ LoginExit = 1 }, @{ CodexOnPath = $false }, @{ SkillsOk = $false; PrewarmExit = 1 }, @{ WizardExit = 3 }, @{ ProbeMode = 'fail' })) {
        $sc = New-Scenario -Fake $variant -Setup { param($h) Initialize-MattHome $h }
        try {
            $run = Invoke-ScenarioRun $sc
            $texts.Add($run.Said)
            $texts.Add((Get-LogDetailsPart $run))
        }
        finally { Remove-Scenario $sc }
    }
    Assert-NoDashes ($texts -join "`n") 'the screen text and the details block of nine runs'
    Assert-True (($texts -join "`n") -notmatch '[^\x00-\x7F]') 'the screen text of the script itself is pure ASCII'
}

# ======================================================================================
# The closing screen: short, the banner is the last big thing, details only in the log file
# ======================================================================================
Test-Case 'the closing screen of all three endings is short and ends with the log file name; details never appear on screen' {
    # (1) complete (also with uv installed during the run: a third instruction)
    $sc = New-Scenario -Fake @{ UvInstalled = $false } -Setup { param($h) Initialize-MattHome $h }
    try {
        $run = Invoke-ScenarioRun $sc
        Assert-Eq $run.Rc 0 $run.Results
        $after = @(Get-LinesAfter $run 'SETUP IS COMPLETE')
        Assert-True ($after.Count -le 6) ('too many lines after the banner: ' + $after.Count)
        Assert-Contains ($after -join "`n") '3. The uv tool was installed during this run. If Codex says it cannot start the AWS tool, sign out of Windows and sign back in once, then open Codex again.'
        Assert-Contains $after[$after.Count - 1] 'Log file (send it to the CTO if something went wrong): '
    }
    finally { Remove-Scenario $sc }
    # (2) finished with items that need a person
    $sc2 = New-Scenario -Fake @{ SkillsOk = $false } -Setup { param($h) Initialize-MattHome $h }
    try {
        $run2 = Invoke-ScenarioRun $sc2
        Assert-Eq $run2.Rc 2 $run2.Results
        $after2 = @(Get-LinesAfter $run2 'SETUP FINISHED, BUT SOME ITEMS NEED ATTENTION')
        Assert-True ($after2.Count -le 9) ('too many lines after the banner: ' + $after2.Count)
        $a2 = $after2 -join "`n"
        Assert-Contains $a2 'Most of the work is done. These items need a person:'
        Assert-Contains $a2 '* Could not read the AWS skill catalog.'
        Assert-Contains $a2 '1. Send the log file named below to the CTO. It holds the exact steps for each item.'
        Assert-Contains $a2 '2. Close Codex completely and open it again'
        Assert-Contains $after2[$after2.Count - 1] 'Log file (send it to the CTO if something went wrong): '
        Assert-NotContains $a2 '[OK]'
        Assert-NotContains $run2.Said 'DETAILS FOR THE CTO'
        Assert-Contains (Get-LogDetailsPart $run2) 'outcome: finished, but some items need attention'
    }
    finally { Remove-Scenario $sc2 }
    # (3) did not finish
    $sc3 = New-Scenario -Fake @{ WizardExit = 2 } -Setup { param($h) Initialize-MattHome $h }
    try {
        $run3 = Invoke-ScenarioRun $sc3
        Assert-Eq $run3.Rc 1
        $after3 = @(Get-LinesAfter $run3 'SETUP DID NOT FINISH')
        Assert-True ($after3.Count -le 6) ('too many lines after the banner: ' + $after3.Count)
        $a3 = $after3 -join "`n"
        Assert-Contains $a3 'What stopped it:'
        Assert-Contains $a3 'The AWS wizard stopped with an error (exit code 2)'
        Assert-Contains $a3 'What to do: run this script again. If it stops the same way, send the log file named below (and a screenshot of this window) to the CTO.'
        Assert-Contains $after3[$after3.Count - 1] 'Log file (send it to the CTO if something went wrong): '
        Assert-Contains (Get-LogDetailsPart $run3) 'outcome: did not finish'
        Assert-Contains (Get-LogDetailsPart $run3) 'What stopped the setup: The AWS wizard stopped with an error (exit code 2)'
    }
    finally { Remove-Scenario $sc3 }
}

Test-Case 'a long list of items that need attention is cut to five on screen; all of them are in the log file' {
    $h = New-TempDir
    try {
        $null = New-TestContext $h
        $script:Ctx.LogPath = Join-Path $h 'fake-log.txt'
        for ($i = 1; $i -le 8; $i++) { Add-Result 'ACTION' 'Step 5' ('item number ' + $i + ' ' + ('x' * 400)) }
        $script:Ctx.Said.Clear()
        Show-FinalSummary
        $said = @($script:Ctx.Said)
        $bullets = @($said | Where-Object { $_.StartsWith('  * item number') })
        Assert-Eq $bullets.Count 5
        Assert-True (@($bullets | Where-Object { $_.Length -gt 310 }).Count -eq 0) 'each item is shortened to a line'
        Assert-Contains ($said -join "`n") '... and 3 more (they are in the log file).'
        $det = Get-DetailBlockText
        for ($i = 1; $i -le 8; $i++) { Assert-Contains $det ('item number ' + $i + ' ') }
    }
    finally { Remove-Item -LiteralPath $h -Recurse -Force -ErrorAction SilentlyContinue }
}

Test-Case 'no log file could be written: the details are shown ABOVE the banner, and the banner is still the last big thing' {
    $sc = New-Scenario -Setup { param($h) Initialize-MattHome $h }
    try {
        $run = & {
            function Start-SetupLog { param([string]$ScriptDir, [string]$Stamp, [string]$UserHome) return '' }
            Invoke-ScenarioRun $sc
        }
        Assert-Eq $run.Rc 0 $run.Results
        Assert-Eq $run.Ctx.LogPath ''
        Assert-Contains $run.Said 'No log file could be written (the folder was not writable), so the details for the CTO are shown here:'
        Assert-Contains $run.Said 'DETAILS FOR THE CTO'
        $iDet = $run.Said.IndexOf('DETAILS FOR THE CTO', [StringComparison]::Ordinal)
        $iBanner = $run.Said.IndexOf('SETUP IS COMPLETE', [StringComparison]::Ordinal)
        Assert-True ($iDet -ge 0 -and $iBanner -gt $iDet) 'the details come before the banner'
        $after = @(Get-LinesAfter $run 'SETUP IS COMPLETE')
        Assert-True ($after.Count -le 5) ('too many lines after the banner: ' + $after.Count)
        Assert-NotContains ($after -join "`n") 'Log file (send it'
    }
    finally { Remove-Scenario $sc }
}

Test-Case 'if the details cannot be added to the log file, they are shown after the closing lines with a clear note (nothing is lost)' {
    $sc = New-Scenario -Setup { param($h) Initialize-MattHome $h }
    try {
        $run = & {
            function Add-LogText { param([string]$Path, [string]$Text) return $false }
            Invoke-ScenarioRun $sc
        }
        Assert-Eq $run.Rc 0 $run.Results
        Assert-Contains $run.Said 'The details for the CTO could not be added to the log file, so they are shown here instead:'
        Assert-Contains $run.Said 'DETAILS FOR THE CTO'
        $iBanner = $run.Said.IndexOf('SETUP IS COMPLETE', [StringComparison]::Ordinal)
        $iDet = $run.Said.IndexOf('DETAILS FOR THE CTO', [StringComparison]::Ordinal)
        Assert-True ($iDet -gt $iBanner) 'in this rare case the details follow the closing lines'
        Assert-NotContains $run.LogText 'DETAILS FOR THE CTO'
    }
    finally { Remove-Scenario $sc }
}

# ======================================================================================
# The sign-in step with a person at the keyboard: retry, the no-browser method, quitting
# ======================================================================================
Test-Case 'attended run: a failed sign-in can be retried with the no-browser method (R), and the setup then finishes' {
    $sc = New-Scenario -Fake @{ LoginExits = @(1, 0) } -Setup { param($h) Initialize-MattHome $h }
    try {
        $run = Invoke-ScenarioRun $sc -Attended -Answer @('', 'R')
        Assert-Eq $run.Rc 0 $run.Results
        $logins = @($run.Calls | Where-Object { $_.StartsWith('LIVE aws login') })
        Assert-Eq $logins.Count 2
        Assert-Eq $logins[0] 'LIVE aws login --region us-east-1 --profile otchealth'
        Assert-Eq $logins[1] 'LIVE aws login --region us-east-1 --profile otchealth --remote'
        Assert-Contains $run.Said 'The sign-in did not finish (exit code 1).'
        Assert-Contains ($run.Calls -join "`n") 'ASK Press Enter to try again, type R to try the no-browser method, or type Q to stop => [R]'
        Assert-Contains ($run.Calls -join "`n") 'ASK Press Enter to start => []'
        Assert-Contains ($run.Calls -join "`n") 'ASK Press Enter to close => []'
        Assert-Contains $run.Said 'SETUP IS COMPLETE'
    }
    finally { Remove-Scenario $sc }
}

Test-Case 'attended run: typing Q after a failed sign-in stops at once with the screenshot request (no third try, nothing else runs)' {
    $sc = New-Scenario -Fake @{ LoginExit = 1 } -Setup { param($h) Initialize-MattHome $h }
    try {
        $run = Invoke-ScenarioRun $sc -Attended -Answer @('', 'Q')
        Assert-Eq $run.Rc 1
        Assert-Eq @($run.Calls | Where-Object { $_.StartsWith('LIVE aws login') }).Count 1
        Assert-Contains $run.Said 'please send a screenshot of this window (and the log file) to the CTO'
        Assert-NoCall $run 'configure agent-toolkit'
    }
    finally { Remove-Scenario $sc }
}

Test-Case 'attended run: pressing Enter retries the normal sign-in, and three failures end the setup' {
    $sc = New-Scenario -Fake @{ LoginExit = 1 } -Setup { param($h) Initialize-MattHome $h }
    try {
        $run = Invoke-ScenarioRun $sc -Attended -Answer @('', '', '')
        Assert-Eq $run.Rc 1
        $logins = @($run.Calls | Where-Object { $_.StartsWith('LIVE aws login') })
        Assert-Eq $logins.Count 3
        Assert-Eq @($logins | Where-Object { $_.Contains('--remote') }).Count 0
    }
    finally { Remove-Scenario $sc }
}

Complete-Tests '06-mock-end-to-end'
