#!/bin/bash
app_pids() {
  local processes
  processes=$(ps -axo pid=,command=) || return 1
  printf '%s\n' "$processes" | awk -v app="$1/" '{ pid=$1; sub(/^[[:space:]]*[0-9]+[[:space:]]+/, ""); if (index($0, app) == 1) print pid }'
}
stop_app() {
  local app=$1 owned_pid=${2:-} pids pid n=0 signalled
  pids=$(app_pids "$app") || { evidence "stop failed: cannot list processes"; return 1; }
  signalled=$pids
  if [ -n "$owned_pid" ] && kill -0 "$owned_pid" 2>/dev/null; then
    case " $pids " in *" $owned_pid "*) ;; *) pids="$pids $owned_pid";; esac
    signalled=$pids
  fi
  for pid in $pids; do
    kill -TERM "$pid" 2>/dev/null || {
      kill -0 "$pid" 2>/dev/null && { evidence "stop failed: pid $pid still running"; return 1; }
    }
  done
  while :; do
    pids=$(app_pids "$app") || { evidence "stop failed: cannot list processes"; return 1; }
    if [ -n "$owned_pid" ] && kill -0 "$owned_pid" 2>/dev/null; then pids="$pids $owned_pid"; fi
    if [ -z "$pids" ]; then evidence "stopped $app; signalled pids: ${signalled:-none}"; return 0; fi
    if [ "$n" -ge 30 ]; then
      evidence "stop failed: $app still has pids $(echo "$pids" | tr '\n' ' ')"
      ps -p "$(echo "$pids" | paste -sd, -)" -o pid=,ppid=,stat= 2>/dev/null | head -20 | sed 's/^/EVIDENCE: stop process: /'
      return 1
    fi
    sleep 3
    n=$((n+3))
  done
}
