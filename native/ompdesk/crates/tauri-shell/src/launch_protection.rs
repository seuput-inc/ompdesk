//! The primary launch owns both files. A failed save is advisory, not a rollback of this launch's decision.
use crate::js_date::iso_ms;
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

const COOLDOWN: i64 = 600_000;
const WEEK: i64 = 7 * 24 * 3_600_000;
const POLICY: i64 = 3;
const KEEP: usize = 10;

fn read(path: &Path) -> Option<Value> {
    fs::read(path)
        .ok()
        .map(|bytes| serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

fn crash_reason(reason: Option<&str>) -> bool {
    !matches!(reason, Some("clean-exit" | "killed"))
}

fn identity(device: &Value) -> Option<Value> {
    if !device["deviceId"].is_number() || device["vendorId"].as_f64()? == 65535.0 {
        return None;
    }
    let mut gpu = json!({"vendorId":device["vendorId"],"deviceId":device["deviceId"]});
    for key in ["driverVersion", "driverDate"] {
        if let Some(value) = device[key].as_str().filter(|v| !v.is_empty()) {
            gpu[key] = json!(value);
        }
    }
    Some(gpu)
}

fn change(before: &Value, after: &Value) -> Option<&'static str> {
    if before.is_null() || after.is_null() {
        return None;
    }
    if ["vendorId", "deviceId"]
        .iter()
        .any(|&k| before[k].as_f64() != after[k].as_f64())
    {
        Some("gpu-changed")
    } else if before["driverVersion"] != after["driverVersion"]
        || before["driverDate"] != after["driverDate"]
    {
        Some("driver-changed")
    } else {
        None
    }
}

fn marker_ms(value: &Value) -> f64 {
    value
        .as_f64()
        .or_else(|| {
            OffsetDateTime::parse(value.as_str()?, &Rfc3339)
                .ok()
                .map(|date| date.unix_timestamp_nanos().div_euclid(1_000_000) as f64)
        })
        .filter(|ms| ms.abs() <= 8_640_000_000_000_000.0)
        .unwrap_or(0.0)
}

fn marker(value: &Value) -> Value {
    let mut clean = json!({"at":marker_ms(&value["at"])});
    if value["reason"].is_string() {
        clean["reason"] = value["reason"].clone();
    }
    if let Some(code) = value
        .get("exitCode")
        .filter(|v| v.is_number() || v.is_null())
    {
        clean["exitCode"] = code.clone();
    }
    for key in ["policy", "trialAt"] {
        if value[key].is_number() {
            clean[key] = value[key].clone();
        }
    }
    for key in ["gpu", "seen"] {
        if let Some(gpu) = identity(&value[key]) {
            clean[key] = gpu;
        }
    }
    clean
}

fn trial(marker: &Value, now: i64) -> Option<&'static str> {
    if marker["policy"].as_f64() != Some(POLICY as f64) {
        return Some("policy");
    }
    change(&marker["gpu"], &marker["seen"]).or_else(|| {
        let last = marker["at"]
            .as_f64()
            .unwrap()
            .max(marker["trialAt"].as_f64().unwrap_or(0.0));
        (now as f64 - last >= WEEK as f64).then_some("cool-off")
    })
}

struct History {
    path: PathBuf,
    launches: Vec<Value>,
    last_relaunch: Option<f64>,
}

impl History {
    fn start(path: PathBuf, now: i64) -> (Self, bool) {
        let mut launches = Vec::new();
        let mut last_relaunch: Option<f64> = None;
        if let Some(Value::Array(rows)) = read(&path) {
            for row in rows {
                if !row["at"].is_number() {
                    continue;
                }
                let mut record = json!({"at":row["at"]});
                for key in ["stable", "safeMode"] {
                    if row[key] == true {
                        record[key] = json!(true);
                    }
                }
                if let Some(at) = row["gpuRelaunchAt"].as_f64() {
                    last_relaunch = Some(last_relaunch.map_or(at, |last| last.max(at)));
                    record["gpuRelaunchAt"] = row["gpuRelaunchAt"].clone();
                }
                launches.push(record);
            }
        }
        let safe = launches.len() >= 3
            && launches.iter().rev().take(3).all(|row| {
                row["stable"] != true
                    && (0.0..=COOLDOWN as f64).contains(&(now as f64 - row["at"].as_f64().unwrap()))
            });
        let discard = launches.len().saturating_sub(KEEP - 1);
        launches.drain(..discard);
        let mut current = json!({"at":now});
        if safe {
            current["safeMode"] = json!(true);
        }
        launches.push(current);
        let history = Self {
            path,
            launches,
            last_relaunch,
        };
        let _ = history.save();
        (history, safe)
    }

    fn save(&self) -> std::io::Result<()> {
        let parent = self.path.parent().expect("profile file");
        fs::create_dir_all(parent)?;
        let mut builder = tempfile::Builder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            builder.permissions(fs::Permissions::from_mode(0o666));
        }
        let mut temp = builder.prefix(".launch-history-").tempfile_in(parent)?;
        std::io::Write::write_all(&mut temp, &serde_json::to_vec(&self.launches)?)?;
        let mut waits = [10, 20, 40, 80, 160, 320].into_iter();
        loop {
            match temp.persist(&self.path) {
                Ok(_) => return Ok(()),
                Err(error) => {
                    let blocked = cfg!(windows)
                        && matches!(error.error.raw_os_error(), Some(5 | 32 | 33 | 170));
                    let Some(ms) = waits.next().filter(|_| blocked) else {
                        return Err(error.error);
                    };
                    temp = error.file;
                    std::thread::sleep(Duration::from_millis(ms));
                }
            }
        }
    }

    fn update(&mut self, key: &str, value: Value) {
        let current = self.launches.last_mut().expect("current launch");
        if current[key] != value {
            current[key] = value;
            let _ = self.save();
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Rendering {
    Hardware,
    Software,
    Trial,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Crash {
    Watching(Option<i64>),
    NoRelaunch,
    Relaunch,
}

pub struct LaunchProtection {
    marker: PathBuf,
    history: Option<History>,
    safe: bool,
    rendering: Rendering,
    gpu: Option<Value>,
    crash: Crash,
}

fn report(message: impl Into<String>, details: Value) -> Value {
    let mut log = json!({"source":"gpu-fallback","message":message.into()});
    if !details.is_null() {
        log["details"] = details;
    }
    log
}

fn effect(log: Value) -> Value {
    json!({"log":log})
}

impl LaunchProtection {
    pub fn start(
        profile: &Path,
        now: i64,
        guard: bool,
        enable_gpu: bool,
        disable_gpu: bool,
    ) -> (Self, Value) {
        let (history, safe) = if guard {
            let (history, safe) = History::start(profile.join("launch-history.json"), now);
            (Some(history), safe)
        } else {
            (None, false)
        };
        let mut state = Self {
            marker: profile.join("gpu-fallback.json"),
            history,
            safe,
            rendering: Rendering::Hardware,
            gpu: None,
            crash: Crash::Watching(None),
        };
        let mut logs = Vec::new();
        if safe {
            logs.push(json!({"source":"launch-guard","message":"Safe mode: the last 3 launches ended within 20 s of starting; software rendering, no automatic relaunch, setup paused"}));
            state.rendering = Rendering::Software;
        } else if enable_gpu {
            let _ = fs::remove_file(&state.marker);
        } else if disable_gpu {
            state.rendering = Rendering::Software;
        } else if let Some(raw) = read(&state.marker) {
            if !crash_reason(raw["reason"].as_str()) {
                let _ = fs::remove_file(&state.marker);
            } else {
                let mut m = marker(&raw);
                if let Some(why) = trial(&m, now) {
                    let at = m["at"]
                        .as_f64()
                        .filter(|at| *at != 0.0)
                        .map(|at| iso_ms(at as i64));
                    logs.push(report(
                        format!("GPU crash marker: trying hardware acceleration again ({why})"),
                        json!({"trial":why,"crashedOn":m["gpu"],"now":m["seen"],"crashedAt":at}),
                    ));
                    if let Some(seen) = m.as_object_mut().unwrap().remove("seen") {
                        m["gpu"] = seen;
                    }
                    m["trialAt"] = json!(now);
                    m["policy"] = json!(POLICY);
                    state.write_marker(&mut m);
                    state.rendering = Rendering::Trial;
                } else {
                    state.rendering = Rendering::Software;
                }
            }
        }
        let software = state.rendering == Rendering::Software;
        if software {
            logs.push(report(
                if safe {
                    "Hardware acceleration disabled (safe mode)"
                } else {
                    "Hardware acceleration disabled (crash marker or --disable-gpu)"
                },
                Value::Null,
            ));
        }
        (
            state,
            json!({"guard":guard,"safeMode":safe,"software":software,"stableAfterMs":20_000,"logs":logs}),
        )
    }

    fn write_marker(&self, value: &mut Value) {
        value["at"] = json!(iso_ms(value["at"].as_f64().unwrap() as i64));
        let _ = fs::write(&self.marker, value.to_string());
    }

    fn identity(&mut self, devices: &Value) -> Value {
        self.gpu = devices.as_array().and_then(|devices| {
            devices
                .iter()
                .filter(|d| d["active"] == true)
                .find_map(identity)
                .or_else(|| devices.iter().find_map(identity))
        });
        let Some(gpu) = &self.gpu else {
            return Value::Null;
        };
        if self.rendering != Rendering::Software {
            return Value::Null;
        }
        let Some(raw) = read(&self.marker).filter(|m| crash_reason(m["reason"].as_str())) else {
            return Value::Null;
        };
        let mut m = marker(&raw);
        if !m["seen"].is_null() && change(&m["seen"], gpu).is_none() {
            return Value::Null;
        }
        m["seen"] = gpu.clone();
        self.write_marker(&mut m);
        let message = match change(&m["gpu"], gpu) {
            Some(why) => {
                format!("GPU {why} since the crash: the next launch tries hardware acceleration")
            }
            None => "GPU unchanged since the crash: software rendering stays".to_owned(),
        };
        effect(report(message, json!({"crashedOn":m["gpu"],"now":gpu})))
    }

    fn crash(&mut self, args: &Value) -> Value {
        let reason = args["reason"].as_str().unwrap_or_default();
        let Crash::Watching(crashed_at) = self.crash else {
            return Value::Null;
        };
        if args["type"] != "GPU" || !crash_reason(Some(reason)) {
            return Value::Null;
        }
        let now = args["now"].as_i64().expect("host clock");
        let mut details = json!({"reason":reason,"exitCode":args["exitCode"]});
        let last = self.history.as_ref().and_then(|h| h.last_relaunch);
        let why = if args["testLaunch"] == true {
            Some("test-launch")
        } else if self.safe {
            Some("safe-mode")
        } else if self.rendering == Rendering::Software {
            Some("software")
        } else if self.rendering != Rendering::Trial
            && crashed_at.is_none_or(|at| now.saturating_sub(at) >= COOLDOWN)
        {
            self.crash = Crash::Watching(Some(now));
            details["why"] = json!("settled");
            return effect(report(
                format!(
                    "GPU process exited ({reason}): WebView2 restarts it and repaints, hardware acceleration stays"
                ),
                details,
            ));
        } else if last.is_some_and(|at| (now as f64) - at < COOLDOWN as f64) {
            Some("cooldown")
        } else {
            None
        };
        self.crash = if why.is_some() {
            Crash::NoRelaunch
        } else {
            Crash::Relaunch
        };
        if self.rendering != Rendering::Software {
            let mut m =
                json!({"at":now,"policy":POLICY,"reason":reason,"exitCode":args["exitCode"]});
            if let Some(gpu) = self.gpu.as_ref() {
                m["gpu"] = gpu.clone();
            } else if let Some(gpu) = read(&self.marker).and_then(|m| identity(&m["gpu"])) {
                m["gpu"] = gpu;
            }
            self.write_marker(&mut m);
        }
        if let Some(why) = why {
            details["why"] = json!(why);
            details["lastRelaunchAt"] = if why == "cooldown" {
                json!(last)
            } else {
                Value::Null
            };
            return effect(report(
                format!("GPU process exited ({reason}): no relaunch ({why}); Chromium restarts it"),
                details,
            ));
        }
        if let Some(h) = &mut self.history {
            h.update("gpuRelaunchAt", json!(now));
        }
        json!({"relaunch":true,"log":report(format!("GPU process exited ({reason}): relaunching with software rendering"),details)})
    }

    pub fn apply(&mut self, op: &str, args: &Value) -> Value {
        match op {
            "identity" => self.identity(&args["devices"]),
            "crash" => self.crash(args),
            "stable" | "healthy" => {
                // A main-thread timer may already be in flight when the GPU's relaunch receipt reaches Node.
                if self.crash == Crash::Relaunch {
                    return Value::Null;
                }
                if let Some(h) = &mut self.history {
                    h.update("stable", json!(true));
                }
                if op == "healthy"
                    && self.rendering == Rendering::Trial
                    && matches!(self.crash, Crash::Watching(_))
                {
                    self.rendering = Rendering::Hardware;
                    if !fs::remove_file(&self.marker)
                        .is_err_and(|e| e.kind() != std::io::ErrorKind::NotFound)
                    {
                        return effect(report(
                            "GPU crash marker cleared: hardware acceleration works again",
                            Value::Null,
                        ));
                    }
                }
                Value::Null
            }
            _ => unreachable!("unknown launch signal {op}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn captured_marker_trials() {
        for (raw, now, why) in [
            (json!({}), 0, Some("policy")),
            (json!({"policy":2,"at":1}), 2, Some("policy")),
            (json!({"policy":3,"at":1}), WEEK, None),
            (json!({"policy":3,"at":1e308}), WEEK, Some("cool-off")),
            (json!({"policy":3,"at":1}), WEEK + 1, Some("cool-off")),
            (json!({"policy":3,"at":0,"trialAt":2}), WEEK + 1, None),
            (
                json!({"policy":3,"gpu":{"vendorId":1,"deviceId":2},"seen":{"vendorId":1,"deviceId":3}}),
                2,
                Some("gpu-changed"),
            ),
            (
                json!({"policy":3,"gpu":{"vendorId":1,"deviceId":2},"seen":{"vendorId":1,"deviceId":2,"driverDate":"today"}}),
                2,
                Some("driver-changed"),
            ),
            (
                json!({"policy":3,"gpu":{"vendorId":65535,"deviceId":2},"seen":{"vendorId":1,"deviceId":2}}),
                2,
                None,
            ),
        ] {
            assert_eq!(trial(&marker(&raw), now), why, "{raw}");
        }
    }

    #[test]
    fn captured_launch_histories() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("launch-history.json");
        for (rows, safe) in [
            (json!([]), false),
            (json!([{"at":600001},{"at":600002}]), false),
            (json!([{"at":1},{"at":600000},{"at":600001}]), true),
            (json!([{"at":0},{"at":600000},{"at":600001}]), false),
            (json!([{"at":1},{"at":600000},{"at":600002}]), false),
            (
                json!([{"at":1,"stable":1},{"at":600000},{"at":600001}]),
                true,
            ),
            (
                json!([{"at":1,"stable":true},{"at":600000},{"at":600001}]),
                false,
            ),
            (
                json!([null,{"at":"ignored"},{"at":1},"bad",{"at":2},{"at":3}]),
                true,
            ),
        ] {
            fs::write(&path, rows.to_string()).unwrap();
            assert_eq!(History::start(path.clone(), 600001).1, safe, "{rows}");
        }
    }

    #[test]
    fn captured_cooldown_boundaries() {
        for (gap, repeated) in [
            (COOLDOWN - 1, true),
            (COOLDOWN, false),
            (COOLDOWN + 1, false),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let (mut launch, _) = LaunchProtection::start(dir.path(), 0, true, false, false);
            for (now, relaunch) in [(1, false), (1 + gap, repeated)] {
                let result = launch.apply("crash", &json!({"type":"GPU","reason":"oom","now":now}));
                assert_eq!(result["relaunch"] == true, relaunch);
            }
        }
    }

    #[test]
    fn a_failed_write_keeps_the_decision_and_the_guard_does_not_touch_an_unguarded_launch() {
        let dir = tempfile::tempdir().unwrap();
        let history = dir.path().join("launch-history.json");
        let rows = br#"[{"at":1},{"at":2},{"at":3}]"#;
        fs::write(&history, rows).unwrap();
        let (_, start) = LaunchProtection::start(dir.path(), 4, false, false, false);
        assert_eq!(start["safeMode"], false);
        assert_eq!(fs::read(&history).unwrap(), rows);
        let (mut launch, start) = LaunchProtection::start(dir.path(), 4, true, true, false);
        assert_eq!(start["safeMode"], true);
        fs::remove_file(&history).unwrap();
        fs::create_dir(&history).unwrap();
        launch.apply("stable", &Value::Null);
        assert_eq!(
            launch.history.unwrap().launches.last().unwrap()["stable"],
            true
        );
    }
}
