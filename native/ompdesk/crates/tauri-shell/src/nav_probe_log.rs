//! Windows test hosts only. Keep the normal log unchanged; the runner owns these two private files.
#[path = "../../shell/src/log.rs"]
mod shell_log;
pub use shell_log::{now_ms, open_file, start_clock};

use serde_json::{Value, json};
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

struct Probe {
    netlog: PathBuf,
    native: Mutex<Option<File>>,
}
static PROBE: OnceLock<Probe> = OnceLock::new();

pub(super) fn open_probe(profile: &Path) {
    if std::env::var("OMP_GUI_TEST_FIRST_NAV_NET").as_deref() != Ok("default") {
        return;
    }
    let dir = |name| {
        let path = PathBuf::from(std::env::var_os(name)?);
        (path.is_absolute() && path.is_dir()).then_some(path)
    };
    let Some(private) = dir("OMPDESK_NAV_PRIVATE") else {
        return;
    };
    let Some(stages) = dir("OMPDESK_NAV_STAGES") else {
        return;
    };
    let (Ok(raw), Ok(out), Ok(profile)) = (
        private.canonicalize(),
        stages.canonicalize(),
        profile.canonicalize(),
    ) else {
        return;
    };
    if raw.starts_with(&profile) || raw.starts_with(&out) || out.starts_with(raw) {
        return;
    }
    let key = format!("{}-{}", std::process::id(), crate::wall_clock_ms());
    let native = File::create_new(private.join(format!("native-{key}.jsonl"))).ok();
    let _ = PROBE.set(Probe {
        netlog: private.join(format!("net-{key}.json")),
        native: Mutex::new(native),
    });
}

pub(super) fn probe_netlog() -> Option<&'static Path> {
    PROBE.get().map(|probe| probe.netlog.as_path())
}

pub fn log(event: &str, fields: Value) {
    if let Some(probe) = PROBE.get() {
        record(probe, event, &fields);
    }
    shell_log::log(event, fields);
}

fn record(probe: &Probe, event: &str, fields: &Value) {
    let keys: &[&str] = match event {
        "shell.started" => &["pid", "at"],
        "shell.ended" | "exit" => &["code"],
        "shell.handedOver" | "shell.failed" | "probe.nav.failed" => &[],
        "node.gone" => &["via", "code", "quitting"],
        "exit.requested" => &["code", "forwardedToNode"],
        "profile.migrate" => &["wcId", "step", "attempt"],
        "profile.migrate.navigation" => &["wcId", "allowed"],
        "profile.migrate.stalled" => &["wcId", "step", "waitedMs", "retry"],
        "profile.migrate.gave_up" => &["wcId", "step"],
        "profile.migrate.request" => &[],
        "profile.migrate.refused" | "profile.migrate.failed" | "profile.migrate.retry_failed"
        | "profile.migrate.dispatch_failed" => &["wcId"],
        "probe.nav.start" => &["wc", "id", "kind", "cancelled"],
        "probe.nav.end" => &["wc", "id", "ok", "error"],
        "probe.nav.resource" | "probe.nav.watching" => &["wc"],
        "probe.nav.response" => &["wc", "status"],
        _ => return,
    };
    let mut row = json!({"event":event,"t":now_ms()});
    for &key in keys {
        if let Some(value) = fields.get(key) {
            row[key] = value.clone();
        }
    }
    if event == "profile.migrate.request"
        && let Some(wc) = fields["webview"].as_str()
            .and_then(|label| label.rsplit_once("-page-"))
            .and_then(|(_, wc)| wc.parse::<u64>().ok())
    {
        row["wcId"] = wc.into();
    }
    if let Ok(mut native) = probe.native.lock()
        && let Some(file) = native.as_mut()
    {
        let _ = writeln!(file, "{row}");
    }
}
