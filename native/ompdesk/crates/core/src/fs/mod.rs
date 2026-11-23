//! Workspace files for the Files panel, the file viewer, plan mode and a paired device's tabs (was
//! `src/main/workspace-fs.ts`). Main parses each call's arguments and resolves its paths with node's `path` rules
//! (`resolveWithin` confinement, `~` expansion), then hands absolute paths here; this side does the disk work and
//! every rule after it: the walk with its ignore rules, caps and name order, text decoding, the size caps, the
//! Files panel's validation and writes. A failure is a fault whose code is the app's `IpcErrorCode` (`io` when the
//! TypeScript set none) and whose message is node's text.

mod agent_files;
pub(crate) mod disk;
mod editor;
pub(crate) mod error;
mod ignore;
mod launch;
mod launcher_path;
mod list;
mod mime;
mod mutate;
pub(crate) mod order;
pub(crate) mod path;
mod read;
pub(crate) mod save_copy;
mod sidebar;

use serde_json::Value;

use crate::server::{Fault, Registry, Reply};

pub fn register(registry: &mut Registry) {
    registry.add("fs.agentFile", |call| {
        Box::pin(blocking(move || agent_files::run(call)))
    });
    registry.add("fs.initialCwd", |call| {
        Box::pin(blocking(move || launch::initial_cwd(call.params()?)))
    });
    registry.add("fs.defaultWorkspace", |call| {
        Box::pin(blocking(move || launch::workspace(call.params()?)))
    });
    registry.add("fs.isLauncherPath", |call| {
        Box::pin(blocking(move || launcher_path::classify(call.params()?)))
    });
    registry.add("fs.list", |call| {
        Box::pin(blocking(move || list::list(&call.params()?)))
    });
    registry.add("fs.listDirs", |call| {
        Box::pin(blocking(move || list::list_dirs(&call.params()?)))
    });
    registry.add("fs.readText", |call| {
        Box::pin(blocking(move || read::read_text(&call.params()?)))
    });
    registry.add("fs.readBinary", |call| {
        Box::pin(blocking(move || read::read_binary(&call.params()?)))
    });
    registry.add("fs.readRange", |call| {
        Box::pin(blocking(move || read::read_range(&call.params()?)))
    });
    registry.add("fs.readImage", |call| {
        Box::pin(blocking(move || read::read_image(&call.params()?)))
    });
    registry.add("fs.readPlan", |call| {
        Box::pin(blocking(move || read::read_plan(&call.params()?)))
    });
    registry.add("fs.resolveMedia", |call| {
        Box::pin(blocking(move || read::resolve_media(&call.params()?)))
    });
    registry.add("fs.stat", |call| {
        Box::pin(blocking(move || read::stat(&call.params()?)))
    });
    registry.add("fs.directory", |call| {
        Box::pin(blocking(move || read::directory(&call.params()?)))
    });
    registry.add("fs.mutate", |call| {
        Box::pin(blocking(move || mutate::mutate(call)))
    });
    registry.add("editor.prepare", |call| {
        Box::pin(blocking(move || editor::prepare(call)))
    });
    registry.add("editor.finish", |call| {
        Box::pin(blocking(move || editor::finish(call)))
    });
    registry.add("fs.saveCopy", |call| {
        Box::pin(blocking(move || save_copy::save(call.params()?)))
    });
    registry.add("fs.sidebarFolder", |call| {
        Box::pin(blocking(move || sidebar::folder(call.params()?)))
    });
}

/// Disk work runs on tokio's blocking pool, so a slow listing never holds a small read behind it.
async fn blocking(
    work: impl FnOnce() -> Result<Reply, Fault> + Send + 'static,
) -> Result<Reply, Fault> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| Fault::new("internal", "The file system call panicked"))?
}

/// `clampInt`: a finite number floored into `[min, max]`; anything else (absent, not a number) is `fallback`.
/// JSON carries no NaN or infinity, which were `fallback` there too.
fn clamp_int(value: Option<&Value>, min: f64, max: f64, fallback: f64) -> f64 {
    match value.and_then(Value::as_f64) {
        Some(number) if number.is_finite() => number.floor().max(min).min(max),
        _ => fallback,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamps_like_the_typescript() {
        let n = |v: Value| clamp_int(Some(&v), 1.0, 16.0, 8.0);
        assert_eq!(n(serde_json::json!(3.9)), 3.0);
        assert_eq!(n(serde_json::json!(-4)), 1.0);
        assert_eq!(n(serde_json::json!(99)), 16.0);
        assert_eq!(n(serde_json::json!("5")), 8.0);
        assert_eq!(n(Value::Null), 8.0);
        assert_eq!(clamp_int(None, 1.0, 16.0, 8.0), 8.0);
    }
}
