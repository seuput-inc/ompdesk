//! The local Source's production Sink. Internal asks stay on the original Application;
//! their futures remain owned until completion even if the caller waiting for close disappears.

use std::sync::{Arc, Mutex, MutexGuard, Weak};

use futures_util::future::{BoxFuture, FutureExt, Shared};
use tokio::sync::oneshot;
use tokio::task::JoinSet;

use crate::server::Fault;
use crate::sidecar::LaneEvent;
use crate::sidecar::application::{Application, Dispatch, EffectFuture, Host};
use crate::sidecar::native::Sink;

type Joined = Shared<BoxFuture<'static, Result<(), Fault>>>;

enum Admission<H: Host> {
    Unbound,
    Live(Weak<Application<H>>),
    Closed(Joined),
}

struct State<H: Host> {
    admission: Admission<H>,
    tasks: JoinSet<()>,
    failure: Option<Fault>,
}

pub(crate) struct LaunchIngress<H: Host> {
    downstream: Arc<dyn Sink>,
    state: Mutex<State<H>>,
}

fn lock<T>(value: &Mutex<T>) -> MutexGuard<'_, T> {
    value.lock().unwrap_or_else(|error| error.into_inner())
}

fn task_failure(error: tokio::task::JoinError) -> Fault {
    Fault::new("native_launch_task", error.to_string())
}

impl<H: Host + 'static> LaunchIngress<H> {
    pub fn new(downstream: Arc<dyn Sink>) -> Arc<Self> {
        Arc::new(Self {
            downstream,
            state: Mutex::new(State {
                admission: Admission::Unbound,
                tasks: JoinSet::new(),
                failure: None,
            }),
        })
    }

    /// Bind once after constructing the Source/Host, before starting that Source.
    /// Weak ownership avoids Source -> Sink -> Application -> Host -> Source cycles.
    pub fn bind(&self, application: &Arc<Application<H>>) -> Result<(), Fault> {
        let mut state = lock(&self.state);
        if !matches!(state.admission, Admission::Unbound) {
            return Err(Fault::new(
                "native_launch_bound",
                "The native launch ingress is already bound or closed",
            ));
        }
        state.admission = Admission::Live(Arc::downgrade(application));
        Ok(())
    }

    /// Stops admission synchronously and returns the same retained join to every waiter.
    /// Root disposes the Source and joins this alongside the captured child-exit receipt.
    pub fn close(&self) -> Joined {
        let mut state = lock(&self.state);
        if let Admission::Closed(joined) = &state.admission {
            return joined.clone();
        }
        let (reply, answer) = oneshot::channel();
        let joined = async move {
            answer.await.unwrap_or_else(|_| {
                Err(Fault::new(
                    "native_launch_join",
                    "The native launch cleanup ended without a receipt",
                ))
            })
        }
        .boxed()
        .shared();
        state.admission = Admission::Closed(joined.clone());
        let mut tasks = std::mem::replace(&mut state.tasks, JoinSet::new());
        let mut failure = state.failure.take();
        tokio::spawn(async move {
            while let Some(result) = tasks.join_next().await {
                if let Err(error) = result {
                    failure.get_or_insert_with(|| task_failure(error));
                }
            }
            let _ = reply.send(failure.map_or(Ok(()), Err));
        });
        joined
    }

    fn completed(state: &mut State<H>) {
        while let Some(result) = state.tasks.try_join_next() {
            if let Err(error) = result {
                state.failure.get_or_insert_with(|| task_failure(error));
            }
        }
    }
}

impl<H: Host + 'static> Sink for LaunchIngress<H> {
    fn event(&self, event: LaneEvent) {
        let mut state = lock(&self.state);
        Self::completed(&mut state);
        let application = match &state.admission {
            Admission::Live(application) => application.upgrade(),
            Admission::Unbound | Admission::Closed(_) => None,
        };
        let Some(application) = application else {
            // Non-ask events (including disposal) still reach the original ordered stream.
            // No unbound or retired ask is forwarded to another launch authority.
            if Application::<H>::handles(&event) {
                return;
            }
            drop(state);
            self.downstream.event(event);
            return;
        };
        match application.dispatch(&event) {
            Ok(Dispatch::Pending(work)) => {
                state.tasks.spawn(work);
            }
            Ok(Dispatch::Done) => {}
            Ok(Dispatch::Ignored) => {
                drop(state);
                self.downstream.event(event);
            }
            Err(error) => {
                state.failure.get_or_insert(error);
            }
        }
    }

    fn before_response(&self) {
        self.downstream.before_response();
    }

    fn reply_barrier(&self) -> crate::sidecar::native::Held {
        self.downstream.reply_barrier()
    }

    fn remove_listeners(&self) {
        drop(self.close());
        self.downstream.remove_listeners();
    }

    fn sync_settings(&self) -> EffectFuture<'_, ()> {
        let mut state = lock(&self.state);
        Self::completed(&mut state);
        let application = match &state.admission {
            Admission::Live(application) => application.upgrade(),
            Admission::Unbound | Admission::Closed(_) => None,
        };
        let Some(application) = application else {
            return Box::pin(async {});
        };
        let (reply, answer) = oneshot::channel();
        state.tasks.spawn(async move {
            application.sync_settings().await;
            let _ = reply.send(());
        });
        Box::pin(async move {
            let _ = answer.await;
        })
    }
}
