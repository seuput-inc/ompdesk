#!/bin/bash
# The packaged macOS app started as a person starts it, through LaunchServices (`open`), and quit as the Dock quits it.
#
#   bash scripts/mac-launch-check.sh <OMPdesk.app>
#
# The bundle's executable is a launcher that starts ompdesk-shell as a process of its own and exits (an `exec` in place hung
# the shell on macOS 27: launcher_main.rs). What that must not change, each an `ok`/`FAILED` line, with EVIDENCE lines:
#  one app   after `open`: one ompdesk-shell, one running application with the bundle id, its pid the shell's, its bundle the
#            app, a regular (Dock) app, the shell its own responsible process (TCC asks for that process's code identity).
#  handover  `open -b com.seuput.ompdesk` and `open <app>` again: still one shell, the same pid, one running application,
#            and it is the frontmost app afterwards (Finder was activated first).
#  quit      three launches, each quit one way: a quit request (`NSRunningApplication.terminate`, what the Dock's Quit sends),
#            then Quit in the menu bar menu and Quit in the tray's menu, each clicked through main's test inspector
#            (scripts/mac-menu-quit.ts: the shim's own `menu.click` delivery, as the shell delivers a person's click).
#            After each, nothing of the bundle and no ompdesk-core is left running.
# No `osascript` or synthetic input: LaunchServices activates Finder (`open -a`) and AppKit sends the quit, so no Automation
# consent is asked. The default profile, so a launch with no arguments finds the same single-instance name (runner homes
# are fresh), and the fake omp (scripts/shell-move/fake-omp.ts), so a tab starts without an install.
set -uo pipefail
APP=$(cd "${1:?usage: mac-launch-check.sh <OMPdesk.app>}" && pwd)
REPO=$(cd "$(dirname "$0")/.." && pwd)
ID=com.seuput.ompdesk
W=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/launch-check.XXXXXX")
UD="$HOME/Library/Application Support/ompdesk"
FAILED=0
evidence() { echo "EVIDENCE: $*"; }
check() { if [ "$1" = 0 ]; then echo "ok $2"; else echo "FAILED $2"; FAILED=1; fi; }
wait_for() { local n=0; while [ $n -lt "$2" ]; do eval "$1" && return 0; sleep 1; n=$((n+1)); done; return 1; }

# A profile an earlier step left (the smoke's host keeps WebKit data there) goes aside: this launch's must be fresh.
[ ! -e "$UD" ] || mv "$UD" "$W/profile-before"
mkdir -p "$UD"
printf '{"language":"en","firstRunComplete":true}\n' > "$UD/prefs.json"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP"

# What AppKit and the kernel say of the bundle's processes; `quit` asks each to quit.
cat > "$W/apps.swift" <<'SWIFT'
import AppKit
let apps = NSRunningApplication.runningApplications(withBundleIdentifier: "com.seuput.ompdesk")
if CommandLine.arguments.dropFirst().first == "quit" {
	for app in apps { print("terminate \(app.processIdentifier) \(app.terminate())") }
	exit(0)
}
for app in apps {
	print("app \(app.processIdentifier) \(app.activationPolicy.rawValue) \(app.bundleURL?.path ?? "-")")
}
print("front \(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0)")
SWIFT
swiftc -O -o "$W/apps" "$W/apps.swift" || { echo "FAILED swiftc"; exit 1; }
cat > "$W/resp.c" <<'C'
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
extern pid_t responsibility_get_pid_responsible_for_pid(pid_t);
int main(int argc, char **argv) {
	pid_t pid = atoi(argv[1]), owner = responsibility_get_pid_responsible_for_pid(pid);
	char path[PROC_PIDPATHINFO_MAXSIZE] = "";
	proc_pidpath(owner, path, sizeof path);
	printf("%d %s\n", owner, path[0] ? path : "(gone)");
	return 0;
}
C
clang -o "$W/resp" "$W/resp.c" || { echo "FAILED clang"; exit 1; }

FAKE_DIR=$W/fake-omp
(cd "$REPO" && exec bun scripts/shell-move/fake-omp.ts "$FAKE_DIR") >"$W/fake-omp.out" 2>&1 &
FAKE_HOLDER=$!
wait_for "test -s '$FAKE_DIR/bin.txt'" 60; check $? "the fake omp is installed"
launchctl setenv OMP_GUI_OMP "$(cat "$FAKE_DIR/bin.txt")"
cleanup() {
	launchctl unsetenv OMP_GUI_OMP
	launchctl unsetenv OMP_GUI_TEST_NODE_INSPECT
	kill "$FAKE_HOLDER" 2>/dev/null
	pkill -f "$APP/Contents/" 2>/dev/null
}
trap cleanup EXIT

shells() { pgrep -f "^$APP/Contents/MacOS/ompdesk-shell" | sort; }
leftovers() { ps -axo pid=,command= | grep -F -e "$APP/Contents/" -e "ompdesk-core" | grep -v -e grep -e mac-launch-check; }

for name in OMPdesk ompdesk-shell; do
	evidence "signature $name: $(codesign -dv --verbose=4 "$APP/Contents/MacOS/$name" 2>&1 | grep -E '^(Identifier|TeamIdentifier|Authority)=' | tr '\n' ' ')"
	evidence "designated $name: $(codesign -d -r- "$APP/Contents/MacOS/$name" 2>&1 | grep designated)"
done

# What main logged, for a launch that did not start: the start mark is written only once the first window's page loaded.
startup_log() {
	grep -v '"source":"startup-timing"' "$UD/logs/gui-runtime.jsonl" 2>/dev/null | tail -n 8 | cut -c1-1500 | tr '\n' '|'
}

open "$APP"
wait_for "test -s '$UD/app-started.json'" 180
STARTED=$?
check $STARTED "the app started through open (app-started.json)"
[ "$STARTED" = 0 ] || evidence "first launch: runtime log: $(startup_log)"
SHELL_PID=$(shells)
[ "$(echo "$SHELL_PID" | grep -c .)" = 1 ]; check $? "one ompdesk-shell runs ($(echo $SHELL_PID))"
[ -z "$(pgrep -fx "$APP/Contents/MacOS/OMPdesk")" ]; check $? "the launcher has exited"
APPS=$("$W/apps")
evidence "running applications: $(echo "$APPS" | tr '\n' '|')"
[ "$(echo "$APPS" | grep -c '^app ')" = 1 ]; check $? "one running application has the bundle id"
echo "$APPS" | grep -qx "app $SHELL_PID 0 $APP"; check $? "it is the shell ($SHELL_PID), a regular app, of $APP"
RESP=$("$W/resp" "$SHELL_PID")
evidence "responsible for the shell: $RESP"
[ "$RESP" = "$SHELL_PID $APP/Contents/MacOS/ompdesk-shell" ]; check $? "the shell is its own responsible process"
evidence "lsappinfo: $(lsappinfo list 2>/dev/null | grep -c "bundleID=\"$ID\"") entries with the bundle id"

# A second launch hands over to the running app: what runs is sampled while it settles.
handover() {
	local label=$1; shift
	open -a Finder
	sleep 2
	"$@"
	local most=0 count n=0
	while [ $n -lt 30 ]; do
		count=$(shells | grep -c .)
		[ "$count" -gt "$most" ] && most=$count
		sleep 0.5
		n=$((n+1))
	done
	evidence "$label: most shells seen at once while it settled: $most"
	[ "$(shells)" = "$SHELL_PID" ]; check $? "$label: the same one shell runs"
	APPS=$("$W/apps")
	evidence "$label: $(echo "$APPS" | tr '\n' '|')"
	[ "$(echo "$APPS" | grep -c '^app ')" = 1 ]; check $? "$label: one running application"
	echo "$APPS" | grep -qx "front $SHELL_PID"; check $? "$label: it is the frontmost app"
}
handover "open -b $ID" open -b "$ID"
handover "open $APP" open "$APP"

evidence "quit request: $("$W/apps" quit | tr '\n' ' ')"
wait_for '[ -z "$(leftovers)" ]' 60; check $? "after the quit request nothing of the bundle and no ompdesk-core runs"
evidence "left: $(leftovers | cut -c1-200 | tr '\n' '|')"

# The inspector's port: main's Node listens on a free one (`--inspect=127.0.0.1:0`); the one that answers /json/list.
inspector_port() {
	local node port
	node=$(pgrep -f "^$APP/Contents/.*Resources/node/node" | head -1)
	[ -n "$node" ] || return 1
	for port in $(lsof -nP -a -p "$node" -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1 { sub(/.*:/, "", $9); print $9 }'); do
		curl -s "http://127.0.0.1:$port/json/list" | grep -q webSocketDebuggerUrl && { echo "$port"; return 0; }
	done
	return 1
}
# A launch with main's test inspector on, quit by clicking Quit in one menu (`app`: the menu bar's, `tray`: the tray's).
menu_quit() {
	local where=$1 port
	rm -f "$UD/app-started.json"
	open "$APP"
	wait_for "test -s '$UD/app-started.json'" 180
	local started=$?
	check $started "$where: the app started again"
	[ "$started" = 0 ] || evidence "$where: runtime log: $(startup_log)"
	wait_for 'port=$(inspector_port)' 60; check $? "$where: main's inspector answers (port ${port:-none})"
	wait_for "bun '$REPO/scripts/mac-menu-quit.ts' '$port' '$where' > '$W/quit-$where.out' 2>&1" 30
	check $? "$where: Quit clicked in the menu"
	evidence "$where: $(tr '\n' ' ' < "$W/quit-$where.out" | cut -c1-400)"
	wait_for '[ -z "$(leftovers)" ]' 60; check $? "$where: after its Quit nothing of the bundle and no ompdesk-core runs"
	evidence "$where: left: $(leftovers | cut -c1-200 | tr '\n' '|')"
	pkill -f "$APP/Contents/" 2>/dev/null
}
launchctl setenv OMP_GUI_TEST_NODE_INSPECT 1
menu_quit app
menu_quit tray
launchctl unsetenv OMP_GUI_TEST_NODE_INSPECT
exit $FAILED
