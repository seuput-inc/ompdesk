<#
The update from the PUBLISHED Electron app (v0.131.0) to a candidate setup, on a clean windows-latest runner, under the
real identity (%LOCALAPPDATA%\Programs\ompdesk, the real uninstall GUID, userData in %APPDATA%\ompdesk). A runner VM is
throwaway, so nothing here protects a person's install: never run it on a machine that holds one.

  -Mode installer  The candidate setup runs with the arguments v0.131.0's electron-updater passes, nothing else of the
                   updater: OmpNsisUpdater.quitAndInstall() with no arguments is isSilent=false and the NSIS updater's
                   `install(false, autoRunAppAfterInstall=true)`, so doInstall builds `--updated --force-run
                   --package-file=<pending file>` (no /S, no /D=: node_modules/electron-updater/out/NsisUpdater.js
                   doInstall; the same on a restart and at quit: src/main/nsis-updater.ts, updater.ts quitAndInstall()).
                   The file sits where the updater keeps it, %LOCALAPPDATA%\ompdesk-updater\pending.
  -Mode feed       The published v0.131.0 app runs its own updater, so the app's real code path checks, downloads,
                   verifies and starts the setup and quits. With -FeedScript it asks feed.ts (a stand-in for api.github.com
                   offering the candidate, reached through Chromium's --host-resolver-rules); without it, GitHub's real
                   feed, whose latest release must then be the candidate.

Both: v0.131.0 is installed by its own setup with `/S` (silent, so the app does not start by itself), the candidate update runs, and the
outcome a person sees is asserted: the uninstall entry and the installed exe say the candidate's version, app-started.json
(written by the new app's Node main once its first page loaded) names it, the setup log has no `incomplete` or
`start-failed` line, no update-start-failed.json, no rollback in the update log, and userData is kept. Everything the
setup and the apps left is copied into -Out (the job uploads it): the setup's %TEMP%\ompdesk-setup.log, the setup's exit
code (installer mode), processes every 3 s while waiting, the shortcuts, the uninstall entry, the install folder, the
WebView2 runtime version, tauri-shell.jsonl, logs\gui-runtime.jsonl, Application-log errors.
#>
param(
	[Parameter(Mandatory)] [ValidateSet('installer', 'feed')] [string] $Mode,
	[Parameter(Mandatory)] [string] $OldSetup,
	[Parameter(Mandatory)] [string] $NewSetup,
	[Parameter(Mandatory)] [string] $OldVersion,
	[Parameter(Mandatory)] [string] $Out,
	[string] $NewVersion = '',
	[string] $FeedScript = '',
	[int] $FeedPort = 8443
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$Out = (Resolve-Path -LiteralPath $Out).Path
$OldSetup = (Resolve-Path -LiteralPath $OldSetup).Path
$NewSetup = (Resolve-Path -LiteralPath $NewSetup).Path
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
$canary = Join-Path $userData 'win-update-real-canary.txt'

if (-not $NewVersion) { $NewVersion = (Get-Item -LiteralPath $NewSetup).VersionInfo.ProductVersion }
if ($NewVersion -notmatch '^\d+\.\d+\.\d+$') { throw "the candidate's version is '$NewVersion': pass -NewVersion" }

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

function Get-WebView2 {
	$guid = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
	foreach ($key in "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$guid", "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$guid", "HKCU:\Software\Microsoft\EdgeUpdate\Clients\$guid") {
		$version = (Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue).pv
		if ($version) { return "$version ($key)" }
	}
	'not installed'
}

function Get-Shortcuts {
	$shell = New-Object -ComObject WScript.Shell
	foreach ($folder in [Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop')) {
		$link = Join-Path $folder 'OMPdesk.lnk'
		if (-not (Test-Path -LiteralPath $link)) { continue }
		$shortcut = $shell.CreateShortcut($link)
		[ordered]@{ link = $link; target = $shortcut.TargetPath; arguments = $shortcut.Arguments; workingDirectory = $shortcut.WorkingDirectory; targetExists = (Test-Path -LiteralPath $shortcut.TargetPath) }
	}
}

# A crash of the setup (0xc0000005 in electron-builder's SpiderBanner plugin after its work, run 44019132915) and what
# Windows Error Reporting shows the person: its windows are watched while the setup runs and after, and pictured.
$script:errorSeen = ''
function Get-ErrorWindows {
	@(Get-Process -ErrorAction SilentlyContinue | Where-Object {
			$_.MainWindowHandle -ne 0 -and ($_.ProcessName -match '^WerFault' -or $_.MainWindowTitle -match 'stopped working|작동이 중지|ompdesk-windows-setup')
		} | ForEach-Object { "$($_.ProcessName) '$($_.MainWindowTitle)'" })
}
function Save-Screen([string] $Name) {
	try {
		Add-Type -AssemblyName System.Windows.Forms, System.Drawing
		$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
		$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
		$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
		$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
		$bitmap.Save((Join-Path $Out $Name), [System.Drawing.Imaging.ImageFormat]::Png)
		$graphics.Dispose(); $bitmap.Dispose()
		Evidence "${Name}: $($bounds.Width)x$($bounds.Height)"
	} catch { Say "note: no screenshot $Name ($($_.Exception.Message))" }
}
function Watch-ErrorWindows {
	$windows = Get-ErrorWindows
	if ($windows.Count -and -not $script:errorSeen) {
		$script:errorSeen = $windows -join '; '
		Evidence "an error window appeared: $($script:errorSeen)"
		Save-Screen 'screen-error.png'
	}
}

function Write-Facts([string] $Label) {
	$entry = Get-Entry
	$facts = [ordered]@{
		at = (Get-Date).ToString('o')
		exeVersion = Get-ExeVersion
		uninstallEntry = if ($entry) { $entry | Select-Object DisplayName, DisplayVersion, InstallLocation, UninstallString, QuietUninstallString, DisplayIcon, EstimatedSize } else { $null }
		installFolder = @(Get-ChildItem -LiteralPath $installDir -Force -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
		resources = @(Get-ChildItem -LiteralPath (Join-Path $installDir 'resources') -Force -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
		backupFolderExists = (Test-Path -LiteralPath "$installDir.move-backup")
		programsFolder = @(Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'Programs') -Force -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
		shortcuts = @(Get-Shortcuts)
		appStarted = Read-Json (Join-Path $userData 'app-started.json')
		startFailed = Read-Json (Join-Path $userData 'update-start-failed.json')
		userDataTop = @(Get-ChildItem -LiteralPath $userData -Force -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
		webView2Runtime = Get-WebView2
	}
	$facts | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $Out "facts-$Label.json")
	$facts
}

# What the candidate setup carries, before anything is installed: its embedded app archive's file names.
function Show-Package {
	$seven = (Get-Command 7z -ErrorAction SilentlyContinue)?.Source
	if (-not $seven) { $seven = 'C:\Program Files\7-Zip\7z.exe' }
	if (-not (Test-Path -LiteralPath $seven)) { Evidence 'package listing skipped: 7z is not on the runner'; return }
	$tmp = Join-Path $env:TEMP 'win-update-real-package'
	Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
	& $seven e -y -r "-o$tmp" $NewSetup '*app-64.7z' | Out-Null
	$archive = Get-ChildItem -LiteralPath $tmp -Filter 'app-64.7z' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
	if (-not $archive) { Evidence 'package listing skipped: no app-64.7z inside the setup'; return }
	$names = @(& $seven l -slt $archive.FullName | Where-Object { $_ -like 'Path = *' } | ForEach-Object { $_.Substring(7) })
	Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
	Set-Content -LiteralPath (Join-Path $Out 'package-files.txt') -Value $names
	foreach ($file in 'OMPdesk.exe', 'libcef.dll', 'resources\node\node.exe', 'resources\app\out\main\index.js', 'resources\app\out\preload\tauri.js', 'resources\app\out\renderer\index.html', 'resources\app.asar') {
		Evidence "the candidate package holds ${file}: $($names -contains $file)"
	}
}

# ---- the runner, and the candidate ------------------------------------------------------------------------------------
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
Evidence "mode $Mode; old v$OldVersion; candidate v$NewVersion ($((Get-Item -LiteralPath $NewSetup).Length) bytes)"
Evidence "runner: $([Environment]::OSVersion.VersionString); elevated $($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)); session '$env:SESSIONNAME'; explorer.exe processes $(@(Get-Process explorer -ErrorAction SilentlyContinue).Count); WebView2 runtime $(Get-WebView2)"
Show-Package
# The runner image sets HKLM ...\Windows Error Reporting DontShowUI=1, so a crash never shows a window here; a person's
# Windows does not have it. The throwaway VM gets the default back, so a crash shows what it would show them.
$werKey = 'HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting'
Evidence "WER DontShowUI before: $((Get-ItemProperty -LiteralPath $werKey -ErrorAction SilentlyContinue).DontShowUI)"
Remove-ItemProperty -LiteralPath $werKey -Name DontShowUI -ErrorAction SilentlyContinue
Evidence "WER DontShowUI now: $((Get-ItemProperty -LiteralPath $werKey -ErrorAction SilentlyContinue).DontShowUI) (unset is the Windows default)"

Check (-not (Test-Path -LiteralPath $installDir) -and -not (Get-Entry)) 'the runner starts without an OMPdesk install'

# ---- v0.131.0, as published ---------------------------------------------------------------------------------------------
$old = Start-Process -FilePath $OldSetup -ArgumentList '/S' -Wait -PassThru
Evidence "v$OldVersion setup /S exit code $($old.ExitCode)"
$entry = Get-Entry
Check ($old.ExitCode -eq 0 -and (Test-Path -LiteralPath $exe)) "v$OldVersion is installed in $installDir"
Check ($entry -and $entry.DisplayVersion -eq $OldVersion) "the uninstall entry says $OldVersion"
$oldVersionInfo = Get-ExeVersion
Evidence "installed exe version $($oldVersionInfo | ConvertTo-Json -Compress)"
$fileVersionTracks = [bool]($oldVersionInfo -and ($oldVersionInfo.file -like "$OldVersion*" -or $oldVersionInfo.product -like "$OldVersion*"))
Write-Facts 'before' | Out-Null

New-Item -ItemType Directory -Force -Path $userData | Out-Null
Set-Content -LiteralPath $canary -Value 'userData before the update'

$noOmp = Join-Path $env:TEMP 'no-omp.cmd'
$noInstall = Join-Path $env:SystemRoot 'System32\whoami.exe'
function Start-Old([string[]] $Arguments) {
	# Headless: no window, no omp:// registration. No omp and no machine setup installs on the runner.
	$env:OMP_GUI_HEADLESS = '1'
	$env:OMP_GUI_OMP = $noOmp
	$env:OMP_GUI_TEST_INSTALLER = $noInstall
	try {
		if ($Arguments) { Start-Process -FilePath $exe -ArgumentList $Arguments -PassThru } else { Start-Process -FilePath $exe -PassThru }
	} finally {
		Remove-Item Env:OMP_GUI_HEADLESS, Env:OMP_GUI_OMP, Env:OMP_GUI_TEST_INSTALLER -ErrorAction SilentlyContinue
	}
}

$t0 = Get-Date
$setup = $null
$setupExit = $null
$feed = $null

if ($Mode -eq 'installer') {
	# The app writes its userData once (the start mark of v0.131.0 itself), then goes: its updater is not what runs here.
	$first = Start-Old @()
	$mark = $null
	for ($i = 0; $i -lt 45 -and $mark.version -ne $OldVersion; $i++) { Start-Sleep -Seconds 2; $mark = Read-Json (Join-Path $userData 'app-started.json') }
	Check ($mark.version -eq $OldVersion) "v$OldVersion started once and wrote app-started.json"
	Stop-Installed
	Start-Sleep -Seconds 3

	$pending = Join-Path $env:LOCALAPPDATA 'ompdesk-updater\pending'
	New-Item -ItemType Directory -Force -Path $pending | Out-Null
	$package = Join-Path $pending 'ompdesk-windows-setup.exe'
	Copy-Item -LiteralPath $NewSetup -Destination $package -Force
	$updaterArgs = @('--updated', '--force-run', "--package-file=$package")
	Evidence "setup command: $package $($updaterArgs -join ' ')"
	Add-Snapshot 'before'
	$t0 = Get-Date
	$setup = Start-Process -FilePath $package -ArgumentList $updaterArgs -PassThru
	$null = $setup.Handle
	$deadline = (Get-Date).AddMinutes(10)
	while (-not $setup.HasExited -and (Get-Date) -lt $deadline) { Add-Snapshot 'setup running'; Watch-ErrorWindows; Start-Sleep -Seconds 3 }
	if (-not $setup.HasExited) { Say 'FAILED the setup was still running after 10 minutes'; $script:failures += 'the setup finished in 10 minutes'; Stop-Process -Id $setup.Id -Force -ErrorAction SilentlyContinue }
	else { $setupExit = $setup.ExitCode }
	Evidence "setup exit code $setupExit after $([int]((Get-Date) - $t0).TotalSeconds) s"
}
else {
	Add-Snapshot 'before'
	if ($FeedScript) {
		$env:PATH = "$env:PATH;C:\Program Files\Git\usr\bin"
		$certDir = Join-Path $env:TEMP 'win-update-real-cert'
		$feed = Start-Process -FilePath bun -ArgumentList @($FeedScript, '--setup', $NewSetup, '--version', $NewVersion, '--cert-dir', $certDir, '--port', "$FeedPort") -PassThru -RedirectStandardOutput (Join-Path $Out 'feed.log') -RedirectStandardError (Join-Path $Out 'feed.err')
		for ($i = 0; $i -lt 30 -and -not (Test-Log (Join-Path $Out 'feed.log') '"listening"'); $i++) { Start-Sleep -Seconds 1 }
		Check (Test-Log (Join-Path $Out 'feed.log') '"listening"') 'the stand-in feed listens'
		$t0 = Get-Date
		# Start-Process joins -ArgumentList with spaces and quotes nothing: the rule's spaces would split it into three
		# arguments (run 44005704911: the check reached GitHub, the stand-in saw no request), so it goes as one quoted string.
		$null = Start-Old @("`"--host-resolver-rules=MAP api.github.com 127.0.0.1:$FeedPort`"", '--ignore-certificate-errors')
		Evidence "v$OldVersion launched with its real updater against the stand-in feed offering v$NewVersion"
	} else {
		$t0 = Get-Date
		$null = Start-Old @()
		Evidence "v$OldVersion launched with its real updater against GitHub's real feed, whose latest release must be v$NewVersion"
	}
	# The app's updater checks, downloads, counts down, starts the setup and quits; the setup then runs on its own.
	$seen = $false
	$setupProc = $null
	$deadline = (Get-Date).AddMinutes(25)
	$tick = 0
	while ((Get-Date) -lt $deadline) {
		$running = @(Get-Process -Name 'ompdesk-windows-setup' -ErrorAction SilentlyContinue)
		if ($running.Count) {
			$seen = $true
			# A handle opened while it runs keeps the exit code readable after it ends (the updater started it, not this script).
			if (-not $setupProc) { $setupProc = $running[0]; $null = $setupProc.Handle }
		} elseif ($seen) { break }
		if ($seen -or $tick % 5 -eq 0) { Add-Snapshot $(if ($seen) { 'setup running' } else { 'waiting for the updater' }) }
		if ($seen) { Watch-ErrorWindows }
		$tick++
		Start-Sleep -Seconds 3
	}
	Check $seen "v$OldVersion's own updater started the setup within 25 minutes"
	Evidence "the setup ran from second $([int]((Get-Date) - $t0).TotalSeconds) of the wait"
	if ($setupProc -and $setupProc.HasExited) { $setupExit = $setupProc.ExitCode }
	Evidence "setup exit code $setupExit (started by v$OldVersion's updater, which does not read it)"
}

# ---- whether a crash of the setup shows the person anything ---------------------------------------------------------------
Start-Sleep -Seconds 5
Watch-ErrorWindows
$errorWindows = Get-ErrorWindows
Evidence "error windows on screen now: $(if ($errorWindows.Count) { $errorWindows -join '; ' } else { 'none' }); seen while the setup ran: $(if ($script:errorSeen) { $script:errorSeen } else { 'none' })"
Check (-not $script:errorSeen -and $errorWindows.Count -eq 0) 'no Windows error window appeared during or after the update'
Evidence "WerFault processes: $(@(Get-Process -Name WerFault, WerFaultSecure -ErrorAction SilentlyContinue | ForEach-Object { "$($_.ProcessName) pid $($_.Id) window '$($_.MainWindowTitle)'" }) -join '; ')"
Evidence "interactive desktop: session $((Get-Process -Id $PID).SessionId), explorer $(@(Get-Process explorer -ErrorAction SilentlyContinue).Count)"
foreach ($key in 'HKCU:\Software\Microsoft\Windows\Windows Error Reporting', 'HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting') {
	$wer = Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue
	Evidence "WER setting ${key}: DontShowUI=$($wer.DontShowUI) Disabled=$($wer.Disabled) DontSendAdditionalData=$($wer.DontSendAdditionalData)"
}
$werOut = Join-Path $Out 'wer'
New-Item -ItemType Directory -Force -Path $werOut | Out-Null
$werReports = @(foreach ($root in "$env:LOCALAPPDATA\Microsoft\Windows\WER", "$env:ProgramData\Microsoft\Windows\WER") {
		foreach ($kind in 'ReportArchive', 'ReportQueue') {
			Get-ChildItem -LiteralPath (Join-Path $root $kind) -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'ompdesk|OMPdesk' }
		}
	})
foreach ($report in $werReports) {
	Copy-Item -LiteralPath (Join-Path $report.FullName 'Report.wer') -Destination (Join-Path $werOut "$($report.Parent.Name)-$($report.Name).wer") -ErrorAction SilentlyContinue
}
Evidence "WER reports: $(if ($werReports.Count) { ($werReports | ForEach-Object { "$($_.Parent.Name)\$($_.Name)" }) -join '; ' } else { 'none' })"
$crashEvents = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = $t0; Id = 1000, 1001 } -ErrorAction SilentlyContinue |
		Where-Object { $_.Message -match 'ompdesk-windows-setup' })
$crashEvents | Select-Object TimeCreated, ProviderName, Id, Message | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $werOut 'events-1000-1001.json')
Evidence "setup crash events: 1000 x$(@($crashEvents | Where-Object Id -eq 1000).Count), 1001 x$(@($crashEvents | Where-Object Id -eq 1001).Count)"
Save-Screen 'screen-after.png'

# ---- what the person would see -------------------------------------------------------------------------------------------
# A setup that succeeded waited for app-started.json itself, so this is only a grace for the old app's restore path.
$mark = $null
for ($i = 0; $i -lt 30 -and $mark.version -ne $NewVersion; $i++) { Start-Sleep -Seconds 2; $mark = Read-Json (Join-Path $userData 'app-started.json') }
if ($Mode -eq 'feed') {
	$updateLog = Join-Path $userData 'logs\gui-runtime.jsonl'
	for ($i = 0; $i -lt 30 -and -not (Test-Log $updateLog '"event":"result"'); $i++) { Start-Sleep -Seconds 2 }
}
Add-Snapshot 'after'
Start-Sleep -Seconds 5
Add-Snapshot 'after +5 s'

Write-Facts 'after' | Out-Null
$entry = Get-Entry
$setupText = if (Test-Path -LiteralPath $setupLog) { Get-Content -Raw -LiteralPath $setupLog } else { '' }
$runningApp = @(Get-Snapshot | Where-Object { $_.name -eq 'OMPdesk.exe' -and $_.path -like "$installDir*" })
$runningNode = @(Get-Snapshot | Where-Object { $_.name -eq 'node.exe' -and $_.path -like "$installDir*" })
$runningWebView = @(Get-Snapshot | Where-Object { $_.name -eq 'msedgewebview2.exe' })
Evidence "after: OMPdesk.exe processes $($runningApp.Count), node.exe from the install $($runningNode.Count), msedgewebview2.exe $($runningWebView.Count)"
Evidence "after: uninstall entry $($entry.DisplayVersion), exe $((Get-ExeVersion) | ConvertTo-Json -Compress), shortcuts $((Get-Shortcuts) | ConvertTo-Json -Compress -Depth 3)"
Evidence "after: app-started.json $((Get-Content -Raw -LiteralPath (Join-Path $userData 'app-started.json') -ErrorAction SilentlyContinue))"
Evidence "after: setup log: $($setupText.Trim() -replace '\s*\r?\n\s*', ' | ')"

Check ($entry -and $entry.DisplayVersion -eq $NewVersion) "the uninstall entry says $NewVersion (Settings > Apps)"
$newVersionInfo = Get-ExeVersion
if ($fileVersionTracks) {
	Check ($newVersionInfo -and ($newVersionInfo.file -like "$NewVersion*" -or $newVersionInfo.product -like "$NewVersion*")) "OMPdesk.exe's file version is $NewVersion"
} else { Evidence "OMPdesk.exe's file version did not track the app version in v$OldVersion; not asserted" }
Check ($mark.version -eq $NewVersion) "app-started.json names $NewVersion (the new app's first page loaded)"
Check ($setupText -notmatch 'incomplete|start-failed|putting the old app back') 'the setup log has no incomplete, start-failed or rollback line'
Check (-not (Test-Path -LiteralPath (Join-Path $userData 'update-start-failed.json'))) 'no update-start-failed.json'
Check (-not (Test-Path -LiteralPath "$installDir.move-backup")) 'no .move-backup folder is left beside the install'
Check (Test-Path -LiteralPath $canary) 'userData is kept (the canary file written before the update is there)'
Check ($runningApp.Count -gt 0) 'OMPdesk.exe of the install is running after the update'
if ($Mode -eq 'installer') { Check ($setupExit -eq 0) 'the setup exited 0' }
else {
	$rows = @(Get-Content -LiteralPath (Join-Path $userData 'logs\gui-runtime.jsonl') -ErrorAction SilentlyContinue | ForEach-Object { try { $_ | ConvertFrom-Json } catch { $null } } | Where-Object { $_.source -eq 'app-update' })
	$events = @($rows | ForEach-Object { "$($_.message) $($_.details.event)".Trim() })
	foreach ($wanted in 'check found', 'download verified', 'swap helper', 'swap result') { Check ($events -contains $wanted) "the update log has `"$wanted`"" }
	$result = $rows | Where-Object { $_.message -eq 'swap' -and $_.details.event -eq 'result' } | Select-Object -Last 1
	Check ($result.details.outcome -eq 'installed') "the new app logged swap result outcome installed (got '$($result.details.outcome)')"
	Check (-not ($rows | Where-Object { $_.details.outcome -eq 'rolled back' })) 'no `swap result` says rolled back'
}

# ---- everything the run left ---------------------------------------------------------------------------------------------
Save-Text $setupLog 'ompdesk-setup.log'
Save-Text (Join-Path $userData 'update-start-failed.json') 'update-start-failed.json'
Save-Text (Join-Path $userData 'app-started.json') 'app-started.json'
Save-Text (Join-Path $userData 'update-install.json') 'update-install.json'
Save-Text (Join-Path $userData 'tauri-shell.jsonl') 'tauri-shell.jsonl' 4000
Save-Text (Join-Path $userData 'tauri-local-storage-import.json') 'tauri-local-storage-import.json'
Save-Text (Join-Path $userData 'logs\gui-runtime.jsonl') 'gui-runtime.jsonl' 4000
if ($feed) { Save-Text (Join-Path $Out 'feed.log') 'feed-requests.log' }
Get-ChildItem -LiteralPath $userData -Recurse -Depth 2 -Force -ErrorAction SilentlyContinue | Select-Object -First 400 -ExpandProperty FullName |
	Set-Content -LiteralPath (Join-Path $Out 'userdata-tree.txt')
try {
	Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = $t0; Level = 1, 2, 3 } -ErrorAction Stop |
		Where-Object { $_.Message -match 'OMPdesk|msedgewebview2|node\.exe|ompdesk' } | Select-Object -First 30 TimeCreated, ProviderName, Id, Message |
		ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $Out 'application-events.json')
} catch { Say "note: no Application-log errors for the apps ($($_.Exception.Message))" }

Stop-Installed
if ($feed -and -not $feed.HasExited) { Stop-Process -Id $feed.Id -Force -ErrorAction SilentlyContinue }
if ($script:failures.Count) { Say "RESULT: FAILED ($($script:failures.Count)): $($script:failures -join '; ')"; exit 1 }
Say 'RESULT: ok'
