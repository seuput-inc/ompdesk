#!/bin/bash
# webkit-store-mac.sh <OMPdesk.app>: an update from the released Tauri app keeps the page's WebKit data store. Throwaway GitHub
# macOS runner only (mac-checks.yml mac-smoke, after mac-launch-check.sh): it opens apps and sets launchd variables.
# WebKit keeps an identified data store (the shell's: the first 16 bytes of SHA-256 of the userData path) whole under
# ~/Library/WebKit/<bundle identifier, else the process name>/WebsiteDataStore/<uuid>: Local Storage, IndexedDB, cookies and
# caches (WebsiteDataStoreCocoa.mm applicationOrProcessIdentifier, WebsiteDataStoreConfiguration(UUID)). Shells up to v0.133.0
# embedded no CFBundleIdentifier, so their stores sit under `ompdesk-shell`; a shell that names com.seuput.ompdesk reads that
# name and must find its store moved there (native/ompdesk/crates/tauri-shell/src/sessions/webkit_store.rs).
#  1. the released app from its DMG starts on a temp profile, its page writes its own Local Storage, and it quits;
#  2. a marker key goes into that store's localstorage.sqlite3 (a released app has no WebDriver to write through; the page never
#     writes the marker itself, so only the moved store can hold it);
#  3. the candidate, its test WebDriver on, starts on the same profile: its page holds the marker and every key the released page
#     wrote, and the store's folder carries the new name.
# Evidence lines start with "EVIDENCE:". Exit 1 on any failed check.
set -uo pipefail
APP=$(cd "${1:?usage: webkit-store-mac.sh <OMPdesk.app>}" && pwd)
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../.." && pwd)
. "$HERE/check-lib.sh"
. "$HERE/mac-processes.sh"
TAG=${OMP_STORE_RELEASED_TAG:-v0.133.0}
ID=com.seuput.ompdesk; OLD_NAME=ompdesk-shell; PORT=19233; MARKER=ompdesk.webkitStoreMove
W=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/webkit-store.XXXXXX")
UD=$W/profile; OLD_STORES=$HOME/Library/WebKit/$OLD_NAME/WebsiteDataStore; NEW_STORES=$HOME/Library/WebKit/$ID/WebsiteDataStore
limit() { perl -e 'alarm shift; exec @ARGV' "$@"; }
wait_for() { local n=0; while [ $n -lt "$2" ]; do eval "$1" && return 0; sleep 1; n=$((n+1)); done; return 1; }
# Every per-app folder macOS and WebKit name after the bundle identifier or the process name.
folders() {
  evidence "$1: $(for d in "$HOME/Library/WebKit" "$HOME/Library/Caches" "$HOME/Library/HTTPStorages" "$HOME/Library/Preferences" "$HOME/Library/Saved Application State" "${TMPDIR:-/tmp}"; do
    find "$d" -maxdepth 1 \( -iname "*$OLD_NAME*" -o -iname "*$ID*" \) 2>/dev/null | sed "s|^$HOME/||" | while read -r f; do printf '%s (%s) ' "$f" "$(du -sk "$HOME/$f" "$f" 2>/dev/null | head -1 | cut -f1)K"; done
  done)"
}
mkdir -p "$UD"
printf '{"language":"en","firstRunComplete":true}\n' > "$UD/prefs.json"

FAKE_DIR=$W/fake-omp
(cd "$REPO" && exec bun scripts/shell-move/fake-omp.ts "$FAKE_DIR") >"$W/fake-omp.out" 2>&1 &
FAKE_HOLDER=$!
cleanup() {
  for v in OMP_GUI_OMP OMP_GUI_TEST_USER_DATA_DIR OMP_GUI_TEST_NODE_INSPECT OMP_GUI_TEST_WEBDRIVER_PORT; do launchctl unsetenv $v; done
  kill "$FAKE_HOLDER" 2>/dev/null
  pkill -f "$W/rel.app/Contents/" 2>/dev/null; pkill -f "$APP/Contents/" 2>/dev/null
}
trap cleanup EXIT
wait_for "test -s '$FAKE_DIR/bin.txt'" 60; check $? "the fake omp is installed"
launchctl setenv OMP_GUI_OMP "$(cat "$FAKE_DIR/bin.txt")"
launchctl setenv OMP_GUI_TEST_USER_DATA_DIR "$UD"

step "the released $TAG writes its store"
curl -fsSL -o "$W/rel.dmg" "https://github.com/seuput-inc/ompdesk/releases/download/$TAG/ompdesk-mac-arm64.dmg"; check $? "downloaded $TAG's DMG"
mkdir -p "$W/mnt" && hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$W/mnt" "$W/rel.dmg" >/dev/null && ditto "$W/mnt/OMPdesk.app" "$W/rel.app"; check $? "copied $TAG's app out of its DMG"
hdiutil detach "$W/mnt" >/dev/null
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$W/rel.app/Contents/Info.plist")" = "${TAG#v}" ]; check $? "the released app is ${TAG#v}"
evidence "embedded Info.plist of $TAG's shell: $(launchctl plist __TEXT,__info_plist "$W/rel.app/Contents/MacOS/ompdesk-shell" 2>&1 | tr -s ' \n' ' ' | cut -c1-300)"
evidence "embedded Info.plist of the candidate's shell: $(launchctl plist __TEXT,__info_plist "$APP/Contents/MacOS/ompdesk-shell" 2>&1 | tr -s ' \n' ' ' | cut -c1-300)"
evidence "expected store of this profile: $(printf %s "$UD" | shasum -a 256 | cut -c1-32)"
folders "before"
BEFORE=$(ls "$OLD_STORES" 2>/dev/null)
open -n "$W/rel.app" --args --user-data-dir="$UD" --host-resolver-rules="MAP api.github.com 127.0.0.1:1"
wait_for "test -s '$UD/app-started.json'" 180; check $? "$TAG started (app-started.json: $(cat "$UD/app-started.json" 2>/dev/null | cut -c1-120))"
# Its page writes Local Storage on its own (snapshot cache, layout); the file appears once the first write commits.
wait_for 'DB=$(find "$OLD_STORES" -name localstorage.sqlite3 2>/dev/null | head -1); [ -n "$DB" ]' 120
check $? "$TAG's page wrote Local Storage under ~/Library/WebKit/$OLD_NAME (${DB:-none})"
sleep 10
stop_app "$W/rel.app"; check $? "$TAG quit"
sleep 5
STORES=$(comm -13 <(printf '%s\n' "$BEFORE" | sort) <(ls "$OLD_STORES" 2>/dev/null | sort))
evidence "stores $TAG made under $OLD_NAME: $(echo $STORES)"
[ -n "${DB:-}" ] || { folders "after $TAG"; exit 1; }
UUID=${DB#"$OLD_STORES/"}; UUID=${UUID%%/*}
evidence "the profile's store: $UUID"
KEYS=(); while IFS= read -r k; do [ -n "$k" ] && KEYS+=("$k"); done < <(sqlite3 "$DB" 'select key from ItemTable order by key')
[ "${#KEYS[@]}" -gt 0 ]; check $? "$TAG's page left ${#KEYS[@]} Local Storage keys: $(printf '%s ' "${KEYS[@]}" | cut -c1-400)"
sqlite3 "$DB" "insert into ItemTable(key, value) select '$MARKER', value from ItemTable order by key limit 1"
[ "$(sqlite3 "$DB" "select count(*) from ItemTable where key = '$MARKER'")" = 1 ]; check $? "the marker $MARKER is in $TAG's store"
folders "after $TAG"

step "the candidate starts on the same profile"
rm -f "$UD/app-started.json"
launchctl setenv OMP_GUI_TEST_NODE_INSPECT 1
launchctl setenv OMP_GUI_TEST_WEBDRIVER_PORT "$PORT"
open -n "$APP" --args --user-data-dir="$UD"
wait_for "test -s '$UD/app-started.json'" 180; check $? "the candidate started (app-started.json)"
SEEN=$(cd "$REPO" && limit 180 bun scripts/shell-move/native-profile.ts "$PORT" keys "$MARKER" "${KEYS[@]}" 2>&1 | tail -1)
evidence "the candidate's page: $(echo "$SEEN" | cut -c1-600)"
jq -e --arg m "$MARKER" '.present[$m] == true' <<<"$SEEN" >/dev/null 2>&1; check $? "the candidate's page reads the marker $TAG's store held"
MISSING=$(jq -r '.present | to_entries | map(select(.value != true) | .key) | join(" ")' <<<"$SEEN" 2>/dev/null || echo unreadable)
[ -z "$MISSING" ]; check $? "the candidate's page holds every key $TAG's page wrote (missing: ${MISSING:-none})"
evidence "the store's shell log lines: $(grep -h 'webkit.store' "$UD/tauri-shell.jsonl" 2>/dev/null | cut -c1-300 | tr '\n' '|')"
test -d "$NEW_STORES/$UUID"; check $? "the store is under ~/Library/WebKit/$ID now"
[ ! -e "$OLD_STORES/$UUID" ]; check $? "nothing of the store is left under ~/Library/WebKit/$OLD_NAME"
(cd "$REPO" && limit 60 bun scripts/shell-move/native-profile.ts "$PORT" quit >/dev/null 2>&1)
wait_app "$APP" || stop_app "$APP"
folders "after the candidate"
exit $FAILED
