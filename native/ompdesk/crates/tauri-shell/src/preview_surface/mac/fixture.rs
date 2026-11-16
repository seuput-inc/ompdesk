use std::sync::{Arc, Mutex};

use objc2_app_kit::{NSEvent, NSEventModifierFlags, NSEventType};
use objc2_foundation::{NSPoint, NSRange, NSString};

use super::super::model::{
    AxAction, AxActionKind, AxSnapshot, AxTarget, Bounds, Consumer, EncodedFrame, FrameDisposition,
    FrameMetadata, Input, Rect, SurfaceError, SurfaceKey, TextContent, TextInputState, TextRange,
};
use super::{NativeParent, Surface};

#[derive(Default)]
struct Recorder {
    inputs: Mutex<Vec<Input>>,
    actions: Mutex<Vec<AxAction>>,
    frames: Mutex<Vec<FrameDisposition>>,
    errors: Mutex<Vec<SurfaceError>>,
}

impl Consumer for Recorder {
    fn schedule_present(&self, _key: SurfaceKey) -> Result<(), SurfaceError> {
        Ok(())
    }
    fn presented(
        &self,
        _key: SurfaceKey,
        _ack: i64,
        disposition: FrameDisposition,
    ) -> Result<(), SurfaceError> {
        self.frames.lock().unwrap().push(disposition);
        Ok(())
    }
    fn input(&self, _key: SurfaceKey, input: Input) -> Result<(), SurfaceError> {
        self.inputs.lock().unwrap().push(input);
        Ok(())
    }
    fn accessibility(
        &self,
        _key: SurfaceKey,
        _generation: u64,
        _target: AxTarget,
        action: AxAction,
    ) -> Result<(), SurfaceError> {
        self.actions.lock().unwrap().push(action);
        Ok(())
    }
    fn text_query(
        &self,
        _key: SurfaceKey,
        _generation: u64,
        _target: AxTarget,
        _query: super::super::model::TextQuery,
    ) -> Result<super::super::model::TextReply, SurfaceError> {
        Err(SurfaceError::Consumer(
            "fixture has no actual BrowserPage text service".into(),
        ))
    }
    fn failed(&self, _key: SurfaceKey, error: SurfaceError) {
        self.errors.lock().unwrap().push(error);
    }
}

fn require(condition: bool, message: &str) -> Result<(), SurfaceError> {
    if condition {
        Ok(())
    } else {
        Err(SurfaceError::Native(message.into()))
    }
}

/// Called by a native fixture runner on the process main thread, never by the test worker pool.
pub(crate) fn run_native_fixture(
    png: Arc<Vec<u8>>,
    width: u32,
    height: u32,
    snapshot: Arc<AxSnapshot>,
) -> Result<(), SurfaceError> {
    let key = snapshot.key;
    let bounds = Bounds {
        rect: Rect {
            x: 20.0,
            y: 30.0,
            width: 160.0,
            height: 90.0,
        },
        scale: 1.0,
    };
    let recorder = Arc::new(Recorder::default());
    let mut surface = Surface::new(
        NativeParent::hidden_fixture()?,
        key,
        bounds,
        recorder.clone(),
    )?;
    surface.publisher().submit(EncodedFrame {
        key,
        ack: 42,
        png,
        pixel_width: width,
        pixel_height: height,
        scale: 1.0,
        metadata: FrameMetadata {
            device_width: width.into(),
            device_height: height.into(),
            page_scale_factor: 1.0,
            offset_top: 0.0,
            scroll_offset_x: 0.0,
            scroll_offset_y: 0.0,
        },
    })
    .map_err(|error| SurfaceError::Consumer(error.to_string()))?;
    surface.drain_frame()?;
    require(
        surface
            .fixture_image_size()
            .is_some_and(|size| size.width == f64::from(width) && size.height == f64::from(height)),
        "native image was not installed",
    )?;
    let frame = surface.fixture_bounds();
    require(
        frame.size.width == bounds.rect.width && frame.size.height == bounds.rect.height,
        "native bounds differ",
    )?;
    require(
        recorder.frames.lock().unwrap().as_slice() == [FrameDisposition::Presented],
        "frame was not presented",
    )?;
    surface.focus()?;
    require(surface.fixture_focused(), "native first responder differs")?;

    assert_native_input(&mut surface, &recorder)?;
    let target = snapshot
        .nodes
        .iter()
        .find(|node| {
            node.backend_dom_node_id.is_some()
                && !node.disabled
                && node.actions.contains(&AxActionKind::Default)
        })
        .map(|node| node.node_id.clone())
        .ok_or_else(|| {
            SurfaceError::Invalid("fixture requires an actual browser node supporting press".into())
        })?;
    surface.set_accessibility(snapshot)?;
    let element = surface
        .fixture_ax_element(&target)
        .ok_or_else(|| SurfaceError::Native("native accessibility element missing".into()))?;
    require(
        Surface::fixture_ax_press(&element),
        "native accessibility press rejected",
    )?;
    require(
        recorder
            .actions
            .lock()
            .unwrap()
            .iter()
            .any(|action| matches!(action, AxAction::Default)),
        "native accessibility action did not reach consumer",
    )?;
    let generation = key
        .generation
        .checked_add(1)
        .ok_or_else(|| SurfaceError::Invalid("fixture generation exhausted".into()))?;
    surface.set_document(SurfaceKey { generation, ..key })?;
    require(
        !Surface::fixture_ax_press(&element),
        "stale accessibility object accepted action",
    )?;
    surface.dispose()?;
    Ok(())
}

fn assert_native_input(surface: &mut Surface, recorder: &Recorder) -> Result<(), SurfaceError> {
    let key = surface.key();
    let characters = NSString::from_str("a");
    let event = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
        NSEventType::KeyDown, NSPoint::new(0.0, 0.0), NSEventModifierFlags::empty(), 0.0, 0,
        None, &characters, &characters, false, 0,
    ).ok_or_else(|| SurfaceError::Native("cannot create fixture key event".into()))?;
    surface.fixture_key_down(&event);
    surface.set_text_input_state(TextInputState {
        key,
        generation: key.generation,
        backend_dom_node_id: None,
        editable: true,
        content: TextContent::Plain("abc".into()),
        selection: TextRange {
            start: 1,
            length: 0,
        },
        marked: None,
        caret: None,
    })?;
    let backspace = NSString::from_str("\u{8}");
    let event = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
        NSEventType::KeyDown, NSPoint::new(0.0, 0.0), NSEventModifierFlags::empty(), 0.0, 0,
        None, &backspace, &backspace, false, 51,
    ).ok_or_else(|| SurfaceError::Native("cannot create fixture backspace event".into()))?;
    surface.fixture_key_down(&event);
    let no_range = NSRange::new(isize::MAX as usize, 0);
    surface.fixture_set_marked_text("가", NSRange::new(1, 0), no_range);
    surface.fixture_insert_text("가", no_range);
    {
        let inputs = recorder.inputs.lock().unwrap();
        require(
            inputs
                .iter()
                .any(|input| matches!(input, Input::Key { key, .. } if key == "a")),
            "native key did not reach consumer",
        )?;
        require(
            inputs.iter().any(
                |input| matches!(input, Input::Ime { utf16text, .. } if utf16text == &[0xac00]),
            ),
            "native marked text did not reach consumer",
        )?;
        require(
            inputs
                .iter()
                .any(|input| matches!(input, Input::CommitText { text, .. } if text == "가")),
            "native committed text did not reach consumer",
        )?;
        require(
            inputs
                .iter()
                .filter(|input| matches!(input, Input::Key { key, .. } if key == "Backspace"))
                .count()
                == 1
                && !inputs.iter().any(|input| {
                    matches!(
                        input,
                        Input::Edit(super::super::model::EditCommand::DeleteBackward)
                    )
                }),
            "physical backspace generated duplicate edit effects",
        )?;
    }
    require(
        recorder.errors.lock().unwrap().is_empty(),
        "native input reported failure",
    )?;
    Ok(())
}

/// Native input-only proof. It makes no BrowserPage, frame or AX provenance claim.
pub(crate) fn run_native_input_fixture() -> Result<(), SurfaceError> {
    let key = SurfaceKey {
        view: 1,
        wc: 1,
        generation: 1,
    };
    let recorder = Arc::new(Recorder::default());
    let mut surface = Surface::new(
        NativeParent::hidden_fixture()?,
        key,
        Bounds {
            rect: Rect {
                x: 0.0,
                y: 0.0,
                width: 160.0,
                height: 90.0,
            },
            scale: 1.0,
        },
        recorder.clone(),
    )?;
    surface.focus()?;
    require(surface.fixture_focused(), "native first responder differs")?;
    assert_native_input(&mut surface, &recorder)?;
    surface.dispose()
}
