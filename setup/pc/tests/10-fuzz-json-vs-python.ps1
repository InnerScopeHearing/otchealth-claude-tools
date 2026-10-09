# 10 - a seeded randomized test of the JSON settings editor (Add-JsonEnvToText: Claude Code, Cline, Cursor, Gemini CLI,
# Kiro, Windsurf) against Python's own JSON parser.
# Hundreds of generated settings files (2 or 4 spaces, tabs, compact and one-line layouts, LF and CRLF, tricky strings with
# braces, quotes, backslashes and unicode, deep "projects" sections with look-alike aws-mcp entries) get the "env" block
# inserted. Python must then read the result with exactly the intended data, no look-alike entry may have been touched,
# and the edit must be a pure insertion. The seed is fixed. Needs Python 3 (skipped with a visible note without it).
. (Join-Path $PSScriptRoot 'TestHelpers.ps1')
. $script:ScriptUnderTest -TestMode
$script:Quiet = $true
$script:NoPauseMode = $true

$casesCount = 300
$eAcute = [string][char]233
$tricky = @('plain', 'a "quoted" word', 'back\slash', 'a } brace', 'a { brace', 'a ] bracket and [ another', 'colon: and, comma', ('caf' + $eAcute), 'tab' + "`t" + 'inside', 'two' + "`n" + 'lines', 'unicode \u00e9 escape text', '', ' ', 'http://example.com/a?b=c&d=e')

function ConvertTo-JsonText {
    param([string]$S, [bool]$EscapeNonAscii)
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('"')
    foreach ($ch in $S.ToCharArray()) {
        $c = [int]$ch
        if ($c -eq 34) { [void]$sb.Append('\"') }
        elseif ($c -eq 92) { [void]$sb.Append('\\') }
        elseif ($c -eq 10) { [void]$sb.Append('\n') }
        elseif ($c -eq 13) { [void]$sb.Append('\r') }
        elseif ($c -eq 9) { [void]$sb.Append('\t') }
        elseif ($c -lt 32 -or ($EscapeNonAscii -and $c -gt 126)) { [void]$sb.Append(('\u{0:x4}' -f $c)) }
        else { [void]$sb.Append($ch) }
    }
    [void]$sb.Append('"')
    return $sb.ToString()
}

function ConvertTo-StyledJson {
    # Value: OrderedDictionary (object), List[object] (array), string, bool, $null or @{ Raw = '...' } (a number written as is).
    param($Value, $Style, [int]$Level)
    if ($null -eq $Value) { return 'null' }
    if ($Value -is [bool]) { if ($Value) { return 'true' } else { return 'false' } }
    if ($Value -is [string]) { return (ConvertTo-JsonText $Value $Style.EscapeNonAscii) }
    if ($Value -is [hashtable]) { return [string]$Value.Raw }
    $parts = New-Object 'System.Collections.Generic.List[string]'
    $isObject = ($Value -is [System.Collections.Specialized.OrderedDictionary])
    if ($isObject) {
        if ($Value.Count -eq 0) { return '{}' }
        foreach ($k in $Value.Keys) { $parts.Add((ConvertTo-JsonText ([string]$k) $Style.EscapeNonAscii) + $Style.Colon + (ConvertTo-StyledJson $Value[$k] $Style ($Level + 1))) }
        $open = '{'; $close = '}'
    }
    else {
        if ($Value.Count -eq 0) { return '[]' }
        foreach ($item in $Value) { $parts.Add((ConvertTo-StyledJson $item $Style ($Level + 1))) }
        $open = '['; $close = ']'
    }
    if ($Style.Kind -eq 'compact') { return $open + ($parts.ToArray() -join ',') + $close }
    if ($Style.Kind -eq 'inline' -or (-not $isObject -and $Style.InlineArrays)) {
        if ($isObject) { return $open + ' ' + ($parts.ToArray() -join ', ') + ' ' + $close }
        return $open + ($parts.ToArray() -join ', ') + $close
    }
    $pad = $Style.Indent * ($Level + 1)
    $padEnd = $Style.Indent * $Level
    return $open + $Style.Nl + $pad + ($parts.ToArray() -join (',' + $Style.Nl + $pad)) + $Style.Nl + $padEnd + $close
}

function New-RandomJsonValue {
    param($Rnd, [int]$Depth)
    $kind = $Rnd.Next(7)
    if ($Depth -le 0 -and $kind -ge 5) { $kind = $Rnd.Next(5) }
    switch ($kind) {
        0 { return $tricky[$Rnd.Next($tricky.Count)] }
        1 { return @{ Raw = @('0', '-1', '3.14', '-1.5e3', '2E+10', '100000')[$Rnd.Next(6)] } }
        2 { return [bool]($Rnd.Next(2)) }
        3 { return $null }
        4 { return $tricky[$Rnd.Next($tricky.Count)] }
        5 {
            $o = New-Object System.Collections.Specialized.OrderedDictionary
            foreach ($i in 1..$Rnd.Next(0, 4)) { $o[('k' + $Rnd.Next(100) + $tricky[$Rnd.Next(4)].Replace(' ', '_'))] = New-RandomJsonValue $Rnd ($Depth - 1) }
            return $o
        }
        default {
            $a = New-Object 'System.Collections.Generic.List[object]'
            foreach ($i in 1..$Rnd.Next(0, 5)) { $a.Add((New-RandomJsonValue $Rnd ($Depth - 1))) }
            return , $a
        }
    }
}

function New-AwsEntry {
    param($Rnd)
    $e = New-Object System.Collections.Specialized.OrderedDictionary
    $e['command'] = 'uvx'
    $args = New-Object 'System.Collections.Generic.List[object]'
    foreach ($a in @('mcp-proxy-for-aws@latest', 'https://aws-mcp.us-east-1.api.aws/mcp', '--metadata', 'INSTALL_SOURCE=aws-cli')) { $args.Add($a) }
    if ($Rnd.Next(5) -ne 0) { $e['args'] = $args }
    if ($Rnd.Next(3) -eq 0) { $e['timeout'] = @{ Raw = '100000' } }
    if ($Rnd.Next(3) -eq 0) { $e['transport'] = 'stdio' }
    return $e
}

function New-OtherServer {
    param($Rnd)
    $e = New-Object System.Collections.Specialized.OrderedDictionary
    $e['command'] = 'node'
    $a = New-Object 'System.Collections.Generic.List[object]'
    $a.Add('server.js')
    $e['args'] = $a
    if ($Rnd.Next(2) -eq 0) { $v = New-Object System.Collections.Specialized.OrderedDictionary; $v['FOO'] = 'bar'; $e['env'] = $v }
    return $e
}

function New-ServersObject {
    # an "mcpServers" object; $WithAws puts the aws-mcp entry among 0 to 2 other servers
    param($Rnd, [bool]$WithAws)
    $names = New-Object 'System.Collections.Generic.List[string]'
    foreach ($i in 1..$Rnd.Next(0, 3)) { $names.Add('other' + $i) }
    if ($WithAws) { $names.Insert($Rnd.Next(0, $names.Count + 1), 'aws-mcp') }
    $o = New-Object System.Collections.Specialized.OrderedDictionary
    foreach ($n in $names) { if ($n -eq 'aws-mcp') { $o[$n] = New-AwsEntry $Rnd } else { $o[$n] = New-OtherServer $Rnd } }
    return $o
}

function New-RandomSettings {
    param($Rnd)
    $root = New-Object System.Collections.Specialized.OrderedDictionary
    $fields = New-Object 'System.Collections.Generic.List[string]'
    foreach ($f in @('numStartups', 'theme', 'history', 'other', 'projects', 'mcpServers', 'flags')) { if ($f -eq 'mcpServers' -or $Rnd.Next(3) -gt 0) { $fields.Add($f) } }
    $shuffled = @($fields.ToArray() | Sort-Object { $Rnd.Next() })
    foreach ($f in $shuffled) {
        switch ($f) {
            'numStartups' { $root[$f] = @{ Raw = [string]$Rnd.Next(0, 500) } }
            'theme' { $root[$f] = 'dark' }
            'history' { $h = New-Object 'System.Collections.Generic.List[object]'; foreach ($i in 1..$Rnd.Next(0, 6)) { $h.Add($tricky[$Rnd.Next($tricky.Count)]) }; $root[$f] = $h }
            'other' { $root[$f] = New-RandomJsonValue $Rnd 4 }
            'flags' { $fl = New-Object System.Collections.Specialized.OrderedDictionary; $fl['a'] = $true; $fl['b'] = $null; $root[$f] = $fl }
            'projects' {
                $p = New-Object System.Collections.Specialized.OrderedDictionary
                foreach ($i in 1..$Rnd.Next(0, 4)) {
                    $proj = New-Object System.Collections.Specialized.OrderedDictionary
                    if ($Rnd.Next(2) -eq 0) { $proj['history'] = New-RandomJsonValue $Rnd 3 }
                    $proj['mcpServers'] = New-ServersObject $Rnd ($Rnd.Next(2) -eq 0)    # look-alike entries that must NOT be edited
                    if ($Rnd.Next(2) -eq 0) { $proj['allowedTools'] = New-RandomJsonValue $Rnd 3 }
                    $p[('C:/Users/matt/project' + $i)] = $proj
                }
                $root[$f] = $p
            }
            'mcpServers' { $root[$f] = New-ServersObject $Rnd $true }
        }
    }
    $kinds = @('multi', 'multi', 'multi', 'compact', 'inline')
    $indents = @('  ', '    ', "`t")
    $style = @{
        Kind = $kinds[$Rnd.Next($kinds.Count)]
        Indent = $indents[$Rnd.Next($indents.Count)]
        Nl = @("`n", "`r`n")[$Rnd.Next(2)]
        Colon = ': '
        EscapeNonAscii = ($Rnd.Next(2) -eq 0)
        InlineArrays = ($Rnd.Next(2) -eq 0)
    }
    if ($style.Kind -eq 'compact') { $style.Colon = ':' }
    $text = ConvertTo-StyledJson $root $style 0
    switch ($Rnd.Next(3)) {
        1 { $text = $text + $style.Nl }
        2 { $text = $text + $style.Nl + $style.Nl }
    }
    return $text
}

Test-Case 'randomized: the env insertion into mcpServers.aws-mcp agrees with Python json on hundreds of generated files, and look-alike entries are never touched' {
    $dir = New-TempDir
    try {
        $rnd = New-Object System.Random(20261007)
        $enc = New-Object System.Text.UTF8Encoding($false)
        $patched = 0
        for ($n = 0; $n -lt $casesCount; $n++) {
            $text = New-RandomSettings $rnd
            $r = Add-JsonEnvToText -Text $text -ParentKey 'mcpServers' -EnvKey 'env'
            Assert-Eq $r.State 'Patched' ('case ' + $n + ': ' + $r.Reason + ' for [' + (Show-Visible $text) + ']')
            [System.IO.File]::WriteAllBytes((Join-Path $dir ('j{0:0000}-orig.json' -f $n)), $enc.GetBytes($text))
            [System.IO.File]::WriteAllBytes((Join-Path $dir ('j{0:0000}-new.json' -f $n)), $enc.GetBytes($r.Text))
            $patched++
        }
        Assert-Eq $patched $casesCount
        $py = Invoke-Py 'check_json_batch.py' @($dir)
        if ($py.ExitCode -eq 99) { Skip-PythonCrossCheck; return }
        Assert-Eq $py.ExitCode 0 $py.Output
        Assert-Contains $py.Output ('checked pairs ok=' + $casesCount + ' problems=0')
    }
    finally { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }
}

Complete-Tests '10-fuzz-json-vs-python'
