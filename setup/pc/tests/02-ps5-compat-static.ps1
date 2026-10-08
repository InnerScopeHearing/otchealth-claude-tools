# 02 - static checks that the script (and the test files) only use what Windows PowerShell 5.1 understands.
# These are SYNTAX and API deny-list checks. They cannot prove 5.1 behaviour by themselves: the real proof is that the
# same tests also run in Windows PowerShell 5.1 on the GitHub Windows machine (.github/workflows/pc-toolkit-ps51.yml).
. (Join-Path $PSScriptRoot 'TestHelpers.ps1')

$path = $script:ScriptUnderTest
$errs = $null
$toks = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$toks, [ref]$errs)
$bytes = [System.IO.File]::ReadAllBytes($path)
$allNodes = @($ast.FindAll({ param($n) $true }, $true))

function Get-Nodes {
    param([string]$TypeName)
    return @($allNodes | Where-Object { $_.GetType().Name -eq $TypeName })
}

Test-Case 'no PowerShell 7 only syntax nodes (ternary, pipeline chains, null-conditional access)' {
    $bad = @($allNodes | Where-Object { $_.GetType().Name -in @('TernaryExpressionAst', 'PipelineChainAst', 'NullConditionalMemberAccessAst', 'NullConditionalIndexExpressionAst') })
    Assert-Eq $bad.Count 0 ('found: ' + (($bad | ForEach-Object { $_.Extent.StartLineNumber }) -join ','))
}

Test-Case 'no PowerShell 7 only tokens (??, ??=, ?., ?[, &&, ||)' {
    $deny = @('QuestionQuestion', 'QuestionQuestionEquals', 'QuestionDot', 'QuestionLBracket', 'QuestionMark', 'AndAnd', 'OrOr')
    $bad = @($toks | Where-Object { $deny -contains $_.Kind.ToString() })
    Assert-Eq $bad.Count 0 ('found: ' + (($bad | ForEach-Object { $_.Kind.ToString() + '@' + $_.Extent.StartLineNumber }) -join ','))
}

Test-Case 'no PowerShell 7 only commands or parameters' {
    $badCmds = @('Test-Json', 'Join-String', 'Get-Error', 'Get-Uptime', 'ConvertFrom-Markdown', 'Show-Markdown', 'Invoke-Expression', 'iex', 'Set-Content', 'Add-Content', 'Out-File')
    $badParams = @('Parallel', 'ThrottleLimit', 'AsHashtable', 'AsByteStream', 'SkipCertificateCheck', 'SkipHttpErrorCheck', 'NoEnumerate', 'AsUTC', 'Authentication', 'ResponseHeadersVariable', 'SslProtocol', 'NoProxy', 'EnumsAsStrings', 'DateKind', 'Encoding', 'AdditionalChildPath')
    $found = New-Object 'System.Collections.Generic.List[string]'
    foreach ($c in (Get-Nodes 'CommandAst')) {
        $name = $c.GetCommandName()
        if ($name -and ($badCmds -contains $name)) { $found.Add('command ' + $name + '@' + $c.Extent.StartLineNumber) }
    }
    foreach ($p in (Get-Nodes 'CommandParameterAst')) {
        if ($badParams -contains $p.ParameterName) { $found.Add('parameter -' + $p.ParameterName + '@' + $p.Extent.StartLineNumber) }
    }
    Assert-Eq $found.Count 0 ($found -join '; ')
}

Test-Case 'Join-Path is never called with more than two positional arguments' {
    $found = New-Object 'System.Collections.Generic.List[string]'
    foreach ($c in (Get-Nodes 'CommandAst')) {
        if ($c.GetCommandName() -ne 'Join-Path') { continue }
        $positional = 0
        $skipNext = $false
        for ($i = 1; $i -lt $c.CommandElements.Count; $i++) {
            $el = $c.CommandElements[$i]
            if ($el -is [System.Management.Automation.Language.CommandParameterAst]) { continue }
            $positional++
        }
        if ($positional -gt 2) { $found.Add('line ' + $c.Extent.StartLineNumber) }
    }
    Assert-Eq $found.Count 0 ($found -join '; ')
}

Test-Case 'no PowerShell 7 only automatic variables' {
    $deny = @('IsWindows', 'IsLinux', 'IsMacOS', 'IsCoreCLR', 'PSStyle', 'PSNativeCommandArgumentPassing', 'PSNativeCommandUseErrorActionPreference', 'PSDefaultParameterValues2')
    $found = @(Get-Nodes 'VariableExpressionAst' | Where-Object { $deny -contains $_.VariablePath.UserPath })
    Assert-Eq $found.Count 0 ($found | ForEach-Object { $_.VariablePath.UserPath })
    $members = @(Get-Nodes 'MemberExpressionAst' | Where-Object { $_.Member -is [System.Management.Automation.Language.StringConstantExpressionAst] -and @('OS', 'Platform', 'GitCommitId') -contains $_.Member.Value -and $_.Expression.Extent.Text -match 'PSVersionTable' })
    Assert-Eq $members.Count 0 'PSVersionTable.OS/Platform do not exist in 5.1'
}

Test-Case 'no .NET Core only members (ArgumentList, Kill($true), Split(), ToHexString, Contains with 2 arguments ...)' {
    $found = New-Object 'System.Collections.Generic.List[string]'
    foreach ($m in (Get-Nodes 'InvokeMemberExpressionAst')) {
        $name = $m.Member.Extent.Text
        $argc = 0
        if ($m.Arguments) { $argc = $m.Arguments.Count }
        if ($name -in @('Split', 'GetRelativePath', 'ToHexString', 'ReadAllTextAsync', 'ReadAllBytesAsync', 'WriteAllTextAsync')) { $found.Add($name + '@' + $m.Extent.StartLineNumber) }
        if ($name -eq 'Kill' -and $argc -gt 0) { $found.Add('Kill with arguments@' + $m.Extent.StartLineNumber) }
        if ($name -eq 'Contains' -and $argc -gt 1) { $found.Add('Contains with 2 arguments@' + $m.Extent.StartLineNumber) }
        if ($name -eq 'Replace' -and $argc -gt 2 -and -not $m.Static) { $found.Add('Replace with 3 arguments@' + $m.Extent.StartLineNumber) }
        if ($name -eq 'Join' -and $m.Expression.Extent.Text -match 'Path') { $found.Add('Path.Join@' + $m.Extent.StartLineNumber) }
    }
    foreach ($m in (Get-Nodes 'MemberExpressionAst')) {
        if ($m.Member.Extent.Text -in @('ArgumentList', 'ProcessPath')) { $found.Add($m.Member.Extent.Text + '@' + $m.Extent.StartLineNumber) }
    }
    Assert-Eq $found.Count 0 ($found -join '; ')
}

Test-Case 'no comma list is silently turned into a "+" expression (PowerShell binds the comma tighter than +)' {
    $bad = @(Get-Nodes 'BinaryExpressionAst' | Where-Object { $_.Operator -eq [System.Management.Automation.Language.TokenKind]::Plus -and $_.Left -is [System.Management.Automation.Language.ArrayLiteralAst] })
    Assert-Eq $bad.Count 0 ('found at lines: ' + (($bad | ForEach-Object { $_.Extent.StartLineNumber }) -join ','))
}

Test-Case 'the file is pure ASCII (so no em or en dashes) and has no BOM' {
    $bad = New-Object 'System.Collections.Generic.List[string]'
    $line = 1
    for ($i = 0; $i -lt $bytes.Length; $i++) {
        if ($bytes[$i] -eq 10) { $line++ }
        if ($bytes[$i] -gt 127) { $bad.Add('line ' + $line); if ($bad.Count -gt 5) { break } }
    }
    Assert-Eq $bad.Count 0 ('non-ASCII bytes at: ' + ($bad -join ', '))
    Assert-True (-not ($bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191)) 'file starts with a BOM'
}

Test-Case 'the script has no control characters other than tab, CR and LF' {
    $bad = @($bytes | Where-Object { $_ -lt 32 -and $_ -ne 9 -and $_ -ne 10 -and $_ -ne 13 })
    Assert-Eq $bad.Count 0
}

Test-Case 'a transcript is started, stopped in a finally block, and the window waits for Enter' {
    $text = [System.Text.Encoding]::ASCII.GetString($bytes)
    Assert-Contains $text 'Start-Transcript'
    Assert-Contains $text "Read-Host 'Press Enter to close'"
    $stopInFinally = $false
    foreach ($t in (Get-Nodes 'TryStatementAst')) {
        if ($t.Finally) {
            $cmds = @($t.Finally.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true))
            foreach ($c in $cmds) { if ($c.GetCommandName() -eq 'Stop-Transcript') { $stopInFinally = $true } }
        }
    }
    Assert-True $stopInFinally 'Stop-Transcript is not inside a finally block'
}

Test-Case 'no stream redirection of any kind (2>&1 would turn native stderr into terminating errors in 5.1)' {
    $r = @(Get-Nodes 'FileRedirectionAst') + @(Get-Nodes 'MergingRedirectionAst')
    Assert-Eq $r.Count 0 ('found at lines: ' + (($r | ForEach-Object { $_.Extent.StartLineNumber }) -join ','))
}

Test-Case 'function names are unique' {
    $names = @(Get-Nodes 'FunctionDefinitionAst' | ForEach-Object { $_.Name })
    $dups = @($names | Group-Object | Where-Object { $_.Count -gt 1 } | ForEach-Object { $_.Name })
    Assert-Eq $dups.Count 0 ($dups -join ',')
}

Test-Case 'no assignment to a built-in variable such as $Profile, $Home, $Host, $Args, $Matches' {
    $deny = @('profile', 'home', 'host', 'args', 'input', 'matches', 'pid', 'pwd', 'error', 'shellid', 'event', 'sender', 'stacktrace', 'executioncontext', 'myinvocation', 'psitem', 'this', 'true', 'false', 'null', '_', 'pshome', 'psboundparameters', 'pscmdlet', 'foreach', 'switch', 'lastexitcode')
    $found = New-Object 'System.Collections.Generic.List[string]'
    foreach ($a in (Get-Nodes 'AssignmentStatementAst')) {
        $left = $a.Left
        if ($left -is [System.Management.Automation.Language.VariableExpressionAst]) {
            if ($deny -contains $left.VariablePath.UserPath.ToLowerInvariant()) { $found.Add($left.VariablePath.UserPath + '@' + $a.Extent.StartLineNumber) }
        }
    }
    foreach ($p in (Get-Nodes 'ParameterAst')) {
        if ($deny -contains $p.Name.VariablePath.UserPath.ToLowerInvariant()) { $found.Add('param ' + $p.Name.VariablePath.UserPath + '@' + $p.Extent.StartLineNumber) }
    }
    Assert-Eq $found.Count 0 ($found -join '; ')
}

# The shipped script does not use strict mode (see below), so a mistyped variable name would silently be empty.
# This check stands in for strict mode: inside a function, every plain variable that is read must have been
# received as a parameter or assigned in that same function (so nothing depends on PowerShell's habit of letting
# a called function see its caller's variables), and every $script: variable that is read must be assigned somewhere.
function Get-AssignedVariableNames {
    param($Node)
    $names = New-Object 'System.Collections.Generic.List[string]'
    $VarAst = [System.Management.Automation.Language.VariableExpressionAst]
    foreach ($a in @($Node.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] }, $true))) {
        $targets = @($a.Left)
        if ($a.Left -is [System.Management.Automation.Language.ArrayLiteralAst]) { $targets = @($a.Left.Elements) }
        foreach ($t in $targets) {
            while ($t -is [System.Management.Automation.Language.ConvertExpressionAst]) { $t = $t.Child }
            if ($t -is $VarAst) { $names.Add($t.VariablePath.UserPath) }
        }
    }
    foreach ($f in @($Node.FindAll({ param($n) $n -is [System.Management.Automation.Language.ForEachStatementAst] }, $true))) { $names.Add($f.Variable.VariablePath.UserPath) }
    foreach ($p in @($Node.FindAll({ param($n) $n -is [System.Management.Automation.Language.ParameterAst] }, $true))) { $names.Add($p.Name.VariablePath.UserPath) }
    return @($names)
}

Test-Case 'variables: every plain variable a function reads was received or assigned in that function (no typos, no reliance on the caller)' {
    $auto = @('_', 'args', 'true', 'false', 'null', 'psitem', 'matches', 'error', 'lastexitcode', 'psscriptroot', 'pscommandpath', 'psboundparameters', 'pscmdlet', 'myinvocation', 'host', 'pid', 'input', 'this', 'executioncontext', 'psversiontable', 'erroractionpreference', 'progresspreference', 'warningpreference', 'verbosepreference', 'home', 'pshome')
    $problems = New-Object 'System.Collections.Generic.List[string]'
    foreach ($fn in (Get-Nodes 'FunctionDefinitionAst')) {
        $known = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
        foreach ($n in (Get-AssignedVariableNames $fn)) { [void]$known.Add($n) }
        foreach ($v in @($fn.FindAll({ param($n) $n -is [System.Management.Automation.Language.VariableExpressionAst] }, $true))) {
            $vp = $v.VariablePath
            if ($vp.IsDriveQualified -or $vp.IsScript -or $vp.IsGlobal -or $vp.IsPrivate) { continue }
            $name = $vp.UserPath
            if ($auto -contains $name.ToLowerInvariant() -or $known.Contains($name)) { continue }
            $problems.Add($fn.Name + ': $' + $name + ' (line ' + $v.Extent.StartLineNumber + ')')
        }
    }
    Assert-Eq $problems.Count 0 ($problems -join '; ')
    $scriptAssigned = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($n in (Get-AssignedVariableNames $ast)) { if ($n -match '^script:(.+)$') { [void]$scriptAssigned.Add($Matches[1]) } }
    $missing = New-Object 'System.Collections.Generic.List[string]'
    foreach ($v in @($allNodes | Where-Object { $_ -is [System.Management.Automation.Language.VariableExpressionAst] -and $_.VariablePath.IsScript })) {
        $nm = $v.VariablePath.UserPath -replace '^script:', ''
        if (-not $scriptAssigned.Contains($nm)) { $missing.Add('$script:' + $nm + ' (line ' + $v.Extent.StartLineNumber + ')') }
    }
    Assert-Eq $missing.Count 0 ('read but never assigned: ' + ($missing -join '; '))
}

Test-Case 'variables: inside each function a variable is always written with the same capital letters (PowerShell ignores case: $B and $b are one variable)' {
    $problems = New-Object 'System.Collections.Generic.List[string]'
    foreach ($fn in (Get-Nodes 'FunctionDefinitionAst')) {
        $spellings = @{}
        foreach ($v in @($fn.FindAll({ param($n) $n -is [System.Management.Automation.Language.VariableExpressionAst] }, $true))) {
            $vp = $v.VariablePath
            if ($vp.IsDriveQualified) { continue }
            $name = $vp.UserPath
            $key = $name.ToLowerInvariant()
            if (-not $spellings.ContainsKey($key)) { $spellings[$key] = New-Object 'System.Collections.Generic.List[string]' }
            if (-not $spellings[$key].Contains($name)) { $spellings[$key].Add($name) }
        }
        foreach ($k in $spellings.Keys) {
            if ($spellings[$k].Count -gt 1) { $problems.Add($fn.Name + ': ' + ($spellings[$k] -join ' / ')) }
        }
    }
    Assert-Eq $problems.Count 0 ($problems -join '; ')
}

Test-Case 'programs are started only inside Invoke-ProcessCapture and Invoke-LiveCommand' {
    $found = New-Object 'System.Collections.Generic.List[string]'
    foreach ($n in (Get-Nodes 'FunctionDefinitionAst')) {
        if ($n.Name -in @('Invoke-ProcessCapture', 'Invoke-LiveCommand')) { continue }
        $t = $n.Extent.Text
        if ($t -match 'ProcessStartInfo|System\.Diagnostics\.Process|Start-Process') { $found.Add($n.Name) }
    }
    # direct calls of native programs by name are not allowed anywhere
    $natives = @('aws', 'codex', 'uv', 'uvx', 'powershell', 'powershell.exe', 'python', 'python3', 'node', 'npx', 'curl', 'git')
    foreach ($c in (Get-Nodes 'CommandAst')) {
        $name = $c.GetCommandName()
        if ($name -and ($natives -contains $name.ToLowerInvariant())) { $found.Add('native ' + $name + '@' + $c.Extent.StartLineNumber) }
        if ($c.InvocationOperator -eq [System.Management.Automation.Language.TokenKind]::Ampersand) {
            $first = $c.CommandElements[0].Extent.Text
            if ($first -ne '$Function' -and $first -ne '$Body') { $found.Add('call operator ' + $first + '@' + $c.Extent.StartLineNumber) }
        }
    }
    Assert-Eq $found.Count 0 ($found -join '; ')
}

Test-Case 'the script is not run in strict mode and does not change the machine-wide execution policy' {
    $text = [System.Text.Encoding]::ASCII.GetString($bytes)
    Assert-NotContains $text 'Set-StrictMode'
    Assert-NotContains $text 'Set-ExecutionPolicy'
}

Test-Case 'user-facing strings contain no em dash, en dash or emoji (checked on the raw bytes above) and no " - " used as a dash' {
    $text = [System.Text.Encoding]::ASCII.GetString($bytes)
    $hits = New-Object 'System.Collections.Generic.List[string]'
    $ln = 0
    foreach ($l in ($text -split "`n")) {
        $ln++
        if ($l -match "^\s*#") { continue }
        if ($l -match "Out-Say|Add-Result|Add-Manual|Stop-Setup|Show-StepHeader" -and $l -match "'[^']* - [^']*'") { $hits.Add('line ' + $ln) }
    }
    Assert-Eq $hits.Count 0 ($hits -join ', ')
}

Test-Case 'a generic List is never wrapped in @( ) (pwsh 7.5 throws "Argument types do not match" for that); use .ToArray() instead' {
    # Found while testing: @($list) on a List[object] threw in PowerShell 7.5. The script converts with .ToArray().
    $found = New-Object 'System.Collections.Generic.List[string]'
    foreach ($fn in (Get-Nodes 'FunctionDefinitionAst')) {
        $listVars = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
        foreach ($a in @($fn.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] }, $true))) {
            if ($a.Left -is [System.Management.Automation.Language.VariableExpressionAst] -and $a.Right.Extent.Text -match 'System\.Collections\.Generic\.List') {
                [void]$listVars.Add($a.Left.VariablePath.UserPath)
            }
        }
        foreach ($arr in @($fn.FindAll({ param($n) $n -is [System.Management.Automation.Language.ArrayExpressionAst] }, $true))) {
            $inner = $arr.SubExpression.Extent.Text.Trim()
            if ($inner -match '^\$([A-Za-z_][A-Za-z0-9_]*)$' -and $listVars.Contains($Matches[1])) {
                $found.Add($fn.Name + ': @($' + $Matches[1] + ') (line ' + $arr.Extent.StartLineNumber + ')')
            }
        }
    }
    Assert-Eq $found.Count 0 ($found -join '; ')
}

Test-Case 'the test files and helpers themselves use nothing that Windows PowerShell 5.1 lacks (they run there too)' {
    $badSyntax = @('TernaryExpressionAst', 'PipelineChainAst', 'NullConditionalMemberAccessAst', 'NullConditionalIndexExpressionAst')
    $badTokens = @('QuestionQuestion', 'QuestionQuestionEquals', 'QuestionDot', 'QuestionLBracket', 'QuestionMark', 'AndAnd', 'OrOr')
    $badCmds = @('Test-Json', 'Join-String', 'Get-Error', 'Get-Uptime', 'ConvertFrom-Markdown', 'Show-Markdown')
    $badParams = @('Parallel', 'ThrottleLimit', 'AsHashtable', 'AsByteStream', 'SkipCertificateCheck', 'SkipHttpErrorCheck', 'NoEnumerate', 'AsUTC', 'Authentication', 'ResponseHeadersVariable', 'SslProtocol', 'NoProxy', 'EnumsAsStrings', 'DateKind', 'AdditionalChildPath')
    $badMethods = @('GetRelativePath', 'ToHexString', 'SetUnixFileMode', 'GetUnixFileMode', 'ReadAllTextAsync', 'ReadAllBytesAsync', 'WriteAllTextAsync')
    $badMembers = @('ArgumentList', 'ProcessPath', 'UnixFileMode')
    $badVars = @('IsWindows', 'IsLinux', 'IsMacOS', 'IsCoreCLR', 'PSStyle')
    $found = New-Object 'System.Collections.Generic.List[string]'
    foreach ($f in @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1')) {
        $e = $null
        $t = $null
        $a = [System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$t, [ref]$e)
        if (@($e).Count -gt 0) { $found.Add($f.Name + ': parse error ' + @($e)[0].Message); continue }
        foreach ($tok in $t) { if ($badTokens -contains $tok.Kind.ToString()) { $found.Add($f.Name + ': token ' + $tok.Kind + '@' + $tok.Extent.StartLineNumber) } }
        foreach ($n in @($a.FindAll({ param($x) $true }, $true))) {
            $type = $n.GetType().Name
            if ($badSyntax -contains $type) { $found.Add($f.Name + ': ' + $type + '@' + $n.Extent.StartLineNumber) }
            if ($n -is [System.Management.Automation.Language.CommandAst]) {
                $name = $n.GetCommandName()
                if ($name -and ($badCmds -contains $name)) { $found.Add($f.Name + ': command ' + $name + '@' + $n.Extent.StartLineNumber) }
                if ($name -eq 'Join-Path') {
                    $positional = 0
                    for ($i = 1; $i -lt $n.CommandElements.Count; $i++) { if (-not ($n.CommandElements[$i] -is [System.Management.Automation.Language.CommandParameterAst])) { $positional++ } }
                    if ($positional -gt 2) { $found.Add($f.Name + ': Join-Path with ' + $positional + ' arguments@' + $n.Extent.StartLineNumber) }
                }
            }
            if ($n -is [System.Management.Automation.Language.CommandParameterAst] -and ($badParams -contains $n.ParameterName)) { $found.Add($f.Name + ': parameter -' + $n.ParameterName + '@' + $n.Extent.StartLineNumber) }
            if ($n -is [System.Management.Automation.Language.InvokeMemberExpressionAst]) {
                $mn = $n.Member.Extent.Text
                $argc = 0
                if ($n.Arguments) { $argc = $n.Arguments.Count }
                if ($badMethods -contains $mn) { $found.Add($f.Name + ': .' + $mn + '()@' + $n.Extent.StartLineNumber) }
                if ($mn -eq 'Split' -and -not $n.Static) { $found.Add($f.Name + ': .Split() (the single character overload is missing in 5.1; use -split)@' + $n.Extent.StartLineNumber) }
                if ($mn -eq 'Kill' -and $argc -gt 0) { $found.Add($f.Name + ': Kill with arguments@' + $n.Extent.StartLineNumber) }
                if ($mn -eq 'Contains' -and $argc -gt 1) { $found.Add($f.Name + ': Contains with 2 arguments@' + $n.Extent.StartLineNumber) }
                if ($mn -eq 'Replace' -and $argc -gt 2 -and -not $n.Static) { $found.Add($f.Name + ': Replace with 3 arguments@' + $n.Extent.StartLineNumber) }
            }
            if ($n -is [System.Management.Automation.Language.MemberExpressionAst] -and -not ($n -is [System.Management.Automation.Language.InvokeMemberExpressionAst]) -and ($badMembers -contains $n.Member.Extent.Text)) { $found.Add($f.Name + ': .' + $n.Member.Extent.Text + '@' + $n.Extent.StartLineNumber) }
            if ($n -is [System.Management.Automation.Language.VariableExpressionAst] -and ($badVars -contains $n.VariablePath.UserPath)) { $found.Add($f.Name + ': $' + $n.VariablePath.UserPath + '@' + $n.Extent.StartLineNumber) }
        }
    }
    Assert-Eq $found.Count 0 ($found -join '; ')
}

Complete-Tests '02-ps5-compat-static'
