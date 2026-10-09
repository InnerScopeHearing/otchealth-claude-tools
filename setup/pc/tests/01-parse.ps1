# 01 - the script (and every test file) parses with zero errors, and loading the script with -TestMode runs nothing.
# This runs in PowerShell 7 on Linux and in Windows PowerShell 5.1 on the GitHub Windows machine: in 5.1 the parser
# that checks the files is the real 5.1 parser.
. (Join-Path $PSScriptRoot 'TestHelpers.ps1')

Test-Case 'script file exists' {
    Assert-True (Test-Path -LiteralPath $script:ScriptUnderTest) "missing: $script:ScriptUnderTest"
}

Test-Case 'parses with zero errors (System.Management.Automation.Language.Parser.ParseFile)' {
    $errs = $null
    $toks = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($script:ScriptUnderTest, [ref]$toks, [ref]$errs)
    $msg = ''
    foreach ($e in $errs) { $msg += ('{0}:{1} {2}; ' -f $e.Extent.StartLineNumber, $e.Extent.StartColumnNumber, $e.Message) }
    Assert-Eq $errs.Count 0 $msg
}

Test-Case 'the script and every test file use LF line endings only (a checkout that turned them into CRLF would change the files)' {
    $bad = New-Object 'System.Collections.Generic.List[string]'
    $all = @(Get-Item -LiteralPath $script:ScriptUnderTest) + @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1') + @(Get-ChildItem -LiteralPath $script:PyDir -Filter '*.py') + @(Get-ChildItem -LiteralPath $script:FixtureDir)
    foreach ($f in $all) {
        $b = [System.IO.File]::ReadAllBytes($f.FullName)
        if ([Array]::IndexOf($b, [byte]13) -ge 0) { $bad.Add($f.Name) }
    }
    Assert-Eq $bad.Count 0 ('files with a CR byte: ' + ($bad -join ', ') + ' (git must not change line endings: see setup/pc/.gitattributes and core.autocrlf)')
}

Test-Case 'every test file and helper in the tests folder parses with zero errors too' {
    $bad = New-Object 'System.Collections.Generic.List[string]'
    foreach ($f in @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1')) {
        $errs = $null
        $toks = $null
        [void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$toks, [ref]$errs)
        foreach ($e in $errs) { $bad.Add(('{0}:{1} {2}' -f $f.Name, $e.Extent.StartLineNumber, $e.Message)) }
    }
    Assert-Eq $bad.Count 0 ($bad -join '; ')
}

Test-Case 'declares #Requires -Version 5.1 and the -TestMode / -NoPause switches' {
    $text = Get-Content -LiteralPath $script:ScriptUnderTest -Raw
    Assert-Contains $text '#Requires -Version 5.1'
    $errs = $null; $toks = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($script:ScriptUnderTest, [ref]$toks, [ref]$errs)
    $names = @($ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
    Assert-True ($names -contains 'TestMode') 'no -TestMode parameter'
    Assert-True ($names -contains 'NoPause') 'no -NoPause parameter'
}

Test-Case 'loading with -TestMode defines the functions and runs nothing' {
    $out = & {
        . $script:ScriptUnderTest -TestMode
        $cmds = @('Invoke-Main', 'Add-TomlMcpEnv', 'Add-ProfileEnv', 'Set-RulesBlock', 'Update-RulesFile', 'Update-CodexConfigEnv', 'Invoke-ProcessCapture', 'Invoke-Step5Toolkit')
        foreach ($c in $cmds) { if (-not (Get-Command $c -ErrorAction SilentlyContinue)) { throw "function not defined: $c" } }
        'loaded'
    }
    Assert-Eq (@($out)[-1]) 'loaded'
    Assert-True (@($out).Count -eq 1) ('loading printed unexpected output: ' + ($out -join ' | '))
}

Test-Case 'the settings in $script:Cfg match the brief' {
    . $script:ScriptUnderTest -TestMode
    Assert-Eq $script:Cfg.ProfileName 'otchealth'
    Assert-Eq $script:Cfg.Region 'us-east-1'
    Assert-Eq $script:Cfg.AccountId '900915535335'
    Assert-Eq $script:Cfg.ExpectedArn 'arn:aws:iam::900915535335:user/otchealth-ai-reader'
    Assert-Eq $script:Cfg.RulesCommit '188af2f810ce4df1b699cb55dd02f28bfa8eb2c8'
    Assert-Eq $script:Cfg.RulesSha256 '11b87c6758be781e367dc961f7b3c80a2c2b978d0d9e287c4920741c91069a39'
    Assert-Contains $script:Cfg.RulesUrl $script:Cfg.RulesCommit 'the rules URL must be pinned to the commit'
    Assert-NotContains $script:Cfg.RulesUrl 'refs/heads/main'
    Assert-Eq $script:Cfg.BeginMarker '<!-- BEGIN AWS Agent Toolkit rules -->'
    Assert-Eq $script:Cfg.EndMarker '<!-- END AWS Agent Toolkit rules -->'
}

Test-Case 'the pinned rules fixture has the pinned sha256' {
    . $script:ScriptUnderTest -TestMode
    $bytes = [System.IO.File]::ReadAllBytes($script:FixtureRules)
    Assert-Eq (Get-Sha256Hex $bytes) $script:Cfg.RulesSha256
}

Complete-Tests '01-parse'
