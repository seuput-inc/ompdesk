use super::target::Target;
use crate::preview_surface::{
    EditCommand, Input, KeyKind, MouseButton, MouseKind, Rect, SurfaceKey, TextContent,
    TextInputState, TextRange, TouchKind, WheelUnit,
};
use serde_json::{Value, json};
use shell_core::{hotkey::Mods, wire::WireError};

fn invalid(message: &str) -> WireError {
    WireError::new("invalid", message)
}
fn unsupported(message: &str) -> WireError {
    WireError::new("unsupported", message)
}
fn mods(m: Mods) -> u32 {
    u32::from(m.alt)
        | (u32::from(m.ctrl) << 1)
        | (u32::from(m.meta) << 2)
        | (u32::from(m.shift) << 3)
}
fn scale(value: f64, zoom: f64) -> Result<f64, WireError> {
    if !value.is_finite() || !zoom.is_finite() || zoom <= 0.0 {
        return Err(invalid("invalid Preview coordinate or zoom"));
    }
    let result = value / zoom;
    if !result.is_finite() {
        return Err(invalid("invalid Preview coordinate"));
    }
    Ok(result)
}
fn range_end(r: TextRange) -> Result<u32, WireError> {
    r.start
        .checked_add(r.length)
        .ok_or_else(|| invalid("text range overflow"))
}
async fn command(page: &Target<'_>, method: &str, params: Value) -> Result<Value, WireError> {
    page.command(method, params).await
}
async fn isolated(page: &Target<'_>, expression: &str, by_value: bool) -> Result<Value, WireError> {
    let context = page.isolated_world("ompdesk-native-input").await?;
    let result = command(
        page,
        "Runtime.evaluate",
        json!({"expression":expression,"contextId":context,"returnByValue":by_value}),
    )
    .await?;
    if result.get("exceptionDetails").is_some() {
        return Err(WireError::new("cdp", "Preview input query failed"));
    }
    Ok(result)
}
async fn focused_object(page: &Target<'_>) -> Result<String, WireError> {
    let object = isolated(page, "document.activeElement", false).await?;
    object
        .pointer("/result/objectId")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| WireError::new("gone", "focused Preview element is unavailable"))
}
async fn on_object(
    page: &Target<'_>,
    id: &str,
    function: &str,
    arguments: Value,
) -> Result<Value, WireError> {
    let value = command(page, "Runtime.callFunctionOn", json!({"objectId":id,"functionDeclaration":function,"arguments":arguments,"returnByValue":true})).await?;
    if value.get("exceptionDetails").is_some() {
        return Err(WireError::new("cdp", "Preview editable query failed"));
    }
    Ok(value)
}
async fn select_replacement(page: &Target<'_>, range: TextRange) -> Result<(), WireError> {
    let end = range_end(range)?;
    let id = focused_object(page).await?;
    let result = on_object(page, &id, r#"function(start,end){const e=this;if(!e.isConnected||e.ownerDocument.activeElement!==e)return 'gone';if(e.tagName==='IFRAME')return 'unsupported';if(e instanceof HTMLInputElement||e instanceof HTMLTextAreaElement){if(e.disabled||e.readOnly||typeof e.selectionStart!=='number'||end>e.value.length)return 'unsupported';e.setSelectionRange(start,end);return 'ok'}if(!e.isContentEditable)return 'unsupported';const w=e.ownerDocument.createTreeWalker(e,NodeFilter.SHOW_TEXT);let n,pos=0,a=null,b=null;while(n=w.nextNode()){let next=pos+n.data.length;if(a===null&&start<=next)a=[n,start-pos];if(end<=next){b=[n,end-pos];break}pos=next}if(!a||!b)return 'unsupported';const r=e.ownerDocument.createRange();r.setStart(...a);r.setEnd(...b);const s=e.ownerDocument.getSelection();s.removeAllRanges();s.addRange(r);return 'ok'}"#, json!([{"value":range.start},{"value":end}])).await;
    let _ = command(page, "Runtime.releaseObject", json!({"objectId":id})).await;
    match result?.pointer("/result/value").and_then(Value::as_str) {
        Some("ok") => Ok(()),
        Some("gone") => Err(WireError::new("gone", "focused Preview element changed")),
        _ => Err(unsupported(
            "replacement range is unavailable in the focused element",
        )),
    }
}

pub async fn apply(page: &Target<'_>, input: Input, zoom: f64) -> Result<(), WireError> {
    match input {
        Input::Mouse {
            kind,
            x,
            y,
            button,
            buttons,
            click_count,
            modifiers,
        } => {
            let kind = match kind {
                MouseKind::Move => "mouseMoved",
                MouseKind::Down => "mousePressed",
                MouseKind::Up => "mouseReleased",
                MouseKind::Enter | MouseKind::Leave => {
                    return Err(unsupported(
                        "CDP cannot dispatch native mouse enter or leave",
                    ));
                }
            };
            let button = match button {
                MouseButton::None => "none",
                MouseButton::Left => "left",
                MouseButton::Middle => "middle",
                MouseButton::Right => "right",
                MouseButton::Back => "back",
                MouseButton::Forward => "forward",
            };
            command(page, "Input.dispatchMouseEvent", json!({"type":kind,"x":scale(x,zoom)?,"y":scale(y,zoom)?,"button":button,"buttons":buttons,"clickCount":click_count,"modifiers":mods(modifiers)})).await?;
        }
        Input::Wheel {
            x,
            y,
            delta_x,
            delta_y,
            unit,
            modifiers,
        } => {
            let (dx, dy) = match unit {
                WheelUnit::Dip => (scale(delta_x, zoom)?, scale(delta_y, zoom)?),
                WheelUnit::Line | WheelUnit::Page => {
                    let expression = if unit == WheelUnit::Line {
                        "(()=>{const e=document.activeElement;if(!e)return null;const n=parseFloat(getComputedStyle(e).lineHeight);return Number.isFinite(n)?[n,n]:null})()"
                    } else {
                        "[innerWidth,innerHeight]"
                    };
                    let v = isolated(page, expression, true).await?;
                    let a = v
                        .pointer("/result/value")
                        .and_then(Value::as_array)
                        .ok_or_else(|| unsupported("actual wheel unit size is unavailable"))?;
                    let w = a
                        .first()
                        .and_then(Value::as_f64)
                        .ok_or_else(|| unsupported("actual wheel unit size is unavailable"))?;
                    let h = a
                        .get(1)
                        .and_then(Value::as_f64)
                        .ok_or_else(|| unsupported("actual wheel unit size is unavailable"))?;
                    (delta_x * w, delta_y * h)
                }
            };
            if !dx.is_finite() || !dy.is_finite() {
                return Err(invalid("invalid wheel delta"));
            }
            command(page,"Input.dispatchMouseEvent",json!({"type":"mouseWheel","x":scale(x,zoom)?,"y":scale(y,zoom)?,"deltaX":dx,"deltaY":dy,"modifiers":mods(modifiers)})).await?;
        }
        Input::Key {
            kind,
            key,
            code,
            windows_virtual_key_code,
            native_virtual_key_code,
            modifiers,
            text,
            repeat,
        } => {
            let mut p = json!({"type":if kind == KeyKind::Up {"keyUp"} else if text.is_some() {"keyDown"} else {"rawKeyDown"},"key":key,"code":code,"windowsVirtualKeyCode":windows_virtual_key_code,"nativeVirtualKeyCode":native_virtual_key_code,"modifiers":mods(modifiers),"autoRepeat":repeat});
            if kind == KeyKind::Down {
                if let Some(text) = text {
                    p["text"] = json!(text);
                }
            }
            command(page, "Input.dispatchKeyEvent", p).await?;
        }
        Input::Touch {
            kind,
            points,
            modifiers,
        } => {
            let kind = match kind {
                TouchKind::Start => "touchStart",
                TouchKind::Move => "touchMove",
                TouchKind::End => "touchEnd",
                TouchKind::Cancel => "touchCancel",
            };
            let points = points.into_iter().map(|p| Ok(json!({"id":p.id,"x":scale(p.x,zoom)?,"y":scale(p.y,zoom)?,"radiusX":scale(p.radius_x,zoom)?,"radiusY":scale(p.radius_y,zoom)?,"force":p.pressure}))).collect::<Result<Vec<_>,WireError>>()?;
            command(
                page,
                "Input.dispatchTouchEvent",
                json!({"type":kind,"touchPoints":points,"modifiers":mods(modifiers)}),
            )
            .await?;
        }
        Input::Ime {
            utf16text,
            selection_start,
            selection_end,
            replacement,
        } => {
            let text = String::from_utf16(&utf16text)
                .map_err(|_| invalid("IME text contains an unpaired UTF-16 surrogate"))?;
            if selection_start > selection_end || selection_end as usize > utf16text.len() {
                return Err(invalid("invalid IME selection"));
            }
            let mut p =
                json!({"text":text,"selectionStart":selection_start,"selectionEnd":selection_end});
            if let Some(r) = replacement {
                p["replacementStart"] = json!(r.start);
                p["replacementEnd"] = json!(range_end(r)?);
            }
            command(page, "Input.imeSetComposition", p).await?;
        }
        Input::CancelIme => {
            command(
                page,
                "Input.imeSetComposition",
                json!({"text":"","selectionStart":0,"selectionEnd":0}),
            )
            .await?;
        }
        Input::CommitText { text, replacement } => {
            if let Some(range) = replacement {
                select_replacement(page, range).await?;
            }
            command(page, "Input.insertText", json!({"text":text})).await?;
        }
        Input::Edit(edit) => {
            let (key, code, vk, shift) = match edit {
                EditCommand::Copy => ("c", "KeyC", 67, false),
                EditCommand::Cut => ("x", "KeyX", 88, false),
                EditCommand::Paste => ("v", "KeyV", 86, false),
                EditCommand::SelectAll => ("a", "KeyA", 65, false),
                EditCommand::Undo => ("z", "KeyZ", 90, false),
                EditCommand::Redo => ("z", "KeyZ", 90, true),
                EditCommand::DeleteBackward => ("Backspace", "Backspace", 8, false),
                EditCommand::DeleteForward => ("Delete", "Delete", 46, false),
            };
            let shortcut = !matches!(
                edit,
                EditCommand::DeleteBackward | EditCommand::DeleteForward
            );
            let m = if shortcut {
                if cfg!(target_os = "macos") { 4 } else { 2 }
            } else {
                0
            } | if shift { 8 } else { 0 };
            for kind in ["rawKeyDown", "keyUp"] {
                command(page,"Input.dispatchKeyEvent",json!({"type":kind,"key":key,"code":code,"windowsVirtualKeyCode":vk,"modifiers":m})).await?;
            }
        }
        Input::Focus(focused) => {
            command(
                page,
                "Emulation.setFocusEmulationEnabled",
                json!({"enabled":focused}),
            )
            .await?;
            if focused {
                command(page, "Page.bringToFront", json!({})).await?;
            }
        }
    }
    Ok(())
}

pub async fn text_state(
    page: &Target<'_>,
    key: SurfaceKey,
    zoom: f64,
    _marked: Option<TextRange>,
) -> Result<TextInputState, WireError> {
    scale(0.0, zoom)?;
    let id = focused_object(page).await?;
    let node = command(page, "DOM.describeNode", json!({"objectId":id})).await;
    let result = on_object(page, &id, r#"function(){const e=this;if(!e.isConnected||e.ownerDocument.activeElement!==e)return {gone:true};if(e.tagName==='IFRAME')return null;const input=e instanceof HTMLInputElement||e instanceof HTMLTextAreaElement;const editable=(input&&!e.disabled&&!e.readOnly)||e.isContentEditable;const secure=input&&e.type==='password';const text=input?e.value:(e.isContentEditable?e.textContent:'');let start=0,end=0,caret=null;if(input&&typeof e.selectionStart==='number'){start=e.selectionStart;end=e.selectionEnd;const s=getComputedStyle(e);if(!secure&&s.writingMode==='horizontal-tb'&&s.direction==='ltr'&&s.textAlign==='start'&&s.transform==='none'){const box=e.getBoundingClientRect(),m=document.createElement('div'),span=document.createElement('span');for(const p of ['font','fontKerning','letterSpacing','wordSpacing','lineHeight','textIndent','textTransform','whiteSpace','overflowWrap','wordBreak','tabSize','boxSizing','padding','border','width'])m.style[p]=s[p];Object.assign(m.style,{position:'fixed',visibility:'hidden',left:box.left+'px',top:box.top+'px',height:'auto',overflow:'hidden',whiteSpace:e.tagName==='INPUT'?'pre':'pre-wrap'});m.textContent=text.slice(0,end);span.textContent='\u200b';m.appendChild(span);document.documentElement.appendChild(m);const b=span.getBoundingClientRect();if(b.height>0)caret={x:b.x-e.scrollLeft,y:b.y-e.scrollTop,width:0,height:b.height};m.remove()}}else if(e.isContentEditable){const s=e.ownerDocument.getSelection();if(s&&s.rangeCount&&e.contains(s.anchorNode)&&e.contains(s.focusNode)){const r=s.getRangeAt(0),p=r.cloneRange();p.selectNodeContents(e);p.setEnd(r.startContainer,r.startOffset);start=p.toString().length;end=start+r.toString().length;const c=r.cloneRange();c.collapse(false);const b=c.getClientRects()[0];if(b&&b.height>0)caret={x:b.x,y:b.y,width:b.width,height:b.height}}}return {editable,secure,text:secure?null:text,length:text.length,start,end,caret,marked:globalThis.__ompdeskNativeComposition?.target===e?globalThis.__ompdeskNativeComposition.marked:null}}"#, json!([])).await;
    let _ = command(page, "Runtime.releaseObject", json!({"objectId":id})).await;
    let node = node?;
    let result = result?;
    let v = result
        .pointer("/result/value")
        .filter(|v| !v.is_null())
        .ok_or_else(|| unsupported("focused frame or editable state is unavailable"))?;
    if v.get("gone").and_then(Value::as_bool) == Some(true) {
        return Err(WireError::new("gone", "focused Preview element changed"));
    }
    let number = |name: &str| -> Result<u32, WireError> {
        v.get(name)
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok())
            .ok_or_else(|| WireError::new("cdp", "invalid text state"))
    };
    let start = number("start")?;
    let end = number("end")?;
    let content = if v.get("secure").and_then(Value::as_bool) == Some(true) {
        TextContent::Protected {
            utf16_length: number("length")?,
        }
    } else {
        TextContent::Plain(
            v.get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| WireError::new("cdp", "invalid text state"))?
                .to_owned(),
        )
    };
    let caret = v.get("caret").and_then(Value::as_object).and_then(|c| {
        Some(Rect {
            x: c.get("x")?.as_f64()? * zoom,
            y: c.get("y")?.as_f64()? * zoom,
            width: c.get("width")?.as_f64()? * zoom,
            height: c.get("height")?.as_f64()? * zoom,
        })
    });
    let marked = match v.get("marked").filter(|value| !value.is_null()) {
        None => None,
        Some(value) => {
            let start = value["start"]
                .as_u64()
                .and_then(|n| u32::try_from(n).ok())
                .ok_or_else(|| invalid("invalid composition start"))?;
            let length = value["length"]
                .as_u64()
                .and_then(|n| u32::try_from(n).ok())
                .ok_or_else(|| invalid("invalid composition length"))?;
            let range = TextRange { start, length };
            if range_end(range)? > number("length")? {
                return Err(invalid("composition exceeds actual text"));
            }
            Some(range)
        }
    };
    let backend_dom_node_id = node.pointer("/node/backendNodeId").and_then(Value::as_i64);
    Ok(TextInputState {
        key,
        generation: key.generation,
        backend_dom_node_id,
        editable: v.get("editable").and_then(Value::as_bool).unwrap_or(false),
        content,
        selection: TextRange {
            start,
            length: end
                .checked_sub(start)
                .ok_or_else(|| WireError::new("cdp", "invalid text selection"))?,
        },
        marked,
        caret,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn modifiers_match_cdp() {
        assert_eq!(
            mods(Mods {
                alt: true,
                ctrl: true,
                meta: false,
                shift: true
            }),
            11
        );
    }
    #[test]
    fn coordinates_and_ranges_preserve_units() {
        assert_eq!(scale(24.0, 2.0).unwrap(), 12.0);
        assert!(scale(1.0, 0.0).is_err());
        assert_eq!(
            range_end(TextRange {
                start: 1,
                length: 2
            })
            .unwrap(),
            3
        );
        assert!(
            range_end(TextRange {
                start: u32::MAX,
                length: 1
            })
            .is_err()
        );
        assert_eq!("😀".encode_utf16().count(), 2);
    }
}
