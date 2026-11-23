param([Parameter(Mandatory)][ValidateSet('start','stop','self-check')][string]$Action)
$ErrorActionPreference = 'Stop'

function FileTimeMs($value) {
    if ($value -is [uint64] -and $value -gt 0) {
        try { return ([DateTimeOffset][DateTime]::FromFileTimeUtc($value)).ToUnixTimeMilliseconds() } catch {}
    }
    return $null
}

function ScanRow($scan, $files) {
    if ($scan.Path -isnot [string] -or !$files.ContainsKey($scan.Path)) { return }
    $start = FileTimeMs $scan.StartTime
    $end = FileTimeMs $scan.EndTime
    $duration = if ($scan.Duration -is [uint64]) { $scan.Duration / 10000.0 }
    $owner = $files[$scan.Path]
    @{stage='defender-scan'; host=$owner.hostKey; file=$owner.file; startMs=$start; endMs=$end;
      absoluteTime=$(if ($null -ne $start -and $null -ne $end) {'reported'} else {'unknown'}); durationMs=$duration}
}

if ($Action -eq 'self-check') {
    $files = @{'C:\synthetic\Cookies'=@{hostKey='1-2';file='Cookies'}}
    $scan = @{Path='C:\synthetic\Cookies'; Duration=[uint64]12345; StartTime=[uint64]116444736000000000}
    $row = ScanRow $scan $files
    if ($row.durationMs -ne 1.2345 -or $row.startMs -ne 0 -or $null -ne $row.endMs -or $row.absoluteTime -ne 'unknown') { throw 'raw units' }
    $scan.Path = 'C:\other\Cookies'
    if ($null -ne (ScanRow $scan $files)) { throw 'path leak' }
    return
}
if (!$IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:OMP_GUI_TEST_FIRST_NAV_NET -ne 'default') { throw 'Hosted Windows probe only.' }
foreach ($dir in @(@($env:OMPDESK_NAV_PRIVATE,'nav-private'),@($env:OMPDESK_NAV_STAGES,'nav-stages'))) {
    $item = Get-Item -LiteralPath $dir[0]
    if (!$item.PSIsContainer -or $item.LinkType -or $item.FullName -ne (Join-Path $env:RUNNER_TEMP $dir[1])) { throw 'Unexpected probe directory.' }
}
$private = $env:OMPDESK_NAV_PRIVATE
$statePath = Join-Path $private 'defender-state.json'
$etl = Join-Path $private 'defender-cost.etl'
$output = Join-Path $env:OMPDESK_NAV_STAGES 'defender-cost.jsonl'
$wpr = "$env:SystemRoot\System32\wpr.exe"
$module = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\Modules\DefenderPerformance"
function CpuSample {
    try {
        $c = (Get-Counter '\Process(MsMpEng)\% Processor Time','\Process(MsMpEng)\ID Process').CounterSamples
        $cpu = @($c | Where-Object Path -like '*\% processor time')
        $id = @($c | Where-Object Path -like '*\id process')
        if ($cpu.Count -eq 1 -and $id.Count -eq 1 -and $cpu[0].Status -in 0,1 -and $id[0].Status -in 0,1) {
            return @{pid=$id[0].RawValue; ticks=$cpu[0].RawValue}
        }
    } catch {}
}
function Emit($row) { Add-Content -LiteralPath $output -Value (ConvertTo-Json $row -Compress) }
if ($Action -eq 'start') {
    if ((Test-Path -LiteralPath $statePath) -or (Test-Path -LiteralPath $etl)) { throw 'Existing probe state.' }
    $state = @{instance=('OMPNav'+[guid]::NewGuid().ToString('N')); started=$false; cpu=(CpuSample); t=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}
    $profile = Join-Path $module 'MSFT_MpPerformanceRecording.wprp'
    try {
        & $wpr -start "${profile}!Scans.Light" -instancename $state.instance *> $null
        $state.started = $LASTEXITCODE -eq 0
    } catch {}
    $state | ConvertTo-Json | Set-Content -LiteralPath $statePath
    return
}
$phase = 'missing-start'
try {
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $now = CpuSample
    $cpuMs = if ($now -and $state.cpu -and $now.pid -eq $state.cpu.pid -and $now.ticks -ge $state.cpu.ticks) { ($now.ticks - $state.cpu.ticks) / 10000.0 }
    Emit @{stage='defender-process-total'; startMs=$state.t; endMs=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); startPid=$state.cpu.pid; endPid=$now.pid; cpuMs=$cpuMs}
    $phase = 'recorder-unavailable'
    if (!$state.started -or $state.instance -notmatch '^OMPNav[0-9a-f]{32}$') { throw 'not started' }
    $phase = 'stop'
    & $wpr -stop $etl -instancename $state.instance *> $null
    if ($LASTEXITCODE -ne 0) { & $wpr -cancel -instancename $state.instance *> $null; throw 'stop' }
    $phase = 'mapping'
    $files = @{}
    foreach ($map in Get-ChildItem -LiteralPath $private -Filter 'profile-*.json' -File) {
        if ($map.LinkType -or $map.Length -gt 65536 -or $map.BaseName -notmatch '^profile-(\d+-\d+)$') { continue }
        $key = $Matches[1]
        $root = (Get-Content -LiteralPath $map.FullName -Raw | ConvertFrom-Json).profile -replace '^\\\\\?\\',''
        if ($root -notmatch '^[A-Za-z]:\\' -or [IO.Path]::GetFullPath($root) -ne $root) { continue }
        foreach ($file in 'Cookies','Cookies-journal','Cookies-wal','Cookies-shm') {
            $path = Join-Path $root "tauri-webview\EBWebView\Default\Network\$file"
            $files[$path] = @{hostKey=$(if (!$files.ContainsKey($path)) {$key});file=$file}
        }
    }
    $phase = 'report'
    Import-Module (Join-Path $module 'DefenderPerformance.psd1') -SkipEditionCheck -WarningAction SilentlyContinue
    $report = Get-MpPerformanceReport -Path $etl -TopScans 8192 -Raw -WarningAction SilentlyContinue 2>$null
    if ($null -eq $report.TopScans) { throw 'no report' }
    $matchesFound = 0
    foreach ($scan in $report.TopScans) {
        $row = ScanRow $scan $files
        if ($row) { Emit $row; $matchesFound++ }
    }
    Emit @{stage='defender-coverage'; selection='memory-ring-top-8192'; mappedFiles=$files.Count; matchedScans=$matchesFound}
} catch { Emit @{stage='defender-unavailable';phase=$phase} }
finally { if (Test-Path -LiteralPath $etl) { Remove-Item -LiteralPath $etl } }
