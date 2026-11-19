#!/bin/bash
# mac-update-gate.sh: an INSTALLED release candidate updates itself into a HIGHER build through its own, unchanged updater,
# on a throwaway GitHub macOS runner only. Nothing here runs on a person's Mac: it replaces /Applications/OMPdesk.app, maps
# api.github.com to this machine in /etc/hosts and trusts a throwaway certificate in the System keychain.
#   CANDIDATE_DMG  the candidate's ompdesk-mac-arm64.dmg (release.yml dry run, artifact ompdesk-mac)
#   NEXT_DMG       the higher build's DMG, offered by the stand-in feed
#   NEXT_VERSION   the version NEXT_DMG carries (the feed's tag is v<NEXT_VERSION>)
#   OUT            the evidence folder the job uploads
#   FEED_SCRIPT    feed.ts (default: beside this script)
# The candidate is copied out of its DMG into /Applications as shipped (not re-signed: stageBundleFromDmg verifies the
# next build's signature and bundle id, and the keychain item trusts the release's designated requirement), opened with
# `open` like a person does, and left alone. Its network is the Tauri shell's native one (NSURLSession), which ignores
# Chromium's --host-resolver-rules, so the stand-in is reached the way any process on this machine reaches a host:
# /etc/hosts and a certificate the system trusts. GitHub's public Latest is never read or changed.
# Lines: "EVIDENCE: …", "ok: …", "FAILED: …", last "RESULT: ok" or "RESULT: FAILED (…)". Exit 1 on any failed check.
[ "${GITHUB_ACTIONS:-}" = true ] || { echo "mac-update-gate.sh runs on a GitHub runner only (it replaces /Applications/OMPdesk.app and edits /etc/hosts)"; exit 2; }
[ "$(uname -s)" = Darwin ] || { echo "mac-update-gate.sh needs macOS"; exit 2; }
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../.." && pwd)
absolute() { case "$1" in /*) printf '%s\n' "$1" ;; *) printf '%s\n' "$PWD/$1" ;; esac; }
: "${CANDIDATE_DMG:?CANDIDATE_DMG: the DMG of the candidate to install}" "${NEXT_DMG:?NEXT_DMG: the DMG of the higher build}"
: "${NEXT_VERSION:?NEXT_VERSION: the version the feed offers}" "${OUT:?OUT: the evidence folder}"
CANDIDATE_DMG=$(absolute "$CANDIDATE_DMG"); NEXT_DMG=$(absolute "$NEXT_DMG"); OUT=$(absolute "$OUT")
FEED_SCRIPT=$(absolute "${FEED_SCRIPT:-$HERE/feed.ts}")
mkdir -p "$OUT"
# mac-common.sh moves into its work folder ($W) and starts the SecurityAgent/coreauthd watch.
. "$HERE/mac-common.sh"
. "$HERE/mac-processes.sh"

APP=/Applications/OMPdesk.app
UD="$HOME/Library/Application Support/ompdesk"
LOG="$UD/logs/gui-runtime.jsonl"
SWAP_LOG="$UD/updates/swap.log"
CERT=$W/cert/feed-cert.pem
HOSTS_MARK='# ompdesk mac-update-gate'
LATEST_URL=https://api.github.com/repos/seuput-inc/ompdesk/releases/latest
FEED=; FEED_AS_ROOT=0; FAKE_OMP_HOLDER=; HOSTS_MAPPED=0; CERT_TRUSTED=0; KEYCHAIN_SWAPPED=0; FAILURES=

check() { if [ "$1" = 0 ]; then echo "ok: $2"; else echo "FAILED: $2"; FAILED=1; FAILURES="${FAILURES:+$FAILURES; }$2"; fi; }
fatal() { check 1 "$1"; exit 1; }
wait_for() { local n=0; while [ "$n" -lt "$2" ]; do "$1" && return 0; sleep 3; n=$((n+3)); done; return 1; }
bundle_version() { /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$1/Contents/Info.plist" 2>/dev/null; }
update_rows() { jq -cR --arg next "$NEXT_VERSION" "fromjson? | select(.source == \"app-update\" and ($1))" "$LOG" 2>/dev/null; }
has_row() { update_rows "$1" | grep -q .; }
update_lines() { update_rows true | jq -r '"\(.message) \(.details.event // "") \(.details | del(.event, .level) | tostring)"' | cut -c1-260; }
check_found() { has_row '.message == "check" and .details.event == "found"'; }
download_verified() { has_row '.message == "download" and .details.event == "verified"'; }
download_ended() { has_row '.message == "download" and (.details.event == "verified" or .details.event == "failed")'; }
swap_helper() { has_row '.message == "swap" and .details.event == "helper"'; }
swap_result() { has_row '.message == "swap" and .details.event == "result"'; }
swap_installed() { grep -q '^installed' "$SWAP_LOG" 2>/dev/null; }
swap_started() { grep -q '^started' "$SWAP_LOG" 2>/dev/null; }
started_version() { jq -r .version "$UD/app-started.json" 2>/dev/null; }
candidate_started() { [ "$(started_version)" = "$CANDIDATE_VERSION" ]; }
next_started() { [ "$(started_version)" = "$NEXT_VERSION" ]; }
feed_listening() { grep -q '"listening":443' "$W/feed.log" 2>/dev/null; }
feed_paths() { jq -rR 'fromjson? | select(.path) | "\(.method) \(.path)"' "$W/feed.log" 2>/dev/null; }

# The app out of a DMG, as shipped. $1 DMG, $2 destination bundle.
copy_app() {
  local mount="$W/mnt-$(basename "$2")" copied
  mkdir -p "$mount"
  hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$mount" "$1" >/dev/null || return 1
  ditto "$mount/OMPdesk.app" "$2"; copied=$?
  hdiutil detach "$mount" >/dev/null || hdiutil detach -force "$mount" >/dev/null
  return "$copied"
}
# The window as the window server shows it (a published app has no page to photograph through); the whole display when
# OMPdesk lists no window.
shot() {
  local file=$OUT/$1 id args=(-x) rc
  id=$(limit 120 swift "$HERE/window-id.swift" 2>/dev/null | tail -1)
  case "$id" in ''|0|*[!0-9]*) id= ;; esac
  [ -z "$id" ] || args=(-x -o -l "$id")
  limit 60 screencapture "${args[@]}" "$file" 2>"$W/screencapture.err"; rc=$?
  evidence "screenshot $1: window ${id:-none (whole display)}, screencapture exit $rc, $(stat -f %z "$file" 2>/dev/null || echo 0) bytes $(head -c 200 "$W/screencapture.err" | tr '\n' ' ')"
}
# $@ is the command prefix: `env` (the runner's user) or `sudo -n` (binding 127.0.0.1:443 may need root).
start_gate_feed() {
  local n=0
  (cd "$REPO" && exec "$@" "$BUN" "$FEED_SCRIPT" --setup "$NEXT_DMG" --platform mac --version "$NEXT_VERSION" --cert-dir "$W/cert" --port 443 --hostname 127.0.0.1 >"$W/feed.log" 2>"$W/feed.err") &
  FEED=$!
  while [ "$n" -lt 120 ]; do
    feed_listening && return 0
    ps -p "$FEED" >/dev/null 2>&1 || return 1
    sleep 1; n=$((n+1))
  done
  return 1
}
stop_gate_feed() {
  [ -n "$FEED" ] || return 0
  if [ "$FEED_AS_ROOT" = 1 ]; then sudo -n kill "$FEED" 2>/dev/null; sudo -n pkill -f "$FEED_SCRIPT" 2>/dev/null; else kill "$FEED" 2>/dev/null; fi
  FEED=
}
flush_dns() { sudo -n dscacheutil -flushcache; sudo -n killall -HUP mDNSResponder 2>/dev/null; }
collect() {
  mkdir -p "$OUT"
  [ ! -f "$LOG" ] || tail -n 4000 "$LOG" >"$OUT/gui-runtime.jsonl"
  local file
  for file in "$SWAP_LOG" "$UD/app-started.json" "$UD/update-install.json" "$UD/update-start-failed.json" "$UD/tauri-shell.jsonl" "$W/feed.err" "$W/dialogs.log"; do
    [ ! -f "$file" ] || cp -f "$file" "$OUT/"
  done
  [ ! -f "$W/feed.log" ] || cp -f "$W/feed.log" "$OUT/feed-requests.log"
  update_lines >"$OUT/update-lines.txt"
  sed 's/^/EVIDENCE: update log: /' "$OUT/update-lines.txt"
  [ ! -f "$SWAP_LOG" ] || evidence "swap.log: $(tr '\n' '|' <"$SWAP_LOG" | cut -c1-600)"
  evidence "feed requests: $(feed_paths | sort | uniq -c | tr -s ' ' | tr '\n' '|' | cut -c1-600)"
  evidence "evidence folder $OUT: $(ls "$OUT" | tr '\n' ' ')"
}
finish() {
  trap - EXIT
  collect
  stop_app "$APP" >/dev/null 2>&1
  launchctl unsetenv OMP_GUI_OMP
  stop_gate_feed
  if [ "$HOSTS_MAPPED" = 1 ]; then sudo -n sed -i '' "/$HOSTS_MARK\$/d" /etc/hosts; flush_dns; fi
  if [ "$CERT_TRUSTED" = 1 ]; then
    sudo -n security remove-trusted-cert -d "$CERT" >/dev/null 2>&1
    sudo -n security delete-certificate -Z "$(/usr/bin/openssl x509 -in "$CERT" -noout -fingerprint -sha1 | sed 's/.*=//; s/://g')" /Library/Keychains/System.keychain >/dev/null 2>&1
  fi
  [ "$KEYCHAIN_SWAPPED" = 0 ] || restore
  kill "${WATCH:-}" "$FAKE_OMP_HOLDER" 2>/dev/null
  security delete-keychain "$KC0" 2>/dev/null
  if [ "$FAILED" = 0 ]; then echo "RESULT: ok"; exit 0; fi
  echo "RESULT: FAILED (${FAILURES:-the script stopped before its checks})"
  exit 1
}
trap finish EXIT
trap 'FAILED=1; FAILURES="${FAILURES:+$FAILURES; }interrupted"; exit 1' INT TERM

step "the candidate, installed in /Applications as shipped"
BUN=$(command -v bun) || fatal "bun is on the PATH (the feed and the fake omp run on it)"
[ -f "$CANDIDATE_DMG" ] && [ -f "$NEXT_DMG" ] && [ -f "$FEED_SCRIPT" ] || fatal "CANDIDATE_DMG, NEXT_DMG and FEED_SCRIPT are files"
copy_app "$NEXT_DMG" "$W/next.app" || fatal "the next build's DMG holds OMPdesk.app"
[ "$(bundle_version "$W/next.app")" = "$NEXT_VERSION" ] || fatal "the next build's DMG is $NEXT_VERSION (it is $(bundle_version "$W/next.app")): the feed would offer a version the staged bundle contradicts"
evidence "next build: $NEXT_VERSION, $(stat -f %z "$NEXT_DMG") bytes, requirement $(codesign -d -r- "$W/next.app" 2>&1 | sed -n 's/^designated => //p')"
rm -rf "$W/next.app"
stop_app "$APP" >/dev/null 2>&1; rm -rf "$APP" "$APP.previous" "$APP.updating"
copy_app "$CANDIDATE_DMG" "$APP" || fatal "the candidate's DMG holds OMPdesk.app and it copies into /Applications"
CANDIDATE_VERSION=$(bundle_version "$APP")
[ -n "$CANDIDATE_VERSION" ] && [ "$CANDIDATE_VERSION" != "$NEXT_VERSION" ] && [ "$(printf '%s\n%s\n' "$CANDIDATE_VERSION" "$NEXT_VERSION" | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)" = "$NEXT_VERSION" ]
check $? "the installed candidate ($CANDIDATE_VERSION) is lower than the offered build ($NEXT_VERSION)"
[ "$FAILED" = 0 ] || exit 1
codesign --verify --deep --strict "$APP"; check $? "the installed candidate $CANDIDATE_VERSION verifies as shipped (not re-signed)"
PIN=$(jq -er .certificateSha1 "$REPO/scripts/mac-signing.json" 2>/dev/null)
REQUIREMENT=$(codesign -d -r- "$APP" 2>&1 | sed -n 's/^designated => //p')
evidence "candidate: $CANDIDATE_VERSION, $(stat -f %z "$CANDIDATE_DMG") bytes, requirement $REQUIREMENT (pinned certificate ${PIN:-unknown})"
[ -w "$APP" ] && [ -w /Applications ]; check $? "the bundle and /Applications are writable by $(id -un): the updater picks relaunch mode, not the manual DMG"
[ "$(xattr -lr "$APP" 2>/dev/null | grep -c com.apple.quarantine)" = 0 ]; check $? "the installed candidate carries no com.apple.quarantine"

step "the profile: a fresh default keychain, a canary in userData, a fake omp"
use_keychain gate; KEYCHAIN_SWAPPED=1
rm -rf "$UD"; mkdir -p "$UD"
CANARY="update-gate canary $(date +%s) $RANDOM"
printf '%s\n' "$CANARY" >"$UD/update-gate-canary.txt"
evidence "userData $UD, canary update-gate-canary.txt: $CANARY"
# The runner has no omp. OMP_GUI_OMP names the e2e suite's fake (as move-mac.sh does); `open` and the swap helper's
# `open -n` hand the app launchd's environment, not this shell's, so it is set there.
FAKE_OMP_DIR=$W/fake-omp-home
(cd "$REPO" && exec "$BUN" scripts/shell-move/fake-omp.ts "$FAKE_OMP_DIR") >"$W/fake-omp.out" 2>&1 &
FAKE_OMP_HOLDER=$!
fake_omp_written() { test -s "$FAKE_OMP_DIR/bin.txt"; }
wait_for fake_omp_written 90
FAKE_OMP=$(cat "$FAKE_OMP_DIR/bin.txt" 2>/dev/null)
if [ ! -x "$FAKE_OMP" ]; then evidence "fake omp output: $(tail -n 8 "$W/fake-omp.out" | cut -c1-200 | tr '\n' '|')"; fatal "the fake omp is installed (fake-omp.ts)"; fi
check 0 "the fake omp is installed and answers --version ($("$FAKE_OMP" --version 2>&1 | head -1))"
launchctl setenv OMP_GUI_OMP "$FAKE_OMP"

step "the stand-in api.github.com: feed.ts on 127.0.0.1:443, /etc/hosts, a system-trusted certificate"
if start_gate_feed env; then
  evidence "the feed runs as $(id -un)"
else
  evidence "the feed could not bind 127.0.0.1:443 as $(id -un): $(tail -n 3 "$W/feed.err" 2>/dev/null | cut -c1-200 | tr '\n' '|'); starting it with sudo"
  FEED_AS_ROOT=1
  start_gate_feed sudo -n || { evidence "feed output: $(tail -n 6 "$W/feed.err" "$W/feed.log" 2>&1 | cut -c1-200 | tr '\n' '|')"; fatal "the stand-in feed listens on 127.0.0.1:443"; }
fi
check 0 "the stand-in feed listens on 127.0.0.1:443 and offers v$NEXT_VERSION ($(head -1 "$W/feed.log" | cut -c1-160))"
evidence "feed certificate: $(/usr/bin/openssl x509 -in "$CERT" -noout -subject -enddate 2>&1 | tr '\n' ' ') extensions: $(/usr/bin/openssl x509 -in "$CERT" -noout -text 2>/dev/null | grep -A1 -E 'Subject Alternative Name|Extended Key Usage' | grep -v -e '^--' | tr -s ' ' | tr '\n' ' ')"
if ! sudo -n security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "$CERT" 2>"$W/trust.err"; then
  evidence "add-trusted-cert refused ($(tr '\n' ' ' <"$W/trust.err" | cut -c1-200)); allowing admin trust settings without a prompt and trying again"
  sudo -n security authorizationdb write com.apple.trust-settings.admin allow >/dev/null 2>&1
  sudo -n security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "$CERT" 2>"$W/trust.err" || { evidence "add-trusted-cert: $(tr '\n' ' ' <"$W/trust.err" | cut -c1-300)"; fatal "the feed's certificate is trusted in the System keychain"; }
fi
CERT_TRUSTED=1
evidence "security verify-cert (ssl, api.github.com): $(security verify-cert -c "$CERT" -p ssl -s api.github.com 2>&1 | tr '\n' ' ' | cut -c1-200)"
printf '127.0.0.1 api.github.com %s\n' "$HOSTS_MARK" | sudo -n tee -a /etc/hosts >/dev/null || fatal "/etc/hosts maps api.github.com to 127.0.0.1"
HOSTS_MAPPED=1
flush_dns
evidence "api.github.com resolves to: $(dscacheutil -q host -a name api.github.com 2>&1 | grep -i address | tr '\n' ' ')"
# No -k and no --resolve: the system's resolver and the system's trust, as the app's own network sees them. nscurl is
# NSURLSession, the stack the Tauri shell downloads through; it is asked too, and decides when curl's TLS library does
# not read the keychain.
MAPPED_TAG=$(limit 60 /usr/bin/curl -fsS "$LATEST_URL" 2>"$W/curl.err" | jq -r .tag_name 2>/dev/null)
NSCURL_BODY=$(limit 60 nscurl "$LATEST_URL" 2>&1)
evidence "curl (no -k) /releases/latest: tag ${MAPPED_TAG:-none} $(head -c 200 "$W/curl.err" | tr '\n' ' '); nscurl: $(printf '%s' "$NSCURL_BODY" | grep -o '"tag_name": *"[^"]*"' | head -1)$(printf '%s' "$NSCURL_BODY" | grep -i -m1 error | cut -c1-200)"
[ "$MAPPED_TAG" = "v$NEXT_VERSION" ] || printf '%s' "$NSCURL_BODY" | grep -q "\"tag_name\": *\"v$NEXT_VERSION\""
check $? "https://api.github.com/repos/seuput-inc/ompdesk/releases/latest, with the system's resolver and trust (no -k), answers the stand-in's v$NEXT_VERSION"
[ "$FAILED" = 0 ] || exit 1
# The certificate's trust step may log SecurityAgent lines of its own; only lines from here on are the app's.
DIALOGS_BEFORE=$(dialog_lines | wc -l | tr -d ' ')

step "the candidate, opened like a person opens it and left alone with its updater"
open "$APP"; check $? "open $APP"
wait_for candidate_started 180; check $? "the installed candidate $CANDIDATE_VERSION started (app-started.json)"
OLD_PID=$(jq -r .pid "$UD/app-started.json" 2>/dev/null)
evidence "the candidate's processes: $(ps -axo pid=,command= | grep "$APP/" | grep -v grep | cut -c1-160 | head -4 | tr '\n' '|')"
shot 01-candidate-$CANDIDATE_VERSION.png
if ! wait_for check_found 180; then
  evidence "update checks so far: $(update_rows '.message == "check"' | tail -3 | cut -c1-300 | tr '\n' '|')"
  fatal "the candidate's updater found an update (check found)"
fi
FOUND=$(update_rows '.message == "check" and .details.event == "found"' | head -1)
evidence "check found: $(jq -c .details <<<"$FOUND")"
[ "$(jq -r .details.version <<<"$FOUND")" = "$NEXT_VERSION" ]; check $? "check found names $NEXT_VERSION"
[ "$(jq -r .details.current <<<"$FOUND")" = "$CANDIDATE_VERSION" ] && [ "$(jq -r .details.mode <<<"$FOUND")" = relaunch ]; check $? "check found: current $CANDIDATE_VERSION, mode relaunch"
wait_for download_ended 600
download_verified; check $? "download verified (SHA-512 against the feed's metadata, the staged bundle's signature, bundle id and version)"
evidence "download rows: $(update_rows '.message == "download"' | jq -c .details | tr '\n' ' ' | cut -c1-500)"
[ "$FAILED" = 0 ] || exit 1
[ "$(bundle_version "$UD/updates/$NEXT_VERSION/OMPdesk.app")" = "$NEXT_VERSION" ]; check $? "the staged bundle is OMPdesk $NEXT_VERSION (updates/$NEXT_VERSION/OMPdesk.app)"
feed_paths | grep -q '^GET /repos/[^/]*/ompdesk/releases/assets/1$' && feed_paths | grep -q '^GET /download/ompdesk-mac-arm64.dmg$'; check $? "the download went through the stand-in: the API asset's 302 and the file it points at"
# The countdown is 60 s; the install waits for no card and no compaction, which a fresh profile never has.
wait_for swap_helper 300; check $? "the scheduler installed unclicked (swap helper)"
# The relaunched app removes update-install.json once it has reported; this copy is the helper's own.
cp -f "$UD/update-install.json" "$OUT/update-install.json" 2>/dev/null
has_row '.message == "scheduler" and .details.event == "countdown"' && has_row '.message == "scheduler" and .details.event == "install" and .details.trigger == "auto"'; check $? "scheduler countdown, then install with trigger auto"
HELPER=$(update_rows '.message == "swap" and .details.event == "helper"' | head -1)
evidence "swap helper: $(jq -c .details <<<"$HELPER" 2>/dev/null)"
[ "$(jq -r '.details.mode + " " + .details.from + " " + .details.to' <<<"$HELPER" 2>/dev/null)" = "relaunch $CANDIDATE_VERSION $NEXT_VERSION" ]; check $? "swap helper: mode relaunch, from $CANDIDATE_VERSION to $NEXT_VERSION"
[ "$FAILED" = 0 ] || exit 1

step "the swap and the relaunch into $NEXT_VERSION"
wait_for swap_installed 180; check $? "swap.log says installed"
wait_for next_started 240; check $? "app-started.json names $NEXT_VERSION (the new app's first page loaded on the same profile)"
evidence "app-started.json: $(cut -c1-160 "$UD/app-started.json" 2>&1)"
NEW_PID=$(jq -r .pid "$UD/app-started.json" 2>/dev/null)
[ -n "$NEW_PID" ] && [ "$NEW_PID" != "$OLD_PID" ] && kill -0 "$NEW_PID" 2>/dev/null; check $? "the process that started is a new one and is running (pid $NEW_PID, the candidate was $OLD_PID)"
wait_for swap_result 120
RESULT_ROW=$(update_rows '.message == "swap" and .details.event == "result"' | tail -1)
evidence "swap result: $(jq -c .details <<<"$RESULT_ROW" 2>/dev/null)"
[ "$(jq -r .details.outcome <<<"$RESULT_ROW" 2>/dev/null)" = installed ]; check $? "swap result outcome installed"
[ "$(jq -r .pid <<<"$RESULT_ROW" 2>/dev/null)" != "$(jq -r .pid <<<"$HELPER" 2>/dev/null)" ]; check $? "swap result was logged by another process than the one that started the helper (after the relaunch)"
wait_for swap_started 180; check $? "the start-checked helper saw the new app's start mark (swap.log started)"
[ ! -e "$APP.previous" ] && [ ! -e "$APP.updating" ]; check $? "no .previous or .updating bundle is left in /Applications"
[ "$(bundle_version "$APP")" = "$NEXT_VERSION" ]; check $? "/Applications/OMPdesk.app is $NEXT_VERSION (Info.plist CFBundleShortVersionString: $(bundle_version "$APP"))"
codesign --verify --deep --strict "$APP"; check $? "the installed $NEXT_VERSION verifies"
[ "$(codesign -d -r- "$APP" 2>&1 | sed -n 's/^designated => //p')" = "$REQUIREMENT" ]; check $? "the installed $NEXT_VERSION keeps the candidate's designated requirement"
RUNNING=$(app_pids "$APP" | tr '\n' ' ')
[ -n "$RUNNING" ]; check $? "OMPdesk is running from /Applications (pids $RUNNING)"
evidence "the new app's processes: $(ps -axo pid=,command= | grep "$APP/" | grep -v grep | cut -c1-160 | head -4 | tr '\n' '|'); started pid: $(ps -p "${NEW_PID:-0}" -o command= 2>/dev/null | cut -c1-160)"
[ "$(cat "$UD/update-gate-canary.txt" 2>/dev/null)" = "$CANARY" ]; check $? "the canary file in userData survived the update"
[ ! -e "$UD/update-start-failed.json" ]; check $? "no update-start-failed.json (no failed start was recorded)"
shot 02-updated-$NEXT_VERSION.png
DIALOGS_AFTER=$(dialog_lines | wc -l | tr -d ' ')
[ "$DIALOGS_AFTER" = "$DIALOGS_BEFORE" ]; check $? "no keychain or credential dialog while the app ran and updated (SecurityAgent/coreauthd dialog lines: $DIALOGS_BEFORE before the launch, $DIALOGS_AFTER now)"
exit "$FAILED"
