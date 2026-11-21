//! Geometry for `win.create`. Display facts and the window builder use logical pixels.
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Debug, PartialEq)]
pub struct Bounds {
    pub position: Option<(f64, f64)>,
    pub width: f64,
    pub height: f64,
}

pub fn for_create(options: &Value, (displays, primary_id): &(Vec<Value>, i64)) -> Bounds {
    let mut bounds = Bounds {
        position: options["x"].as_f64().zip(options["y"].as_f64()),
        width: options["width"].as_f64().unwrap_or(1200.0),
        height: options["height"].as_f64().unwrap_or(800.0),
    };
    let Some((x, y)) = bounds.position else {
        return bounds;
    };
    if options["restoreBounds"] != true {
        return bounds;
    }

    let mut fallback = None;
    for display in displays {
        let Ok(area) = Rect::deserialize(&display["workArea"]) else {
            continue;
        };
        let grab_width = (x + bounds.width).min(area.x + area.width) - x.max(area.x);
        let grab_height = (y + 28.0).min(area.y + area.height) - y.max(area.y);
        if grab_width >= 60.0 && grab_height > 0.0 {
            return bounds;
        }
        if fallback.is_none() || display["id"].as_i64() == Some(*primary_id) {
            fallback = Some(area);
        }
    }
    if let Some(area) = fallback {
        bounds.width = bounds.width.min((area.width - 40.0).max(1.0));
        bounds.height = bounds.height.min((area.height - 40.0).max(1.0));
        bounds.position = Some((
            center(area.x, area.width, bounds.width),
            center(area.y, area.height, bounds.height),
        ));
    }
    bounds
}

fn center(origin: f64, available: f64, size: f64) -> f64 {
    // Math.round breaks halfway ties toward +infinity, also on screens left of the primary.
    let position = origin + (available - size) / 2.0;
    let floor = position.floor();
    if position - floor < 0.5 {
        floor
    } else {
        floor + 1.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn displays() -> (Vec<Value>, i64) {
        (
            vec![
                json!({"id": 1, "workArea": {"x": 0, "y": 0, "width": 1440, "height": 900}}),
                json!({"id": 2, "workArea": {"x": -601, "y": -401, "width": 600, "height": 400}}),
            ],
            2,
        )
    }

    #[test]
    fn restore_only_adjusts_a_positioned_saved_window() {
        let mut opts = json!({"x":2000,"y":0,"width":321,"height":321});
        assert_eq!(for_create(&opts, &displays()).position, Some((2000.0, 0.0)));
        opts["restoreBounds"] = json!(true);
        assert_eq!(
            for_create(&opts, &(vec![], 0)).position,
            Some((2000.0, 0.0))
        );
        assert_eq!(
            for_create(&opts, &displays()).position,
            Some((-461.0, -361.0))
        );
        opts.as_object_mut().unwrap().remove("y");
        assert_eq!(
            for_create(&opts, &displays()),
            Bounds {
                position: None,
                width: 321.0,
                height: 321.0
            }
        );
    }

    #[test]
    fn one_visible_row_and_sixty_title_pixels_on_a_nonprimary_display_keep_the_saved_size() {
        let mut opts = json!({"restoreBounds":true,"x":1380,"y":-27,"width":2000,"height":1200});
        assert_eq!(
            for_create(&opts, &displays()),
            Bounds {
                position: Some((1380.0, -27.0)),
                width: 2000.0,
                height: 1200.0
            }
        );
        opts["x"] = json!(1381);
        let fitted = Bounds {
            position: Some((-581.0, -381.0)),
            width: 560.0,
            height: 360.0,
        };
        assert_eq!(for_create(&opts, &displays()), fitted);
        opts["x"] = json!(1380);
        opts["y"] = json!(-28);
        assert_eq!(for_create(&opts, &displays()), fitted);
    }
}
