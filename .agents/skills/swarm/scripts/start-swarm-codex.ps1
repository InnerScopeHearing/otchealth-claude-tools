[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $ProjectFolder,
    [ValidateRange(1, 2147483647)]
    [int] $MaxWorkers = 6,
    [string] $CodexExecutable,
    [string] $Task = 'Use $swarm automatically for this authorized task. Use GPT-6.1 Sol for coordination, design and final verification, and GPT-6 Luna exclusively for execution workers. Discover live capacity, divide useful independent work, queue excess tasks, and preserve one writer per target. Report actual models and worker handles. Do not start paid API jobs or create production deployment authority.',
    [switch] $Preview
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $ProjectFolder -PathType Container)) {
    throw 'ProjectFolder must be an existing authorized directory.'
}
$resolvedFolder = (Resolve-Path -LiteralPath $ProjectFolder).ProviderPath
if (-not $CodexExecutable) {
    $codexCommand = Get-Command codex -ErrorAction SilentlyContinue
    if ($codexCommand) {
        $CodexExecutable = $codexCommand.Source
    } else {
        $userProfilePath = [Environment]::GetFolderPath('UserProfile')
        $CodexExecutable = Join-Path $userProfilePath '.codex\.sandbox-bin\codex.exe'
    }
}
if (-not (Test-Path -LiteralPath $CodexExecutable -PathType Leaf)) {
    throw 'Codex executable unavailable. Supply its verified path with CodexExecutable.'
}
$resolvedExecutable = (Resolve-Path -LiteralPath $CodexExecutable).ProviderPath
$codexArguments = @(
    '--cd', $resolvedFolder,
    '--model', 'gpt-6.1-sol',
    '--config', 'agents.enabled=true',
    '--config', ('agents.max_concurrent_threads_per_session=' + $MaxWorkers),
    '--config', 'agents.default_subagent_model="gpt-6-luna"',
    '--config', 'agents.default_subagent_reasoning_effort="medium"',
    $Task
)
if ($Preview) {
    [pscustomobject]@{
        mode = 'preview'
        executable = $resolvedExecutable
        arguments = $codexArguments
        conductor_model = 'gpt-6.1-sol'
        execution_worker_model = 'gpt-6-luna'
        requested_child_ceiling = $MaxWorkers
        worker_execution_verified = $false
        changes_user_config = $false
    } | ConvertTo-Json -Depth 5
    return
}
& $resolvedExecutable @codexArguments
if ($LASTEXITCODE -ne 0) {
    throw ('Codex exited with code ' + $LASTEXITCODE)
}
