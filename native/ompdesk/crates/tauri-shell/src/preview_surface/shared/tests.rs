use super::*;

#[derive(Default)]
struct Sink {
    receipts: Mutex<Vec<(SurfaceKey, i64, FrameDisposition)>>,
    schedules: Mutex<Vec<SurfaceKey>>,
    fail_schedule: Mutex<bool>,
    failed_receipts: Mutex<Vec<i64>>,
}
impl Consumer for Sink {
    fn schedule_present(&self, key: SurfaceKey) -> Result<(), SurfaceError> {
        self.schedules.lock().unwrap().push(key);
        if *self.fail_schedule.lock().unwrap() {
            Err(SurfaceError::Consumer("schedule failed".into()))
        } else {
            Ok(())
        }
    }
    fn presented(
        &self,
        key: SurfaceKey,
        ack: i64,
        disposition: FrameDisposition,
    ) -> Result<(), SurfaceError> {
        self.receipts.lock().unwrap().push((key, ack, disposition));
        if self.failed_receipts.lock().unwrap().contains(&ack) {
            Err(SurfaceError::Consumer(format!("receipt {ack} failed")))
        } else {
            Ok(())
        }
    }
    fn input(&self, _: SurfaceKey, _: Input) -> Result<(), SurfaceError> {
        Ok(())
    }
    fn accessibility(
        &self,
        _: SurfaceKey,
        _: u64,
        _: AxTarget,
        _: AxAction,
    ) -> Result<(), SurfaceError> {
        Ok(())
    }
    fn text_query(
        &self,
        _: SurfaceKey,
        _: u64,
        _: AxTarget,
        _: TextQuery,
    ) -> Result<TextReply, SurfaceError> {
        Err(SurfaceError::Consumer(
            "test has no BrowserPage text service".into(),
        ))
    }
    fn failed(&self, _: SurfaceKey, _: SurfaceError) {
        panic!("unexpected native failure");
    }
}
fn key(generation: u64) -> SurfaceKey {
    SurfaceKey {
        view: 4,
        wc: 7,
        generation,
    }
}
fn shared() -> (Arc<Shared>, Arc<Sink>) {
    let sink = Arc::new(Sink::default());
    let shared = Shared::new(
        key(1),
        Bounds {
            rect: Rect {
                x: 0.0,
                y: 0.0,
                width: 30.0,
                height: 20.0,
            },
            scale: 2.0,
        },
        sink.clone(),
    )
    .unwrap();
    (shared, sink)
}
fn frame(key: SurfaceKey, ack: i64) -> EncodedFrame {
    EncodedFrame {
        key,
        ack,
        png: Arc::new(vec![ack as u8]),
        pixel_width: 60,
        pixel_height: 40,
        scale: 2.0,
        metadata: FrameMetadata {
            device_width: 30.0,
            device_height: 20.0,
            page_scale_factor: 1.0,
            offset_top: 0.0,
            scroll_offset_x: 0.0,
            scroll_offset_y: 0.0,
        },
    }
}

#[test]
fn coalescing_releases_original_receipt_and_presents_only_newest_frame() {
    let (shared, sink) = shared();
    let publisher = shared.publisher();
    publisher.submit(frame(key(1), 11)).unwrap();
    publisher.submit(frame(key(1), 12)).unwrap();
    let pending = shared.take_frame().unwrap().unwrap();
    assert_eq!(pending.frame.ack, 12);
    shared
        .finish_frame(pending, FrameDisposition::Presented)
        .unwrap();
    assert_eq!(*sink.schedules.lock().unwrap(), vec![key(1)]);
    assert_eq!(
        *sink.receipts.lock().unwrap(),
        vec![
            (key(1), 11, FrameDisposition::Superseded),
            (key(1), 12, FrameDisposition::Presented)
        ]
    );
}

#[test]
fn hidden_frame_can_paint_after_show_without_acknowledging_twice() {
    let (shared, sink) = shared();
    shared.set_visible(false).unwrap();
    shared.publisher().submit(frame(key(1), 31)).unwrap();
    assert!(shared.take_frame().unwrap().is_none());
    shared.set_visible(true).unwrap();
    let pending = shared.take_frame().unwrap().unwrap();
    assert_eq!(pending.frame.ack, 31);
    shared
        .finish_frame(pending, FrameDisposition::Presented)
        .unwrap();
    assert_eq!(
        *sink.receipts.lock().unwrap(),
        vec![(key(1), 31, FrameDisposition::Hidden)]
    );
}

#[test]
fn old_document_publisher_cannot_replace_or_ack_new_document_frame() {
    let (shared, sink) = shared();
    let old = shared.publisher();
    old.submit(frame(key(1), 40)).unwrap();
    shared.set_document(key(2)).unwrap();
    assert_eq!(
        old.submit(frame(key(1), 41)),
        Err(FrameSubmitError::Rejected(SurfaceError::StaleGeneration))
    );
    shared.publisher().submit(frame(key(2), 42)).unwrap();
    let pending = shared.take_frame().unwrap().unwrap();
    assert_eq!(pending.frame.key, key(2));
    shared
        .finish_frame(pending, FrameDisposition::Presented)
        .unwrap();
    shared.close().unwrap();
    assert_eq!(
        *sink.receipts.lock().unwrap(),
        vec![
            (key(1), 40, FrameDisposition::Disposed),
            (key(2), 42, FrameDisposition::Presented)
        ]
    );
}

#[test]
fn disposal_releases_pending_original_frame_once_and_rejects_later_publish() {
    let (shared, sink) = shared();
    let publisher = shared.publisher();
    publisher.submit(frame(key(1), 90)).unwrap();
    shared.close().unwrap();
    shared.close().unwrap();
    assert_eq!(
        publisher.submit(frame(key(1), 91)),
        Err(FrameSubmitError::Rejected(SurfaceError::Disposed))
    );
    assert_eq!(
        *sink.receipts.lock().unwrap(),
        vec![(key(1), 90, FrameDisposition::Disposed)]
    );
}

#[test]
fn protected_value_is_not_cached_and_navigation_invalidates_accessibility() {
    let (shared, _) = shared();
    let mut snapshot = Arc::new(AxSnapshot {
        key: key(1),
        generation: 1,
        root_id: Some("password".into()),
        nodes: vec![AxNode {
            node_id: "password".into(),
            frame_id: Some("actual-frame".into()),
            backend_dom_node_id: Some(17),
            role: "textbox".into(),
            name: None,
            description: None,
            value: AxValue::Text("do not retain".into()),
            children: Vec::new(),
            bounds: None,
            disabled: false,
            focused: true,
            focusable: true,
            editable: true,
            read_only: false,
            secure: true,
            multiline: false,
            required: false,
            selected: false,
            expanded: None,
            checked: None,
            selected_text_range: None,
            actions: vec![AxActionKind::Focus],
        }],
    });
    assert!(matches!(
        shared.set_accessibility(Arc::clone(&snapshot)),
        Err(SurfaceError::Invalid(_))
    ));
    assert!(shared.ax_tree().is_none());
    Arc::get_mut(&mut snapshot).unwrap().nodes[0].value = AxValue::Protected;
    shared.set_accessibility(Arc::clone(&snapshot)).unwrap();
    let tree = shared.ax_tree().unwrap();
    assert!(Arc::ptr_eq(&tree.snapshot, &snapshot));
    assert_eq!(tree.node("password").unwrap().value, AxValue::Protected);
    shared.set_document(key(2)).unwrap();
    assert!(shared.ax_tree().is_none());
    assert_eq!(
        shared.accessibility(
            1,
            AxTarget {
                node_id: "password".into(),
                frame_id: Some("actual-frame".into()),
                backend_dom_node_id: 17,
            },
            AxAction::Focus
        ),
        Err(SurfaceError::StaleGeneration)
    );
}

#[test]
fn hiding_pending_visible_frame_releases_receipt_before_any_show_or_replacement() {
    let (shared, sink) = shared();
    shared.publisher().submit(frame(key(1), 55)).unwrap();
    shared.set_visible(false).unwrap();
    assert_eq!(
        *sink.receipts.lock().unwrap(),
        vec![(key(1), 55, FrameDisposition::Hidden)]
    );
    shared.set_visible(true).unwrap();
    let pending = shared.take_frame().unwrap().unwrap();
    assert_eq!(pending.frame.ack, 55);
    shared
        .finish_frame(pending, FrameDisposition::Presented)
        .unwrap();
    assert_eq!(
        *sink.receipts.lock().unwrap(),
        vec![(key(1), 55, FrameDisposition::Hidden)]
    );
}

#[test]
fn superseded_receipt_failure_leaves_new_frame_owned_by_surface() {
    let (shared, sink) = shared();
    let publisher = shared.publisher();
    publisher.submit(frame(key(1), 11)).unwrap();
    sink.failed_receipts.lock().unwrap().push(11);

    assert_eq!(
        publisher.submit(frame(key(1), 12)),
        Err(FrameSubmitError::Accepted {
            errors: vec![SurfaceError::Consumer("receipt 11 failed".into())],
        })
    );
    let pending = shared.take_frame().unwrap().unwrap();
    assert_eq!((pending.frame.key, pending.frame.ack), (key(1), 12));
    shared
        .finish_frame(pending, FrameDisposition::Presented)
        .unwrap();
    shared.close().unwrap();
    assert_eq!(
        *sink.receipts.lock().unwrap(),
        vec![
            (key(1), 11, FrameDisposition::Superseded),
            (key(1), 12, FrameDisposition::Presented),
        ]
    );
}

#[test]
fn schedule_failure_keeps_receipt_ownership_and_preserves_cleanup_failure() {
    for fail_receipt in [false, true] {
        let (shared, sink) = shared();
        let publisher = shared.publisher();
        *sink.fail_schedule.lock().unwrap() = true;
        let mut errors = vec![SurfaceError::Consumer("schedule failed".into())];
        if fail_receipt {
            sink.failed_receipts.lock().unwrap().push(61);
            errors.push(SurfaceError::Consumer("receipt 61 failed".into()));
        }
        assert_eq!(
            publisher.submit(frame(key(1), 61)),
            Err(FrameSubmitError::Accepted { errors })
        );
        assert!(shared.take_frame().unwrap().is_none());
        shared.close().unwrap();
        assert_eq!(
            *sink.receipts.lock().unwrap(),
            vec![(key(1), 61, FrameDisposition::Disposed)]
        );
        assert_eq!(*sink.schedules.lock().unwrap(), vec![key(1)]);
    }
}

#[test]
fn hidden_receipt_failure_is_not_retried_by_show_or_disposal() {
    let (shared, sink) = shared();
    shared.set_visible(false).unwrap();
    sink.failed_receipts.lock().unwrap().push(71);
    assert_eq!(
        shared.publisher().submit(frame(key(1), 71)),
        Err(FrameSubmitError::Accepted {
            errors: vec![SurfaceError::Consumer("receipt 71 failed".into())],
        })
    );
    shared.set_visible(true).unwrap();
    let pending = shared.take_frame().unwrap().unwrap();
    assert_eq!((pending.frame.key, pending.frame.ack), (key(1), 71));
    shared
        .finish_frame(pending, FrameDisposition::Presented)
        .unwrap();
    shared.close().unwrap();
    assert_eq!(
        *sink.receipts.lock().unwrap(),
        vec![(key(1), 71, FrameDisposition::Hidden)]
    );
    assert!(sink.schedules.lock().unwrap().is_empty());
}
