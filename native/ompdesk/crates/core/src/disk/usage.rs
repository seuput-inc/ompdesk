//! The disk breakdown, including which roots can reuse their previous directory measurements.
use std::path::Path;

use futures_util::future::join_all;
use serde::{Deserialize, Serialize};

use super::sizes::{Work, bytes};
use crate::git::read::{blocking, resolve};
use crate::server::{Call, Fault, Reply};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Params {
    reading: Option<u64>,
    cwd: String,
    worktrees: String,
    sessions: String,
    omp: String,
    app_data: String,
    scratch: Option<String>,
    caches: Vec<Target>,
}

#[derive(Deserialize, Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
enum Part {
    Worktrees,
    Sessions,
    OmpLogs,
    Stats,
    AppData,
    Scratch,
    BunCache,
    BunTranspilerCache,
    NpmCache,
}

#[derive(Deserialize, Serialize)]
struct Target {
    id: Part,
    path: String,
}

#[derive(Serialize)]
struct Row {
    #[serde(flatten)]
    target: Target,
    bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Usage {
    measured_at: u64,
    total: u64,
    parts: Vec<Row>,
}

#[derive(Serialize)]
struct Answer {
    usage: Usage,
    work: Work,
}

pub(super) async fn handle(call: Call) -> Result<Reply, Fault> {
    let params: Params = call.params()?;
    let omp_path = |name: &str| {
        Path::new(&params.omp)
            .join(name)
            .to_string_lossy()
            .into_owned()
    };
    let mut targets = Vec::with_capacity(6 + params.caches.len());
    for (id, path) in [
        (Part::Worktrees, params.worktrees),
        (Part::Sessions, params.sessions),
        (Part::OmpLogs, omp_path("logs")),
        (Part::Stats, omp_path("stats.db")),
        (Part::AppData, params.app_data),
    ] {
        targets.push(Target { id, path });
    }
    if let Some(path) = params.scratch.filter(|p| !p.is_empty()) {
        targets.push(Target {
            id: Part::Scratch,
            path,
        });
    }
    targets.extend(params.caches);

    let walks = targets.into_iter().map(|target| {
        let scope = call.scope.clone();
        let path = resolve(&params.cwd, &target.path);
        let reading = params.reading;
        blocking(move || {
            // Files rewritten in place (journals, logs, databases) cannot reuse a directory mtime.
            let reuse = matches!(
                target.id,
                Part::Worktrees | Part::BunCache | Part::BunTranspilerCache | Part::NpmCache
            );
            let walked = bytes(reading, &path, reuse, &scope)?;
            let mut count = walked.bytes;
            let mut work = walked.work;
            if matches!(target.id, Part::Stats) {
                for suffix in ["-wal", "-shm"] {
                    let sidecar = bytes(reading, &format!("{path}{suffix}"), false, &scope)?;
                    count += sidecar.bytes;
                    work.lstat += sidecar.work.lstat;
                    work.readdir += sidecar.work.readdir;
                }
            }
            let row = Row {
                target,
                bytes: count,
            };
            Ok::<_, Fault>((row, work))
        })
    });
    let mut parts = Vec::with_capacity(walks.len());
    let mut total = 0;
    let mut work = Work::default();
    for result in join_all(walks).await {
        let (row, measured) = result??;
        total += row.bytes;
        work.lstat += measured.lstat;
        work.readdir += measured.readdir;
        parts.push(row);
    }
    Reply::json(&Answer {
        usage: Usage {
            measured_at: crate::clock::now_ms(),
            total,
            parts,
        },
        work,
    })
}
