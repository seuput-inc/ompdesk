use std::collections::{HashMap, HashSet};

use serde_json::{Value, json};
use shell_core::wire::WireError;
use shell_preview::Browser;

use super::{accessibility, input, target::Target, text_queries};
use crate::preview_surface::{
    AxNode, AxSnapshot, AxTarget, Rect, SurfaceKey, TextContent, TextInputState, TextQuery,
    TextRange, TextReply,
};

fn error(message: &str) -> WireError {
    WireError::new("cdp", message)
}

struct Frame<'a> {
    id: String,
    parent: Option<String>,
    session: &'a str,
    session_root: String,
}

fn collect_frames<'a>(
    tree: &Value,
    session: &'a str,
    root: &str,
    tree_parent: Option<&str>,
    frames: &mut HashMap<String, Frame<'a>>,
) -> Result<(), WireError> {
    let frame = tree
        .get("frame")
        .ok_or_else(|| error("Frame tree has no frame"))?;
    let id = frame
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| error("Frame has no ID"))?;
    let parent = frame
        .get("parentId")
        .and_then(Value::as_str)
        .or(tree_parent)
        .map(str::to_owned);
    match frames.get_mut(id) {
        Some(existing) => {
            if existing.parent.is_none() {
                existing.parent = parent;
            }
            if id == root {
                existing.session = session;
                existing.session_root = root.to_owned();
            }
        }
        None => {
            frames.insert(
                id.to_owned(),
                Frame {
                    id: id.to_owned(),
                    parent,
                    session,
                    session_root: root.to_owned(),
                },
            );
        }
    }
    if let Some(children) = tree.get("childFrames").and_then(Value::as_array) {
        for child in children {
            collect_frames(child, session, root, Some(id), frames)?;
        }
    }
    Ok(())
}

async fn frames<'a>(
    browser: &Browser,
    primary: &'a str,
    sessions: &'a [String],
    key: Option<SurfaceKey>,
) -> Result<(String, HashMap<String, Frame<'a>>), WireError> {
    let mut frames = HashMap::new();
    let mut primary_root = None;
    let mut roots = HashMap::new();
    for session in std::iter::once(primary).chain(sessions.iter().map(String::as_str)) {
        let target = match key {
            Some(key) => Target::guarded(browser, session, key),
            None => Target::new(browser, session),
        };
        let tree = target.command("Page.getFrameTree", json!({})).await?;
        let tree = tree
            .get("frameTree")
            .ok_or_else(|| error("Chromium returned no frame tree"))?;
        let root = tree
            .pointer("/frame/id")
            .and_then(Value::as_str)
            .ok_or_else(|| error("Chromium returned no root frame"))?;
        if primary_root.is_none() {
            primary_root = Some(root.to_owned());
        }
        roots.insert(root.to_owned(), session);
        collect_frames(tree, session, root, None, &mut frames)?;
    }
    let mut assignments = Vec::with_capacity(frames.len());
    for frame in frames.values() {
        let mut current = frame.id.as_str();
        let mut visited = HashSet::new();
        loop {
            if !visited.insert(current) {
                return Err(error("Cycle in Chromium frame tree"));
            }
            if let Some(session) = roots.get(current) {
                assignments.push((frame.id.clone(), current.to_owned(), *session));
                break;
            }
            current = frames
                .get(current)
                .and_then(|entry| entry.parent.as_deref())
                .ok_or_else(|| error("Frame has no authorized session root"))?;
        }
    }
    for (id, root, session) in assignments {
        let frame = frames
            .get_mut(&id)
            .ok_or_else(|| error("Frame disappeared"))?;
        frame.session = session;
        frame.session_root = root;
    }
    Ok((
        primary_root.ok_or_else(|| error("Chromium returned no primary frame"))?,
        frames,
    ))
}

pub(super) async fn resolve_session<'a>(
    browser: &Browser,
    primary_session: &'a str,
    iframe_sessions: &'a [String],
    frame_id: &str,
) -> Result<&'a str, WireError> {
    let (_, frames) = frames(browser, primary_session, iframe_sessions, None).await?;
    frames
        .get(frame_id)
        .map(|frame| frame.session)
        .ok_or_else(|| error("Frame is not in an authorized Preview session"))
}

#[derive(Clone, Copy, PartialEq)]
struct Transform {
    a: f64,
    b: f64,
    c: f64,
    d: f64,
    x: f64,
    y: f64,
}

impl Transform {
    const IDENTITY: Self = Self {
        a: 1.0,
        b: 0.0,
        c: 0.0,
        d: 1.0,
        x: 0.0,
        y: 0.0,
    };
    fn point(self, x: f64, y: f64) -> (f64, f64) {
        (
            self.a * x + self.c * y + self.x,
            self.b * x + self.d * y + self.y,
        )
    }
    fn inverse_point(self, x: f64, y: f64) -> Result<(f64, f64), WireError> {
        let determinant = self.a * self.d - self.b * self.c;
        if !determinant.is_finite() || determinant.abs() <= f64::EPSILON {
            return Err(error("Iframe geometry is not invertible"));
        }
        let x = x - self.x;
        let y = y - self.y;
        let point = (
            (self.d * x - self.c * y) / determinant,
            (self.a * y - self.b * x) / determinant,
        );
        if !point.0.is_finite() || !point.1.is_finite() {
            return Err(error("Invalid transformed text point"));
        }
        Ok(point)
    }
    fn compose(self, child: Self) -> Self {
        let (x, y) = self.point(child.x, child.y);
        Self {
            a: self.a * child.a + self.c * child.b,
            b: self.b * child.a + self.d * child.b,
            c: self.a * child.c + self.c * child.d,
            d: self.b * child.c + self.d * child.d,
            x,
            y,
        }
    }
    fn rect(self, rect: Rect, zoom: f64) -> Rect {
        let points = [
            self.point(rect.x, rect.y),
            self.point(rect.x + rect.width, rect.y),
            self.point(rect.x + rect.width, rect.y + rect.height),
            self.point(rect.x, rect.y + rect.height),
        ];
        let min_x = points.iter().map(|p| p.0).fold(f64::INFINITY, f64::min);
        let max_x = points.iter().map(|p| p.0).fold(f64::NEG_INFINITY, f64::max);
        let min_y = points.iter().map(|p| p.1).fold(f64::INFINITY, f64::min);
        let max_y = points.iter().map(|p| p.1).fold(f64::NEG_INFINITY, f64::max);
        Rect {
            x: min_x * zoom,
            y: min_y * zoom,
            width: (max_x - min_x) * zoom,
            height: (max_y - min_y) * zoom,
        }
    }
}

fn from_quad(quad: &[f64], width: f64, height: f64) -> Result<Transform, WireError> {
    if quad.len() != 8
        || !width.is_finite()
        || !height.is_finite()
        || width <= 0.0
        || height <= 0.0
        || quad.iter().any(|n| !n.is_finite())
    {
        return Err(error("Invalid iframe content quad or viewport"));
    }
    let tolerance = 1e-5 * (1.0 + quad.iter().map(|n| n.abs()).fold(0.0, f64::max));
    if (quad[0] + quad[4] - quad[2] - quad[6]).abs() > tolerance
        || (quad[1] + quad[5] - quad[3] - quad[7]).abs() > tolerance
    {
        return Err(error("Perspective iframe geometry is not affine"));
    }
    Ok(Transform {
        a: (quad[2] - quad[0]) / width,
        b: (quad[3] - quad[1]) / width,
        c: (quad[6] - quad[0]) / height,
        d: (quad[7] - quad[1]) / height,
        x: quad[0],
        y: quad[1],
    })
}

fn attach(
    nodes: &mut [AxNode],
    parent_frame: &str,
    owner: i64,
    child_root: &str,
) -> Result<(), WireError> {
    let mut owners = nodes.iter_mut().filter(|node| {
        node.frame_id.as_deref() == Some(parent_frame) && node.backend_dom_node_id == Some(owner)
    });
    let node = owners
        .next()
        .ok_or_else(|| error("Iframe owner is absent from parent AX tree"))?;
    if owners.next().is_some() {
        return Err(error("Iframe owner is ambiguous in parent AX tree"));
    }
    if !node.children.iter().any(|id| id == child_root) {
        node.children.push(child_root.to_owned());
    }
    Ok(())
}

struct FrameGeometry {
    transform: Transform,
    owner: Option<(String, i64)>,
}

async fn geometry(
    browser: &Browser,
    root: &str,
    frames: &HashMap<String, Frame<'_>>,
    key: SurfaceKey,
) -> Result<Vec<(String, FrameGeometry)>, WireError> {
    let mut ordered = Vec::with_capacity(frames.len());
    let mut transforms: HashMap<String, Transform> = HashMap::new();
    let mut pending: HashSet<&str> = frames.keys().map(String::as_str).collect();
    while !pending.is_empty() {
        let mut ready: Vec<&str> = pending
            .iter()
            .copied()
            .filter(|id| {
                let frame = &frames[*id];
                *id == root
                    || frame.parent.as_ref().is_some_and(|parent| {
                        frames.get(parent).is_some_and(|parent| {
                            transforms.contains_key(&parent.id)
                                && transforms.contains_key(&parent.session_root)
                        })
                    })
            })
            .collect();
        ready.sort_unstable();
        if ready.is_empty() {
            return Err(error("Iframe tree is disconnected from primary Preview"));
        }
        for id in ready {
            let frame = &frames[id];
            let (transform, owner) = if id == root {
                (Transform::IDENTITY, None)
            } else {
                let parent_id = frame
                    .parent
                    .as_deref()
                    .ok_or_else(|| error("Iframe has no parent frame"))?;
                let parent = frames
                    .get(parent_id)
                    .ok_or_else(|| error("Iframe parent is not authorized"))?;
                let parent_target = Target::frame(browser, parent.session, parent_id, key);
                let owner = parent_target
                    .command("DOM.getFrameOwner", json!({"frameId":id}))
                    .await?;
                let backend = owner
                    .get("backendNodeId")
                    .and_then(Value::as_i64)
                    .ok_or_else(|| error("Iframe owner has no backend ID"))?;
                let model = parent_target
                    .command("DOM.getBoxModel", json!({"backendNodeId":backend}))
                    .await?;
                let quad = model
                    .pointer("/model/content")
                    .and_then(Value::as_array)
                    .ok_or_else(|| error("Iframe owner has no content quad"))?
                    .iter()
                    .map(|n| {
                        n.as_f64()
                            .ok_or_else(|| error("Invalid iframe content quad"))
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                let target = Target::frame(browser, frame.session, id, key);
                let world = target.command("Page.createIsolatedWorld", json!({"frameId":id,"worldName":"ompdesk-frame-geometry","grantUniveralAccess":false})).await?;
                let context = world
                    .get("executionContextId")
                    .and_then(Value::as_i64)
                    .ok_or_else(|| error("Iframe has no isolated world"))?;
                let viewport = target.command("Runtime.evaluate", json!({"expression":"[innerWidth,innerHeight]","contextId":context,"returnByValue":true})).await?;
                let values = viewport
                    .pointer("/result/value")
                    .and_then(Value::as_array)
                    .ok_or_else(|| error("Iframe viewport unavailable"))?;
                let width = values
                    .first()
                    .and_then(Value::as_f64)
                    .ok_or_else(|| error("Iframe viewport width unavailable"))?;
                let height = values
                    .get(1)
                    .and_then(Value::as_f64)
                    .ok_or_else(|| error("Iframe viewport height unavailable"))?;
                let parent_root = transforms
                    .get(&parent.session_root)
                    .copied()
                    .ok_or_else(|| error("Parent session geometry unavailable"))?;
                (
                    parent_root.compose(from_quad(&quad, width, height)?),
                    Some((parent_id.to_owned(), backend)),
                )
            };
            transforms.insert(id.to_owned(), transform);
            ordered.push((id.to_owned(), FrameGeometry { transform, owner }));
            pending.remove(id);
        }
    }
    Ok(ordered)
}

pub(super) async fn snapshot(
    browser: &Browser,
    primary_session: &str,
    iframe_sessions: &[String],
    key: SurfaceKey,
    paint: crate::preview_surface::FrameGeometry,
) -> Result<AxSnapshot, WireError> {
    let (root, frames) = frames(browser, primary_session, iframe_sessions, Some(key)).await?;
    let geometry = geometry(browser, &root, &frames, key).await?;
    let mut result = AxSnapshot {
        key,
        generation: key.generation,
        root_id: None,
        nodes: Vec::new(),
    };
    for (id, geometry) in geometry {
        let frame = &frames[&id];
        let target = Target::frame(browser, frame.session, &frame.id, key);
        let mut tree = accessibility::snapshot_frame(&target, &frame.id, key, 1.0).await?;
        let child_root = tree
            .root_id
            .as_deref()
            .ok_or_else(|| error("Frame has no AX root"))?;
        if let Some((parent, backend)) = geometry.owner {
            attach(&mut result.nodes, &parent, backend, child_root)?;
        } else {
            result.root_id = Some(child_root.to_owned());
        }
        for node in &mut tree.nodes {
            if let Some(bounds) = node.bounds {
                node.bounds =
                    Some(paint.viewport_rect_to_view(geometry.transform.rect(bounds, 1.0)));
            }
        }
        result.nodes.extend(tree.nodes);
    }
    Ok(result)
}

async fn check_root(
    target: &Target<'_>,
    snapshot: &AxSnapshot,
    frame: &str,
    primary: bool,
) -> Result<(), WireError> {
    target.command("Accessibility.enable", json!({})).await?;
    let root = target
        .command("Accessibility.getRootAXNode", json!({"frameId":frame}))
        .await?;
    let id = root
        .pointer("/node/nodeId")
        .and_then(Value::as_str)
        .ok_or_else(|| error("Frame has no actual AX root"))?;
    let id = accessibility::scoped_id(frame, id);
    if !snapshot
        .nodes
        .iter()
        .any(|node| node.node_id == id && node.frame_id.as_deref() == Some(frame))
        || primary && snapshot.root_id.as_deref() != Some(id.as_str())
    {
        return Err(WireError::new("stale", "Accessibility frame root changed"));
    }
    Ok(())
}

pub(super) async fn text_query(
    browser: &Browser,
    primary: &str,
    iframe_sessions: &[String],
    snapshot: &AxSnapshot,
    node: AxTarget,
    query: TextQuery,
    paint: crate::preview_surface::FrameGeometry,
) -> Result<TextReply, WireError> {
    if snapshot.generation != snapshot.key.generation {
        return Err(WireError::new(
            "stale",
            "Accessibility snapshot generation is stale",
        ));
    }
    let belongs = |target: &AxTarget| {
        snapshot.nodes.iter().any(|item| {
            item.node_id == target.node_id
                && item.frame_id == target.frame_id
                && item.backend_dom_node_id == Some(target.backend_dom_node_id)
        })
    };
    if !belongs(&node) {
        return Err(WireError::new(
            "invalid",
            "Text target does not belong to snapshot",
        ));
    }
    #[cfg(windows)]
    if let TextQuery::RangeFromChild { child } = &query {
        if !belongs(child) {
            return Err(WireError::new(
                "invalid",
                "Text child does not belong to snapshot",
            ));
        }
        if child.frame_id != node.frame_id {
            return Err(WireError::new(
                "unsupported",
                "Text ranges across frames are not supported",
            ));
        }
    }
    let frame_id = node
        .frame_id
        .as_deref()
        .ok_or_else(|| WireError::new("invalid", "Text target has no frame"))?
        .to_owned();
    let (root, graph) = frames(browser, primary, iframe_sessions, Some(snapshot.key)).await?;
    let session = graph
        .get(&frame_id)
        .ok_or_else(|| WireError::new("stale", "Text frame is no longer authorized"))?
        .session;
    let primary_target = Target::frame(browser, primary, &root, snapshot.key);
    let target = Target::frame(browser, session, &frame_id, snapshot.key);
    check_root(&primary_target, snapshot, &root, true).await?;
    if frame_id != root {
        check_root(&target, snapshot, &frame_id, false).await?;
    }
    let needs_geometry = matches!(
        &query,
        TextQuery::RangeRects { .. } | TextQuery::OffsetAtPoint { .. }
    );
    let transform = if needs_geometry {
        geometry(browser, &root, &graph, snapshot.key)
            .await?
            .into_iter()
            .find(|(id, _)| id == &frame_id)
            .map(|(_, frame)| frame.transform)
            .ok_or_else(|| error("Text frame geometry unavailable"))?
    } else {
        Transform::IDENTITY
    };
    let query = match query {
        TextQuery::OffsetAtPoint { x, y } => {
            if !x.is_finite() || !y.is_finite() {
                return Err(WireError::new("invalid", "Invalid text point"));
            }
            let (x, y) = paint.to_viewport_css((x, y));
            let (x, y) = transform.inverse_point(x, y)?;
            TextQuery::OffsetAtPoint { x, y }
        }
        other => other,
    };
    let result = text_queries::query(&target, snapshot, node, query, 1.0).await;
    let (current_root, current_graph) =
        frames(browser, primary, iframe_sessions, Some(snapshot.key)).await?;
    if current_root != root
        || current_graph
            .get(&frame_id)
            .is_none_or(|frame| frame.session != session)
    {
        return Err(WireError::new("stale", "Text frame changed during query"));
    }
    check_root(&primary_target, snapshot, &root, true).await?;
    if frame_id != root {
        check_root(&target, snapshot, &frame_id, false).await?;
    }
    if needs_geometry {
        let current = geometry(browser, &root, &current_graph, snapshot.key)
            .await?
            .into_iter()
            .find(|(id, _)| id == &frame_id)
            .map(|(_, frame)| frame.transform)
            .ok_or_else(|| error("Text frame geometry unavailable"))?;
        if current != transform {
            return Err(WireError::new(
                "stale",
                "Text frame geometry changed during query",
            ));
        }
    }
    match result? {
        TextReply::Rects(rects) => Ok(TextReply::Rects(
            rects
                .into_iter()
                .map(|rect| paint.viewport_rect_to_view(transform.rect(rect, 1.0)))
                .collect(),
        )),
        other => Ok(other),
    }
}

#[derive(Clone, Copy)]
enum Focus {
    Unfocused,
    Empty,
    Leaf(i64),
    Owner(i64),
}

async fn focused_frame(
    browser: &Browser,
    root: &str,
    frames: &HashMap<String, Frame<'_>>,
    key: SurfaceKey,
) -> Result<Option<(String, i64)>, WireError> {
    let mut states = HashMap::new();
    let mut ids: Vec<&str> = frames.keys().map(String::as_str).collect();
    ids.sort_unstable();
    for id in ids {
        let frame = &frames[id];
        let target = Target::frame(browser, frame.session, id, key);
        let context = target.isolated_world("ompdesk-native-input").await?;
        let value = target.command("Runtime.evaluate", json!({"contextId":context,"returnByValue":true,"expression":"(()=>{if(!document.hasFocus())return 'unfocused';const e=document.activeElement;if(!e)return 'empty';if(e instanceof HTMLIFrameElement||e instanceof HTMLFrameElement)return 'owner';if((e===document.body||e===document.documentElement)&&!e.matches(':focus')&&!e.isContentEditable)return 'empty';return 'leaf'})()"})).await?;
        if value.get("exceptionDetails").is_some() {
            return Err(error("Could not inspect frame focus"));
        }
        let state = match value.pointer("/result/value").and_then(Value::as_str) {
            Some("unfocused") => Focus::Unfocused,
            Some("empty") => Focus::Empty,
            Some(kind @ ("leaf" | "owner")) => {
                let object = target
                    .command(
                        "Runtime.evaluate",
                        json!({"contextId":context,"expression":"document.activeElement"}),
                    )
                    .await?;
                let object = object
                    .pointer("/result/objectId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| error("Focused element is unavailable"))?;
                let described = target
                    .command("DOM.describeNode", json!({"objectId":object}))
                    .await;
                let release = target
                    .command("Runtime.releaseObject", json!({"objectId":object}))
                    .await;
                let described = described?;
                release?;
                let backend = described
                    .pointer("/node/backendNodeId")
                    .and_then(Value::as_i64)
                    .ok_or_else(|| error("Focused element has no backend ID"))?;
                if kind == "owner" {
                    Focus::Owner(backend)
                } else {
                    Focus::Leaf(backend)
                }
            }
            _ => return Err(error("Invalid frame focus result")),
        };
        states.insert(id.to_owned(), state);
    }
    let mut current = root;
    let mut visited = HashSet::new();
    let selected = loop {
        if !visited.insert(current) {
            return Err(error("Cycle in focused frame chain"));
        }
        match states
            .get(current)
            .copied()
            .ok_or_else(|| error("Focused frame is unavailable"))?
        {
            Focus::Unfocused | Focus::Empty => break None,
            Focus::Leaf(backend) => break Some((current.to_owned(), backend)),
            Focus::Owner(owner) => {
                let parent = frames
                    .get(current)
                    .ok_or_else(|| error("Focused frame is unavailable"))?;
                let target = Target::frame(browser, parent.session, current, key);
                let mut child = None;
                for frame in frames
                    .values()
                    .filter(|frame| frame.parent.as_deref() == Some(current))
                {
                    let actual = target
                        .command("DOM.getFrameOwner", json!({"frameId":frame.id}))
                        .await?;
                    if actual.get("backendNodeId").and_then(Value::as_i64) == Some(owner)
                        && child.replace(frame.id.as_str()).is_some()
                    {
                        return Err(error("Focused iframe owner is ambiguous"));
                    }
                }
                current =
                    child.ok_or_else(|| error("Focused iframe is not in an authorized session"))?;
                if matches!(states.get(current), Some(Focus::Unfocused) | None) {
                    return Err(error("Focused iframe document is unavailable"));
                }
            }
        }
    };
    if states.iter().any(|(id, state)| {
        matches!(state, Focus::Leaf(_))
            && selected.as_ref().is_none_or(|(selected, _)| selected != id)
    }) {
        return Err(error("Multiple focused frame leaves are ambiguous"));
    }
    Ok(selected)
}

pub(super) struct FocusedTarget {
    pub session: String,
    pub frame: String,
    pub backend: i64,
}

pub(super) struct TextSnapshot {
    pub state: TextInputState,
    pub target: Option<FocusedTarget>,
}

pub(super) async fn focused_target(
    browser: &Browser,
    primary: &str,
    iframe_sessions: &[String],
    key: SurfaceKey,
) -> Result<FocusedTarget, WireError> {
    let (root, graph) = frames(browser, primary, iframe_sessions, Some(key)).await?;
    let (frame, backend) = focused_frame(browser, &root, &graph, key)
        .await?
        .ok_or_else(|| {
            WireError::new("focus-unavailable", "Preview has no focused frame target")
        })?;
    let session = graph
        .get(&frame)
        .ok_or_else(|| error("Focused frame disappeared"))?
        .session
        .to_owned();
    Ok(FocusedTarget {
        session,
        frame,
        backend,
    })
}

pub(super) async fn text_state(
    browser: &Browser,
    primary: &str,
    iframe_sessions: &[String],
    key: SurfaceKey,
    paint: crate::preview_surface::FrameGeometry,
    marked: Option<TextRange>,
) -> Result<TextSnapshot, WireError> {
    let (root, graph) = frames(browser, primary, iframe_sessions, Some(key)).await?;
    let Some((frame_id, backend)) = focused_frame(browser, &root, &graph, key).await? else {
        return Ok(TextSnapshot {
            state: TextInputState {
                key,
                generation: key.generation,
                backend_dom_node_id: None,
                #[cfg(target_os = "macos")]
                editable: false,
                content: TextContent::Plain(String::new()),
                selection: TextRange {
                    start: 0,
                    length: 0,
                },
                marked: None,
                caret: None,
            },
            target: None,
        });
    };
    let frame = graph
        .get(&frame_id)
        .ok_or_else(|| error("Focused frame disappeared"))?;
    let session = frame.session;
    let target = Target::frame(browser, session, &frame_id, key);
    let mut state = input::text_state(&target, key, 1.0, marked).await?;
    if state.backend_dom_node_id != Some(backend) {
        return Err(WireError::new(
            "stale",
            "Focused element changed during text state query",
        ));
    }
    let caret_transform = if let Some(caret) = state.caret {
        let transform = geometry(browser, &root, &graph, key)
            .await?
            .into_iter()
            .find(|(id, _)| id == &frame_id)
            .map(|(_, frame)| frame.transform)
            .ok_or_else(|| error("Focused frame geometry unavailable"))?;
        state.caret = Some(paint.viewport_rect_to_view(transform.rect(caret, 1.0)));
        Some(transform)
    } else {
        None
    };
    let (current_root, current_graph) =
        frames(browser, primary, iframe_sessions, Some(key)).await?;
    if current_root != root
        || current_graph
            .get(&frame_id)
            .is_none_or(|frame| frame.session != session)
        || focused_frame(browser, &current_root, &current_graph, key)
            .await?
            .is_none_or(|(id, actual)| id != frame_id || actual != backend)
    {
        return Err(WireError::new(
            "stale",
            "Focused frame changed during text state query",
        ));
    }
    if let Some(transform) = caret_transform {
        let current = geometry(browser, &root, &current_graph, key)
            .await?
            .into_iter()
            .find(|(id, _)| id == &frame_id)
            .map(|(_, frame)| frame.transform)
            .ok_or_else(|| error("Focused frame geometry unavailable"))?;
        if current != transform {
            return Err(WireError::new(
                "stale",
                "Focused frame geometry changed during text state query",
            ));
        }
    }
    Ok(TextSnapshot {
        state,
        target: Some(FocusedTarget {
            session: session.to_owned(),
            frame: frame_id,
            backend,
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ids_preserve_frame_and_node_without_collisions() {
        let a = accessibility::scoped_id("frame\"a", "7");
        let b = accessibility::scoped_id("frame", "7");
        assert_ne!(a, b);
        assert_eq!(
            serde_json::from_str::<Vec<String>>(&a).unwrap(),
            ["frame\"a", "7"]
        );
    }
    #[test]
    fn attaches_only_to_the_real_owner() {
        let raw = json!({"nodeId":"1","backendDOMNodeId":7});
        let mut nodes = vec![
            accessibility::convert(&raw, "parent", None, false).unwrap(),
            accessibility::convert(&raw, "other", None, false).unwrap(),
        ];
        let child = accessibility::scoped_id("child", "1");
        attach(&mut nodes, "parent", 7, &child).unwrap();
        attach(&mut nodes, "parent", 7, &child).unwrap();
        assert_eq!(nodes[0].children, vec![child]);
        assert!(nodes[1].children.is_empty());
        assert!(attach(&mut nodes, "parent", 8, "missing").is_err());
    }
    #[test]
    fn affine_quad_maps_viewport_and_rejects_perspective() {
        let t = from_quad(
            &[10.0, 20.0, 10.0, 220.0, -90.0, 220.0, -90.0, 20.0],
            100.0,
            50.0,
        )
        .unwrap();
        assert_eq!(
            t.rect(
                Rect {
                    x: 10.0,
                    y: 5.0,
                    width: 20.0,
                    height: 10.0
                },
                1.0
            ),
            Rect {
                x: -20.0,
                y: 40.0,
                width: 20.0,
                height: 40.0
            }
        );
        let ancestor = from_quad(
            &[100.0, 50.0, 300.0, 50.0, 300.0, 150.0, 100.0, 150.0],
            100.0,
            50.0,
        )
        .unwrap();
        assert_eq!(
            ancestor.compose(t).rect(
                Rect {
                    x: 10.0,
                    y: 5.0,
                    width: 20.0,
                    height: 10.0
                },
                1.0
            ),
            Rect {
                x: 60.0,
                y: 130.0,
                width: 40.0,
                height: 80.0
            }
        );
        let combined = ancestor.compose(t);
        assert_eq!(combined.inverse_point(100.0, 130.0).unwrap(), (10.0, 5.0));
        assert!(
            from_quad(&[0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], 100.0, 100.0)
                .unwrap()
                .inverse_point(0.0, 0.0)
                .is_err()
        );
        assert!(
            from_quad(
                &[0.0, 0.0, 100.0, 0.0, 90.0, 100.0, 0.0, 100.0],
                100.0,
                100.0
            )
            .is_err()
        );
    }
}
