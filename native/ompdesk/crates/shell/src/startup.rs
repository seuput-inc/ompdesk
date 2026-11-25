//! What the shell decides before CEF starts, as pure functions: the user-data folder, the single-instance name, where
//! the app and Node are, which of the shell's own arguments are Chromium switches, and how it was started.

use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};

/// Test seam: a dry run keeps a relaunched app off the person's real profile with this.
pub const USER_DATA_ENV: &str = "OMP_GUI_TEST_USER_DATA_DIR";

/// The running instance checks directories in its own cwd, as its Node child did. Keep the spelling:
/// main refuses relative paths rather than opening them against either launch's cwd.
pub fn second_instance(argv: &[String]) -> serde_json::Value {
    let args = argv.get(1..).unwrap_or_default();
    if let Some(url) = args.iter().find(|arg| arg.starts_with("omp://")) {
        return serde_json::json!({ "kind": "url", "url": url });
    }
    if let Some(path) = args
        .iter()
        .find(|arg| !arg.starts_with('-') && Path::new(arg).is_dir())
    {
        return serde_json::json!({ "kind": "path", "path": path });
    }
    serde_json::json!({ "kind": "focus" })
}

/// `--user-data-dir=<dir>` or `--user-data-dir <dir>` among `args` (the shell's argv after the exe); the last one wins,
/// as Chromium's own switch parsing does.
pub fn user_data_switch(args: &[String]) -> Option<String> {
    let mut found = None;
    let mut i = 0;
    while i < args.len() {
        if let Some(value) = args[i].strip_prefix("--user-data-dir=") {
            found = Some(value.to_string());
        } else if args[i] == "--user-data-dir" && i + 1 < args.len() {
            found = Some(args[i + 1].clone());
            i += 1;
        }
        i += 1;
    }
    found.filter(|v| !v.is_empty())
}

pub fn user_data_override(args: &[String], env_value: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    user_data_switch(args)
        .map(PathBuf::from)
        .or_else(|| env_value.filter(|dir| !dir.is_empty()).map(PathBuf::from))
}

/// The switch, else the test seam's env value, else `default` (Electron's own rule for `app.getPath("userData")`).
pub fn resolve_user_data(args: &[String], env_value: Option<&str>, default: PathBuf) -> PathBuf {
    user_data_override(args, env_value.map(std::ffi::OsStr::new)).unwrap_or(default)
}

/// The folder Electron used for `userData` without a switch: `<roaming app data>\ompdesk` (Windows), `~/Library/Application Support/ompdesk` (macOS).
pub fn default_user_data(roaming_app_data: &Path) -> PathBuf {
    roaming_app_data.join("ompdesk")
}

/// Windows: `\\.\pipe\ompdesk-shell-<first 16 hex digits of SHA-256(lower-cased user-data path)>`. The path is the
/// string as given, lower-cased, so two spellings of one folder differing only in case name one instance.
pub fn pipe_name(user_data: &Path) -> String {
    format!("\\\\.\\pipe\\ompdesk-shell-{}", instance_hash(user_data))
}

/// The first 16 hex digits of SHA-256 over the lower-cased user-data path.
pub fn instance_hash(user_data: &Path) -> String {
    let digest = Sha256::digest(user_data.to_string_lossy().to_lowercase().as_bytes());
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// The longest unix socket path used (`sun_path` is 104 bytes on macOS, 108 on Linux, with the terminating NUL).
const SOCKET_PATH_MAX: usize = 100;

/// A unix socket for `tag`: `ompdesk-<instance hash>-<tag>.sock` in `tmp` (the per-user temp folder), `/tmp` when that
/// would pass `sun_path`'s limit. Never under the profile, whose path can be long (the e2e profiles are); the hash is of the
/// user-data path, so a second launch of the same profile computes the same name, and two profiles never share one.
pub fn unix_socket_path(user_data: &Path, tmp: &Path, tag: &str) -> PathBuf {
    let file = format!("ompdesk-{}-{tag}.sock", instance_hash(user_data));
    let beside = tmp.join(&file);
    if beside.as_os_str().len() <= SOCKET_PATH_MAX {
        return beside;
    }
    Path::new("/tmp").join(file)
}

/// macOS: the unix socket a second launch hands its arguments to.
pub fn socket_path(user_data: &Path) -> PathBuf {
    unix_socket_path(user_data, &std::env::temp_dir(), "shell")
}

/// macOS: the unix socket Node connects to, one per shell process.
pub fn host_socket_path(user_data: &Path, pid: u32) -> PathBuf {
    unix_socket_path(user_data, &std::env::temp_dir(), &format!("host-{pid}"))
}

/// The helper app every CEF helper process starts from, named after the app, not after this executable.
pub const MAC_HELPER_NAME: &str = "OMPdesk Helper";

/// macOS: for the executable `exe` inside an app bundle (`<bundle>/Contents/MacOS/<name>`), the bundle and the helper
/// executable `<bundle>/Contents/Frameworks/OMPdesk Helper.app/Contents/MacOS/OMPdesk Helper`. CEF names its helpers
/// after the running executable, and the launcher layout runs the shell as `ompdesk-shell`, which would look for
/// `ompdesk-shell Helper (GPU).app`: `main_bundle_path` and `browser_subprocess_path` name them explicitly. None for an
/// executable that is not inside a bundle (an unpackaged build).
pub fn mac_bundle_paths(exe: &Path) -> Option<(PathBuf, PathBuf)> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    if macos.file_name()? != "MacOS" || contents.file_name()? != "Contents" {
        return None;
    }
    let bundle = contents.parent()?;
    let helper = contents
        .join("Frameworks")
        .join(format!("{MAC_HELPER_NAME}.app"))
        .join("Contents")
        .join("MacOS")
        .join(MAC_HELPER_NAME);
    Some((bundle.to_path_buf(), helper))
}

/// The folder holding `out/main/index.js`, found by walking up from `start`.
pub fn find_app_dir(start: &Path, exists: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    let mut dir = Some(start);
    while let Some(d) = dir {
        if exists(&d.join("out").join("main").join("index.js")) {
            return Some(d.to_path_buf());
        }
        dir = d.parent();
    }
    None
}

/// A Chromium switch among the shell's arguments: its name without the dashes (`remote-debugging-port`), and its value.
pub fn switch_of(arg: &str) -> Option<(&str, Option<&str>)> {
    let body = arg.strip_prefix("--")?;
    if body.is_empty() || body.starts_with(['-', '=']) {
        return None;
    }
    Some(match body.split_once('=') {
        Some((name, value)) => (name, Some(value)),
        None => (body, None),
    })
}

/// `--remote-debugging-port=<n>` among `args`; `Some(0)` asks Chromium for a free port.
pub fn remote_debugging_port(args: &[String]) -> Option<u16> {
    args.iter().rev().find_map(|arg| match switch_of(arg) {
        Some(("remote-debugging-port", Some(value))) => value.parse().ok(),
        _ => None,
    })
}

/// True when `rel` stays inside its root: only plain names, no `..`, no drive, no root.
pub fn is_plain_relative(rel: &str) -> bool {
    // A drive (`C:`) or a backslash is no plain name on any platform, whatever this one's path rules say.
    !rel.contains([':', '\\'])
        && Path::new(rel)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
}

/// Set by a shell on the shell it spawns for Node's `app.relaunch`, to its own pid; the new shell reads and removes it.
pub const RELAUNCHED_BY_ENV: &str = "OMPDESK_RELAUNCHED_BY";

/// Who started this shell, for the first line of its log.
pub struct Started<'a> {
    pub pid: u32,
    pub parent_pid: Option<u32>,
    /// The parent's executable (a path on macOS, a file name on Windows), while it still runs.
    pub parent: Option<&'a str>,
    /// `RELAUNCHED_BY_ENV` as this process found it.
    pub relaunched_by: Option<&'a str>,
    /// macOS `XPC_SERVICE_NAME`: `application.<bundle id>.…` when LaunchServices opened the app.
    pub xpc_service: Option<&'a str>,
    pub argv: &'a [String],
    /// Wall-clock milliseconds since the Unix epoch (the log's `t` counts from this start only).
    pub at_ms: u64,
}

/// The `shell.started` fields. `via`: `relaunch` (a previous shell started it for Node's `app.relaunch`),
/// `launchservices` (macOS opened the app: Finder, the Dock, `open`, a login item) or `process` (another program ran
/// the executable; `parent` names it: Explorer, a terminal, an installer).
pub fn started_line(started: &Started) -> serde_json::Value {
    let relaunched_by = started.relaunched_by.filter(|s| !s.is_empty());
    let via = if relaunched_by.is_some() {
        "relaunch"
    } else if started
        .xpc_service
        .is_some_and(|s| s.starts_with("application."))
    {
        "launchservices"
    } else {
        "process"
    };
    serde_json::json!({
        "via": via,
        "pid": started.pid,
        "parentPid": started.parent_pid,
        "parent": started.parent,
        "relaunchedBy": relaunched_by,
        "xpcService": started.xpc_service,
        "argv": started.argv,
        "at": started.at_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn second_instance_prefers_the_first_link_over_real_directories() {
        assert_eq!(
            second_instance(&args(&["exe", ".", "omp://new", "omp://session/abc"])),
            serde_json::json!({ "kind": "url", "url": "omp://new" }),
        );
    }

    #[test]
    fn second_instance_checks_directories_and_preserves_the_first_spelling() {
        let dir = std::env::current_dir().unwrap();
        let dir = dir.to_str().unwrap();
        let file = std::env::current_exe().unwrap();
        let file = file.to_str().unwrap();
        for (first, second) in [(".", dir), (dir, ".")] {
            assert_eq!(
                second_instance(&args(&["exe", "--no-sandbox", file, first, second])),
                serde_json::json!({ "kind": "path", "path": first }),
            );
        }
        for argv in [
            vec![],
            args(&[dir, "-flag", file, "not-a-directory/absent"]),
        ] {
            assert_eq!(
                second_instance(&argv),
                serde_json::json!({ "kind": "focus" })
            );
        }
    }

    fn started<'a>(
        relaunched_by: Option<&'a str>,
        xpc: Option<&'a str>,
        argv: &'a [String],
    ) -> Started<'a> {
        Started {
            pid: 20,
            parent_pid: Some(10),
            parent: Some("/Applications/OMPdesk.app/Contents/MacOS/OMPdesk"),
            relaunched_by,
            xpc_service: xpc,
            argv,
            at_ms: 1_700_000_000_000,
        }
    }

    #[test]
    fn the_start_line_says_whether_a_relaunch_launchservices_or_a_program_started_the_shell() {
        let argv = args(&["OMPdesk", "--lang=ko"]);
        let relaunch = started_line(&started(
            Some("4242"),
            Some("application.com.seuput.ompdesk.1.2"),
            &argv,
        ));
        assert_eq!(relaunch["via"], "relaunch");
        assert_eq!(relaunch["relaunchedBy"], "4242");
        let opened = started_line(&started(
            None,
            Some("application.com.seuput.ompdesk.1.2"),
            &argv,
        ));
        assert_eq!(opened["via"], "launchservices");
        assert_eq!(opened["parentPid"], 10);
        assert_eq!(opened["argv"], serde_json::json!(["OMPdesk", "--lang=ko"]));
        let ran = started_line(&started(Some(""), Some("0"), &argv));
        assert_eq!(ran["via"], "process");
        assert_eq!(
            ran["parent"],
            "/Applications/OMPdesk.app/Contents/MacOS/OMPdesk"
        );
        assert_eq!(ran["relaunchedBy"], serde_json::Value::Null);
        assert_eq!(ran["at"], 1_700_000_000_000u64);
    }

    #[test]
    fn user_data_comes_from_the_switch_then_the_seam_then_the_default() {
        let default = PathBuf::from("C:/Users/x/AppData/Roaming/ompdesk");
        assert_eq!(
            resolve_user_data(
                &args(&["--user-data-dir=D:/t"]),
                Some("E:/seam"),
                default.clone()
            ),
            PathBuf::from("D:/t")
        );
        assert_eq!(
            resolve_user_data(&args(&["--user-data-dir", "D:/t2"]), None, default.clone()),
            PathBuf::from("D:/t2")
        );
        assert_eq!(
            resolve_user_data(&args(&[]), Some("E:/seam"), default.clone()),
            PathBuf::from("E:/seam")
        );
        assert_eq!(
            resolve_user_data(&args(&["--foo"]), Some(""), default.clone()),
            default
        );
        assert_eq!(
            resolve_user_data(&args(&["--user-data-dir="]), None, default.clone()),
            default
        );
    }

    #[test]
    fn the_last_user_data_switch_wins_and_a_trailing_bare_one_is_ignored() {
        assert_eq!(
            user_data_switch(&args(&["--user-data-dir=a", "--user-data-dir", "b"])).as_deref(),
            Some("b")
        );
        assert_eq!(user_data_switch(&args(&["--user-data-dir"])), None);
    }

    #[test]
    fn the_pipe_is_named_by_sha256_of_the_lower_cased_path() {
        // sha256("c:\users\x\appdata\roaming\ompdesk"), first 8 bytes.
        let name = pipe_name(Path::new("C:\\Users\\X\\AppData\\Roaming\\ompdesk"));
        assert_eq!(
            name,
            pipe_name(Path::new("c:\\users\\x\\appdata\\roaming\\OMPDESK"))
        );
        assert!(name.starts_with("\\\\.\\pipe\\ompdesk-shell-"));
        assert_eq!(name.len(), "\\\\.\\pipe\\ompdesk-shell-".len() + 16);
        assert!(
            name.rsplit('-')
                .next()
                .unwrap()
                .chars()
                .all(|c| c.is_ascii_hexdigit())
        );
        assert_ne!(name, pipe_name(Path::new("C:\\Users\\X\\other")));
    }

    #[test]
    fn the_instance_hash_is_a_known_sha256_prefix() {
        // printf 'abc' | sha256sum = ba7816bf8f01cfea…
        assert_eq!(instance_hash(Path::new("ABC")), "ba7816bf8f01cfea");
    }

    #[test]
    fn the_app_dir_is_the_nearest_folder_above_holding_the_main_script() {
        let exists = |p: &Path| p == Path::new("/repo/out/main/index.js");
        assert_eq!(
            find_app_dir(Path::new("/repo/resources/ompdesk-shell/win32-x64"), exists),
            Some(PathBuf::from("/repo"))
        );
        assert_eq!(find_app_dir(Path::new("/elsewhere/bin"), exists), None);
    }

    #[test]
    fn switches_are_read_with_and_without_values() {
        assert_eq!(switch_of("--lang=ko"), Some(("lang", Some("ko"))));
        assert_eq!(
            switch_of("--ignore-certificate-errors"),
            Some(("ignore-certificate-errors", None))
        );
        assert_eq!(switch_of("omp://open"), None);
        assert_eq!(switch_of("--"), None);
        assert_eq!(switch_of("--=x"), None);
        assert_eq!(
            remote_debugging_port(&args(&["--remote-debugging-port=0", "--x"])),
            Some(0)
        );
        assert_eq!(
            remote_debugging_port(&args(&[
                "--remote-debugging-port=9222",
                "--remote-debugging-port=9333"
            ])),
            Some(9333)
        );
        assert_eq!(
            remote_debugging_port(&args(&["--remote-debugging-port=nope"])),
            None
        );
    }

    #[test]
    fn a_socket_path_is_short_and_one_per_user_data_folder() {
        let tmp = Path::new("/var/folders/xx/yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy/T");
        let long = Path::new(
            "/var/folders/xx/yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy/T/ompdesk-run-1234-abcdef/omp-gui-smoke-abcdef/desktop",
        );
        let path = unix_socket_path(long, tmp, "shell");
        assert!(path.starts_with(tmp));
        assert!(path.as_os_str().len() <= SOCKET_PATH_MAX);
        assert_eq!(path, unix_socket_path(long, tmp, "shell"));
        assert_ne!(path, unix_socket_path(Path::new("/other"), tmp, "shell"));
        let host = unix_socket_path(long, tmp, "host-77");
        assert_ne!(host, path, "the host socket is another file");
        assert!(host.as_os_str().len() <= SOCKET_PATH_MAX);
        // A temp folder that is itself long falls back to /tmp.
        let long_tmp = Path::new(
            "/var/folders/xx/yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy/T/with/a/very/long/path/of/its/own/that/is/too/much",
        );
        let fallback = unix_socket_path(long, long_tmp, "shell");
        assert!(fallback.starts_with("/tmp"));
        assert!(fallback.as_os_str().len() <= SOCKET_PATH_MAX);
    }

    #[test]
    fn the_mac_helper_is_named_after_the_app_not_the_executable() {
        let (bundle, helper) = mac_bundle_paths(Path::new(
            "/Applications/OMPdesk.app/Contents/MacOS/ompdesk-shell",
        ))
        .unwrap();
        assert_eq!(bundle, Path::new("/Applications/OMPdesk.app"));
        assert_eq!(
            helper,
            Path::new(
                "/Applications/OMPdesk.app/Contents/Frameworks/OMPdesk Helper.app/Contents/MacOS/OMPdesk Helper"
            )
        );
        assert_eq!(
            mac_bundle_paths(Path::new("/work/target/release/ompdesk-shell")),
            None
        );
        assert_eq!(mac_bundle_paths(Path::new("ompdesk-shell")), None);
    }

    #[test]
    fn relative_paths_must_stay_inside() {
        assert!(is_plain_relative("assets/a.js"));
        assert!(!is_plain_relative("../a"));
        assert!(!is_plain_relative("/a"));
        assert!(!is_plain_relative("C:/a"));
    }
}
