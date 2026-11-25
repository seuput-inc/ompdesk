use std::time::Duration;

use serde_json::{Value, json};

#[cfg(target_os = "macos")]
#[path = "sample/macos.rs"]
mod platform;
#[cfg(windows)]
#[path = "sample/windows.rs"]
mod platform;

pub(super) struct Sample {
    cpus: u32,
    busy_ticks: u64,
    idle_ticks: u64,
    process_start: u64,
    process_ns: u64,
    free_bytes: u64,
    total_bytes: u64,
    load1: Option<f64>,
}

#[cfg(any(target_os = "macos", windows))]
pub(super) fn read(pid: u32) -> Option<Sample> {
    platform::read(pid)
}

#[cfg(not(any(target_os = "macos", windows)))]
pub(super) fn read(_pid: u32) -> Option<Sample> {
    None
}

pub(super) fn facts(before: &Sample, after: &Sample, elapsed: Duration) -> Value {
    let mb = |bytes: u64| (bytes as f64 / 1_048_576.0).round() as u64;
    let share = |part: u64, whole: f64| ((100.0 * part as f64 / whole) * 10.0).round() / 10.0;
    let mut facts = json!({
        "availMB": mb(after.free_bytes),
        "totalMB": mb(after.total_bytes),
        "cpus": after.cpus,
    });
    if let (Some(busy), Some(idle)) = (
        after.busy_ticks.checked_sub(before.busy_ticks),
        after.idle_ticks.checked_sub(before.idle_ticks),
    ) && (busy != 0 || idle != 0)
    {
        facts["cpuBusyPct"] = share(busy, busy as f64 + idle as f64).into();
    }
    if let Some(load) = after.load1 {
        facts["load1"] = ((load * 100.0).round() / 100.0).into();
    }
    // A PID reused between the two reads has no process CPU interval.
    if before.process_start == after.process_start
        && let Some(ns) = after.process_ns.checked_sub(before.process_ns)
        && !elapsed.is_zero()
        && after.cpus != 0
    {
        facts["mainCpuPct"] = share(ns, elapsed.as_nanos() as f64 * f64::from(after.cpus)).into();
    }
    facts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_new_memory_and_load_and_both_cpu_shares_over_the_interval() {
        let before = Sample {
            cpus: 4,
            busy_ticks: 4_000,
            idle_ticks: 300,
            process_start: 42,
            process_ns: 90_000_000_000,
            free_bytes: 0,
            total_bytes: 0,
            load1: None,
        };
        let after = Sample {
            busy_ticks: 4_002,
            idle_ticks: 301,
            process_ns: 90_500_000_000,
            free_bytes: 80 * 1_048_576 + 524_288,
            total_bytes: 512 * 1_048_576 + 524_287,
            load1: Some(3.456),
            ..before
        };
        assert_eq!(
            facts(&before, &after, Duration::from_secs(1)),
            json!({ "availMB": 81, "totalMB": 512, "cpus": 4, "cpuBusyPct": 66.7,
                "load1": 3.46, "mainCpuPct": 12.5 })
        );
        assert_eq!(
            facts(&before, &before, Duration::ZERO),
            json!({ "availMB": 0, "totalMB": 0, "cpus": 4 })
        );
        let replacement = Sample {
            process_start: 43,
            ..after
        };
        let facts = facts(&before, &replacement, Duration::from_secs(1));
        assert_eq!(facts["cpuBusyPct"], 66.7);
        assert!(facts.get("mainCpuPct").is_none());
    }

    #[cfg(any(target_os = "macos", windows))]
    #[test]
    fn reads_the_private_node_child_between_its_own_cpu_readings() {
        use std::io::{BufRead, BufReader, Write};
        use std::process::{Command, Stdio};

        let mut child = Command::new("node")
            .args([
                "-e",
                r#"
                const os = require('node:os');
                const cpu = () => { const t = process.cpuUsage(); return t.user + t.system; };
                while (cpu() < 200000) {}
                console.log(JSON.stringify([os.cpus().length, os.totalmem(), cpu()]));
                process.stdin.once('data', () => { console.log(cpu()); process.stdin.pause(); });
            "#,
            ])
            .env_remove("NODE_OPTIONS")
            .env("NODE_DISABLE_COMPILE_CACHE", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let pid = child.id();
        let mut out = BufReader::new(child.stdout.take().unwrap()).lines();
        let ready = out.next().unwrap().unwrap();
        let sample = read(pid);
        child.stdin.as_mut().unwrap().write_all(b"x").unwrap();
        let end = out.next().unwrap().unwrap();
        assert!(child.wait().unwrap().success());

        let [cpus, total, start_us]: [u64; 3] = serde_json::from_str(&ready).unwrap();
        let end_us: u64 = end.parse().unwrap();
        let sample = sample.unwrap();
        assert_ne!(pid, std::process::id());
        assert_eq!(u64::from(sample.cpus), cpus);
        assert_eq!(sample.total_bytes, total);
        assert!(sample.free_bytes <= total && total > 0);
        assert!(sample.busy_ticks > 0 && sample.idle_ticks > 0);
        assert_eq!(sample.load1.is_some(), cfg!(target_os = "macos"));
        // Allow one Windows accounting tick and getrusage's microsecond truncation.
        let measured_us = sample.process_ns / 1_000;
        assert!(
            (start_us.saturating_sub(16_000)..=end_us + 16_000).contains(&measured_us),
            "child reported {start_us}..{end_us} us, watchdog read {measured_us} us"
        );
    }
}
