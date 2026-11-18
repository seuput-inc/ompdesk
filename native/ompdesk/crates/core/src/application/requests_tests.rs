use std::sync::Arc;

use ompdesk_app_contract::{NativeCaller, RequestId};
use tokio::sync::oneshot;

use super::*;

fn caller() -> NativeCaller {
    NativeCaller::Desktop {
        win_id: 1,
        wc_id: 2,
    }
}
fn request(id: u64) -> RequestId {
    RequestId { generation: 71, id }
}
fn executor() -> Requests {
    Requests::new(Arc::new(Callers::new(71)))
}

#[cfg(unix)]
#[tokio::test]
async fn revoking_a_caller_while_resolving_a_target_prevents_a_late_real_child() {
    use crate::models::test_rig::Fixture;
    let fixture = Fixture::new("native-request-revoke");
    let executable = fixture.script("child", "printf started > \"$1\"");
    let marker = fixture.dir.join("started");
    let requests = executor();
    requests.admit(caller()).await.unwrap();
    let (started, resolving) = oneshot::channel();
    let (release, target) = oneshot::channel();
    let delayed_executable = executable.clone();
    let delayed_marker = marker.clone();
    let late = requests.invoke(caller(), request(1), move |_, scope| async move {
        let _scope = scope;
        started.send(()).unwrap();
        target.await.unwrap();
        tokio::process::Command::new(delayed_executable)
            .arg(delayed_marker)
            .status()
            .await
            .unwrap();
        Ok(())
    });
    resolving.await.unwrap();
    requests
        .close(caller(), |_| async { Ok(()) })
        .await
        .unwrap();
    assert!(release.send(()).is_err());
    assert_eq!(late.await.unwrap_err().code, "cancelled");
    assert!(!marker.exists());
    requests.admit(caller()).await.unwrap();
    requests
        .invoke(caller(), request(2), move |_, scope| async move {
            let _scope = scope;
            assert!(
                tokio::process::Command::new(executable)
                    .arg(marker.clone())
                    .status()
                    .await
                    .unwrap()
                    .success()
            );
            assert_eq!(std::fs::read(marker).unwrap(), b"started");
            Ok(())
        })
        .await
        .unwrap();
    requests.stop().await.unwrap();
}

#[tokio::test]
async fn replies_and_close_wait_for_the_effect_scope_instead_of_only_its_cancel_signal() {
    let requests = executor();
    requests.admit(caller()).await.unwrap();
    let (started, held) = oneshot::channel();
    let (release, finish) = oneshot::channel();
    let (done, finished) = oneshot::channel();
    let completed = requests.invoke(caller(), request(3), move |_, scope| async move {
        tokio::spawn(async move {
            let scope = scope;
            started.send(()).unwrap();
            finish.await.unwrap();
            let cancelled = scope.cancelled();
            drop(scope);
            let _ = done.send(cancelled);
        });
        Ok(())
    });
    held.await.unwrap();
    let closing = requests.close(caller(), |_| async { Ok(()) });
    tokio::pin!(closing);
    assert!(
        std::future::poll_fn(|cx| std::task::Poll::Ready(closing.as_mut().poll(cx).is_pending()))
            .await
    );
    let (barrier, reached) = oneshot::channel();
    hub::post(move || {
        let _ = barrier.send(());
    });
    reached.await.unwrap();
    release.send(()).unwrap();
    completed.await.unwrap();
    closing.await.unwrap();
    assert!(finished.await.unwrap());
}

#[tokio::test]
async fn rpc_waiter_answers_while_the_same_request_still_owns_its_effects_and_close_joins_them() {
    let requests = executor();
    requests.admit(caller()).await.unwrap();
    let (started, entered) = oneshot::channel();
    let (release, blocked) = oneshot::channel();
    let (done, completed) = oneshot::channel();
    let response = requests.invoke_rpc(caller(), request(37), move |_, scope| async move {
        tokio::spawn(async move {
            started.send(()).unwrap();
            blocked.await.unwrap();
            done.send(scope.cancelled()).unwrap();
            drop(scope);
        });
        Ok(serde_json::json!({"success":false,"error":"RPC timeout (1ms): local_write"}))
    });
    entered.await.unwrap();
    let response = response.await.unwrap();
    assert_eq!(response["success"], false);
    let mut closing = requests.close(caller(), |_| async { Ok(()) });
    assert!(std::future::poll_fn(|cx| std::task::Poll::Ready(closing.as_mut().poll(cx).is_pending())).await);
    let (fence, passed) = oneshot::channel();
    hub::post(move || { let _ = fence.send(()); });
    passed.await.unwrap();
    release.send(()).unwrap();
    assert!(completed.await.unwrap(), "closing the original caller still cancels its retained effect");
    closing.await.unwrap();
}

#[tokio::test]
async fn dropping_an_unpolled_answer_withdraws_only_its_own_request() {
    let requests = executor();
    requests.admit(caller()).await.unwrap();
    let (release, held) = std::sync::mpsc::channel();
    hub::post(move || {
        held.recv().unwrap();
    });
    let polled = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let observed = Arc::clone(&polled);
    let never = requests.invoke(caller(), request(4), |_, _| async move {
        observed.store(true, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    });
    drop(never);
    let live = requests.invoke(caller(), request(5), |_, _| async { Ok(9) });
    release.send(()).unwrap();
    assert_eq!(live.await.unwrap(), 9);
    assert!(!polled.load(std::sync::atomic::Ordering::SeqCst));
    requests.stop().await.unwrap();
}

#[tokio::test]
async fn shutdown_stops_admission_before_waiting_for_domain_cleanup() {
    let requests = executor();
    requests.admit(caller()).await.unwrap();
    let (started, held) = oneshot::channel();
    let (release, cleanup) = oneshot::channel();
    let result = requests.invoke(caller(), request(6), move |_, scope| async move {
        tokio::spawn(async move {
            started.send(()).unwrap();
            cleanup.await.unwrap();
            drop(scope);
        });
        Ok(())
    });
    held.await.unwrap();
    let admitted = requests.stop_admission().await.unwrap();
    assert_eq!(admitted.len(), 1);
    assert_eq!(
        requests.admit(caller()).await.err().unwrap().code,
        "app_closed"
    );
    let joining = requests.join();
    tokio::pin!(joining);
    assert!(
        std::future::poll_fn(|cx| std::task::Poll::Ready(joining.as_mut().poll(cx).is_pending()))
            .await
    );
    release.send(()).unwrap();
    result.await.unwrap();
    joining.await.unwrap();
}

#[tokio::test]
async fn cancelled_and_returned_handlers_keep_the_same_deletion_until_effects_are_gone() {
    use crate::application::session_authority::{AdmissionRefusal, SessionAuthority};
    use std::path::Path;

    for handler_returns in [false, true] {
        let requests = executor();
        requests.admit(caller()).await.unwrap();
        let authority = Arc::new(SessionAuthority::open(None));
        let handler_authority = Arc::clone(&authority);
        let (started, held) = oneshot::channel();
        let (cancelled, observed_cancel) = oneshot::channel();
        let (release, finish) = oneshot::channel();
        let answer = requests.invoke(caller(), request(30), move |_, scope| async move {
            let claim = handler_authority
                .begin_delete_scoped(Path::new("/sessions/request.jsonl"), None, &scope)
                .ready()
                .await;
            tokio::spawn(async move {
                started.send(()).unwrap();
                scope.on_cancel().await;
                cancelled.send(()).unwrap();
                finish.await.unwrap();
            });
            if !handler_returns {
                std::future::pending::<()>().await;
            }
            drop(claim);
            Ok(())
        });
        held.await.unwrap();
        drop(answer);
        observed_cancel.await.unwrap();
        let path = Path::new("/sessions/request.jsonl");
        assert!(authority.in_progress(path, None));
        assert_eq!(
            authority.admit(path, None, || ()),
            Err(AdmissionRefusal::Deleting)
        );
        let closing = requests.close(caller(), |_| async { Ok(()) });
        tokio::pin!(closing);
        assert!(
            std::future::poll_fn(|cx| std::task::Poll::Ready(
                closing.as_mut().poll(cx).is_pending()
            ))
            .await
        );
        release.send(()).unwrap();
        closing.await.unwrap();
        assert!(!authority.in_progress(path, None));
        assert_eq!(authority.admit(path, None, || ()), Ok(()));
    }
}

#[tokio::test]
async fn erroring_handler_cancels_but_retains_deletion_for_its_supervised_cleanup() {
    use crate::application::session_authority::SessionAuthority;
    use std::path::Path;

    let requests = executor();
    requests.admit(caller()).await.unwrap();
    let authority = Arc::new(SessionAuthority::open(None));
    let handler_authority = Arc::clone(&authority);
    let (started, held) = oneshot::channel();
    let (release, finish) = oneshot::channel();
    let answer = requests.invoke(caller(), request(31), move |_, scope| async move {
        let _claim = handler_authority
            .begin_delete_scoped(Path::new("/sessions/error.jsonl"), None, &scope)
            .ready()
            .await;
        tokio::spawn(async move {
            scope.on_cancel().await;
            started.send(()).unwrap();
            finish.await.unwrap();
        });
        Err::<(), _>(Fault::new("failed", "failed"))
    });
    held.await.unwrap();
    assert!(authority.in_progress(Path::new("/sessions/error.jsonl"), None));
    release.send(()).unwrap();
    assert_eq!(answer.await.unwrap_err().code, "failed");
    assert!(!authority.in_progress(Path::new("/sessions/error.jsonl"), None));
    requests.stop().await.unwrap();
}
