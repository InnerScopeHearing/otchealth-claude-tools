# A controllable "other program" for the tests that start real programs (07, and 08 for its own child).
# The tests must behave the same on the Linux test machine and on a Windows PC (the GitHub Windows job), so the
# behaviours they need are written once and implemented twice:
#   Linux / macOS   /bin/sh -c "..."  (with its printf)
#   Windows         a tiny console program (childkit.exe) that this file compiles with Add-Type. Windows PowerShell 5.1
#                   can write an .exe with Add-Type -OutputAssembly; PowerShell 7 cannot, so there the process tests are
#                   skipped with a visible reason (the GitHub Windows job uses Windows PowerShell 5.1).
# The behaviours:
#   echo TEXT               prints TEXT and a newline on the output
#   fail TEXT CODE          prints TEXT on the error output and exits with CODE
#   out-err-exit CODE       prints "out" on the output and "err" on the error output, then exits with CODE
#   cat-then-done           reads its input until the end, then prints "done" (proves that the input was closed)
#   sleep SECONDS           waits that long
#   flood COUNT             COUNT lines on each of the two outputs (more than a pipe buffer holds)
#   utf8                    prints "caf" + e-acute + " " + a Chinese character + newline, as UTF-8 bytes
#   env                     prints FOO, AWS_PAGER, AWS_CLI_AUTO_PROMPT, PYTHONIOENCODING and AWS_CLI_AGENT_TOOLKIT_HINT_DISABLED
#   args A B C ...          prints every argument on its own line (an empty argument gives an empty line)
# And one more on Windows: when the program is copied to a file called aws.exe it prints the text of the file
# "aws.exe.txt" next to it (first line "stdout:..." or "stderr:..."), like "aws --version" does.
# (The C# below is kept to C# 5, the language of the compiler that Windows PowerShell 5.1 uses.)

$script:ChildKit = $null

function Get-ChildKitSource {
    return @'
using System;
using System.IO;
using System.Text;
using System.Threading;

public static class ChildKit
{
    static void Put(Stream s, string text)
    {
        byte[] b = new UTF8Encoding(false).GetBytes(text);
        s.Write(b, 0, b.Length);
        s.Flush();
    }

    public static int Main(string[] args)
    {
        Stream o = Console.OpenStandardOutput();
        Stream e = Console.OpenStandardError();
        try
        {
            string self = System.Reflection.Assembly.GetExecutingAssembly().Location;
            if (string.Equals(Path.GetFileNameWithoutExtension(self), "aws", StringComparison.OrdinalIgnoreCase))
            {
                string side = self + ".txt";
                string text = File.Exists(side) ? File.ReadAllText(side) : "";
                text = text.TrimEnd('\r', '\n');
                if (text.StartsWith("stderr:", StringComparison.Ordinal)) { Put(e, text.Substring(7) + "\n"); }
                else if (text.StartsWith("stdout:", StringComparison.Ordinal)) { Put(o, text.Substring(7) + "\n"); }
                else { Put(o, text + "\n"); }
                return 0;
            }
            string mode = args.Length > 0 ? args[0] : "";
            if (mode == "echo")
            {
                Put(o, (args.Length > 1 ? args[1] : "") + "\n");
                return 0;
            }
            if (mode == "fail")
            {
                Put(e, (args.Length > 1 ? args[1] : "") + "\n");
                return args.Length > 2 ? int.Parse(args[2]) : 1;
            }
            if (mode == "out-err-exit")
            {
                Put(o, "out\n");
                Put(e, "err\n");
                return int.Parse(args[1]);
            }
            if (mode == "cat-then-done")
            {
                Stream i = Console.OpenStandardInput();
                byte[] buf = new byte[4096];
                while (i.Read(buf, 0, buf.Length) > 0) { }
                Put(o, "done\n");
                return 0;
            }
            if (mode == "sleep")
            {
                Thread.Sleep(int.Parse(args[1]) * 1000);
                return 0;
            }
            if (mode == "flood")
            {
                int n = int.Parse(args[1]);
                for (int k = 0; k < n; k++)
                {
                    Put(o, "line " + k + " of standard output, padding padding padding\n");
                    Put(e, "line " + k + " of standard error, padding padding padding\n");
                }
                return 0;
            }
            if (mode == "utf8")
            {
                byte[] raw = new byte[] { 0x63, 0x61, 0x66, 0xC3, 0xA9, 0x20, 0xE4, 0xB8, 0xAD, 0x0A };
                o.Write(raw, 0, raw.Length);
                o.Flush();
                return 0;
            }
            if (mode == "env")
            {
                string[] names = new string[] { "FOO", "AWS_PAGER", "AWS_CLI_AUTO_PROMPT", "PYTHONIOENCODING", "AWS_CLI_AGENT_TOOLKIT_HINT_DISABLED" };
                string line = "";
                for (int k = 0; k < names.Length; k++)
                {
                    if (k > 0) { line += "|"; }
                    line += (Environment.GetEnvironmentVariable(names[k]) ?? "");
                }
                Put(o, line + "\n");
                return 0;
            }
            if (mode == "args")
            {
                for (int k = 1; k < args.Length; k++) { Put(o, args[k] + "\n"); }
                return 0;
            }
            Put(e, "childkit: unknown behaviour [" + mode + "]\n");
            return 64;
        }
        catch (Exception ex)
        {
            Put(e, "childkit crashed: " + ex.Message + "\n");
            return 99;
        }
    }
}
'@
}

function Test-ChildKitSource {
    # Parses the C# above with Roslyn at language level 5 (what Windows PowerShell 5.1 can compile) when this PowerShell
    # happens to contain Roslyn (PowerShell 7 does). Returns Checked (false when Roslyn is not there) and Errors.
    $res = [pscustomobject]@{ Checked = $false; Errors = @() }
    $errors = New-Object 'System.Collections.Generic.List[string]'
    try {
        $dir = Split-Path -Parent ([System.Reflection.Assembly]::GetAssembly([psobject]).Location)
        foreach ($n in @('Microsoft.CodeAnalysis.dll', 'Microsoft.CodeAnalysis.CSharp.dll')) {
            $p = Join-Path $dir $n
            if (-not (Test-Path -LiteralPath $p)) { return $res }
            [void][System.Reflection.Assembly]::LoadFrom($p)
        }
        $opts = [Microsoft.CodeAnalysis.CSharp.CSharpParseOptions]::Default.WithLanguageVersion([Microsoft.CodeAnalysis.CSharp.LanguageVersion]::CSharp5)
        $tree = [Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree]::ParseText((Get-ChildKitSource), $opts)
        foreach ($d in $tree.GetDiagnostics()) {
            if ($d.Severity.ToString() -eq 'Error') { $errors.Add($d.ToString()) }
        }
        $res.Checked = $true
        $res.Errors = $errors.ToArray()
    }
    catch { $res.Checked = $false }
    return $res
}

function Initialize-ChildKit {
    # Prepares the kit once per test process. Returns an object: Kind ('sh', 'exe' or 'none'), Exe (the program to start)
    # and Why (the reason, when Kind is 'none').
    param([string]$Dir)
    if ($script:ChildKit) { return $script:ChildKit }
    $kit = [pscustomobject]@{ Kind = 'none'; Exe = ''; Why = '' }
    if ($env:OS -eq 'Windows_NT') {
        if ($PSVersionTable.PSVersion.Major -ge 6) {
            $kit.Why = 'the helper program can only be compiled by Windows PowerShell 5.1 (Add-Type -OutputAssembly)'
        }
        else {
            $exe = Join-Path $Dir 'childkit.exe'
            Add-Type -TypeDefinition (Get-ChildKitSource) -OutputAssembly $exe -OutputType ConsoleApplication -ErrorAction Stop
            if (-not (Test-Path -LiteralPath $exe)) { throw 'the helper program childkit.exe was not created' }
            $kit.Kind = 'exe'
            $kit.Exe = $exe
        }
    }
    elseif (Test-Path -LiteralPath '/bin/sh') {
        $kit.Kind = 'sh'
        $kit.Exe = '/bin/sh'
    }
    else { $kit.Why = 'there is no /bin/sh on this machine' }
    $script:ChildKit = $kit
    return $kit
}

function Get-ChildCall {
    # How to start one behaviour: returns File and Arguments (for Invoke-ProcessCapture).
    param([string]$Behavior, [string[]]$Params = @())
    $kit = $script:ChildKit
    if (-not $kit -or $kit.Kind -eq 'none') { throw 'the child kit is not available' }
    if ($kit.Kind -eq 'exe') {
        return [pscustomobject]@{ File = $kit.Exe; Arguments = @(@($Behavior) + @($Params)) }
    }
    $script = ''
    switch ($Behavior) {
        'echo'          { $script = 'printf "%s\n" "$1"' }
        'fail'          { $script = 'printf "%s\n" "$1" 1>&2; exit "$2"' }
        'out-err-exit'  { $script = 'echo out; echo err 1>&2; exit "$1"' }
        'cat-then-done' { $script = 'cat; echo done' }
        'sleep'         { $script = 'exec sleep "$1"' }
        'flood'         { $script = 'i=0; while [ $i -lt "$1" ]; do echo "line $i of standard output, padding padding padding"; echo "line $i of standard error, padding padding padding" 1>&2; i=$((i+1)); done' }
        'utf8'          { $script = 'printf "caf\303\251 \344\270\255\n"' }
        'env'           { $script = 'echo "$FOO|$AWS_PAGER|$AWS_CLI_AUTO_PROMPT|$PYTHONIOENCODING|$AWS_CLI_AGENT_TOOLKIT_HINT_DISABLED"' }
        'args'          { $script = 'for a in "$@"; do printf "%s\n" "$a"; done' }
        default         { throw ('unknown child behaviour: ' + $Behavior) }
    }
    # sh -c SCRIPT NAME PARAM1 PARAM2 ...   (NAME becomes $0, the parameters become $1, $2, ...)
    return [pscustomobject]@{ File = $kit.Exe; Arguments = @(@('-c', $script, 'sh') + @($Params)) }
}

function Assert-ChildKitReady {
    # Ends the current test case as "skip" (with the reason) when child programs cannot be started on this machine.
    param([string]$What = 'this check')
    $kit = $script:ChildKit
    if ($kit -and $kit.Kind -ne 'none') { return }
    $why = 'the child kit was not set up'
    if ($kit) { $why = $kit.Why }
    Skip-Test ($What + ': ' + $why)
}

function Save-FakeAwsProgram {
    # Puts a fake "aws" program into a folder: it answers "--version" (or anything else) with the given text, on the
    # output or on the error output. Returns the path of the program. (Windows: aws.exe; Linux: aws. -FileName changes that.)
    param([string]$Dir, [string]$Text, [switch]$OnError, [string]$FileName = '')
    [void](New-Item -ItemType Directory -Path $Dir -Force)
    $kit = $script:ChildKit
    if ($kit.Kind -eq 'exe') {
        if (-not $FileName) { $FileName = 'aws.exe' }
        $exe = Join-Path $Dir $FileName
        Copy-Item -LiteralPath $kit.Exe -Destination $exe -Force
        $prefix = 'stdout:'
        if ($OnError) { $prefix = 'stderr:' }
        Save-Text ($exe + '.txt') ($prefix + $Text + "`n")
        return $exe
    }
    if (-not $FileName) { $FileName = 'aws' }
    $p = Join-Path $Dir $FileName
    $redirect = ''
    if ($OnError) { $redirect = ' 1>&2' }
    Save-Text $p ("#!/bin/sh`n" + "echo '" + $Text + "'" + $redirect + "`n")
    & chmod +x $p
    return $p
}
