param([Parameter(Mandatory)][ValidateSet('start', 'stop')][string]$Action)

$ErrorActionPreference = 'Stop'
$phase = 'runner'
$artifact = $null
try {
    if (-not $IsWindows -or $env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted') { throw 'runner' }
    $phase = 'directories'
    $runner = (Get-Item -LiteralPath $env:RUNNER_TEMP).FullName
    $private = Get-Item -LiteralPath $env:OMPDESK_NAV_PRIVATE
    $stages = Get-Item -LiteralPath $env:OMPDESK_NAV_STAGES
    foreach ($dir in $private, $stages) {
        if (-not $dir.PSIsContainer -or $dir.Parent.FullName -ne $runner -or ($dir.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'unsafe directory' }
    }
    if ($private.FullName -eq $stages.FullName) { throw 'overlap' }
    $artifact = Join-Path $stages.FullName 'cookie-io.jsonl'
    $etl = Join-Path $private.FullName 'nav-cookie-io.etl'
    $marker = Join-Path $private.FullName 'nav-cookie-io.session'
    if ($Action -eq 'start') {
        $phase = 'start'
        if ((Test-Path -LiteralPath $etl) -or (Test-Path -LiteralPath $marker)) { throw 'existing session' }
        $logger = 'ompdesk-cookie-' + [guid]::NewGuid().ToString('N')
        [IO.File]::WriteAllText($marker, $logger)
        # Filename lifetime, operation end, create/open, read, write. No general FILEIO, stacks or process provider.
        & logman.exe create trace $logger -p 'Microsoft-Windows-Kernel-File' 0x3d0 4 -f bin -max 256 -bs 64 -nb 16 64 -ct perf -o $etl -ets *> $null
        if ($LASTEXITCODE -ne 0) { throw 'start' }
        exit 0
    }

    $phase = 'stop'
    $logger = [IO.File]::ReadAllText($marker)
    if ($logger -cnotmatch '^ompdesk-cookie-[a-f0-9]{32}$') { throw 'session' }
    $query = & logman.exe query $logger -ets 2>$null
    if ($LASTEXITCODE -eq 0) {
        if (-not ($query -match (':\s*' + [regex]::Escape($etl) + '\s*$'))) { throw 'ownership' }
        & logman.exe stop $logger -ets *> $null
        if ($LASTEXITCODE -ne 0) { throw 'stop' }
    }
    # Sequential ETW sessions stop at MaximumFileSize; never restart or overwrite the first window.
    $length = (Get-Item -LiteralPath $etl).Length
    $phase = 'registry'
    $hosts = @{}
    foreach ($file in (Get-ChildItem -LiteralPath $private.FullName -File)) {
        if ($file.Name -cnotmatch '^(profile|native|net)-([0-9]{1,10})-([0-9]{1,15})\.(jsonl?)$') { continue }
        $kind, $owner, $lifetime = $Matches[1..3]
        $key = "$owner-$lifetime"
        if (-not $hosts.ContainsKey($key)) { $hosts[$key] = '' }
        if ($kind -ne 'profile' -or $Matches[4] -ne 'json' -or $file.Length -gt 65536 -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { continue }
        try {
            $p = ([IO.File]::ReadAllText($file.FullName) | ConvertFrom-Json).profile
            if ($p -isnot [string]) { continue }
            if ($p.StartsWith('\\?\')) { $p = $p.Substring(4) }
            if ($p -notmatch '^[A-Za-z]:\\' -or $p -match '[\x00-\x1f]|(?:^|\\)\.{1,2}(?:\\|$)' -or [IO.Path]::GetFullPath($p) -ne $p) { continue }
            foreach ($base in @($env:TEMP, $env:TMP, (Join-Path $env:LOCALAPPDATA 'Temp'), $runner)) {
                if ($base -and [IO.Path]::GetRelativePath($base, $p) -match '^ompdesk-run-[0-9]+-[a-zA-Z0-9]{6}\\.+') {
                    $hosts[$key] = $p
                    break
                }
            }
        } catch { continue }
    }
    $roots = foreach ($key in $hosts.Keys) { "$($key.Replace('-', "`t"))`t$($hosts[$key])" }
    $phase = 'decode'
    Push-Location -LiteralPath $private.FullName
    try {
        [IO.File]::WriteAllLines((Join-Path $private.FullName 'nav-cookie-io.roots'), [string[]]@($roots | Where-Object { $_ }))
        $phase = 'compiler'
        & g++.exe -std=c++17 -O2 (Join-Path $PSScriptRoot 'nav-cookie-io.cpp') -o nav-cookie-io.exe -ladvapi32 *> $null
        if ($LASTEXITCODE -ne 0) { throw 'compiler' }
        $phase = 'decode'
        & .\nav-cookie-io.exe *> $null
        if ($LASTEXITCODE -ne 0) { throw 'decoder' }
        $phase = 'publish'
        $result = Join-Path $private.FullName 'nav-cookie-io.jsonl'
        $info = @{ event = 'cookie-io.window'; mode = 'sequential-prefix'; maxMiB = 256; etlBytes = $length; nearCap = ($length -ge (256MB - 64KB)) }
        [IO.File]::AppendAllText($result, (($info | ConvertTo-Json -Compress) + "`n"))
        Copy-Item -LiteralPath $result -Destination $artifact
    } finally { Pop-Location }
} catch {
    if ($artifact) { [IO.File]::WriteAllText($artifact, "{`"event`":`"cookie-io.unavailable`",`"phase`":`"$phase`"}`n") }
    [Console]::Error.WriteLine("Cookie I/O probe unavailable at $phase.")
    exit 1
}
