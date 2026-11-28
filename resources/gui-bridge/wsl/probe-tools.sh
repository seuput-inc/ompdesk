#!/bin/sh
# The caller starts /bin/sh -s with an empty environment and supplies only this script.
set -eu
export PATH=/usr/bin:/bin LC_ALL=C
cd /proc/self
uid=$(id -u)
[ "$uid" != 0 ] || exit 1
# WSL interop can run a Windows binary even when the guest symlink has no .exe suffix.
elf() { [ -f "$1" ] && [ -x "$1" ] && [ "$(od -An -N4 -tx1 -- "$1" | tr -d ' \n')" = 7f454c46 ]; }
git=null
if elf /usr/bin/git && line=$(/usr/bin/git --version 2>/dev/null); then
    case $line in 'git version '*)
        version=${line#git version }
        case $version in ''|*[!0-9A-Za-z.+-]*) ;; [0-9]*.[0-9]*) git="\"$version\"";; esac
    esac
fi
home=$(getent passwd "$uid" | cut -d: -f6)
case $home in /|/mnt/*|'') exit 1;; /*) ;; *) exit 1;; esac
bun=$home/.bun/bin/bun
if ! elf "$bun"; then
    printf '{"git":%s,"bun":null,"omp":null,"enginesBun":null,"launchable":false}\n' "$git"
    exit 0
fi
# No package imports, project cwd, dotenv, global bunfig, or user shell startup files.
exec /usr/bin/env -i PATH=/usr/bin:/bin HOME=/dev/null "$bun" --no-install --no-env-file -e '
const fs = require("node:fs");
const [home, git] = process.argv.slice(1);
if (process.platform !== "linux" || !process.versions.bun) process.exit(1);
const result = {git: JSON.parse(git), bun: process.versions.bun, omp: null, enginesBun: null, launchable: false};
const pkg = home + "/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent";
const uid = process.getuid();
function owned(path, directory) {
    const real = fs.realpathSync(path), st = fs.lstatSync(real);
    if (directory ? real !== home || !st.isDirectory() : !real.startsWith(home + "/") || !st.isFile()) throw Error();
    if (st.uid !== uid || st.mode & 0o022) throw Error();
    if (![0xef53, 0x58465342, 0x9123683e, 0xf2f52010, 0x01021994].includes(fs.statfsSync(real).type >>> 0)) throw Error();
    return real;
}
try {
    owned(home, true);
    const m = JSON.parse(fs.readFileSync(owned(pkg + "/package.json", false), "utf8"));
    if (m.name === "@oh-my-pi/pi-coding-agent" && typeof m.version === "string" && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(m.version)) {
        result.omp = m.version;
        const engine = m.engines?.bun;
        if (typeof engine === "string" && /^\s*>=\s*v?\d+\.\d+\.\d+\s*$/.test(engine)) result.enginesBun = engine;
        owned(pkg + "/dist/cli.js", false);
        result.launchable = uid !== 0 && result.enginesBun !== null;
    }
} catch { /* No launchable package at the fixed guest path. */ }
console.log(JSON.stringify(result));
' "$home" "$git"
