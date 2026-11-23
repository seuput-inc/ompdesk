param([Parameter(Mandatory)][ValidateSet('start', 'stop')][string]$Action)

$ErrorActionPreference = 'Stop'
$phase = 'directories'
$artifact = $null
try {
    if (-not $IsWindows) { throw 'platform' }
    $private = (Get-Item -LiteralPath $env:OMPDESK_NAV_PRIVATE).FullName
    $stages = (Get-Item -LiteralPath $env:OMPDESK_NAV_STAGES).FullName
    $relative = [IO.Path]::GetRelativePath($stages, $private)
    if (-not ($relative -eq '..' -or $relative.StartsWith('..\') -or [IO.Path]::IsPathRooted($relative))) { throw 'unsafe' }
    $artifact = Join-Path $stages 'process-timeline.jsonl'
    $etl = Join-Path $private 'nav-process.etl'
    $logger = 'NT Kernel Logger'
    if ($Action -eq 'start') {
        $phase = 'start'
        if (Test-Path -LiteralPath $etl) { throw 'existing trace' }
        & logman.exe create trace $logger -p 'Windows Kernel Trace' 0x1 -ct system -o $etl -ets *> $null
        if ($LASTEXITCODE -ne 0) { throw 'logman' }
        exit 0
    }

    $phase = 'ownership'
    $query = & logman.exe query $logger -ets 2>$null
    # The classic logger is machine-wide. Never stop one writing another job's trace.
    if ($LASTEXITCODE -ne 0 -or -not ($query -match (':\s*' + [regex]::Escape($etl) + '\s*$'))) { throw 'not our logger' }
    $phase = 'stop'
    & logman.exe stop $logger -ets *> $null
    if ($LASTEXITCODE -ne 0) { throw 'logman' }

    $phase = 'decode'
    Push-Location -LiteralPath $private
    try {
        & tracerpt.exe $etl -of XML -rts -o nav-process.xml -y *> $null
        if ($LASTEXITCODE -ne 0) { throw 'tracerpt' }
        $phase = 'transform'
        & python.exe -I (Join-Path $PSScriptRoot 'nav-process-events.py') *> $null
        if ($LASTEXITCODE -ne 0) { throw 'transform' }
        $phase = 'publish'
        Copy-Item -LiteralPath 'nav-process.jsonl' -Destination $artifact
    } finally { Pop-Location }
} catch {
    if ($Action -eq 'stop' -and $artifact) {
        try {
            [IO.File]::WriteAllText($artifact, "{`"stage`":`"process-trace-unavailable`",`"phase`":`"$phase`"}`n")
        } catch { [Console]::Error.WriteLine('Could not write trace status.') }
    }
    [Console]::Error.WriteLine("Process tracing failed at $phase.")
    exit 1
}
