# 04 - unit tests for the JSON settings reader and the insert-only env patch (Add-ProfileEnv and friends).
# Every patched result is also parsed by Python's own json module (independent of our reader): it checks that
# the file is still valid JSON, that the env block has AWS_MCP_PROXY_PROFILES = "otchealth", and that removing
# the env block gives back exactly the original data.
. (Join-Path $PSScriptRoot 'TestHelpers.ps1')
. $script:ScriptUnderTest -TestMode
$script:Quiet = $true
$script:NoPauseMode = $true

$wizardJson = @'
{
  "mcpServers": {
    "aws-mcp": {
      "command": "uvx",
      "args": [
        "mcp-proxy-for-aws@latest",
        "https://aws-mcp.us-east-1.api.aws/mcp",
        "--metadata",
        "INSTALL_SOURCE=aws-cli"
      ]
    }
  }
}
'@ + "`n"

function PatchJson {
    param([string]$Text, [string]$Parent = 'mcpServers', [string]$EnvKey = 'env')
    return (Add-JsonEnvToText -Text $Text -ParentKey $Parent -EnvKey $EnvKey)
}

Test-Case 'wizard-style JSON (indent 2): Patched, exact text, valid JSON' {
    $r = PatchJson $wizardJson
    Assert-Eq $r.State 'Patched' $r.Reason
    $expected = @'
{
  "mcpServers": {
    "aws-mcp": {
      "command": "uvx",
      "args": [
        "mcp-proxy-for-aws@latest",
        "https://aws-mcp.us-east-1.api.aws/mcp",
        "--metadata",
        "INSTALL_SOURCE=aws-cli"
      ],
      "env": {
        "AWS_MCP_PROXY_PROFILES": "otchealth"
      }
    }
  }
}
'@ + "`n"
    Assert-Eq $r.Text $expected
    Assert-JsonPatchedOk $wizardJson $r.Text
}

Test-Case 'Kiro-style entry (timeout and transport after args): env goes after the last member' {
    $t = @'
{
  "mcpServers": {
    "aws-mcp": {
      "command": "uvx",
      "args": ["mcp-proxy-for-aws@latest", "https://aws-mcp.us-east-1.api.aws/mcp"],
      "timeout": 100000,
      "transport": "stdio"
    }
  }
}
'@ + "`n"
    $r = PatchJson $t
    Assert-Eq $r.State 'Patched' $r.Reason
    Assert-Contains $r.Text "`"transport`": `"stdio`",`n      `"env`": {"
    Assert-JsonPatchedOk $t $r.Text
    Assert-True (Get-JsonServerInfo -Text $t).Looks 'Kiro default should look standard'
}

Test-Case 'other servers are untouched and only the aws-mcp entry changes' {
    $t = @'
{
  "theme": "dark",
  "mcpServers": {
    "other": { "command": "node", "args": ["x.js"], "env": { "A": "1" } },
    "aws-mcp": {
      "command": "uvx",
      "args": ["mcp-proxy-for-aws@latest"]
    },
    "third": { "command": "y" }
  },
  "numbers": [1, 2.5, -3e4, true, false, null, [], {}]
}
'@ + "`n"
    $r = PatchJson $t
    Assert-Eq $r.State 'Patched' $r.Reason
    Assert-JsonPatchedOk $t $r.Text
    Assert-Contains $r.Text '"third": { "command": "y" }'
    Assert-Contains $r.Text '"other": { "command": "node", "args": ["x.js"], "env": { "A": "1" } },'
}

Test-Case 'Claude Code style: an aws-mcp under "projects" is ignored, only the top-level entry is patched' {
    $t = @'
{
  "numStartups": 12,
  "mcpServers": {
    "aws-mcp": { "command": "uvx", "args": ["mcp-proxy-for-aws@latest"] }
  },
  "projects": {
    "C:/Users/matt/app": {
      "mcpServers": {
        "aws-mcp": { "command": "node", "args": ["custom.js"] }
      }
    }
  }
}
'@ + "`n"
    $r = PatchJson $t
    Assert-Eq $r.State 'Patched' $r.Reason
    Assert-JsonPatchedOk $t $r.Text
    $only = '{ "projects": { "p": { "mcpServers": { "aws-mcp": { "command": "node" } } } }, "mcpServers": {} }'
    Assert-Eq (PatchJson $only).State 'NotFound'
    $noParent = '{ "projects": { "p": { "mcpServers": { "aws-mcp": { "command": "node" } } } } }'
    Assert-Eq (PatchJson $noParent).State 'NotFound'
}

Test-Case 'compact one-line JSON, tabs and CRLF are patched in their own style' {
    $compact = '{"mcpServers":{"aws-mcp":{"command":"uvx","args":["mcp-proxy-for-aws@latest"]}}}'
    $r = PatchJson $compact
    Assert-Eq $r.State 'Patched' $r.Reason
    Assert-Contains $r.Text '"args":["mcp-proxy-for-aws@latest"], "env": {"AWS_MCP_PROXY_PROFILES": "otchealth"}}}}'
    Assert-JsonPatchedOk $compact $r.Text
    $tabs = "{`n`t`"mcpServers`": {`n`t`t`"aws-mcp`": {`n`t`t`t`"command`": `"uvx`",`n`t`t`t`"args`": [`"mcp-proxy-for-aws@latest`"]`n`t`t}`n`t}`n}`n"
    $r2 = PatchJson $tabs
    Assert-Eq $r2.State 'Patched' $r2.Reason
    Assert-Contains $r2.Text "`t`t`t`"env`": {`n`t`t`t`t`"AWS_MCP_PROXY_PROFILES`": `"otchealth`"`n`t`t`t}"
    Assert-JsonPatchedOk $tabs $r2.Text
    $crlf = ConvertTo-Crlf $wizardJson
    $r3 = PatchJson $crlf
    Assert-Eq $r3.State 'Patched' $r3.Reason
    Assert-True (($r3.Text -replace "`r`n", '').IndexOf("`n") -lt 0) 'a bare LF was introduced'
    Assert-JsonPatchedOk $crlf $r3.Text
}

Test-Case 'strings with braces, quotes, escapes, unicode escapes and trailing backslashes do not confuse the scanner' {
    $t = '{"note":"a } b { c \" d \\", "path":"C:\\Users\\matt\\", "u":"\u00e9\u4e2d", "mcpServers":{"x":{"command":"a\\\\"},"aws-mcp":{"command":"uvx","args":["mcp-proxy-for-aws@latest","}{\""]}}}'
    $r = PatchJson $t
    Assert-Eq $r.State 'Patched' $r.Reason
    Assert-JsonPatchedOk $t $r.Text
}

Test-Case 'existing env states: ours is AlreadyOk; anything else is Refused (never merged automatically)' {
    $ok = @(
        '{"mcpServers":{"aws-mcp":{"command":"uvx","args":["mcp-proxy-for-aws@latest"],"env":{"AWS_MCP_PROXY_PROFILES":"otchealth"}}}}',
        '{"mcpServers":{"aws-mcp":{"command":"uvx","args":["mcp-proxy-for-aws@latest"],"env":{"AWS_MCP_PROXY_PROFILES":"default otchealth","X":"1"}}}}'
    )
    foreach ($t in $ok) { $r = PatchJson $t; Assert-Eq $r.State 'AlreadyOk' $t; Assert-Eq $r.Text $t }
    $no = @(
        '{"mcpServers":{"aws-mcp":{"command":"uvx","args":["mcp-proxy-for-aws@latest"],"env":{"AWS_MCP_PROXY_PROFILES":"default"}}}}',
        '{"mcpServers":{"aws-mcp":{"command":"uvx","args":["mcp-proxy-for-aws@latest"],"env":{"FOO":"bar"}}}}',
        '{"mcpServers":{"aws-mcp":{"command":"uvx","args":["mcp-proxy-for-aws@latest"],"env":{}}}}',
        '{"mcpServers":{"aws-mcp":{"command":"uvx","args":["mcp-proxy-for-aws@latest"],"env":"oops"}}}',
        '{"mcpServers":{"aws-mcp":{"command":"uvx","args":["x"],"env":{"A":"1"},"env":{"B":"2"}}}}'
    )
    foreach ($t in $no) { $r = PatchJson $t; Assert-Eq $r.State 'Refused' $t; Assert-Eq $r.Text $t; Assert-True ($r.Reason.Length -gt 5) 'reason needed' }
}

Test-Case 'invalid JSON is Invalid (trailing comma, comment, single quotes, NaN, unterminated, extra text)' {
    $bad = @(
        '{"mcpServers":{"aws-mcp":{"command":"uvx",}}}',
        "{`"mcpServers`":{} // c`n}",
        "{'mcpServers':{}}",
        '{"a": NaN}',
        '{"mcpServers":{"aws-mcp":{"command":"uvx"',
        '{"a":1} x',
        '',
        '{"a" 1}'
    )
    foreach ($t in $bad) { $r = PatchJson $t; Assert-Eq $r.State 'Invalid' ("[" + $t + "] " + $r.Reason); Assert-Eq $r.Text $t }
}

Test-Case 'unusual shapes are Refused: top-level array, non-object parent, non-object entry, empty entry, duplicate keys' {
    $bad = @(
        '[1,2]',
        '{"mcpServers":[1]}',
        '{"mcpServers":{"aws-mcp":"uvx"}}',
        '{"mcpServers":{"aws-mcp":{}}}',
        '{"mcpServers":{"aws-mcp":{"command":"uvx"}},"mcpServers":{}}',
        '{"mcpServers":{"aws-mcp":{"command":"uvx"},"aws-mcp":{"command":"x"}}}'
    )
    foreach ($t in $bad) { $r = PatchJson $t; Assert-Eq $r.State 'Refused' ("[" + $t + "] " + $r.Reason); Assert-Eq $r.Text $t }
}

Test-Case 'OpenCode shape: parent "mcp", key "environment"' {
    $t = @'
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "aws-mcp": {
      "type": "local",
      "command": ["uvx", "mcp-proxy-for-aws@latest", "https://aws-mcp.us-east-1.api.aws/mcp", "--metadata", "INSTALL_SOURCE=aws-cli"]
    }
  }
}
'@ + "`n"
    $r = PatchJson $t 'mcp' 'environment'
    Assert-Eq $r.State 'Patched' $r.Reason
    Assert-Contains $r.Text '"environment": {'
    Assert-JsonPatchedOk $t $r.Text 'mcp' 'environment'
    Assert-Eq (PatchJson $t 'mcpServers' 'env').State 'NotFound'
}

Test-Case 'a big settings file (about 700 KB) is handled correctly and quickly' {
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append("{`n  `"projects`": {`n")
    for ($i = 0; $i -lt 4000; $i++) {
        [void]$sb.Append("    `"C:/Users/matt/proj$i`": { `"allowedTools`": [], `"history`": [`"hello \`"world\`" $i`", `"x`"], `"cost`": $i.5, `"mcpServers`": {} },`n")
    }
    [void]$sb.Append("    `"last`": {}`n  },`n  `"mcpServers`": {`n    `"aws-mcp`": {`n      `"command`": `"uvx`",`n      `"args`": [`"mcp-proxy-for-aws@latest`"]`n    }`n  }`n}`n")
    $t = $sb.ToString()
    Assert-True ($t.Length -gt 500000) 'test file should be large'
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $r = PatchJson $t
    $sw.Stop()
    Assert-Eq $r.State 'Patched' $r.Reason
    Assert-True ($sw.Elapsed.TotalSeconds -lt 60) ('too slow: ' + $sw.Elapsed.TotalSeconds + ' s')
    Write-Host ('        (big file patched in {0:N1} s)' -f $sw.Elapsed.TotalSeconds)
    Assert-JsonPatchedOk $t $r.Text
}

Test-Case 'a damaged file with a never-closed quote is rejected at once (no hang, no slow retry from every later quote)' {
    # Before the quick quote check, 40 KB of escaped quotes after one open quote took about 20 seconds.
    $cases = @(
        ('{"a": "' + ('\"' * 30000)),
        ('{"a": "' + ('a\"' * 30000)),
        ('{"a": "' + ('x' * 600000)),
        ('{"mcpServers":{"aws-mcp":{"command":"uvx","args":["mcp-proxy-for-aws@latest"],"note":"' + ('\\' * 50001)),
        ('{"a": "trailing backslash \')
    )
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    foreach ($t in $cases) {
        $r = PatchJson $t
        Assert-Eq $r.State 'Invalid' ('len ' + $t.Length)
        Assert-Contains $r.Reason 'never closed'
        Assert-Eq $r.Text $t
    }
    $sw.Stop()
    Assert-True ($sw.Elapsed.TotalSeconds -lt 10) ('too slow: ' + $sw.Elapsed.TotalSeconds + ' s')
}

Test-Case 'values we do not need to look inside are skipped, however they are shaped (deep nesting, brackets inside strings, unclosed)' {
    # (Python's json module and copy.deepcopy give up at about 500 levels, so the independent check uses 200 levels;
    # the 3000-level text below is checked by our own round-trip self-check only.)
    $deep = ('[' * 200) + (']' * 200)
    $t = '{"cache": ' + $deep + ', "note": "]]}} [[{{", "mcpServers": {"aws-mcp": {"command": "uvx", "args": ["mcp-proxy-for-aws@latest"]}}, "tail": {"a": [1, {"b": "}"}]}}'
    $r = PatchJson $t
    Assert-Eq $r.State 'Patched' $r.Reason
    Assert-JsonPatchedOk $t $r.Text
    $deeper = '{"cache": ' + (('[' * 3000) + (']' * 3000)) + ', "mcpServers": {"aws-mcp": {"command": "uvx", "args": ["mcp-proxy-for-aws@latest"]}}}'
    $rd = PatchJson $deeper
    Assert-Eq $rd.State 'Patched' $rd.Reason
    Assert-Contains $rd.Text '"env": {"AWS_MCP_PROXY_PROFILES": "otchealth"}'
    $open = '{"cache": [[[1, 2], "x"], "mcpServers": {"aws-mcp": {"command": "uvx"}}}'
    $r2 = PatchJson $open
    Assert-Eq $r2.State 'Invalid' $r2.Reason
    $stray = '{"cache": {"a": 1, # nope' + "`n" + '}, "mcpServers": {"aws-mcp": {"command": "uvx"}}}'
    Assert-Eq (PatchJson $stray).State 'Invalid'
    # a skipped value that lies inside the guided path but is not the aws-mcp entry itself
    $other = '{"mcpServers": {"big": {"x": [' + ('{"k": [1, 2, 3]},' * 2000) + '{}]}, "aws-mcp": {"command": "uvx", "args": ["mcp-proxy-for-aws@latest"]}}}'
    $r3 = PatchJson $other
    Assert-Eq $r3.State 'Patched' $r3.Reason
    Assert-JsonPatchedOk $other $r3.Text
}

Test-Case 'if the reader ever takes too long it reports "unreadable" instead of hanging (regex time limit)' {
    # A stand-in for a pathological file: the token search is replaced by a pattern that backtracks without end (nested
    # quantifiers) and has a short time limit. (A time limit of 1 millisecond on the normal search is not reliable: the timer
    # of the regex engine in Windows PowerShell 5.1 only ticks about every 15 ms, and every normal match is far quicker.)
    $text = ('a' * 40) + '!'
    $saved = $script:JsonTokenRe
    try {
        $script:JsonTokenRe = New-Object System.Text.RegularExpressions.Regex('^(a+)+$', [System.Text.RegularExpressions.RegexOptions]::Singleline, [TimeSpan]::FromMilliseconds(200))
        $r = PatchJson $text
        Assert-Eq $r.State 'Invalid' 'expected the time limit to be hit'
        Assert-Contains $r.Reason 'too long'
        Assert-Eq $r.Text $text
    }
    finally { $script:JsonTokenRe = $saved }
    $normal = '{"mcpServers": {"aws-mcp": {"command": "uvx", "args": ["mcp-proxy-for-aws@latest"]}}}'
    Assert-Eq (PatchJson $normal).State 'Patched' 'the normal regex must be restored'
}

Test-Case 'Looks classification: standard entries yes, custom entries no' {
    Assert-True (Get-JsonServerInfo -Text $wizardJson).Looks 'wizard default'
    Assert-True (-not (Get-JsonServerInfo -Text '{"mcpServers":{"aws-mcp":{"command":"node","args":["x"]}}}').Looks) 'custom command'
    Assert-True (-not (Get-JsonServerInfo -Text '{"mcpServers":{"aws-mcp":{"command":"uvx","args":["mcp-proxy-for-aws@latest"],"disabled":true}}}').Looks) 'extra key'
    Assert-True (-not (Get-JsonServerInfo -Text '{"mcpServers":{"aws-mcp":{"command":"uvx","args":["something-else"]}}}').Looks) 'other package'
}

Test-Case 'second run is idempotent' {
    $r1 = PatchJson $wizardJson
    $r2 = PatchJson $r1.Text
    Assert-Eq $r2.State 'AlreadyOk'
    Assert-Eq $r2.Text $r1.Text
}

Test-Case 'hand-edit texts are ASCII and name the exact setting' {
    $h = Get-JsonEnvHandEdit 'C:\Users\matt\.cursor\mcp.json' 'otchealth'
    Assert-Contains $h '"env": { "AWS_MCP_PROXY_PROFILES": "otchealth" }'
    $o = Get-OpenCodeHandEdit 'C:\Users\matt\.config\opencode\opencode.json' 'otchealth'
    Assert-Contains $o '"environment": { "AWS_MCP_PROXY_PROFILES": "otchealth" }'
    Assert-True (($h + $o) -notmatch '[^\x00-\x7F]') 'must be ASCII'
}

# ---- file wrapper ----
$tmp = New-TempDir
try {
    $null = New-TestContext $tmp

    Test-Case 'file wrapper: patches on disk, backup is byte-identical, only the insertion differs' {
        $p = Join-Path $tmp 'mcp.json'
        Save-Text $p $wizardJson
        $origBytes = Get-FileBytes $p
        $r = Add-ProfileEnv -Path $p
        Assert-Eq $r.State 'Patched' $r.Reason
        Assert-Contains $r.Backup '.pre-env-'
        Assert-Eq ([Convert]::ToBase64String((Get-FileBytes $r.Backup))) ([Convert]::ToBase64String($origBytes))
        $new = Get-FileText $p
        Assert-JsonPatchedOk $wizardJson $new
        $obj = $new | ConvertFrom-Json
        Assert-Eq $obj.mcpServers.'aws-mcp'.env.AWS_MCP_PROXY_PROFILES 'otchealth'
        $again = Add-ProfileEnv -Path $p
        Assert-Eq $again.State 'AlreadyOk'
        Assert-True ($null -eq $again.Backup) 'no backup when nothing changes'
    }

    Test-Case 'file wrapper: missing file and file without an aws-mcp entry give NoEntry and are not changed' {
        $r = Add-ProfileEnv -Path (Join-Path $tmp 'missing.json')
        Assert-Eq $r.State 'NoEntry'
        $p = Join-Path $tmp 'noentry.json'
        Save-Text $p '{"mcpServers":{"other":{"command":"x"}}}'
        $before = Get-FileBytes $p
        $r2 = Add-ProfileEnv -Path $p
        Assert-Eq $r2.State 'NoEntry'
        Assert-Eq ([Convert]::ToBase64String((Get-FileBytes $p))) ([Convert]::ToBase64String($before))
    }

    Test-Case 'file wrapper: a BOM is preserved' {
        $p = Join-Path $tmp 'bom.json'
        Save-Text $p $wizardJson -Bom
        $r = Add-ProfileEnv -Path $p
        Assert-Eq $r.State 'Patched' $r.Reason
        $b = Get-FileBytes $p
        Assert-True ($b[0] -eq 239 -and $b[1] -eq 187 -and $b[2] -eq 191) 'BOM lost'
        Assert-JsonPatchedOk $wizardJson (Get-FileText $p)
    }

    Test-Case 'file wrapper: Invalid and Refused files stay byte-identical with no backup' {
        $cases = @{
            'invalid.json' = '{"mcpServers":{"aws-mcp":{"command":"uvx",}}}'
            'refused.json' = '{"mcpServers":{"aws-mcp":{"command":"uvx","env":{"FOO":"bar"}}}}'
        }
        foreach ($k in $cases.Keys) {
            $p = Join-Path $tmp $k
            Save-Text $p $cases[$k]
            $before = Get-FileBytes $p
            $r = Add-ProfileEnv -Path $p
            Assert-True ($r.State -eq 'Invalid' -or $r.State -eq 'Refused') "$k : $($r.State)"
            Assert-Eq ([Convert]::ToBase64String((Get-FileBytes $p))) ([Convert]::ToBase64String($before)) "$k changed"
            Assert-True ($null -eq $r.Backup) "$k backup"
        }
    }

    Test-Case 'file wrapper: UTF-16 and invalid UTF-8 files are Refused and untouched' {
        $cases = @{
            'u16.json' = [byte[]](@(255, 254) + [System.Text.Encoding]::Unicode.GetBytes('{"a":1}'))
            'b8.json'  = [byte[]](123, 34, 97, 34, 58, 34, 195, 40, 34, 125)
        }
        foreach ($k in $cases.Keys) {
            $p = Join-Path $tmp $k
            [System.IO.File]::WriteAllBytes($p, $cases[$k])
            $r = Add-ProfileEnv -Path $p
            Assert-Eq $r.State 'Refused' $k
            Assert-Eq ([Convert]::ToBase64String((Get-FileBytes $p))) ([Convert]::ToBase64String($cases[$k])) "$k changed"
        }
    }

    Test-Case 'file wrapper: if the saved file does not verify, the original is restored' {
        $p = Join-Path $tmp 'corrupt.json'
        Save-Text $p $wizardJson
        $before = Get-FileBytes $p
        $r = & {
            function Write-TextFile {
                param([string]$Path, [string]$Text, [bool]$Bom = $false)
                [System.IO.File]::WriteAllText($Path, $Text.Substring(0, $Text.Length - 7))
            }
            Add-ProfileEnv -Path $p
        }
        Assert-Eq $r.State 'Refused'
        Assert-Contains $r.Reason 'restored'
        Assert-Eq ([Convert]::ToBase64String((Get-FileBytes $p))) ([Convert]::ToBase64String($before))
    }

    Test-Case 'file wrapper: a file that PowerShell itself cannot parse is still patched safely (our scanner is the check)' {
        # duplicate keys that differ only by case: ConvertFrom-Json in PowerShell 7.5 rejects this, so the extra PowerShell check is skipped
        $t = '{"Key":1,"key":2,"mcpServers":{"aws-mcp":{"command":"uvx","args":["mcp-proxy-for-aws@latest"]}}}'
        $p = Join-Path $tmp 'dupcase.json'
        Save-Text $p $t
        $r = Add-ProfileEnv -Path $p
        Assert-Eq $r.State 'Patched' $r.Reason
        Assert-JsonPatchedOk $t (Get-FileText $p)
    }
}
finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Complete-Tests '04-unit-json-env'
