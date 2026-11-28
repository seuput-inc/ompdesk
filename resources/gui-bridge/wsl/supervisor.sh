#!/bin/sh
# The host calls this packaged file by absolute path. stdin/stdout belong to stock after admission.
set -eu
export PATH=/usr/bin:/bin LC_ALL=C
cd /

fail() { printf '%s\n' "$1" >&2; exit 1; }
hex_id() { [ "${#1}" -eq 32 ] && case $1 in *[!0-9a-f]*) false;; *) true;; esac; }
[ "$#" -ge 2 ] && hex_id "$2" || fail 'Invalid guest spawn ID.'
unit="ompdesk-$2.service"
uid=$(id -u)
[ "$uid" != 0 ] || fail 'WSL session requires a non-root guest user.'
export XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus"

# A missing unit is evidence only after the host witnessed and recorded admission to that unit.
state() {
    info=$(systemctl --user show --property=LoadState,ActiveState,SubState,InvocationID,Job,ControlGroup,MainPID "$unit") || return 1
    load=? active=? sub=? invocation=? job=? cgroup=? main=?
    while IFS='=' read -r key value; do
        case $key in
            LoadState) load=$value;; ActiveState) active=$value;; SubState) sub=$value;;
            InvocationID) invocation=$value;; Job) job=$value;; ControlGroup) cgroup=$value;; MainPID) main=$value;;
        esac
    done <<EOF
$info
EOF
    if [ "$load/$active/$sub/$job/$cgroup/$main" = 'not-found/inactive/dead///0' ] && [ -z "$invocation" ]; then
        printf 'stopped\n'
    elif [ "$load" = loaded ] && [ "$invocation" = "$1" ]; then
        printf 'owned\n'
    else
        return 1
    fi
}

case $1 in
    run)
        [ "$#" = 2 ] || fail 'Unexpected guest launch arguments.'
        case $0 in /*/*) script=${0%/*}/launch.ts;; *) fail 'A packaged guest launcher is required.';; esac
        home=$(getent passwd "$uid" | cut -d: -f6)
        case $home in /*) ;; *) fail 'No guest user home.';; esac
        # systemd supplies INVOCATION_ID to the service. No other manager or Windows environment enters Bun.
        exec systemd-run --user --quiet --wait --pipe --collect --expand-environment=no --service-type=exec --unit="$unit" \
            --property=ExitType=cgroup --property=KillMode=control-group --property=TimeoutStopSec=5s \
            /bin/sh -c 'exec /usr/bin/env -i HOME="$1" PATH=/usr/bin:/bin XDG_RUNTIME_DIR="$3" INVOCATION_ID="$INVOCATION_ID" "$1/.bun/bin/bun" --no-env-file "$2" "$4"' sh "$home" "$script" "$XDG_RUNTIME_DIR" "$2"
        ;;
    state|stop)
        [ "$#" = 4 ] && hex_id "$3" || fail 'A witnessed guest invocation and UID are required.'
        [ "$uid" = "$4" ] || fail 'Guest process state is unknown for this user.'
        result=$(state "$3") || fail 'Guest process state is unknown.'
        if [ "$1" = stop ] && [ "$result" = owned ]; then
            # A natural exit can race the stop. Only the following read proves it ended.
            systemctl --user stop "$unit" >/dev/null 2>&1 || :
            result=$(state "$3") || fail 'Guest stop could not be confirmed.'
            [ "$result" = stopped ] || fail 'Guest stop could not be confirmed.'
        fi
        printf '%s\n' "$result"
        ;;
    *) fail 'Unknown guest supervisor operation.';;
esac
