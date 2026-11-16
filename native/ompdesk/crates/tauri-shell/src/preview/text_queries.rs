use crate::preview_surface::{
    AxSnapshot, AxTarget, AxValue, Rect, TextQuery, TextRange, TextReply, TextUnit,
};
use serde_json::{Value, json};
use shell_core::wire::WireError;

use super::target::Target;

fn error(code: &str, message: &str) -> WireError {
    WireError::new(code, message)
}

fn validate_target<'a>(
    snapshot: &'a AxSnapshot,
    target: &AxTarget,
) -> Result<&'a crate::preview_surface::AxNode, WireError> {
    if snapshot.generation != snapshot.key.generation {
        return Err(error("stale", "Accessibility snapshot generation is stale"));
    }
    snapshot
        .nodes
        .iter()
        .find(|node| {
            node.node_id == target.node_id
                && node.frame_id == target.frame_id
                && node.backend_dom_node_id == Some(target.backend_dom_node_id)
        })
        .ok_or_else(|| {
            error(
                "invalid",
                "Accessibility target does not belong to snapshot",
            )
        })
}

fn number(value: &Value) -> Result<f64, WireError> {
    value
        .as_f64()
        .filter(|v| v.is_finite())
        .ok_or_else(|| error("cdp", "Invalid text geometry"))
}

fn scaled(value: &Value, zoom: f64) -> Result<f64, WireError> {
    let result = number(value)? * zoom;
    if result.is_finite() {
        Ok(result)
    } else {
        Err(error("cdp", "Invalid scaled text geometry"))
    }
}

fn offset(value: &Value) -> Result<u32, WireError> {
    value
        .as_u64()
        .and_then(|v| u32::try_from(v).ok())
        .ok_or_else(|| error("cdp", "Invalid text offset"))
}

fn contains_frame(tree: &Value, id: &str) -> bool {
    tree.pointer("/frame/id").and_then(Value::as_str) == Some(id)
        || tree
            .get("childFrames")
            .and_then(Value::as_array)
            .is_some_and(|children| children.iter().any(|child| contains_frame(child, id)))
}

fn range(value: &Value) -> Result<TextRange, WireError> {
    let start = offset(&value[0])?;
    let end = offset(&value[1])?;
    Ok(TextRange {
        start,
        length: end
            .checked_sub(start)
            .ok_or_else(|| error("cdp", "Invalid text range"))?,
    })
}

pub(super) async fn query(
    target: &Target<'_>,
    snapshot: &AxSnapshot,
    node: AxTarget,
    query: TextQuery,
    zoom: f64,
) -> Result<TextReply, WireError> {
    if !zoom.is_finite() || zoom <= 0.0 {
        return Err(error("invalid", "Invalid text zoom"));
    }
    let ax = validate_target(snapshot, &node)?;
    if ax.secure || matches!(ax.value, AxValue::Protected) {
        return Err(error("protected", "Protected text cannot be queried"));
    }
    let (request, child) = match query {
        TextQuery::RangeRects { range } => (
            json!({"op":"rects","start":range.start,"length":range.length}),
            None,
        ),
        TextQuery::OffsetAtPoint { x, y } => {
            if !x.is_finite()
                || !y.is_finite()
                || !(x / zoom).is_finite()
                || !(y / zoom).is_finite()
            {
                return Err(error("invalid", "Invalid text point"));
            }
            (json!({"op":"point","x":x / zoom,"y":y / zoom}), None)
        }
        TextQuery::VisibleRanges => (json!({"op":"visible"}), None),
        TextQuery::RangeFromChild { child } => {
            let child_ax = validate_target(snapshot, &child)?;
            if child_ax.secure || matches!(child_ax.value, AxValue::Protected) {
                return Err(error("protected", "Protected text cannot be queried"));
            }
            if child.frame_id != node.frame_id {
                return Err(error("invalid", "Text child belongs to another frame"));
            }
            (json!({"op":"child"}), Some(child))
        }
        TextQuery::UnitBoundaries { unit } => (
            json!({"op":"unit","unit":match unit {
                TextUnit::Character => "character", TextUnit::Word => "word", TextUnit::Line => "line",
                TextUnit::Paragraph => "paragraph", TextUnit::Page => "page", TextUnit::Format => "format", TextUnit::Document => "document",
            }}),
            None,
        ),
        TextQuery::ScrollIntoView {
            range,
            align_to_top,
        } => (
            json!({"op":"scroll","start":range.start,"length":range.length,"top":align_to_top}),
            None,
        ),
    };
    let frame_tree = target.command("Page.getFrameTree", json!({})).await?;
    let frame = node
        .frame_id
        .as_deref()
        .ok_or_else(|| error("invalid", "Accessibility target has no frame"))?;
    if !contains_frame(&frame_tree["frameTree"], frame) {
        return Err(error(
            "stale",
            "Accessibility target belongs to another frame",
        ));
    }
    let world = target
        .command(
            "Page.createIsolatedWorld",
            json!({"frameId":frame,"worldName":"ompdesk-native-text","grantUniveralAccess":false}),
        )
        .await?;
    let world = world
        .get("executionContextId")
        .and_then(Value::as_i64)
        .ok_or_else(|| error("cdp", "Actual Preview isolated world missing"))?;
    let resolved = target
        .command(
            "DOM.resolveNode",
            json!({"backendNodeId":node.backend_dom_node_id,"executionContextId":world}),
        )
        .await?;
    let object = resolved
        .pointer("/object/objectId")
        .and_then(Value::as_str)
        .ok_or_else(|| error("cdp", "Chromium could not resolve text target"))?;
    let mut child_object = None;
    let result = async {
        let mut args = vec![json!({"value":request})];
        if let Some(child) = child {
            let resolved_child = target.command("DOM.resolveNode", json!({"backendNodeId":child.backend_dom_node_id,"executionContextId":world})).await?;
            let id = resolved_child.pointer("/object/objectId").and_then(Value::as_str).ok_or_else(|| error("cdp", "Chromium could not resolve text child"))?.to_owned();
            args.push(json!({"objectId":id}));
            child_object = Some(id);
        }
        target.command("Runtime.callFunctionOn", json!({"objectId":object,"functionDeclaration":QUERY_JS,"arguments":args,"returnByValue":true})).await
    }.await;
    let child_release = if let Some(id) = child_object {
        target
            .command("Runtime.releaseObject", json!({"objectId":id}))
            .await
            .map(|_| ())
    } else {
        Ok(())
    };
    let root_release = target
        .command("Runtime.releaseObject", json!({"objectId":object}))
        .await;
    let result = result?;
    child_release?;
    root_release?;
    if result.get("exceptionDetails").is_some() {
        return Err(error("cdp", "Chromium text query failed"));
    }
    let value = result
        .pointer("/result/value")
        .ok_or_else(|| error("cdp", "Chromium returned no text query result"))?;
    if let Some(code) = value.get("error").and_then(Value::as_str) {
        return Err(error(code, "Chromium rejected text query"));
    }
    let data = &value["value"];
    match value["kind"].as_str() {
        Some("rects") => {
            let rects = data
                .as_array()
                .ok_or_else(|| error("cdp", "Invalid text rectangles"))?
                .iter()
                .map(|r| {
                    let width = scaled(&r[2], zoom)?;
                    let height = scaled(&r[3], zoom)?;
                    if width < 0.0 || height < 0.0 {
                        return Err(error("cdp", "Invalid text rectangle size"));
                    }
                    Ok(Rect {
                        x: scaled(&r[0], zoom)?,
                        y: scaled(&r[1], zoom)?,
                        width,
                        height,
                    })
                })
                .collect::<Result<Vec<_>, WireError>>()?;
            Ok(TextReply::Rects(rects))
        }
        Some("point") => Ok(TextReply::Offset(if data.is_null() {
            None
        } else {
            Some(offset(data)?)
        })),
        Some("visible") => Ok(TextReply::Ranges(
            data.as_array()
                .ok_or_else(|| error("cdp", "Invalid visible ranges"))?
                .iter()
                .map(range)
                .collect::<Result<Vec<_>, _>>()?,
        )),
        Some("child") => Ok(TextReply::Range(if data.is_null() {
            None
        } else {
            Some(range(data)?)
        })),
        Some("unit") => Ok(TextReply::Boundaries(
            data.as_array()
                .ok_or_else(|| error("cdp", "Invalid text boundaries"))?
                .iter()
                .map(offset)
                .collect::<Result<Vec<_>, _>>()?,
        )),
        Some("scroll") if data.as_bool() == Some(true) => Ok(TextReply::Scrolled),
        _ => Err(error("cdp", "Invalid text query result")),
    }
}

const QUERY_JS: &str = r#"function(q, child) {
    const root = this, doc = root.ownerDocument || (root.nodeType === 9 ? root : null);
    if (!doc || !root.isConnected || doc !== document) return {error:'stale'};
    const input = root instanceof HTMLInputElement || root instanceof HTMLTextAreaElement;
    if (root instanceof HTMLInputElement && root.type.toLowerCase() === 'password') return {error:'protected'};
    const secured = element => { const value=getComputedStyle(element).getPropertyValue('-webkit-text-security'); return value && value !== 'none'; };
    for (let element = root.nodeType === Node.ELEMENT_NODE ? root : root.parentElement; element; element = element.parentElement) {
        if (secured(element)) return {error:'protected'};
    }
    if (root.querySelectorAll && [...root.querySelectorAll('*')].some(secured)) return {error:'protected'};
    if (input && typeof root.selectionStart !== 'number') return {error:'unsupported'};
    if (child && (!child.isConnected || child.ownerDocument !== doc)) return {error:'stale'};
    let host = null, base = root, text;
    try {
        if (input) {
            const rect = root.getBoundingClientRect(), style = getComputedStyle(root);
            host = doc.createElement('div');
            const shadow = host.attachShadow({mode:'closed'}), mirror = doc.createElement('div');
            host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
            mirror.style.cssText = 'position:fixed;overflow:hidden;pointer-events:auto;opacity:0;margin:0;';
            for (const property of ['box-sizing','border-top-width','border-right-width','border-bottom-width','border-left-width','border-top-style','border-right-style','border-bottom-style','border-left-style','padding-top','padding-right','padding-bottom','padding-left','font','font-kerning','font-feature-settings','font-variation-settings','letter-spacing','word-spacing','line-height','text-align','text-indent','text-transform','direction','unicode-bidi','tab-size','word-break','overflow-wrap','white-space','writing-mode']) mirror.style.setProperty(property, style.getPropertyValue(property));
            mirror.style.boxSizing = 'border-box';
            mirror.style.left = rect.left + 'px'; mirror.style.top = rect.top + 'px';
            mirror.style.width = rect.width + 'px'; mirror.style.height = rect.height + 'px';
            mirror.style.whiteSpace = root instanceof HTMLTextAreaElement ? 'pre-wrap' : 'pre';
            mirror.style.overflowWrap = root instanceof HTMLTextAreaElement ? 'break-word' : 'normal';
            mirror.appendChild(doc.createTextNode(root.value)); shadow.appendChild(mirror);
            (doc.body || doc.documentElement).appendChild(host);
            mirror.scrollLeft = root.scrollLeft; mirror.scrollTop = root.scrollTop;
            base = mirror;
        }
        const nodes = [];
        if (base.nodeType === Node.TEXT_NODE) nodes.push(base);
        else { const walker = doc.createTreeWalker(base, NodeFilter.SHOW_TEXT); let n; while ((n = walker.nextNode())) nodes.push(n); }
        text = nodes.map(n => n.data).join('');
        const len = text.length;
        if (len > 4294967295) return {error:'invalid'};
        const position = (offset, end) => {
            let at = 0;
            for (const n of nodes) {
                const next = at + n.length;
                if (offset < next || (offset === next && (end || next === len))) return [n, offset - at];
                at = next;
            }
            return [base, 0];
        };
        const makeRange = (start, end) => {
            const r = doc.createRange();
            r.setStart(...position(start, false)); r.setEnd(...position(end, true));
            return r;
        };
        const toOffset = (n, off) => {
            if (n !== base && !base.contains(n)) return null;
            const r = doc.createRange(); r.selectNodeContents(base); r.setEnd(n, off);
            return r.toString().length;
        };
        const box = r => [r.x,r.y,r.width,r.height];
        const clipped = (rect, node) => {
            let left = Math.max(0, rect.left), top = Math.max(0, rect.top), right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
            let element = input ? root : (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
            for (let parent=element; parent; parent=parent.parentElement) {
                const style=getComputedStyle(parent), b=parent.getBoundingClientRect();
                if (parent === root && input || /(hidden|clip|auto|scroll)/.test(style.overflowX)) { left=Math.max(left,b.left); right=Math.min(right,b.right); }
                if (parent === root && input || /(hidden|clip|auto|scroll)/.test(style.overflowY)) { top=Math.max(top,b.top); bottom=Math.min(bottom,b.bottom); }
            }
            return right > left && bottom > top;
        };
        const graphemes = () => {
            if (!Intl.Segmenter) return null;
            return [...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text)].map(s => s.index).concat(len);
        };
        const boundaries = values => [...new Set([0, ...values, len])].sort((a,b) => a-b);
        const geometryUnits = () => {
            const points = graphemes(); if (!points) return null;
            const units = [];
            for (let i=0; i+1<points.length; i++) {
                const rects = [...makeRange(points[i],points[i+1]).getClientRects()];
                units.push({start:points[i], end:points[i+1], rect:rects.find(r => r.width || r.height) || null});
            }
            return units;
        };
        if (q.op === 'rects' || q.op === 'scroll') {
            if (!Number.isSafeInteger(q.start) || !Number.isSafeInteger(q.length) || q.start + q.length > len) return {error:'invalid'};
            const r = makeRange(q.start,q.start+q.length);
            if (q.op === 'rects') return {kind:'rects',value:[...r.getClientRects()].map(box)};
            if (input) {
                root.scrollIntoView({block:q.top?'start':'end',inline:'nearest',behavior:'instant'});
                const b = root.getBoundingClientRect();
                base.style.left = b.left + 'px'; base.style.top = b.top + 'px';
                const c = r.getBoundingClientRect();
                if (c.left < b.left) root.scrollLeft += c.left-b.left;
                else if (c.right > b.right) root.scrollLeft += c.right-b.right;
                if (c.top < b.top) root.scrollTop += c.top-b.top;
                else if (c.bottom > b.bottom) root.scrollTop += c.bottom-b.bottom;
            } else {
                let element = r.startContainer.nodeType === Node.ELEMENT_NODE ? r.startContainer : r.startContainer.parentElement;
                if (!element) return {error:'unsupported'};
                element.scrollIntoView({block:q.top?'start':'end',inline:'nearest',behavior:'instant'});
                for (let parent = element; parent; parent = parent.parentElement) {
                    const style = getComputedStyle(parent), b = parent.getBoundingClientRect(), c = r.getBoundingClientRect();
                    if (/(auto|scroll)/.test(style.overflowY)) parent.scrollTop += q.top ? c.top-b.top : c.bottom-b.bottom;
                    if (/(auto|scroll)/.test(style.overflowX)) {
                        if (c.left < b.left) parent.scrollLeft += c.left-b.left;
                        else if (c.right > b.right) parent.scrollLeft += c.right-b.right;
                    }
                }
                const c = r.getBoundingClientRect(); window.scrollBy({top:q.top?c.top:c.bottom-innerHeight,behavior:'instant'});
            }
            return {kind:'scroll',value:true};
        }
        if (q.op === 'point') {
            if (input) {
                const b=root.getBoundingClientRect();
                if (q.x < b.left || q.x > b.right || q.y < b.top || q.y > b.bottom) return {kind:'point',value:null};
            }
            let n, o;
            const p = doc.caretPositionFromPoint?.(q.x,q.y, input ? {shadowRoots:[base.getRootNode()]} : undefined);
            if (p) { n=p.offsetNode; o=p.offset; }
            else { const r=doc.caretRangeFromPoint?.(q.x,q.y); if (r) { n=r.startContainer; o=r.startOffset; } }
            let hit = n ? toOffset(n,o) : null;
            if (input && hit === null) {
                let distance=Infinity;
                for (const i of graphemes() || []) {
                    const r=makeRange(i,i).getBoundingClientRect();
                    if (!r.height && !r.width) continue;
                    const dx=Math.max(r.left-q.x,0,q.x-r.right), dy=Math.max(r.top-q.y,0,q.y-r.bottom);
                    const d=dx*dx+dy*dy;
                    if (d < distance) { distance=d; hit=i; }
                }
            }
            return {kind:'point',value:hit};
        }
        if (q.op === 'child') {
            if (input || !child || child === root || !root.contains(child)) return {kind:'child',value:null};
            const r=doc.createRange(); r.selectNode(child);
            const start=toOffset(r.startContainer,r.startOffset), end=toOffset(r.endContainer,r.endOffset);
            return {kind:'child',value:start === null || end === null ? null : [start,end]};
        }
        if (q.op === 'visible') {
            const units=geometryUnits(); if (!units) return {error:'unsupported'};
            const ranges=[];
            for (const u of units) if (u.rect && clipped(u.rect,position(u.start,false)[0])) {
                const last=ranges[ranges.length-1]; if (last && last[1] === u.start) last[1]=u.end; else ranges.push([u.start,u.end]);
            }
            return {kind:'visible',value:ranges};
        }
        if (q.op === 'unit') {
            let values = null;
            if ((q.unit === 'character' || q.unit === 'word') && Intl.Segmenter) {
                const granularity = q.unit === 'character' ? 'grapheme' : 'word';
                values = [...new Intl.Segmenter(undefined,{granularity}).segment(text)].map(s => s.index);
            }
            if (q.unit === 'line') {
                const units=geometryUnits();
                if (units) {
                    values=[]; let last=null;
                    const vertical = getComputedStyle(input ? root : (root.nodeType === Node.ELEMENT_NODE ? root : root.parentElement || doc.documentElement)).writingMode.startsWith('vertical');
                    for (const u of units) if (u.rect) {
                        if (last && (vertical ? u.rect.right <= last.left || u.rect.left >= last.right : u.rect.bottom <= last.top || u.rect.top >= last.bottom)) values.push(u.start);
                        last=u.rect;
                    }
                }
            }
            if (q.unit === 'paragraph' || values === null && (q.unit === 'character' || q.unit === 'word' || q.unit === 'line')) {
                values=[];
                for (let i=0; i<len; i++) if (text[i] === '\n') values.push(i+1);
                if (!input) {
                    let at=0, previous=null;
                    for (const n of nodes) {
                        let parent=n.parentElement;
                        while (parent && parent !== root && !/^(block|flow-root|list-item|table|table-row|table-cell|flex|grid)$/.test(getComputedStyle(parent).display)) parent=parent.parentElement;
                        if (previous && parent !== previous) values.push(at);
                        previous=parent; at+=n.length;
                    }
                }
                if (!input && root.nodeType !== Node.TEXT_NODE) {
                    const walker=doc.createTreeWalker(root,NodeFilter.SHOW_ELEMENT); let element;
                    while ((element=walker.nextNode())) if (element.tagName === 'BR') {
                        const r=doc.createRange(); r.selectNode(element);
                        const offset=toOffset(r.startContainer,r.startOffset);
                        if (offset !== null) values.push(offset);
                    }
                }
            }
            return {kind:'unit',value:boundaries(values || [])};
        }
        return {error:'invalid'};
    } finally { if (host) host.remove(); }
}"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_utf16_ranges_without_overflow_or_reversal() {
        let empty = range(&json!([0, 0])).unwrap();
        assert_eq!((empty.start, empty.length), (0, 0));
        let astral = range(&json!([1, 3])).unwrap();
        assert_eq!((astral.start, astral.length), (1, 2));
        assert!(range(&json!([3, 1])).is_err());
        assert!(range(&json!([0, 4294967296_u64])).is_err());
    }
}

#[cfg(test)]
mod geometry_tests {
    use super::*;

    #[test]
    fn rejects_overflowing_or_non_numeric_scaled_geometry() {
        assert_eq!(scaled(&json!(0), 2.0).unwrap(), 0.0);
        assert_eq!(scaled(&json!(-3), 2.0).unwrap(), -6.0);
        assert!(scaled(&json!(1.0e308), 2.0).is_err());
        assert!(scaled(&Value::Null, 1.0).is_err());
    }
}
