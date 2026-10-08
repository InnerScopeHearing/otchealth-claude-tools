# 05 - unit tests for Step 7: the AWS rules block inside AGENTS.md (Codex) and CLAUDE.md (Claude Code).
# Covers: create, append, replace-only-between-the-markers, idempotence, preserved line endings (CRLF), BOM and
# unicode, refusal of odd marker layouts, backups, restore on a failed write, and the pinned download check.
. (Join-Path $PSScriptRoot 'TestHelpers.ps1')
. $script:ScriptUnderTest -TestMode
$script:Quiet = $true
$script:NoPauseMode = $true

# (PowerShell variable names are not case sensitive: $B and $b would be the same variable, so the markers get long names.)
$cfg = $script:Cfg
$MarkBegin = $cfg.BeginMarker
$MarkEnd = $cfg.EndMarker
$Note = $cfg.PrecedenceNote
$rules = (Get-FileText $script:FixtureRules) -replace "`r`n", "`n"
$emDash = [string][char]0x2014

function SetBlock { param([string]$Existing) return (Set-RulesBlock -Existing $Existing -Rules $rules -Begin $MarkBegin -End $MarkEnd -Note $Note) }
function CountOf { param([string]$Text, [string]$Part) return ([regex]::Matches($Text, [regex]::Escape($Part))).Count }
function B64 { param([byte[]]$Bytes) return [Convert]::ToBase64String($Bytes) }

$stale = $MarkBegin + "`n" + $Note + "`n`n" + "- an older version of the rules`n- another old line" + "`n" + $MarkEnd

Test-Case 'the settings: marker lines, a one-line precedence note, and a pinned (commit and sha256) download' {
    Assert-Eq $MarkBegin '<!-- BEGIN AWS Agent Toolkit rules -->'
    Assert-Eq $MarkEnd '<!-- END AWS Agent Toolkit rules -->'
    Assert-True ($Note.IndexOf("`n") -lt 0 -and $Note.IndexOf("`r") -lt 0) 'the note must be one line'
    Assert-Contains $Note "the project's instructions win"
    Assert-Eq $cfg.RulesCommit '188af2f810ce4df1b699cb55dd02f28bfa8eb2c8'
    Assert-Eq $cfg.RulesUrl ('https://raw.githubusercontent.com/aws/agent-toolkit-for-aws/' + $cfg.RulesCommit + '/rules/aws-agent-rules.md')
    Assert-Eq (Get-Sha256Hex (Get-FileBytes $script:FixtureRules)) $cfg.RulesSha256 'the fixture must be the pinned file'
}

Test-Case 'block: markers, the note, a blank line, the pinned rules word for word, the end marker' {
    $block = Get-RulesBlockText -Rules $rules -Begin $MarkBegin -End $MarkEnd -Note $Note -Nl "`n"
    $lines = $block -split "`n"
    Assert-Eq $lines[0] $MarkBegin
    Assert-Eq $lines[1] $Note
    Assert-Eq $lines[2] ''
    Assert-Eq $lines[$lines.Count - 1] $MarkEnd
    $inner = ($lines[3..($lines.Count - 2)]) -join "`n"
    Assert-Eq $inner $rules.Trim([char]10)
    # The upstream rules contain exactly one em dash. It is kept as it is (the fingerprint depends on it).
    Assert-Eq (CountOf $rules $emDash) 1
    Assert-Eq (CountOf $block $emDash) 1
    # CRLF version has the same lines
    $crlf = Get-RulesBlockText -Rules $rules -Begin $MarkBegin -End $MarkEnd -Note $Note -Nl "`r`n"
    Assert-Eq ($crlf -replace "`r`n", "`n") $block
    Assert-True (($crlf -replace "`r`n", '') -notmatch "[`r`n]") 'only CRLF pairs in the CRLF block'
}

Test-Case 'Created: no file (or an empty one) gives exactly the block and one final newline (LF)' {
    foreach ($e in @($null, '')) {
        $r = SetBlock $e
        Assert-Eq $r.State 'Created'
        Assert-Eq $r.Text ($r.Block + "`n")
        Assert-True ($r.Text.StartsWith($MarkBegin + "`n" + $Note + "`n`n")) 'starts with marker, note and a blank line'
        Assert-True ($r.Text.EndsWith($MarkEnd + "`n")) 'ends with the end marker and a newline'
        Assert-Eq (CountOf $r.Text $MarkBegin) 1
        Assert-Eq (CountOf $r.Text $MarkEnd) 1
        Assert-NotContains $r.Text "`r"
    }
}

Test-Case 'Appended: every existing character is kept and a blank line separates it from the block' {
    $cases = @(
        "# My rules`nBe nice.`n",
        "# My rules`nBe nice.",
        "# My rules`nBe nice.`n`n",
        "# My rules`nBe nice.`n   `n",
        "# My rules`n`n`n",
        'x',
        "`n",
        "   "
    )
    foreach ($c in $cases) {
        $r = SetBlock $c
        Assert-Eq $r.State 'Appended' ('[' + (Show-Visible $c) + ']')
        Assert-True ($r.Text.StartsWith($c)) ('the old text must stay at the start: [' + (Show-Visible $c) + ']')
        $bi = $r.Text.IndexOf($MarkBegin, [StringComparison]::Ordinal)
        $between = $r.Text.Substring($c.Length, $bi - $c.Length)
        Assert-True ($between -match '^[\r\n]*$') ('only newlines may be added before the block: [' + (Show-Visible $between) + ']')
        Assert-True ($between.Length -le 2) 'at most a newline and a blank line are added'
        Assert-True (($c + $between) -match '(?:\r?\n)[ \t]*\r?\n\z') 'a blank line must precede the block'
        Assert-True ($r.Text.EndsWith($MarkEnd + "`n")) 'ends with the end marker and a newline'
        Assert-Eq (CountOf $r.Text $MarkBegin) 1
    }
}

Test-Case 'CRLF file: the block is added (and later refreshed) with CRLF only; no bare LF appears' {
    $crlf = ConvertTo-Crlf "# Rules`nBe nice.`n"
    $r = SetBlock $crlf
    Assert-Eq $r.State 'Appended'
    Assert-Eq $r.Nl "`r`n"
    Assert-True ($r.Text.StartsWith($crlf))
    Assert-True (($r.Text -replace "`r`n", '') -notmatch "[`r`n]") 'only CRLF pairs may remain'
    # an old block written with LF inside a mostly-CRLF file is replaced with a CRLF block
    $mixed = (ConvertTo-Crlf "# Rules`nBe nice.`n`n") + $stale + "`r`n" + (ConvertTo-Crlf "after`nmore`n")
    $r2 = SetBlock $mixed
    Assert-Eq $r2.State 'Replaced'
    Assert-Eq $r2.Nl "`r`n"
    Assert-True ($r2.Text.StartsWith((ConvertTo-Crlf "# Rules`nBe nice.`n`n") + $MarkBegin)) 'the text before the block is unchanged'
    Assert-True ($r2.Text.EndsWith($MarkEnd + "`r`n" + (ConvertTo-Crlf "after`nmore`n"))) 'the text after the block is unchanged'
    Assert-True (($r2.Text -replace "`r`n", '') -notmatch "[`r`n]") 'only CRLF pairs may remain'
    # an LF file stays LF
    $lf = SetBlock "# Rules`nBe nice.`n"
    Assert-NotContains $lf.Text "`r"
}

Test-Case 'Replaced: only the text between the markers changes; the text before and after is kept exactly' {
    $before = "# Team rules`n`nAlways write tests.`n`n"
    $after = "`n`n## Other section`nKeep it short.`n"
    $r = SetBlock ($before + $stale + $after)
    Assert-Eq $r.State 'Replaced'
    Assert-Eq $r.Text ($before + $r.Block + $after)
    Assert-NotContains $r.Text 'an older version'
    # the block at the very start, at the very end, and with edits inside it
    $r2 = SetBlock ($stale + $after)
    Assert-Eq $r2.Text ($r2.Block + $after)
    $r3 = SetBlock ($before + $stale)
    Assert-Eq $r3.Text ($before + $r3.Block)
    $edited = $MarkBegin + "`nsomeone typed here`n" + $Note + "`nand here`n" + $MarkEnd
    $r4 = SetBlock ("keep1`n" + $edited + "`nkeep2")
    Assert-Eq $r4.State 'Replaced'
    Assert-Eq $r4.Text ("keep1`n" + $r4.Block + "`nkeep2")
    # a trailing text without newline at the end of the file
    $r5 = SetBlock ($before + $stale + "`nlast line without newline")
    Assert-Eq $r5.Text ($before + $r5.Block + "`nlast line without newline")
}

Test-Case 'marker lines are matched as WHOLE lines: the same words inside other text are not markers' {
    # Get-MarkerMatches finds only a marker that stands alone on its line (spaces and tabs around it are allowed).
    $text = "intro $MarkBegin in prose`n" + $MarkBegin + "`nbody`n" + $MarkEnd + "`ntail $MarkEnd more`n"
    $mb = @(Get-MarkerMatches -Text $text -Marker $MarkBegin)
    $me = @(Get-MarkerMatches -Text $text -Marker $MarkEnd)
    Assert-Eq $mb.Count 1
    Assert-Eq $me.Count 1
    Assert-Eq $mb[0].Index ($text.IndexOf("`n" + $MarkBegin + "`n") + 1)
    Assert-Eq $me[0].Index ($text.IndexOf("`n" + $MarkEnd + "`n") + 1)
    # spaces, tabs and CRLF around a marker line are fine; any other character on the line is not
    $ok = @(
        ("  " + $MarkBegin), ($MarkBegin + "   "), ("`t" + $MarkBegin + "`t"), ($MarkBegin)
    )
    foreach ($o in $ok) {
        Assert-Eq @(Get-MarkerMatches -Text ("a`r`n" + $o + "`r`nb") -Marker $MarkBegin).Count 1 (Show-Visible $o)
        Assert-Eq @(Get-MarkerMatches -Text $o -Marker $MarkBegin).Count 1 ('alone: ' + (Show-Visible $o))
    }
    $notOk = @(
        ("x " + $MarkBegin), ($MarkBegin + " x"), ("> " + $MarkBegin), ('`' + $MarkBegin + '`'), ($MarkBegin + $MarkBegin), ("-" + $MarkBegin)
    )
    foreach ($o in $notOk) {
        Assert-Eq @(Get-MarkerMatches -Text ("a`n" + $o + "`nb") -Marker $MarkBegin).Count 0 (Show-Visible $o)
    }
}

Test-Case 'a marker mentioned inside a sentence is kept as text: the block is appended, nothing is refused or replaced' {
    $prose = "# My notes`nThe tool writes $MarkBegin and $MarkEnd around its rules.`nKeep both words.`n"
    $r = SetBlock $prose
    Assert-Eq $r.State 'Appended' $r.Reason
    Assert-True ($r.Text.StartsWith($prose)) 'the sentence must stay exactly as it was'
    Assert-Eq @(Get-MarkerMatches -Text $r.Text -Marker $MarkBegin).Count 1
    Assert-Eq @(Get-MarkerMatches -Text $r.Text -Marker $MarkEnd).Count 1
    # running it again finds exactly the one real block
    $r2 = SetBlock $r.Text
    Assert-Eq $r2.State 'Unchanged'
    # a real block next to a sentence that mentions the markers: only the real block is replaced
    $mixed = $prose + "`n" + $stale + "`n`n## end`n"
    $r3 = SetBlock $mixed
    Assert-Eq $r3.State 'Replaced' $r3.Reason
    Assert-True ($r3.Text.StartsWith($prose + "`n")) 'the sentence and everything before the block stays'
    Assert-True ($r3.Text.EndsWith($MarkEnd + "`n`n## end`n")) 'everything after the block stays'
    Assert-Contains $r3.Text 'The tool writes'
    Assert-NotContains $r3.Text 'an older version'
}

Test-Case 'a marker line with extra spaces, tabs or an indent is still found, and the whitespace outside the markers is kept' {
    $old = "  " + $MarkBegin + "  `r`n" + $Note + "`r`n`r`n- stale`r`n`t" + $MarkEnd + "`t`r`nafter`r`n"
    $text = "# T`r`n`r`n" + $old
    $r = SetBlock $text
    Assert-Eq $r.State 'Replaced' $r.Reason
    Assert-True ($r.Text.StartsWith("# T`r`n`r`n  " + $MarkBegin + "`r`n")) 'indent before BEGIN kept; the marker line is rewritten'
    Assert-True ($r.Text.EndsWith($MarkEnd + "`t`r`nafter`r`n")) 'tab after END and the text after it are kept'
    Assert-NotContains $r.Text 'stale'
    $again = SetBlock $r.Text
    Assert-Eq $again.State 'Unchanged'
}

Test-Case 'unbalanced real marker lines are still refused, and a stray mention does not change that' {
    $t1 = "only mention $MarkBegin here`n" + $MarkEnd + "`n"
    $r1 = SetBlock $t1
    Assert-Eq $r1.State 'Refused'
    Assert-Contains $r1.Reason 'BEGIN x0, END x1'
    $t2 = "x`n" + $MarkBegin + "`nmid`n" + $MarkBegin + "`n" + $MarkEnd + "`n"
    Assert-Eq (SetBlock $t2).State 'Refused'
}

Test-Case 'idempotent: running it again gives the same text (from every starting point)' {
    $starts = @('', "# A`nB`n", (ConvertTo-Crlf "# A`nB`n"), "no newline at all", ("# T`n`n" + $stale + "`n`n## after`n"), ($stale))
    foreach ($s in $starts) {
        $r1 = SetBlock $s
        $r2 = SetBlock $r1.Text
        Assert-Eq $r2.State 'Unchanged' ('[' + (Show-Visible $s) + ']')
        Assert-Eq $r2.Text $r1.Text
        $r3 = SetBlock $r2.Text
        Assert-Eq $r3.Text $r1.Text
        Assert-Eq (CountOf $r3.Text $MarkBegin) 1
        Assert-Eq (CountOf $r3.Text $MarkEnd) 1
    }
}

Test-Case 'Refused: a missing, repeated or reversed marker is never guessed at' {
    $bad = @(
        ($MarkBegin + "`nx`n"),
        ("x`n" + $MarkEnd + "`n"),
        ($MarkBegin + "`n" + $MarkBegin + "`n" + $MarkEnd + "`n"),
        ($MarkBegin + "`n" + $MarkEnd + "`n" + $MarkEnd + "`n"),
        ($MarkEnd + "`nmiddle`n" + $MarkBegin + "`n"),
        ($MarkBegin + "`na`n" + $MarkEnd + "`nb`n" + $MarkBegin + "`nc`n" + $MarkEnd + "`n")
    )
    foreach ($t in $bad) {
        $r = SetBlock $t
        Assert-Eq $r.State 'Refused' (Show-Visible $t)
        Assert-True ($r.Reason.Length -gt 10) 'a reason is needed'
    }
}

Test-Case 'unicode, dollar signs, backslashes and regex symbols in the file or in the rules are carried through untouched' {
    $weird = '# Caf' + [char]0x00e9 + ' ' + [char]0x4e2d + [char]0x6587 + ' ' + [char]::ConvertFromUtf32(0x1F600) + "`n" + 'Price $1 and $& and \1 and ${x} [a-z]+ (.*) ^$' + "`n" + 'C:\Users\matt\.codex' + "`n"
    $r = SetBlock $weird
    Assert-Eq $r.State 'Appended'
    Assert-True ($r.Text.StartsWith($weird))
    $r2 = SetBlock ($weird + $stale + "`n" + $weird)
    Assert-Eq $r2.State 'Replaced'
    Assert-Eq $r2.Text ($weird + $r2.Block + "`n" + $weird)
    $oddRules = 'Use $& and $1 and \1 and $0 literally'
    $r3 = Set-RulesBlock -Existing ($MarkBegin + "`nold`n" + $MarkEnd + "`n") -Rules $oddRules -Begin $MarkBegin -End $MarkEnd -Note $Note
    Assert-Eq $r3.State 'Replaced'
    Assert-Contains $r3.Text 'Use $& and $1 and \1 and $0 literally'
}

# ---- file wrapper ----
$tmp = New-TempDir
try {
    $null = New-TestContext $tmp
    function Upd { param([string]$Path) return (Update-RulesFile -Path $Path -Rules $rules -Begin $MarkBegin -End $MarkEnd -Note $Note) }
    function NewDir { param([string]$Name) $d = Join-Path $tmp $Name; [void](New-Item -ItemType Directory -Path $d -Force); return $d }

    Test-Case 'file wrapper: a missing file is created (no backup, no BOM, LF only, ends with a newline); a second run does nothing' {
        $dir = NewDir 'codex-create'
        $p = Join-Path $dir 'AGENTS.md'
        $r = Upd $p
        Assert-Eq $r.State 'Created' $r.Reason
        Assert-True ($null -eq $r.Backup) 'no backup for a new file'
        $b = Get-FileBytes $p
        Assert-True (-not ($b[0] -eq 239 -and $b[1] -eq 187 -and $b[2] -eq 191)) 'no BOM expected'
        Assert-Eq (Get-FileText $p) ($MarkBegin + "`n" + $Note + "`n`n" + $rules.Trim([char]10) + "`n" + $MarkEnd + "`n")
        Assert-Eq $r.Bytes $b.Length
        $r2 = Upd $p
        Assert-Eq $r2.State 'Unchanged'
        Assert-True ($null -eq $r2.Backup) 'no backup when nothing changes'
        Assert-Eq (B64 (Get-FileBytes $p)) (B64 $b)
        Assert-Eq @(Get-ChildItem -LiteralPath $dir).Count 1 'no stray files'
    }

    Test-Case 'file wrapper: appends to an existing file; the backup is byte-identical; the old bytes stay at the start' {
        $dir = NewDir 'codex-append'
        $p = Join-Path $dir 'AGENTS.md'
        Save-Text $p ("# My Codex rules`nUse tabs. Caf" + [char]0x00e9 + "`n")
        $orig = Get-FileBytes $p
        $r = Upd $p
        Assert-Eq $r.State 'Appended' $r.Reason
        Assert-Contains $r.Backup '.bak-'
        Assert-Eq (B64 (Get-FileBytes $r.Backup)) (B64 $orig)
        $new = Get-FileBytes $p
        Assert-True ($new.Length -gt $orig.Length) 'the file must have grown'
        for ($i = 0; $i -lt $orig.Length; $i++) { if ($new[$i] -ne $orig[$i]) { throw ('byte ' + $i + ' changed') } }
        Assert-Eq (CountOf (Get-FileText $p) $MarkBegin) 1
    }

    Test-Case 'file wrapper: refreshes an old block; everything outside the markers stays byte for byte' {
        $dir = NewDir 'codex-replace'
        $p = Join-Path $dir 'AGENTS.md'
        $before = "# Mine`nline 1`n`n"
        $after = "`n## After`nline 2 " + [char]0x00e9 + "`n"
        Save-Text $p ($before + $stale + $after)
        $orig = Get-FileBytes $p
        $r = Upd $p
        Assert-Eq $r.State 'Replaced' $r.Reason
        Assert-Eq (B64 (Get-FileBytes $r.Backup)) (B64 $orig)
        $t = Get-FileText $p
        Assert-True $t.StartsWith($before + $MarkBegin)
        Assert-True $t.EndsWith($MarkEnd + $after)
        Assert-NotContains $t 'an older version'
        Assert-Eq (CountOf $t $MarkBegin) 1
        Assert-Eq (CountOf $t $MarkEnd) 1
        $again = Upd $p
        Assert-Eq $again.State 'Unchanged'
    }

    Test-Case 'file wrapper: a BOM is kept, none is added, and CRLF stays CRLF' {
        $dir = NewDir 'codex-bom'
        $p1 = Join-Path $dir 'with-bom.md'
        Save-Text $p1 "# A`r`nB`r`n" -Bom
        $r1 = Upd $p1
        Assert-Eq $r1.State 'Appended' $r1.Reason
        $b1 = Get-FileBytes $p1
        Assert-True ($b1[0] -eq 239 -and $b1[1] -eq 187 -and $b1[2] -eq 191) 'BOM lost'
        Assert-True ((Get-FileText $p1) -notmatch "(?<!`r)`n") 'a bare LF was introduced'
        $p2 = Join-Path $dir 'no-bom.md'
        Save-Text $p2 "# A`r`nB`r`n"
        $r2 = Upd $p2
        Assert-Eq $r2.State 'Appended' $r2.Reason
        $b2 = Get-FileBytes $p2
        Assert-Eq $b2[0] 35 'no BOM must be added'
        Assert-True ((Get-FileText $p2) -notmatch "(?<!`r)`n") 'a bare LF was introduced'
    }

    Test-Case 'file wrapper: UTF-16, binary, invalid UTF-8 and unbalanced markers are Refused and left untouched, with no backup' {
        $dir = NewDir 'codex-refuse'
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        $cases = @(
            [pscustomobject]@{ Name = 'u16.md'; Bytes = [byte[]](@(255, 254) + [System.Text.Encoding]::Unicode.GetBytes("# hi`n")) },
            [pscustomobject]@{ Name = 'bin.md'; Bytes = [byte[]](65, 0, 66, 0, 67) },
            [pscustomobject]@{ Name = 'bad8.md'; Bytes = [byte[]](35, 32, 195, 40, 10) },
            [pscustomobject]@{ Name = 'unbalanced.md'; Bytes = $utf8.GetBytes($MarkBegin + "`nonly a begin`n") }
        )
        foreach ($c in $cases) {
            $p = Join-Path $dir $c.Name
            [System.IO.File]::WriteAllBytes($p, $c.Bytes)
            $r = Upd $p
            Assert-Eq $r.State 'Refused' $c.Name
            Assert-True ($r.Reason.Length -gt 5) 'a reason is needed'
            Assert-True ($null -eq $r.Backup) ($c.Name + ' must not be backed up')
            Assert-Eq (B64 (Get-FileBytes $p)) (B64 $c.Bytes) ($c.Name + ' changed')
        }
        Assert-Eq @(Get-ChildItem -LiteralPath $dir).Count $cases.Count 'no extra files'
    }

    Test-Case 'file wrapper: if the saved file does not verify, the original comes back (and a file that was new is removed)' {
        $dir = NewDir 'codex-restore'
        $p = Join-Path $dir 'AGENTS.md'
        Save-Text $p "keep me`n"
        $orig = Get-FileBytes $p
        $r = & {
            function Write-TextFile {
                param([string]$Path, [string]$Text, [bool]$Bom = $false)
                [System.IO.File]::WriteAllText($Path, $Text.Substring(0, $Text.Length - 5))
            }
            Upd $p
        }
        Assert-Eq $r.State 'Refused'
        Assert-Contains $r.Reason 'restored'
        Assert-Eq (B64 (Get-FileBytes $p)) (B64 $orig)
        $p2 = Join-Path $dir 'NEW.md'
        $r2 = & {
            function Write-TextFile {
                param([string]$Path, [string]$Text, [bool]$Bom = $false)
                [System.IO.File]::WriteAllText($Path, 'garbage')
            }
            Upd $p2
        }
        Assert-Eq $r2.State 'Refused'
        Assert-True (-not (Test-Path -LiteralPath $p2)) 'a half-written new file must be removed'
    }

    Test-Case 'file wrapper: a change to text outside the block during the write is caught and undone' {
        $dir = NewDir 'codex-outside'
        $p = Join-Path $dir 'AGENTS.md'
        $before = "# Mine`nimportant`n`n"
        Save-Text $p ($before + $stale + "`n")
        $orig = Get-FileBytes $p
        $r = & {
            function Write-TextFile {
                param([string]$Path, [string]$Text, [bool]$Bom = $false)
                # simulates a bug: the text before the block is altered while the block itself is right
                [System.IO.File]::WriteAllText($Path, $Text.Replace('important', 'IMPORTANT'))
            }
            Upd $p
        }
        Assert-Eq $r.State 'Refused'
        Assert-Eq (B64 (Get-FileBytes $p)) (B64 $orig)
    }

    # ---- Get-PinnedRules ----
    Test-Case 'Get-PinnedRules: asks for the commit-pinned URL and accepts only the exact pinned bytes' {
        $good = Get-FileBytes $script:FixtureRules
        $script:seenUrl = $null
        $r = & {
            function Get-WebBytes { param([string]$Url) $script:seenUrl = $Url; return , $good }
            Get-PinnedRules
        }
        Assert-True $r.Ok $r.Error
        Assert-Eq $script:seenUrl $cfg.RulesUrl
        Assert-Contains $script:seenUrl $cfg.RulesCommit
        Assert-Eq $r.Sha256 $cfg.RulesSha256
        Assert-Eq $r.Text $rules
        # one changed byte, an error page, an empty answer, a version with a BOM: all rejected before use
        $flipped = [byte[]]$good.Clone()
        $flipped[10] = [byte]($flipped[10] -bxor 1)
        $html = [System.Text.Encoding]::UTF8.GetBytes('<html><body>404: Not Found</body></html>')
        $withBom = [byte[]](@(239, 187, 191) + $good)
        $crlfVersion = [System.Text.Encoding]::UTF8.GetBytes(($rules -replace "`n", "`r`n"))
        foreach ($bad in @($flipped, $html, [byte[]]@(), $withBom, $crlfVersion)) {
            $script:badBytes = $bad
            $r2 = & {
                function Get-WebBytes { param([string]$Url) return , $script:badBytes }
                Get-PinnedRules
            }
            Assert-True (-not $r2.Ok) 'must be rejected'
            Assert-Contains $r2.Error 'fingerprint'
            Assert-Eq $r2.Text ''
        }
        $r3 = & {
            function Get-WebBytes { param([string]$Url) throw 'no network' }
            Get-PinnedRules
        }
        Assert-True (-not $r3.Ok)
        Assert-Contains $r3.Error 'download failed'
        Assert-Contains $r3.Error 'no network'
    }
}
finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

# ---- the whole Step 7 (which folders get the rules, and the warnings) ----
function New-Step7Home {
    $h = New-TempDir
    $null = New-TestContext $h
    return $h
}

function Invoke-Step7WithFakeDownload {
    param([bool]$DownloadOk = $true)
    $script:fakeOk = $DownloadOk
    & {
        function Get-PinnedRules {
            if ($script:fakeOk) { return [pscustomobject]@{ Ok = $true; Text = $rules; Sha256 = $cfg.RulesSha256; Error = '' } }
            return [pscustomobject]@{ Ok = $false; Text = ''; Sha256 = ''; Error = 'the download failed: no network' }
        }
        Invoke-Step7Rules
    }
}

function Get-ResultsText { return (($script:Ctx.Results | ForEach-Object { '[' + $_.Level + '] ' + $_.Step + ': ' + $_.Text }) -join "`n") }

Test-Case 'Step 7: only .codex exists: AGENTS.md is created there, nothing is created for Claude' {
    $h = New-Step7Home
    try {
        [void](New-Item -ItemType Directory -Path (Join-Path $h '.codex'))
        Invoke-Step7WithFakeDownload
        $agents = Join-Path (Join-Path $h '.codex') 'AGENTS.md'
        Assert-True (Test-Path -LiteralPath $agents) 'AGENTS.md missing'
        Assert-Contains (Get-FileText $agents) $MarkBegin
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $h '.claude'))) '.claude must not be created'
        Assert-True $script:Ctx.RulesApplied
        $txt = Get-ResultsText
        Assert-Contains $txt '[OK] Step 7: Codex: created'
        Assert-Eq $script:Ctx.Manual.Count 0
    }
    finally { Remove-Item -LiteralPath $h -Recurse -Force -ErrorAction SilentlyContinue }
}

Test-Case 'Step 7: .codex and .claude both exist: both get the block and keep their own text' {
    $h = New-Step7Home
    try {
        $cdir = Join-Path $h '.codex'
        $ldir = Join-Path $h '.claude'
        Save-Text (Join-Path $cdir 'AGENTS.md') "# Codex mine`nrule A`n"
        Save-Text (Join-Path $ldir 'CLAUDE.md') "# Claude mine`nrule B`n"
        Invoke-Step7WithFakeDownload
        $a = Get-FileText (Join-Path $cdir 'AGENTS.md')
        $c = Get-FileText (Join-Path $ldir 'CLAUDE.md')
        Assert-True $a.StartsWith("# Codex mine`nrule A`n")
        Assert-True $c.StartsWith("# Claude mine`nrule B`n")
        Assert-Eq (CountOf $a $MarkBegin) 1
        Assert-Eq (CountOf $c $MarkBegin) 1
        Assert-Contains (Get-ResultsText) 'Codex: added the AWS rules block'
        Assert-Contains (Get-ResultsText) 'Claude Code: added the AWS rules block'
        Assert-Eq $script:Ctx.Backups.Count 2
        # a second run: nothing changes
        $sumBefore = (B64 (Get-FileBytes (Join-Path $cdir 'AGENTS.md'))) + (B64 (Get-FileBytes (Join-Path $ldir 'CLAUDE.md')))
        $script:Ctx.Results.Clear()
        Invoke-Step7WithFakeDownload
        $sumAfter = (B64 (Get-FileBytes (Join-Path $cdir 'AGENTS.md'))) + (B64 (Get-FileBytes (Join-Path $ldir 'CLAUDE.md')))
        Assert-Eq $sumAfter $sumBefore
        Assert-Contains (Get-ResultsText) 'already up to date'
        Assert-Eq $script:Ctx.Backups.Count 2 'no new backups on the second run'
    }
    finally { Remove-Item -LiteralPath $h -Recurse -Force -ErrorAction SilentlyContinue }
}

Test-Case 'Step 7: only .claude exists: only CLAUDE.md is written (and a CLAUDE_CONFIG_DIR is honoured by the context)' {
    $h = New-Step7Home
    try {
        [void](New-Item -ItemType Directory -Path (Join-Path $h '.claude'))
        Invoke-Step7WithFakeDownload
        Assert-True (Test-Path -LiteralPath (Join-Path (Join-Path $h '.claude') 'CLAUDE.md'))
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $h '.codex'))) '.codex must not be created'
        $alt = Join-Path $h 'alt-claude'
        [void](New-Item -ItemType Directory -Path $alt)
        $ctx2 = New-SetupContext -UserHome $h -ScriptDir $h -ClaudeConfigDir $alt -IsTest
        Assert-Eq $ctx2.ClaudeMd (Join-Path $alt 'CLAUDE.md')
    }
    finally { Remove-Item -LiteralPath $h -Recurse -Force -ErrorAction SilentlyContinue }
}

Test-Case 'Step 7: neither folder exists: a NOTE, and nothing is created' {
    $h = New-Step7Home
    try {
        Invoke-Step7WithFakeDownload
        Assert-Contains (Get-ResultsText) '[NOTE] Step 7: Neither a Codex nor a Claude Code settings folder exists'
        Assert-Eq @(Get-ChildItem -LiteralPath $h -Force).Count 0
        Assert-True (-not $script:Ctx.RulesApplied)
    }
    finally { Remove-Item -LiteralPath $h -Recurse -Force -ErrorAction SilentlyContinue }
}

Test-Case 'Step 7: a failed download adds an ACTION and writes nothing' {
    $h = New-Step7Home
    try {
        $cdir = Join-Path $h '.codex'
        [void](New-Item -ItemType Directory -Path $cdir)
        Invoke-Step7WithFakeDownload -DownloadOk $false
        Assert-Contains (Get-ResultsText) '[ACTION] Step 7: The AWS rules were NOT added'
        Assert-Eq @(Get-ChildItem -LiteralPath $cdir -Force).Count 0
    }
    finally { Remove-Item -LiteralPath $h -Recurse -Force -ErrorAction SilentlyContinue }
}

Test-Case 'Step 7: a file with odd markers becomes a hand edit; the other tool is still done' {
    $h = New-Step7Home
    try {
        $cdir = Join-Path $h '.codex'
        $ldir = Join-Path $h '.claude'
        Save-Text (Join-Path $cdir 'AGENTS.md') ($MarkBegin + "`nonly a begin marker`n")
        Save-Text (Join-Path $ldir 'CLAUDE.md') "# fine`n"
        $origBytes = Get-FileBytes (Join-Path $cdir 'AGENTS.md')
        Invoke-Step7WithFakeDownload
        Assert-Eq $script:Ctx.Manual.Count 1
        Assert-Contains $script:Ctx.Manual[0].File 'AGENTS.md'
        Assert-Contains $script:Ctx.Manual[0].Fix $MarkBegin
        Assert-Eq (B64 (Get-FileBytes (Join-Path $cdir 'AGENTS.md'))) (B64 $origBytes)
        Assert-Contains (Get-FileText (Join-Path $ldir 'CLAUDE.md')) $MarkEnd
    }
    finally { Remove-Item -LiteralPath $h -Recurse -Force -ErrorAction SilentlyContinue }
}

Test-Case 'Step 7: warns when AGENTS.override.md has text (Codex would ignore AGENTS.md) and when AGENTS.md passes 32 KiB' {
    $h = New-Step7Home
    try {
        $cdir = Join-Path $h '.codex'
        Save-Text (Join-Path $cdir 'AGENTS.override.md') "   `n"
        Invoke-Step7WithFakeDownload
        Assert-NotContains (Get-ResultsText) 'AGENTS.override.md' 'an empty override file must not cause a warning'
    }
    finally { Remove-Item -LiteralPath $h -Recurse -Force -ErrorAction SilentlyContinue }
    $h2 = New-Step7Home
    try {
        $cdir = Join-Path $h2 '.codex'
        Save-Text (Join-Path $cdir 'AGENTS.override.md') "Use this instead.`n"
        Save-Text (Join-Path $cdir 'AGENTS.md') ('# big' + "`n" + ('line of text that makes the file big' + "`n") * 1000)
        Invoke-Step7WithFakeDownload
        $txt = Get-ResultsText
        Assert-Contains $txt '[ACTION] Step 7: Codex reads'
        Assert-Contains $txt 'AGENTS.override.md'
        Assert-Contains $txt '[NOTE] Step 7: AGENTS.md is now larger than 32 KiB'
    }
    finally { Remove-Item -LiteralPath $h2 -Recurse -Force -ErrorAction SilentlyContinue }
}

Test-Case 'hand-edit text for Step 7 is ASCII and names the file and both marker lines' {
    $t = Get-RulesHandEdit 'C:\Users\matt\.codex\AGENTS.md' 'the marker lines are unbalanced'
    Assert-Contains $t 'C:\Users\matt\.codex\AGENTS.md'
    Assert-Contains $t $MarkBegin
    Assert-Contains $t $MarkEnd
    Assert-True ($t -notmatch '[^\x00-\x7F]') 'must be ASCII'
}

Complete-Tests '05-unit-step7-markers'
