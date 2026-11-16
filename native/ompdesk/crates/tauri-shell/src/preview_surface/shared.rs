use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};

use super::model::*;

#[derive(PartialEq, Eq)]
enum ReplyKind {
    Rects,
    Offset,
    Ranges,
    Range,
    Boundaries,
    Scrolled,
}

pub struct AxTree {
    pub snapshot: Arc<AxSnapshot>,
    indexes: HashMap<String, usize>,
    parents: HashMap<String, String>,
}

pub struct AxNodeRef {
    tree: Arc<AxTree>,
    index: usize,
}

impl std::ops::Deref for AxNodeRef {
    type Target = AxNode;
    fn deref(&self) -> &AxNode {
        &self.tree.snapshot.nodes[self.index]
    }
}

impl AxTree {
    fn new(snapshot: Arc<AxSnapshot>) -> Result<Self, SurfaceError> {
        let mut indexes = HashMap::with_capacity(snapshot.nodes.len());
        for (index, node) in snapshot.nodes.iter().enumerate() {
            if indexes.insert(node.node_id.clone(), index).is_some() {
                return Err(SurfaceError::Invalid("duplicate accessibility node".into()));
            }
            if node.secure && !matches!(node.value, AxValue::Protected | AxValue::None) {
                return Err(SurfaceError::Invalid(
                    "secure accessibility value was not redacted".into(),
                ));
            }
        }
        if snapshot
            .root_id
            .as_ref()
            .is_some_and(|id| !indexes.contains_key(id))
        {
            return Err(SurfaceError::Invalid("missing accessibility root".into()));
        }
        let mut parents = HashMap::new();
        for node in &snapshot.nodes {
            for child in &node.children {
                if !indexes.contains_key(child)
                    || parents
                        .insert(child.clone(), node.node_id.clone())
                        .is_some()
                {
                    return Err(SurfaceError::Invalid("invalid accessibility parent".into()));
                }
            }
        }
        let mut colors = vec![0u8; snapshot.nodes.len()];
        for start in 0..snapshot.nodes.len() {
            let mut cursor = Some(start);
            while let Some(index) = cursor {
                match colors[index] {
                    1 => return Err(SurfaceError::Invalid("cyclic accessibility tree".into())),
                    2 => break,
                    _ => colors[index] = 1,
                }
                cursor = parents
                    .get(&snapshot.nodes[index].node_id)
                    .map(|parent| indexes[parent]);
            }
            cursor = Some(start);
            while let Some(index) = cursor {
                if colors[index] != 1 {
                    break;
                }
                colors[index] = 2;
                cursor = parents
                    .get(&snapshot.nodes[index].node_id)
                    .map(|parent| indexes[parent]);
            }
        }
        Ok(Self {
            snapshot,
            indexes,
            parents,
        })
    }

    pub fn node(&self, id: &str) -> Option<&AxNode> {
        self.indexes
            .get(id)
            .map(|index| &self.snapshot.nodes[*index])
    }
    pub fn node_ref(self: &Arc<Self>, id: &str) -> Option<AxNodeRef> {
        self.indexes.get(id).map(|index| AxNodeRef {
            tree: Arc::clone(self),
            index: *index,
        })
    }
    pub fn parent(&self, id: &str) -> Option<&str> {
        self.parents.get(id).map(String::as_str)
    }
}

pub struct PendingFrame {
    pub frame: EncodedFrame,
    pub receipt_pending: bool,
}

struct State {
    key: SurfaceKey,
    bounds: Bounds,
    visible: bool,
    disposed: bool,
    scheduled: bool,
    schedule_ticket: u64,
    pending: Option<PendingFrame>,
    text: Option<Arc<TextInputState>>,
    ax: Option<Arc<AxTree>>,
}

pub struct Shared {
    state: Mutex<State>,
    consumer: Arc<dyn Consumer>,
}

#[derive(Clone)]
pub struct FramePublisher {
    shared: Weak<Shared>,
    key: SurfaceKey,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FrameSubmitError {
    /// The surface never owned or acknowledged the submitted frame.
    Rejected(SurfaceError),
    /// The surface owns the submitted receipt, even if a consumer callback failed.
    /// The caller must not acknowledge the submitted frame again.
    Accepted { errors: Vec<SurfaceError> },
}

impl std::fmt::Display for FrameSubmitError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Rejected(error) => std::fmt::Display::fmt(error, formatter),
            Self::Accepted { errors } => {
                formatter.write_str("frame accepted; consumer failures: ")?;
                for (index, error) in errors.iter().enumerate() {
                    if index != 0 {
                        formatter.write_str("; ")?;
                    }
                    std::fmt::Display::fmt(error, formatter)?;
                }
                Ok(())
            }
        }
    }
}

impl std::error::Error for FrameSubmitError {}

fn valid_bounds(bounds: Bounds) -> bool {
    let r = bounds.rect;
    [r.x, r.y, r.width, r.height, bounds.scale]
        .iter()
        .all(|v| v.is_finite())
        && r.width >= 0.0
        && r.height >= 0.0
        && bounds.scale > 0.0
}

impl Shared {
    pub fn new(
        key: SurfaceKey,
        bounds: Bounds,
        consumer: Arc<dyn Consumer>,
    ) -> Result<Arc<Self>, SurfaceError> {
        if !valid_bounds(bounds) {
            return Err(SurfaceError::Invalid("invalid surface bounds".into()));
        }
        Ok(Arc::new(Self {
            state: Mutex::new(State {
                key,
                bounds,
                visible: true,
                disposed: false,
                scheduled: false,
                schedule_ticket: 0,
                pending: None,
                text: None,
                ax: None,
            }),
            consumer,
        }))
    }
    pub fn key(&self) -> SurfaceKey {
        self.state.lock().unwrap().key
    }
    pub fn bounds(&self) -> Bounds {
        self.state.lock().unwrap().bounds
    }
    pub fn is_visible(&self) -> bool {
        let s = self.state.lock().unwrap();
        s.visible && !s.disposed
    }
    pub fn check(&self) -> Result<(), SurfaceError> {
        if self.state.lock().unwrap().disposed {
            Err(SurfaceError::Disposed)
        } else {
            Ok(())
        }
    }
    pub fn check_key(&self, key: SurfaceKey) -> Result<(), SurfaceError> {
        let s = self.state.lock().unwrap();
        if s.disposed {
            Err(SurfaceError::Disposed)
        } else if s.key != key {
            Err(SurfaceError::StaleGeneration)
        } else {
            Ok(())
        }
    }
    pub fn publisher(self: &Arc<Self>) -> FramePublisher {
        FramePublisher {
            shared: Arc::downgrade(self),
            key: self.key(),
        }
    }
    pub fn report_error(&self, error: SurfaceError) {
        self.consumer.failed(self.key(), error);
    }
    pub fn input(&self, input: Input) -> Result<(), SurfaceError> {
        self.check()?;
        self.consumer.input(self.key(), input)
    }
    pub fn accessibility(
        &self,
        generation: u64,
        target: AxTarget,
        action: AxAction,
    ) -> Result<(), SurfaceError> {
        let (key, node) = self.target(generation, &target)?;
        let kind = match action {
            AxAction::Default => AxActionKind::Default,
            AxAction::Focus => AxActionKind::Focus,
            AxAction::SetValue(_) => AxActionKind::SetValue,
            AxAction::SetSelection(_) => AxActionKind::SetSelection,
            AxAction::Increment => AxActionKind::Increment,
            AxAction::Decrement => AxActionKind::Decrement,
            AxAction::ShowMenu => AxActionKind::ShowMenu,
        };
        if node.disabled
            || !node.actions.contains(&kind)
            || (node.secure && matches!(action, AxAction::SetValue(_)))
        {
            return Err(SurfaceError::Invalid(
                "unsupported accessibility action".into(),
            ));
        }
        self.check_key(key)?;
        self.consumer.accessibility(key, generation, target, action)
    }

    fn target(
        &self,
        generation: u64,
        target: &AxTarget,
    ) -> Result<(SurfaceKey, AxNodeRef), SurfaceError> {
        let (key, tree) = {
            let s = self.state.lock().unwrap();
            if s.disposed {
                return Err(SurfaceError::Disposed);
            }
            (s.key, s.ax.clone().ok_or(SurfaceError::StaleGeneration)?)
        };
        if tree.snapshot.generation != generation {
            return Err(SurfaceError::StaleGeneration);
        }
        let node = tree
            .node_ref(&target.node_id)
            .ok_or(SurfaceError::StaleGeneration)?;
        if node.backend_dom_node_id != Some(target.backend_dom_node_id)
            || node.frame_id != target.frame_id
        {
            return Err(SurfaceError::StaleGeneration);
        }
        Ok((key, node))
    }

    pub fn text_query(
        &self,
        generation: u64,
        target: AxTarget,
        query: TextQuery,
    ) -> Result<TextReply, SurfaceError> {
        let (key, node) = self.target(generation, &target)?;
        if node.secure {
            return Err(SurfaceError::Invalid(
                "protected accessibility text is not exposed".into(),
            ));
        }
        if let TextQuery::RangeFromChild { child } = &query {
            self.target(generation, child)?;
        }
        let expected = match &query {
            TextQuery::RangeRects { .. } => ReplyKind::Rects,
            TextQuery::OffsetAtPoint { x, y } => {
                if !x.is_finite() || !y.is_finite() {
                    return Err(SurfaceError::Invalid("invalid text point".into()));
                }
                ReplyKind::Offset
            }
            TextQuery::VisibleRanges => ReplyKind::Ranges,
            TextQuery::RangeFromChild { .. } => ReplyKind::Range,
            TextQuery::UnitBoundaries { .. } => ReplyKind::Boundaries,
            TextQuery::ScrollIntoView { .. } => ReplyKind::Scrolled,
        };
        let reply = self.consumer.text_query(key, generation, target, query)?;
        self.check_key(key)?;
        let actual = match &reply {
            TextReply::Rects(rects) => {
                if rects.iter().any(|rect| {
                    ![rect.x, rect.y, rect.width, rect.height]
                        .iter()
                        .all(|value| value.is_finite())
                        || rect.width < 0.0
                        || rect.height < 0.0
                }) {
                    return Err(SurfaceError::Invalid(
                        "invalid actual text rectangles".into(),
                    ));
                }
                ReplyKind::Rects
            }
            TextReply::Offset(_) => ReplyKind::Offset,
            TextReply::Ranges(_) => ReplyKind::Ranges,
            TextReply::Range(_) => ReplyKind::Range,
            TextReply::Boundaries(values) => {
                if values.first() != Some(&0) || values.windows(2).any(|pair| pair[0] >= pair[1]) {
                    return Err(SurfaceError::Invalid(
                        "invalid actual UTF-16 boundaries".into(),
                    ));
                }
                ReplyKind::Boundaries
            }
            TextReply::Scrolled => ReplyKind::Scrolled,
        };
        if expected != actual {
            return Err(SurfaceError::Consumer(
                "text query returned a different reply kind".into(),
            ));
        }
        Ok(reply)
    }
    pub fn set_document(&self, key: SurfaceKey) -> Result<(), SurfaceError> {
        let pending = {
            let mut s = self.state.lock().unwrap();
            if s.disposed {
                return Err(SurfaceError::Disposed);
            }
            if key.view != s.key.view || key.wc != s.key.wc || key.generation <= s.key.generation {
                return Err(SurfaceError::StaleGeneration);
            }
            s.key = key;
            s.ax = None;
            s.text = None;
            s.scheduled = false;
            s.schedule_ticket = s.schedule_ticket.wrapping_add(1);
            s.pending.take()
        };
        if let Some(pending) = pending {
            self.finish_frame(pending, FrameDisposition::Disposed)?;
        }
        Ok(())
    }
    pub fn set_bounds(&self, bounds: Bounds) -> Result<(), SurfaceError> {
        if !valid_bounds(bounds) {
            return Err(SurfaceError::Invalid("invalid surface bounds".into()));
        }
        let mut s = self.state.lock().unwrap();
        if s.disposed {
            return Err(SurfaceError::Disposed);
        }
        s.bounds = bounds;
        Ok(())
    }
    pub fn set_visible(&self, visible: bool) -> Result<(), SurfaceError> {
        let receipt = {
            let mut s = self.state.lock().unwrap();
            if s.disposed {
                return Err(SurfaceError::Disposed);
            }
            s.visible = visible;
            if !visible {
                s.scheduled = false;
                s.schedule_ticket = s.schedule_ticket.wrapping_add(1);
                s.pending.as_mut().and_then(|pending| {
                    if std::mem::replace(&mut pending.receipt_pending, false) {
                        Some((pending.frame.key, pending.frame.ack))
                    } else {
                        None
                    }
                })
            } else {
                None
            }
        };
        if let Some((key, ack)) = receipt {
            self.consumer
                .presented(key, ack, FrameDisposition::Hidden)?;
        }
        Ok(())
    }
    pub fn set_text_input_state(&self, text: TextInputState) -> Result<(), SurfaceError> {
        let length = match &text.content {
            TextContent::Plain(value) => value.encode_utf16().count(),
            TextContent::Protected { utf16_length } => *utf16_length as usize,
        };
        for range in [Some(text.selection), text.marked].into_iter().flatten() {
            if range.start as usize > length
                || range.length as usize > length - range.start as usize
            {
                return Err(SurfaceError::Invalid(
                    "text range outside actual content".into(),
                ));
            }
        }
        let mut s = self.state.lock().unwrap();
        if s.disposed {
            return Err(SurfaceError::Disposed);
        }
        if s.key != text.key || text.generation != s.key.generation {
            return Err(SurfaceError::StaleGeneration);
        }
        s.text = Some(Arc::new(text));
        Ok(())
    }
    pub fn text_input_state(&self) -> Option<Arc<TextInputState>> {
        self.state.lock().unwrap().text.clone()
    }
    pub fn set_accessibility(&self, snapshot: Arc<AxSnapshot>) -> Result<(), SurfaceError> {
        let tree = Arc::new(AxTree::new(snapshot)?);
        let mut s = self.state.lock().unwrap();
        if s.disposed {
            return Err(SurfaceError::Disposed);
        }
        if tree.snapshot.key != s.key || tree.snapshot.generation != s.key.generation {
            return Err(SurfaceError::StaleGeneration);
        }
        s.ax = Some(tree);
        Ok(())
    }
    pub fn ax_tree(&self) -> Option<Arc<AxTree>> {
        self.state.lock().unwrap().ax.clone()
    }
    pub fn take_frame(&self) -> Result<Option<PendingFrame>, SurfaceError> {
        let mut s = self.state.lock().unwrap();
        if s.disposed {
            return Err(SurfaceError::Disposed);
        }
        s.scheduled = false;
        if !s.visible {
            return Ok(None);
        }
        Ok(s.pending.take())
    }
    pub fn finish_frame(
        &self,
        pending: PendingFrame,
        disposition: FrameDisposition,
    ) -> Result<(), SurfaceError> {
        if pending.receipt_pending {
            self.consumer
                .presented(pending.frame.key, pending.frame.ack, disposition)?;
        }
        Ok(())
    }
    pub fn close(&self) -> Result<(), SurfaceError> {
        let pending = {
            let mut s = self.state.lock().unwrap();
            if s.disposed {
                return Ok(());
            }
            s.disposed = true;
            s.scheduled = false;
            s.ax = None;
            s.text = None;
            s.pending.take()
        };
        if let Some(pending) = pending {
            self.finish_frame(pending, FrameDisposition::Disposed)?;
        }
        Ok(())
    }
}

impl FramePublisher {
    pub fn submit(&self, frame: EncodedFrame) -> Result<(), FrameSubmitError> {
        let shared = self
            .shared
            .upgrade()
            .ok_or(FrameSubmitError::Rejected(SurfaceError::Disposed))?;
        if frame.key != self.key {
            return Err(FrameSubmitError::Rejected(SurfaceError::StaleGeneration));
        }
        if frame.pixel_width == 0
            || frame.pixel_height == 0
            || !frame.scale.is_finite()
            || frame.scale <= 0.0
        {
            return Err(FrameSubmitError::Rejected(SurfaceError::Invalid(
                "invalid actual frame dimensions".into(),
            )));
        }
        let frame_ack = frame.ack;
        let (old, hidden, schedule) = {
            let mut s = shared.state.lock().unwrap();
            if s.disposed {
                return Err(FrameSubmitError::Rejected(SurfaceError::Disposed));
            }
            if s.key != self.key {
                return Err(FrameSubmitError::Rejected(SurfaceError::StaleGeneration));
            }
            let hidden = !s.visible;
            let old = s.pending.replace(PendingFrame {
                frame,
                receipt_pending: !hidden,
            });
            let schedule = if !hidden && !s.scheduled {
                s.scheduled = true;
                s.schedule_ticket = s.schedule_ticket.wrapping_add(1);
                Some(s.schedule_ticket)
            } else {
                None
            };
            (old, hidden, schedule)
        };
        let mut errors = Vec::new();
        if let Some(old) = old
            && let Err(error) = shared.finish_frame(old, FrameDisposition::Superseded)
        {
            errors.push(error);
        }
        if hidden
            && let Err(error) =
                shared
                    .consumer
                    .presented(self.key, frame_ack, FrameDisposition::Hidden)
        {
            errors.push(error);
        }
        if let Some(ticket) = schedule
            && let Err(error) = shared.consumer.schedule_present(self.key)
        {
            errors.push(error);
            let pending = {
                let mut s = shared.state.lock().unwrap();
                if s.schedule_ticket == ticket && s.key == self.key {
                    s.scheduled = false;
                    s.pending.take()
                } else {
                    None
                }
            };
            if let Some(pending) = pending
                && let Err(error) = shared.finish_frame(pending, FrameDisposition::Disposed)
            {
                errors.push(error);
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(FrameSubmitError::Accepted { errors })
        }
    }
}

#[cfg(test)]
#[path = "shared/tests.rs"]
mod tests;
