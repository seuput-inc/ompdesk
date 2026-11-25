#!/bin/bash
# move-mac.sh: the whole update move on macOS, from the selected released Electron app into the real shell bundle, on a
# throwaway GitHub macOS runner only (shell-batch-checks.yml, macos-15 and macos-26).
# run-move.ts. Nothing here runs on a person's Mac: it re-signs apps, makes keychains, sets launchd variables and opens apps.
#  - the released app is copied out of its DMG into a temp "Applications" folder and re-signed with a throwaway certificate and
#    the release's form of designated requirement (resign-mac.sh), so its keychain item is a release-signed one;
#  - its profile is a temp --user-data-dir; HOME stays the runner's (the keychain is the job's own default keychain, never a
#    test HOME, whose keychain would add a partition entry); the app is NOT headless: OMP_GUI_HEADLESS makes the released app use a
#    mock keychain, which would skip the very keychain path under test (windows show on the throwaway runner);
#  - its updater, unchanged, reaches feed.ts (--platform mac, GitHub's 302 to the storage host for `signedAssetUrl`) through
#    Chromium's own switches, and is offered ompdesk-mac-arm64.dmg built by scripts/package-mac.ts, signed with the same
#    certificate, as 0.200.0.
#  S1 the move: check found, download verified (stageBundleFromDmg: codesign --verify --deep --strict, bundle id, version),
#     scheduler safe, countdown, install auto, swap helper, swap.log installed, the shell started with Electron's argv, Local
#     Storage imported, the page loaded, the seeded token decrypted, no SecurityAgent/coreauthd line.
#  S3 a new shell that does not start (OMP_GUI_TEST_SHELL_FAIL_START=1 in the relaunch's launchd environment): v0.127.0's swap
#     script installs it and deletes `.previous`, so the shell bundle's launcher, which sees no page within the window
#     (OMPDESK_LAUNCHER_START_WAIT_S), downloads the last Electron release from the stand-in (OMPDESK_LAUNCHER_RELEASE_URL: the
#     pinned final Electron app re-signed stands in for it), swaps it back and opens it; swap.log reports it and Electron says
#     `swap result … rolled back`; no dialog.
#  S2 a failed move: the apps folder is made read-only before the countdown ends; the swap fails (copy failed), Electron is
#     untouched, and the next launch of the released app logs `swap result outcome rolled back`.
# OMP_MOVE_RELEASED_TAG selects v0.127.0, v0.128.0 or the pinned final Electron release (the default). Releases from v0.128.0 keep
# `<app>.previous` until the new app writes app-started.json for the offered version: S1 then says `started`, and S4
# (the new shell does not start) has the script restore `.previous` (`start failed; previous app restored`) and reopen
# the old app, which logs `swap result … rolled back`; the launcher only notes that the swap restores.
# OMP_MOVE_REAL_FEED=<tag> (shell-batch-checks.yml only=release-verify, release-update-mac): the same S1 move against GitHub's REAL
# feed. Nothing is built, nothing is re-signed (the released app keeps its own signature, so the keychain item it makes trusts
# the requirement the published <tag> carries) and no stand-in feed or host-resolver mapping is in the update run: the released
# updater reads api.github.com's /releases/latest, downloads the published DMG, verifies it, swaps, and the published Tauri app
# starts on the seeded profile. A published app has no page to ask (no WebDriver, no inspector), so what it kept is read from
# disk (real_retention_checks) and its window is photographed with screencapture. S4 (a new shell that does not start) needs a broken DMG and is skipped.
# Evidence lines start with "EVIDENCE:". Exit 1 on any failed check.
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../.." && pwd)
. "$HERE/mac-common.sh"
. "$HERE/mac-processes.sh"
SHOTS=${RUNNER_TEMP:-/tmp}/move-shots; mkdir -p "$SHOTS"   # the job uploads this folder (shell-batch-checks.yml)
SEED_TITLE='이사 검사 대화 ✓ (Electron에서 만듦)'; SEED_ID=move-seed-conversation; SEED_LANGUAGE=Japanese; SEED_ASSISTANT='업데이트 뒤에도 이 대화가 남아야 합니다.'
PORT=19230; FEEDPORT=18444; HTTPPORT=18445; SEEDPORT=18446
NATIVEPORT=19231
MOVE_ENGINE=${OMPDESK_SHELL_ENGINE:-tauri}
case "$MOVE_ENGINE" in tauri|cef) ;; *) echo "unsupported move engine: $MOVE_ENGINE"; exit 1 ;; esac
PACKAGE_ARGS=()
[ "$MOVE_ENGINE" = cef ] && PACKAGE_ARGS=(--historical-cef)
# OMP_MOVE_REAL_FEED=<tag> runs the update against GitHub's real feed (see real_prepare below); it needs OMP_MOVE_API_TOKEN, the
# job's token, which the released app stores as its seeded update token (a name the app itself does not read, so the
# stored token stays the source) and the checks read the release with.
REAL_TAG=${OMP_MOVE_REAL_FEED:-}; REAL_VERSION=${REAL_TAG#v}; REAL_TOKEN=${OMP_MOVE_API_TOKEN:-}
DOWNLOAD_WAIT_S=240; EXPECT_SHA512=; EXPECT_SIZE=
if [ -n "$REAL_TAG" ]; then
  [[ "$REAL_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "OMP_MOVE_REAL_FEED must be a release tag (vX.Y.Z), got: $REAL_TAG"; exit 1; }
  [ "$MOVE_ENGINE" = tauri ] || { echo "OMP_MOVE_REAL_FEED moves into the published Tauri app: OMPDESK_SHELL_ENGINE must be tauri"; exit 1; }
  [ -n "$REAL_TOKEN" ] || { echo "OMP_MOVE_REAL_FEED needs OMP_MOVE_API_TOKEN: a stand-in token is answered 401 by the real API and dropped by the updater"; exit 1; }
  DOWNLOAD_WAIT_S=900
fi
native_environment() {
  # A published app honours neither (no WebDriver server, no inspector: scripts/tauri-release-automation-check.ts).
  { [ "$MOVE_ENGINE" = tauri ] && [ -z "$REAL_TAG" ]; } || return 0
  launchctl setenv OMP_GUI_TEST_NODE_INSPECT 1
  launchctl setenv OMP_GUI_TEST_WEBDRIVER_PORT "$NATIVEPORT"
}
new_profile() {
  if [ "$MOVE_ENGINE" = tauri ]; then
    (cd "$REPO" && limit 120 bun scripts/shell-move/native-profile.ts "$NATIVEPORT" "${1:-read}")
  else
    (cd "$REPO" && limit 120 bun scripts/shell-move/cdp-seed-mac.ts "$PORT" "${1:-read}")
  fi
}
# Screenshots, each asserted on the page before it is taken (seed-state.ts takeSeedShots): $1 number ("01"), $2 file label,
# $3 old|new. Three files: <n>-<label> (the seeded conversation open: title in its sidebar row, both messages in the transcript),
# <n>b-<label>-settings-reply-language (Settings > General shows the seeded reply language), <n>c-<label>-settings-update-token
# (Settings > Updates shows the stored GitHub token row). A failed assertion leaves <file>.failed.png and fails the check.
shots() {
  local n=$1 label=$2 files=("$SHOTS/$1-$2.png" "$SHOTS/$1b-$2-settings-reply-language.png" "$SHOTS/$1c-$2-settings-update-token.png") rc
  if [ "$3" = new ]; then (cd "$REPO" && limit 240 bun scripts/shell-move/native-profile.ts "$NATIVEPORT" shots "${files[@]}"); rc=$?
  else (cd "$REPO" && limit 240 bun scripts/shell-move/cdp-seed-mac.ts "$PORT" shots "${files[@]}"); rc=$?; fi
  check $rc "screenshots $n, ${n}b, ${n}c ($label): conversation open, reply language $SEED_LANGUAGE in Settings, stored update token in Settings"
}
# Best effort: the relaunched old app after a rollback; a file is saved whatever its page shows.
shot_old() { (cd "$REPO" && limit 90 bun scripts/shell-move/cdp-seed-mac.ts "$PORT" shot "$SHOTS/$1"); evidence "screenshot $1: exit $?"; }
LAST_ELECTRON_TAG=$(jq -er .tag "$REPO/native/ompdesk/crates/shell/last-electron.json") || exit 1
SOURCE_TAG=${OMP_MOVE_RELEASED_TAG:-$LAST_ELECTRON_TAG}
case "$SOURCE_TAG" in v0.127.0|v0.128.0|"$LAST_ELECTRON_TAG") ;; *) echo "unsupported released tag: $SOURCE_TAG"; exit 1 ;; esac
cleanup() { for v in OMP_GUI_OMP OMP_GUI_TEST_USER_DATA_DIR OMP_GUI_TEST_NODE_INSPECT OMP_GUI_TEST_WEBDRIVER_PORT OMP_GUI_TEST_SHELL_FAIL_START OMPDESK_LAUNCHER_RELEASE_URL OMPDESK_LAUNCHER_START_WAIT_S; do launchctl unsetenv $v; done; chmod -R u+w "$W" 2>/dev/null; kill "${WATCH:-}" "${FEED:-}" "${FAKE_OMP_HOLDER:-}" 2>/dev/null; }
trap cleanup EXIT
stop_or_exit() { stop_app "$@" || { check 1 "app processes did not exit"; restore; exit 1; }; }


step "control: a prompt-free keychain read"
control_chatter

stand_in_candidate() {
  step "the new shell bundle and its DMG (scripts/package-mac.ts, signed with the throwaway identity)"
  (cd "$REPO" && bun scripts/package-mac.ts ${PACKAGE_ARGS[@]+"${PACKAGE_ARGS[@]}"} --version 0.200.0 --sign-with "$ID" --keychain "$KC0"); check $? "package-mac built the signed bundle and the DMG"
  DMG=$(ls "$REPO"/dist/ompdesk-0.200.0-arm64.dmg 2>/dev/null | head -1); test -f "$DMG"; check $? "dist/ompdesk-0.200.0-arm64.dmg exists ($(stat -f %z "$DMG" 2>/dev/null) bytes)"
  cp "$DMG" "$W/new.dmg"
}
[ -n "$REAL_TAG" ] || stand_in_candidate

# The released app is downloaded as shipped; the stand-in feed's run re-signs it with the throwaway certificate, the real feed's does not.
download_app() {
  local tag=$1 destination=$2 mount="$W/mnt-$1"
  curl -fsSL -o "$W/$tag.dmg" "https://github.com/seuput-inc/ompdesk/releases/download/$tag/ompdesk-mac-arm64.dmg" || return 1
  mkdir -p "$mount"
  hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$mount" "$W/$tag.dmg" >/dev/null || return 1
  ditto "$mount/OMPdesk.app" "$destination"; local copied=$?
  hdiutil detach "$mount" >/dev/null || return 1
  return "$copied"
}
step "the released app $SOURCE_TAG"
download_app "$SOURCE_TAG" "$W/rel.app" || exit 1
OLD_VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' rel.app/Contents/Info.plist)
[ "$OLD_VERSION" = "${SOURCE_TAG#v}" ] || exit 1
evidence "the app that updates: the real $SOURCE_TAG DMG ($OLD_VERSION)"
# What the stand-in feed's run needs besides the released app: re-signed apps, the candidate bundle, the rollback DMG, the stand-in feed.
stand_in_prepare() {
bash "$HERE/resign-mac.sh" rel.app "$KC0" "$ID" | tail -1
evidence "released app requirement: $(codesign -d -r- rel.app 2>&1 | sed -n 's/^designated => //p')"
# Compare the actual user relaunch (`open -n` from the released swap script), with no Gatekeeper rule: the re-signed
# Electron and the shell must both start, without quarantine. A rejected `spctl --assess` alone does not prove launch refusal.
open_probe() {
  local app=$1 label=$2 ud
  ud=$W/probe-$label
  mkdir -p "$ud"
  evidence "probe $label: spctl --status: $(spctl --status 2>&1 | tr '\n' ' ')"
  evidence "probe $label: quarantine on the bundle: $(xattr -l "$app" 2>&1 | tr '\n' '|') ; on nested executables: $(find "$app" -type f -perm +111 -exec xattr -l {} + 2>/dev/null | grep -c quarantine) with the attribute"
  evidence "probe $label: spctl --assess: $(spctl --assess -vv --type execute "$app" 2>&1 | tr '\n' ' ')"
  local t0; t0=$(date '+%Y-%m-%d %H:%M:%S')
  launchctl setenv OMP_GUI_TEST_USER_DATA_DIR "$ud"
  native_environment
  open -n "$app" --args --user-data-dir="$ud" --remote-debugging-port=$PORT --host-resolver-rules="MAP api.github.com 127.0.0.1:1" >"$W/probe-$label.out" 2>&1; local rc=$?
  sleep 25
  local running; running=$(ps -axo command | grep "$app/Contents/MacOS/" | grep -v grep | head -1 | cut -c1-140)
  evidence "probe $label: open -n exit $rc, output: $(head -c 300 "$W/probe-$label.out" | tr '\n' '|'); running afterwards: ${running:-nothing}"
  log show --start "$t0" --predicate 'process == "syspolicyd" OR subsystem == "com.apple.launchservices"' --style compact 2>/dev/null | grep -i 'ompdesk\|reject\|denied\|not allowed\|assess' | tail -12 | cut -c1-260 | sed "s/^/EVIDENCE: probe $label log: /"
  stop_or_exit "$app"; launchctl unsetenv OMP_GUI_TEST_USER_DATA_DIR
  [ -n "$running" ]
}
mkdir -p "$W/probe-apps"
use_keychain probe
ditto rel.app "$W/probe-apps/electron.app"; ditto "$REPO/dist/mac-arm64/OMPdesk.app" "$W/probe-apps/shell.app"
open_probe "$W/probe-apps/electron.app" electron; ELECTRON_OPENS=$?
open_probe "$W/probe-apps/shell.app" shell; SHELL_OPENS=$?
restore
check "$ELECTRON_OPENS" "the re-signed released Electron opens through \`open -n\` without any spctl rule"
check "$SHELL_OPENS" "the shell bundle opens through \`open -n\` without any spctl rule"
evidence "the released SWAP_SCRIPT relaunches with open -n: $(grep -a -o 'open -n "$dest"[^;]*' rel.app/Contents/Resources/app.asar 2>/dev/null | head -1 | cut -c1-80)"
# The launcher's baked tag selects the last Electron release, also when the user skips release 1 and starts at v0.127.0.
if [ "$SOURCE_TAG" = "$LAST_ELECTRON_TAG" ]; then
  ditto rel.app "$W/rollback.app"
else
  download_app "$LAST_ELECTRON_TAG" "$W/rollback.app" || exit 1
  bash "$HERE/resign-mac.sh" "$W/rollback.app" "$KC0" "$ID" | tail -1
fi
ROLLBACK_VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$W/rollback.app/Contents/Info.plist")
[ "$ROLLBACK_VERSION" = "${LAST_ELECTRON_TAG#v}" ] || exit 1
# `-srcfolder` copies contents; its source folder must hold the app, not be the app.
mkdir "$W/dmgsrc" && ditto "$W/rollback.app" "$W/dmgsrc/OMPdesk.app"
hdiutil create -volname OMPdesk -srcfolder "$W/dmgsrc" -fs HFS+ -ov -format UDZO "$W/rollback.dmg" 2>&1 | tail -3 | sed 's/^/EVIDENCE: hdiutil: /'
test -s "$W/rollback.dmg"; check $? "the re-signed last Electron release $LAST_ELECTRON_TAG is in a DMG ($(stat -f %z "$W/rollback.dmg" 2>/dev/null) bytes)"
test -s "$W/rollback.dmg" || exit 1
start_feed $FEEDPORT "$W/new.dmg" --rollback-dmg "$W/rollback.dmg" --rollback-tag "$LAST_ELECTRON_TAG" --http-port $HTTPPORT --seed-port $SEEDPORT
curl -s "http://127.0.0.1:$HTTPPORT/repos/SeuPut0705/ompdesk/releases/tags/$LAST_ELECTRON_TAG" | grep -q ompdesk-update; check $? "the stand-in serves the last Electron release's tag route on :$HTTPPORT"
  check_seed_feed
  SWITCHES=(--host-resolver-rules="MAP api.github.com 127.0.0.1:$FEEDPORT" --ignore-certificate-errors)
}

# OMP_MOVE_REAL_FEED=<tag>: the released app, as shipped (its own signature, nothing re-signed), updates through the REAL
# GitHub feed into the published <tag>. Only the seeding is local: the seed feed validates the token the released app stores
# and offers nothing; it is stopped before the update run, which then has no host-resolver mapping and no certificate switch.
github_api() { curl -fsS -H "Accept: application/vnd.github+json" -H "Authorization: Bearer $REAL_TOKEN" "https://api.github.com/repos/seuput-inc/ompdesk/$1"; }
real_prepare() {
  local pin requirement latest meta
  pin=$(jq -er .certificateSha1 "$REPO/scripts/mac-signing.json") || exit 1
  requirement=$(codesign -d -r- rel.app 2>&1 | sed -n 's/^designated => //p')
  evidence "the released $SOURCE_TAG, as shipped (not re-signed): designated requirement $requirement"
  [ "$requirement" = "identifier \"com.seuput.ompdesk\" and certificate root = H\"$pin\"" ]; check $? "the released $SOURCE_TAG is signed with the pinned certificate (scripts/mac-signing.json, $pin)"
  codesign --verify --deep --strict rel.app; check $? "the released $SOURCE_TAG verifies as shipped"
  latest=$(github_api releases/latest | jq -er .tag_name) || { check 1 "the real feed answers /releases/latest"; exit 1; }
  [ "$latest" = "$REAL_TAG" ] || { check 1 "the real feed's latest release is $REAL_TAG (it is $latest): the $SOURCE_TAG updater would be offered another version"; exit 1; }
  check 0 "the real feed's latest release is $REAL_TAG: the $SOURCE_TAG updater is offered it"
  meta=$(github_api "releases/tags/$REAL_TAG" | jq -r .body | sed -n 's/.*<!-- ompdesk-update \(.*\) -->.*/\1/p')
  [ "$(jq -r .version <<<"$meta")" = "$REAL_VERSION" ]; check $? "the release notes carry the ompdesk-update metadata for $REAL_VERSION"
  EXPECT_SHA512=$(jq -er .files.mac.sha512 <<<"$meta"); EXPECT_SIZE=$(jq -er .files.mac.size <<<"$meta") || exit 1
  evidence "published metadata: mac size $EXPECT_SIZE, sha512 $(echo "$EXPECT_SHA512" | cut -c1-24)..."
  (cd "$REPO" && bun scripts/shell-move/feed.ts --seed-only --cert-dir "$W/cert" --seed-port $SEEDPORT >"$W/feed.log" 2>&1) &
  FEED=$!
  sleep 4
  check_seed_feed
  # The seeded token is the job's own: a stand-in token would be answered 401 by the real API and dropped by the updater.
  export STAND_IN_TOKEN=$REAL_TOKEN
  SWITCHES=()
}
stop_seed_feed() {
  pkill -f 'shell-move/feed.ts' 2>/dev/null; sleep 2
  nc -z 127.0.0.1 $SEEDPORT 2>/dev/null; [ $? != 0 ]; check $? "the seed feed is stopped: nothing local answers for api.github.com during the update run"
}
real_old_app_checks() {
  local argv; argv=$(ps -axo command | grep "$1/OMPdesk.app/Contents/MacOS/OMPdesk" | grep -v grep | head -1)
  evidence "the released app's command line for the update run: $(echo "$argv" | cut -c1-300)"
  case "$argv" in *host-resolver-rules*|*ignore-certificate-errors*) check 1 "the released app runs with no host-resolver mapping and no certificate switch (the real api.github.com)" ;; *) check 0 "the released app runs with no host-resolver mapping and no certificate switch (the real api.github.com)" ;; esac
}
real_downloaded_checks() {
  local ud=$1 bytes verified found staged
  # Relaunch mode: the updater checks the downloaded bytes' SHA-512 against the release's metadata (a mismatch is an error, not a
  # `verified` line), copies the app out of the DMG into updates/<version>/OMPdesk.app and REMOVES the DMG (v0.131.0 updater.ts:
  # startMacDownload). So the DMG is not there to hash; the log and the staged app are what v0.131.0 leaves.
  bytes=$(jq -r 'select(.source == "app-update" and .message == "download" and .details.event == "started") | .details.bytes' "$ud/logs/gui-runtime.jsonl" 2>/dev/null | head -1)
  [ "$bytes" = "$EXPECT_SIZE" ]; check $? "the $SOURCE_TAG updater downloaded the published size (log: $bytes bytes, release notes: $EXPECT_SIZE)"
  verified=$(jq -r 'select(.source == "app-update" and .message == "download" and .details.event == "verified") | .details.bytes' "$ud/logs/gui-runtime.jsonl" 2>/dev/null | head -1)
  [ "$verified" = "$EXPECT_SIZE" ]; check $? "its SHA-512 check of the downloaded bytes against the release notes' metadata passed (log: download verified, $verified bytes)"
  staged=$ud/updates/$REAL_VERSION/OMPdesk.app
  [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$staged/Contents/Info.plist" 2>/dev/null)" = "$REAL_VERSION" ]; check $? "the app it staged from the DMG is OMPdesk $REAL_VERSION (updates/$REAL_VERSION/OMPdesk.app)"
  evidence "the updates folder after the download: $(ls -A "$ud/updates" | tr '\n' ' ')"
  found=$(jq -r 'select(.source == "app-update" and .message == "check" and .details.event == "found") | .details.version' "$ud/logs/gui-runtime.jsonl" 2>/dev/null | head -1)
  [ "$found" = "$REAL_VERSION" ]; check $? "the update log's check found names $REAL_VERSION (found: ${found:-nothing})"
}
real_installed_checks() {
  local app=$1/OMPdesk.app ud=$2 pin requirement minos started
  pin=$(jq -er .certificateSha1 "$REPO/scripts/mac-signing.json") || exit 1
  [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")" = "$REAL_VERSION" ]; check $? "S1: the installed bundle is $REAL_VERSION"
  requirement=$(codesign -d -r- "$app" 2>&1 | sed -n 's/^designated => //p')
  [ "$requirement" = "identifier \"com.seuput.ompdesk\" and certificate root = H\"$pin\"" ]; check $? "S1: the installed $REAL_VERSION keeps the pinned designated requirement (the keychain item Electron made trusts it)"
  minos=$(plutil -extract LSMinimumSystemVersion raw -o - "$app/Contents/Info.plist" 2>/dev/null)
  [[ "$minos" == 14.* ]]; check $? "S1: the installed bundle's LSMinimumSystemVersion is $minos (14)"
  [ "$(jq -r '.engine + " " + .platform' "$app/Contents/Resources/ompdesk-tauri.build.json" 2>/dev/null)" = "tauri darwin" ] && [ ! -e "$app/Contents/Frameworks/Chromium Embedded Framework.framework" ]; check $? "S1: the installed bundle is the Tauri app (build record engine tauri, no CEF)"
  started=$(jq -er .version "$ud/app-started.json" 2>/dev/null)
  [ "$started" = "$REAL_VERSION" ]; check $? "S1: app-started.json names $REAL_VERSION (the published app started on the user's profile)"
}
# A published app has no page to ask: no WebDriver server (scripts/tauri-release-automation-check.ts) and no inspector. What it kept
# is read from what it keeps on disk, as its own main reads it. `<label>` says when ("after the update relaunch", "after a restart").
app_checked() { jq -e --argjson pid "$2" 'select(.pid == $pid and .source == "app-update" and .message == "check" and .details.event == "no-update")' "$1/logs/gui-runtime.jsonl" >/dev/null 2>&1; }
journal_done() { jq -e '.version == 1 and .destination == "app://ompdesk" and .source == "file://" and .state.status == "done"' "$1/tauri-local-storage-import.json" >/dev/null 2>&1; }
started_pid_changed() { local now; now=$(jq -r .pid "$1/app-started.json" 2>/dev/null); [ -n "$now" ] && [ "$now" != "$2" ]; }
started_version_is() { [ "$(jq -r .version "$1/app-started.json" 2>/dev/null)" = "$2" ]; }
real_retention_checks() {
  local app=$1/OMPdesk.app ud=$2 label=$3 verdict pid failures lines file listed rc tries
  wait_for "started_version_is $ud $REAL_VERSION" 180
  pid=$(jq -r .pid "$ud/app-started.json" 2>/dev/null)
  step "S1 ($label): what the published app kept, read from disk (pid ${pid:-unknown})"
  # The stored update token: decrypted offline with the key the host itself returns, never printed.
  verdict=$(cd "$REPO" && limit 90 bun scripts/shell-move/release-token.ts "$app" "$ud" 2>&1 | tail -1)
  evidence "S1 ($label) token against the host's key: $(jq -c . <<<"$verdict" 2>/dev/null || echo "$verdict" | cut -c1-200)"
  [ "$(jq -r .equalsSeeded <<<"$verdict" 2>/dev/null)" = true ]; check $? "S1 ($label): update-token.bin decrypts, with the key \`ompdesk-shell --keychain-key\` answers, to the seeded token"
  if [ "$(jq -r .equalsSeeded <<<"$verdict" 2>/dev/null)" != true ]; then keychain_diag "$1" "$ud"; fi
  [ -f "$ud/update-token.bin" ] && [ ! -e "$ud/update-token.dropped" ]; check $? "S1 ($label): the token file is still in userData and no update-token.dropped marker says it was removed"
  lines=$(jq -r --argjson pid "${pid:-0}" 'select(.pid == $pid) | .source' "$ud/logs/gui-runtime.jsonl" 2>/dev/null | wc -l | tr -d ' ')
  failures=$(jq -r --argjson pid "${pid:-0}" 'select(.pid == $pid and .source == "app-update" and (.details.event == "stored-token-read" or ((.message // "") | startswith("The saved update token")))) | .message' "$ud/logs/gui-runtime.jsonl" 2>/dev/null | wc -l | tr -d ' ')
  [ "${lines:-0}" -gt 0 ] && [ "$failures" = 0 ]; check $? "S1 ($label): the app's runtime log (pid ${pid:-unknown}, $lines lines) holds no stored-token-read failure and no removed-token line ($failures)"
  wait_for "app_checked $ud ${pid:-0}" 180; check $? "S1 ($label): the app's own update check answered (check no-update, pid ${pid:-unknown})"
  # The setting: the prefs file the app reads (electron-store `prefs`, key replyLanguage).
  [ "$(jq -r .replyLanguage "$ud/prefs.json" 2>/dev/null)" = "$SEED_LANGUAGE" ]; check $? "S1 ($label): prefs.json in userData still holds replyLanguage $SEED_LANGUAGE"
  # The conversation: the stock session file under the agent dir the apps list, still whole.
  file=${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}/sessions/move-seed-project/$SEED_ID.jsonl
  [ -f "$file" ] && jq -e --arg id "$SEED_ID" 'select(.type == "session" and .id == $id)' "$file" >/dev/null 2>&1 && grep -qF "$SEED_TITLE" "$file" && grep -qF "$SEED_ASSISTANT" "$file"; check $? "S1 ($label): the seeded conversation file is intact (session header $SEED_ID, both messages)"
  tries=0; rc=1
  while [ "$tries" -lt 6 ]; do
    listed=$(OMPDESK_CONTROL_DIR="$ud/control" limit 60 "$app/Contents/Resources/ompdesk-bin/ompdesk" sessions --scope stored 2>&1); rc=$?
    [ "$rc" = 0 ] && break
    tries=$((tries+1)); sleep 5
  done
  if [ "$rc" = 0 ]; then
    printf '%s\n' "$listed" | grep -qF -e "$SEED_ID" -e "$SEED_TITLE"; check $? "S1 ($label): the running app's session index lists the seeded conversation (ompdesk sessions --scope stored)"
  else
    evidence "S1 ($label): the running app could not be asked for its sessions (ompdesk sessions exit $rc: $(printf '%s' "$listed" | head -c 200 | tr '\n' ' ')); the listing is not asserted, the conversation file above is"
  fi
  # Local Storage lives only in the page's store: it cannot be read offline. The Tauri host moves it from Electron's through a
  # journal (tauri-local-storage-import.json): `done` is written only when the page wrote every exported key and read the count back.
  wait_for "journal_done $ud" 120; check $? "S1 ($label): the Tauri page imported and verified every key of Electron's Local Storage (journal state done, file:// to app://ompdesk)"
  evidence "S1 ($label) Local Storage journal: $(jq -c '{version, destination, source, status: .state.status, pendingKeys: ((.state.items // {}) | keys | length)}' "$ud/tauri-local-storage-import.json" 2>&1 | cut -c1-200)"
}
keychain_diag() {
  local apps=$1 ud=$2 bounded=(perl -e 'alarm 20; exec @ARGV')
  # Which key did the host get: Electron's item, or a second one it made because it found none? Attributes and the host's own
  # non-interactive answer only: reading the item's secret with `security -w` asks for access (the item trusts the app's
  # requirement, not /usr/bin/security) and hung the job until its timeout. Each call is bounded.
  evidence "S1 keychain items: $("${bounded[@]}" security dump-keychain "$KC" 2>/dev/null | grep -B4 -A14 '"ompdesk Safe Storage"' | grep -E '"svce"|"acct"|"cdat"|"mdat"|"labl"' | tr -s ' ' | tr '\n' ' ' | cut -c1-900)"
  evidence "S1 host keychain answer: $("${bounded[@]}" "$apps/OMPdesk.app/Contents/MacOS/ompdesk-shell" --keychain-key "$ud" 2>&1 | tail -1 | sed -E 's/"password":"[^"]*"/"password":"(redacted)"/' | cut -c1-200)"
  evidence "S1 keychain items after that read (svce lines, as the single-item check counts): $("${bounded[@]}" security dump-keychain "$KC" 2>/dev/null | grep -c '"svce"<blob>="ompdesk Safe Storage"')"
  evidence "S1 host signature: $(codesign -d -r- "$apps/OMPdesk.app/Contents/MacOS/ompdesk-shell" 2>&1 | grep -E 'designated|Identifier' | tr '\n' ' ')"
}
# The window as the window server shows it (evidence only: a published app has no page to photograph through; the whole display
# when no window of OMPdesk is listed).
real_shot() {
  local file=$SHOTS/$1 id args=(-x) rc
  id=$(limit 120 swift "$HERE/window-id.swift" 2>/dev/null | tail -1)
  case "$id" in ''|0|*[!0-9]*) id= ;; esac
  [ -z "$id" ] || args=(-x -o -l "$id")
  limit 60 screencapture "${args[@]}" "$file" 2>"$W/screencapture.err"; rc=$?
  evidence "screenshot $1: window ${id:-none (whole display)}, screencapture exit $rc, $(stat -f %z "$file" 2>/dev/null || echo 0) bytes $(head -c 200 "$W/screencapture.err" | tr '\n' ' ')"
}
# A quit and a start again: what the app keeps is read once more, and the new process is the one the log lines are read for.
real_restart_checks() {
  local apps=$1 ud=$2 before
  before=$(jq -r .pid "$ud/app-started.json" 2>/dev/null)
  stop_or_exit "$apps/OMPdesk.app"
  open -n "$apps/OMPdesk.app" --args --user-data-dir="$ud"
  wait_for "started_pid_changed $ud $before" 180; check $? "S1: the published app started again after the quit (a new pid in app-started.json)"
  real_retention_checks "$apps" "$ud" "after a restart"
  real_shot 03-tauri-reopened-retained.png
}

# The seed feed's own answers (a repository probe that succeeds, no release, no asset): seeding must not start a download.
check_seed_feed() {
seed_repo=$(curl -sk -o /dev/null -w '%{http_code}' --resolve "api.github.com:$SEEDPORT:127.0.0.1" "https://api.github.com:$SEEDPORT/repos/SeuPut0705/ompdesk")
seed_latest=$(curl -sk -o /dev/null -w '%{http_code}' --resolve "api.github.com:$SEEDPORT:127.0.0.1" "https://api.github.com:$SEEDPORT/repos/SeuPut0705/ompdesk/releases/latest")
seed_list=$(curl -sk --resolve "api.github.com:$SEEDPORT:127.0.0.1" "https://api.github.com:$SEEDPORT/repos/SeuPut0705/ompdesk/releases")
seed_asset=$(curl -sk -o /dev/null -w '%{http_code}' --resolve "api.github.com:$SEEDPORT:127.0.0.1" "https://api.github.com:$SEEDPORT/repos/SeuPut0705/ompdesk/releases/assets/1")
evidence "seed feed: repository $seed_repo, latest $seed_latest, releases $seed_list, asset $seed_asset"
if [ "$seed_repo" != 200 ] || [ "$seed_latest" != 404 ] || [ "$seed_list" != "[]" ] || [ "$seed_asset" != 404 ]; then
  check 1 "seed feed validates repository access but offers no update or asset"
  exit 1
fi
}
if [ -n "$REAL_TAG" ]; then real_prepare; else stand_in_prepare; fi
update_lines() { jq -r 'select(.source=="app-update") | "\(.message) \(.details.event // "") \(.details.outcome // "") \(.details.mode // "") \(.details.reason // "")"' "$1/logs/gui-runtime.jsonl" 2>/dev/null; }
has_line() { update_lines "$1" | grep -q "^$2"; }
wait_for() { local n=0; while [ $n -lt $2 ]; do eval "$1" && return 0; sleep 3; n=$((n+3)); done; return 1; }

# A working omp for every app of the move. The runner has no omp a stored session's transcript can be read through: the
# apps resolved some Bun omp that exited 1 ("omp unavailable"), so no conversation opened. OMP_GUI_OMP names the e2e suite's fake
# omp (e2e/sidecar-fixture.ts), which serves stored transcripts from the session file as the e2e suite's session tests do. The
# fake lives only while the process that installed it does (fake-omp.ts), so it runs until cleanup. Exported for the apps
# started from this script and set in launchd's environment for the swap script's `open -n` relaunches, as OMP_GUI_TEST_*.
evidence "omp candidates before the fake: $(ls -l "$HOME/.bun/bin/omp" /opt/homebrew/bin/omp /usr/local/bin/omp 2>&1 | cut -c1-160 | tr '\n' '|')"
FAKE_OMP_DIR=$W/fake-omp-home
(cd "$REPO" && exec bun scripts/shell-move/fake-omp.ts "$FAKE_OMP_DIR") >"$W/fake-omp.out" 2>&1 &
FAKE_OMP_HOLDER=$!
wait_for "test -s $FAKE_OMP_DIR/bin.txt" 60; check $? "the fake omp is installed (fake-omp.ts)"
FAKE_OMP=$(cat "$FAKE_OMP_DIR/bin.txt" 2>/dev/null)
if [ ! -x "$FAKE_OMP" ]; then evidence "fake omp output: $(tail -n 8 "$W/fake-omp.out" | cut -c1-200 | tr '\n' '|')"; check 1 "the fake omp is an executable file ($FAKE_OMP)"; exit 1; fi
FAKE_OMP_VERSION=$("$FAKE_OMP" --version 2>&1); check $? "the fake omp answers --version ($FAKE_OMP_VERSION)"
export OMP_GUI_OMP="$FAKE_OMP"

# What the relaunch left when the new shell did not come up: what runs, what the shell wrote, the system's word on the
# process and crash reports; then the same bundle started directly (not through `open`), to tell a broken bundle from a
# broken launch context.
relaunch_diag() {
  local APPS=$1 UD=$2 name=$3
  evidence "diag: processes: $(ps -axo pid,command | grep 'OMPdesk' | grep -v grep | cut -c1-200 | tr '\n' '|')"
  evidence "diag: shell-webview: $(ls "$UD/shell-webview" 2>&1 | tr '\n' ' ')"
  evidence "diag: shell log tail: $(tail -n 8 "$UD/shell-webview/shell.log.jsonl" 2>&1 | cut -c1-200 | tr '\n' '|')"
  evidence "diag: swap.log: $(tr '\n' '|' < "$UD/updates/swap.log" | cut -c1-400)"
  evidence "diag: crash reports: $(ls -t ~/Library/Logs/DiagnosticReports 2>/dev/null | grep -i ompdesk | head -3 | tr '\n' ' ')"
  for r in $(ls -t ~/Library/Logs/DiagnosticReports/*OMPdesk* 2>/dev/null | head -1); do head -c 1800 "$r" | sed 's/^/EVIDENCE: diag crash: /'; done
  log show --last 6m --predicate 'process == "OMPdesk" OR process == "launchservicesd" AND eventMessage CONTAINS "OMPdesk"' --style compact 2>/dev/null | tail -25 | cut -c1-260 | sed 's/^/EVIDENCE: diag log: /'
  evidence "diag: spctl: $(spctl --assess --type execute -vv "$APPS/OMPdesk.app" 2>&1 | tr '\n' '|' | cut -c1-300)"
  evidence "diag: quarantine: $(xattr -l "$APPS/OMPdesk.app" 2>&1 | head -3 | tr '\n' '|')"
  # The relaunch as the swap script does it, by hand: its exit code and what the system says about the launch.
  open -n "$APPS/OMPdesk.app" --args --user-data-dir="$UD" --remote-debugging-port=$PORT "${SWITCHES[@]}" >"$W/$name-open.out" 2>&1; local rc=$?
  sleep 20
  evidence "diag: open -n exit $rc: $(head -c 400 "$W/$name-open.out" | tr '\n' '|'); running afterwards: $(ps -axo command | grep "$APPS/OMPdesk.app/Contents/MacOS/OMPdesk" | grep -v grep | head -1 | cut -c1-120)"
  log show --last 2m --predicate 'process == "syspolicyd" OR process == "amfid" OR process == "launchservicesd" OR process == "runningboardd"' --style compact 2>/dev/null | grep -i 'ompdesk\|reject\|deny\|kill' | tail -12 | cut -c1-260 | sed 's/^/EVIDENCE: diag system: /'
  stop_or_exit "$APPS/OMPdesk.app"
  OMP_GUI_TEST_USER_DATA_DIR=$UD "$APPS/OMPdesk.app/Contents/MacOS/OMPdesk" --user-data-dir="$UD" --remote-debugging-port=$PORT "${SWITCHES[@]}" >"$W/$name-direct.out" 2>&1 &
  sleep 25
  evidence "diag: started directly: $(ps -axo command | grep "$APPS/OMPdesk.app/Contents/MacOS/OMPdesk" | grep -v grep | head -1 | cut -c1-160); output: $(head -c 600 "$W/$name-direct.out" | tr '\n' '|')"
  crash_diag "$APPS/OMPdesk.app" "$W/$name-direct.out" "$UD"
}

# scenario <name> <0 success | 1 read-only apps folder | 2 shell start failure, launcher restores | 3 shell start failure,
# the v0.128.0 swap script restores .previous>
scenario() {
  local name=$1 fail=$2
  use_keychain "$name"
  local APPS=$W/$name/Applications UD=$W/$name/ud
  mkdir -p "$APPS" "$UD"; ditto rel.app "$APPS/OMPdesk.app"
  launchctl setenv OMP_GUI_TEST_USER_DATA_DIR "$UD"
  launchctl setenv OMP_GUI_OMP "$FAKE_OMP"
  native_environment
  local OLDENV=(); [ "$fail" = 3 ] && OLDENV=(OMPDESK_SWAP_START_WAIT_S=20)
  if [ "$fail" = 2 ] || [ "$fail" = 3 ]; then
    # The swap script relaunches with `open -n`, which hands the new shell launchd's environment, not the old app's.
    launchctl setenv OMP_GUI_TEST_SHELL_FAIL_START 1
    launchctl setenv OMPDESK_LAUNCHER_RELEASE_URL "http://127.0.0.1:$HTTPPORT"
    launchctl setenv OMPDESK_LAUNCHER_START_WAIT_S 20
  fi
  step "$name: the released app seeds a token and Local Storage (its own IPC)"
  # This feed validates the token but offers no release: seeding must not start a concurrent download.
  OMP_GUI_TEST_USER_DATA_DIR=$UD "$APPS/OMPdesk.app/Contents/MacOS/OMPdesk" --user-data-dir="$UD" --remote-debugging-port=$PORT --host-resolver-rules="MAP api.github.com 127.0.0.1:$SEEDPORT" --ignore-certificate-errors >"$W/$name-seed.out" 2>&1 &
  local seed_pid=$! seed_rc
  (cd "$REPO" && limit 120 bun scripts/shell-move/cdp-seed-mac.ts $PORT) | tee "$W/$name-seed.json"; seed_rc=${PIPESTATUS[0]}
  if [ "$seed_rc" != 0 ] || [ ! -f "$UD/update-token.bin" ]; then
    check 1 "$name: seed must validate and store the token in the test profile"
    evidence "$name seed diagnostics: seed exit $seed_rc; app pid $seed_pid; token file $([ -f "$UD/update-token.bin" ] && echo present || echo absent); runtime log $([ -f "$UD/logs/gui-runtime.jsonl" ] && echo present || echo absent)"
    evidence "$name seed output: $(tail -n 12 "$W/$name-seed.out" 2>&1 | cut -c1-220 | tr '\n' '|')"
    stop_or_exit "$APPS/OMPdesk.app"
    restore
    exit 1
  fi
  check 0 "$name: seed validated and stored a token, set the reply language ($SEED_LANGUAGE) and listed the seeded conversation"
  grep -q "\"id\":\"$SEED_ID\"" "$W/$name-seed.json" && grep -q "\"replyLanguage\":\"$SEED_LANGUAGE\"" "$W/$name-seed.json"; check $? "$name: the released app's own page reported the seeded setting and conversation id"
  if [ "$name" = s1 ]; then shots 01 old-electron-signed-in-with-data old; fi
  (cd "$REPO" && limit 90 bun scripts/shell-move/cdp-seed-mac.ts $PORT quit) | tee "$W/$name-quit.json"; seed_rc=${PIPESTATUS[0]}
  if [ "$seed_rc" != 0 ] || ! wait_app "$APPS/OMPdesk.app" "$seed_pid"; then
    check 1 "$name: the seeded released app quit normally before its profile was read again"
    stop_or_exit "$APPS/OMPdesk.app" "$seed_pid"
    restore
    exit 1
  fi
  if wait "$seed_pid"; then seed_rc=0; else seed_rc=$?; fi
  evidence "$name seed process: pid $seed_pid exited $seed_rc"
  if [ "$seed_rc" != 0 ]; then
    check 1 "$name: the seeded released app exited successfully"
    restore
    exit 1
  fi
  rm -rf "$UD/logs" "$UD/updates"
  [ -z "$REAL_TAG" ] || stop_seed_feed
  step "$name: the released app, left alone with its updater"
  env -u GH_TOKEN -u GITHUB_TOKEN ${OLDENV[@]+"${OLDENV[@]}"} OMP_GUI_TEST_USER_DATA_DIR=$UD "$APPS/OMPdesk.app/Contents/MacOS/OMPdesk" --user-data-dir="$UD" --remote-debugging-port=$PORT ${SWITCHES[@]+"${SWITCHES[@]}"} >"$W/$name-old.out" 2>&1 &
  local old_pid=$! old_state=running
  (cd "$REPO" && limit 120 bun scripts/shell-move/cdp-seed-mac.ts $PORT read) | tee "$W/$name-persisted.json"
  local persisted_rc=${PIPESTATUS[0]}
  if [ "$persisted_rc" != 0 ] ||
     ! grep -q '"href":"file://' "$W/$name-persisted.json" ||
     ! grep -q '"source":"stored"' "$W/$name-persisted.json" ||
     ! grep -q '"draft":"a draft typed in Electron"' "$W/$name-persisted.json" ||
     ! grep -q '"korean":"한국어 초안 ✓"' "$W/$name-persisted.json" ||
     ! grep -q '"large":200000' "$W/$name-persisted.json"; then
    check 1 "$name: the restarted released app retained the original token and Local Storage before migration"
    stop_or_exit "$APPS/OMPdesk.app"
    restore
    exit 1
  fi
  check 0 "$name: the restarted released app retained the original token and Local Storage before migration"
  grep -q "\"replyLanguage\":\"$SEED_LANGUAGE\"" "$W/$name-persisted.json" && grep -q "\"seedSessionId\":\"$SEED_ID\"" "$W/$name-persisted.json"; check $? "$name: the restarted released app kept the setting and the seeded conversation before migration"
  [ -z "$REAL_TAG" ] || real_old_app_checks "$APPS"
  if wait_for "has_line $UD 'download verified'" "$DOWNLOAD_WAIT_S"; then
    check 0 "$name: check found, download verified"
  else
    if ! kill -0 "$old_pid" 2>/dev/null; then
      wait "$old_pid"; old_state="exited $?"
    fi
    check 1 "$name: check found, download verified"
    evidence "$name update startup: pid $old_pid ($old_state); runtime log $([ -f "$UD/logs/gui-runtime.jsonl" ] && echo present || echo absent)"
    evidence "$name update output: $(tail -n 12 "$W/$name-old.out" 2>&1 | cut -c1-220 | tr '\n' '|')"
    stop_or_exit "$APPS/OMPdesk.app"
    restore
    exit 1
  fi
  [ -z "$REAL_TAG" ] || real_downloaded_checks "$UD"
  if [ "$fail" = 1 ]; then
    chmod -R a-w "$APPS"; evidence "S2 the apps folder is read-only before the countdown ends ($(stat -f %Sp "$APPS"))"
  fi
  wait_for "has_line $UD 'swap helper'" 300; check $? "$name: install auto, swap helper"
  update_lines "$UD" | sed 's/^/EVIDENCE: update log: /'
  if [ "$fail" = 2 ]; then
    wait_for "grep -q '^installed' $UD/updates/swap.log" 120; check $? "S3: the swap installed the shell bundle (swap.log installed)"
    wait_for "grep -q 'previous app restored\|restore failed' $UD/updates/swap.log" 300; check $? "S3: the launcher finished (swap.log)"
    evidence "S3 swap.log: $(tr '\n' '|' < "$UD/updates/swap.log" | cut -c1-900)"
    for line in 'start failed' 'rollback: fetching' 'rollback: download ok' 'rollback: sha512 ok' 'rollback: verified' 'rollback: swapped' 'rollback: opened' 'start failed; previous app restored'; do
      grep -q "$line" "$UD/updates/swap.log"; check $? "S3: swap.log has \"$line\""
    done
    evidence "S3 launcher traffic: $(grep -c . "$W/feed.log") feed lines; http: $(grep http "$W/feed.log" | cut -c1-110 | tr '\n' '|')"
    sleep 5
    evidence "S3 restored bundle: $(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APPS/OMPdesk.app/Contents/Info.plist"), shell binary present: $(ls "$APPS/OMPdesk.app/Contents/MacOS" | tr '\n' ' ')"
    [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APPS/OMPdesk.app/Contents/Info.plist")" = "$ROLLBACK_VERSION" ] && [ ! -e "$APPS/OMPdesk.app/Contents/MacOS/ompdesk-shell" ]; check $? "S3: the last Electron release is back in place ($ROLLBACK_VERSION, no shell binary)"
    codesign --verify --deep --strict "$APPS/OMPdesk.app"; check $? "S3: the restored app verifies"
    wait_for "has_line $UD 'swap result'" 120; update_lines "$UD" | sed 's/^/EVIDENCE: S3 update log: /'
    update_lines "$UD" | grep -Eq '^swap result (rolled back|changed)'; check $? "S3: the restored Electron logged swap result (rolled back/changed)"
    ps -axo command | grep "$APPS/OMPdesk.app/Contents/MacOS/OMPdesk" | grep -v grep | grep -q .; check $? "S3: the Electron app is running"
    ls "$APPS" | grep -q 'updating\|previous'; [ $? != 0 ]; check $? "S3: no .updating or .previous leftovers"
    evidence "S3 shell started at all: $(ls "$UD/shell-webview" 2>&1 | tr '\n' ' ')"
  elif [ "$fail" = 3 ]; then
    wait_for "grep -q 'previous app restored\|previous app lost' $UD/updates/swap.log" 300; check $? "S4: the swap script finished (swap.log)"
    evidence "S4 swap.log: $(tr '\n' '|' < "$UD/updates/swap.log" | cut -c1-900)"
    for line in '^installed' 'waiting for the new app to start' 'start failed; previous app restored'; do
      grep -q "$line" "$UD/updates/swap.log"; check $? "S4: swap.log has \"$line\""
    done
    grep -q 'rollback: download ok' "$UD/updates/swap.log"; [ $? != 0 ]; check $? "S4: the launcher downloaded nothing (the script owns the rollback)"
    sleep 5
    [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APPS/OMPdesk.app/Contents/Info.plist")" = $OLD_VERSION ] && [ ! -e "$APPS/OMPdesk.app/Contents/MacOS/ompdesk-shell" ]; check $? "S4: the old Electron app is back in place ($OLD_VERSION, no shell binary)"
    codesign --verify --deep --strict "$APPS/OMPdesk.app"; check $? "S4: the restored app verifies"
    wait_for "has_line $UD 'swap result'" 120; update_lines "$UD" | sed 's/^/EVIDENCE: S4 update log: /'
    update_lines "$UD" | grep -Eq '^swap result (rolled back|changed)'; check $? "S4: the restored Electron logged swap result (rolled back/changed)"
    ps -axo command | grep "$APPS/OMPdesk.app/Contents/MacOS/OMPdesk" | grep -v grep | grep -q .; check $? "S4: the Electron app is running"
    # Best effort: the relaunched old app has a CDP port only when the swap script passed the original argv through.
    shot_old 04-rollback-old-app.png
    ls "$APPS" | grep -q 'updating\|previous'; [ $? != 0 ]; check $? "S4: no .updating or .previous leftovers"
  elif [ "$fail" = 0 ]; then
    wait_for "grep -q '^installed' $UD/updates/swap.log" 120; check $? "S1: swap.log says installed"
    evidence "S1 swap.log: $(tr '\n' '|' < "$UD/updates/swap.log" | cut -c1-300)"
    if [ "$MOVE_ENGINE" = cef ]; then
      wait_for "grep -q window.created $UD/shell-webview/shell.log.jsonl 2>/dev/null" 180; check $? "S1: the new shell started (window.created)"
      if ! grep -q window.created "$UD/shell-webview/shell.log.jsonl" 2>/dev/null; then relaunch_diag "$APPS" "$UD" "$name"; fi
      grep -q '"migrate.localStorage"' "$UD/shell-webview/shell.log.jsonl"; check $? "S1: migrate.localStorage in the shell log"
      evidence "S1 shell log: $(grep -E 'migrate|cef.ready|window.created' "$UD/shell-webview/shell.log.jsonl" | cut -c1-200 | tr '\n' '|')"
    fi
    evidence "S1 shell command line: $(ps -axo command | grep "$APPS/OMPdesk.app/Contents/MacOS/" | grep -v grep | head -1 | cut -c1-260)"
    ps -axo command | grep "$APPS/OMPdesk.app/Contents/MacOS/" | grep -v grep | grep -q -- "--user-data-dir=$UD"; check $? "S1: the shell was started with Electron's argv (--user-data-dir)"
    if [ -n "$REAL_TAG" ]; then
      real_retention_checks "$APPS" "$UD" "after the update relaunch"
      real_shot 02-tauri-after-update-relaunch.png
    else
      new_profile read | tee "$W/$name-read.json"; check ${PIPESTATUS[0]} "S1: the actual $MOVE_ENGINE page answered"
      grep -q '"href":"app://ompdesk/' "$W/$name-read.json"; check $? "S1: the page loaded from app://ompdesk"
      grep -q '"draft":"a draft typed in Electron"' "$W/$name-read.json" && grep -q '"korean":"한국어 초안 ✓"' "$W/$name-read.json" && grep -q '"large":200000' "$W/$name-read.json"; check $? "S1: Local Storage reached the page"
      if [ "$MOVE_ENGINE" = tauri ]; then
        grep -q "\"replyLanguage\":\"$SEED_LANGUAGE\"" "$W/$name-read.json"; check $? "S1: the setting changed in Electron (reply language $SEED_LANGUAGE) reads back on the Tauri page after the update relaunch"
        grep -q "\"seedSessionId\":\"$SEED_ID\"" "$W/$name-read.json" && grep -q "\"seedSessionTitle\":\"$SEED_TITLE\"" "$W/$name-read.json"; check $? "S1: the conversation made in Electron is in the Tauri session list after the update relaunch (id and title)"
        shots 02 tauri-after-update-relaunch new
      fi
    fi
    # The new app reads the item Electron made (service "ompdesk Safe Storage", account "ompdesk Key") instead of making
    # a second one: a second item is a new password, and every secret Electron saved is lost with it.
    [ "$(perl -e 'alarm 20; exec @ARGV' security dump-keychain "$KC" 2>/dev/null | grep -c '"svce"<blob>="ompdesk Safe Storage"')" = 1 ]; check $? "S1: the new app reused Electron's one keychain item (no second \"ompdesk Safe Storage\")"
    if [ -z "$REAL_TAG" ]; then
      if grep -q '"source":"stored"' "$W/$name-read.json" && grep -q '"droppedReason":null' "$W/$name-read.json"; then
        check 0 "S1: the seeded token was decrypted (source stored, none dropped)"
      else
        check 1 "S1: the seeded token was decrypted (source stored, none dropped)"
        evidence "S1 token-read failure phases: $(grep -F '"event":"stored-token-read"' "$UD/logs/gui-runtime.jsonl" 2>/dev/null | tail -8 | cut -c1-500 | tr '\n' '|')"
        keychain_diag "$APPS" "$UD"
      fi
    fi
    wait_for "has_line $UD 'swap result'" 60; update_lines "$UD" | grep -q '^swap result installed'; check $? "S1: swap result outcome installed"
    codesign --verify --deep --strict "$APPS/OMPdesk.app"; check $? "S1: the installed app verifies"
    [ "$(xattr -lr "$APPS/OMPdesk.app" 2>/dev/null | grep -c com.apple.quarantine)" = 0 ]; check $? "S1: the moved bundle and everything in it carries no com.apple.quarantine (the swap's xattr -dr covers it)"
    evidence "S1 spctl: $(spctl --assess -vv --type execute "$APPS/OMPdesk.app" 2>&1 | tr '\n' ' ') (no spctl rule)"
    if [ "$SOURCE_TAG" != v0.127.0 ]; then
      wait_for "grep -q '^started' $UD/updates/swap.log" 180; check $? "S1: the start-checked script saw app-started.json for the new version (swap.log started)"
      evidence "S1 app-started.json: $(cat "$UD/app-started.json" 2>&1 | cut -c1-120)"
      ls "$APPS" | grep -q 'previous'; [ $? != 0 ]; check $? "S1: .previous is gone once the new app proved it started"
    fi
    evidence "S1 installed bundle: $(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APPS/OMPdesk.app/Contents/Info.plist") ($(codesign -d -r- "$APPS/OMPdesk.app" 2>&1 | sed -n 's/^designated => //p'))"
    [ -z "$REAL_TAG" ] || real_installed_checks "$APPS" "$UD"
    if [ -n "$REAL_TAG" ]; then
      real_restart_checks "$APPS" "$UD"
    elif [ "$MOVE_ENGINE" = tauri ]; then
      new_profile write | tee "$W/$name-native-write.json"; check ${PIPESTATUS[0]} "S1: the migrated native page saved new Korean data"
      new_profile quit | tee "$W/$name-native-quit.json"; local quit_rc=${PIPESTATUS[0]}
      if [ "$quit_rc" != 0 ] || ! wait_app "$APPS/OMPdesk.app"; then
        check 1 "S1: the native app quit normally before its profile was reopened"
        stop_or_exit "$APPS/OMPdesk.app"; restore; exit 1
      fi
      open -n "$APPS/OMPdesk.app" --args --user-data-dir="$UD"
      new_profile read | tee "$W/$name-native-reopened.json"; local reopened_rc=${PIPESTATUS[0]}
      if [ "$reopened_rc" != 0 ] ||
         ! grep -q '"afterMigration":"Tauri 저장 후 다시 열기 ✓"' "$W/$name-native-reopened.json" ||
         ! grep -q '"draft":"a draft typed in Electron"' "$W/$name-native-reopened.json" ||
         ! grep -q '"korean":"한국어 초안 ✓"' "$W/$name-native-reopened.json" ||
         ! grep -q '"large":200000' "$W/$name-native-reopened.json" ||
         ! grep -q '"source":"stored"' "$W/$name-native-reopened.json"; then
        check 1 "S1: the restarted native app retained old and new data plus encrypted auth"
      else
        check 0 "S1: the restarted native app retained old and new data plus encrypted auth"
      fi
      grep -q "\"replyLanguage\":\"$SEED_LANGUAGE\"" "$W/$name-native-reopened.json"; check $? "S1: the reopened Tauri app still has the reply language setting ($SEED_LANGUAGE)"
      grep -q "\"seedSessionId\":\"$SEED_ID\"" "$W/$name-native-reopened.json" && grep -q "\"seedSessionTitle\":\"$SEED_TITLE\"" "$W/$name-native-reopened.json"; check $? "S1: the reopened Tauri app still lists the seeded conversation (id and title)"
      shots 03 tauri-reopened-retained new
    fi
  else
    wait_for "grep -q 'copy failed\|install failed\|cannot move' $UD/updates/swap.log 2>/dev/null" 120; check $? "S2: the swap failed (swap.log)"
    evidence "S2 swap.log: $(tr '\n' '|' < "$UD/updates/swap.log" | cut -c1-300)"
    sleep 5
    [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APPS/OMPdesk.app/Contents/Info.plist")" = $OLD_VERSION ]; check $? "S2: the Electron app is untouched (the old version)"
    ls "$APPS" | grep -q 'updating\|previous'; [ $? != 0 ]; check $? "S2: no .updating or .previous leftovers"
    stop_or_exit "$APPS/OMPdesk.app"
    chmod -R u+w "$APPS"
    # The next launch, as a person's: the released app reports the failed move.
    OMP_GUI_TEST_USER_DATA_DIR=$UD "$APPS/OMPdesk.app/Contents/MacOS/OMPdesk" --user-data-dir="$UD" --remote-debugging-port=$PORT --host-resolver-rules="MAP api.github.com 127.0.0.1:1" --ignore-certificate-errors >"$W/$name-again.out" 2>&1 &
    wait_for "has_line $UD 'swap result'" 120; update_lines "$UD" | grep -q '^swap result rolled back'; check $? "S2: swap result outcome rolled back"
  fi
  evidence "$name feed log: $(tail -n 6 "$W/feed.log" | cut -c1-120 | tr '\n' '|')"
  dialogs; check $? "$name: no dialog (SecurityAgent) line"
  stop_or_exit "$APPS/OMPdesk.app"
  for v in OMP_GUI_TEST_SHELL_FAIL_START OMPDESK_LAUNCHER_RELEASE_URL OMPDESK_LAUNCHER_START_WAIT_S; do launchctl unsetenv $v; done
  restore
}
scenario s1 0
if [ -n "$REAL_TAG" ]; then
  evidence "S4 (a new shell that does not start) is not run against the real feed: it needs a broken DMG, and the published one is not ours to break"
elif [ "$SOURCE_TAG" != v0.127.0 ]; then
  scenario s4 3
else
  scenario s3 2
  scenario s2 1
fi
dialog_evidence
security delete-keychain "$KC0" 2>/dev/null
exit $FAILED
