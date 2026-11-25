//! Cache locations, bounds, tool lifetimes and the fixed commands disk care may run.
use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use super::{cache, tree};
use crate::fs::order::{is_js_space, js_trim};
use crate::git::read::{blocking, resolve};
use crate::run::Runner;
use crate::server::{Call, Fault, Reply, Scope};

#[derive(Serialize, Deserialize, Clone, Copy)]
enum Part {
    #[serde(rename = "bunCache")]
    Install,
    #[serde(rename = "bunTranspilerCache")]
    Transpiler,
    #[serde(rename = "npmCache")]
    Npm,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Cache {
    part: Part,
    action: &'static str,
    max_bytes: u64,
    check_processes: bool,
}

const GB: u64 = 1024 * 1024 * 1024;
const CACHES: [Cache; 3] = [
    Cache {
        part: Part::Install,
        action: "bun-cache",
        max_bytes: 2 * GB,
        check_processes: true,
    },
    Cache {
        part: Part::Transpiler,
        action: "bun-transpiler-cache",
        max_bytes: GB,
        check_processes: false,
    },
    Cache {
        part: Part::Npm,
        action: "npm-cache",
        max_bytes: 2 * GB,
        check_processes: true,
    },
];

#[derive(Deserialize)]
struct Tool {
    bin: String,
    cwd: String,
    env: BTreeMap<String, String>,
}

impl Tool {
    /// Like execFile, fail on either stream over 16 MiB. Never put tool output in a fault or log.
    async fn run(&self, args: &[&str], scope: &Scope) -> Result<Option<Vec<u8>>, Fault> {
        tree::live(scope)?;
        let mut command = Command::new(&self.bin);
        command
            .args(args)
            .current_dir(&self.cwd)
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        Runner::apply_environment(&self.env, &mut command);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let Ok(mut child) = command.spawn() else {
            return Ok(None);
        };
        let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
            return Err(Fault::new(
                "internal",
                "The cache tool's pipes were not open",
            ));
        };
        const CAP: u64 = 16 * 1024 * 1024;
        let capped = |size: u64| {
            if size > CAP {
                Err(io::Error::other("cache tool output exceeded its limit"))
            } else {
                Ok(())
            }
        };
        let mut output = Vec::new();
        let read = async {
            tokio::try_join!(
                async { capped(stdout.take(CAP + 1).read_to_end(&mut output).await? as u64) },
                async {
                    capped(
                        tokio::io::copy(&mut stderr.take(CAP + 1), &mut tokio::io::sink()).await?,
                    )
                },
                child.wait(),
            )
        };
        let exit = tokio::select! {
            _ = scope.on_cancel() => None,
            result = tokio::time::timeout(Duration::from_secs(120), read) => result.ok().and_then(Result::ok),
        };
        match exit {
            Some(((), (), status)) => Ok(status.success().then_some(output)),
            None => {
                let _ = child.kill().await;
                tree::live(scope)?;
                Ok(None)
            }
        }
    }
}

#[derive(Deserialize)]
struct BunPaths {
    install: PathBuf,
    cache: Option<String>,
    transpiler: Option<String>,
    xdg: Option<PathBuf>,
    home: PathBuf,
    mac: bool,
}

fn join(base: &Path, suffix: &str) -> String {
    let mut path = if base == Path::new(".") {
        PathBuf::new()
    } else {
        base.to_owned()
    };
    path.extend(suffix.split('/'));
    path.to_string_lossy().into_owned()
}

fn within(cwd: &str, install: &str, transpiler: &str) -> bool {
    let root = resolve(cwd, install);
    let child = resolve(cwd, transpiler);
    #[cfg(windows)]
    let (root, child) = (root.to_lowercase(), child.to_lowercase());
    Path::new(&child)
        .strip_prefix(root)
        .is_ok_and(|rest| !rest.as_os_str().to_string_lossy().starts_with(".."))
}

impl BunPaths {
    fn dirs(self, cwd: &str) -> (String, Option<String>) {
        let install = self
            .cache
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| join(&self.install, "install/cache"));
        // RuntimeTranspilerCache.zig: BUN_INSTALL does not move the default transpiler cache.
        let transpiler = match self.transpiler {
            Some(s) if s.is_empty() || s == "0" => None,
            Some(s) => Some(s),
            None => Some(match self.xdg.filter(|s| !s.as_os_str().is_empty()) {
                Some(xdg) => join(&xdg, "bun/@t@"),
                None if self.mac => join(&self.home, "Library/Caches/bun/@t@"),
                None => join(&self.home, ".bun/install/cache/@t@"),
            }),
        };
        let separate = transpiler.filter(|path| !within(cwd, &install, path));
        (install, separate)
    }
}

fn npm_dir(output: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(output);
    let root = js_trim(js_trim(&text).rsplit('\n').next()?);
    // Node considers a rooted Windows path absolute even without a drive letter.
    Path::new(root)
        .has_root()
        .then(|| resolve(root, "_cacache"))
}

#[derive(Deserialize)]
struct Locate {
    cwd: String,
    bun: Option<BunPaths>,
    npm: Option<Tool>,
}

#[derive(Serialize)]
struct Located<'a> {
    cache: &'a Cache,
    dir: &'a str,
}

pub async fn locate(call: Call) -> Result<Reply, Fault> {
    let Locate { cwd, bun, npm } = call.params()?;
    let bun = bun.map(|bun| bun.dirs(&cwd));
    let npm = match npm {
        Some(npm) => npm
            .run(&["config", "get", "cache"], &call.scope)
            .await?
            .and_then(|out| npm_dir(&out)),
        None => None,
    };
    let located: Vec<_> = CACHES
        .iter()
        .filter_map(|cache| {
            let dir = match cache.part {
                Part::Install => &bun.as_ref()?.0,
                Part::Transpiler => bun.as_ref()?.1.as_ref()?,
                Part::Npm => npm.as_ref()?,
            };
            Some(Located { cache, dir })
        })
        .collect();
    Reply::json(&located)
}

fn line_start(prefix: &str) -> bool {
    prefix.is_empty() || prefix.ends_with(['\n', '\r', '\u{2028}', '\u{2029}'])
}

fn word_end(rest: &str) -> bool {
    rest.as_bytes()
        .first()
        .is_none_or(|b| !b.is_ascii_alphanumeric() && *b != b'_')
}

fn space_or_end(rest: &str) -> bool {
    rest.chars().next().is_none_or(is_js_space)
}

fn bun_running(text: &str) -> bool {
    text.match_indices("bun").any(|(at, _)| {
        let prefix = &text[..at];
        if !line_start(prefix) && !prefix.ends_with('/') {
            return false;
        }
        let rest = &text[at + 3..];
        if rest.strip_prefix('x').is_some_and(word_end) {
            return true;
        }
        let rest = rest.strip_prefix(".exe").unwrap_or(rest);
        let args = rest.trim_start_matches(is_js_space);
        args.len() != rest.len()
            && [
                "install", "i", "add", "update", "remove", "rm", "pm", "x", "create", "link",
            ]
            .into_iter()
            .any(|word| args.strip_prefix(word).is_some_and(word_end))
    })
}

fn npm_running(text: &str) -> bool {
    text.match_indices("np").any(|(at, _)| {
        let prefix = &text[..at];
        let tail = &text[at + 2..];
        if line_start(prefix) && tail.strip_prefix(['m', 'x']).is_some_and(space_or_end) {
            return true;
        }
        let cli = || {
            tail.strip_prefix('m')?
                .strip_prefix(['/', '\\'])?
                .strip_prefix("bin")?
                .strip_prefix(['/', '\\'])?
                .strip_prefix("np")?
                .strip_prefix(['m', 'x'])?
                .strip_prefix("-cli.js")
        };
        prefix.ends_with(['/', '\\']) && cli().is_some_and(space_or_end)
    })
}

#[derive(Deserialize)]
struct Processes {
    ps: Option<Tool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Holds {
    #[serde(skip_serializing_if = "Option::is_none")]
    bun_cache: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    npm_cache: Option<&'static str>,
}

pub async fn holds(call: Call) -> Result<Reply, Fault> {
    let Processes { ps } = call.params()?;
    let output = match ps {
        Some(ps) => ps.run(&["-axo", "command="], &call.scope).await?,
        None => None,
    };
    let holds = match output {
        Some(output) => {
            let text = String::from_utf8_lossy(&output);
            Holds {
                bun_cache: bun_running(&text).then_some("an install runs"),
                npm_cache: npm_running(&text).then_some("npm runs"),
            }
        }
        None => Holds {
            bun_cache: Some("process check unavailable"),
            npm_cache: Some("process check unavailable"),
        },
    };
    Reply::json(&holds)
}

#[derive(Deserialize)]
struct Clear {
    part: Part,
    dir: String,
    bun: Option<Tool>,
}

pub async fn clear(call: Call) -> Result<Reply, Fault> {
    let Clear { part, dir, bun } = call.params()?;
    let kind = match part {
        Part::Install => {
            let Some(bun) = bun else {
                return Reply::json(&"bun was not found");
            };
            // Bun has no age option, and removes its temporary bunx trees as well as the install cache.
            if bun
                .run(&["pm", "cache", "rm"], &call.scope)
                .await?
                .is_none()
            {
                return Err(Fault::new("cache_failed", "bun pm cache rm failed"));
            }
            return Reply::json(&());
        }
        Part::Npm => cache::Kind::Npm,
        Part::Transpiler => cache::Kind::BunTranspiler,
    };
    let scope = call.scope;
    let cleared = blocking(move || cache::clear(kind, &dir, &scope)).await??;
    Reply::json(&(cleared.removed == 0 && cleared.left > 0).then_some("its files are held open"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_lines_captured_from_the_typescript_process_table() {
        for (line, bun, npm) in [
            ("", false, false),
            ("bun install", true, false),
            ("/bin/bun.exe pm cache rm", true, false),
            ("bun run dev", false, false),
            ("bun input", false, false),
            ("bun i-more", true, false),
            ("bun add-on", true, false),
            ("bunx", true, false),
            ("/bin/bunx.exe hi", true, false),
            ("/bin/bunxyz", false, false),
            ("/bin/bun create", true, false),
            (" npm install", false, false),
            ("npx", false, true),
            ("node /lib/npm/bin/npm-cli.js i", false, true),
            (r"node C:\app\npm\bin\npx-cli.js", false, true),
            ("node /srv/npm-mirror/server.js", false, false),
            ("bun\nadd", true, false),
            ("sh\n/bin/bunx\nnpm", true, true),
            ("bun removeFOO", false, false),
            ("bunx_some", false, false),
            ("npx\u{feff}pkg", false, true),
            ("bun rmé", true, false),
        ] {
            assert_eq!(
                (bun_running(line), npm_running(line)),
                (bun, npm),
                "{line:?}"
            );
        }
    }

    #[test]
    fn npm_uses_only_an_absolute_path_on_the_last_nonblank_line() {
        let root = std::env::temp_dir().join("npm fixture");
        let path = root.display();
        let expected = root.join("_cacache");
        for text in [format!("warn\r\n {path} \r\n\n"), format!("{path}/x/../")] {
            assert_eq!(npm_dir(text.as_bytes()).as_deref(), expected.to_str());
        }
        for text in ["", "relative", &format!("{path}\nwarn")] {
            assert_eq!(npm_dir(text.as_bytes()), None);
        }
    }

    #[test]
    fn a_transpiler_cache_inside_the_install_cache_has_no_separate_row() {
        let home = std::env::temp_dir().join("fixture-home");
        let home = home.to_str().unwrap();
        let base = Path::new(home);
        let install = join(base, "alt");
        for (relative, separate) in [
            ("alt", false),
            ("alt/piles", false),
            ("alt-neighbor", true),
            ("alt/..not-parent", true),
        ] {
            let named = join(base, relative);
            let (dir, transpiler) = BunPaths {
                install: base.join(".bun"),
                cache: Some(install.clone()),
                transpiler: Some(named.clone()),
                xdg: None,
                home: base.to_owned(),
                mac: true,
            }
            .dirs(home);
            assert_eq!(dir, install);
            assert_eq!(transpiler, separate.then_some(named));
        }
    }
}
