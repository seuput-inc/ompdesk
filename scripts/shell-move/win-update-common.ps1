<#
What win-update-real.ps1 and win-update-gate.ps1 share: the real identity's paths (%LOCALAPPDATA%\Programs\ompdesk, the
uninstall entry, %APPDATA%\ompdesk) and the run log's helpers. Dot-source it after setting $Out; `Check` collects failures
in $script:failures of the caller.
#>
$runLog = Join-Path $Out 'run.log'
$script:failures = @()

function Say([string] $Line) { Write-Host $Line; Add-Content -LiteralPath $runLog -Value $Line }
function Evidence([string] $Text) { Say "EVIDENCE $Text" }
function Check([bool] $Ok, [string] $What) {
	if ($Ok) { Say "ok   $What" } else { Say "FAILED $What"; $script:failures += $What }
}

$installDir = Join-Path $env:LOCALAPPDATA 'Programs\ompdesk'
$exe = Join-Path $installDir 'OMPdesk.exe'
$userData = Join-Path $env:APPDATA 'ompdesk'
$setupLog = Join-Path $env:TEMP 'ompdesk-setup.log'
$uninstallRoot = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'

function Get-Entry {
	@(Get-ChildItem $uninstallRoot -ErrorAction SilentlyContinue |
		ForEach-Object { Get-ItemProperty $_.PSPath } |
		Where-Object { $_.DisplayName -like 'OMPdesk*' }) | Select-Object -First 1
}

function Get-ExeVersion {
	if (-not (Test-Path -LiteralPath $exe)) { return $null }
	$info = (Get-Item -LiteralPath $exe).VersionInfo
	[ordered]@{ file = $info.FileVersion; product = $info.ProductVersion }
}

function Read-Json([string] $File) {
	if (-not (Test-Path -LiteralPath $File)) { return $null }
	try { Get-Content -Raw -LiteralPath $File | ConvertFrom-Json } catch { $null }
}

# A file another process holds open (a log still being written) is read with Get-Content, which shares it.
function Test-Log([string] $File, [string] $Pattern) {
	if (-not (Test-Path -LiteralPath $File)) { return $false }
	$text = Get-Content -Raw -LiteralPath $File -ErrorAction SilentlyContinue
	[bool]($text -and $text -match $Pattern)
}

function Get-Snapshot {
	Get-CimInstance Win32_Process | Where-Object {
		$_.Name -in 'OMPdesk.exe', 'node.exe', 'msedgewebview2.exe', 'ompdesk-windows-setup.exe', 'Uninstall OMPdesk.exe' -or
		($_.ExecutablePath -and $_.ExecutablePath -like "$installDir*")
	} | ForEach-Object {
		[ordered]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name; path = $_.ExecutablePath }
	}
}

function Add-Snapshot([string] $Label) {
	$line = [ordered]@{ at = (Get-Date).ToString('o'); label = $Label; processes = @(Get-Snapshot) } |
		ConvertTo-Json -Compress -Depth 4
	Add-Content -LiteralPath (Join-Path $Out 'processes.jsonl') -Value $line
}

function Stop-Installed {
	Get-Process -ErrorAction SilentlyContinue |
		Where-Object { $_.Path -and $_.Path -like "$installDir\*" } |
		Stop-Process -Force -ErrorAction SilentlyContinue
}

function Save-Text([string] $Source, [string] $Name, [int] $Tail = 0) {
	if (-not (Test-Path -LiteralPath $Source)) { Say "note: $Source is not there"; return }
	try {
		$lines = if ($Tail -gt 0) { Get-Content -LiteralPath $Source -Tail $Tail } else { Get-Content -LiteralPath $Source }
		Set-Content -LiteralPath (Join-Path $Out $Name) -Value $lines
	} catch { Say "note: could not copy ${Source}: $($_.Exception.Message)" }
}

# The update log's rows (src/main/updater.ts logUpdate: source app-update, message = area, details.event = step).
function Get-UpdateRows {
	@(Get-Content -LiteralPath (Join-Path $userData 'logs\gui-runtime.jsonl') -ErrorAction SilentlyContinue |
		ForEach-Object { try { $_ | ConvertFrom-Json } catch { $null } } | Where-Object { $_.source -eq 'app-update' })
}
