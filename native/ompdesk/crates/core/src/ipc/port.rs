//! Shared `CorePort` slot for page IPC domains whose live service still runs in Node main.

use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::{Value, json};

use crate::ipc::{Handled, IpcContext};
use crate::ports::Port;
use crate::server::{Answer, Call, Fault, Reply};

#[derive(Deserialize)]
struct PortParams {
    port: u64,
}

/// Holds one live `CorePort` for a page IPC domain, replacing and closing any superseded port.
pub(crate) struct IpcPort {
    slot: Mutex<Option<Arc<Port<Value>>>>,
    unavailable_code: &'static str,
    unavailable_message: &'static str,
}

impl IpcPort {
    pub(crate) const fn new(
        unavailable_code: &'static str,
        unavailable_message: &'static str,
    ) -> Self {
        Self {
            slot: Mutex::new(None),
            unavailable_code,
            unavailable_message,
        }
    }

    /// Handles `<domain>.ipcPort { port }`, replacing and closing any previous port.
    pub(crate) fn open_call(&'static self, call: Call) -> Answer {
        Box::pin(async move {
            let PortParams { port } = call.params()?;
            let opened = Port::open(&call.events, port, Value::Null)?;
            self.replace(Some(opened));
            Reply::json(&Value::Null)
        })
    }

    pub(crate) fn replace(&self, next: Option<Arc<Port<Value>>>) {
        let mut guard = self.slot.lock().unwrap_or_else(|p| p.into_inner());
        let prev = match next {
            Some(port) => guard.replace(port),
            None => guard.take(),
        };
        drop(guard);
        if let Some(prev) = prev {
            prev.close();
        }
    }

    /// Forwards `(ctx, args)` to `method` on the connected `CorePort`, returning `Some(value)`.
    pub(crate) fn ask_value(
        &'static self,
        method: &'static str,
        ctx: IpcContext,
        args: Vec<Value>,
    ) -> Handled {
        Box::pin(async move { Ok(Some(self.ask(method, ctx, args).await?)) })
    }

    /// Forwards `(ctx, args)` to `method` on the connected `CorePort`, returning `None` (void/undefined).
    pub(crate) fn ask_void(
        &'static self,
        method: &'static str,
        ctx: IpcContext,
        args: Vec<Value>,
    ) -> Handled {
        Box::pin(async move {
            let _ = self.ask(method, ctx, args).await?;
            Ok(None)
        })
    }

    async fn ask(
        &self,
        method: &'static str,
        ctx: IpcContext,
        args: Vec<Value>,
    ) -> Result<Value, Fault> {
        let port = self.slot.lock().unwrap_or_else(|p| p.into_inner()).clone();
        let Some(port) = port else {
            return Err(Fault::new(self.unavailable_code, self.unavailable_message));
        };
        let val: Value = port
            .ask(
                method,
                &json!({
                    "args": args,
                    "caller": {
                        "window": ctx.caller.window,
                        "connId": ctx.caller.conn_id,
                        "deviceId": ctx.caller.device_id,
                    },
                }),
            )
            .await?;
        Ok(val)
    }
}
