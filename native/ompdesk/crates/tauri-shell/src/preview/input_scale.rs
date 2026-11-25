use serde_json::Value;
use shell_core::wire::WireError;

/// Spatial fields of each `Input.*` command, in the CSS pixels its caller (Puppeteer, the phone, the agent) speaks.
///
/// A page framed by `Page::resize_framed` is emulated with a `scale`, and Chromium takes input in the scaled
/// widget space (pinned 157.0.8103.79): `InputHandler` turns CSS positions into widget positions with browser zoom
/// and page scale only, and Blink then divides every position, wheel delta, touch radius and gesture distance of the
/// event by `page scale * emulation scale` (`WebMouseEvent::PositionInRootFrame`, `WebMouseWheelEvent::DeltaXInRootFrame`,
/// `WebPointerEvent::WebPointerEventInRootFrame`, `WebGestureEvent` scroll deltas, `LocalFrameView::InputEventsScaleFactor`).
/// `Input.dispatchMouseEvent`'s `deltaX` and `deltaY` are not multiplied by zoom on the way in, so they are no
/// exception. The page then derives the DOM wheel delta by dividing by `devicePixelRatio`, which is what callers
/// already allow for. Everything below is therefore multiplied by the emulation scale, and nothing else.
const FLAT: &[(&str, &[&str])] = &[
    ("Input.dispatchMouseEvent", &["x", "y", "deltaX", "deltaY"]),
    ("Input.dispatchDragEvent", &["x", "y"]),
    ("Input.synthesizeTapGesture", &["x", "y"]),
    ("Input.synthesizePinchGesture", &["x", "y"]),
    (
        "Input.synthesizeScrollGesture",
        &[
            "x",
            "y",
            "xDistance",
            "yDistance",
            "xOverscroll",
            "yOverscroll",
        ],
    ),
];
const TOUCH_POINT: &[&str] = &["x", "y", "radiusX", "radiusY"];

/// Rewrites CSS-pixel input fields to the scaled widget space. `emulateTouchFromMouseEvent` already uses DIPs;
/// keys, text, IME and that DIP command pass through. Chromium validates non-numeric fields.
pub fn scale_input(method: &str, params: &mut Value, scale: f64) -> Result<(), WireError> {
    if !scale.is_finite() || scale <= 0.0 {
        return Err(WireError::new(
            "invalid",
            "the page's emulation scale must be a finite number above 0",
        ));
    }
    if scale == 1.0 {
        return Ok(());
    }
    if let Some((_, fields)) = FLAT.iter().find(|(name, _)| *name == method) {
        multiply(params, fields, scale)?;
    } else if method == "Input.dispatchTouchEvent"
        && let Some(points) = params.get_mut("touchPoints").and_then(Value::as_array_mut)
    {
        for point in points {
            multiply(point, TOUCH_POINT, scale)?;
        }
    }
    Ok(())
}

fn multiply(object: &mut Value, fields: &[&str], scale: f64) -> Result<(), WireError> {
    for field in fields {
        let Some(value) = object.get(*field).and_then(Value::as_f64) else {
            continue;
        };
        let scaled = value * scale;
        if !scaled.is_finite() {
            return Err(WireError::new(
                "invalid",
                format!("Input {field} is out of range"),
            ));
        }
        object[*field] = serde_json::json!(scaled);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scaled(method: &str, mut params: Value, scale: f64) -> Value {
        scale_input(method, &mut params, scale).unwrap();
        params
    }

    #[test]
    fn a_mouse_position_and_wheel_delta_are_taken_at_the_emulation_scale() {
        assert_eq!(
            scaled(
                "Input.dispatchMouseEvent",
                json!({"type":"mouseWheel","x":100.0,"y":58.0,"deltaX":0,"deltaY":240.0,"modifiers":0}),
                2.0
            ),
            json!({"type":"mouseWheel","x":200.0,"y":116.0,"deltaX":0.0,"deltaY":480.0,"modifiers":0})
        );
    }

    #[test]
    fn touch_points_scale_their_positions_and_radii_and_nothing_else() {
        assert_eq!(
            scaled(
                "Input.dispatchTouchEvent",
                json!({"type":"touchStart","touchPoints":[{"x":10.0,"y":20.0,"radiusX":3.0,"radiusY":4.0,"force":0.5,"id":7}]}),
                2.0
            ),
            json!({"type":"touchStart","touchPoints":[{"x":20.0,"y":40.0,"radiusX":6.0,"radiusY":8.0,"force":0.5,"id":7}]})
        );
    }

    #[test]
    fn gestures_scale_their_anchor_and_distances_but_not_their_speed_or_zoom() {
        assert_eq!(
            scaled(
                "Input.synthesizeScrollGesture",
                json!({"x":5.0,"y":6.0,"yDistance":-100.0,"yOverscroll":10.0,"speed":800}),
                3.0
            ),
            json!({"x":15.0,"y":18.0,"yDistance":-300.0,"yOverscroll":30.0,"speed":800})
        );
        assert_eq!(
            scaled(
                "Input.synthesizePinchGesture",
                json!({"x":5.0,"y":6.0,"scaleFactor":1.5}),
                2.0
            ),
            json!({"x":10.0,"y":12.0,"scaleFactor":1.5})
        );
        assert_eq!(
            scaled("Input.synthesizeTapGesture", json!({"x":1.0,"y":2.0}), 2.0),
            json!({"x":2.0,"y":4.0})
        );
        assert_eq!(
            scaled(
                "Input.dispatchDragEvent",
                json!({"type":"drop","x":1.0,"y":2.0}),
                2.0
            ),
            json!({"type":"drop","x":2.0,"y":4.0})
        );
    }

    #[test]
    fn a_scale_of_one_and_commands_without_space_pass_unchanged() {
        let mouse = json!({"type":"mousePressed","x":100.0,"y":58.0});
        assert_eq!(
            scaled("Input.dispatchMouseEvent", mouse.clone(), 1.0),
            mouse
        );
        let key = json!({"type":"keyDown","key":"a"});
        assert_eq!(scaled("Input.dispatchKeyEvent", key.clone(), 2.0), key);
        let dip = json!({"type":"mouseMoved","x":100,"y":58,"button":"none"});
        assert_eq!(
            scaled("Input.emulateTouchFromMouseEvent", dip.clone(), 2.0),
            dip
        );
        let other = json!({"x":1.0});
        assert_eq!(scaled("Runtime.evaluate", other.clone(), 2.0), other);
    }

    #[test]
    fn a_bad_scale_or_an_overflowing_position_is_refused() {
        let mut mouse = json!({"x":1.0,"y":2.0});
        for scale in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(scale_input("Input.dispatchMouseEvent", &mut mouse, scale).is_err());
        }
        let mut huge = json!({"x":1.7e308,"y":2.0});
        assert!(scale_input("Input.dispatchMouseEvent", &mut huge, 2.0).is_err());
        let mut text = json!({"x":"left","y":2.0});
        scale_input("Input.dispatchMouseEvent", &mut text, 2.0).unwrap();
        assert_eq!(text, json!({"x":"left","y":4.0}));
    }
}
