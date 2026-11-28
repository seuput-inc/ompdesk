use std::io;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use tokio::io::AsyncReadExt;

use super::invalid;

#[derive(Clone)]
pub(super) struct Target {
    pub(super) exe: PathBuf,
    pub(super) id: String,
}

// No user profile, dotenv, project shell, inherited PATH or interpolated argument is evaluated.
const OPERATION: &str = r#"set -eu
export PATH=/usr/bin:/bin LC_ALL=C
uid=$(id -u)
[ "$uid" != 0 ] && [ "$uid" = "$2" ] || exit 1
HOME=$(getent passwd "$uid" | cut -d: -f6)
[ "$HOME" = "$1" ] || exit 1
export HOME
# Script selection always starts with the host's installed package, never a path from a guest reply.
scripts=$(/usr/bin/wslpath -a -u "$3")/wsl
op=$4
shift 4
case $op in
run)
    case $2 in /*) p=$2;; *) p=$(/usr/bin/wslpath -a -u "$2");; esac
    [ "$(realpath -e -- "$p")" = "$3" ] || exit 1
    exec /bin/sh "$scripts/supervisor.sh" run "$1";;
stop) exec /bin/sh "$scripts/supervisor.sh" stop "$@";;
esac
[ "$(/bin/sh "$scripts/supervisor.sh" state "$1" "$2" "$3")" = owned ] || exit 1
bun=$HOME/.bun/bin/bun
bunfig=/run/user/$uid/ompdesk/$1/bunfig.toml
case $op in
bridge)
    n=0
    while [ ! -S "/run/user/$uid/ompdesk/$1/bridge.sock" ]; do
        [ "$n" -lt 100 ] || exit 1
        n=$((n+1)); sleep 0.1
    done
    exec "$bun" --no-env-file --no-install "--config=$bunfig" "$scripts/bridge-relay.ts" "$1";;
checkpoint)
    exec /usr/bin/timeout --kill-after=1s 120s "$bun" --no-env-file --no-install "--config=$bunfig" "$scripts/checkpoint.ts" "$4" "$1" "$5" "$6";;
*) exit 1;;
esac"#;

impl Target {
    fn command(&self, script: &'static str) -> Command {
        let system = self.exe.parent().expect("absolute WSL launcher");
        let mut cmd = Command::new(&self.exe);
        cmd.current_dir(system)
            .env_clear()
            .args([
                "--distribution-id",
                &self.id,
                "--cd",
                "/",
                "--exec",
                "/usr/bin/env",
                "-i",
                "/bin/sh",
                "-c",
                script,
                "sh",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.env("SystemRoot", system.parent().expect("System32 parent"))
                .env("WSLENV", "")
                .creation_flags(0x0800_0000);
        }
        cmd
    }

    pub(super) fn operation(
        &self,
        home: &str,
        uid: u32,
        bridge: &str,
        op: &str,
        args: &[&str],
    ) -> Command {
        let mut cmd = self.command(OPERATION);
        cmd.args([home, &uid.to_string(), bridge, op]).args(args);
        cmd
    }

    #[cfg(any(windows, all(test, unix)))]
    pub(super) fn prepare(&self, project: &str, bridge: &str) -> Command {
        const PATHS: &str = r#"set -eu
export PATH=/usr/bin:/bin LC_ALL=C
uid=$(id -u)
[ "$uid" != 0 ]
home=$(getent passwd "$uid" | cut -d: -f6)
[ -d "$home" ] && [ "$(realpath -e -- "$home")" = "$home" ] || exit 1
path() {
    case $1 in /*) p=$1;; *) p=$(/usr/bin/wslpath -a -u "$1") || return 1;; esac
    [ -d "$p" ] && realpath -e -- "$p"
}
project=$(path "$1")
bridge=$(path "$2")
printf '%s\n' "$uid" "$home" "$project" "$bridge""#;
        let mut cmd = self.command(PATHS);
        cmd.args([project, bridge]);
        cmd
    }
}

pub(super) async fn output(command: Command, limit: usize) -> io::Result<Vec<u8>> {
    let mut child = tokio::process::Command::from(command)
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let mut stdout = child
        .stdout
        .take()
        .expect("piped stdout")
        .take(limit as u64 + 1);
    let mut out = Vec::new();
    stdout.read_to_end(&mut out).await?;
    if out.len() > limit {
        return Err(invalid("Oversized WSL response"));
    }
    if !child.wait().await?.success() {
        return Err(invalid("WSL operation refused"));
    }
    Ok(out)
}

pub(super) fn basename(name: &str) -> bool {
    super::super::guest_state::valid_name(name) && name.len() <= 255
}

#[cfg(any(windows, test))]
pub(super) fn guest_path(path: &str) -> bool {
    path == "/"
        || path.strip_prefix('/').is_some_and(|s| {
            !s.contains('\\')
                && !s.chars().any(char::is_control)
                && s.split('/').all(|p| !matches!(p, "" | "." | ".."))
        })
}

// Only drive paths and the *registered* distro's WSL UNC path enter path resolution. Never contact
// another UNC server (including through verbatim syntax), traverse a device name, or open an ADS.
#[cfg(any(windows, test))]
pub(super) fn translate(path: &str, distro: &str) -> io::Result<String> {
    let err = || {
        invalid(
            "Expected an absolute project path in the registered WSL distribution or on a local drive",
        )
    };
    let path = path.replace('/', "\\");
    if path.chars().any(char::is_control) {
        return Err(err());
    }
    let raw = path.strip_prefix(r"\\?\").unwrap_or(&path);
    let unc = if raw.len() < path.len() {
        raw.strip_prefix(r"UNC\")
    } else {
        raw.strip_prefix(r"\\")
    };
    let (mut translated, rest) = if let Some(unc) = unc {
        let mut parts = unc.splitn(3, '\\');
        if !parts.next().is_some_and(|s| {
            s.eq_ignore_ascii_case("wsl.localhost") || s.eq_ignore_ascii_case("wsl$")
        }) || !parts.next().is_some_and(|s| s.eq_ignore_ascii_case(distro))
        {
            return Err(err());
        }
        (String::from("/"), parts.next().unwrap_or(""))
    } else {
        let bytes = raw.as_bytes();
        if bytes.len() < 3 || !bytes[0].is_ascii_alphabetic() || &bytes[1..3] != b":\\" {
            return Err(err());
        }
        (raw[..3].to_owned(), &raw[3..])
    };
    let rest = rest.strip_suffix('\\').unwrap_or(rest);
    if !rest.is_empty() {
        for part in rest.split('\\') {
            let device = part
                .split('.')
                .next()
                .unwrap_or_default()
                .trim_end_matches(' ');
            if part.is_empty()
                || part.ends_with([' ', '.'])
                || part.contains([':', '*', '?', '"', '<', '>', '|'])
                || ["con", "prn", "aux", "nul", "conin$", "conout$", "clock$"]
                    .iter()
                    .any(|s| device.eq_ignore_ascii_case(s))
                || (device.get(..3).is_some_and(|s| {
                    s.eq_ignore_ascii_case("com") || s.eq_ignore_ascii_case("lpt")
                }) && device
                    .get(3..)
                    .is_some_and(|s| s.chars().count() == 1 && "0123456789¹²³".contains(s)))
            {
                return Err(err());
            }
        }
        if translated == "/" {
            translated.push_str(&rest.replace('\\', "/"));
        } else {
            translated.push_str(rest);
        }
    }
    Ok(translated)
}

#[cfg(windows)]
pub(super) fn resolve(
    reg: &crate::wsl_copy::Registration,
    supplied: &std::path::Path,
) -> io::Result<(Target, String, String)> {
    use crate::sys::wsl;
    use std::path::Path;

    let err = || invalid("Cannot establish the registered WSL host and packaged bridge");
    if !crate::setup::wsl::guid(&reg.distro) {
        return Err(err());
    }
    let registrations = wsl::inventory()?.distributions;
    let distro = registrations
        .iter()
        .find(|d| d.version == 2 && reg.distro.eq_ignore_ascii_case(&d.id))
        .ok_or_else(err)?;
    if registrations
        .iter()
        .filter(|d| d.name.eq_ignore_ascii_case(&distro.name))
        .count()
        != 1
    {
        return Err(err());
    }
    let clean = |p: &Path| translate(p.to_str().ok_or_else(err)?, &distro.name);
    let requested = Path::new(&reg.cwd);
    clean(requested)?;
    let canonical = requested.canonicalize()?;
    if !canonical.is_dir() {
        return Err(err());
    }
    let project = clean(&canonical)?;

    let exe = std::env::current_exe()?.canonicalize()?;
    let bin = exe.parent().ok_or_else(err)?;
    let bin = if bin.ends_with("win32-x64") {
        bin.parent().ok_or_else(err)?
    } else {
        bin
    };
    if !bin.ends_with("ompdesk-bin") {
        return Err(err());
    }
    let expected = bin.parent().ok_or_else(err)?.join("gui-bridge");
    let bridge = clean(&expected)?;
    if bridge.starts_with('/')
        || !bridge.eq_ignore_ascii_case(&clean(supplied)?)
        || expected.canonicalize()? != expected
    {
        return Err(err());
    }
    for name in [
        "index.ts",
        "wsl/supervisor.sh",
        "wsl/launch.ts",
        "wsl/bridge-relay.ts",
        "wsl/checkpoint.ts",
    ] {
        let script = expected.join(name);
        if !script.is_file() || script.canonicalize()? != script {
            return Err(err());
        }
    }
    Ok((
        Target {
            exe: wsl::system_directory()?.join("wsl.exe"),
            id: distro.id.clone(),
        },
        project,
        bridge,
    ))
}
