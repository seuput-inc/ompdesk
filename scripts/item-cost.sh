#!/usr/bin/env bash
# From a Linux CI checkout with history through v0.153.0, the repository's JS deps, Rust, Node 24+ and strace:
#   bash scripts/item-cost.sh
# No workflow is triggered. Keep stdout (ITEM_COST_SAMPLE and ITEM_COST_SUMMARY) as the run artifact.
set -euo pipefail
[[ ${CI:-} == true && $(uname -s) == Linux ]] || { echo 'This probe is for Linux CI only.' >&2; exit 2; }
base=8739e83e17
repo=$(git rev-parse --show-toplevel)
cd "$repo"
command -v strace >/dev/null
[[ -x node_modules/.bin/vitest ]] || { echo 'Install the pinned JS dependencies in the CI setup.' >&2; exit 2; }
root=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/item-cost.XXXXXXXX")
trap 'rm -rf -- "$root"' EXIT
mkdir -p "$root/src" "$root/baseline" "$root/ompdesk-bin"
git archive "$base" native/ompdesk resources/gui-bridge/gh-guard-core.ts | tar -x -C "$root/src"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$root/target}"
CARGO_TARGET_DIR=$(realpath -m "$CARGO_TARGET_DIR")
for side in baseline ompdesk-bin; do
  src=$repo; [[ $side != baseline ]] || src=$root/src
  (cd "$src/native/ompdesk" && cargo build --release --locked -p ompdesk-core --bin ompdesk-core)
  cp "$CARGO_TARGET_DIR/release/ompdesk-core" "$root/$side/ompdesk-core"
done
printf 'ITEM_COST_ENV baseline=v0.153.0/%s candidate=%s profile=release pageBytes=%s platform=%s\n' \
  "$(git rev-parse "$base")" "$(git rev-parse HEAD)" "$(getconf PAGESIZE)" "$(uname -smr)"
sha256sum "$root/baseline/ompdesk-core" "$root/ompdesk-bin/ompdesk-core"
node --version; rustc --version; strace -V | head -1
printf '%s\n' 'Raw bytes: completed profile-fd syscalls; core/main stdio JSON lines; app-window IPC socket RX/TX; peer frames with deflate, encryption and header. Not physical disk bytes, SQLite VFS counts, renderer paint, stock execution or network headers. Both sides use the candidate shell/peer transport around their respective Rust host.'
(cd native/ompdesk && cargo test --release --locked -p ompdesk-core --lib \
  agentctl::service::work::tests::item_cost::warm_comment -- --ignored --exact --nocapture) | tee "$root/test-result"
grep -q 'test result: ok. 1 passed;' "$root/test-result"
mkdir -p "$root/home" "$root/tmp"
export HOME="$root/home" TMPDIR="$root/tmp" XDG_CONFIG_HOME="$root/home/config" XDG_DATA_HOME="$root/home/data"
OMPDESK_ITEM_COST_ROOT="$root" node_modules/.bin/vitest run --config scripts/item-cost.config.mjs
