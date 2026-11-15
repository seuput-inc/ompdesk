use std::fmt;
use std::future::Future;
use std::task::Poll;
use futures_util::FutureExt;

use serde_json::Value;
use tokio::sync::oneshot;

use crate::agentctl::service::host::Deadline;
use crate::server::Fault;
use crate::sidecar::application::EffectFuture;

#[derive(Debug)]
pub(crate) enum RpcError {
    Fault(Fault),
    Timeout(RpcTimeout),
}

#[derive(Debug)]
pub(crate) struct RpcTimeout {
    pub timeout_ms: u64,
    pub command: String,
}

impl fmt::Display for RpcTimeout {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "RPC timeout ({}ms): {}", self.timeout_ms, self.command)
    }
}

impl fmt::Display for RpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Fault(error) => f.write_str(&error.message),
            Self::Timeout(error) => error.fmt(f),
        }
    }
}

impl From<Fault> for RpcError {
    fn from(error: Fault) -> Self { Self::Fault(error) }
}

impl RpcError {
    /// Only an adapter whose existing contract is Fault may erase timeout provenance here.
    pub(crate) fn into_fault(self) -> Fault {
        match self {
            Self::Fault(error) => error,
            Self::Timeout(error) => Fault::new("rpc_delivery_unknown", error.to_string()),
        }
    }
}

/// The waiter owns no effect cancellation: the original handler and Scope stay on the hub until settled.
pub(crate) fn start(
    work: impl Future<Output = Result<Value, Fault>> + Send + 'static,
    command: String,
    deadline: Deadline,
) -> EffectFuture<'static, Result<Value, RpcError>> {
    let (reply, answer) = oneshot::channel();
    crate::hub::post(move || crate::hub::spawn(async move {
        let work = async move {
            std::panic::AssertUnwindSafe(work).catch_unwind().await
                .unwrap_or_else(|_| Err(Fault::new("rpc_handler_panicked", "The local RPC handler panicked")))
        };
        tokio::pin!(work);
        // RpcClient starts the local handler before registering its outer timeout.
        if let Poll::Ready(result) = std::future::poll_fn(|cx| Poll::Ready(work.as_mut().poll(cx))).await {
            let _ = reply.send(result.map_err(Into::into));
            return;
        }
        let Some(duration) = deadline.timeout() else {
            let _ = reply.send(work.await.map_err(Into::into));
            return;
        };
        tokio::select! {
            biased;
            result = &mut work => { let _ = reply.send(result.map_err(Into::into)); }
            () = tokio::time::sleep(duration) => {
                let _ = reply.send(Err(RpcError::Timeout(RpcTimeout {
                    timeout_ms: duration.as_millis() as u64, command,
                })));
                let _ = work.await;
            }
        }
    }));
    Box::pin(async move {
        answer.await.map_err(|_| Fault::new("rpc_handler_ended", "The local RPC handler ended"))?
    })
}

/// Stock has already been enqueued at this boundary. Ending its waiter never withdraws that command.
pub(crate) fn wait(
    work: impl Future<Output = Result<Value, Fault>> + Send + 'static,
    command: String,
    deadline: Deadline,
) -> impl Future<Output = Result<Value, RpcError>> + Send {
    let expires = deadline.timeout().map(|duration| (tokio::time::Instant::now() + duration, duration));
    async move {
        match expires {
            Some((at, duration)) => tokio::time::timeout_at(at, work).await
                .map_err(|_| RpcError::Timeout(RpcTimeout { timeout_ms: duration.as_millis() as u64, command }))?
                .map_err(Into::into),
            None => work.await.map_err(Into::into),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn timeout_returns_before_the_original_effect_finishes_without_cancelling_it() {
        let scope = crate::server::Scope::detached();
        let held = scope.clone();
        let (started, entered) = oneshot::channel();
        let (release, blocked) = oneshot::channel();
        let (done, completed) = oneshot::channel();
        let reply = start(async move {
            started.send(()).unwrap();
            blocked.await.unwrap();
            let cancelled = held.cancelled();
            done.send(cancelled).unwrap();
            Ok(json!({"committed":true}))
        }, "provider_edit".into(), Deadline::Ms(0));
        entered.await.unwrap();
        assert!(matches!(reply.await, Err(RpcError::Timeout(RpcTimeout { timeout_ms: 0, .. }))));
        assert!(!scope.cancelled());
        release.send(()).unwrap();
        assert!(!completed.await.unwrap());
    }

    #[tokio::test]
    async fn abandoning_the_waiter_does_not_withdraw_the_already_started_effect() {
        let (release, blocked) = oneshot::channel();
        let (done, completed) = oneshot::channel();
        let waiter = start(async move {
            blocked.await.unwrap();
            done.send(()).unwrap();
            Ok(json!(null))
        }, "local_write".into(), Deadline::None);
        drop(waiter);
        release.send(()).unwrap();
        completed.await.unwrap();
    }

    #[tokio::test]
    async fn an_inner_stock_deadline_remains_a_local_failure_when_the_outer_deadline_is_the_same() {
        let result = start(async {
            wait(std::future::pending(), "switch_session".into(), Deadline::Ms(0)).await
                .map_err(RpcError::into_fault)
        }, "switch_session".into(), Deadline::Ms(0)).await;
        assert!(matches!(result, Err(RpcError::Fault(_))), "the already-started inner waiter must win over the equal outer deadline");
    }
}
