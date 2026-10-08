# 03 - unit tests for the Codex config.toml reader and the insert-only env patch.
# Every patched result is also parsed by Python's own tomllib (independent of our reader), which checks that
# the file is still valid TOML, that [mcp_servers.aws-mcp.env] has AWS_MCP_PROXY_PROFILES = "otchealth",
# and that removing that env table gives back exactly the original data.
. (Join-Path $PSScriptRoot 'TestHelpers.ps1')
. $script:ScriptUnderTest -TestMode
$script:Quiet = $true
$script:NoPauseMode = $true

$args1 = 'args = ["mcp-proxy-for-aws@latest", "https://aws-mcp.us-east-1.api.aws/mcp", "--metadata", "INSTALL_SOURCE=aws-cli"]'
$wizardBody = @"
model = "gpt-5-codex"

[mcp_servers.aws-mcp]
command = "uvx"
$args1
"@
$wizard = $wizardBody + "`n"

function Patch { param([string]$Text) return (Add-TomlMcpEnv -Text $Text) }

Test-Case 'wizard-style file: Patched, exact text, valid TOML' {
    $r = Patch $wizard
    Assert-Eq $r.State 'Patched' $r.Reason
    $expected = $wizardBody + "`n`n[mcp_servers.aws-mcp.env]`nAWS_MCP_PROXY_PROFILES = `"otchealth`"`n"
    Assert-Eq $r.Text $expected
    Assert-TomlPatchedOk $wizard $r.Text
}

Test-Case 'file that ends without a trailing newline' {
    $t = $wizardBody
    $r = Patch $t
    Assert-Eq $r.State 'Patched' $r.Reason
    Assert-True ($r.Text.EndsWith('AWS_MCP_PROXY_PROFILES = "otchealth"')) 'should end with the env line'
    Assert-TomlPatchedOk $t $r.Text
}

Test-Case 'CRLF file: only CRLF is added, no bare LF' {
    $t = ConvertTo-Crlf $wizard
    $r = Patch $t
    Assert-Eq $r.State 'Patched' $r.Reason
    Assert-True (($r.Text -replace "`r`n", '').IndexOf("`n") -lt 0) 'a bare LF was introduced'
    Assert-True ($r.Text.StartsWith($t.Substring(0, $t.Length - 2))) 'the original must stay as the prefix'
    Assert-TomlPatchedOk $t $r.Text
}

Test-Case 'other servers before and after are untouched; env goes right after the aws-mcp table' {
    $t = @"
[mcp_servers.other]
command = "node"
args = ["a"]

[mcp_servers.other.env]
FOO = "bar"

[mcp_servers.aws-mcp]
command = "uvx"
$args1

[mcp_servers.third]
command = "x"
"@
    $t = $t + "`n"
    $r = Patch $t
    Assert-Eq $r.State 'Patched' $r.Reason
    $i1 = $r.Text.IndexOf('[mcp_servers.aws-mcp.env]')
    $i2 = $r.Text.IndexOf('[mcp_servers.third]')
    Assert-True ($i1 -gt 0 -and $i1 -lt $i2) 'env table should come before [mcp_servers.third]'
    Assert-TomlPatchedOk $t $r.Text
}

Test-Case 'comments: header comment and trailing comment on the last line are kept in place' {
    $t = "[mcp_servers.aws-mcp] # from AWS`ncommand = `"uvx`"`n$args1 # keep me`n# a trailing comment`n"
    $r = Patch $t
    Assert-Eq $r.State 'Patched' $r.Reason
    Assert-Contains $r.Text "$args1 # keep me`n`n[mcp_servers.aws-mcp.env]"
    Assert-Contains $r.Text "# a trailing comment"
    Assert-TomlPatchedOk $t $r.Text
}

Test-Case 'multi-line args array (with a comment inside) is handled' {
    $t = @'
[mcp_servers.aws-mcp]
command = "uvx"
args = [
  "mcp-proxy-for-aws@latest",
  "https://aws-mcp.us-east-1.api.aws/mcp",
  # a comment inside the array
  "--metadata", "INSTALL_SOURCE=aws-cli",
]

[tui]
theme = "dark"
'@
    $r = Patch ($t + "`n")
    Assert-Eq $r.State 'Patched' $r.Reason
    Assert-Contains $r.Text "]`n`n[mcp_servers.aws-mcp.env]`nAWS_MCP_PROXY_PROFILES = `"otchealth`"`n`n[tui]"
    Assert-TomlPatchedOk ($t + "`n") $r.Text
}

Test-Case 'quoted and spaced headers name the same table' {
    foreach ($h in @('[mcp_servers."aws-mcp"]', '[ mcp_servers . aws-mcp ]', "[mcp_servers.'aws-mcp']")) {
        $t = "$h`ncommand = `"uvx`"`n$args1`n"
        $r = Patch $t
        Assert-Eq $r.State 'Patched' ("header $h : " + $r.Reason)
        Assert-TomlPatchedOk $t $r.Text
    }
}

Test-Case 'an existing env with the otchealth profile is AlreadyOk and nothing changes' {
    $variants = @(
        "[mcp_servers.aws-mcp]`ncommand = `"uvx`"`n$args1`n`n[mcp_servers.aws-mcp.env]`nAWS_MCP_PROXY_PROFILES = `"otchealth`"`n",
        "[mcp_servers.aws-mcp]`ncommand = `"uvx`"`n$args1`n`n[mcp_servers.aws-mcp.env]`nAWS_MCP_PROXY_PROFILES = `"default otchealth`"`n",
        "[mcp_servers.aws-mcp]`ncommand = `"uvx`"`n$args1`nenv = { AWS_MCP_PROXY_PROFILES = `"otchealth`" }`n",
        "[mcp_servers.aws-mcp]`ncommand = `"uvx`"`n$args1`nenv.AWS_MCP_PROXY_PROFILES = `"otchealth`"`n",
        "[mcp_servers.aws-mcp]`ncommand = `"uvx`"`n$args1`n`n[mcp_servers.aws-mcp.env]`nAWS_MCP_PROXY_PROFILES = 'otchealth'`n"
    )
    foreach ($t in $variants) {
        $r = Patch $t
        Assert-Eq $r.State 'AlreadyOk' ($t + ' => ' + $r.Reason)
        Assert-Eq $r.Text $t
    }
}

Test-Case 'an existing env without the profile is Refused (never merged automatically)' {
    $variants = @(
        "[mcp_servers.aws-mcp]`ncommand = `"uvx`"`n$args1`n`n[mcp_servers.aws-mcp.env]`nAWS_MCP_PROXY_PROFILES = `"default`"`n",
        "[mcp_servers.aws-mcp]`ncommand = `"uvx`"`n$args1`n`n[mcp_servers.aws-mcp.env]`nFOO = `"bar`"`n",
        "[mcp_servers.aws-mcp]`ncommand = `"uvx`"`n$args1`nenv = { FOO = `"bar`" }`n",
        "[mcp_servers.aws-mcp]`ncommand = `"uvx`"`n$args1`nenv.FOO = `"bar`"`n"
    )
    foreach ($t in $variants) {
        $r = Patch $t
        Assert-Eq $r.State 'Refused' ($t)
        Assert-Eq $r.Text $t
        Assert-True ($r.Reason.Length -gt 5) 'a reason is needed'
    }
}

Test-Case 'no aws-mcp entry gives NotFound (also with look-alikes and text inside strings)' {
    $variants = @(
        '',
        "# only a comment`n",
        "model = `"x`"`n[mcp_servers.other]`ncommand = `"y`"`n",
        "[mcp_servers.aws-mcp-extra]`ncommand = `"y`"`n",
        "[mcp_servers.AWS-MCP]`ncommand = `"y`"`n",
        "[mcp_servers.other]`ncommand = `"[mcp_servers.aws-mcp]`"`nargs = [`"[mcp_servers.aws-mcp]`"]`n",
        "developer_instructions = `"`"`"`n[mcp_servers.aws-mcp]`ncommand = `"uvx`"`n`"`"`"`n"
    )
    foreach ($t in $variants) {
        $r = Patch $t
        Assert-Eq $r.State 'NotFound' ($t + ' => ' + $r.Reason)
        Assert-Eq $r.Text $t
    }
}

Test-Case 'unusual definitions are Refused: duplicate tables, inline table, dotted keys, array of tables' {
    $variants = @(
        "[mcp_servers.aws-mcp]`ncommand = `"uvx`"`n[mcp_servers.aws-mcp]`nargs = []`n",
        "[mcp_servers]`naws-mcp = { command = `"uvx`" }`n",
        "mcp_servers.aws-mcp.command = `"uvx`"`n",
        "[[mcp_servers.aws-mcp]]`ncommand = `"uvx`"`n",
        "[mcp_servers.aws-mcp.env]`nFOO = `"bar`"`n"
    )
    foreach ($t in $variants) {
        $r = Patch $t
        Assert-Eq $r.State 'Refused' ($t + ' => ' + $r.Reason)
        Assert-Eq $r.Text $t
    }
}

Test-Case 'invalid TOML is Refused with the "could not be read safely" reason' {
    $variants = @("[mcp_servers.aws-mcp]`ncommand = `"uvx`n", "[mcp_servers.aws-mcp`ncommand = 1`n", "key value`n", "a = [1, 2`n", "x = {a = 1`n")
    foreach ($t in $variants) {
        $r = Patch $t
        Assert-Eq $r.State 'Refused' $t
        Assert-True ($r.Reason.StartsWith('the file could not be read safely')) $r.Reason
    }
}

Test-Case 'extra keys or sub-tables mean "not the plain AWS entry" (Looks = false) but can still be patched' {
    $plain = Get-TomlServerInfo -Text $wizard
    Assert-True $plain.Looks 'the wizard entry should look standard'
    $extraKey = "[mcp_servers.aws-mcp]`ncommand = `"uvx`"`n$args1`nstartup_timeout_sec = 30`n"
    $i = Get-TomlServerInfo -Text $extraKey
    Assert-True (-not $i.Looks) 'extra key'
    Assert-Eq $i.State 'Ready'
    $r = Patch $extraKey
    Assert-Eq $r.State 'Patched'
    Assert-TomlPatchedOk $extraKey $r.Text
    $sub = "[mcp_servers.aws-mcp]`ncommand = `"uvx`"`n$args1`n`n[mcp_servers.aws-mcp.tools.call_aws]`napproval_mode = `"approve`"`n"
    $i2 = Get-TomlServerInfo -Text $sub
    Assert-True (-not $i2.Looks) 'sub table'
    $r2 = Patch $sub
    Assert-Eq $r2.State 'Patched'
    Assert-True ($r2.Text.IndexOf('[mcp_servers.aws-mcp.env]') -lt $r2.Text.IndexOf('[mcp_servers.aws-mcp.tools.call_aws]')) 'env goes right after the main table'
    Assert-TomlPatchedOk $sub $r2.Text
    $other = "[mcp_servers.aws-mcp]`ncommand = `"node`"`nargs = [`"x`"]`n"
    Assert-True (-not (Get-TomlServerInfo -Text $other).Looks) 'a different command is not the AWS entry'
    $envOther = "[mcp_servers.aws-mcp]`ncommand = `"uvx`"`n$args1`n[mcp_servers.aws-mcp.env]`nAWS_MCP_PROXY_PROFILES = `"otchealth`"`nFOO = `"bar`"`n"
    Assert-True (-not (Get-TomlServerInfo -Text $envOther).Looks) 'an extra env variable would be lost by "codex mcp add"'
    $envOk = "[mcp_servers.aws-mcp]`ncommand = `"uvx`"`n$args1`n[mcp_servers.aws-mcp.env]`nAWS_MCP_PROXY_PROFILES = `"otchealth`"`n"
    Assert-True (Get-TomlServerInfo -Text $envOk).Looks 'our own env is fine'
}

Test-Case 'realistic config with projects, a multi-line string and Windows paths' {
    $t = @'
model = "gpt-5-codex"
approval_policy = "on-request"
developer_instructions = """
Be careful.
[mcp_servers.aws-mcp]
command = "not-a-real-table"
"""

[projects."C:\\Users\\matt\\code\\app"]
trust_level = "trusted"

[projects.'C:\Users\matt\other']
trust_level = "untrusted"

[tui]
notifications = true

[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]

[mcp_servers.context7.env]
MY_ENV_VAR = "MY_ENV_VALUE"

[mcp_servers.aws-mcp]
command = "uvx"
args = ["mcp-proxy-for-aws@latest", "https://aws-mcp.us-east-1.api.aws/mcp", "--metadata", "INSTALL_SOURCE=aws-cli"]

[features]
web_search_request = true
'@
    $t = $t + "`n"
    $r = Patch $t
    Assert-Eq $r.State 'Patched' $r.Reason
    Assert-TomlPatchedOk $t $r.Text
    $again = Patch $r.Text
    Assert-Eq $again.State 'AlreadyOk'
    Assert-Eq $again.Text $r.Text
}

Test-Case 'strings with escapes, literals and multi-line values in other tables do not confuse the reader' {
    $t = @'
a = "quote \" inside and backslash \\"
b = 'literal \no escapes'
c = """
multi "quoted" line with \
continuation
"""
d = '''
literal [mcp_servers.aws-mcp]
'''
e = [1, 2, [3, 4], { x = 1, y = "}" }]
f = 1979-05-27T07:32:00Z
g = -1.5e3
[mcp_servers.aws-mcp]
command = "uvx"
args = ["mcp-proxy-for-aws@latest"]
'@
    $t = $t + "`n"
    $r = Patch $t
    Assert-Eq $r.State 'Patched' $r.Reason
    Assert-TomlPatchedOk $t $r.Text
}

Test-Case 'a config with hundreds of trusted projects is patched correctly; an absurdly large one is refused, not hung on' {
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append("model = `"gpt-5`"`n`n")
    for ($i = 0; $i -lt 300; $i++) { [void]$sb.Append("[projects.'C:\Users\matt\code\project$i']`ntrust_level = `"trusted`"`n`n") }
    [void]$sb.Append($wizard)
    $t = $sb.ToString()
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $r = Patch $t
    $sw.Stop()
    Assert-Eq $r.State 'Patched' $r.Reason
    Assert-True ($sw.Elapsed.TotalSeconds -lt 60) ('too slow: ' + $sw.Elapsed.TotalSeconds + ' s')
    Assert-TomlPatchedOk $t $r.Text
    $huge = '# ' + ('x' * 1100000) + "`n" + $wizard
    $sw2 = [System.Diagnostics.Stopwatch]::StartNew()
    $r2 = Patch $huge
    $sw2.Stop()
    Assert-Eq $r2.State 'Refused'
    Assert-True ($r2.Reason.StartsWith('the file could not be read safely')) $r2.Reason
    Assert-Contains $r2.Reason 'unusually large'
    Assert-Eq $r2.Text $huge
    Assert-True ($sw2.Elapsed.TotalSeconds -lt 5) 'the size guard must answer at once'
}

Test-Case 'second run is idempotent' {
    $r1 = Patch $wizard
    $r2 = Patch $r1.Text
    Assert-Eq $r2.State 'AlreadyOk'
    Assert-Eq $r2.Text $r1.Text
}

Test-Case 'hand-edit texts mention the exact lines' {
    $h = Get-CodexEnvHandEdit 'C:\Users\matt\.codex\config.toml' 'otchealth'
    Assert-Contains $h '[mcp_servers.aws-mcp.env]'
    Assert-Contains $h 'AWS_MCP_PROXY_PROFILES = "otchealth"'
    $f = Get-CodexFullHandEdit 'C:\Users\matt\.codex\config.toml' 'otchealth'
    Assert-Contains $f '[mcp_servers.aws-mcp]'
    Assert-Contains $f 'command = "uvx"'
    Assert-Contains $f 'codex mcp add aws-mcp --env AWS_MCP_PROXY_PROFILES=otchealth'
    $combined = $h + $f
    Assert-True ($combined -notmatch '[^\x00-\x7F]') 'hand-edit text must be ASCII'
}

# ---- adding the WHOLE entry (the AWS wizard skipped Codex because "codex" was not on the PATH) ----
$entryBody = "[mcp_servers.aws-mcp]`ncommand = `"uvx`"`n$args1`n`n[mcp_servers.aws-mcp.env]`nAWS_MCP_PROXY_PROFILES = `"otchealth`""

function AddEntry { param([string]$Text) return (Add-TomlMcpEntry -Text $Text) }

Test-Case 'whole entry: an empty file gets exactly the standard entry and env table' {
    $r = AddEntry ''
    Assert-Eq $r.State 'Added' $r.Reason
    Assert-Eq $r.Text ($entryBody + "`n")
    Assert-TomlEntryAddedOk '' $r.Text
}

Test-Case 'whole entry: appended after the user''s own settings with one blank line, the original text stays in front' {
    $own = "model = `"gpt-5-codex`"`napproval_policy = `"on-request`"`n`n[projects.'C:\Users\matt\code\app']`ntrust_level = `"trusted`"`n"
    $r = AddEntry $own
    Assert-Eq $r.State 'Added' $r.Reason
    Assert-Eq $r.Text ($own + "`n" + $entryBody + "`n")
    Assert-TomlEntryAddedOk $own $r.Text
}

Test-Case 'whole entry: no trailing newline, trailing blank lines, and a file that is only comments all give exactly one blank line' {
    # input text, and exactly what must be added between it and the entry
    $cases = @(
        @('a = 1', "`n`n"),
        @("a = 1`n", "`n"),
        @("a = 1`n`n", ''),
        @("a = 1`n`n`n", ''),
        @('# only a comment', "`n`n"),
        @("# only a comment`n", "`n"),
        @("`n", "`n"),
        @('   ', "`n`n"),
        @("a = 1`n   `n", '')
    )
    foreach ($c in $cases) {
        $input = [string]$c[0]
        $gapWanted = [string]$c[1]
        $r = AddEntry $input
        Assert-Eq $r.State 'Added' ($r.Reason + ' for [' + (Show-Visible $input) + ']')
        Assert-Eq $r.Text ($input + $gapWanted + $entryBody + "`n") ('for [' + (Show-Visible $input) + ']')
        Assert-TomlEntryAddedOk $input $r.Text
    }
}

Test-Case 'whole entry: a CRLF file stays CRLF (no bare LF is introduced)' {
    $own = ConvertTo-Crlf "model = `"gpt-5-codex`"`n`n[mcp_servers.other]`ncommand = `"node`"`nargs = [`"a`"]`n"
    $r = AddEntry $own
    Assert-Eq $r.State 'Added' $r.Reason
    Assert-True (($r.Text -replace "`r`n", '').IndexOf("`n") -lt 0) 'a bare LF was introduced'
    Assert-True $r.Text.StartsWith($own) 'the original must stay in front'
    Assert-Contains $r.Text ("[mcp_servers.aws-mcp]`r`ncommand = `"uvx`"`r`n")
    Assert-TomlEntryAddedOk $own $r.Text
}

Test-Case 'whole entry: other servers (with their own env tables) are left alone and the file stays valid TOML' {
    $own = @"
[mcp_servers.other]
command = "node"
args = ["a", "b"]

[mcp_servers.other.env]
FOO = "bar"

[mcp_servers.third]
url = "https://example.com/mcp"
"@ + "`n"
    $r = AddEntry $own
    Assert-Eq $r.State 'Added' $r.Reason
    Assert-TomlEntryAddedOk $own $r.Text
}

Test-Case 'whole entry: a multi-line string that contains a fake header, and Windows paths, do not confuse it' {
    $own = @"
notes = """
[mcp_servers.aws-mcp]
command = "not a real entry"
"""
path = 'C:\Users\matt\.codex'

[projects.'C:\Users\matt\code\app']
trust_level = "trusted"
"@ + "`n"
    $r = AddEntry $own
    Assert-Eq $r.State 'Added' $r.Reason
    Assert-TomlEntryAddedOk $own $r.Text
}

Test-Case 'whole entry: an explicit [mcp_servers] parent table is fine, and an inline mcp_servers value is refused' {
    $parent = "[mcp_servers]`n`n[mcp_servers.other]`ncommand = `"node`"`n"
    $r1 = AddEntry $parent
    Assert-Eq $r1.State 'Added' $r1.Reason
    Assert-TomlEntryAddedOk $parent $r1.Text
    $inline = "mcp_servers = { other = { command = `"node`" } }`n"
    $r2 = AddEntry $inline
    Assert-Eq $r2.State 'Refused'
    Assert-Eq $r2.Text $inline
    Assert-Contains $r2.Reason 'mcp_servers'
}

Test-Case 'whole entry: dotted keys for mcp_servers outside its section, and an array of tables, are refused (they would clash)' {
    foreach ($bad in @("mcp_servers.other.command = `"node`"`n", "[[mcp_servers]]`nname = `"x`"`n")) {
        $r = AddEntry $bad
        Assert-Eq $r.State 'Refused' (Show-Visible $bad)
        Assert-Eq $r.Text $bad
    }
}

Test-Case 'whole entry: never used when an entry exists, when the file cannot be read, or when the structure is unusual' {
    foreach ($existing in @($wizard, ($wizard + "`n[mcp_servers.aws-mcp.env]`nAWS_MCP_PROXY_PROFILES = `"otchealth`"`n"), "[mcp_servers.aws-mcp]`ncommand = `"x`"`n[mcp_servers.aws-mcp]`n", "[mcp_servers.aws-mcp.env]`nA = `"b`"`n")) {
        $r = AddEntry $existing
        Assert-Eq $r.State 'Refused' (Show-Visible $existing)
        Assert-Eq $r.Text $existing
    }
    $broken = "a = [1, 2`n"
    $r2 = AddEntry $broken
    Assert-Eq $r2.State 'Refused'
    Assert-Contains $r2.Reason 'could not be read safely'
    $huge = AddEntry (('a = 1' + "`n") * 300000)
    Assert-Eq $huge.State 'Refused'
}

Test-Case 'whole entry: the standard lines match the hand-edit text and the wizard shape (Looks = true)' {
    $lines = @(Get-CodexEntryLines -Server 'aws-mcp' -EnvName 'AWS_MCP_PROXY_PROFILES' -ProfileName 'otchealth' -McpUrl 'https://aws-mcp.us-east-1.api.aws/mcp' -ProxyPackage 'mcp-proxy-for-aws')
    $hand = Get-CodexFullHandEdit 'C:\x\config.toml' 'otchealth'
    foreach ($l in $lines) { if ($l.Length -gt 0) { Assert-Contains $hand $l } }
    $info = Get-TomlServerInfo -Text (($lines -join "`n") + "`n")
    Assert-Eq $info.State 'AlreadyOk'
    Assert-True $info.Looks 'Looks'
    Assert-Eq $info.MainCount 1
    # the same text without the env table is what AWS's wizard writes: it is "Ready" and gets the env from the normal patch
    $wizardOnly = Get-TomlServerInfo -Text (($lines[0..2] -join "`n") + "`n")
    Assert-Eq $wizardOnly.State 'Ready'
    Assert-True $wizardOnly.Looks 'Looks (wizard shape)'
}

# ---- file wrapper ----
$tmp = New-TempDir
try {
    $null = New-TestContext $tmp
    $cfgPath = Join-Path $tmp 'config.toml'

    Test-Case 'file wrapper: patches on disk, keeps a byte-identical backup, verifies' {
        Save-Text $cfgPath $wizard
        $origBytes = Get-FileBytes $cfgPath
        $r = Update-CodexConfigEnv -Path $cfgPath
        Assert-Eq $r.State 'Patched' $r.Reason
        Assert-True (Test-Path -LiteralPath $r.Backup) 'backup missing'
        Assert-Contains $r.Backup '.pre-env-'
        Assert-Eq ([Convert]::ToBase64String((Get-FileBytes $r.Backup))) ([Convert]::ToBase64String($origBytes))
        Assert-TomlPatchedOk $wizard (Get-FileText $cfgPath)
        $second = Update-CodexConfigEnv -Path $cfgPath
        Assert-Eq $second.State 'AlreadyOk'
        Assert-True ($null -eq $second.Backup) 'no backup when nothing changes'
    }

    Test-Case 'file wrapper: missing file is NotFound and is not created' {
        $p = Join-Path $tmp 'nope.toml'
        $r = Update-CodexConfigEnv -Path $p
        Assert-Eq $r.State 'NotFound'
        Assert-True (-not (Test-Path -LiteralPath $p)) 'must not create the file'
    }

    Test-Case 'file wrapper: a BOM is preserved' {
        $p = Join-Path $tmp 'bom.toml'
        Save-Text $p $wizard -Bom
        $r = Update-CodexConfigEnv -Path $p
        Assert-Eq $r.State 'Patched' $r.Reason
        $b = Get-FileBytes $p
        Assert-True ($b[0] -eq 239 -and $b[1] -eq 187 -and $b[2] -eq 191) 'BOM lost'
        Assert-TomlPatchedOk $wizard (Get-FileText $p)
    }

    Test-Case 'file wrapper: no BOM is added to a file that had none' {
        $p = Join-Path $tmp 'nobom.toml'
        Save-Text $p $wizard
        [void](Update-CodexConfigEnv -Path $p)
        $b = Get-FileBytes $p
        Assert-True (-not ($b[0] -eq 239 -and $b[1] -eq 187)) 'BOM added'
    }

    Test-Case 'file wrapper: UTF-16, binary and invalid UTF-8 files are Refused and untouched' {
        $cases = @{
            'utf16.toml' = [byte[]](@(255, 254) + [System.Text.Encoding]::Unicode.GetBytes("a = 1`n"))
            'bin.toml'   = [byte[]](1, 2, 0, 3, 4)
            'bad8.toml'  = [byte[]](97, 32, 61, 32, 34, 195, 40, 34, 10)
        }
        foreach ($k in $cases.Keys) {
            $p = Join-Path $tmp $k
            [System.IO.File]::WriteAllBytes($p, $cases[$k])
            $r = Update-CodexConfigEnv -Path $p
            Assert-Eq $r.State 'Refused' $k
            Assert-Eq ([Convert]::ToBase64String((Get-FileBytes $p))) ([Convert]::ToBase64String($cases[$k])) "$k was modified"
            Assert-True ($null -eq $r.Backup) "$k got a backup"
        }
    }

    Test-Case 'file wrapper: Refused states leave the file byte-identical and make no backup' {
        $p = Join-Path $tmp 'refused.toml'
        $t = "[mcp_servers.aws-mcp]`ncommand = `"uvx`"`n$args1`n`n[mcp_servers.aws-mcp.env]`nFOO = `"bar`"`n"
        Save-Text $p $t
        $before = Get-FileBytes $p
        $r = Update-CodexConfigEnv -Path $p
        Assert-Eq $r.State 'Refused'
        Assert-Eq ([Convert]::ToBase64String((Get-FileBytes $p))) ([Convert]::ToBase64String($before))
        Assert-True ($null -eq $r.Backup) 'no backup expected'
    }

    Test-Case 'file wrapper: if the saved file does not verify, the original is restored' {
        $p = Join-Path $tmp 'corrupt.toml'
        Save-Text $p $wizard
        $before = Get-FileBytes $p
        $r = & {
            function Write-TextFile {
                param([string]$Path, [string]$Text, [bool]$Bom = $false)
                [System.IO.File]::WriteAllText($Path, $Text.Substring(0, $Text.Length - 5))   # simulates a damaged write
            }
            Update-CodexConfigEnv -Path $p
        }
        Assert-Eq $r.State 'Refused'
        Assert-Contains $r.Reason 'restored'
        Assert-Eq ([Convert]::ToBase64String((Get-FileBytes $p))) ([Convert]::ToBase64String($before))
    }

    Test-Case 'entry file wrapper: a missing config.toml is created with the standard entry (no backup, no BOM)' {
        $p = Join-Path $tmp 'sub\new-config.toml'
        $r = Add-CodexEntryToFile -Path $p
        Assert-Eq $r.State 'Added' $r.Reason
        Assert-True $r.Created 'Created'
        Assert-True ($null -eq $r.Backup) 'no backup for a new file'
        $b = Get-FileBytes $p
        Assert-True (-not ($b[0] -eq 239 -and $b[1] -eq 187)) 'no BOM expected'
        Assert-TomlEntryAddedOk '' (Get-FileText $p)
        $again = Add-CodexEntryToFile -Path $p
        Assert-Eq $again.State 'Refused'
        Assert-Contains $again.Reason 'already exists'
    }

    Test-Case 'entry file wrapper: an existing file is backed up byte for byte, the entry is appended, a BOM is kept' {
        $p = Join-Path $tmp 'own.toml'
        $own = "model = `"gpt-5-codex`"`n`n[projects.'C:\Users\matt\x']`ntrust_level = `"trusted`"`n"
        Save-Text $p $own -Bom
        $orig = Get-FileBytes $p
        $r = Add-CodexEntryToFile -Path $p
        Assert-Eq $r.State 'Added' $r.Reason
        Assert-True (-not $r.Created) 'not created'
        Assert-Contains $r.Backup '.pre-entry-'
        Assert-Eq ([Convert]::ToBase64String((Get-FileBytes $r.Backup))) ([Convert]::ToBase64String($orig))
        $b = Get-FileBytes $p
        Assert-True ($b[0] -eq 239 -and $b[1] -eq 187 -and $b[2] -eq 191) 'BOM lost'
        Assert-TomlEntryAddedOk $own (Get-FileText $p)
    }

    Test-Case 'entry file wrapper: unreadable and unusual files are refused and stay byte-identical, without a backup' {
        $cases = [ordered]@{
            'utf16.toml'   = [byte[]](@(255, 254) + [System.Text.Encoding]::Unicode.GetBytes("a = 1`n"))
            'bin.toml'     = [byte[]](1, 2, 0, 3, 4)
            'bad8.toml'    = [byte[]](97, 32, 61, 32, 34, 195, 40, 34, 10)
            'inline.toml'  = [System.Text.Encoding]::UTF8.GetBytes("mcp_servers = { other = { command = `"node`" } }`n")
            'broken.toml'  = [System.Text.Encoding]::UTF8.GetBytes("a = [1, 2`n")
        }
        foreach ($k in $cases.Keys) {
            $p = Join-Path $tmp ('entry-' + $k)
            [System.IO.File]::WriteAllBytes($p, $cases[$k])
            $r = Add-CodexEntryToFile -Path $p
            Assert-Eq $r.State 'Refused' $k
            Assert-Eq ([Convert]::ToBase64String((Get-FileBytes $p))) ([Convert]::ToBase64String($cases[$k])) "$k was modified"
            Assert-True ($null -eq $r.Backup) "$k got a backup"
        }
    }

    Test-Case 'entry file wrapper: if the saved file does not verify, an existing file is restored and a new file is removed again' {
        $p = Join-Path $tmp 'entry-corrupt.toml'
        Save-Text $p $wizard.Replace('aws-mcp', 'other-mcp')
        $before = Get-FileBytes $p
        $r = & {
            function Write-TextFile {
                param([string]$Path, [string]$Text, [bool]$Bom = $false)
                [System.IO.File]::WriteAllText($Path, $Text.Substring(0, $Text.Length - 5))   # simulates a damaged write
            }
            Add-CodexEntryToFile -Path $p
        }
        Assert-Eq $r.State 'Refused'
        Assert-Contains $r.Reason 'put back'
        Assert-Eq ([Convert]::ToBase64String((Get-FileBytes $p))) ([Convert]::ToBase64String($before))
        $newPath = Join-Path $tmp 'entry-corrupt-new.toml'
        $r2 = & {
            function Write-TextFile {
                param([string]$Path, [string]$Text, [bool]$Bom = $false)
                [System.IO.File]::WriteAllText($Path, $Text.Substring(0, $Text.Length - 5))
            }
            Add-CodexEntryToFile -Path $newPath
        }
        Assert-Eq $r2.State 'Refused'
        Assert-True (-not (Test-Path -LiteralPath $newPath)) 'a new file that failed verification must be removed again'
    }
}
finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Complete-Tests '03-unit-toml'
