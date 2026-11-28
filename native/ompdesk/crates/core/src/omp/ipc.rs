//! Direct core IPC handlers for paired-host updates (`host-desktop:*`, `host-omp-update:*`) and bridge health
//! (`bridge-health:get`, `bridge-health:take`) (6 channels, H(c), routed `tauri-shell -> ompdesk-core`).

use serde_json::Value;

use crate::ipc::port::IpcPort;
use crate::ipc::{Handled, IpcContext};
use crate::server::Registry;

static HOST_PORT: IpcPort = IpcPort::new(
    "host_ipc_unavailable",
    "Host update and bridge-health service is not connected",
);
static BRIDGE_HEALTH_PORT: IpcPort = IpcPort::new(
    "bridge_health_unavailable",
    "Bridge health service is not connected",
);

pub(crate) fn register(registry: &mut Registry) {
    registry.add("omp.hostIpcPort", |call| HOST_PORT.open_call(call));
    registry.add("omp.bridgeHealthPort", |call| {
        BRIDGE_HEALTH_PORT.open_call(call)
    });
}

pub(crate) fn ipc_host_desktop_get(ctx: IpcContext, args: Vec<Value>) -> Handled {
    HOST_PORT.ask_value("getHostDesktop", ctx, args)
}

pub(crate) fn ipc_host_desktop_update(ctx: IpcContext, args: Vec<Value>) -> Handled {
    HOST_PORT.ask_value("updateHostDesktop", ctx, args)
}

pub(crate) fn ipc_host_omp_update_get(ctx: IpcContext, args: Vec<Value>) -> Handled {
    HOST_PORT.ask_value("getHostOmpUpdate", ctx, args)
}

pub(crate) fn ipc_host_omp_update_now(ctx: IpcContext, args: Vec<Value>) -> Handled {
    HOST_PORT.ask_value("startHostOmpUpdate", ctx, args)
}

pub(crate) fn ipc_bridge_health_get(ctx: IpcContext, args: Vec<Value>) -> Handled {
    HOST_PORT.ask_value("getBridgeHealth", ctx, args)
}

pub(crate) fn ipc_bridge_health_take(ctx: IpcContext, args: Vec<Value>) -> Handled {
    BRIDGE_HEALTH_PORT.ask_value("takeWarnings", ctx, args)
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
    async fn forwards_host_updates_and_bridge_health_over_ports() {
        let _guard = crate::ipc::TEST_LOCK.lock().await;
        HOST_PORT.replace(None);
        BRIDGE_HEALTH_PORT.replace(None);

        assert_eq!(
            ipc_host_desktop_get(ctx(Some(1)), vec![])
                .await
                .err()
                .unwrap()
                .code,
            "host_ipc_unavailable"
        );
        assert_eq!(
            ipc_bridge_health_take(ctx(Some(1)), vec![])
                .await
                .err()
                .unwrap()
                .code,
            "bridge_health_unavailable"
        );

        let (events, _tx, mut frames) = Events::capture();
        let host_port = Port::open(&events, 92_004, Value::Null).unwrap();
        let health_port = Port::open(&events, 92_005, Value::Null).unwrap();
        HOST_PORT.replace(Some(Arc::clone(&host_port)));
        BRIDGE_HEALTH_PORT.replace(Some(Arc::clone(&health_port)));

        let desktop = tokio::spawn(ipc_host_desktop_update(
            ctx(Some(3)),
            vec![json!("check"), json!("studio")],
        ));
        let frame = frames.recv().await.unwrap();
        let parsed: Value = serde_json::from_slice(frame.parts().0).unwrap();
        assert_eq!(parsed["data"]["method"], "updateHostDesktop");
        assert_eq!(parsed["data"]["args"]["args"], json!(["check", "studio"]));
        apply_answer(
            &host_port,
            parsed["data"]["ask"].as_u64().unwrap(),
            Ok(r#"{"version":"0.132.0"}"#),
        );
        assert_eq!(
            desktop.await.unwrap().unwrap(),
            Some(json!({"version": "0.132.0"}))
        );

        let omp_now = tokio::spawn(ipc_host_omp_update_now(ctx(Some(3)), vec![json!("studio")]));
        let frame = frames.recv().await.unwrap();
        let parsed: Value = serde_json::from_slice(frame.parts().0).unwrap();
        assert_eq!(parsed["data"]["method"], "startHostOmpUpdate");
        apply_answer(
            &host_port,
            parsed["data"]["ask"].as_u64().unwrap(),
            Ok(r#"{"status":"updating"}"#),
        );
        assert_eq!(
            omp_now.await.unwrap().unwrap(),
            Some(json!({"status": "updating"}))
        );

        let get_health = tokio::spawn(ipc_bridge_health_get(ctx(Some(3)), vec![]));
        let frame = frames.recv().await.unwrap();
        let parsed: Value = serde_json::from_slice(frame.parts().0).unwrap();
        assert_eq!(parsed["data"]["method"], "getBridgeHealth");
        apply_answer(
            &host_port,
            parsed["data"]["ask"].as_u64().unwrap(),
            Ok(r#"{"results":[]}"#),
        );
        assert_eq!(
            get_health.await.unwrap().unwrap(),
            Some(json!({"results": []}))
        );

        let take = tokio::spawn(ipc_bridge_health_take(ctx(Some(3)), vec![]));
        let frame = frames.recv().await.unwrap();
        let parsed: Value = serde_json::from_slice(frame.parts().0).unwrap();
        assert_eq!(parsed["data"]["method"], "takeWarnings");
        apply_answer(
            &health_port,
            parsed["data"]["ask"].as_u64().unwrap(),
            Ok(r#"[{"kind":"unavailable"}]"#),
        );
        assert_eq!(
            take.await.unwrap().unwrap(),
            Some(json!([{"kind": "unavailable"}]))
        );

        HOST_PORT.replace(None);
        BRIDGE_HEALTH_PORT.replace(None);
    }
}
