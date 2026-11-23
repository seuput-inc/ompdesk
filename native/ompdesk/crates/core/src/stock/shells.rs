use std::{env, fs, path::Path};

use serde::Serialize;

use crate::fs::order::js_trim;
use crate::fs::path::normalize_win32;
use crate::server::{Fault, Registry, Reply};

#[derive(Serialize)]
pub(super) struct Shell {
    pub(super) path: String,
    name: String,
    args: &'static [&'static str],
}

pub(super) fn register(registry: &mut Registry) {
    registry.add("terminal.shells", |_| {
        Box::pin(async {
            let shells = tokio::task::spawn_blocking(list)
                .await
                .map_err(|error| Fault::new("internal", error.to_string()))?;
            Reply::json(&shells)
        })
    });
}

pub(super) fn list() -> Vec<Shell> {
    let listed = if cfg!(windows) {
        Vec::new()
    } else {
        fs::read("/etc/shells").unwrap_or_default()
    };
    probe(
        cfg!(windows),
        |key| env::var_os(key).map(|value| value.to_string_lossy().into_owned()),
        &String::from_utf8_lossy(&listed),
        |file| Path::new(file).exists(),
    )
}

fn win_join(root: &str, suffix: &str) -> String {
    if root.is_empty() {
        return suffix.to_owned();
    }
    // win32.join preserves an initial double separator only for a UNC server.
    let tail = root.trim_start_matches(['/', '\\']);
    if tail.is_empty() {
        return format!(r"\{suffix}");
    }
    if root.len() - tail.len() > 2 {
        return normalize_win32(&format!(r"\{tail}\{suffix}"));
    }
    normalize_win32(&format!(r"{root}\{suffix}"))
}

fn probe(
    windows: bool,
    env: impl Fn(&str) -> Option<String>,
    listed: &str,
    exists: impl Fn(&str) -> bool,
) -> Vec<Shell> {
    let mut found = Vec::<Shell>::new();
    let mut add = |file: &str, name: &str, args: &'static [&'static str]| {
        if !file.is_empty()
            && exists(file)
            && !found.iter().any(|shell| {
                shell.path.eq_ignore_ascii_case(file)
                    || ((!file.is_ascii() || !shell.path.is_ascii())
                        && shell.path.to_lowercase() == file.to_lowercase())
            })
        {
            found.push(Shell {
                path: file.to_owned(),
                name: name.to_owned(),
                args,
            });
        }
    };
    if windows {
        let root = env("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
        let programs = env("ProgramFiles").unwrap_or_else(|| r"C:\Program Files".into());
        add(
            &env("ComSpec").unwrap_or_else(|| win_join(&root, r"System32\cmd.exe")),
            "Command Prompt",
            &[],
        );
        add(
            &win_join(&root, r"System32\WindowsPowerShell\v1.0\powershell.exe"),
            "Windows PowerShell",
            &["-NoLogo"],
        );
        add(
            &win_join(&programs, r"PowerShell\7\pwsh.exe"),
            "PowerShell 7",
            &["-NoLogo"],
        );
        add(
            &win_join(&programs, r"Git\bin\bash.exe"),
            "Git Bash",
            &["--login", "-i"],
        );
        if let Some(local) = env("LOCALAPPDATA").filter(|s| !s.is_empty()) {
            add(
                &win_join(&local, r"ompdesk\tools\git\bin\bash.exe"),
                "Git Bash",
                &["--login", "-i"],
            );
        }
    } else {
        let login = env("SHELL");
        let entries = listed
            .split('\n')
            .map(js_trim)
            .filter(|s| s.starts_with('/'));
        for file in login
            .as_deref()
            .into_iter()
            .chain(entries)
            .chain(["/bin/zsh", "/bin/bash"])
        {
            let name = file.trim_end_matches('/').rsplit('/').next().unwrap_or("");
            add(file, name, &["-l"]);
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_shell_then_installed_entries_then_fallbacks_once() {
        let fish = "/opt/homebrew/bin/fish";
        let fixtures = [
            (
                "# comment\n/bin/bash\n/bin/csh\n/bin/zsh\n/opt/homebrew/bin/fish\n",
                vec![fish, "/bin/bash", "/bin/zsh"],
            ),
            (
                "\u{feff} /BIN/ZSH \r\nrelative\n",
                vec![fish, "/BIN/ZSH", "/bin/bash"],
            ),
            ("", vec![fish, "/bin/zsh", "/bin/bash"]),
        ];
        for (listed, paths) in fixtures {
            let shells = probe(
                false,
                |_| Some(fish.into()),
                listed,
                |file| [fish, "/bin/zsh", "/bin/bash", "/BIN/ZSH"].contains(&file),
            );
            assert_eq!(
                shells.iter().map(|s| s.path.as_str()).collect::<Vec<_>>(),
                paths
            );
            assert_eq!(shells[0].name, "fish");
            assert!(shells.iter().all(|s| s.args == ["-l"]));
        }
        assert!(probe(false, |_| None, "", |_| false).is_empty());
    }

    #[test]
    fn windows_paths_join_like_node_before_checking_disk() {
        for (root, expected) in [
            ("", r"bin\bash.exe"),
            (r"C:", r"C:\bin\bash.exe"),
            ("C:/tools/../Git/", r"C:\Git\bin\bash.exe"),
            ("//server/share/tools/..", r"\\server\share\bin\bash.exe"),
            ("///tools", r"\tools\bin\bash.exe"),
            ("//", r"\bin\bash.exe"),
        ] {
            assert_eq!(win_join(root, r"bin\bash.exe"), expected);
        }
    }

    #[test]
    fn windows_offers_only_installed_shells_in_preference_order() {
        let cmd = r"C:\Windows\System32\cmd.exe";
        let ps = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe";
        let local_git = r"C:\Users\a\AppData\Local\ompdesk\tools\git\bin\bash.exe";
        let env = |key: &str| match key {
            "ComSpec" => Some(cmd.into()),
            "LOCALAPPDATA" => Some(r"C:\Users\a\AppData\Local".into()),
            _ => None,
        };
        let shells = probe(true, env, "", |file| [cmd, ps, local_git].contains(&file));
        let rows: Vec<_> = shells
            .iter()
            .map(|s| (s.path.as_str(), s.name.as_str(), s.args))
            .collect();
        assert_eq!(
            rows,
            [
                (cmd, "Command Prompt", &[][..]),
                (ps, "Windows PowerShell", &["-NoLogo"][..]),
                (local_git, "Git Bash", &["--login", "-i"][..])
            ]
        );
        let all = probe(true, |_| None, "", |_| true);
        assert_eq!(all[0].path, cmd);
        assert_eq!(all[2].path, r"C:\Program Files\PowerShell\7\pwsh.exe");
        assert_eq!(all[3].path, r"C:\Program Files\Git\bin\bash.exe");
        assert_eq!(all.len(), 4);
    }
}
