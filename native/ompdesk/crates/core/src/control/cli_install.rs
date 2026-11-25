//! Install launchers pointing at this copy of the CLI. Only a marked launcher in Bun's bin is ours to replace.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use super::{blocking, endpoint::RENAME_RETRY_MS};
use crate::disk::tree;
use crate::server::{Call, Fault, Reply, Scope};

const MARKER: &str = "ompdesk CLI launcher, written by OMPdesk";

// Under WSL, Windows holds the slot while Linux runs the command. Only this shell keeps fd 3 open.
const WINDOWS_SH: &str = r#"
if [ -z "$WSL_DISTRO_NAME" ] || ! command -v wslpath >/dev/null 2>&1; then
	exec "$exe" "$@"
fi
exe=$(wslpath -u "$exe") || exit 1
case ":$WSLENV:" in
*:OMPDESK_HEAVY_HELD:*) ;;
::) WSLENV=OMPDESK_HEAVY_HELD ;;
*) WSLENV="$WSLENV:OMPDESK_HEAVY_HELD" ;;
esac
export WSLENV
if [ "$1" != run ] || [ "$2" != --heavy ]; then
	exec "$exe" "$@"
fi
shift 2
all=
if [ "$1" = --all ]; then all=--all; shift; fi
if [ "$1" = -- ]; then shift; fi
if [ $# -eq 0 ]; then exec "$exe" run --heavy $all; fi
fifos=$(mktemp -d) || exit 1
mkfifo "$fifos/in" "$fifos/out" || exit 1
"$exe" heavy hold $all <"$fifos/in" >"$fifos/out" &
hold=$!
exec 3>"$fifos/in" 4<"$fifos/out"
rm -rf "$fifos"
held=
read -r held <&4
held=$(printf '%s' "$held" | tr -d '\r')
case $held in
"held reused") ;;
"unlimited") unset OMPDESK_HEAVY_HELD ;;
"held "*" pid "*) OMPDESK_HEAVY_HELD=$(printf '%s' "$held" | sed 's/.* pid //'); export OMPDESK_HEAVY_HELD ;;
*) exec 3>&-; wait "$hold"; code=$?; [ $code -eq 0 ] && code=1; exit $code ;;
esac
"$@" 3>&- 4<&-
code=$?
exec 3>&- 4<&-
wait "$hold"
exit $code
"#;

fn launchers(binary: &str, windows: bool) -> (String, Option<String>) {
    let suffix = if windows { WINDOWS_SH } else { " \"$@\"\n" };
    let mut sh = String::with_capacity(32 + MARKER.len() + binary.len() + suffix.len());
    sh.push_str("#!/bin/sh\n# ");
    sh.push_str(MARKER);
    sh.push_str(if windows { "\nexe='" } else { "\nexec '" });
    for ch in binary.chars() {
        match ch {
            '\'' => sh.push_str("'\\''"),
            '\\' if windows => sh.push('/'),
            _ => sh.push(ch),
        }
    }
    sh.push('\'');
    sh.push_str(suffix);
    let cmd = windows.then(|| format!("@echo off\r\nrem {MARKER}\r\n\"{binary}\" %*\r\n"));
    (sh, cmd)
}

fn place(file: &Path, content: &str, foreign_wins: bool, scope: &Scope) -> Result<bool, Fault> {
    tree::live(scope)?;
    match fs::read(file) {
        Ok(current) => {
            if current == content.as_bytes() {
                return Ok(true);
            }
            if foreign_wins
                && !current
                    .windows(MARKER.len())
                    .any(|part| part == MARKER.as_bytes())
            {
                return Ok(false);
            }
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {
            // A dangling foreign link is still someone's launcher.
            if foreign_wins {
                match fs::symlink_metadata(file) {
                    Err(error) if error.kind() == ErrorKind::NotFound => {}
                    Ok(_) => return Ok(false),
                    Err(error) => return Err(tree::fault(&error, "lstat", file)),
                }
            }
        }
        Err(error) => return Err(tree::fault(&error, "open", file)),
    }
    tree::write_atomic_with_retries(
        file,
        content.as_bytes(),
        Some(0o755),
        0o755,
        &|| !scope.cancelled(),
        &RENAME_RETRY_MS,
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Install {
    binary: String,
    windows: bool,
    app_bin: PathBuf,
    bun_bin: Option<PathBuf>,
}

pub(super) async fn install(call: Call) -> Result<Reply, Fault> {
    let args: Install = call.params()?;
    blocking(move || {
        let (sh, cmd) = launchers(&args.binary, args.windows);
        let files = |dir: &Path, foreign_wins| {
            let write = |name, content: &str| {
                let file = dir.join(name);
                place(&file, content, foreign_wins, &call.scope).unwrap_or_else(|error| {
                    eprintln!("[cli-install] {}: {}", file.display(), error.message);
                    false
                })
            };
            let sh_ok = write("ompdesk", &sh);
            let cmd_ok = cmd.as_ref().is_none_or(|cmd| write("ompdesk.cmd", cmd));
            sh_ok && cmd_ok
        };
        let mut written = Vec::with_capacity(2);
        if files(&args.app_bin, false) {
            written.push(args.app_bin);
        }
        if let Some(dir) = args.bun_bin
            && dir.exists()
            && files(&dir, true)
        {
            written.push(dir);
        }
        Reply::json(&written)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[test]
    fn launcher_bytes_match_the_typescript_installer() {
        let (sh, cmd) = launchers("/App Support's/ompdesk", false);
        assert!(cmd.is_none());
        let (win_sh, cmd) = launchers(r"C:\Program Files\O'MP\ompdesk-bin\ompdesk.exe", true);
        for (bytes, expected) in [
            (
                sh,
                "6bbf548b92112920692979887e2a1f8a5b1dda53c28d7cd574c454201322c456",
            ),
            (
                win_sh,
                "1d5ae99b5facbaac6a19cc0bee086a83f3d3b5b0c598a794ccbbd487b0606995",
            ),
            (
                cmd.unwrap(),
                "e425fd8fcb7b8c53dbcf29e7e775f77accb09d5bedf5919139820d2252e59c6e",
            ),
        ] {
            assert_eq!(crate::hex(&Sha256::digest(bytes.as_bytes())), expected);
        }
    }
}
