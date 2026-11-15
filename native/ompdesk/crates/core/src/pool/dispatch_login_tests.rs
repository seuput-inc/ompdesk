use super::*;
use futures_util::FutureExt;
use serde_json::json;
use std::panic::AssertUnwindSafe;
use crate::server::Scope;
use crate::pool::application::native::dispatch::tests::Rig;

#[tokio::test]
async fn original_login_cleanup_survives_caller_retirement_without_admitting_another_command() {
    let mut rig = Rig::new("dispatch-login-original", 0x6c6f67696e31).await;
    let result = AssertUnwindSafe(async {
        rig.ready().await;
        let admission = rig.capture(Scope::detached()).await;
        let tab = rig.world.spawn.tab.clone();
        let login = rig.pool.begin_sign_in_command(Arc::clone(&admission), Some("provider-one".into())).await.unwrap().unwrap();
        assert_eq!(rig.pool.call("signInActive", json!({"tab":tab}), false).await.unwrap(), true);
        assert_eq!(rig.pool.begin_sign_in_command(Arc::clone(&admission), Some("provider-two".into())).await.err().unwrap().code, "login_in_progress");
        assert_eq!(rig.pool.command_kind(Arc::clone(&admission)).await.unwrap(), "agent");
        rig.world.callers.close_page(&ompdesk_app_contract::NativeCaller::Desktop { win_id:17, wc_id:117 });
        login.finish(Some("cancelled by original caller".into())).await.unwrap();
        assert_eq!(rig.pool.call("signInActive", json!({"tab":tab}), false).await.unwrap(), false);
        assert!(rig.pool.begin_sign_in_command(admission, Some("retired".into())).await.is_err());
    }).catch_unwind().await;
    rig.close().await;
    if let Err(error) = result { std::panic::resume_unwind(error); }
}

#[tokio::test]
async fn abandoned_login_ticket_releases_its_original_provider_without_another_caller() {
    let mut rig = Rig::new("dispatch-login-drop", 0x6c6f67696e32).await;
    let result = AssertUnwindSafe(async {
        rig.ready().await;
        let admission = rig.capture(Scope::detached()).await;
        let tab = rig.world.spawn.tab.clone();
        let login = rig.pool.begin_sign_in_command(Arc::clone(&admission), Some("provider-one".into())).await.unwrap().unwrap();
        let generation = rig.source.generation();
        rig.source.restart(None);
        crate::sidecar::native::tests::ready_with(&mut rig.events, |_| None).await;
        assert_ne!(rig.source.generation(), generation);
        drop(login);
        // Both calls enter the existing hub FIFO; the ticket's synchronous Drop enqueued cleanup first.
        assert_eq!(rig.pool.call("signInActive", json!({"tab":tab}), false).await.unwrap(), false);
        let admission = rig.capture(Scope::detached()).await;
        let next = rig.pool.begin_sign_in_command(admission, Some("provider-two".into())).await.unwrap().unwrap();
        next.finish(None).await.unwrap();
    }).catch_unwind().await;
    rig.close().await;
    if let Err(error) = result { std::panic::resume_unwind(error); }
}
