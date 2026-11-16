use super::target::Target;
use crate::preview_surface::{
    AxAction, AxActionKind, AxNode, AxSnapshot, AxTarget, AxValue, Checked, Rect, SurfaceKey,
    TextRange,
};
use serde_json::{Value, json};
use shell_core::wire::WireError;
use std::collections::HashMap;

fn error(code: &str, message: &str) -> WireError {
    WireError::new(code, message)
}

fn property<'a>(node: &'a Value, name: &str) -> Option<&'a Value> {
    node.get("properties")?
        .as_array()?
        .iter()
        .find(|p| p.get("name").and_then(Value::as_str) == Some(name))?
        .pointer("/value/value")
}

fn flag(node: &Value, name: &str) -> bool {
    property(node, name)
        .and_then(Value::as_bool)
        .unwrap_or(false)
}
fn text(node: &Value, field: &str) -> Option<String> {
    node.get(field)?.get("value")?.as_str().map(str::to_owned)
}

pub(super) fn scoped_id(frame: &str, node: &str) -> String {
    json!([frame, node]).to_string()
}

pub(super) fn convert(
    node: &Value,
    frame: &str,
    bounds: Option<Rect>,
    password: bool,
) -> Result<AxNode, WireError> {
    let raw_id = node
        .get("nodeId")
        .and_then(Value::as_str)
        .ok_or_else(|| error("cdp", "AX node has no nodeId"))?;
    let node_id = scoped_id(frame, raw_id);
    let role = text(node, "role").unwrap_or_default();
    let secure = password
        || flag(node, "protected")
        || role == "password"
        || node.pointer("/value/type").and_then(Value::as_str) == Some("protected");
    let value = if secure {
        AxValue::Protected
    } else {
        match node.pointer("/value/value") {
            Some(Value::String(s)) => AxValue::Text(s.clone()),
            Some(Value::Number(n)) => n.as_f64().map(AxValue::Number).unwrap_or(AxValue::None),
            Some(Value::Bool(b)) => AxValue::Boolean(*b),
            _ => AxValue::None,
        }
    };
    let checked = match property(node, "checked").and_then(Value::as_str) {
        Some("true") => Some(Checked::On),
        Some("false") => Some(Checked::Off),
        Some("mixed") => Some(Checked::Mixed),
        _ => None,
    }
    .or_else(|| {
        property(node, "checked")
            .and_then(Value::as_bool)
            .map(|v| if v { Checked::On } else { Checked::Off })
    });
    Ok(AxNode {
        node_id,
        frame_id: Some(frame.to_owned()),
        backend_dom_node_id: node.get("backendDOMNodeId").and_then(Value::as_i64),
        role,
        name: text(node, "name"),
        description: text(node, "description"),
        value,
        children: node
            .get("childIds")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(|id| scoped_id(frame, id))
                    .collect()
            })
            .unwrap_or_default(),
        bounds,
        disabled: flag(node, "disabled"),
        focused: flag(node, "focused"),
        focusable: flag(node, "focusable"),
        editable: property(node, "editable")
            .and_then(Value::as_str)
            .is_some_and(|v| v != "false"),
        read_only: flag(node, "readonly"),
        secure,
        multiline: flag(node, "multiline"),
        required: flag(node, "required"),
        selected: flag(node, "selected"),
        expanded: property(node, "expanded").and_then(Value::as_bool),
        checked,
        selected_text_range: None,
        actions: Vec::new(),
    })
}

fn bounds(snapshot: &Value, frame: &str, zoom: f64) -> Result<HashMap<i64, Rect>, WireError> {
    let strings = snapshot
        .get("strings")
        .and_then(Value::as_array)
        .ok_or_else(|| error("cdp", "DOM snapshot has no strings"))?;
    let documents = snapshot
        .get("documents")
        .and_then(Value::as_array)
        .ok_or_else(|| error("cdp", "DOM snapshot has no documents"))?;
    let document = documents
        .iter()
        .find(|d| {
            d.get("frameId")
                .and_then(Value::as_u64)
                .and_then(|i| strings.get(i as usize))
                .and_then(Value::as_str)
                == Some(frame)
        })
        .ok_or_else(|| error("cdp", "DOM snapshot has no main frame"))?;
    let x = document
        .get("scrollOffsetX")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let y = document
        .get("scrollOffsetY")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let ids = document
        .pointer("/nodes/backendNodeId")
        .and_then(Value::as_array)
        .ok_or_else(|| error("cdp", "DOM snapshot has no node IDs"))?;
    let indices = document
        .pointer("/layout/nodeIndex")
        .and_then(Value::as_array)
        .ok_or_else(|| error("cdp", "DOM snapshot has no layout indices"))?;
    let boxes = document
        .pointer("/layout/bounds")
        .and_then(Value::as_array)
        .ok_or_else(|| error("cdp", "DOM snapshot has no layout bounds"))?;
    if indices.len() != boxes.len() {
        return Err(error("cdp", "DOM snapshot layout is inconsistent"));
    }
    let mut result = HashMap::new();
    for (index, rect) in indices.iter().zip(boxes) {
        let id = index
            .as_u64()
            .and_then(|i| ids.get(i as usize))
            .and_then(Value::as_i64)
            .ok_or_else(|| error("cdp", "DOM snapshot layout node is invalid"))?;
        let rect = rect
            .as_array()
            .filter(|r| r.len() == 4)
            .ok_or_else(|| error("cdp", "DOM snapshot bounds are invalid"))?;
        let number = |i: usize| {
            rect[i]
                .as_f64()
                .ok_or_else(|| error("cdp", "DOM snapshot bounds are invalid"))
        };
        result.insert(
            id,
            Rect {
                x: (number(0)? - x) * zoom,
                y: (number(1)? - y) * zoom,
                width: number(2)? * zoom,
                height: number(3)? * zoom,
            },
        );
    }
    Ok(result)
}

pub async fn snapshot(
    target: &Target<'_>,
    key: SurfaceKey,
    zoom: f64,
) -> Result<AxSnapshot, WireError> {
    let frame_tree = target.command("Page.getFrameTree", json!({})).await?;
    let frame = frame_tree
        .pointer("/frameTree/frame/id")
        .and_then(Value::as_str)
        .ok_or_else(|| error("cdp", "Chromium returned no main frame"))?;
    snapshot_frame(target, frame, key, zoom).await
}

pub(super) async fn snapshot_frame(
    target: &Target<'_>,
    frame: &str,
    key: SurfaceKey,
    zoom: f64,
) -> Result<AxSnapshot, WireError> {
    if !zoom.is_finite() || zoom <= 0.0 {
        return Err(error("invalid", "Invalid accessibility zoom"));
    }
    target.command("Accessibility.enable", json!({})).await?;
    let tree = target
        .command("Accessibility.getFullAXTree", json!({"frameId":frame}))
        .await?;
    let raw = tree
        .get("nodes")
        .and_then(Value::as_array)
        .ok_or_else(|| error("cdp", "Chromium returned no AX nodes"))?;
    let layout = target
        .command(
            "DOMSnapshot.captureSnapshot",
            json!({"computedStyles":[],"includeDOMRects":true}),
        )
        .await?;
    let bounds = bounds(&layout, frame, zoom)?;
    let mut nodes = Vec::with_capacity(raw.len());
    for node in raw {
        if node
            .get("frameId")
            .and_then(Value::as_str)
            .is_some_and(|id| id != frame)
        {
            return Err(error("cdp", "AX node belongs to a different frame"));
        }
        let id = node.get("backendDOMNodeId").and_then(Value::as_i64);
        let described = if let Some(id) = id {
            Some(
                target
                    .command("DOM.describeNode", json!({"backendNodeId":id}))
                    .await?,
            )
        } else {
            None
        };
        let dom = described.as_ref().map(|d| &d["node"]);
        let tag = dom
            .and_then(|d| d.get("nodeName"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let attrs = dom
            .and_then(|d| d.get("attributes"))
            .and_then(Value::as_array);
        let attr = |name: &str| {
            attrs
                .and_then(|a| {
                    a.chunks_exact(2)
                        .find(|p| p[0].as_str().is_some_and(|s| s.eq_ignore_ascii_case(name)))
                })
                .and_then(|p| p[1].as_str())
        };
        let input = tag.eq_ignore_ascii_case("input");
        let input_type = attr("type").unwrap_or("text").to_ascii_lowercase();
        let password = input && input_type == "password";
        let rect = id.and_then(|id| bounds.get(&id).copied());
        let mut converted = convert(node, frame, rect, password)?;
        if id.is_some() && !converted.disabled {
            if converted.focusable {
                converted.actions.push(AxActionKind::Focus);
            }
            if converted.focusable
                && (matches!(
                    tag.to_ascii_lowercase().as_str(),
                    "button" | "a" | "summary"
                ) || input
                    && matches!(
                        input_type.as_str(),
                        "button" | "submit" | "reset" | "checkbox" | "radio"
                    ))
            {
                converted.actions.push(AxActionKind::Default);
            }
            let text_input = (input
                && matches!(
                    input_type.as_str(),
                    "text" | "search" | "tel" | "url" | "password"
                ))
                || tag.eq_ignore_ascii_case("textarea");
            if !converted.read_only && (text_input || converted.editable && !input) {
                converted.actions.push(AxActionKind::SetValue);
                converted.actions.push(AxActionKind::SetSelection);
            }
            if input && !converted.read_only && matches!(input_type.as_str(), "number" | "range") {
                converted.actions.push(AxActionKind::Increment);
                converted.actions.push(AxActionKind::Decrement);
            }
        }
        if converted.focused && converted.editable {
            if let Some(id) = id {
                converted.selected_text_range = selection(target, frame, id).await?;
            }
        }
        nodes.push(converted);
    }
    let root_id = raw
        .first()
        .and_then(|n| n.get("nodeId"))
        .and_then(Value::as_str)
        .map(|id| scoped_id(frame, id));
    Ok(AxSnapshot {
        key,
        generation: key.generation,
        root_id,
        nodes,
    })
}

async fn selection(
    page: &Target<'_>,
    frame: &str,
    id: i64,
) -> Result<Option<TextRange>, WireError> {
    let context = isolated_world(page, frame).await?;
    let resolved = page
        .command(
            "DOM.resolveNode",
            json!({"backendNodeId":id,"executionContextId":context}),
        )
        .await?;
    let object = resolved
        .pointer("/object/objectId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            error(
                "cdp",
                "Chromium could not resolve focused accessibility node",
            )
        })?;
    let response = page.command("Runtime.callFunctionOn", json!({"objectId":object,"returnByValue":true,"functionDeclaration":"function(){if(document.activeElement!==this)return null;if(typeof this.selectionStart==='number'&&typeof this.selectionEnd==='number')return [this.selectionStart,this.selectionEnd];if(!this.isContentEditable)return null;let s=this.ownerDocument.getSelection();if(!s||!s.rangeCount||!this.contains(s.anchorNode)||!this.contains(s.focusNode))return null;let r=s.getRangeAt(0),a=r.cloneRange(),b=r.cloneRange();a.selectNodeContents(this);a.setEnd(r.startContainer,r.startOffset);b.selectNodeContents(this);b.setEnd(r.endContainer,r.endOffset);return [a.toString().length,b.toString().length]}"})).await;
    let _ = page
        .command("Runtime.releaseObject", json!({"objectId":object}))
        .await;
    let response = response?;
    if response.get("exceptionDetails").is_some() {
        return Err(error("cdp", "Could not read accessibility selection"));
    }
    let Some(values) = response.pointer("/result/value").and_then(Value::as_array) else {
        return Ok(None);
    };
    let start = values
        .first()
        .and_then(Value::as_u64)
        .and_then(|v| u32::try_from(v).ok());
    let end = values
        .get(1)
        .and_then(Value::as_u64)
        .and_then(|v| u32::try_from(v).ok());
    Ok(start.zip(end).and_then(|(start, end)| {
        end.checked_sub(start)
            .map(|length| TextRange { start, length })
    }))
}

async fn isolated_world(target: &Target<'_>, frame: &str) -> Result<i64, WireError> {
    let world = target.command("Page.createIsolatedWorld", json!({"frameId":frame,"worldName":"ompdesk-accessibility","grantUniveralAccess":false})).await?;
    world
        .get("executionContextId")
        .and_then(Value::as_i64)
        .ok_or_else(|| error("cdp", "Chromium returned no isolated world"))
}

fn validate_target(snapshot: &AxSnapshot, target: &AxTarget) -> Result<(), WireError> {
    if snapshot.generation != snapshot.key.generation {
        return Err(error("stale", "Accessibility snapshot generation is stale"));
    }
    if !snapshot.nodes.iter().any(|n| {
        n.node_id == target.node_id
            && n.frame_id == target.frame_id
            && n.backend_dom_node_id == Some(target.backend_dom_node_id)
    }) {
        return Err(error(
            "invalid",
            "Accessibility target does not belong to snapshot",
        ));
    }
    Ok(())
}

pub async fn action(
    page: &Target<'_>,
    snapshot: &AxSnapshot,
    target: AxTarget,
    action: AxAction,
) -> Result<(), WireError> {
    validate_target(snapshot, &target)?;
    if matches!(action, AxAction::ShowMenu) {
        return Err(error(
            "unsupported",
            "Chromium exposes no accessibility show-menu primitive",
        ));
    }
    let kind = match &action {
        AxAction::Default => AxActionKind::Default,
        AxAction::Focus => AxActionKind::Focus,
        AxAction::SetValue(_) => AxActionKind::SetValue,
        AxAction::SetSelection(_) => AxActionKind::SetSelection,
        AxAction::Increment => AxActionKind::Increment,
        AxAction::Decrement => AxActionKind::Decrement,
        AxAction::ShowMenu => AxActionKind::ShowMenu,
    };
    let node = snapshot
        .nodes
        .iter()
        .find(|n| {
            n.node_id == target.node_id
                && n.frame_id == target.frame_id
                && n.backend_dom_node_id == Some(target.backend_dom_node_id)
        })
        .ok_or_else(|| {
            error(
                "invalid",
                "Accessibility target does not belong to snapshot",
            )
        })?;
    if !node.actions.contains(&kind) {
        return Err(error(
            "unsupported",
            "Accessibility action is not available for this target",
        ));
    }
    if matches!(action, AxAction::Focus) {
        page.command(
            "DOM.focus",
            json!({"backendNodeId":target.backend_dom_node_id}),
        )
        .await?;
        return Ok(());
    }
    if matches!(action, AxAction::Default) {
        page.command(
            "DOM.focus",
            json!({"backendNodeId":target.backend_dom_node_id}),
        )
        .await?;
        let (key, code, number) = if matches!(node.role.as_str(), "checkbox" | "radio" | "switch") {
            (" ", "Space", 32)
        } else {
            ("Enter", "Enter", 13)
        };
        for kind in ["rawKeyDown", "keyUp"] {
            page.command("Input.dispatchKeyEvent", json!({"type":kind,"key":key,"code":code,"windowsVirtualKeyCode":number,"nativeVirtualKeyCode":number})).await?;
        }
        return Ok(());
    }
    if matches!(
        &action,
        AxAction::SetValue(_) | AxAction::Increment | AxAction::Decrement
    ) {
        page.command(
            "DOM.focus",
            json!({"backendNodeId":target.backend_dom_node_id}),
        )
        .await?;
    }
    let frame = target
        .frame_id
        .as_deref()
        .ok_or_else(|| error("invalid", "Accessibility target has no frame"))?;
    let context = isolated_world(page, frame).await?;
    let resolved = page
        .command(
            "DOM.resolveNode",
            json!({"backendNodeId":target.backend_dom_node_id,"executionContextId":context}),
        )
        .await?;
    let object = resolved
        .pointer("/object/objectId")
        .and_then(Value::as_str)
        .ok_or_else(|| error("cdp", "Chromium could not resolve accessibility target"))?;
    let (function, args) = match &action {
        AxAction::Default => unreachable!(),
        AxAction::SetValue(_) => (
            "function(){if(this.ownerDocument.activeElement!==this)return false;if((this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement)&&!this.readOnly&&!this.disabled&&typeof this.selectionStart==='number'){this.setSelectionRange(0,this.value.length);return true}if(!this.isContentEditable)return false;let r=this.ownerDocument.createRange();r.selectNodeContents(this);let s=this.ownerDocument.getSelection();s.removeAllRanges();s.addRange(r);return true}",
            vec![],
        ),
        AxAction::SetSelection(range) => (
            "function(s,l){let e=s+l;if(typeof this.setSelectionRange==='function'){this.setSelectionRange(s,e);return true} if(!this.isContentEditable)return false;let w=document.createTreeWalker(this,NodeFilter.SHOW_TEXT),n,start=null,end=null,pos=0;while(n=w.nextNode()){let next=pos+n.length;if(start===null&&s<=next)start=[n,s-pos];if(e<=next){end=[n,e-pos];break}pos=next}if(!start||!end)return false;let r=document.createRange();r.setStart(...start);r.setEnd(...end);let sel=this.ownerDocument.getSelection();sel.removeAllRanges();sel.addRange(r);return true}",
            vec![json!({"value":range.start}), json!({"value":range.length})],
        ),
        AxAction::Increment | AxAction::Decrement => (
            "function(){return this.ownerDocument.activeElement===this && this instanceof HTMLInputElement && (this.type==='number'||this.type==='range') && !this.disabled && !this.readOnly}",
            vec![],
        ),
        AxAction::Focus | AxAction::ShowMenu => unreachable!(),
    };
    let response = page.command("Runtime.callFunctionOn", json!({"objectId":object,"functionDeclaration":function,"arguments":args,"returnByValue":true,"userGesture":true})).await;
    let _ = page
        .command("Runtime.releaseObject", json!({"objectId":object}))
        .await;
    let response = response?;
    if response.get("exceptionDetails").is_some() {
        return Err(error(
            "unsupported",
            "Accessibility action failed on this element",
        ));
    }
    if response.pointer("/result/value").and_then(Value::as_bool) != Some(true) {
        return Err(error(
            "unsupported",
            "Accessibility action is not supported by this element",
        ));
    }
    match action {
        AxAction::SetValue(value) if value.is_empty() => {
            for kind in ["rawKeyDown", "keyUp"] {
                page.command("Input.dispatchKeyEvent", json!({"type":kind,"key":"Backspace","code":"Backspace","windowsVirtualKeyCode":8,"nativeVirtualKeyCode":8})).await?;
            }
        }
        AxAction::SetValue(value) => {
            page.command("Input.insertText", json!({"text":value}))
                .await?;
        }
        AxAction::Increment | AxAction::Decrement => {
            let up = matches!(action, AxAction::Increment);
            let (key, code) = if up {
                ("ArrowUp", 38)
            } else {
                ("ArrowDown", 40)
            };
            for kind in ["rawKeyDown", "keyUp"] {
                page.command("Input.dispatchKeyEvent", json!({"type":kind,"key":key,"code":key,"windowsVirtualKeyCode":code,"nativeVirtualKeyCode":code})).await?;
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn converts_real_tree_and_redacts_protected_value() {
        let raw = json!({"nodeId":"42","frameId":"frame","backendDOMNodeId":7,"role":{"value":"textField"},"value":{"value":"secret"},"childIds":["43"],"properties":[{"name":"protected","value":{"value":true}}]});
        let node = convert(&raw, "frame", None, false).unwrap();
        assert_eq!(node.node_id, scoped_id("frame", "42"));
        assert_eq!(node.children, vec![scoped_id("frame", "43")]);
        assert_eq!(node.backend_dom_node_id, Some(7));
        assert_eq!(node.value, AxValue::Protected);
        let key = SurfaceKey {
            view: 1,
            wc: 2,
            generation: 3,
        };
        let snapshot = AxSnapshot {
            key,
            generation: 3,
            root_id: Some(scoped_id("frame", "42")),
            nodes: vec![node],
        };
        assert!(
            validate_target(
                &snapshot,
                &AxTarget {
                    node_id: scoped_id("frame", "42"),
                    frame_id: Some("frame".into()),
                    backend_dom_node_id: 8
                }
            )
            .is_err()
        );
        assert!(
            validate_target(
                &snapshot,
                &AxTarget {
                    node_id: scoped_id("frame", "42"),
                    frame_id: Some("frame".into()),
                    backend_dom_node_id: 7
                }
            )
            .is_ok()
        );
    }
}
