//! Direct core IPC handlers for schedules, bots, bot connectors, mail accounts, trackers, and sidebar projects
//! (8 channels, H(c), routed `tauri-shell -> ompdesk-core`).

use serde_json::Value;

use crate::ipc::port::IpcPort;
use crate::ipc::{Handled, IpcContext};
use crate::server::Registry;

static PORT: IpcPort = IpcPort::new(
    "routines_unavailable",
    "Routines, bots, trackers and projects service is not connected",
);

pub(crate) fn register(registry: &mut Registry) {
    registry.add("routines.ipcPort", |call| PORT.open_call(call));
}

pub(crate) fn ipc_schedules_command(ctx: IpcContext, args: Vec<Value>) -> Handled {
    PORT.ask_value("schedulesCommand", ctx, args)
}

pub(crate) fn ipc_schedules_log(ctx: IpcContext, args: Vec<Value>) -> Handled {
    PORT.ask_value("schedulesLog", ctx, args)
}

pub(crate) fn ipc_bots_command(ctx: IpcContext, args: Vec<Value>) -> Handled {
    PORT.ask_value("botsCommand", ctx, args)
}

pub(crate) fn ipc_bot_connectors_command(ctx: IpcContext, args: Vec<Value>) -> Handled {
    PORT.ask_value("botConnectorsCommand", ctx, args)
}

pub(crate) fn ipc_mail_accounts_command(ctx: IpcContext, args: Vec<Value>) -> Handled {
    PORT.ask_value("mailAccountsCommand", ctx, args)
}

pub(crate) fn ipc_trackers_command(ctx: IpcContext, args: Vec<Value>) -> Handled {
    PORT.ask_value("trackersCommand", ctx, args)
}

pub(crate) fn ipc_trackers_accounts(ctx: IpcContext, args: Vec<Value>) -> Handled {
    PORT.ask_value("trackersAccounts", ctx, args)
}

pub(crate) fn ipc_sidebar_projects_command(ctx: IpcContext, args: Vec<Value>) -> Handled {
    PORT.ask_value("sidebarProjectsCommand", ctx, args)
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
    async fn forwards_routines_bots_mail_trackers_and_projects_over_port() {
        let _guard = crate::ipc::TEST_LOCK.lock().await;
        PORT.replace(None);

        let fault = ipc_schedules_command(ctx(Some(1), None), vec![])
            .await
            .err()
            .unwrap();
        assert_eq!(fault.code, "routines_unavailable");

        let (events, _tx, mut frames) = Events::capture();
        let port = Port::open(&events, 92_003, Value::Null).unwrap();
        PORT.replace(Some(Arc::clone(&port)));

        let sched = tokio::spawn(ipc_schedules_command(
            ctx(Some(2), None),
            vec![json!({"action": "list"}), json!("host-a")],
        ));
        let frame = frames.recv().await.unwrap();
        let parsed: Value = serde_json::from_slice(frame.parts().0).unwrap();
        assert_eq!(parsed["data"]["method"], "schedulesCommand");
        assert_eq!(
            parsed["data"]["args"]["args"],
            json!([{"action": "list"}, "host-a"])
        );
        apply_answer(
            &port,
            parsed["data"]["ask"].as_u64().unwrap(),
            Ok(r#"{"schedules":[]}"#),
        );
        assert_eq!(
            sched.await.unwrap().unwrap(),
            Some(json!({"schedules": []}))
        );

        let bots = tokio::spawn(ipc_bots_command(
            ctx(Some(-1), Some("web-9")),
            vec![json!({"action": "get"})],
        ));
        let frame = frames.recv().await.unwrap();
        let parsed: Value = serde_json::from_slice(frame.parts().0).unwrap();
        assert_eq!(parsed["data"]["method"], "botsCommand");
        assert_eq!(parsed["data"]["args"]["caller"]["connId"], "web-9");
        apply_answer(
            &port,
            parsed["data"]["ask"].as_u64().unwrap(),
            Ok(r#"{"bots":[]}"#),
        );
        assert_eq!(bots.await.unwrap().unwrap(), Some(json!({"bots": []})));

        let mail = tokio::spawn(ipc_mail_accounts_command(
            ctx(Some(2), None),
            vec![json!({"action": "list"})],
        ));
        let frame = frames.recv().await.unwrap();
        let parsed: Value = serde_json::from_slice(frame.parts().0).unwrap();
        assert_eq!(parsed["data"]["method"], "mailAccountsCommand");
        apply_answer(
            &port,
            parsed["data"]["ask"].as_u64().unwrap(),
            Ok(r#"{"accounts":[]}"#),
        );
        assert_eq!(mail.await.unwrap().unwrap(), Some(json!({"accounts": []})));

        let trackers = tokio::spawn(ipc_trackers_accounts(
            ctx(Some(2), None),
            vec![json!({"action": "list"})],
        ));
        let frame = frames.recv().await.unwrap();
        let parsed: Value = serde_json::from_slice(frame.parts().0).unwrap();
        assert_eq!(parsed["data"]["method"], "trackersAccounts");
        apply_answer(
            &port,
            parsed["data"]["ask"].as_u64().unwrap(),
            Ok(r#"{"accounts":[]}"#),
        );
        assert_eq!(
            trackers.await.unwrap().unwrap(),
            Some(json!({"accounts": []}))
        );

        let projects = tokio::spawn(ipc_sidebar_projects_command(
            ctx(Some(2), None),
            vec![json!({"action": "get"}), Value::Null],
        ));
        let frame = frames.recv().await.unwrap();
        let parsed: Value = serde_json::from_slice(frame.parts().0).unwrap();
        assert_eq!(parsed["data"]["method"], "sidebarProjectsCommand");
        apply_answer(
            &port,
            parsed["data"]["ask"].as_u64().unwrap(),
            Ok(r#"{"projects":[]}"#),
        );
        assert_eq!(
            projects.await.unwrap().unwrap(),
            Some(json!({"projects": []}))
        );

        PORT.replace(None);
    }
}
