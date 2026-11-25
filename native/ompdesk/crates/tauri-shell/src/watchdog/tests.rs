use super::*;
use serde_json::json;
use std::fs;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};

#[test]
fn recovery_replaces_the_marker_while_a_reader_holds_the_stall() {
    let profile = tempfile::tempdir().unwrap();
    let path = profile.path().join(MARKER);
    let mut engine = Engine::new(0, 7);
    assert!(!engine.tick(3_000));
    assert!(engine.tick(6_000));
    record(&engine, &path).unwrap();
    let stalled = std::fs::File::open(&path).unwrap();

    assert!(engine.heartbeat(6_001));
    record(&engine, &path).unwrap();
    let previous: Value = serde_json::from_reader(stalled).unwrap();
    let current: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(previous["selfRecovered"], false);
    assert_eq!(current["selfRecovered"], true);
}

#[test]
fn blocked_node_leaves_a_sampled_marker_before_it_can_recover() {
    let profile = tempfile::tempdir().unwrap();
    let logs = profile.path().join("logs");
    std::fs::create_dir(&logs).unwrap();
    let path = logs.join(MARKER);
    // The private Node main cannot run JS until a separate observer sees the host's sampled marker.
    let mut child = Command::new("node")
        .args([
            "-e",
            r#"
            const { Worker } = require('node:worker_threads');
            const post = signal => require('node:fs').writeSync(1, JSON.stringify(signal) + '\n');
            post({type: 'step', phase: 'update', step: 'quit-and-install'});
            const gate = new Int32Array(new SharedArrayBuffer(4));
            new Worker(`
                const { gate, path } = require('node:worker_threads').workerData;
                const fs = require('node:fs');
                const watcher = fs.watch(require('node:path').dirname(path), inspect);
                function inspect() {
                    let marker;
                    try { marker = JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return; }
                    if (!marker.machine) return;
                    watcher.close();
                    Atomics.store(gate, 0, 1);
                    Atomics.notify(gate, 0);
                }
                inspect();
            `, { eval: true, workerData: { gate, path: process.argv[1] } });
            if (Atomics.wait(gate, 0, 0, 30000) === 'timed-out') process.exit(1);
            post({type: 'heartbeat'});
            post({type: 'shutdown'});
        "#,
        ])
        .arg(&path)
        .env_remove("NODE_OPTIONS")
        .env("NODE_DISABLE_COMPILE_CACHE", "1")
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let pid = child.id();
    let (tx, rx) = mpsc::channel();
    let output = BufReader::new(child.stdout.take().unwrap());
    let status = std::thread::scope(|scope| {
        scope.spawn(|| watch(pid, &path, rx));
        for line in output.lines() {
            tx.send(serde_json::from_str(&line.unwrap()).unwrap())
                .unwrap();
        }
        drop(tx);
        child.wait().unwrap()
    });
    assert!(
        status.success(),
        "blocked Node did not observe a sampled marker ({status}); marker: {:?}",
        std::fs::read_to_string(&path)
    );
    let marker: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(marker["selfRecovered"], true);
    assert_eq!(marker["pid"], pid);
    assert!(marker["unresponsiveMs"].as_u64().unwrap() > 5_000);
    assert_eq!(marker["phase"], "update");
    assert_eq!(
        marker["steps"],
        serde_json::json!(["update:quit-and-install"])
    );
    for field in ["availMB", "totalMB", "cpus", "cpuBusyPct", "mainCpuPct"] {
        assert!(
            marker["machine"][field].is_number(),
            "missing {field}: {marker}"
        );
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o077,
            0
        );
    }
    assert_eq!(marker::consume(&path), Some(marker));
    assert!(!path.try_exists().unwrap());
    assert_eq!(marker::consume(&path), None);
}

fn old_marker() -> Value {
    json!({"detectedAt": 1_700_000_000_000_i64, "pid": 4242, "unresponsiveMs": 6100, "selfRecovered": false})
}

fn consume_bytes(bytes: &[u8]) -> Option<Value> {
    let profile = tempfile::tempdir().unwrap();
    let path = profile.path().join(MARKER);
    fs::write(&path, bytes).unwrap();
    let result = marker::consume(&path);
    assert!(!path.try_exists().unwrap(), "readable marker left on disk");
    result
}

fn consume_json(value: &Value) -> Option<Value> {
    consume_bytes(&serde_json::to_vec(value).unwrap())
}

#[test]
fn consumes_an_old_marker_at_the_byte_limit_and_discards_oversize_or_corrupt_files() {
    let marker = old_marker();
    let mut bytes = serde_json::to_vec(&marker).unwrap();
    bytes.resize(64 * 1024, b' ');
    assert_eq!(consume_bytes(&bytes), Some(marker));
    bytes.push(b' ');
    assert_eq!(consume_bytes(&bytes), None);
    assert_eq!(consume_bytes(b"{not json"), None);
}

#[test]
fn a_read_error_leaves_the_marker_in_place() {
    let profile = tempfile::tempdir().unwrap();
    let path = profile.path().join(MARKER);
    // Both can be unlinked, but neither can be read as a file.
    #[cfg(unix)]
    std::os::unix::fs::symlink(profile.path(), &path).unwrap();
    #[cfg(windows)]
    let _locked = {
        use std::os::windows::fs::OpenOptionsExt;
        fs::write(&path, old_marker().to_string()).unwrap();
        fs::OpenOptions::new()
            .read(true)
            .share_mode(4) // FILE_SHARE_DELETE
            .open(&path)
            .unwrap()
    };
    assert_eq!(marker::consume(&path), None);
    assert!(path.try_exists().unwrap());
}

#[test]
fn a_marker_that_cannot_be_unlinked_still_reports_the_hang() {
    let profile = tempfile::tempdir().unwrap();
    let path = profile.path().join(MARKER);
    let marker = old_marker();
    fs::write(&path, marker.to_string()).unwrap();
    #[cfg(unix)]
    let original = {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let metadata = fs::metadata(profile.path()).unwrap();
        if metadata.uid() == 0 {
            return; // Root can unlink a file even in a read-only directory.
        }
        fs::set_permissions(profile.path(), fs::Permissions::from_mode(0o500)).unwrap();
        metadata.permissions()
    };
    #[cfg(windows)]
    let _locked = {
        use std::os::windows::fs::OpenOptionsExt;
        fs::OpenOptions::new()
            .read(true)
            .share_mode(1) // FILE_SHARE_READ, no FILE_SHARE_DELETE
            .open(&path)
            .unwrap()
    };
    let result = marker::consume(&path);
    #[cfg(unix)]
    fs::set_permissions(profile.path(), original).unwrap();
    assert_eq!(result, Some(marker));
    assert!(path.try_exists().unwrap());
}

#[test]
fn requires_a_js_date_a_positive_integer_pid_and_a_finite_nonnegative_duration() {
    for (key, value) in [
        ("detectedAt", json!(8_640_000_000_000_001_i64)),
        ("detectedAt", json!(-8_640_000_000_000_001_i64)),
        ("detectedAt", json!("1")),
        ("pid", json!(0)),
        ("pid", json!(-3)),
        ("pid", json!(1.5)),
        ("pid", json!("7")),
        ("unresponsiveMs", json!(-0.5)),
        ("unresponsiveMs", Value::Null),
        ("unresponsiveMs", json!("0")),
    ] {
        let mut marker = old_marker();
        marker[key] = value;
        assert_eq!(consume_json(&marker), None, "{marker}");
    }
    for raw in [
        r#"{"detectedAt":0,"pid":1,"unresponsiveMs":1e400}"#,
        r#"{"detectedAt":0,"unresponsiveMs":0}"#,
        r#"{"detectedAt":0,"pid":1}"#,
        r#"{"pid":1,"unresponsiveMs":0}"#,
        "null",
        "[]",
    ] {
        assert_eq!(consume_bytes(raw.as_bytes()), None, "{raw}");
    }
    for (at, pid, ms) in [
        (-8.64e15, 1.0, 0.0),
        (8.64e15, 1e20, 1e300),
        (-0.25, 4_294_967_296.0, 0.75),
    ] {
        let marker = json!({"detectedAt": at, "pid": pid, "unresponsiveMs": ms});
        let read = consume_json(&marker).unwrap();
        assert_eq!(read["detectedAt"].as_f64(), Some(at));
        assert_eq!(read["pid"].as_f64(), Some(pid));
        assert_eq!(read["unresponsiveMs"].as_f64(), Some(ms));
        assert_eq!(read["selfRecovered"], false);
    }
}

#[test]
fn only_true_means_recovered() {
    let mut marker = old_marker();
    for value in [json!(true), json!(1), json!("true"), Value::Null] {
        marker["selfRecovered"] = value;
        let recovered = marker["selfRecovered"] == true;
        assert_eq!(consume_json(&marker).unwrap()["selfRecovered"], recovered);
    }
}

#[test]
fn keeps_the_last_eight_steps_only_when_the_phase_and_entire_history_are_valid() {
    let mut marker = old_marker();
    for phase in ["startup", "running", "quit", "update"] {
        marker["phase"] = json!(phase);
        marker["steps"] = json!([]);
        assert_eq!(consume_json(&marker).unwrap(), marker);
    }
    let steps = json!(["a", "b", "c", "d", "e", "f", "g", "h", "i"]);
    marker["steps"] = steps.clone();
    let read = consume_json(&marker).unwrap();
    assert_eq!(read["phase"], "update");
    assert_eq!(
        read["steps"],
        json!(["b", "c", "d", "e", "f", "g", "h", "i"])
    );
    for (phase, steps) in [
        (json!("nonsense"), steps),
        (Value::Null, json!([])),
        (json!("quit"), json!("quit:teardown")),
        (
            json!("quit"),
            json!([1, "b", "c", "d", "e", "f", "g", "h", "i"]),
        ),
        (json!("quit"), json!(["quit:teardown", null])),
    ] {
        marker["phase"] = phase;
        marker["steps"] = steps;
        assert_eq!(consume_json(&marker), Some(old_marker()));
    }
}

#[test]
fn keeps_the_first_twelve_primitive_machine_entries_in_js_key_order() {
    let mut marker = old_marker();
    for (machine, expected) in [
        (
            json!({
                "nested": {"a": 1}, "list": [1], "nil": null,
                "availMB": 512, "cpuBusyPct": 99.5, "a": 0, "b": 1, "c": 2, "d": 3, "e": 4,
                "f": 5, "g": 6, "01": "past the limit", "4294967295": false,
                "4294967294": true, "11": 11, "2": 2
            }),
            json!({
                "2": 2, "11": 11, "4294967294": true, "availMB": 512, "cpuBusyPct": 99.5,
                "a": 0, "b": 1, "c": 2, "d": 3, "e": 4, "f": 5, "g": 6
            }),
        ),
        (
            Value::Object((0..13).rev().map(|i| (i.to_string(), json!(i))).collect()),
            Value::Object((0..12).map(|i| (i.to_string(), json!(i))).collect()),
        ),
        (
            json!([{}, false, null, "low", [1], 512]),
            json!({"1": false, "3": "low", "5": 512}),
        ),
        (json!({"nested": [], "nil": null}), json!({})),
    ] {
        marker["machine"] = machine;
        let read = consume_json(&marker).unwrap();
        assert_eq!(read["machine"], expected);
    }
    marker["machine"] = json!("not an object");
    assert_eq!(consume_json(&marker), Some(old_marker()));
}
