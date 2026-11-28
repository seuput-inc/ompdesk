//! Direct core IPC handlers for 23 `ai-memory:*` channels (H(c), routed `tauri-shell -> ompdesk-core`):
//! the 17 wiki/data channels plus the 6 lifecycle & maintenance care channels (`get-state`, `retry`, `purge`,
//! `set-terminal`, `care`, `care-undo`).
//!
//! Validation and error messages match the retired Node wrappers in `src/main/ai-memory/ipc.ts` 1-to-1; each call
//! talks directly to the active local ai-memory service/server without hopping through Node main.

use serde_json::{Value, json};

use super::client::{Client, Server};
use super::ops::{DeleteInput, PageAt, ProjectRef, WriteInput};
use super::{out, service};
use crate::care::{Common as CareCommon, Ctx as CareCtx, engine as care_engine};
use crate::ipc::{Handled, IpcContext};
use crate::server::Fault;

fn invalid(message: impl Into<String>) -> Fault {
    Fault::new("invalid_params", message)
}

fn project_ref(value: Option<&Value>) -> Result<Option<ProjectRef>, Fault> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let Some(obj) = value.as_object() else {
        return Err(invalid("Invalid project"));
    };
    let workspace = obj.get("workspace").and_then(Value::as_str);
    let project = obj.get("project").and_then(Value::as_str);
    match (workspace, project) {
        (Some(w), Some(p)) if !w.is_empty() && !p.is_empty() => Ok(Some(ProjectRef {
            workspace: w.to_owned(),
            project: p.to_owned(),
        })),
        _ => Err(invalid("Invalid project")),
    }
}

fn require_project(value: Option<&Value>) -> Result<ProjectRef, Fault> {
    project_ref(value)?.ok_or_else(|| invalid("Invalid project"))
}

fn read_page_ref(value: Option<&Value>) -> Result<PageAt, Fault> {
    let project = project_ref(value)?;
    let path = value.and_then(|v| v.get("path")).and_then(Value::as_str);
    match (project, path) {
        (Some(project), Some(path)) if !path.is_empty() => Ok(PageAt {
            project,
            path: path.to_owned(),
        }),
        _ => Err(invalid("Invalid page")),
    }
}

fn page_ref(value: Option<&Value>) -> Result<PageAt, Fault> {
    let project = require_project(value)?;
    let path = value.and_then(|v| v.get("path")).and_then(Value::as_str);
    match path {
        Some(path)
            if !path.is_empty()
                && !path.starts_with('/')
                && !path.split('/').any(|part| part == "..") =>
        {
            Ok(PageAt {
                project,
                path: path.to_owned(),
            })
        }
        _ => Err(invalid("Invalid page")),
    }
}

fn text(value: Option<&Value>, name: &str) -> Result<String, Fault> {
    match value.and_then(Value::as_str) {
        Some(s) if !s.is_empty() => Ok(s.to_owned()),
        _ => Err(invalid(format!("Invalid argument: {name}"))),
    }
}

fn optional_text(value: Option<&Value>, name: &str) -> Result<Option<String>, Fault> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(invalid(format!("Invalid argument: {name}"))),
    }
}

fn optional_offset(value: Option<&Value>) -> Result<f64, Fault> {
    match value {
        None | Some(Value::Null) => Ok(0.0),
        Some(v) => v
            .as_f64()
            .ok_or_else(|| invalid("Invalid argument: offset")),
    }
}

fn parse_write_input(value: Option<&Value>) -> Result<(PageAt, WriteInput), Fault> {
    let at = page_ref(value)?;
    let obj = value
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("Invalid page"))?;
    let body = obj
        .get("body")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("Invalid argument: body"))?
        .to_owned();
    let tags = match obj.get("tags") {
        None => None,
        Some(Value::Array(items)) => {
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                let Some(tag) = item.as_str() else {
                    return Err(invalid("Invalid argument: tags"));
                };
                out.push(tag.to_owned());
            }
            Some(out)
        }
        Some(_) => return Err(invalid("Invalid argument: tags")),
    };
    let pinned = match obj.get("pinned") {
        None => None,
        Some(Value::Bool(b)) => Some(*b),
        Some(_) => return Err(invalid("Invalid argument: pinned")),
    };
    let title = optional_text(obj.get("title"), "title")?;
    let kind = optional_text(obj.get("kind"), "kind")?;
    let tier = optional_text(obj.get("tier"), "tier")?;
    Ok((
        at,
        WriteInput {
            body,
            title,
            kind,
            tier,
            tags,
            pinned,
        },
    ))
}

async fn run_projects(server: Server) -> Result<Option<Value>, Fault> {
    let client = Client::new(server);
    Ok(Some(out(client.projects().await?)?))
}

async fn run_search(server: Server, args: Vec<Value>) -> Result<Option<Value>, Fault> {
    let query = args
        .first()
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("Invalid argument: query"))?;
    let project = project_ref(args.get(1))?;
    let client = Client::new(server);
    Ok(Some(out(client.search(query, project.as_ref()).await?)?))
}

async fn run_recent(server: Server, args: Vec<Value>) -> Result<Option<Value>, Fault> {
    let project = project_ref(args.first())?;
    let client = Client::new(server);
    let pages = match project {
        Some(project) => client.recent(&project).await?,
        None => client.recent_everywhere().await?,
    };
    Ok(Some(out(pages)?))
}

async fn run_handoffs(server: Server, args: Vec<Value>) -> Result<Option<Value>, Fault> {
    let project = project_ref(args.first())?;
    let client = Client::new(server);
    Ok(Some(out(client.handoffs(project).await?)?))
}

async fn run_read_page(server: Server, args: Vec<Value>) -> Result<Option<Value>, Fault> {
    let at = read_page_ref(args.first())?;
    let client = Client::new(server);
    Ok(Some(out(client.page(&at).await?)?))
}

async fn run_overview(server: Server, args: Vec<Value>) -> Result<Option<Value>, Fault> {
    let project = require_project(args.first())?;
    let client = Client::new(server);
    Ok(Some(out(client.overview(&project).await?)?))
}

async fn run_pages(server: Server, args: Vec<Value>) -> Result<Option<Value>, Fault> {
    let project = require_project(args.first())?;
    let client = Client::new(server);
    Ok(Some(out(client.pages(&project).await?)?))
}

async fn run_sessions(server: Server, args: Vec<Value>) -> Result<Option<Value>, Fault> {
    let project = require_project(args.first())?;
    let client = Client::new(server);
    Ok(Some(out(client.sessions(&project, None, None).await?)?))
}

async fn run_observations(server: Server, args: Vec<Value>) -> Result<Option<Value>, Fault> {
    let offset = optional_offset(args.get(2))?;
    let project = require_project(args.first())?;
    let session_id = text(args.get(1), "sessionId")?;
    let client = Client::new(server);
    Ok(Some(out(client
        .observations(&project, &session_id, offset, &[])
        .await?)?))
}

async fn run_profile(server: Server) -> Result<Option<Value>, Fault> {
    let client = Client::new(server);
    Ok(Some(out(client.profile().await?)?))
}

async fn run_lint(server: Server, args: Vec<Value>) -> Result<Option<Value>, Fault> {
    let project = require_project(args.first())?;
    let client = Client::new(server);
    Ok(Some(out(client.lint(&project).await?)?))
}

async fn run_sweep(server: Server, args: Vec<Value>) -> Result<Option<Value>, Fault> {
    let dry_run = args
        .get(1)
        .and_then(Value::as_bool)
        .ok_or_else(|| invalid("Invalid argument: dryRun"))?;
    let project = require_project(args.first())?;
    let client = Client::new(server);
    Ok(Some(out(client.sweep(&project, dry_run).await?)?))
}

async fn run_write_page(server: Server, args: Vec<Value>) -> Result<Option<Value>, Fault> {
    let (at, input) = parse_write_input(args.first())?;
    let client = Client::new(server);
    client.write_page(&at, &input).await?;
    Ok(None)
}

async fn run_delete_page(server: Server, args: Vec<Value>) -> Result<Option<Value>, Fault> {
    let at = page_ref(args.first())?;
    let title = optional_text(args.first().and_then(|v| v.get("title")), "title")?;
    let client = Client::new(server);
    Ok(Some(out(client
        .delete_page(&at, &DeleteInput { title })
        .await?)?))
}

async fn run_restore_page(server: Server, args: Vec<Value>) -> Result<Option<Value>, Fault> {
    let at = page_ref(args.first())?;
    let rev = text(args.get(1), "rev")?;
    let client = Client::new(server);
    client.restore_page(&at, &rev).await?;
    Ok(None)
}

async fn run_feedback(server: Server, args: Vec<Value>) -> Result<Option<Value>, Fault> {
    let signal = match args.get(1).and_then(Value::as_str) {
        Some(s @ ("helpful" | "not_helpful")) => s,
        _ => return Err(invalid("Invalid argument: signal")),
    };
    let at = page_ref(args.first())?;
    let client = Client::new(server);
    client.feedback(&at, signal).await?;
    Ok(None)
}

async fn run_cancel_handoff(server: Server, args: Vec<Value>) -> Result<Option<Value>, Fault> {
    let project = require_project(args.first())?;
    let id = text(args.get(1), "id")?;
    let client = Client::new(server);
    client.cancel_handoff(&project, &id).await?;
    Ok(None)
}

pub(crate) fn ipc_get_state(_ctx: IpcContext, _args: Vec<Value>) -> Handled {
    Box::pin(async move {
        let Some(svc) = service::current_service() else {
            return Ok(Some(out(service::initial_state())?));
        };
        let state = svc.state();
        tokio::spawn(async move {
            let _ = svc.refresh().await;
        });
        Ok(Some(out(state)?))
    })
}

pub(crate) fn ipc_retry(_ctx: IpcContext, _args: Vec<Value>) -> Handled {
    Box::pin(async move {
        if let Some(svc) = service::current_service() {
            svc.queue_retry();
        }
        Ok(None)
    })
}

pub(crate) fn ipc_purge(_ctx: IpcContext, _args: Vec<Value>) -> Handled {
    Box::pin(async move {
        let Some(svc) = service::current_service() else {
            return Err(Fault::new(
                "memory_not_managed",
                "ai-memory is not managed by this build.",
            ));
        };
        svc.run_purge().await?;
        Ok(None)
    })
}

pub(crate) fn ipc_set_terminal(_ctx: IpcContext, args: Vec<Value>) -> Handled {
    Box::pin(async move {
        let Some(enabled) = args.first().and_then(Value::as_bool) else {
            return Err(invalid("Invalid argument: enabled"));
        };
        let Some(svc) = service::current_service() else {
            return Err(Fault::new(
                "memory_not_managed",
                "ai-memory is not managed by this build.",
            ));
        };
        svc.run_set_terminal(enabled).await?;
        Ok(None)
    })
}

pub(crate) fn ipc_care(ctx: IpcContext, _args: Vec<Value>) -> Handled {
    Box::pin(async move {
        let Some(user_data) = ctx.user_data else {
            return Ok(Some(Value::Null));
        };
        let Some((care_name, events)) = service::current_service().and_then(|s| s.care_client())
        else {
            return Ok(Some(Value::Null));
        };
        let state_file = user_data
            .join("ai-memory")
            .join("care.json")
            .to_string_lossy()
            .into_owned();
        let care_ctx = CareCtx::new(
            CareCommon {
                service: care_name,
                asks: Vec::new(),
                server: service::current_server(),
                stock_host: String::new(),
                locale: String::new(),
                now: None,
            },
            &events,
        );
        let summary = care_engine::summary(&care_ctx, &state_file).await;
        Ok(Some(summary.unwrap_or(Value::Null)))
    })
}

pub(crate) fn ipc_care_undo(ctx: IpcContext, _args: Vec<Value>) -> Handled {
    Box::pin(async move {
        let Some(user_data) = ctx.user_data else {
            return Ok(Some(json!(0)));
        };
        let Some((care_name, events)) = service::current_service().and_then(|s| s.care_client())
        else {
            return Ok(Some(json!(0)));
        };
        let state_file = user_data
            .join("ai-memory")
            .join("care.json")
            .to_string_lossy()
            .into_owned();
        let gate = care_engine::service(&care_name);
        let care_ctx = CareCtx::new(
            CareCommon {
                service: care_name,
                asks: Vec::new(),
                server: service::current_server(),
                stock_host: String::new(),
                locale: String::new(),
                now: None,
            },
            &events,
        );
        let restored = care_engine::undo(&gate, &care_ctx, &state_file).await?;
        Ok(Some(json!(restored)))
    })
}

pub(crate) fn ipc_projects(_ctx: IpcContext, _args: Vec<Value>) -> Handled {
    Box::pin(run_projects(service::current_server()))
}
pub(crate) fn ipc_search(_ctx: IpcContext, args: Vec<Value>) -> Handled {
    Box::pin(run_search(service::current_server(), args))
}
pub(crate) fn ipc_recent(_ctx: IpcContext, args: Vec<Value>) -> Handled {
    Box::pin(run_recent(service::current_server(), args))
}
pub(crate) fn ipc_handoffs(_ctx: IpcContext, args: Vec<Value>) -> Handled {
    Box::pin(run_handoffs(service::current_server(), args))
}
pub(crate) fn ipc_read_page(_ctx: IpcContext, args: Vec<Value>) -> Handled {
    Box::pin(run_read_page(service::current_server(), args))
}
pub(crate) fn ipc_overview(_ctx: IpcContext, args: Vec<Value>) -> Handled {
    Box::pin(run_overview(service::current_server(), args))
}
pub(crate) fn ipc_pages(_ctx: IpcContext, args: Vec<Value>) -> Handled {
    Box::pin(run_pages(service::current_server(), args))
}
pub(crate) fn ipc_sessions(_ctx: IpcContext, args: Vec<Value>) -> Handled {
    Box::pin(run_sessions(service::current_server(), args))
}
pub(crate) fn ipc_observations(_ctx: IpcContext, args: Vec<Value>) -> Handled {
    Box::pin(run_observations(service::current_server(), args))
}
pub(crate) fn ipc_profile(_ctx: IpcContext, _args: Vec<Value>) -> Handled {
    Box::pin(run_profile(service::current_server()))
}
pub(crate) fn ipc_lint(_ctx: IpcContext, args: Vec<Value>) -> Handled {
    Box::pin(run_lint(service::current_server(), args))
}
pub(crate) fn ipc_sweep(_ctx: IpcContext, args: Vec<Value>) -> Handled {
    Box::pin(run_sweep(service::current_server(), args))
}
pub(crate) fn ipc_write_page(_ctx: IpcContext, args: Vec<Value>) -> Handled {
    Box::pin(run_write_page(service::current_server(), args))
}
pub(crate) fn ipc_delete_page(_ctx: IpcContext, args: Vec<Value>) -> Handled {
    Box::pin(run_delete_page(service::current_server(), args))
}
pub(crate) fn ipc_restore_page(_ctx: IpcContext, args: Vec<Value>) -> Handled {
    Box::pin(run_restore_page(service::current_server(), args))
}
pub(crate) fn ipc_feedback(_ctx: IpcContext, args: Vec<Value>) -> Handled {
    Box::pin(run_feedback(service::current_server(), args))
}
pub(crate) fn ipc_cancel_handoff(_ctx: IpcContext, args: Vec<Value>) -> Handled {
    Box::pin(run_cancel_handoff(service::current_server(), args))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::aimemory::tests::{data_dir, fake};
    use serde_json::json;

    fn project() -> Value {
        json!({"workspace": "w", "project": "p"})
    }

    fn page() -> Value {
        json!({"workspace": "w", "project": "p", "path": "notes/a.md"})
    }

    #[tokio::test]
    async fn validates_arguments_matching_former_node_ipc_rules() {
        let server = Server {
            url: Some("http://127.0.0.1:1".into()),
            data_dir: None,
        };

        // search query
        assert_eq!(
            run_search(server.clone(), vec![json!(5)])
                .await
                .unwrap_err()
                .message,
            "Invalid argument: query"
        );

        // malformed project refs everywhere
        for bad in [
            json!("p"),
            json!(3),
            json!({"workspace": "w"}),
            json!({"workspace": "", "project": "p"}),
            json!({"workspace": "w", "project": 2}),
            json!([]),
        ] {
            assert_eq!(
                run_recent(server.clone(), vec![bad.clone()])
                    .await
                    .unwrap_err()
                    .message,
                "Invalid project"
            );
            assert_eq!(
                run_handoffs(server.clone(), vec![bad.clone()])
                    .await
                    .unwrap_err()
                    .message,
                "Invalid project"
            );
            assert_eq!(
                run_search(server.clone(), vec![json!("x"), bad.clone()])
                    .await
                    .unwrap_err()
                    .message,
                "Invalid project"
            );
            assert_eq!(
                run_overview(server.clone(), vec![bad.clone()])
                    .await
                    .unwrap_err()
                    .message,
                "Invalid project"
            );
            assert_eq!(
                run_pages(server.clone(), vec![bad.clone()])
                    .await
                    .unwrap_err()
                    .message,
                "Invalid project"
            );
            assert_eq!(
                run_sessions(server.clone(), vec![bad.clone()])
                    .await
                    .unwrap_err()
                    .message,
                "Invalid project"
            );
            assert_eq!(
                run_lint(server.clone(), vec![bad])
                    .await
                    .unwrap_err()
                    .message,
                "Invalid project"
            );
        }

        // read-page validation
        for bad in [
            Value::Null,
            project(),
            json!({"workspace": "w", "project": "p", "path": ""}),
            json!({"workspace": "w", "project": "p", "path": 3}),
            json!({"workspace": "w", "path": "a.md"}),
        ] {
            let msg = run_read_page(server.clone(), vec![bad])
                .await
                .unwrap_err()
                .message;
            assert!(msg == "Invalid page" || msg == "Invalid project", "{msg}");
        }

        // observations validation
        assert_eq!(
            run_observations(server.clone(), vec![project(), json!("")])
                .await
                .unwrap_err()
                .message,
            "Invalid argument: sessionId"
        );
        assert_eq!(
            run_observations(server.clone(), vec![project(), json!("s1"), json!("5")])
                .await
                .unwrap_err()
                .message,
            "Invalid argument: offset"
        );

        // sweep dryRun validation
        for bad in [json!("true"), json!(1), Value::Null] {
            assert_eq!(
                run_sweep(server.clone(), vec![project(), bad])
                    .await
                    .unwrap_err()
                    .message,
                "Invalid argument: dryRun"
            );
        }

        // pageRef rejects absolute paths and parent traversal
        for bad_path in ["/etc/passwd", "../x.md", "a/../../x.md", ""] {
            let bad = json!({"workspace": "w", "project": "p", "path": bad_path});
            assert_eq!(
                run_delete_page(server.clone(), vec![bad.clone()])
                    .await
                    .unwrap_err()
                    .message,
                "Invalid page"
            );
            assert_eq!(
                run_restore_page(server.clone(), vec![bad, json!("rev")])
                    .await
                    .unwrap_err()
                    .message,
                "Invalid page"
            );
        }

        // write-page field validation
        assert_eq!(
            run_write_page(server.clone(), vec![page()])
                .await
                .unwrap_err()
                .message,
            "Invalid argument: body"
        );
        assert_eq!(
            run_write_page(
                server.clone(),
                vec![json!({"workspace": "w", "project": "p", "path": "notes/a.md", "body": "x", "tags": "a"})]
            )
            .await
            .unwrap_err()
            .message,
            "Invalid argument: tags"
        );
        assert_eq!(
            run_write_page(
                server.clone(),
                vec![json!({"workspace": "w", "project": "p", "path": "notes/a.md", "body": "x", "pinned": "yes"})]
            )
            .await
            .unwrap_err()
            .message,
            "Invalid argument: pinned"
        );

        // restore, feedback, cancel-handoff validation
        assert_eq!(
            run_restore_page(server.clone(), vec![page(), json!("")])
                .await
                .unwrap_err()
                .message,
            "Invalid argument: rev"
        );
        assert_eq!(
            run_feedback(server.clone(), vec![page(), json!("stale")])
                .await
                .unwrap_err()
                .message,
            "Invalid argument: signal"
        );
        assert_eq!(
            run_cancel_handoff(server.clone(), vec![project(), json!("")])
                .await
                .unwrap_err()
                .message,
            "Invalid argument: id"
        );
    }

    #[tokio::test]
    async fn dispatches_reads_and_mutations_and_strips_extra_fields() {
        let dir = data_dir(Some("tok-123\n"));
        let srv = fake(json!({
            "GET /api/v1/projects": {"json": [{"workspace_name": "w", "project_name": "p", "page_count": 1}]},
            "GET /api/v1/workspaces/w/projects/p/pages/sessions/a.md": {
                "json": {
                    "path": "sessions/a.md",
                    "title": "A",
                    "body_markdown": "hi",
                    "id": "p1",
                    "pinned": false,
                    "frontmatter": {"tags": []}
                }
            },
            "POST /admin/write-page": {"json": {"ok": true}},
            "GET /admin/checkpoints?limit=1": {"json": []},
            "POST /admin/delete-page": {"json": {"pre_checkpoint": "r1"}},
            "POST /admin/restore-page": {"json": {"ok": true}},
            "POST /mcp": {"json": {"jsonrpc": "2.0", "id": 1, "result": {"content": [{"type": "text", "text": "ok"}]}}}
        }))
        .await;
        let server = Server {
            url: Some(srv.url.clone()),
            data_dir: Some(dir.to_string_lossy().into_owned()),
        };

        let projects = run_projects(server.clone()).await.unwrap().unwrap();
        assert_eq!(projects[0]["workspace"], "w");

        let read = run_read_page(
            server.clone(),
            vec![json!({"workspace": "w", "project": "p", "path": "sessions/a.md", "extra": "dropped"})],
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(read["path"], "sessions/a.md");

        // write-page returns None (JS undefined) and drops unknown fields.
        assert_eq!(
            run_write_page(
                server.clone(),
                vec![json!({
                    "workspace": "w",
                    "project": "p",
                    "path": "notes/a.md",
                    "body": "hi",
                    "title": "T",
                    "kind": "note",
                    "tier": "semantic",
                    "tags": ["a"],
                    "pinned": true,
                    "extra": 1
                })]
            )
            .await
            .unwrap(),
            None
        );

        let deleted = run_delete_page(
            server.clone(),
            vec![json!({"workspace": "w", "project": "p", "path": "notes/a.md", "title": "T", "extra": 1})],
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(deleted["rev"], "r1");
        assert_eq!(deleted["title"], "T");

        // restore, feedback, cancel-handoff return None (JS undefined).
        assert_eq!(
            run_restore_page(server.clone(), vec![page(), json!("r1")])
                .await
                .unwrap(),
            None
        );
        assert_eq!(
            run_feedback(server.clone(), vec![page(), json!("not_helpful")])
                .await
                .unwrap(),
            None
        );
        assert_eq!(
            run_cancel_handoff(server.clone(), vec![project(), json!("h-1")])
                .await
                .unwrap(),
            None
        );

        // Verify `extra` field was never sent to `/admin/write-page`.
        let requests = srv.requests.lock().unwrap();
        let write_req = requests
            .iter()
            .find(|r| r["path"] == "/admin/write-page")
            .unwrap();
        assert!(write_req["body"].get("extra").is_none());

        std::fs::remove_dir_all(dir).unwrap();
    }

    static SERVICE_TEST_LOCK: std::sync::LazyLock<tokio::sync::Mutex<()>> =
        std::sync::LazyLock::new(Default::default);

    fn ipc_ctx(user_data: Option<std::path::PathBuf>) -> IpcContext {
        IpcContext {
            caller: crate::ipc::Caller {
                key: "w1".into(),
                window: Some(1),
                conn_id: None,
                device_id: None,
            },
            user_data,
        }
    }

    #[tokio::test]
    async fn lifecycle_channels_match_retired_node_ipc_contract() {
        let _guard = SERVICE_TEST_LOCK.lock().await;

        // Without an open service: get-state returns initial state, retry returns undefined,
        // purge and set-terminal refuse unmanaged, set-terminal validates strict bool first.
        let initial = ipc_get_state(ipc_ctx(None), vec![]).await.unwrap().unwrap();
        assert_eq!(initial["phase"], "starting");
        assert_eq!(initial["step"], "stage");
        assert_eq!(ipc_retry(ipc_ctx(None), vec![]).await.unwrap(), None);
        assert!(
            ipc_purge(ipc_ctx(None), vec![])
                .await
                .unwrap_err()
                .message
                .contains("not managed by this build")
        );
        for bad in [
            vec![json!("true")],
            vec![json!(1)],
            vec![Value::Null],
            vec![],
            vec![json!({})],
        ] {
            assert_eq!(
                ipc_set_terminal(ipc_ctx(None), bad)
                    .await
                    .unwrap_err()
                    .message,
                "Invalid argument: enabled"
            );
        }
        assert!(
            ipc_set_terminal(ipc_ctx(None), vec![json!(true)])
                .await
                .unwrap_err()
                .message
                .contains("not managed by this build")
        );

        // Open an unmanaged service (automatic: false): get-state returns snapshot, retry returns undefined,
        // purge and set-terminal refuse unmanaged.
        let _svc = service::open_for_ipc_test("ipc-lifecycle-unmanaged", false, None, None);
        let snap = ipc_get_state(ipc_ctx(None), vec![]).await.unwrap().unwrap();
        assert_eq!(snap["phase"], "starting");
        assert_eq!(ipc_retry(ipc_ctx(None), vec![]).await.unwrap(), None);
        assert!(
            ipc_purge(ipc_ctx(None), vec![])
                .await
                .unwrap_err()
                .message
                .contains("not managed by this build")
        );
        assert!(
            ipc_set_terminal(ipc_ctx(None), vec![json!(false)])
                .await
                .unwrap_err()
                .message
                .contains("not managed by this build")
        );
        service::close_for_ipc_test("ipc-lifecycle-unmanaged");
    }

    #[tokio::test]
    async fn care_summary_and_undo_read_state_file_and_restore_pages() {
        let _guard = SERVICE_TEST_LOCK.lock().await;
        let user_data = tempfile::tempdir().unwrap();
        let mem_dir = data_dir(Some("tok-care\n"));
        let srv = fake(json!({
            "POST /admin/restore-page": {"json": {"ok": true}}
        }))
        .await;

        // Without care client configured: summary is null, undo is 0.
        assert_eq!(
            ipc_care(ipc_ctx(Some(user_data.path().to_path_buf())), vec![])
                .await
                .unwrap(),
            Some(Value::Null)
        );
        assert_eq!(
            ipc_care_undo(ipc_ctx(Some(user_data.path().to_path_buf())), vec![])
                .await
                .unwrap(),
            Some(json!(0))
        );

        let _svc = service::open_for_ipc_test(
            "ipc-care-test",
            false,
            Some("care-svc-1"),
            Some(Server {
                url: Some(srv.url.clone()),
                data_dir: Some(mem_dir.to_string_lossy().into_owned()),
            }),
        );

        // Write a recent change into <userData>/ai-memory/care.json.
        let care_dir = user_data.path().join("ai-memory");
        std::fs::create_dir_all(&care_dir).unwrap();
        let now_iso = crate::care::Clock::new(None).iso();
        std::fs::write(
            care_dir.join("care.json"),
            json!({
                "version": "1.0.0",
                "units": {},
                "kept": [],
                "changes": [{
                    "workspace": "w",
                    "project": "p",
                    "path": "notes/a.md",
                    "title": "Note A",
                    "action": "retired",
                    "rev": "r-prev",
                    "at": now_iso
                }],
                "backfills": [],
                "memo": {}
            })
            .to_string(),
        )
        .unwrap();

        let summary = ipc_care(ipc_ctx(Some(user_data.path().to_path_buf())), vec![])
            .await
            .unwrap()
            .unwrap();
        assert_eq!(summary["retired"], 1);
        assert_eq!(summary["pages"][0]["path"], "notes/a.md");

        let restored = ipc_care_undo(ipc_ctx(Some(user_data.path().to_path_buf())), vec![])
            .await
            .unwrap()
            .unwrap();
        assert_eq!(restored, json!(1));

        // After undo, the Maintenance line clears to null.
        let after = ipc_care(ipc_ctx(Some(user_data.path().to_path_buf())), vec![])
            .await
            .unwrap();
        assert_eq!(after, Some(Value::Null));

        service::close_for_ipc_test("ipc-care-test");
        crate::care::engine::close("care-svc-1");
        std::fs::remove_dir_all(mem_dir).unwrap();
    }
}
