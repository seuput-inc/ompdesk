//! One Bun catalog probe per omp install and version. Only the first call asks main for its launch
//! environment: even a failed lookup is cached, and the installed stock catalog stays Bun's to read.

use std::collections::{BTreeMap, HashMap, hash_map::Entry};
use std::process::Stdio;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use serde::Deserialize;
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio::time::timeout;

use super::locked;
use crate::fs::error::uv_code;
use crate::fs::order::{is_js_space, js_trim};
use crate::ports::Port;
use crate::run::{KILL_GRACE, Runner, terminate};
use crate::server::{Answer, Call, Fault, Reply};

const BUDGET: Duration = Duration::from_secs(15);
type Lookup = Shared<BoxFuture<'static, Arc<str>>>;
static CACHE: LazyLock<Mutex<HashMap<String, Lookup>>> = LazyLock::new(Default::default);

#[derive(Deserialize)]
struct Params {
    bin: String,
    version: String,
    port: u64,
    fallback: String,
}

#[derive(Deserialize)]
struct Launch {
    script: String,
    cwd: String,
    env: BTreeMap<String, String>,
}

pub(super) fn handle(call: Call) -> Answer {
    // Reserve the first caller's launch inputs in wire order, before either request's task runs.
    let pending = lookup(&call);
    Box::pin(async move { Reply::json(&*pending?.await) })
}

fn lookup(call: &Call) -> Result<Lookup, Fault> {
    let p: Params = call.params()?;
    let mut cache = locked(&CACHE);
    match cache.entry(format!("{}@{}", p.bin, p.version)) {
        Entry::Occupied(entry) => Ok(entry.get().clone()),
        Entry::Vacant(entry) => {
            let port = Port::open(&call.events, p.port, ())?;
            let pending = async move {
                let result = match port.ask::<Launch, _>("launch", &()).await {
                    Ok(launch) => probe(launch).await,
                    Err(error) => Err(error.message),
                };
                result.unwrap_or_else(|detail| {
                    port.tell("warn", &detail);
                    Arc::from(p.fallback)
                })
            };
            Ok(entry.insert(pending.boxed().shared()).clone())
        }
    }
}

async fn probe(launch: Launch) -> Result<Arc<str>, String> {
    #[cfg(windows)]
    let bun = windows_bun(&launch).ok_or("spawn bun ENOENT")?;
    #[cfg(not(windows))]
    let bun = "bun";
    let mut command = Command::new(bun);
    command
        .arg(launch.script)
        .current_dir(launch.cwd)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    Runner::apply_environment(&launch.env, &mut command);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let child = command
        .spawn()
        .map_err(|error| format!("spawn bun {}", uv_code(&error)))?;
    collect(child).await
}

#[cfg(windows)]
fn windows_bun(launch: &Launch) -> Option<std::path::PathBuf> {
    let search_cwd = !launch
        .env
        .keys()
        .any(|k| k.eq_ignore_ascii_case("NoDefaultCurrentDirectoryInExePath"));
    crate::windows_executable::find(
        launch.cwd.as_ref(),
        launch.env.get("PATH").map_or("", String::as_str),
        search_cwd,
        &["bun.com", "bun.exe"],
    )
}

async fn collect(mut child: Child) -> Result<Arc<str>, String> {
    let mut out = child.stdout.take().expect("piped stdout");
    let mut err = child.stderr.take().expect("piped stderr");
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let closed = async {
        tokio::try_join!(
            child.wait(),
            out.read_to_end(&mut stdout),
            err.read_to_end(&mut stderr)
        )
    };
    match timeout(BUDGET, closed).await {
        Ok(Ok((status, _, _))) => selector(status.code(), &stdout, &stderr),
        Ok(Err(error)) => Err(error.to_string()),
        Err(_) => {
            terminate(&mut child);
            // Report the deadline immediately, but reap Bun even if it ignores SIGTERM.
            tokio::spawn(async move {
                if timeout(KILL_GRACE, child.wait()).await.is_err() {
                    let _ = child.kill().await;
                }
            });
            Err(format!("timed out after {}ms", BUDGET.as_millis()))
        }
    }
}

fn selector(code: Option<i32>, stdout: &[u8], stderr: &[u8]) -> Result<Arc<str>, String> {
    let stdout = String::from_utf8_lossy(stdout);
    let value = js_trim(&stdout);
    if code == Some(0)
        && value.split_once('/').is_some_and(|(provider, model)| {
            !provider.is_empty()
                && provider
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
                && !model.is_empty()
                && !model.contains(is_js_space)
        })
    {
        return Ok(Arc::from(value));
    }
    let message = if stderr.is_empty() {
        stdout
    } else {
        String::from_utf8_lossy(stderr)
    };
    let head = js_trim(&message).split('\n').next().unwrap_or("");
    match code {
        Some(code) => Err(format!("exit {code}: {head}")),
        None => Err(format!("exit null: {head}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_and_failure_detail_from_the_typescript_probe() {
        for (code, stdout, stderr, answer) in [
            (
                0,
                "anthropic/claude-next\n",
                "",
                Ok("anthropic/claude-next"),
            ),
            (0, "\u{feff}_A.-3/한/😀\u{a0}", "ignored", Ok("_A.-3/한/😀")),
            (0, "x/a\u{85}b", "", Ok("x/a\u{85}b")),
            (0, "x/a\u{1c}b", "", Ok("x/a\u{1c}b")),
            (0, "x/a\u{2029}b", "", Err("exit 0: x/a\u{2029}b")),
            (0, "x/a\u{feff}b", "", Err("exit 0: x/a\u{feff}b")),
            (0, "한글/alpha", "", Err("exit 0: 한글/alpha")),
            (0, "x/", "", Err("exit 0: x/")),
            (0, "/x", "", Err("exit 0: /x")),
            (0, "x /a", "", Err("exit 0: x /a")),
            (0, "x/a b", "", Err("exit 0: x/a b")),
            (0, "bad\r\nlater\n", "", Err("exit 0: bad\r")),
            (0, "", "", Err("exit 0: ")),
            (
                0,
                "ok/but trailing\n",
                "  err\r\nlater\n",
                Err("exit 0: err\r"),
            ),
            (17, "out\n", "  err\r\nlater\n", Err("exit 17: err\r")),
            (2, "only out\n", "   ", Err("exit 2: ")),
            (3, "\u{feff}no provider  \n", "", Err("exit 3: no provider")),
        ] {
            assert_eq!(
                selector(Some(code), stdout.as_bytes(), stderr.as_bytes())
                    .as_deref()
                    .map_err(String::as_str),
                answer
            );
        }
        assert_eq!(selector(None, b"x/y", b"").unwrap_err(), "exit null: x/y");
    }

    #[tokio::test(start_paused = true)]
    async fn times_out_waiting_for_the_child_to_close_its_pipes() {
        #[cfg(unix)]
        let mut command = Command::new("/bin/cat");
        #[cfg(windows)]
        let mut command = Command::new(
            std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap())
                .join("System32")
                .join("sort.exe"),
        );
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let _input = child.stdin.take().unwrap();
        let mut pending = std::pin::pin!(collect(child));
        assert!(pending.as_mut().now_or_never().is_none());
        tokio::time::advance(Duration::from_millis(14_999)).await;
        assert!(pending.as_mut().now_or_never().is_none());
        tokio::time::advance(Duration::from_millis(2)).await;
        assert_eq!(pending.await.unwrap_err(), "timed out after 15000ms");
    }

    #[cfg(windows)]
    #[test]
    fn windows_bun_uses_cwd_and_the_spawn_path_not_the_cores_path() {
        use std::fs;

        let dir = crate::fs::disk::make_temp_dir("boot-model-").unwrap();
        let tools = dir.join("tools; installed");
        fs::create_dir(&tools).unwrap();
        fs::write(tools.join("bun.com"), "").unwrap();
        fs::write(tools.join("bun.exe"), "").unwrap();
        let mut launch = Launch {
            cwd: dir.to_str().unwrap().into(),
            script: String::new(),
            env: BTreeMap::from([("PATH".into(), "missing;'tools; installed'".into())]),
        };
        assert_eq!(windows_bun(&launch), Some(tools.join("bun.com")));
        fs::write(dir.join("bun.exe"), "").unwrap();
        assert_eq!(windows_bun(&launch), Some(dir.join("bun.exe")));
        launch
            .env
            .insert("NODEFAULTCURRENTDIRECTORYINEXEPATH".into(), "".into());
        assert_eq!(windows_bun(&launch), Some(tools.join("bun.com")));
        launch.env.insert("PATH".into(), "missing".into());
        assert_eq!(windows_bun(&launch), None);
        fs::remove_dir_all(dir).unwrap();
    }
}
