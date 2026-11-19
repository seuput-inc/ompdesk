<#
The Windows update gate of a release (0.134.2 on): an INSTALLED Tauri-shell app's own updater, on a clean windows-latest
runner under the real identity (win-update-common.ps1). A runner VM is throwaway: never run it on a machine that holds an
install.

  -Mode break   the old app (-OldSetup, e.g. published v0.134.1) is offered -NewSetup by the stand-in feed; the gate passes
                when its download fails with "session electron-updater does not exist" (the defect 0.134.2 fixes), and it
                records every update-log row for seven minutes, so a second check after the failure is seen too.
  -Mode manual  the old app runs, and -NewSetup is run by hand with /S over it (what a person stuck on the old app does
                once); the new app starts as -NewVersion with userData, the WebView store and ~\.omp kept.
  -Mode update  the old app (-OldSetup = the candidate) is offered -NewSetup (a higher build of the same branch) and its
                own updater checks, downloads, verifies, counts down, starts the setup and quits; the setup installs and
                starts the new app.

The stand-in feed (feed.ts) answers for api.github.com on 127.0.0.1:443. The Tauri shell's network is native (WinHTTP),
which no Chromium switch reaches, so the name is mapped in the hosts file and the feed's certificate is trusted in
LocalMachine\Root: the app runs unchanged, with no argument, and GitHub's public feed is never touched.
#>
param(
	[Parameter(Mandatory)] [ValidateSet('break', 'manual', 'update')] [string] $Mode,
	[Parameter(Mandatory)] [string] $OldSetup,
	[Parameter(Mandatory)] [string] $OldVersion,
	[Parameter(Mandatory)] [string] $NewSetup,
	[Parameter(Mandatory)] [string] $NewVersion,
	[Parameter(Mandatory)] [string] $Out,
	[string] $FeedScript = ''
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$Out = (Resolve-Path -LiteralPath $Out).Path
$OldSetup = (Resolve-Path -LiteralPath $OldSetup).Path
$NewSetup = (Resolve-Path -LiteralPath $NewSetup).Path
. (Join-Path $PSScriptRoot 'win-update-common.ps1')
$canary = Join-Path $userData 'win-update-gate-canary.txt'
$ompCanary = Join-Path $HOME '.omp\agent\sessions\win-update-gate\canary.jsonl'
$webViewStore = Join-Path $userData 'tauri-webview'
$feed = $null

Evidence "mode $Mode; installed v$OldVersion; offered v$NewVersion ($((Get-Item -LiteralPath $NewSetup).Length) bytes)"
Check (-not (Test-Path -LiteralPath $installDir) -and -not (Get-Entry)) 'the runner starts without an OMPdesk install'

# No omp and no machine setup on the runner: the app looks for omp at a path that is not there, and "installs" with whoami.
$noOmp = Join-Path $env:TEMP 'no-omp.cmd'
$noInstall = Join-Path $env:SystemRoot 'System32\whoami.exe'
function Start-App {
	$env:OMP_GUI_HEADLESS = '1'
	$env:OMP_GUI_OMP = $noOmp
	$env:OMP_GUI_TEST_INSTALLER = $noInstall
	try { Start-Process -FilePath $exe -PassThru } finally {
		Remove-Item Env:OMP_GUI_HEADLESS, Env:OMP_GUI_OMP, Env:OMP_GUI_TEST_INSTALLER -ErrorAction SilentlyContinue
	}
}
function Wait-Started([string] $Version, [int] $Seconds) {
	$mark = $null
	for ($i = 0; $i -lt $Seconds / 2 -and $mark.version -ne $Version; $i++) { Start-Sleep -Seconds 2; $mark = Read-Json (Join-Path $userData 'app-started.json') }
	$mark
}
function Show-Rows {
	foreach ($row in Get-UpdateRows) { Evidence "update log: $($row.message) $($row.details | ConvertTo-Json -Compress -Depth 4)" }
}

function Start-Feed {
	$env:PATH = "$env:PATH;C:\Program Files\Git\usr\bin"
	$certDir = Join-Path $env:TEMP 'win-update-gate-cert'
	$script:feed = Start-Process -FilePath bun -ArgumentList @($FeedScript, '--setup', $NewSetup, '--version', $NewVersion, '--cert-dir', $certDir, '--port', '443') -PassThru -RedirectStandardOutput (Join-Path $Out 'feed.log') -RedirectStandardError (Join-Path $Out 'feed.err')
	for ($i = 0; $i -lt 30 -and -not (Test-Log (Join-Path $Out 'feed.log') '"listening"'); $i++) { Start-Sleep -Seconds 1 }
	Check (Test-Log (Join-Path $Out 'feed.log') '"listening"') 'the stand-in feed listens on 127.0.0.1:443'
	& certutil -addstore -f Root (Join-Path $certDir 'feed-cert.pem') | Out-Null
	Check ($LASTEXITCODE -eq 0) "the stand-in's certificate is trusted in LocalMachine\Root"
	Add-Content -LiteralPath (Join-Path $env:SystemRoot 'System32\drivers\etc\hosts') -Value "`r`n127.0.0.1 api.github.com"
	Clear-DnsClientCache
	# No -SkipCertificateCheck: the system's trust is what the app's WinHTTP uses too.
	$latest = try { Invoke-RestMethod -Uri 'https://api.github.com/repos/seuput-inc/ompdesk/releases/latest' } catch { Evidence "probe failed: $($_.Exception.Message)"; $null }
	Check ($latest.tag_name -eq "v$NewVersion") "api.github.com answers from the stand-in through the system's name and trust (latest $($latest.tag_name))"
}

# ---- the old app, as its setup installs it --------------------------------------------------------------------------------
$old = Start-Process -FilePath $OldSetup -ArgumentList '/S' -Wait -PassThru
$entry = Get-Entry
Check ($old.ExitCode -eq 0 -and (Test-Path -LiteralPath $exe)) "v$OldVersion's setup /S installed it (exit $($old.ExitCode))"
Check ($entry -and $entry.DisplayVersion -eq $OldVersion) "the uninstall entry says $OldVersion"
New-Item -ItemType Directory -Force -Path $userData, (Split-Path $ompCanary) | Out-Null
Set-Content -LiteralPath $canary -Value 'userData before the update'
Set-Content -LiteralPath $ompCanary -Value '{"type":"session","id":"win-update-gate"}'

$t0 = Get-Date
if ($Mode -eq 'break') {
	Start-Feed
	$null = Start-App
	$failed = $null
	# The first check runs 3 s after start, the next one 5 minutes later: seven minutes see both.
	while (((Get-Date) - $t0).TotalMinutes -lt 7) {
		Start-Sleep -Seconds 5
		if (-not $failed) { $failed = Get-UpdateRows | Where-Object { $_.message -eq 'download' -and $_.details.event -eq 'failed' } | Select-Object -First 1 }
	}
	Show-Rows
	Check ($null -ne $failed) "v${OldVersion}'s download of v$NewVersion failed"
	Check ($failed.details.reason -match 'session electron-updater does not exist') "the failure is the shell's missing partition (reason '$($failed.details.reason)')"
	Check (-not (Get-UpdateRows | Where-Object { $_.message -eq 'download' -and $_.details.event -eq 'verified' })) 'nothing was downloaded'
}
elseif ($Mode -eq 'manual') {
	$null = Start-App
	$mark = Wait-Started $OldVersion 90
	Check ($mark.version -eq $OldVersion) "v$OldVersion started (app-started.json)"
	Start-Sleep -Seconds 15
	$storeBefore = @(Get-ChildItem -LiteralPath $webViewStore -Recurse -File -Force -ErrorAction SilentlyContinue).Count
	$prefsBefore = Read-Json (Join-Path $userData 'prefs.json')
	Evidence "before: WebView store files $storeBefore; prefs keys $(@($prefsBefore.PSObject.Properties.Name) -join ',')"
	# A person runs the setup while the app is open.
	$setup = Start-Process -FilePath $NewSetup -ArgumentList '/S' -Wait -PassThru
	Check ($setup.ExitCode -eq 0) "v$NewVersion's setup /S over the running v$OldVersion exited 0 (exit $($setup.ExitCode))"
	$entry = Get-Entry
	Check ($entry -and $entry.DisplayVersion -eq $NewVersion) "the uninstall entry says $NewVersion"
	if (-not @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }).Count) { $null = Start-App }
	$mark = Wait-Started $NewVersion 120
	Check ($mark.version -eq $NewVersion) "v$NewVersion started on the same profile (app-started.json)"
	Start-Sleep -Seconds 10
	$storeAfter = @(Get-ChildItem -LiteralPath $webViewStore -Recurse -File -Force -ErrorAction SilentlyContinue).Count
	$prefsAfter = Read-Json (Join-Path $userData 'prefs.json')
	$lost = @($prefsBefore.PSObject.Properties.Name | Where-Object { $_ -notin @($prefsAfter.PSObject.Properties.Name) })
	Evidence "after: WebView store files $storeAfter; prefs keys lost: $($lost -join ',')"
	Check ($storeBefore -gt 0 -and $storeAfter -gt 0) 'the WebView store is kept'
	if ($prefsBefore) { Check ($null -ne $prefsAfter -and $lost.Count -eq 0) 'the settings file (prefs.json) keeps every key' }
	else { Evidence "v$OldVersion wrote no prefs.json on the runner; settings retention not asserted" }
	Check (Test-Path -LiteralPath $ompCanary) '~\.omp (sessions) is kept'
	Evidence 'not covered here: an interrupted turn continuing (the runner has no omp and no model account)'
}
else {
	Start-Feed
	$null = Start-App
	Evidence "v$OldVersion launched unchanged; the stand-in offers v$NewVersion"
	$seen = $false
	$deadline = (Get-Date).AddMinutes(25)
	while ((Get-Date) -lt $deadline) {
		$running = @(Get-Process -Name 'ompdesk-windows-setup' -ErrorAction SilentlyContinue)
		if ($running.Count) { $seen = $true } elseif ($seen) { break }
		Add-Snapshot $(if ($seen) { 'setup running' } else { 'waiting for the updater' })
		Start-Sleep -Seconds 3
	}
	Check $seen "v${OldVersion}'s own updater started the setup within 25 minutes"
	Evidence "the setup ended at second $([int]((Get-Date) - $t0).TotalSeconds)"
	$mark = Wait-Started $NewVersion 120
	for ($i = 0; $i -lt 30 -and -not (Get-UpdateRows | Where-Object { $_.message -eq 'swap' -and $_.details.event -eq 'result' }); $i++) { Start-Sleep -Seconds 2 }
	Show-Rows
	$rows = Get-UpdateRows
	$events = @($rows | ForEach-Object { "$($_.message) $($_.details.event)".Trim() })
	foreach ($wanted in 'check found', 'download verified', 'swap helper', 'swap result') { Check ($events -contains $wanted) "the update log has `"$wanted`"" }
	$result = $rows | Where-Object { $_.message -eq 'swap' -and $_.details.event -eq 'result' } | Select-Object -Last 1
	Check ($result.details.outcome -eq 'installed') "the new app logged swap result outcome installed (got '$($result.details.outcome)')"
	$entry = Get-Entry
	Check ($entry -and $entry.DisplayVersion -eq $NewVersion) "the uninstall entry says $NewVersion"
	Check ($mark.version -eq $NewVersion) "app-started.json names $NewVersion (the relaunched app's first page loaded)"
	Check (@(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }).Count -gt 0) 'the updated OMPdesk.exe is running'
}

if ($Mode -ne 'break') {
	Check (Test-Path -LiteralPath $canary) 'userData is kept (the canary written before the update)'
	Check (-not (Test-Path -LiteralPath (Join-Path $userData 'update-start-failed.json'))) 'no update-start-failed.json'
	$setupText = if (Test-Path -LiteralPath $setupLog) { Get-Content -Raw -LiteralPath $setupLog } else { '' }
	Check ($setupText -notmatch 'incomplete|start-failed|putting the old app back') 'the setup log has no incomplete, start-failed or rollback line'
}

# ---- everything the run left ---------------------------------------------------------------------------------------------
Save-Text $setupLog 'ompdesk-setup.log'
Save-Text (Join-Path $userData 'app-started.json') 'app-started.json'
Save-Text (Join-Path $userData 'update-install.json') 'update-install.json'
Save-Text (Join-Path $userData 'update-start-failed.json') 'update-start-failed.json'
Save-Text (Join-Path $userData 'tauri-shell.jsonl') 'tauri-shell.jsonl' 4000
Save-Text (Join-Path $userData 'logs\gui-runtime.jsonl') 'gui-runtime.jsonl' 4000
if ($feed) { Save-Text (Join-Path $Out 'feed.log') 'feed-requests.log' }
Stop-Installed
if ($feed -and -not $feed.HasExited) { Stop-Process -Id $feed.Id -Force -ErrorAction SilentlyContinue }
if ($script:failures.Count) { Say "RESULT: FAILED ($($script:failures.Count)): $($script:failures -join '; ')"; exit 1 }
Say 'RESULT: ok'
