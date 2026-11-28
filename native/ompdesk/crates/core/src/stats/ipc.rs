//! Direct core IPC handlers for stats, benchmarks, and model-setup research
//! (8 channels, H(c), routed `tauri-shell -> ompdesk-core`).

use serde_json::Value;

use crate::ipc::port::IpcPort;
use crate::ipc::{Handled, IpcContext};
use crate::server::Registry;

static PORT: IpcPort = IpcPort::new(
    "stats_unavailable",
    "Stats, benchmark and model-setup service is not connected",
);

pub(crate) fn register(registry: &mut Registry) {
    registry.add("stats.ipcPort", |call| PORT.open_call(call));
}

pub(crate) fn ipc_stats_fetch(ctx: IpcContext, args: Vec<Value>) -> Handled {
    PORT.ask_value("fetchStats", ctx, args)
}

pub(crate) fn ipc_bench_run(ctx: IpcContext, args: Vec<Value>) -> Handled {
    PORT.ask_value("runBenchmark", ctx, args)
}

pub(crate) fn ipc_bench_abort(ctx: IpcContext, args: Vec<Value>) -> Handled {
    PORT.ask_value("abortBenchmark", ctx, args)
}

pub(crate) fn ipc_model_setup_run(ctx: IpcContext, args: Vec<Value>) -> Handled {
    PORT.ask_value("runModelSetup", ctx, args)
}

pub(crate) fn ipc_model_setup_status(ctx: IpcContext, args: Vec<Value>) -> Handled {
    PORT.ask_value("getModelSetupStatus", ctx, args)
}

pub(crate) fn ipc_model_setup_abort(ctx: IpcContext, args: Vec<Value>) -> Handled {
    PORT.ask_value("abortModelSetup", ctx, args)
}

pub(crate) fn ipc_model_setup_pick_get(ctx: IpcContext, args: Vec<Value>) -> Handled {
    PORT.ask_value("getModelSetupPick", ctx, args)
}

pub(crate) fn ipc_model_setup_pick_set(ctx: IpcContext, args: Vec<Value>) -> Handled {
    PORT.ask_value("setModelSetupPick", ctx, args)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;

    use super::*;
    use crate::ipc::Caller;
    use crate::ports::{Port, apply_answer};
    use crate::server::Events;

    fn ctx(window: Option<i64>) -> IpcContext {
        IpcContext {
            caller: Caller {
                key: format!("w{}", window.unwrap_or(0)),
                window,
                conn_id: None,
                device_id: None,
            },
            user_data: None,
        }
    }

    #[tokio::test]
    async fn forwards_stats_bench_and_model_setup_over_port() {
        let _guard = crate::ipc::TEST_LOCK.lock().await;
        PORT.replace(None);

        let fault = ipc_stats_fetch(ctx(Some(1)), vec![]).await.err().unwrap();
        assert_eq!(fault.code, "stats_unavailable");

        let (events, _tx, mut frames) = Events::capture();
        let port = Port::open(&events, 92_002, Value::Null).unwrap();
        PORT.replace(Some(Arc::clone(&port)));

        let fetch = tokio::spawn(ipc_stats_fetch(
            ctx(Some(5)),
            vec![json!({"path": "/api/summary", "device": "mini"})],
        ));
        let frame = frames.recv().await.unwrap();
        let parsed: Value = serde_json::from_slice(frame.parts().0).unwrap();
        assert_eq!(parsed["data"]["method"], "fetchStats");
        assert_eq!(parsed["data"]["args"]["caller"]["window"], 5);
        apply_answer(
            &port,
            parsed["data"]["ask"].as_u64().unwrap(),
            Ok(r#"{"total":42}"#),
        );
        assert_eq!(fetch.await.unwrap().unwrap(), Some(json!({"total": 42})));

        let bench = tokio::spawn(ipc_bench_run(
            ctx(Some(5)),
            vec![json!({"models": ["m1"]}), json!("mini")],
        ));
        let frame = frames.recv().await.unwrap();
        let parsed: Value = serde_json::from_slice(frame.parts().0).unwrap();
        assert_eq!(parsed["data"]["method"], "runBenchmark");
        assert_eq!(
            parsed["data"]["args"]["args"],
            json!([{"models": ["m1"]}, "mini"])
        );
        apply_answer(
            &port,
            parsed["data"]["ask"].as_u64().unwrap(),
            Ok(r#"{"ok":true}"#),
        );
        assert_eq!(bench.await.unwrap().unwrap(), Some(json!({"ok": true})));

        let abort = tokio::spawn(ipc_bench_abort(ctx(Some(5)), vec![]));
        let frame = frames.recv().await.unwrap();
        let parsed: Value = serde_json::from_slice(frame.parts().0).unwrap();
        assert_eq!(parsed["data"]["method"], "abortBenchmark");
        apply_answer(&port, parsed["data"]["ask"].as_u64().unwrap(), Ok("true"));
        assert_eq!(abort.await.unwrap().unwrap(), Some(json!(true)));

        let status = tokio::spawn(ipc_model_setup_status(ctx(Some(5)), vec![]));
        let frame = frames.recv().await.unwrap();
        let parsed: Value = serde_json::from_slice(frame.parts().0).unwrap();
        assert_eq!(parsed["data"]["method"], "getModelSetupStatus");
        apply_answer(
            &port,
            parsed["data"]["ask"].as_u64().unwrap(),
            Ok(r#"{"running":false}"#),
        );
        assert_eq!(
            status.await.unwrap().unwrap(),
            Some(json!({"running": false}))
        );

        let pick = tokio::spawn(ipc_model_setup_pick_set(
            ctx(Some(5)),
            vec![json!("openai/gpt-5"), Value::Null],
        ));
        let frame = frames.recv().await.unwrap();
        let parsed: Value = serde_json::from_slice(frame.parts().0).unwrap();
        assert_eq!(parsed["data"]["method"], "setModelSetupPick");
        apply_answer(
            &port,
            parsed["data"]["ask"].as_u64().unwrap(),
            Ok(r#"{"pick":"openai/gpt-5"}"#),
        );
        assert_eq!(
            pick.await.unwrap().unwrap(),
            Some(json!({"pick": "openai/gpt-5"}))
        );

        PORT.replace(None);
    }
}
