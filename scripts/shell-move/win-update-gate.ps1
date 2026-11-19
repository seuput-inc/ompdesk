<#
The Windows update gate of a release (0.134.2 on): an INSTALLED Tauri-shell app's own updater, on a clean windows-latest
runner under the real identity (win-update-common.ps1). A runner VM is throwaway: never run it on a machine that holds an
install.

  -Mode break   the old app (-OldSetup, e.g. published v0.134.1) is offered -NewSetup by the stand-in feed; the gate passes
                when its download fails with "session electron-updater does not exist" (the defect 0.134.2 fixes), and it
                records every update-log row for eight minutes, so what the second check after the failure does is seen too.
  -Mode manual  the old app runs a turn on the runner's stock omp, which a scripted provider on loopback holds open, and
                -NewSetup is run by hand with /S --force-run over it (what a person stuck on the old app does once); the
                setup starts -NewVersion with userData, the WebView store and ~\.omp kept, both tabs come back and the
                cut-off turn is continued once, in the new app.
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
$provider = $null

Evidence "mode $Mode; installed v$OldVersion; offered v$NewVersion ($((Get-Item -LiteralPath $NewSetup).Length) bytes)"
Check (-not (Test-Path -LiteralPath $installDir) -and -not (Get-Entry)) 'the runner starts without an OMPdesk install'

# break and update: no omp and no machine setup on the runner: the app looks for omp at a path that is not there, and
# "installs" with whoami. manual: the runner's stock omp (install-omp), which the app finds on PATH as a person's.
$noOmp = Join-Path $env:TEMP 'no-omp.cmd'
$noInstall = Join-Path $env:SystemRoot 'System32\whoami.exe'
$appEnv = @{ OMP_GUI_HEADLESS = '1' }
if ($Mode -ne 'manual') { $appEnv.OMP_GUI_OMP = $noOmp; $appEnv.OMP_GUI_TEST_INSTALLER = $noInstall }
function Set-AppEnv { foreach ($name in $appEnv.Keys) { Set-Item -LiteralPath "Env:$name" -Value $appEnv[$name] } }
function Clear-AppEnv { foreach ($name in $appEnv.Keys) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue } }
function Start-App {
	Set-AppEnv
	try { Start-Process -FilePath $exe -PassThru } finally { Clear-AppEnv }
}
function Read-JsonLines([string] $File) {
	@(Get-Content -LiteralPath $File -ErrorAction SilentlyContinue |
		ForEach-Object { try { $_ | ConvertFrom-Json } catch { $null } } | Where-Object { $_ })
}
# The lines one version of the app wrote to gui-runtime.jsonl (runtime-log.ts stamps each with appVersion).
function Get-LogRows([string] $Source, [string] $Version) {
	@(Read-JsonLines (Join-Path $userData 'logs\gui-runtime.jsonl') | Where-Object { $_.source -eq $Source -and $_.appVersion -eq $Version })
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
	# The first check runs 3 s after start, the next one 5 minutes later: eight minutes see both and the second download.
	while (((Get-Date) - $t0).TotalMinutes -lt 8) {
		Start-Sleep -Seconds 5
		if (-not $failed) { $failed = Get-UpdateRows | Where-Object { $_.message -eq 'download' -and $_.details.event -eq 'failed' } | Select-Object -First 1 }
	}
	Show-Rows
	Check ($null -ne $failed) "v${OldVersion}'s download of v$NewVersion failed"
	Check ($failed.details.reason -match 'session electron-updater does not exist') "the failure is the shell's missing partition (reason '$($failed.details.reason)')"
	# Whether the second check's download, on the partition Brave registered meanwhile, gets through is a fact to record.
	$verified = Get-UpdateRows | Where-Object { $_.message -eq 'download' -and $_.details.event -eq 'verified' } | Select-Object -First 1
	Evidence "a later download of v$NewVersion was verified: $($null -ne $verified)"
}
elseif ($Mode -eq 'manual') {
	# The turn under test runs on stock omp against a scripted provider on loopback (scripted-provider.ts: no account, no
	# spend), which omp reaches through ~\.omp\agent of this throwaway runner. The provider holds the turn's request open
	# until $release exists, so the turn stays running in the old app until the setup ends it.
	$turnMark = 'WIN-UPDATE-GATE-TURN-0134'
	$providerPort = 18434
	$providerLog = Join-Path $Out 'provider.log'
	$release = Join-Path $env:TEMP 'win-update-gate-release'
	Remove-Item -LiteralPath $release -ErrorAction SilentlyContinue
	$omp = Get-Command omp -ErrorAction SilentlyContinue
	Check ($null -ne $omp) "stock omp is on PATH ($($omp.Source): $(if ($omp) { & $omp.Source '--version' | Select-Object -First 1 }))"
	$provider = Start-Process -FilePath bun -ArgumentList @((Join-Path $PSScriptRoot 'scripted-provider.ts'), '--marker', $turnMark, '--release', $release, '--port', "$providerPort") -PassThru -RedirectStandardOutput $providerLog -RedirectStandardError (Join-Path $Out 'provider.err')
	for ($i = 0; $i -lt 30 -and -not (Test-Log $providerLog '"listening"'); $i++) { Start-Sleep -Seconds 1 }
	Check (Test-Log $providerLog '"listening"') "the scripted provider listens on 127.0.0.1:$providerPort"
	$agentDir = Join-Path $HOME '.omp\agent'
	Set-Content -LiteralPath (Join-Path $agentDir 'models.yml') -Value @(
		'providers:', '  fake:', "    baseUrl: http://127.0.0.1:$providerPort/v1", '    apiKey: x', '    api: openai-completions',
		'    models:', '      - id: m1', '        name: m1', '        reasoning: false',
		'        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }')
	Set-Content -LiteralPath (Join-Path $agentDir 'config.yml') -Value @('modelRoles:', '  default: fake/m1', '  smol: fake/m1', '  slow: fake/m1')

	# What the old app finds at its first start: two saved tabs (prefs.json tabLayouts, tab-layout.ts) and, for the first
	# one, a stock session whose prompt nothing answered with its marker (turn-resume.ts ResumeMarker). The old app
	# continues that turn itself (stock restoreSession), so from then on the running turn, its marker and the saved layout
	# are the old app's own; nothing is seeded while it runs or after it.
	$projects = Join-Path $HOME 'win-update-gate-projects'
	$turnCwd = Join-Path $projects 'interrupted'
	$otherCwd = Join-Path $projects 'second'
	New-Item -ItemType Directory -Force -Path $turnCwd, $otherCwd | Out-Null
	$turnSession = Join-Path (Split-Path $ompCanary) 'interrupted-turn.jsonl'
	$otherSession = Join-Path (Split-Path $ompCanary) 'second-tab.jsonl'
	$markerFile = Join-Path $userData 'interrupted-turns.json'
	$now = [DateTimeOffset]::UtcNow
	$stamp = $now.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
	function Write-Session([string] $File, [string] $Cwd, [hashtable[]] $Messages) {
		$lines = @([ordered]@{ type = 'session'; version = 3; id = [guid]::NewGuid().ToString(); timestamp = $stamp; cwd = $Cwd } | ConvertTo-Json -Compress)
		$parent = $null
		foreach ($message in $Messages) {
			$entry = '{0:x8}' -f $lines.Count
			$lines += [ordered]@{
				type = 'message'; id = $entry; parentId = $parent; timestamp = $stamp
				message = [ordered]@{ role = $message.role; content = @(@{ type = 'text'; text = $message.text }); timestamp = $now.ToUnixTimeMilliseconds() }
			} | ConvertTo-Json -Compress -Depth 5
			$parent = $entry
		}
		Set-Content -LiteralPath $File -NoNewline -Value (($lines -join "`n") + "`n")
	}
	# The journal as its message roles and record types, in order.
	function Get-Journal([string] $File) {
		(Read-JsonLines $File | ForEach-Object {
			if ($_.type -eq 'message') { "$($_.message.role)$(if ($_.message.stopReason) { "/$($_.message.stopReason)" })" } elseif ($_.customType) { $_.customType } else { $_.type }
		}) -join ' '
	}
	function Test-Reply {
		[bool](Read-JsonLines $turnSession | Where-Object { $_.type -eq 'message' -and $_.message.role -eq 'assistant' -and (($_.message.content | ForEach-Object { $_.text }) -join '') -cmatch 'CONTINUED' })
	}
	Write-Session $turnSession $turnCwd @(@{ role = 'user'; text = "$turnMark Answer in one word." })
	Write-Session $otherSession $otherCwd @(@{ role = 'user'; text = 'The second tab.' }, @{ role = 'assistant'; text = 'It stays open across the update.' })
	Set-Content -LiteralPath $markerFile -Value (ConvertTo-Json -Compress -InputObject @([ordered]@{ window = 1; tab = 'seed'; sessionPath = $turnSession; cwd = $turnCwd; kind = 'agent'; startedAt = $now.ToUnixTimeMilliseconds(); reason = 'running' }))
	# With them a setting a person picks (Settings › General › reply language; prefs.json is electron-store's file, SafeStore
	# "prefs"), written before the first start so the old app reads and keeps it.
	$prefsFile = Join-Path $userData 'prefs.json'
	$tabs = @([ordered]@{ cwd = $turnCwd; sessionPath = $turnSession; kind = 'agent' }, [ordered]@{ cwd = $otherCwd; sessionPath = $otherSession; kind = 'agent' })
	Set-Content -LiteralPath $prefsFile -Value ([ordered]@{ replyLanguage = 'Japanese'; tabLayouts = @([ordered]@{ version = 1; tabs = $tabs; activeIndex = 0 }) } | ConvertTo-Json -Compress -Depth 6)
	$sessionHash = (Get-FileHash -LiteralPath $ompCanary).Hash
	$null = Start-App
	$mark = Wait-Started $OldVersion 90
	Check ($mark.version -eq $OldVersion) "v$OldVersion started (app-started.json)"
	for ($i = 0; $i -lt 60 -and -not (Test-Log $providerLog '"phase":"held"'); $i++) { Start-Sleep -Seconds 2 }
	Start-Sleep -Seconds 15
	$store = Get-Item -LiteralPath $webViewStore -Force -ErrorAction SilentlyContinue
	$storeBorn = $store.CreationTimeUtc
	$prefsBefore = Read-Json $prefsFile
	Evidence "before: WebView store created $($storeBorn.ToString('o')), $(@(Get-ChildItem -LiteralPath $webViewStore -Recurse -File -Force -ErrorAction SilentlyContinue).Count) files; prefs $($prefsBefore | ConvertTo-Json -Compress -Depth 6)"
	Check ($prefsBefore.replyLanguage -eq 'Japanese') "v$OldVersion kept the seeded reply language"
	$held = @(Read-JsonLines $providerLog | Where-Object { $_.phase -eq 'held' })
	$marked = @(Read-Json $markerFile | Where-Object { $_ })
	foreach ($row in Get-LogRows 'turn-resume' $OldVersion) { Evidence "before: v$OldVersion turn-resume $($row.message) $($row.details | ConvertTo-Json -Compress -Depth 3)" }
	Evidence "before: the provider holds $($held.Count) request(s) of the turn; marker file $($marked | ConvertTo-Json -Compress -Depth 3); journal: $(Get-Journal $turnSession)"
	Check ($held.Count -ge 1 -and -not (Read-JsonLines $providerLog | Where-Object { $_.phase -eq 'continued' })) "v$OldVersion runs the seeded turn on stock omp and the provider holds its request unanswered"
	Check ($marked.Count -eq 1 -and $marked[0].reason -eq 'running' -and $marked[0].sessionPath -eq $turnSession -and $marked[0].tab -ne 'seed') "v$OldVersion wrote the marker of that running turn itself (tab $($marked[0].tab))"
	# A person runs the setup while the app is open. /S alone closes the running app and starts nothing; --force-run starts
	# the new app. The provider is let go only once every process of the old install has ended, so the one answer it gives
	# can reach nothing but the app the setup starts. The setup is polled, not waited for: Start-Process -Wait would also
	# wait for the app it starts.
	$oldIds = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -like "$installDir\*" } | ForEach-Object { $_.Id })
	Check ($oldIds.Count -gt 0) "v$OldVersion is running when the setup starts ($($oldIds.Count) processes of the install)"
	$letGo = {
		if (-not (Test-Path -LiteralPath $release) -and -not ($oldIds.Count -and (Get-Process -Id $oldIds -ErrorAction SilentlyContinue))) {
			Set-Content -LiteralPath $release -Value 'the old app ended'
			Evidence "every process of v$OldVersion had ended at second $([int]((Get-Date) - $t0).TotalSeconds): the provider answers from here ($([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()))"
		}
	}
	Set-AppEnv
	$setup = Start-Process -FilePath $NewSetup -ArgumentList '/S', '--force-run' -PassThru
	Clear-AppEnv
	$null = $setup.Handle
	$deadline = (Get-Date).AddMinutes(10)
	while (-not $setup.HasExited -and (Get-Date) -lt $deadline) { & $letGo; Start-Sleep -Milliseconds 200 }
	& $letGo
	Check ($setup.HasExited -and $setup.ExitCode -eq 0) "v$NewVersion's setup /S --force-run over the running v$OldVersion exited 0 (exit $($setup.ExitCode))"
	$entry = Get-Entry
	Check ($entry -and $entry.DisplayVersion -eq $NewVersion) "the uninstall entry says $NewVersion"
	$mark = Wait-Started $NewVersion 120
	Check ($mark.version -eq $NewVersion) "the setup started v$NewVersion on the same profile (app-started.json)"
	for ($i = 0; $i -lt 90 -and -not (Test-Reply); $i++) { Start-Sleep -Seconds 2 }
	# Ten more seconds: a second request of the turn, were one sent, is in the provider's log by then.
	Start-Sleep -Seconds 10
	$prefsAfter = Read-Json $prefsFile
	$lost = @($prefsBefore.PSObject.Properties.Name | Where-Object { $_ -notin @($prefsAfter.PSObject.Properties.Name) })
	$storeAfter = Get-Item -LiteralPath $webViewStore -Force -ErrorAction SilentlyContinue
	Evidence "after: WebView store created $($storeAfter.CreationTimeUtc.ToString('o')); prefs keys lost: $($lost -join ',')"
	Check ($null -ne $store -and $null -ne $storeAfter -and $storeAfter.CreationTimeUtc -eq $storeBorn) 'the WebView store is the same folder, not made anew'
	Check ($prefsAfter.replyLanguage -eq 'Japanese' -and $lost.Count -eq 0) "v$NewVersion keeps the reply language and every setting key"
	Check ((Test-Path -LiteralPath $ompCanary) -and (Get-FileHash -LiteralPath $ompCanary).Hash -eq $sessionHash) '~\.omp session file is unchanged'
	foreach ($row in @(Get-LogRows 'tab-layout' $NewVersion) + @(Get-LogRows 'turn-resume' $NewVersion)) { Evidence "after: v$NewVersion $($row.source) $($row.message) $($row.details | ConvertTo-Json -Compress -Depth 3)" }
	$layout = Get-LogRows 'tab-layout' $NewVersion | Where-Object { $_.message -like 'restored*' } | Select-Object -First 1
	Check ($layout.message -eq 'restored' -and $layout.details.tabs -eq 2) "v$NewVersion restored both tabs, none left out or started fresh (tab-layout '$($layout.message)', tabs $($layout.details.tabs))"
	$resume = Get-LogRows 'turn-resume' $NewVersion
	$launch = $resume | Where-Object { $_.message -eq 'launch' } | Select-Object -First 1
	Check ($launch.details.markers -eq 1 -and $launch.details.enabled -eq $true) "v$NewVersion found the one interrupted turn at launch (turn-resume launch: markers $($launch.details.markers), enabled $($launch.details.enabled))"
	$started = @($resume | Where-Object { $_.message -eq 'continue' -and $_.details.started -eq $true })
	Check ($started.Count -eq 1) "v$NewVersion continued it once (turn-resume continue with started true: $($started.Count))"
	$turnRows = @(Read-JsonLines $providerLog | Where-Object { $_.marker -eq $true -and $_.main -eq $true })
	$answered = @($turnRows | Where-Object { $_.phase -eq 'continued' })
	Evidence "after: the provider's requests of the turn: $(($turnRows | ForEach-Object { "$($_.phase) at $($_.at)" }) -join ', '); requests of any kind: $(@(Read-JsonLines $providerLog | Where-Object { $_.phase -and $_.phase -ne 'cut' }).Count)"
	Check ($answered.Count -eq 1) "the provider got exactly one request of the interrupted turn after v$OldVersion had ended, and answered it (got $($answered.Count))"
	Check (Test-Reply) "the turn's session file journals the provider's reply (journal: $(Get-Journal $turnSession))"
	Save-Text $turnSession 'interrupted-turn.jsonl'
	Save-Text $markerFile 'interrupted-turns.json'
	Save-Text $prefsFile 'prefs.json'
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
	# 0.134.0 and 0.134.1 also got here, one background check (5 min) later: the gate is that the FIRST download succeeds.
	$downloads = @($rows | Where-Object { $_.message -eq 'download' })
	Evidence "download rows: $(($downloads | ForEach-Object { "$($_.details.event) $($_.details.version)" }) -join ', ')"
	Check ($downloads.Count -ge 2 -and $downloads[0].details.event -eq 'started' -and $downloads[1].details.event -eq 'verified' -and $downloads[1].details.version -eq $NewVersion) "the first download of v$NewVersion is verified with nothing in between"
	Check (-not ($downloads | Where-Object { $_.details.event -eq 'failed' })) 'no download failed'
	Check (@($downloads | Where-Object { $_.details.event -eq 'started' }).Count -eq 1) 'the update was downloaded once'
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
if ($provider -and -not $provider.HasExited) { Stop-Process -Id $provider.Id -Force -ErrorAction SilentlyContinue }
if ($script:failures.Count) { Say "RESULT: FAILED ($($script:failures.Count)): $($script:failures -join '; ')"; exit 1 }
Say 'RESULT: ok'
