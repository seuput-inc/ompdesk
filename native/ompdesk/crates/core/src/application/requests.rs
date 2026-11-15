use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::pin::Pin;
use std::sync::Arc;

use futures_util::FutureExt;
use ompdesk_app_contract::{NativeCaller, RequestId};
use tokio::sync::oneshot;

use crate::hub;
use crate::pool::application::Sidecar;
use crate::server::{Fault, Scope};

use super::callers::{Admitted, Callers};

pub type Task<T> = Pin<Box<dyn Future<Output = Result<T, Fault>> + Send>>;

/// Uses the existing hub executor: revocation cannot interleave with one synchronous segment of a handler.
/// Domain executors must retain the supplied Scope while reaping the effects they started.
pub struct Requests {
    callers: Arc<Callers>,
}


/// Parsed page payload plus transport-owned attribution. It contains no caller or execution grant.
pub(crate) struct CommandRequest {
    pub command: crate::local_dispatch::protocol::RpcCommand,
    pub tab: Option<String>,
    pub deadline: crate::agentctl::service::host::Deadline,
    pub channel: Arc<str>,
    pub origin: Option<serde_json::Value>,
}
#[derive(Clone, Copy)]
enum ReplyWhen {
    EffectsJoined,
    HandlerAnswered,
}

impl Requests {
    pub fn new(callers: Arc<Callers>) -> Self {
        Self { callers }
    }

    pub fn admit(&self, caller: NativeCaller) -> Task<Admitted> {
        let callers = Arc::clone(&self.callers);
        let (reply, answer) = oneshot::channel();
        hub::post(move || {
            if !reply.is_closed() {
                let _ = reply.send(callers.admit_page(caller));
            }
        });
        Box::pin(async move { answer.await.unwrap_or_else(|_| Err(stopped())) })
    }

    pub fn invoke<T, F>(
        &self,
        caller: NativeCaller,
        id: RequestId,
        prepare: impl FnOnce(Admitted, Scope) -> F + Send + 'static,
    ) -> Task<T>
    where
        T: Send + 'static,
        F: Future<Output = Result<T, Fault>> + 'static,
    {
        self.invoke_when(caller, id, prepare, ReplyWhen::EffectsJoined)
    }

    /// RPC deadlines end only the waiter; the original request remains registered until retained effects join.
    pub fn invoke_rpc<T, F>(
        &self,
        caller: NativeCaller,
        id: RequestId,
        prepare: impl FnOnce(Admitted, Scope) -> F + Send + 'static,
    ) -> Task<T>
    where
        T: Send + 'static,
        F: Future<Output = Result<T, Fault>> + 'static,
    {
        self.invoke_when(caller, id, prepare, ReplyWhen::HandlerAnswered)
    }

    pub(crate) fn invoke_command<P, R>(
        &self,
        caller: NativeCaller,
        id: RequestId,
        pool: Arc<crate::pool::application::native::Service<P>>,
        policy: Arc<super::dispatch_policy::Policy<P, R>>,
        request: CommandRequest,
    ) -> Task<serde_json::Value>
    where
        P: crate::pool::application::native::Host<Sidecar = super::source::Source>,
        R: crate::remote::application_host::Host,
    {
        self.invoke_rpc(caller, id, move |caller, scope| async move {
            let CommandRequest { command, tab, deadline, channel, origin } = request;
            if let Some(work) = policy.slot_command(caller.clone(), None, scope.clone(), &command) {
                return work.await;
            }
            let pending = pool.select_page_command(caller, tab, Some(channel), scope).await;
            let mut source = None;
            let admitted = match pending {
                Ok(pending) => {
                    source = Some(Arc::clone(pending.source()));
                    pool.finish_page_command(pending).await
                }
                Err(error) => Err(error),
            };
            let result = match admitted {
                Ok(admission) => policy.command(admission, command, deadline, origin).await,
                Err(error) => {
                    serde_json::to_value(crate::local_dispatch::protocol::RpcResponse::local(
                        &command,
                        Err(crate::local_dispatch::protocol::CommandError::local(error.code, error.message)),
                    )).map_err(|error| Fault::new("internal", error.to_string()))
                }
            };
            if let Some(source) = source {
                let delivered = source.reply_barrier().await;
                crate::pool::application::Sidecar::before_response(source.as_ref());
                return result.and_then(|value| delivered.map(|()| value));
            }
            result
        })
    }

    fn invoke_when<T, F>(
        &self,
        caller: NativeCaller,
        id: RequestId,
        prepare: impl FnOnce(Admitted, Scope) -> F + Send + 'static,
        reply_when: ReplyWhen,
    ) -> Task<T>
    where
        T: Send + 'static,
        F: Future<Output = Result<T, Fault>> + 'static,
    {
        let callers = Arc::clone(&self.callers);
        let (mut reply, answer) = oneshot::channel();
        hub::post(move || {
            if reply.is_closed() {
                return;
            }
            let admitted = match callers.page(&caller) {
                Ok(admitted) => admitted,
                Err(error) => {
                    let _ = reply.send(Err(error));
                    return;
                }
            };
            let (scope, gone) = match callers.begin(&admitted.owner, id) {
                Ok(work) => work,
                Err(error) => {
                    let _ = reply.send(Err(error));
                    return;
                }
            };
            let owner = admitted.owner.clone();
            let work =
                std::panic::catch_unwind(AssertUnwindSafe(|| prepare(admitted, scope.clone())));
            hub::spawn(async move {
                let result = match work {
                    Ok(work) => {
                        let work = AssertUnwindSafe(work).catch_unwind();
                        tokio::pin!(work);
                        tokio::select! {
                            biased;
                            _ = reply.closed() => { scope.cancel(); Err(Fault::cancelled()) },
                            () = scope.on_cancel() => Err(Fault::cancelled()),
                            result = &mut work => match result {
                                Ok(result) => result,
                                Err(_) => { scope.cancel(); Err(panicked()) },
                            },
                        }
                    }
                    Err(_) => {
                        scope.cancel();
                        Err(panicked())
                    }
                };
                drop(scope);
                gone.wait().await;
                if matches!(reply_when, ReplyWhen::HandlerAnswered) {
                    if reply.send(result).is_err() {
                        cancel.cancel();
                    }
                    gone.wait().await;
                    callers.finish(&owner, id);
                    return;
                }
                callers.finish(&owner, id);
                let _ = reply.send(result);
            });
        });
        Box::pin(async move { answer.await.unwrap_or_else(|_| Err(stopped())) })
    }

    pub fn close<F>(
        &self,
        caller: NativeCaller,
        cleanup: impl FnOnce(Admitted) -> F + Send + 'static,
    ) -> Task<()>
    where
        F: Future<Output = Result<(), Fault>> + 'static,
    {
        let callers = Arc::clone(&self.callers);
        let (reply, answer) = oneshot::channel();
        hub::post(move || {
            let Some(admitted) = callers.close_page(&caller) else {
                let _ = reply.send(Ok(()));
                return;
            };
            let owner = admitted.owner.clone();
            let work = std::panic::catch_unwind(AssertUnwindSafe(|| cleanup(admitted)));
            hub::spawn(async move {
                let result = match work {
                    Ok(work) => AssertUnwindSafe(work)
                        .catch_unwind()
                        .await
                        .unwrap_or_else(|_| Err(panicked())),
                    Err(_) => Err(panicked()),
                };
                callers.joined(Some(&owner)).await;
                let _ = reply.send(result);
            });
        });
        Box::pin(async move { answer.await.unwrap_or_else(|_| Err(stopped())) })
    }

    pub fn stop_admission(&self) -> Task<Vec<Admitted>> {
        let callers = Arc::clone(&self.callers);
        let (reply, answer) = oneshot::channel();
        hub::post(move || {
            let _ = reply.send(Ok(callers.stop()));
        });
        Box::pin(async move { answer.await.unwrap_or_else(|_| Err(stopped())) })
    }

    pub fn join(&self) -> Task<()> {
        let callers = Arc::clone(&self.callers);
        let (reply, answer) = oneshot::channel();
        hub::post(move || {
            hub::spawn(async move {
                callers.joined(None).await;
                let _ = reply.send(Ok(()));
            });
        });
        Box::pin(async move { answer.await.unwrap_or_else(|_| Err(stopped())) })
    }

    pub fn stop(&self) -> Task<Vec<Admitted>> {
        let admitted = self.stop_admission();
        let joined = self.join();
        Box::pin(async move {
            let admitted = admitted.await?;
            joined.await?;
            Ok(admitted)
        })
    }
}

fn stopped() -> Fault {
    Fault::new("app_closed", "The native application executor ended")
}
fn panicked() -> Fault {
    Fault::new("internal", "The native request handler panicked")
}

#[cfg(test)]
#[path = "requests_tests.rs"]
mod tests;
