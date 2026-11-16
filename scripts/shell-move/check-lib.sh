#!/bin/bash
# check-lib.sh: the three lines every runner check prints its verdict with (sourced by mac-common.sh and release-assets.sh).
# `check <status> <what>` prints "ok:" or "FAILED:" and sets FAILED; `evidence` and `step` print what the job summary greps
# (shell-batch-checks.yml: ^EVIDENCE, ^ok, ^FAILED). The script ends with `exit $FAILED`.
FAILED=0
step() { echo; echo "=== $*"; }
check() { if [ "$1" = 0 ]; then echo "ok: $2"; else echo "FAILED: $2"; FAILED=1; fi; }
evidence() { echo "EVIDENCE: $*"; }
