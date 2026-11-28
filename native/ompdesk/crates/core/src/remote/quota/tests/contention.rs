use super::*;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Command, Stdio};
use std::time::Instant;

// One year at about 27 requests/day. The permanent IDs, not today's count, determine snapshot size.
const HISTORY: usize = 10_000;
const ROUNDS: usize = 20;
const TEST: &str = "remote::quota::tests::contention::populated_device_reserve_and_refund_stay_below_the_hub_deadline";
const DIR: &str = "OMPDESK_TEST_QUOTA_CONTENTION_DIR";
const WORKER: &str = "OMPDESK_TEST_QUOTA_CONTENTION_WORKER";

#[test]
fn populated_device_reserve_and_refund_stay_below_the_hub_deadline() {
    if let Some(dir) = std::env::var_os(DIR) {
        let q = Quota::new(Which::Peers, Path::new(&dir));
        let worker = std::env::var(WORKER).unwrap();
        let mut timings = Vec::with_capacity(ROUNDS);
        writeln!(std::io::stdout(), "\nquota-ready").unwrap();
        std::io::stdout().flush().unwrap();
        std::io::stdin().read_exact(&mut [0; 1]).unwrap();
        for i in 0..ROUNDS {
            let id = format!("{worker}:{i}");
            let start = Instant::now();
            let result = reserve(&q, NEXT, &id, &id, 1).unwrap();
            let reserve_us = start.elapsed().as_micros() as u64;
            assert_eq!(result["ok"], true);
            let start = Instant::now();
            q.run("laptop", Action::Refund { id: &id }, NEXT).unwrap();
            timings.push([reserve_us, start.elapsed().as_micros() as u64]);
        }
        settled(&q);
        writeln!(
            std::io::stdout(),
            "\nquota-samples {}",
            serde_json::to_string(&timings).unwrap()
        )
        .unwrap();
        return;
    }

    let dir = tempdir().unwrap();
    seed(dir.path(), Which::Peers, json!({}));
    let q = Quota::new(Which::Peers, dir.path());
    reserve(&q, DAY, "seed", "seed-attempt", 1).unwrap();
    settled(&q);
    let path = ledger_path(&q.path, "laptop");
    let mut initial: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let ids = initial["reservations"].as_object_mut().unwrap();
    let mut receipt = ids.remove("seed").unwrap();
    for i in 0..HISTORY {
        receipt["attempt"] = json!(format!("00000000-0000-4000-a000-{i:012x}"));
        ids.insert(format!("delivery:{i:064x}"), receipt.clone());
    }
    initial["usage"][0]["requests"] = json!(HISTORY);
    fs::write(&path, serde_json::to_vec(&initial).unwrap()).unwrap();
    let bytes = fs::metadata(&path).unwrap().len();
    drop(initial);
    drop(q);

    let mut workers = [0, 1].map(|i| {
        Command::new(std::env::current_exe().unwrap())
            .args(["--exact", TEST, "--nocapture"])
            .env(DIR, dir.path())
            .env(WORKER, i.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap()
    });
    for child in &mut workers {
        let mut out = BufReader::new(child.stdout.take().unwrap());
        assert!(
            out.by_ref()
                .lines()
                .map(Result::unwrap)
                .any(|line| line == "quota-ready")
        );
        child.stdout = Some(out.into_inner());
    }
    for child in &mut workers {
        child.stdin.take().unwrap().write_all(&[1]).unwrap();
    }
    let mut samples = Vec::<[u64; 2]>::new();
    for child in workers {
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success(), "worker exited {}", out.status);
        let text = String::from_utf8(out.stdout).unwrap();
        let data = text
            .lines()
            .find_map(|line| line.strip_prefix("quota-samples "))
            .unwrap();
        samples.extend(serde_json::from_str::<Vec<[u64; 2]>>(data).unwrap());
    }
    assert_eq!(samples.len(), ROUNDS * 2);
    let q = Quota::new(Which::Peers, dir.path());
    assert_eq!(usage(&q, NEXT)["requests"], 0);
    for worker in 0..2 {
        for i in 0..ROUNDS {
            assert_eq!(
                reserve(&q, NEXT, &format!("{worker}:{i}"), "replay", 1).unwrap(),
                duplicate(false)
            );
        }
    }
    for (i, operation) in ["reserve", "refund"].iter().enumerate() {
        let mut times: Vec<_> = samples.iter().map(|sample| sample[i]).collect();
        times.sort_unstable();
        let p95 = times[(times.len() * 95).div_ceil(100) - 1];
        let max = *times.last().unwrap();
        // Use the process's stderr so passing Rust tests also print the evidence in CI.
        writeln!(std::io::stderr(), "quota-contention {operation} receipts={HISTORY} bytes={bytes} processes=2 n={} p95_us={p95} max_us={max}", times.len()).unwrap();
        assert!(
            p95 < 1_000_000 && max < 1_500_000,
            "{operation} lacks headroom below the hub's 2 s silence deadline"
        );
    }
}
