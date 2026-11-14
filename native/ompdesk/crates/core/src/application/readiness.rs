use tokio::sync::watch;

use crate::server::Fault;

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Pending,
    Opened,
    Closed,
}

pub struct FirstTab {
    state: watch::Sender<State>,
}

impl Default for FirstTab {
    fn default() -> Self {
        Self {
            state: watch::channel(State::Pending).0,
        }
    }
}

impl FirstTab {
    pub fn opened(&self) {
        self.state.send_if_modified(|state| {
            if *state == State::Pending {
                *state = State::Opened;
                true
            } else {
                false
            }
        });
    }

    pub fn close(&self) {
        self.state.send_replace(State::Closed);
    }

    pub async fn wait(&self) -> Result<(), Fault> {
        let mut state = self.state.subscribe();
        let ready = state
            .wait_for(|state| *state != State::Pending)
            .await
            .map_err(|_| Fault::new("app_closed", "The application generation ended"))?;
        if *ready == State::Opened {
            Ok(())
        } else {
            Err(Fault::new("app_closed", "The application generation ended"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn all_waiters_observe_the_first_tab_and_later_waiters_are_ready() {
        let first = FirstTab::default();
        let a = first.wait();
        let b = first.wait();
        first.opened();
        assert!(a.await.is_ok());
        assert!(b.await.is_ok());
        assert!(first.wait().await.is_ok());
    }

    #[tokio::test]
    async fn shutdown_revokes_readiness_and_late_open_cannot_revive_it() {
        let first = FirstTab::default();
        first.opened();
        first.close();
        first.opened();
        assert_eq!(first.wait().await.unwrap_err().code, "app_closed");
        let pending = FirstTab::default();
        let waiter = pending.wait();
        pending.close();
        assert_eq!(waiter.await.unwrap_err().code, "app_closed");
    }
}
