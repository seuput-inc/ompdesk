use std::panic::AssertUnwindSafe;
use std::sync::Arc;

use futures_util::FutureExt;
use serde_json::json;

use crate::pool::application::Sidecar;
use crate::pool::application::native::dispatch::tests::Rig;
use crate::remote::requests::tests::pair;
use crate::server::Scope;

#[tokio::test]
async fn an_authenticated_view_controls_the_original_page_source_without_becoming_its_creator() {
    let mut rig = Rig::new("peer-presentation-local-page", 0x7065657276696577).await;
    let (first, first_remote, _first_io) = pair().await;
    let (next, next_remote, _next_io) = pair().await;
    let (other, other_remote, _other_io) = pair().await;
    let result = AssertUnwindSafe(async {
        rig.ready().await;
        let target = rig
            .pool
            .execution_target(&rig.world.owner, &rig.world.spawn.tab)
            .await
            .unwrap();
        let peer = rig
            .world
            .callers
            .admit_peer("viewer-device".into(), first.link_id().unwrap())
            .unwrap();
        rig.world
            .callers
            .bind_peer_connection(&peer.owner, first.clone())
            .unwrap();
        let path = rig.world.unwritten.to_string_lossy().into_owned();
        assert!(
            rig.pool
                .attach_peer_presentation(
                    &peer.owner,
                    &first,
                    &target,
                    Some("/not-the-original-session".into()),
                    711
                )
                .await
                .is_err()
        );
        assert!(
            rig.pool
                .peer_execution_target(&peer.owner, &first, target.tab())
                .await
                .is_err(),
            "the creator-only runner grant is not broadened"
        );
        let view = rig
            .pool
            .attach_peer_presentation(&peer.owner, &first, &target, Some(path), 711)
            .await
            .unwrap();
        let admitted = rig
            .pool
            .capture_peer_command(peer.clone(), first.clone(), &view, None, Scope::detached())
            .await
            .unwrap();
        assert_eq!(admitted.execution_owner(), &rig.world.owner);
        assert!(Arc::ptr_eq(&admitted.selected().sidecar, &rig.source));
        assert_eq!(
            admitted.stock(json!({"type":"get_state"})).await.unwrap()["success"],
            true
        );

        let stranger = rig
            .world
            .callers
            .admit_peer("different-device".into(), other.link_id().unwrap())
            .unwrap();
        rig.world
            .callers
            .bind_peer_connection(&stranger.owner, other.clone())
            .unwrap();
        let before = rig.world.stdin().len();
        assert!(
            rig.pool
                .capture_peer_command(stranger, other.clone(), &view, None, Scope::detached())
                .await
                .is_err()
        );
        assert_eq!(rig.world.stdin().len(), before);

        let rejoined = rig
            .world
            .callers
            .admit_peer("viewer-device".into(), next.link_id().unwrap())
            .unwrap();
        rig.world
            .callers
            .bind_peer_connection(&rejoined.owner, next.clone())
            .unwrap();
        assert!(admitted.stock(json!({"type":"get_state"})).await.is_err());
        let current = rig
            .pool
            .capture_peer_command(rejoined, next.clone(), &view, None, Scope::detached())
            .await
            .unwrap();
        assert_eq!(
            current.selected().generation,
            admitted.selected().generation
        );
        assert_eq!(
            current.stock(json!({"type":"get_state"})).await.unwrap()["success"],
            true
        );
        view.retire().wait().await.unwrap();
        let before = rig.world.stdin().len();
        assert!(current.stock(json!({"type":"get_state"})).await.is_err());
        assert_eq!(rig.world.stdin().len(), before);
        let local = rig.capture(Scope::detached()).await;
        assert_eq!(
            local.stock(json!({"type":"get_state"})).await.unwrap()["success"],
            true
        );
        assert_eq!(rig.source.facts()["processAlive"], true);
    })
    .catch_unwind()
    .await;
    first.disconnect_for_test();
    first_remote.disconnect_for_test();
    next.disconnect_for_test();
    next_remote.disconnect_for_test();
    other.disconnect_for_test();
    other_remote.disconnect_for_test();
    rig.close().await;
    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
}
