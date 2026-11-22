use super::*;
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
            std::fs::metadata(path).unwrap().permissions().mode() & 0o077,
            0
        );
    }
}
