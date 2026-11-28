//! Rust-owned per-session process-tree memory & CPU accounting (`procs.sessionFootprints`).
//!
//! Replaces full-OS process transfers and quadratic JS grouping in `SessionProcesses.use()` with
//! a single native Rust pass that attributes every tagged process (`OMP_GUI_SESSION_TAG`) to its
//! owning session or orphan bucket, separates `omp` / console host / stock shared workers / user
//! child processes, sums working-set/footprint bytes and CPU time, flags hibernation-blocking
//! child trees and memory-budget spikes, and bounds per-session process rows without leaking argv.

use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::{
    Row, SESSION_TAG_ENV, STOCK_WORKER_ARG, begot, check_env, check_tag, cpu_ns, plan, scan,
};
use crate::server::{Call, Fault, Registry, Reply};

const DEFAULT_TIMEOUT_MS: u64 = 10_000;
const DEFAULT_TOP_PER_SESSION: usize = 8;
const MAX_TOP_PER_SESSION: usize = 32;
const MAX_ORPHAN_GROUPS: usize = 16;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub tag: String,
    #[serde(default)]
    pub tab_id: Option<String>,
    #[serde(default)]
    pub session_path: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub omp_pid: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FootprintsParams {
    #[serde(default)]
    env: Option<String>,
    #[serde(default)]
    keep_arg: Option<String>,
    #[serde(default)]
    sessions: Vec<SessionMeta>,
    #[serde(default = "default_true")]
    include_orphans: bool,
    #[serde(default)]
    spike_bytes: Option<u64>,
    #[serde(default)]
    top_per_session: Option<usize>,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackedProcess {
    pub pid: u32,
    pub ppid: u32,
    pub name: String,
    pub bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_ms: Option<u64>,
    pub omp: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub stock: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFootprint {
    pub tag: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub omp_pid: Option<u32>,
    pub total_bytes: u64,
    pub omp_bytes: u64,
    pub children_bytes: u64,
    pub stock_worker_bytes: u64,
    pub total_cpu_ms: u64,
    pub process_count: usize,
    pub child_count: usize,
    pub stock_worker_count: usize,
    /// True when the session owns non-console, non-stock child work that blocks safe hibernation.
    pub has_blocking_children: bool,
    /// True when `spikeBytes` was configured and `totalBytes >= spikeBytes`.
    pub over_budget: bool,
    pub top_processes: Vec<TrackedProcess>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanGroup {
    pub tag: String,
    pub total_bytes: u64,
    pub total_cpu_ms: u64,
    pub process_count: usize,
    pub top_processes: Vec<TrackedProcess>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFootprintsReport {
    pub sampled_at_ms: u64,
    pub total_session_bytes: u64,
    pub total_orphan_bytes: u64,
    pub session_count: usize,
    pub orphan_process_count: usize,
    pub sessions: Vec<SessionFootprint>,
    pub orphans: Vec<OrphanGroup>,
}

pub(super) fn register(registry: &mut Registry) {
    registry.add("procs.sessionFootprints", |call| {
        Box::pin(session_footprints(call))
    });
}

fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

async fn session_footprints(call: Call) -> Result<Reply, Fault> {
    let params: FootprintsParams = call.params()?;
    let env = params.env.as_deref().unwrap_or(SESSION_TAG_ENV);
    check_env(env)?;
    let keep_arg = match params.keep_arg.as_deref() {
        Some("") => {
            return Err(Fault::new(
                "invalid_params",
                "keepArg is empty, which every argument starts with",
            ));
        }
        Some(arg) => Some(arg),
        None => Some(STOCK_WORKER_ARG),
    };
    for session in &params.sessions {
        check_tag(&session.tag)?;
    }

    let timeout_ms = params.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
    let args_of: HashSet<String> = params.sessions.iter().map(|s| s.tag.clone()).collect();
    let rows = scan(env, timeout_ms, call.scope, args_of, false).await?;
    let cpu_ms: Vec<Option<u64>> = rows
        .iter()
        .map(|row| {
            row.tag
                .as_ref()
                .and_then(|_| cpu_ns(row).map(|ns| ns / 1_000_000))
        })
        .collect();
    let top_per_session = params
        .top_per_session
        .unwrap_or(DEFAULT_TOP_PER_SESSION)
        .clamp(1, MAX_TOP_PER_SESSION);

    let report = aggregate(
        &rows,
        &cpu_ms,
        &params.sessions,
        std::process::id(),
        keep_arg,
        cfg!(windows),
        params.include_orphans,
        params.spike_bytes,
        top_per_session,
        now_epoch_ms(),
    );
    Reply::json(&report)
}

fn is_console_host(name: &str, windows: bool) -> bool {
    windows && name.eq_ignore_ascii_case("conhost.exe")
}

/// On Windows a tab's `omp_pid` is often a launcher (`omp.exe` shim or `cmd.exe`) whose sole
/// non-console direct child is the `bun.exe` running `omp` itself. Identify that one direct
/// runtime PID so we don't misclassify the sidecar's own runtime as a hibernation-blocking child.
fn windows_launcher_runtime_pid(rows: &[Row], omp_pid: u32, windows: bool) -> Option<u32> {
    if !windows {
        return None;
    }
    let launcher = rows.iter().find(|r| r.pid == omp_pid)?;
    let mut direct_non_console = rows
        .iter()
        .filter(|r| begot(launcher, r) && !is_console_host(&r.name, true));
    let only = direct_non_console.next()?;
    if direct_non_console.next().is_some() {
        return None;
    }
    Some(only.pid)
}

#[allow(clippy::too_many_arguments)]
fn aggregate(
    rows: &[Row],
    cpu_ms: &[Option<u64>],
    sessions_meta: &[SessionMeta],
    me_pid: u32,
    keep_arg: Option<&str>,
    windows: bool,
    include_orphans: bool,
    spike_bytes: Option<u64>,
    top_per_session: usize,
    sampled_at_ms: u64,
) -> SessionFootprintsReport {
    let known_tags: HashSet<String> = sessions_meta.iter().map(|s| s.tag.clone()).collect();
    let kept_indices: HashSet<usize> = match keep_arg {
        Some(arg) => plan(rows, me_pid, &known_tags, Some(arg))
            .kept
            .into_iter()
            .collect(),
        None => HashSet::new(),
    };

    let meta_by_tag: HashMap<&str, &SessionMeta> = sessions_meta
        .iter()
        .map(|meta| (meta.tag.as_str(), meta))
        .collect();

    let mut by_session: HashMap<&str, Vec<usize>> = HashMap::new();
    let mut by_orphan: HashMap<&str, Vec<usize>> = HashMap::new();

    for (idx, row) in rows.iter().enumerate() {
        let Some(tag) = row.tag.as_deref() else {
            continue;
        };
        if meta_by_tag.contains_key(tag) {
            by_session.entry(tag).or_default().push(idx);
        } else if include_orphans {
            by_orphan.entry(tag).or_default().push(idx);
        }
    }

    let mut sessions = Vec::with_capacity(by_session.len());
    let mut total_session_bytes: u64 = 0;

    for (tag, indices) in by_session {
        let meta = meta_by_tag[tag];
        let runtime_pid = meta
            .omp_pid
            .and_then(|pid| windows_launcher_runtime_pid(rows, pid, windows));

        let mut total_bytes: u64 = 0;
        let mut omp_bytes: u64 = 0;
        let mut children_bytes: u64 = 0;
        let mut stock_worker_bytes: u64 = 0;
        let mut total_cpu_ms: u64 = 0;
        let mut child_count: usize = 0;
        let mut stock_worker_count: usize = 0;
        let mut has_blocking_children = false;
        let mut procs = Vec::with_capacity(indices.len());

        for idx in indices {
            let row = &rows[idx];
            let cpu = cpu_ms.get(idx).copied().flatten();
            let stock = kept_indices.contains(&idx);
            let is_omp = meta.omp_pid == Some(row.pid)
                || (runtime_pid.is_some() && runtime_pid == Some(row.pid));
            let console = is_console_host(&row.name, windows);

            total_bytes = total_bytes.saturating_add(row.bytes);
            if let Some(ms) = cpu {
                total_cpu_ms = total_cpu_ms.saturating_add(ms);
            }

            if stock {
                stock_worker_bytes = stock_worker_bytes.saturating_add(row.bytes);
                stock_worker_count += 1;
            } else if is_omp {
                omp_bytes = omp_bytes.saturating_add(row.bytes);
            } else {
                children_bytes = children_bytes.saturating_add(row.bytes);
                if !console {
                    child_count += 1;
                    has_blocking_children = true;
                }
            }

            procs.push(TrackedProcess {
                pid: row.pid,
                ppid: row.ppid,
                name: row.name.clone(),
                bytes: row.bytes,
                cpu_ms: cpu,
                started_ms: row.started_ms,
                omp: meta.omp_pid == Some(row.pid),
                stock,
            });
        }

        procs.sort_by(|a, b| {
            b.omp
                .cmp(&a.omp)
                .then_with(|| b.bytes.cmp(&a.bytes))
                .then_with(|| a.pid.cmp(&b.pid))
        });
        let process_count = procs.len();
        procs.truncate(top_per_session);

        total_session_bytes = total_session_bytes.saturating_add(total_bytes);
        let over_budget = spike_bytes.is_some_and(|limit| total_bytes >= limit);

        sessions.push(SessionFootprint {
            tag: meta.tag.clone(),
            tab_id: meta.tab_id.clone(),
            session_path: meta.session_path.clone(),
            cwd: meta.cwd.clone(),
            label: meta.label.clone(),
            omp_pid: meta.omp_pid,
            total_bytes,
            omp_bytes,
            children_bytes,
            stock_worker_bytes,
            total_cpu_ms,
            process_count,
            child_count,
            stock_worker_count,
            has_blocking_children,
            over_budget,
            top_processes: procs,
        });
    }

    sessions.sort_by(|a, b| {
        b.total_bytes
            .cmp(&a.total_bytes)
            .then_with(|| a.tag.cmp(&b.tag))
    });

    let mut orphans = Vec::with_capacity(by_orphan.len());
    let mut total_orphan_bytes: u64 = 0;
    let mut orphan_process_count: usize = 0;

    for (tag, indices) in by_orphan {
        let mut group_bytes: u64 = 0;
        let mut group_cpu_ms: u64 = 0;
        let mut procs = Vec::with_capacity(indices.len());
        for idx in indices {
            let row = &rows[idx];
            let cpu = cpu_ms.get(idx).copied().flatten();
            group_bytes = group_bytes.saturating_add(row.bytes);
            if let Some(ms) = cpu {
                group_cpu_ms = group_cpu_ms.saturating_add(ms);
            }
            procs.push(TrackedProcess {
                pid: row.pid,
                ppid: row.ppid,
                name: row.name.clone(),
                bytes: row.bytes,
                cpu_ms: cpu,
                started_ms: row.started_ms,
                omp: false,
                stock: false,
            });
        }
        procs.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.pid.cmp(&b.pid)));
        let process_count = procs.len();
        procs.truncate(top_per_session);

        total_orphan_bytes = total_orphan_bytes.saturating_add(group_bytes);
        orphan_process_count += process_count;
        orphans.push(OrphanGroup {
            tag: tag.to_owned(),
            total_bytes: group_bytes,
            total_cpu_ms: group_cpu_ms,
            process_count,
            top_processes: procs,
        });
    }

    orphans.sort_by(|a, b| {
        b.total_bytes
            .cmp(&a.total_bytes)
            .then_with(|| a.tag.cmp(&b.tag))
    });
    orphans.truncate(MAX_ORPHAN_GROUPS);

    let session_count = sessions.len();
    SessionFootprintsReport {
        sampled_at_ms,
        total_session_bytes,
        total_orphan_bytes,
        session_count,
        orphan_process_count,
        sessions,
        orphans,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TAG_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const TAG_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const TAG_ORPHAN: &str = "cccccccccccccccccccccccccccccccc";

    fn make_row(
        pid: u32,
        ppid: u32,
        bytes: u64,
        name: &str,
        tag: Option<&str>,
        args: &[&str],
    ) -> Row {
        Row {
            pid,
            ppid,
            bytes,
            started_ms: Some(1_000 + u64::from(pid)),
            name: name.into(),
            tag: tag.map(str::to_owned),
            args: args.iter().map(|s| (*s).to_owned()).collect(),
            ..Row::default()
        }
    }

    #[test]
    fn aggregates_sessions_separates_stock_workers_and_detects_orphans_and_spikes() {
        let rows = vec![
            // Session A: omp (100) + stock worker (101) + stock worker child (102) => NO blocking children
            make_row(100, 1, 300 << 20, "bun", Some(TAG_A), &["omp"]),
            make_row(
                101,
                100,
                80 << 20,
                "bun",
                Some(TAG_A),
                &["bun", "__omp_worker_lsp"],
            ),
            make_row(102, 101, 40 << 20, "rust-analyzer", Some(TAG_A), &[]),
            // Session B: omp (200) + user dev server (201) => HAS blocking children & exceeds 500 MiB spike budget
            make_row(200, 1, 250 << 20, "bun", Some(TAG_B), &["omp"]),
            make_row(201, 200, 400 << 20, "node", Some(TAG_B), &["next-server"]),
            // Orphan tag from a closed session
            make_row(300, 1, 180 << 20, "vite", Some(TAG_ORPHAN), &[]),
            // Unrelated system process
            make_row(400, 1, 900 << 20, "chrome", None, &[]),
        ];
        let cpu = vec![
            Some(1200),
            Some(300),
            Some(500),
            Some(400),
            Some(2500),
            Some(9000),
            Some(50),
        ];
        let metas = vec![
            SessionMeta {
                tag: TAG_A.into(),
                tab_id: Some("tab-a".into()),
                session_path: Some("/s/a.jsonl".into()),
                cwd: Some("/repo/a".into()),
                label: Some("A".into()),
                omp_pid: Some(100),
            },
            SessionMeta {
                tag: TAG_B.into(),
                tab_id: Some("tab-b".into()),
                session_path: Some("/s/b.jsonl".into()),
                cwd: Some("/repo/b".into()),
                label: Some("B".into()),
                omp_pid: Some(200),
            },
        ];

        let report = aggregate(
            &rows,
            &cpu,
            &metas,
            999,
            Some(STOCK_WORKER_ARG),
            false,
            true,
            Some(500 << 20),
            8,
            123_456,
        );

        assert_eq!(report.sampled_at_ms, 123_456);
        assert_eq!(report.session_count, 2);
        assert_eq!(report.sessions[0].tag, TAG_B);
        assert_eq!(report.sessions[0].total_bytes, 650 << 20);
        assert_eq!(report.sessions[0].omp_bytes, 250 << 20);
        assert_eq!(report.sessions[0].children_bytes, 400 << 20);
        assert_eq!(report.sessions[0].total_cpu_ms, 2900);
        assert_eq!(report.sessions[0].child_count, 1);
        assert!(report.sessions[0].has_blocking_children);
        assert!(report.sessions[0].over_budget);
        assert!(report.sessions[0].top_processes[0].omp);

        assert_eq!(report.sessions[1].tag, TAG_A);
        assert_eq!(report.sessions[1].total_bytes, 420 << 20);
        assert_eq!(report.sessions[1].omp_bytes, 300 << 20);
        assert_eq!(report.sessions[1].stock_worker_bytes, 120 << 20);
        assert_eq!(report.sessions[1].stock_worker_count, 2);
        assert_eq!(report.sessions[1].child_count, 0);
        assert!(!report.sessions[1].has_blocking_children);
        assert!(!report.sessions[1].over_budget);

        assert_eq!(report.total_session_bytes, (650 + 420) << 20);
        assert_eq!(report.total_orphan_bytes, 180 << 20);
        assert_eq!(report.orphan_process_count, 1);
        assert_eq!(report.orphans.len(), 1);
        assert_eq!(report.orphans[0].tag, TAG_ORPHAN);
        assert_eq!(report.orphans[0].total_cpu_ms, 9000);
    }

    #[test]
    fn windows_launcher_and_conhost_do_not_mark_session_as_having_blocking_children() {
        let rows = vec![
            make_row(10, 1, 5 << 20, "omp.exe", Some(TAG_A), &[]),
            make_row(11, 10, 2 << 20, "ConHost.EXE", Some(TAG_A), &[]),
            make_row(12, 10, 350 << 20, "bun.exe", Some(TAG_A), &[]),
            make_row(13, 12, 3 << 20, "conhost.exe", Some(TAG_A), &[]),
        ];
        let cpu = vec![Some(10), Some(5), Some(800), Some(2)];
        let metas = vec![SessionMeta {
            tag: TAG_A.into(),
            tab_id: Some("tab-win".into()),
            session_path: None,
            cwd: None,
            label: None,
            omp_pid: Some(10),
        }];

        let report = aggregate(
            &rows,
            &cpu,
            &metas,
            999,
            Some(STOCK_WORKER_ARG),
            true,
            true,
            None,
            8,
            42,
        );
        assert_eq!(report.sessions.len(), 1);
        let session = &report.sessions[0];
        assert_eq!(session.omp_bytes, 355 << 20);
        assert_eq!(session.children_bytes, 5 << 20);
        assert_eq!(session.child_count, 0);
        assert!(!session.has_blocking_children);
    }

    #[test]
    fn bounds_top_processes_per_session_keeping_omp_first() {
        let mut rows = vec![make_row(10, 1, 50 << 20, "omp", Some(TAG_A), &[])];
        for i in 1..=20u32 {
            rows.push(make_row(
                100 + i,
                10,
                u64::from(i) << 20,
                "worker",
                Some(TAG_A),
                &[],
            ));
        }
        let cpu = vec![None; rows.len()];
        let metas = vec![SessionMeta {
            tag: TAG_A.into(),
            tab_id: Some("tab-a".into()),
            session_path: None,
            cwd: None,
            label: None,
            omp_pid: Some(10),
        }];

        let report = aggregate(&rows, &cpu, &metas, 999, None, false, false, None, 4, 1);
        let session = &report.sessions[0];
        assert_eq!(session.process_count, 21);
        assert_eq!(session.top_processes.len(), 4);
        assert!(session.top_processes[0].omp);
        assert_eq!(session.top_processes[1].pid, 120);
        assert_eq!(session.top_processes[2].pid, 119);
        assert_eq!(session.top_processes[3].pid, 118);
    }
}
