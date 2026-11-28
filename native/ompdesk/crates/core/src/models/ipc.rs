//! Direct core IPC handlers for models, provider config, account rotation, local engines, and credit spend
//! (12 channels, H(c), routed `tauri-shell -> ompdesk-core`).

use serde_json::Value;

use crate::ipc::port::IpcPort;
use crate::ipc::{Handled, IpcContext};
use crate::server::Registry;

static PORT: IpcPort = IpcPort::new(
    "models_unavailable",
    "Models and machine-settings service is not connected",
);

pub(crate) fn register(registry: &mut Registry) {
    registry.add("models.ipcPort", |call| PORT.open_call(call));
}

pub(crate) fn ipc_providers_list(ctx: IpcContext, args: Vec<Value>) -> Handled {
    PORT.ask_value("listProviders", ctx, args)
}

pub(crate) fn ipc_signed_in(ctx: IpcContext, args: Vec<Value>) -> Handled {
    PORT.ask_value("signedIn", ctx, args)
}

pub(crate) fn ipc_provider_upsert(ctx: IpcContext, args: Vec<Value>) -> Handled {
    PORT.ask_void("upsertProvider", ctx, args)
}

pub(crate) fn ipc_provider_delete(ctx: IpcContext, args: Vec<Value>) -> Handled {
    PORT.ask_void("deleteProvider", ctx, args)
}

pub(crate) fn ipc_override_set(ctx: IpcContext, args: Vec<Value>) -> Handled {
    PORT.ask_void("setModelOverride", ctx, args)
}

pub(crate) fn ipc_config_open(ctx: IpcContext, args: Vec<Value>) -> Handled {
    PORT.ask_value("openConfig", ctx, args)
}

pub(crate) fn ipc_account_rotation_get(ctx: IpcContext, args: Vec<Value>) -> Handled {
    PORT.ask_value("getAccountRotation", ctx, args)
}

pub(crate) fn ipc_account_rotation_set(ctx: IpcContext, args: Vec<Value>) -> Handled {
    PORT.ask_value("setAccountRotation", ctx, args)
}

pub(crate) fn ipc_local_engines_get(ctx: IpcContext, args: Vec<Value>) -> Handled {
    PORT.ask_value("getLocalEngines", ctx, args)
}

pub(crate) fn ipc_local_engines_set(ctx: IpcContext, args: Vec<Value>) -> Handled {
    PORT.ask_value("setLocalEngines", ctx, args)
}

pub(crate) fn ipc_credit_spend_get(ctx: IpcContext, args: Vec<Value>) -> Handled {
    PORT.ask_value("getCreditSpend", ctx, args)
}

pub(crate) fn ipc_credit_spend_set(ctx: IpcContext, args: Vec<Value>) -> Handled {
    PORT.ask_value("setCreditSpend", ctx, args)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;

    use super::*;
    use crate::ipc::Caller;
    use crate::ports::{Port, apply_answer};
    use crate::server::Events;

    fn ctx(window: Option<i64>, conn_id: Option<&str>) -> IpcContext {
        IpcContext {
            caller: Caller {
                key: match conn_id {
                    Some(id) => format!("c{id}"),
                    None => format!("w{}", window.unwrap_or(0)),
                },
                window,
                conn_id: conn_id.map(str::to_owned),
                device_id: None,
            },
            user_data: None,
        }
    }

    #[tokio::test]
    async fn forwards_models_and_machine_settings_over_port() {
        let _guard = crate::ipc::TEST_LOCK.lock().await;
        PORT.replace(None);

        let fault = ipc_providers_list(ctx(Some(1), None), vec![])
            .await
            .err()
            .unwrap();
        assert_eq!(fault.code, "models_unavailable");

        let (events, _tx, mut frames) = Events::capture();
        let port = Port::open(&events, 92_001, Value::Null).unwrap();
        PORT.replace(Some(Arc::clone(&port)));

        let list = tokio::spawn(ipc_providers_list(
            ctx(Some(7), None),
            vec![json!("studio")],
        ));
        let frame = frames.recv().await.unwrap();
        let parsed: Value = serde_json::from_slice(frame.parts().0).unwrap();
        assert_eq!(parsed["event"], "port");
        assert_eq!(parsed["data"]["method"], "listProviders");
        assert_eq!(parsed["data"]["args"]["args"], json!(["studio"]));
        assert_eq!(parsed["data"]["args"]["caller"]["window"], 7);
        apply_answer(
            &port,
            parsed["data"]["ask"].as_u64().unwrap(),
            Ok(r#"{"providers":[]}"#),
        );
        assert_eq!(list.await.unwrap().unwrap(), Some(json!({"providers": []})));

        let upsert = tokio::spawn(ipc_provider_upsert(
            ctx(Some(-2), Some("conn-a")),
            vec![json!({"id": "local"}), json!("studio")],
        ));
        let frame = frames.recv().await.unwrap();
        let parsed: Value = serde_json::from_slice(frame.parts().0).unwrap();
        assert_eq!(parsed["data"]["method"], "upsertProvider");
        assert_eq!(parsed["data"]["args"]["caller"]["connId"], "conn-a");
        apply_answer(&port, parsed["data"]["ask"].as_u64().unwrap(), Ok("null"));
        assert_eq!(upsert.await.unwrap().unwrap(), None);

        let rot = tokio::spawn(ipc_account_rotation_set(
            ctx(Some(1), None),
            vec![json!("even")],
        ));
        let frame = frames.recv().await.unwrap();
        let parsed: Value = serde_json::from_slice(frame.parts().0).unwrap();
        assert_eq!(parsed["data"]["method"], "setAccountRotation");
        apply_answer(
            &port,
            parsed["data"]["ask"].as_u64().unwrap(),
            Ok(r#"{"mode":"even"}"#),
        );
        assert_eq!(rot.await.unwrap().unwrap(), Some(json!({"mode": "even"})));

        let engines = tokio::spawn(ipc_local_engines_get(ctx(Some(1), None), vec![]));
        let frame = frames.recv().await.unwrap();
        let parsed: Value = serde_json::from_slice(frame.parts().0).unwrap();
        assert_eq!(parsed["data"]["method"], "getLocalEngines");
        apply_answer(
            &port,
            parsed["data"]["ask"].as_u64().unwrap(),
            Ok(r#"{"enabled":true}"#),
        );
        assert_eq!(
            engines.await.unwrap().unwrap(),
            Some(json!({"enabled": true}))
        );

        let spend = tokio::spawn(ipc_credit_spend_set(ctx(Some(1), None), vec![json!(false)]));
        let frame = frames.recv().await.unwrap();
        let parsed: Value = serde_json::from_slice(frame.parts().0).unwrap();
        assert_eq!(parsed["data"]["method"], "setCreditSpend");
        apply_answer(
            &port,
            parsed["data"]["ask"].as_u64().unwrap(),
            Ok(r#"{"enabled":false}"#),
        );
        assert_eq!(
            spend.await.unwrap().unwrap(),
            Some(json!({"enabled": false}))
        );

        PORT.replace(None);
    }
}
