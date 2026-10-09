# 09 - a seeded randomized test of the two Codex config.toml editors against Python's own TOML parser.
# Hundreds of generated config files (LF and CRLF, comments, multi-line strings and arrays, quoted headers, arrays of
# tables, other servers, projects with Windows paths ...) go through
#   Add-TomlMcpEntry   (the file has no aws-mcp entry: the whole standard entry is appended)
#   Add-TomlMcpEnv     (the file has the plain AWS entry from the wizard: the env sub-table is inserted)
# and Python's tomllib must then read the result with exactly the intended data, and the edit must be a pure insertion.
# The seed is fixed, so a failure can be reproduced. Needs Python 3.11+ (skipped with a visible note without it).
. (Join-Path $PSScriptRoot 'TestHelpers.ps1')
. $script:ScriptUnderTest -TestMode
$script:Quiet = $true
$script:NoPauseMode = $true

$casesPerMode = 300
$longString = 'long = """' + "`n" + 'line one' + "`n" + '[mcp_servers.aws-mcp]' + "`n" + '"""'
$multiArray = 'multi = [' + "`n" + '  "a",  # first' + "`n" + '  "b",' + "`n" + ']'
$rootKvs = @(
    'model = "gpt-5-codex"',
    'approval_policy = "on-request"',
    "sandbox_mode = 'workspace-write'",
    'x = [1, 2, 3]',
    'y = { a = 1, b = "two" }',
    $longString,
    'esc = "a \"quoted\" \\ value"',
    '"quoted key" = 1',
    "'literal key' = 2",
    $multiArray,
    'dotted.key.here = "v"',
    'when = 1979-05-27T07:32:00Z',
    'f = 3.14e2'
)
$tables = @(
    @("[projects.'C:\Users\matt\code\app']", 'trust_level = "trusted"'),
    @('[projects."D:\\work"]', 'trust_level = "untrusted"'),
    @('[mcp_servers.other]', 'command = "node"', 'args = ["a", "b"]'),
    @('[mcp_servers.other.env]', 'FOO = "bar"'),
    @('[mcp_servers]'),
    @('[features]', 'a = true', 'b = false'),
    @('[tui]', 'theme = "dark"'),
    @('[profiles.fast]', 'model = "gpt-5-mini"'),
    @('[[plugins]]', 'name = "one"'),
    @('[tools.web]', 'search = { enabled = true }')
)
$awsShapes = @(
    @('[mcp_servers.aws-mcp]', 'command = "uvx"', 'args = ["mcp-proxy-for-aws@latest", "https://aws-mcp.us-east-1.api.aws/mcp", "--metadata", "INSTALL_SOURCE=aws-cli"]'),
    @('[mcp_servers.aws-mcp]', 'command = "uvx"', 'args = [', '  "mcp-proxy-for-aws@latest",  # the proxy', '  "https://aws-mcp.us-east-1.api.aws/mcp",', '  "--metadata", "INSTALL_SOURCE=aws-cli",', ']'),
    @('[ mcp_servers . "aws-mcp" ]  # entry', 'command = "uvx"', 'args = ["mcp-proxy-for-aws@latest"]  # trailing comment'),
    @('[mcp_servers.aws-mcp]', "command = 'uvx'", 'args = ["mcp-proxy-for-aws@latest", "x"]', '', '', '# a comment after the entry')
)
$comments = @('# a comment', '  # indented comment', '#', '')

function New-RandomConfig {
    # Returns the text of one generated, valid config.toml. $WithAws puts the plain AWS entry among the tables.
    param($Rnd, [bool]$WithAws)
    $nl = "`n"
    if ($Rnd.Next(2) -eq 0) { $nl = "`r`n" }
    $lines = New-Object 'System.Collections.Generic.List[string]'
    $seen = @{}
    foreach ($i in 1..$Rnd.Next(0, 5)) {
        if ($Rnd.Next(4) -eq 0) { $lines.Add($comments[$Rnd.Next($comments.Count)]) }
        $kv = $rootKvs[$Rnd.Next($rootKvs.Count)]
        $k = ($kv -split '[ =\.]')[0]
        if (-not $seen.ContainsKey($k)) { $seen[$k] = $true; $lines.Add($kv) }
    }
    $blocks = New-Object 'System.Collections.Generic.List[object]'
    $used = @{}
    foreach ($i in 1..$Rnd.Next(0, 5)) {
        $ti = $Rnd.Next($tables.Count)
        if ($used.ContainsKey($ti)) { continue }
        $used[$ti] = $true
        $blocks.Add($tables[$ti])
    }
    if ($WithAws) { $blocks.Insert($Rnd.Next(0, $blocks.Count + 1), $awsShapes[$Rnd.Next($awsShapes.Count)]) }
    foreach ($b in $blocks) {
        if ($Rnd.Next(2) -eq 0) { $lines.Add('') }
        foreach ($l in $b) { $lines.Add($l) }
        if ($Rnd.Next(4) -eq 0) { $lines.Add($comments[$Rnd.Next($comments.Count)]) }
    }
    $text = ($lines.ToArray() -join $nl)
    switch ($Rnd.Next(4)) {
        1 { $text = $text + $nl }
        2 { $text = $text + $nl + $nl }
        3 { $text = $text + $nl + '   ' + $nl }
    }
    return $text
}

Test-Case 'randomized: the whole-entry insertion and the env insertion agree with Python tomllib on hundreds of generated files' {
    $dir = New-TempDir
    try {
        $rnd = New-Object System.Random(20261007)
        $enc = New-Object System.Text.UTF8Encoding($false)
        $entryAdded = 0
        $envPatched = 0
        for ($n = 0; $n -lt $casesPerMode; $n++) {
            $text = New-RandomConfig $rnd $false
            $r = Add-TomlMcpEntry -Text $text
            Assert-Eq $r.State 'Added' ('entry case ' + $n + ': ' + $r.Reason + ' for [' + (Show-Visible $text) + ']')
            [System.IO.File]::WriteAllBytes((Join-Path $dir ('a{0:0000}-orig.toml' -f $n)), $enc.GetBytes($text))
            [System.IO.File]::WriteAllBytes((Join-Path $dir ('a{0:0000}-entry.toml' -f $n)), $enc.GetBytes($r.Text))
            $entryAdded++
            $text2 = New-RandomConfig $rnd $true
            $r2 = Add-TomlMcpEnv -Text $text2
            Assert-Eq $r2.State 'Patched' ('env case ' + $n + ': ' + $r2.Reason + ' for [' + (Show-Visible $text2) + ']')
            [System.IO.File]::WriteAllBytes((Join-Path $dir ('b{0:0000}-orig.toml' -f $n)), $enc.GetBytes($text2))
            [System.IO.File]::WriteAllBytes((Join-Path $dir ('b{0:0000}-env.toml' -f $n)), $enc.GetBytes($r2.Text))
            $envPatched++
        }
        Assert-Eq $entryAdded $casesPerMode
        Assert-Eq $envPatched $casesPerMode
        $py = Invoke-Py 'check_toml_batch.py' @($dir)
        if ($py.ExitCode -eq 99) { Skip-PythonCrossCheck; return }
        Assert-Eq $py.ExitCode 0 $py.Output
        Assert-Contains $py.Output ('checked pairs ok=' + (2 * $casesPerMode) + ' problems=0')
    }
    finally { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }
}

Complete-Tests '09-fuzz-toml-vs-python'
