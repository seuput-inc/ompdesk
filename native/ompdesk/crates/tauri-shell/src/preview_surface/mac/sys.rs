#![allow(unsafe_code)]

use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    ffi::c_void,
    ptr::NonNull,
    sync::Arc,
};

use block2::RcBlock;
use objc2::{
    AnyThread, ClassType, DefinedClass, MainThreadMarker, MainThreadOnly, Message, define_class,
    msg_send,
    rc::{Retained, Weak},
    runtime::{AnyObject, AnyProtocol, Sel},
};
use objc2_app_kit::{
    NSAccessibilityElement, NSBitmapImageRep, NSColor, NSCompositingOperation, NSEvent,
    NSEventModifierFlags, NSImage, NSImageView, NSRectFill, NSTrackingArea, NSTrackingAreaOptions,
    NSView, NSWindow,
};
use objc2_foundation::{
    NSArray, NSAttributedString, NSData, NSNumber, NSPoint, NSRange, NSRect, NSSize, NSString,
};
use shell_core::hotkey::Mods;

use super::super::model::{
    AxAction, AxActionKind, AxNode, AxTarget, AxValue, Bounds, Checked, EditCommand, EncodedFrame,
    FrameGeometry, Input, KeyKind, MouseButton, MouseKind, SurfaceError, SurfaceKey, TextContent,
    TextQuery, TextRange, TextReply, WheelUnit,
};
use super::super::shared::{AxNodeRef, Shared};

pub(super) struct Parent {
    window: Retained<NSWindow>,
    content: Retained<NSView>,
}

impl Parent {
    pub(super) fn from_tauri_window(window: &tauri::WebviewWindow) -> Result<Self, SurfaceError> {
        MainThreadMarker::new().ok_or(SurfaceError::WrongThread)?;
        let ptr = window
            .ns_window()
            .map_err(|error| SurfaceError::Native(error.to_string()))?;
        // SAFETY: Tauri documents ns_window as its live NSWindow pointer. Retaining it
        // on the main thread gives this parent an independent Objective-C ownership.
        let window = unsafe { Retained::retain(ptr.cast::<NSWindow>()) }
            .ok_or_else(|| SurfaceError::Native("Tauri returned a null NSWindow".into()))?;
        Self::from_retained(window)
    }

    fn from_retained(window: Retained<NSWindow>) -> Result<Self, SurfaceError> {
        let content = window
            .contentView()
            .ok_or_else(|| SurfaceError::Native("NSWindow has no content view".into()))?;
        Ok(Self { window, content })
    }

    fn frame(&self, bounds: Bounds) -> NSRect {
        let rect = bounds.rect;
        let y = if self.content.isFlipped() {
            rect.y
        } else {
            self.content.bounds().size.height - rect.y - rect.height
        };
        NSRect::new(
            NSPoint::new(rect.x, y),
            NSSize::new(rect.width, rect.height),
        )
    }

    pub(super) fn attach(
        &self,
        bounds: Bounds,
        shared: Arc<Shared>,
    ) -> Result<Retained<PreviewView>, SurfaceError> {
        let mtm = MainThreadMarker::new().ok_or(SurfaceError::WrongThread)?;
        let view = PreviewView::new(mtm, self.frame(bounds), shared)?;
        view.setClipsToBounds(true);
        let owner = retain_any(&*view);
        // SAFETY: the tracking owner is the live view and AppKit retains the area.
        let tracking = unsafe {
            NSTrackingArea::initWithRect_options_owner_userInfo(
                NSTrackingArea::alloc(),
                view.bounds(),
                NSTrackingAreaOptions::MouseEnteredAndExited
                    | NSTrackingAreaOptions::MouseMoved
                    | NSTrackingAreaOptions::ActiveInKeyWindow
                    | NSTrackingAreaOptions::InVisibleRect
                    | NSTrackingAreaOptions::EnabledDuringMouseDrag,
                Some(&owner),
                None,
            )
        };
        view.addTrackingArea(&tracking);
        self.window.setAcceptsMouseMovedEvents(true);
        self.content.addSubview(&view);
        Ok(view)
    }

    pub(super) fn set_bounds(
        &self,
        view: &PreviewView,
        bounds: Bounds,
    ) -> Result<(), SurfaceError> {
        MainThreadMarker::new().ok_or(SurfaceError::WrongThread)?;
        view.setFrame(self.frame(bounds));
        view.ivars().image_geometry.set(None);
        view.setNeedsDisplay(true);
        if bounds.rect.width > 0.0 && bounds.rect.height > 0.0 {
            let geometry = view.ivars().shared.publisher().geometry()?;
            view.ivars().image_geometry.set(geometry);
            if geometry.is_none() {
                view.setImage(None);
            }
        }
        view.displayIfNeeded();
        Ok(())
    }

    pub(super) fn focus(&self, view: &PreviewView) -> Result<(), SurfaceError> {
        MainThreadMarker::new().ok_or(SurfaceError::WrongThread)?;
        if self.window.makeFirstResponder(Some(view)) {
            Ok(())
        } else {
            Err(SurfaceError::Native(
                "NSWindow refused Preview focus".into(),
            ))
        }
    }
}

pub(super) struct ViewState {
    shared: Arc<Shared>,
    composition: Cell<Option<SurfaceKey>>,
    interpreting_physical_key: Cell<bool>,
    elements: RefCell<HashMap<String, Retained<AxElement>>>,
    image_geometry: Cell<Option<FrameGeometry>>,
}

define_class!(
    // SAFETY: NSImageView supports subclassing and the ivars have no custom drop.
    #[unsafe(super = NSImageView)]
    #[thread_kind = MainThreadOnly]
    #[ivars = ViewState]
    pub(super) struct PreviewView;

    impl PreviewView {
        #[unsafe(method(acceptsFirstResponder))]
        fn accepts_first_responder(&self) -> bool { true }

        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> bool { true }

        #[unsafe(method(drawRect:))]
        fn draw_rect(&self, _dirty: NSRect) {
            let bounds = self.bounds();
            self.window()
                .map_or_else(NSColor::windowBackgroundColor, |window| window.backgroundColor())
                .setFill();
            NSRectFill(bounds);
            if bounds.size.width <= 0.0 || bounds.size.height <= 0.0 {
                return;
            }
            if let (Some(image), Some(geometry)) = (self.image(), self.ivars().image_geometry.get()) {
                let (_, destination) = paint_rects(geometry, bounds, self.isFlipped());
                // SAFETY: AppKit owns the active draw context; no untyped drawing hints are supplied.
                unsafe {
                    image.drawInRect_fromRect_operation_fraction_respectFlipped_hints(
                        destination, NSRect::ZERO, NSCompositingOperation::SourceOver,
                        1.0, true, None,
                    );
                }
            }
        }
        #[unsafe(method(isAccessibilityElement))]
        fn is_accessibility_element(&self) -> bool { false }

        #[unsafe(method_id(accessibilityChildren))]
        fn accessibility_children(&self) -> Retained<NSArray<AxElement>> {
            let elements = self.ivars().elements.borrow();
            let tree = self.ivars().shared.ax_tree();
            let root = tree.as_ref()
                .and_then(|tree| tree.snapshot.root_id.as_deref())
                .and_then(|id| elements.get(id));
            match root {
                Some(root) => NSArray::from_slice(&[&**root]),
                None => NSArray::from_slice(&[]),
            }
        }

        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, event: &NSEvent) {
            if let Some(window) = self.window()
                && !window.makeFirstResponder(Some(self)) {
                self.ivars().shared.report_error(SurfaceError::Native("NSWindow refused Preview focus".into()));
            }
            self.mouse(event, MouseKind::Down);
        }
        #[unsafe(method(mouseUp:))]
        fn mouse_up(&self, event: &NSEvent) { self.mouse(event, MouseKind::Up); }
        #[unsafe(method(rightMouseDown:))]
        fn right_mouse_down(&self, event: &NSEvent) { self.mouse(event, MouseKind::Down); }
        #[unsafe(method(rightMouseUp:))]
        fn right_mouse_up(&self, event: &NSEvent) { self.mouse(event, MouseKind::Up); }
        #[unsafe(method(otherMouseDown:))]
        fn other_mouse_down(&self, event: &NSEvent) { self.mouse(event, MouseKind::Down); }
        #[unsafe(method(otherMouseUp:))]
        fn other_mouse_up(&self, event: &NSEvent) { self.mouse(event, MouseKind::Up); }
        #[unsafe(method(mouseMoved:))]
        fn mouse_moved(&self, event: &NSEvent) { self.mouse(event, MouseKind::Move); }
        #[unsafe(method(mouseDragged:))]
        fn mouse_dragged(&self, event: &NSEvent) { self.mouse(event, MouseKind::Move); }
        #[unsafe(method(rightMouseDragged:))]
        fn right_mouse_dragged(&self, event: &NSEvent) { self.mouse(event, MouseKind::Move); }
        #[unsafe(method(otherMouseDragged:))]
        fn other_mouse_dragged(&self, event: &NSEvent) { self.mouse(event, MouseKind::Move); }
        #[unsafe(method(mouseEntered:))]
        fn mouse_entered(&self, event: &NSEvent) { self.mouse(event, MouseKind::Enter); }
        #[unsafe(method(mouseExited:))]        fn mouse_exited(&self, event: &NSEvent) { self.mouse(event, MouseKind::Leave); }

        #[unsafe(method(keyDown:))]
        fn key_down(&self, event: &NSEvent) {
            if self.ivars().composition.get().is_some_and(|key| self.ivars().shared.check_key(key).is_err()) {
                self.ivars().composition.set(None);
            }
            self.key(event, KeyKind::Down);
            if self.ivars().shared.text_input_state().is_some_and(|state| state.editable) {
                let previous = self.ivars().interpreting_physical_key.replace(true);
                self.interpretKeyEvents(&NSArray::from_slice(&[event]));
                self.ivars().interpreting_physical_key.set(previous);
            }
        }

        #[unsafe(method(keyUp:))]
        fn key_up(&self, event: &NSEvent) { self.key(event, KeyKind::Up); }

        #[unsafe(method(flagsChanged:))]
        fn flags_changed(&self, event: &NSEvent) {
            let flags = event.modifierFlags();
            let active = match event.keyCode() {
                54 | 55 => flags.contains(NSEventModifierFlags::Command),
                56 | 60 => flags.contains(NSEventModifierFlags::Shift),
                57 => flags.contains(NSEventModifierFlags::CapsLock),
                58 | 61 => flags.contains(NSEventModifierFlags::Option),
                59 | 62 => flags.contains(NSEventModifierFlags::Control),
                _ => false,
            };
            self.key(event, if active { KeyKind::Down } else { KeyKind::Up });
        }

        #[unsafe(method(copy:))]
        fn copy(&self, _sender: Option<&AnyObject>) { self.forward(Input::Edit(EditCommand::Copy)); }
        #[unsafe(method(cut:))]
        fn cut(&self, _sender: Option<&AnyObject>) { self.forward(Input::Edit(EditCommand::Cut)); }
        #[unsafe(method(paste:))]
        fn paste(&self, _sender: Option<&AnyObject>) { self.forward(Input::Edit(EditCommand::Paste)); }
        #[unsafe(method(selectAll:))]
        fn select_all(&self, _sender: Option<&AnyObject>) { self.forward(Input::Edit(EditCommand::SelectAll)); }
        #[unsafe(method(undo:))]
        fn undo(&self, _sender: Option<&AnyObject>) { self.forward(Input::Edit(EditCommand::Undo)); }
        #[unsafe(method(redo:))]
        fn redo(&self, _sender: Option<&AnyObject>) { self.forward(Input::Edit(EditCommand::Redo)); }

        #[unsafe(method(insertText:replacementRange:))]
        fn insert_text(&self, object: &AnyObject, replacement: NSRange) {
            if !self.composition_current() { return; }
            let Some(text) = text_from_object(object) else {
                self.ivars().shared.report_error(SurfaceError::Invalid("unsupported AppKit text object".into()));
                return;
            };
            self.ivars().composition.set(None);
            self.forward(Input::CommitText { text, replacement: text_range(replacement) });
        }

        #[unsafe(method(setMarkedText:selectedRange:replacementRange:))]
        fn set_marked_text(&self, object: &AnyObject, selection: NSRange, replacement: NSRange) {
            if !self.composition_current() { return; }
            let Some(text) = text_from_object(object) else {
                self.ivars().shared.report_error(SurfaceError::Invalid("unsupported AppKit marked text".into()));
                return;
            };
            let Ok(start) = u32::try_from(selection.location) else {
                self.ivars().shared.report_error(SurfaceError::Invalid("invalid marked selection".into()));
                return;
            };
            let Some(end) = selection.location.checked_add(selection.length).and_then(|v| u32::try_from(v).ok()) else {
                self.ivars().shared.report_error(SurfaceError::Invalid("invalid marked selection".into()));
                return;
            };
            self.ivars().composition.set(Some(self.ivars().shared.key()));
            self.forward(Input::Ime { utf16text: text.encode_utf16().collect(), selection_start: start, selection_end: end, replacement: text_range(replacement) });
        }

        #[unsafe(method(unmarkText))]
        fn unmark_text(&self) {
            if self.composition_current() && self.ivars().composition.take().is_some() {
                self.forward(Input::CancelIme);
            }
        }

        #[unsafe(method(hasMarkedText))]
        fn has_marked_text(&self) -> bool {
            self.ivars().shared.text_input_state().is_some_and(|state| state.marked.is_some())
        }

        #[unsafe(method(markedRange))]
        fn marked_range(&self) -> NSRange {
            self.ivars().shared.text_input_state().and_then(|state| state.marked).map(native_range).unwrap_or_else(unavailable_range)
        }

        #[unsafe(method(selectedRange))]
        fn selected_range(&self) -> NSRange {
            self.ivars().shared.text_input_state().map(|state| native_range(state.selection)).unwrap_or_else(unavailable_range)
        }

        #[unsafe(method_id(validAttributesForMarkedText))]
        fn valid_attributes_for_marked_text(&self) -> Retained<NSArray<NSString>> {
            NSArray::from_slice(&[])
        }

        #[unsafe(method_id(attributedSubstringForProposedRange:actualRange:))]
        fn attributed_substring(&self, range: NSRange, actual: *mut NSRange) -> Option<Retained<NSAttributedString>> {
            (|| {
                // SAFETY: AppKit supplies either null or a valid output range pointer.
                if let Some(actual) = unsafe { actual.as_mut() } { *actual = unavailable_range(); }
                let state = self.ivars().shared.text_input_state()?;
                let TextContent::Plain(text) = &state.content else { return None; };
                let string = NSString::from_str(text);
                let end = range.location.checked_add(range.length)?;
                if end > string.length() { return None; }
                // SAFETY: AppKit supplies either null or a valid output range pointer.
                if let Some(actual) = unsafe { actual.as_mut() } { *actual = range; }
                let substring = string.substringWithRange(range);
                Some(NSAttributedString::initWithString(NSAttributedString::alloc(), &substring))
            })()
        }

        #[unsafe(method(firstRectForCharacterRange:actualRange:))]
        fn first_rect(&self, range: NSRange, actual: *mut NSRange) -> NSRect {
            let state = self.ivars().shared.text_input_state();
            if let Some((state, window)) = state.zip(self.window())
                && let Some(caret) = state.caret.filter(|_| state.selection.length == 0 && range.location == state.selection.start as usize) {
                // SAFETY: AppKit supplies either null or a valid output range pointer.
                if let Some(actual) = unsafe { actual.as_mut() } { *actual = native_range(state.selection); }
                let local = NSRect::new(NSPoint::new(caret.x, caret.y), NSSize::new(caret.width, caret.height));
                return window.convertRectToScreen(self.convertRect_toView(local, None));
            }
            if let (Some(requested), Some(window)) = (text_range(range), self.window()) {
                match self.query_text(TextQuery::RangeRects { range: requested }) {
                    Ok(Some(TextReply::Rects(rects))) => {
                        if let Some(rect) = rects.first() {
                            // SAFETY: AppKit supplies either null or a valid output range pointer.
                            if let Some(actual) = unsafe { actual.as_mut() } {                                *actual = if rects.len() == 1 { range } else { unavailable_range() };
                            }
                            let rect = NSRect::new(NSPoint::new(rect.x, rect.y), NSSize::new(rect.width, rect.height));
                            return window.convertRectToScreen(self.convertRect_toView(rect, None));
                        }
                    }
                    Ok(_) => {}
                    Err(error) => self.ivars().shared.report_error(error),
                }
            }
            // SAFETY: AppKit supplies either null or a valid output range pointer.
            if let Some(actual) = unsafe { actual.as_mut() } { *actual = unavailable_range(); }
            NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(0.0, 0.0))
        }

        #[unsafe(method(characterIndexForPoint:))]
        fn character_index(&self, point: NSPoint) -> usize {
            let Some(window) = self.window() else { return isize::MAX as usize; };
            let rect = window.convertRectFromScreen(NSRect::new(point, NSSize::new(0.0, 0.0)));
            let point = self.convertPoint_fromView(rect.origin, None);
            match self.query_text(TextQuery::OffsetAtPoint { x: point.x, y: point.y }) {
                Ok(Some(TextReply::Offset(Some(offset)))) => offset as usize,
                Ok(_) => isize::MAX as usize,
                Err(error) => {
                    self.ivars().shared.report_error(error);
                    isize::MAX as usize
                }
            }
        }

        #[unsafe(method(doCommandBySelector:))]
        fn do_command(&self, selector: Sel) {
            // The same Page already received rawKeyDown; its default action owns this key.
            if self.ivars().interpreting_physical_key.get() { return; }
            let command = match selector.name().to_str().unwrap_or_default() {
                "copy:" => Some(EditCommand::Copy),
                "cut:" => Some(EditCommand::Cut),
                "paste:" => Some(EditCommand::Paste),
                "selectAll:" => Some(EditCommand::SelectAll),
                "undo:" => Some(EditCommand::Undo),
                "redo:" => Some(EditCommand::Redo),
                "deleteBackward:" => Some(EditCommand::DeleteBackward),
                "deleteForward:" => Some(EditCommand::DeleteForward),
                _ => None,
            };
            if let Some(command) = command {
                self.forward(Input::Edit(command));
            } else {
                self.ivars().shared.report_error(SurfaceError::Invalid(format!("unsupported AppKit edit selector {}", selector.name().to_string_lossy())));
            }
        }

        #[unsafe(method(scrollWheel:))]
        fn scroll_wheel(&self, event: &NSEvent) {
            let point = self.convertPoint_fromView(event.locationInWindow(), None);
            self.forward(Input::Wheel {
                x: point.x,
                y: point.y,
                delta_x: -event.scrollingDeltaX(),
                delta_y: -event.scrollingDeltaY(),
                unit: if event.hasPreciseScrollingDeltas() { WheelUnit::Dip } else { WheelUnit::Line },
                modifiers: modifiers(event.modifierFlags()),
            });
        }

        #[unsafe(method(becomeFirstResponder))]
        fn become_first_responder(&self) -> bool {
            self.forward(Input::Focus(true));
            true
        }

        #[unsafe(method(resignFirstResponder))]
        fn resign_first_responder(&self) -> bool {
            self.forward(Input::Focus(false));
            true
        }
    }
);
struct AxState {
    view: Weak<PreviewView>,
    shared: Arc<Shared>,
    key: SurfaceKey,
    generation: u64,
    id: String,
    frame_id: Option<String>,
    backend: Option<i64>,
}

define_class!(
    // SAFETY: NSAccessibilityElement permits subclassing and owns no Rust-side
    // references back to the view; its weak view pointer does not form a cycle.
    #[unsafe(super = NSAccessibilityElement)]
    #[thread_kind = MainThreadOnly]
    #[ivars = AxState]
    struct AxElement;

    impl AxElement {
        #[unsafe(method(isAccessibilityElement))]
        fn is_element(&self) -> bool { self.node().is_some() }

        #[unsafe(method_id(accessibilityRole))]
        fn role(&self) -> Option<Retained<NSString>> {
            self.node().map(|node| NSString::from_str(if node.multiline && node.editable { "AXTextArea" } else { ax_role(&node.role) }))
        }

        #[unsafe(method_id(accessibilitySubrole))]
        fn subrole(&self) -> Option<Retained<NSString>> {
            self.node().filter(|node| node.secure).map(|_| NSString::from_str("AXSecureTextField"))
        }

        #[unsafe(method_id(accessibilityLabel))]
        fn label(&self) -> Option<Retained<NSString>> {
            self.node().and_then(|node| node.name.as_deref().map(NSString::from_str))
        }

        #[unsafe(method_id(accessibilityHelp))]
        fn help(&self) -> Option<Retained<NSString>> {
            self.node().and_then(|node| node.description.as_deref().map(NSString::from_str))
        }

        #[unsafe(method_id(accessibilityValue))]
        fn value(&self) -> Option<Retained<AnyObject>> {
            (|| {
                let node = self.node()?;
                if node.secure { return None; }
                if let Some(checked) = node.checked {
                    let value = match checked { Checked::Off => 0, Checked::On => 1, Checked::Mixed => 2 };
                    return Some(retain_any(&*NSNumber::numberWithInt(value)));
                }
                match &node.value {
                    AxValue::Text(text) => Some(retain_any(&*NSString::from_str(text))),
                    AxValue::Number(number) => Some(retain_any(&*NSNumber::numberWithDouble(*number))),
                    AxValue::Boolean(value) => Some(retain_any(&*NSNumber::numberWithBool(*value))),
                    AxValue::None | AxValue::Protected => None,
                }
            })()
        }

        #[unsafe(method(isAccessibilityEnabled))]
        fn enabled(&self) -> bool { self.node().is_some_and(|node| !node.disabled) }

        #[unsafe(method(isAccessibilityRequired))]
        fn required(&self) -> bool { self.node().is_some_and(|node| node.required) }

        #[unsafe(method(isAccessibilityFocused))]
        fn focused(&self) -> bool { self.node().is_some_and(|node| node.focused) }

        #[unsafe(method(isAccessibilitySelected))]
        fn selected(&self) -> bool { self.node().is_some_and(|node| node.selected) }

        #[unsafe(method(isAccessibilityExpanded))]
        fn expanded(&self) -> bool { self.node().and_then(|node| node.expanded).unwrap_or(false) }

        #[unsafe(method(accessibilitySelectedTextRange))]
        fn selected_range(&self) -> NSRange {
            self.node().and_then(|node| node.selected_text_range).map(native_range).unwrap_or_else(unavailable_range)
        }

        #[unsafe(method(accessibilityFrame))]
        fn frame(&self) -> NSRect {
            if let (Some(node), Some(view)) = (self.node(), self.ivars().view.load())
                && let (Some(bounds), Some(window)) = (node.bounds, view.window()) {
                let rect = NSRect::new(NSPoint::new(bounds.x, bounds.y), NSSize::new(bounds.width, bounds.height));
                return window.convertRectToScreen(view.convertRect_toView(rect, None));
            }
            NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(0.0, 0.0))
        }

        #[unsafe(method_id(accessibilityChildren))]
        fn children(&self) -> Retained<NSArray<AxElement>> {
            let mut children = Vec::new();
            if let (Some(node), Some(view)) = (self.node(), self.ivars().view.load()) {
                let elements = view.ivars().elements.borrow();
                children.extend(node.children.iter().filter_map(|id| elements.get(id).cloned()));
            }
            NSArray::from_retained_slice(&children)
        }

        #[unsafe(method_id(accessibilityParent))]
        fn parent(&self) -> Option<Retained<AnyObject>> {            (|| {
                self.node()?;
                let view = self.ivars().view.load()?;
                let tree = self.ivars().shared.ax_tree()?;
                if let Some(parent) = tree.parent(&self.ivars().id) {
                    return view.ivars().elements.borrow().get(parent).map(|item| retain_any(&**item));
                }
                Some(retain_any(&*view))
            })()
        }

        #[unsafe(method(accessibilityPerformPress))]
        fn press(&self) -> bool { self.perform(AxAction::Default) }
        #[unsafe(method(accessibilityPerformIncrement))]
        fn increment(&self) -> bool { self.perform(AxAction::Increment) }
        #[unsafe(method(accessibilityPerformDecrement))]
        fn decrement(&self) -> bool { self.perform(AxAction::Decrement) }
        #[unsafe(method(accessibilityPerformShowMenu))]
        fn show_menu(&self) -> bool { self.perform(AxAction::ShowMenu) }

        #[unsafe(method(setAccessibilityFocused:))]
        fn set_focused(&self, focused: bool) {
            if focused { self.perform(AxAction::Focus); }
        }

        #[unsafe(method(setAccessibilityValue:))]
        fn set_value(&self, value: Option<&AnyObject>) {
            if let Some(text) = value.and_then(AnyObject::downcast_ref::<NSString>) {
                self.perform(AxAction::SetValue(text.to_string()));
            } else {
                self.ivars().shared.report_error(SurfaceError::Invalid("unsupported accessibility value".into()));
            }
        }

        #[unsafe(method(setAccessibilitySelectedTextRange:))]
        fn set_selected_range(&self, range: NSRange) {
            if let Some(range) = text_range(range) {
                self.perform(AxAction::SetSelection(range));
            } else {
                self.ivars().shared.report_error(SurfaceError::Invalid("invalid accessibility selection".into()));
            }
        }

        #[unsafe(method(isAccessibilitySelectorAllowed:))]
        fn selector_allowed(&self, selector: Sel) -> bool {
            let name = selector.name().to_str().unwrap_or_default();
            let action = match name {
                "accessibilityPerformPress" => Some(AxActionKind::Default),
                "accessibilityPerformIncrement" => Some(AxActionKind::Increment),
                "accessibilityPerformDecrement" => Some(AxActionKind::Decrement),
                "accessibilityPerformShowMenu" => Some(AxActionKind::ShowMenu),
                "setAccessibilityFocused:" => Some(AxActionKind::Focus),
                "setAccessibilityValue:" => Some(AxActionKind::SetValue),
                "setAccessibilitySelectedTextRange:" => Some(AxActionKind::SetSelection),
                _ => None,
            };
            self.node().is_some_and(|node| match action {
                Some(action) => !node.disabled && node.actions.contains(&action)
                    && !(node.secure && action == AxActionKind::SetValue),
                None => match name {
                    "accessibilityFrame" => node.bounds.is_some(),
                    "isAccessibilityExpanded" => node.expanded.is_some(),
                    "accessibilitySelectedTextRange" => node.selected_text_range.is_some(),
                    "accessibilityValue" => !node.secure && (node.checked.is_some() || !matches!(&node.value, AxValue::None | AxValue::Protected)),
                    _ => true,
                },
            })
        }
    }
);

impl AxElement {
    fn new(
        mtm: MainThreadMarker,
        view: &PreviewView,
        key: SurfaceKey,
        generation: u64,
        node: &AxNode,
    ) -> Retained<Self> {
        let state = AxState {
            view: Weak::new(view),
            shared: Arc::clone(&view.ivars().shared),
            key,
            generation,
            id: node.node_id.clone(),
            frame_id: node.frame_id.clone(),
            backend: node.backend_dom_node_id,
        };
        let this = Self::alloc(mtm).set_ivars(state);
        // SAFETY: NSAccessibilityElement implements init and the ivars are initialized.
        unsafe { msg_send![super(this), init] }
    }
    fn node(&self) -> Option<AxNodeRef> {
        let state = self.ivars();
        state.shared.check_key(state.key).ok()?;
        let tree = state.shared.ax_tree()?;
        if tree.snapshot.generation != state.generation {
            return None;
        }
        let node = tree.node_ref(&state.id)?;
        if node.frame_id != state.frame_id || node.backend_dom_node_id != state.backend {
            return None;
        }
        Some(node)
    }

    fn perform(&self, action: AxAction) -> bool {
        let state = self.ivars();
        let result = state.shared.check_key(state.key).and_then(|()| {
            let backend = state.backend.ok_or(SurfaceError::StaleGeneration)?;
            state.shared.accessibility(
                state.generation,
                AxTarget {
                    node_id: state.id.clone(),
                    frame_id: state.frame_id.clone(),
                    backend_dom_node_id: backend,
                },
                action,
            )
        });
        match result {
            Ok(()) => true,
            Err(error) => {
                state.shared.report_error(error);
                false
            }
        }
    }
}

fn retain_any<T: Message>(object: &T) -> Retained<AnyObject> {
    // SAFETY: every Objective-C object can be retained as its type-erased object.
    unsafe { Retained::retain(std::ptr::from_ref(object).cast_mut().cast::<AnyObject>()) }
        .expect("a reference cannot be null")
}

fn ax_role(role: &str) -> &'static str {
    match role {
        "RootWebArea" | "WebArea" => "AXWebArea",
        "button" | "toggleButton" => "AXButton",
        "link" => "AXLink",
        "checkbox" => "AXCheckBox",
        "radio" => "AXRadioButton",
        "textbox" | "searchbox" => "AXTextField",
        "StaticText" | "InlineTextBox" => "AXStaticText",
        "image" | "img" => "AXImage",
        "heading" => "AXHeading",
        "list" => "AXList",
        "listitem" => "AXRow",
        "table" | "grid" => "AXTable",
        "row" => "AXRow",
        "cell" | "gridcell" => "AXCell",
        "slider" => "AXSlider",
        "combobox" => "AXComboBox",
        "menu" => "AXMenu",
        "menuitem" => "AXMenuItem",
        "tab" => "AXRadioButton",
        "group" | "generic" | "region" => "AXGroup",
        _ => "AXUnknown",
    }
}

fn modifiers(flags: NSEventModifierFlags) -> Mods {
    Mods {
        ctrl: flags.contains(NSEventModifierFlags::Control),
        alt: flags.contains(NSEventModifierFlags::Option),
        shift: flags.contains(NSEventModifierFlags::Shift),
        meta: flags.contains(NSEventModifierFlags::Command),
    }
}

fn native_range(range: TextRange) -> NSRange {
    NSRange::new(range.start as usize, range.length as usize)
}

fn unavailable_range() -> NSRange {
    NSRange::new(isize::MAX as usize, 0)
}

fn text_range(range: NSRange) -> Option<TextRange> {
    if range.location == isize::MAX as usize {
        return None;
    }
    Some(TextRange {
        start: u32::try_from(range.location).ok()?,
        length: u32::try_from(range.length).ok()?,
    })
}

fn text_from_object(object: &AnyObject) -> Option<String> {
    if let Some(text) = object.downcast_ref::<NSString>() {
        return Some(text.to_string());
    }
    object
        .downcast_ref::<NSAttributedString>()
        .map(|text| text.string().to_string())
}

fn key_code(key: u16) -> Option<(&'static str, u32, Option<&'static str>)> {
    let (code, vk, name) = match key {
        0 => ("KeyA", 65, None),
        1 => ("KeyS", 83, None),
        2 => ("KeyD", 68, None),
        3 => ("KeyF", 70, None),
        4 => ("KeyH", 72, None),
        5 => ("KeyG", 71, None),
        6 => ("KeyZ", 90, None),
        7 => ("KeyX", 88, None),
        8 => ("KeyC", 67, None),
        9 => ("KeyV", 86, None),
        11 => ("KeyB", 66, None),
        12 => ("KeyQ", 81, None),
        13 => ("KeyW", 87, None),
        14 => ("KeyE", 69, None),
        15 => ("KeyR", 82, None),
        16 => ("KeyY", 89, None),
        17 => ("KeyT", 84, None),
        18 => ("Digit1", 49, None),
        19 => ("Digit2", 50, None),
        20 => ("Digit3", 51, None),
        21 => ("Digit4", 52, None),
        22 => ("Digit6", 54, None),
        23 => ("Digit5", 53, None),
        24 => ("Equal", 187, None),
        25 => ("Digit9", 57, None),
        26 => ("Digit7", 55, None),
        27 => ("Minus", 189, None),
        28 => ("Digit8", 56, None),
        29 => ("Digit0", 48, None),
        30 => ("BracketRight", 221, None),
        31 => ("KeyO", 79, None),
        32 => ("KeyU", 85, None),
        33 => ("BracketLeft", 219, None),
        34 => ("KeyI", 73, None),
        35 => ("KeyP", 80, None),
        36 => ("Enter", 13, Some("Enter")),
        37 => ("KeyL", 76, None),
        38 => ("KeyJ", 74, None),
        39 => ("Quote", 222, None),
        40 => ("KeyK", 75, None),
        41 => ("Semicolon", 186, None),
        42 => ("Backslash", 220, None),
        43 => ("Comma", 188, None),
        44 => ("Slash", 191, None),
        45 => ("KeyN", 78, None),
        46 => ("KeyM", 77, None),
        47 => ("Period", 190, None),
        48 => ("Tab", 9, Some("Tab")),
        49 => ("Space", 32, Some(" ")),
        50 => ("Backquote", 192, None),
        51 => ("Backspace", 8, Some("Backspace")),
        53 => ("Escape", 27, Some("Escape")),
        55 => ("MetaLeft", 91, Some("Meta")),
        54 => ("MetaRight", 92, Some("Meta")),
        56 => ("ShiftLeft", 16, Some("Shift")),
        60 => ("ShiftRight", 16, Some("Shift")),
        58 => ("AltLeft", 18, Some("Alt")),
        61 => ("AltRight", 18, Some("Alt")),
        59 => ("ControlLeft", 17, Some("Control")),
        62 => ("ControlRight", 17, Some("Control")),
        57 => ("CapsLock", 20, Some("CapsLock")),
        122 => ("F1", 112, Some("F1")),
        120 => ("F2", 113, Some("F2")),
        99 => ("F3", 114, Some("F3")),
        118 => ("F4", 115, Some("F4")),
        96 => ("F5", 116, Some("F5")),
        97 => ("F6", 117, Some("F6")),
        98 => ("F7", 118, Some("F7")),
        100 => ("F8", 119, Some("F8")),
        101 => ("F9", 120, Some("F9")),
        109 => ("F10", 121, Some("F10")),
        103 => ("F11", 122, Some("F11")),
        111 => ("F12", 123, Some("F12")),
        105 => ("F13", 124, Some("F13")),
        107 => ("F14", 125, Some("F14")),
        113 => ("F15", 126, Some("F15")),
        106 => ("F16", 127, Some("F16")),
        64 => ("F17", 128, Some("F17")),
        79 => ("F18", 129, Some("F18")),
        80 => ("F19", 130, Some("F19")),
        90 => ("F20", 131, Some("F20")),
        82 => ("Numpad0", 96, None),
        83 => ("Numpad1", 97, None),
        84 => ("Numpad2", 98, None),
        85 => ("Numpad3", 99, None),
        86 => ("Numpad4", 100, None),
        87 => ("Numpad5", 101, None),
        88 => ("Numpad6", 102, None),
        89 => ("Numpad7", 103, None),
        91 => ("Numpad8", 104, None),
        92 => ("Numpad9", 105, None),
        65 => ("NumpadDecimal", 110, None),
        67 => ("NumpadMultiply", 106, None),
        69 => ("NumpadAdd", 107, None),
        75 => ("NumpadDivide", 111, None),
        76 => ("NumpadEnter", 13, Some("Enter")),
        78 => ("NumpadSubtract", 109, None),
        115 => ("Home", 36, Some("Home")),
        116 => ("PageUp", 33, Some("PageUp")),
        117 => ("Delete", 46, Some("Delete")),
        119 => ("End", 35, Some("End")),
        121 => ("PageDown", 34, Some("PageDown")),
        123 => ("ArrowLeft", 37, Some("ArrowLeft")),
        124 => ("ArrowRight", 39, Some("ArrowRight")),
        125 => ("ArrowDown", 40, Some("ArrowDown")),
        126 => ("ArrowUp", 38, Some("ArrowUp")),
        _ => return None,
    };
    Some((code, vk, name))
}

impl PreviewView {
    pub(super) fn new(
        mtm: MainThreadMarker,
        rect: NSRect,
        shared: Arc<Shared>,
    ) -> Result<Retained<Self>, SurfaceError> {
        let protocol = AnyProtocol::get(c"NSTextInputClient")
            .ok_or_else(|| SurfaceError::Native("NSTextInputClient protocol unavailable".into()))?;
        let class = Self::class();
        if !class.conforms_to(protocol) {
            // SAFETY: this class implements the public NSTextInputClient selectors above.
            unsafe {
                objc2::ffi::class_addProtocol(std::ptr::from_ref(class).cast_mut(), protocol);
            }
            if !class.conforms_to(protocol) {
                return Err(SurfaceError::Native(
                    "could not register NSTextInputClient".into(),
                ));
            }
        }
        let this = Self::alloc(mtm).set_ivars(ViewState {
            shared,
            composition: Cell::new(None),
            interpreting_physical_key: Cell::new(false),
            elements: RefCell::new(HashMap::new()),
            image_geometry: Cell::new(None),
        });
        // SAFETY: NSImageView implements initWithFrame:, and the ivars are initialized.
        Ok(unsafe { msg_send![super(this), initWithFrame: rect] })
    }

    fn query_text(&self, query: TextQuery) -> Result<Option<TextReply>, SurfaceError> {
        let Some(text) = self.ivars().shared.text_input_state() else {
            return Ok(None);
        };
        self.ivars().shared.check_key(text.key)?;
        let Some(backend) = text.backend_dom_node_id else {
            return Ok(None);
        };
        let Some(tree) = self.ivars().shared.ax_tree() else {
            return Ok(None);
        };
        let mut nodes = tree
            .snapshot
            .nodes
            .iter()
            .filter(|node| node.backend_dom_node_id == Some(backend));
        let Some(node) = nodes.next() else {
            return Ok(None);
        };
        if nodes.next().is_some() {
            return Err(SurfaceError::Invalid("ambiguous actual text frame".into()));
        }
        self.ivars()
            .shared
            .text_query(
                tree.snapshot.generation,
                AxTarget {
                    node_id: node.node_id.clone(),
                    frame_id: node.frame_id.clone(),
                    backend_dom_node_id: backend,
                },
                query,
            )
            .map(Some)
    }

    pub(super) fn clear_document(&self) {
        if let Some(context) = self.inputContext() {
            context.discardMarkedText();
        }
        self.ivars().elements.borrow_mut().clear();
        self.ivars().image_geometry.set(None);
        self.setImage(None);
        self.setNeedsDisplay(true);
    }

    pub(super) fn update_text_input(&self) {
        if let Some(context) = self.inputContext() {
            context.invalidateCharacterCoordinates();
        }
    }

    pub(super) fn update_accessibility(&self) {
        let Some(mtm) = MainThreadMarker::new() else {
            self.ivars().shared.report_error(SurfaceError::WrongThread);
            return;
        };
        let Some(tree) = self.ivars().shared.ax_tree() else {
            self.ivars().elements.borrow_mut().clear();
            return;
        };
        let mut elements = HashMap::with_capacity(tree.snapshot.nodes.len());
        for node in &tree.snapshot.nodes {
            elements.insert(
                node.node_id.clone(),
                AxElement::new(mtm, self, tree.snapshot.key, tree.snapshot.generation, node),
            );
        }
        *self.ivars().elements.borrow_mut() = elements;
        let object = retain_any(self);
        // SAFETY: PreviewView implements the accessibility methods and the
        // notification constant is AppKit's layout-changed notification.
        unsafe {
            objc2_app_kit::NSAccessibilityPostNotification(
                &object,
                objc2_app_kit::NSAccessibilityLayoutChangedNotification,
            );
        }
    }

    fn composition_current(&self) -> bool {
        match self.ivars().composition.get() {
            Some(key) => match self.ivars().shared.check_key(key) {
                Ok(()) => true,
                Err(error) => {
                    self.ivars().shared.report_error(error);
                    false
                }
            },
            None => match self.ivars().shared.check() {
                Ok(()) => true,
                Err(error) => {
                    self.ivars().shared.report_error(error);
                    false
                }
            },
        }
    }

    fn key(&self, event: &NSEvent, kind: KeyKind) {
        let native = event.keyCode();
        let Some((code, windows, special)) = key_code(native) else {
            self.ivars()
                .shared
                .report_error(SurfaceError::Invalid(format!(
                    "unsupported macOS key code {native}"
                )));
            return;
        };
        let characters = event
            .characters()
            .map(|value| value.to_string())
            .unwrap_or_default();
        let key = special
            .map(str::to_owned)
            .unwrap_or_else(|| characters.clone());
        let editable = self
            .ivars()
            .shared
            .text_input_state()
            .is_some_and(|state| state.editable);
        let text = if kind == KeyKind::Down
            && !editable
            && (special.is_none() || special == Some(" "))
            && !characters.is_empty()
        {
            Some(characters)
        } else {
            None
        };
        self.forward(Input::Key {
            kind,
            key,
            code: code.into(),
            windows_virtual_key_code: windows,
            native_virtual_key_code: u32::from(native),
            modifiers: modifiers(event.modifierFlags()),
            text,
            repeat: event.isARepeat(),
        });
    }

    pub(super) fn install_image(
        &self,
        image: &NSImage,
        geometry: FrameGeometry,
    ) -> Result<(), SurfaceError> {
        MainThreadMarker::new().ok_or(SurfaceError::WrongThread)?;
        self.ivars().image_geometry.set(Some(geometry));
        self.setImage(Some(image));
        self.setNeedsDisplay(true);
        self.displayIfNeeded();
        Ok(())
    }

    pub(super) fn set_visible(&self, visible: bool) -> Result<(), SurfaceError> {
        MainThreadMarker::new().ok_or(SurfaceError::WrongThread)?;
        self.setHidden(!visible);
        Ok(())
    }

    pub(super) fn detach(&self) -> Result<(), SurfaceError> {
        MainThreadMarker::new().ok_or(SurfaceError::WrongThread)?;
        self.setImage(None);
        self.ivars().image_geometry.set(None);
        self.removeFromSuperview();
        Ok(())
    }

    fn forward(&self, input: Input) {
        if let Err(error) = self.ivars().shared.input(input) {
            self.ivars().shared.report_error(error);
        }
    }

    fn mouse(&self, event: &NSEvent, kind: MouseKind) {
        let NSPoint { x, y } = self.convertPoint_fromView(event.locationInWindow(), None);
        let button = if matches!(kind, MouseKind::Move | MouseKind::Enter | MouseKind::Leave) {
            MouseButton::None
        } else {
            match event.buttonNumber() {
                0 => MouseButton::Left,
                1 => MouseButton::Right,
                2 => MouseButton::Middle,
                3 => MouseButton::Back,
                4 => MouseButton::Forward,
                _ => MouseButton::None,
            }
        };
        let pressed = NSEvent::pressedMouseButtons();
        let buttons =
            ((pressed & 1) | ((pressed & 2) << 1) | ((pressed & 4) >> 1) | (pressed & 24)) as u32;
        self.forward(Input::Mouse {
            kind,
            x,
            y,
            button,
            buttons,
            click_count: event.clickCount().max(0) as u32,
            modifiers: modifiers(event.modifierFlags()),
        });
    }
}

fn paint_rects(geometry: FrameGeometry, bounds: NSRect, flipped: bool) -> (NSRect, NSRect) {
    let image = geometry.image_rect();
    let y = if flipped {
        image.y
    } else {
        bounds.size.height - image.y - image.height
    };
    (
        bounds,
        NSRect::new(
            NSPoint::new(bounds.origin.x + image.x, bounds.origin.y + y),
            NSSize::new(image.width, image.height),
        ),
    )
}

pub(super) fn decode_frame(frame: &EncodedFrame) -> Result<Retained<NSImage>, SurfaceError> {
    MainThreadMarker::new().ok_or(SurfaceError::WrongThread)?;
    let bytes = Arc::clone(&frame.png);
    if bytes.is_empty() {
        return Err(SurfaceError::Native("empty Preview PNG".into()));
    }
    let ptr = NonNull::new(bytes.as_ptr().cast_mut().cast::<c_void>())
        .ok_or_else(|| SurfaceError::Native("invalid Preview PNG buffer".into()))?;
    let len = bytes.len();
    let deallocator = RcBlock::new(move |_: NonNull<c_void>, _: usize| {
        let _ = &bytes;
    });
    // SAFETY: NSData retains the deallocator block, which owns the Arc until NSData
    // releases the borrowed buffer. The immutable PNG allocation remains stable.
    let data = unsafe {
        NSData::initWithBytesNoCopy_length_deallocator(
            NSData::alloc(),
            ptr,
            len,
            Some(&deallocator),
        )
    };
    let bitmap = NSBitmapImageRep::initWithData(NSBitmapImageRep::alloc(), &data)
        .ok_or_else(|| SurfaceError::Native("cannot decode Preview PNG".into()))?;
    if bitmap.pixelsWide() != i64::from(frame.pixel_width) as isize
        || bitmap.pixelsHigh() != i64::from(frame.pixel_height) as isize
        || bitmap.bitmapData().is_null()
    {
        return Err(SurfaceError::Native(
            "invalid Preview PNG dimensions or pixels".into(),
        ));
    }
    let image = NSImage::initWithSize(
        NSImage::alloc(),
        NSSize::new(f64::from(frame.pixel_width), f64::from(frame.pixel_height)),
    );
    image.addRepresentation(&bitmap);
    Ok(image)
}

#[cfg(test)]
mod paint_tests {
    use super::super::super::model::FrameMetadata;
    use super::*;

    #[test]
    fn offset_image_keeps_its_size_and_leaves_the_rest_as_background() {
        let geometry = FrameGeometry::new(
            &FrameMetadata {
                device_width: 400.0,
                device_height: 300.0,
                page_scale_factor: 2.0,
                offset_top: 20.0,
                scroll_offset_x: 70.0,
                scroll_offset_y: 90.0,
            },
            (800.0, 600.0),
            (800, 480),
        )
        .unwrap();
        let bounds = NSRect::new(NSPoint::new(5.0, 7.0), NSSize::new(800.0, 600.0));
        let (background, image) = paint_rects(geometry, bounds, true);
        assert_eq!(background, bounds);
        assert_eq!(
            image,
            NSRect::new(NSPoint::new(5.0, 47.0), NSSize::new(800.0, 480.0))
        );
        assert_eq!(
            background.size.width * background.size.height - image.size.width * image.size.height,
            96_000.0,
        );
        assert_eq!(
            paint_rects(geometry, bounds, false).1,
            NSRect::new(NSPoint::new(5.0, 87.0), NSSize::new(800.0, 480.0)),
        );
    }
}
