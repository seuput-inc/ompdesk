use super::{Entry, Pages, ViewLayout, native, runtime, surface};
use crate::registry::{Kind, PageState};
use serde_json::{Value, json};
use shell_core::wire::WireError;
use shell_preview::Viewport;
use std::sync::Arc;

fn current(wc: u64) -> Result<(native::SurfaceKey, Option<u64>, f64), WireError> {
    let registry = runtime().registry.lock().expect("registry");
    let page = registry
        .page(wc)
        .filter(|page| page.state == PageState::Live)
        .ok_or_else(|| WireError::new("gone", "Preview view ended"))?;
    let Kind::PreviewView { view, parent } = page.kind else {
        return Err(WireError::new("invalid", "page is not a Preview view"));
    };
    Ok((
        native::SurfaceKey {
            view,
            wc,
            generation: page.identity.generation,
        },
        parent,
        page.zoom,
    ))
}

fn check(key: native::SurfaceKey) -> Result<(), WireError> {
    if current(key.wc)?.0 == key {
        Ok(())
    } else {
        Err(WireError::new("gone", "Preview document changed"))
    }
}

fn parse_bounds(value: &Value) -> Result<native::Rect, WireError> {
    let number = |name: &str| {
        value[name]
            .as_f64()
            .filter(|n| n.is_finite())
            .ok_or_else(|| WireError::new("invalid", format!("invalid Preview bounds {name}")))
    };
    let width = number("width")?;
    let height = number("height")?;
    if width < 0.0 || height < 0.0 {
        return Err(WireError::new("invalid", "Preview bounds are out of range"));
    }
    let rect = native::Rect {
        x: number("x")?.round(),
        y: number("y")?.round(),
        width: width.round(),
        height: height.round(),
    };
    if [rect.x, rect.y, rect.width, rect.height]
        .iter()
        .any(|n| *n < i32::MIN as f64 || *n > i32::MAX as f64)
    {
        return Err(WireError::new("invalid", "Preview bounds are out of range"));
    }
    Ok(rect)
}

fn usable(rect: native::Rect) -> bool {
    rect.width > 0.0 && rect.height > 0.0
}

async fn resize(
    entry: &Entry,
    key: native::SurfaceKey,
    rect: native::Rect,
    win: Option<u64>,
    zoom: f64,
) -> Result<f64, WireError> {
    let scale = super::native_scale(win).await?;
    check(key)?;
    if !scale.is_finite()
        || scale <= 0.0
        || [rect.x, rect.y, rect.width, rect.height]
            .iter()
            .any(|value| {
                let physical = value * scale;
                !physical.is_finite() || physical < i32::MIN as f64 || physical > i32::MAX as f64
            })
    {
        return Err(WireError::new(
            "invalid",
            "Preview physical bounds are out of range",
        ));
    }
    if usable(rect) {
        let viewport = Viewport {
            width: rect.width as u32,
            height: rect.height as u32,
            device_scale_factor: scale,
        };
        entry
            .page
            .resize(super::layout_metrics(viewport, zoom)?)
            .await
            .map_err(super::wire)?;
        check(key)?;
        entry.document.lock().expect("Preview document").viewport = viewport;
    }
    Ok(scale)
}

async fn painting(entry: &Entry, key: native::SurfaceKey, visible: bool) -> Result<(), WireError> {
    let running = entry.document.lock().expect("Preview document").painting;
    if running == visible {
        return Ok(());
    }
    check(key)?;
    if visible {
        entry
            .page
            .start_screencast(json!({"format":"png","everyNthFrame":1}))
            .await
            .map_err(super::wire)?;
    } else {
        super::ack_retained(entry).await;
        entry.page.stop_screencast().await.map_err(super::wire)?;
    }
    check(key)?;
    entry.document.lock().expect("Preview document").painting = visible;
    Ok(())
}

async fn detach(entry: &Entry, key: native::SurfaceKey) -> Result<(), WireError> {
    surface::dispose(key).await?;
    *entry.publisher.lock().expect("Preview publisher") = None;
    let (current, _, _) = current(key.wc)?;
    if current.view != key.view {
        return Err(WireError::new("gone", "Preview view changed"));
    }
    painting(entry, current, false).await
}

pub(super) async fn operation(
    pages: &Arc<Pages>,
    wc: u64,
    params: &Value,
) -> Result<Value, WireError> {
    let entry = pages.entry(wc)?;
    let op = crate::string(params, "op")?;
    if op == "destroy" {
        super::close(pages, wc).await?;
        return Ok(json!({}));
    }
    let _surface_change = entry.surface_change.lock().await;
    let (key, parent, zoom) = current(wc)?;
    if params["viewId"].as_u64() != Some(key.view) {
        return Err(WireError::new("gone", "Preview view identity changed"));
    }
    let args = &params["args"];
    match op {
        "attach" => {
            let win = crate::number(args, "winId")?;
            {
                let registry = runtime().registry.lock().expect("registry");
                if !registry
                    .by_window(win)
                    .is_some_and(|page| page.kind == Kind::App && page.state == PageState::Live)
                {
                    return Err(WireError::new(
                        "gone",
                        "native Preview parent must be a live app window",
                    ));
                }
            }
            let (rect, visible) = {
                let document = entry.document.lock().expect("Preview document");
                let layout = document
                    .layout
                    .as_ref()
                    .ok_or_else(|| WireError::new("invalid", "Preview view layout missing"))?;
                (layout.bounds, layout.visible)
            };
            let scale = resize(&entry, key, rect, Some(win), zoom).await?;
            if parent == Some(win) {
                surface::bounds(key, native::Bounds { rect, scale }).await?;
                surface::visible(key, visible && usable(rect)).await?;
            } else {
                if parent.is_some() {
                    detach(&entry, key).await?;
                }
                let publisher = surface::attach(
                    Arc::clone(pages),
                    Arc::clone(&entry),
                    key,
                    win,
                    native::Bounds { rect, scale },
                    false,
                )
                .await?;
                let stored = {
                    let registry = runtime().registry.lock().expect("registry");
                    if registry.page(wc).is_some_and(|page| {
                        page.state == PageState::Live
                            && page.identity.generation == key.generation
                            && matches!(page.kind,Kind::PreviewView{view,..} if view==key.view)
                    }) {
                        *entry.publisher.lock().expect("Preview publisher") = Some(publisher);
                        true
                    } else {
                        false
                    }
                };
                if !stored {
                    let _ = surface::dispose(key).await;
                    return Err(WireError::new("gone", "Preview document changed"));
                }
                surface::visible(key, visible && usable(rect)).await?;
            }
            painting(&entry, key, visible && usable(rect)).await?;
            if visible && usable(rect) {
                super::request_refresh(&entry, key, super::TEXT | super::AX);
            }
        }
        "detach" => {
            let win = crate::number(args, "winId")?;
            if parent == Some(win) {
                detach(&entry, key).await?;
            }
        }
        "setBounds" => {
            let rect = parse_bounds(&args["bounds"])?;
            let visible = entry
                .document
                .lock()
                .expect("Preview document")
                .layout
                .as_ref()
                .ok_or_else(|| WireError::new("invalid", "Preview view layout missing"))?
                .visible;
            if let Some(win) = parent {
                let scale = resize(&entry, key, rect, Some(win), zoom).await?;
                if !usable(rect) {
                    surface::visible(key, false).await?;
                }
                surface::bounds(key, native::Bounds { rect, scale }).await?;
                if usable(rect) {
                    surface::visible(key, visible).await?;
                }
            }
            entry.document.lock().expect("Preview document").layout = Some(ViewLayout {
                bounds: rect,
                visible,
            });
            painting(&entry, key, parent.is_some() && visible && usable(rect)).await?;
            if parent.is_some() && visible && usable(rect) {
                super::request_refresh(&entry, key, super::TEXT | super::AX);
            }
        }
        "setVisible" => {
            let visible = args["visible"].as_bool().unwrap_or(false);
            let rect = entry
                .document
                .lock()
                .expect("Preview document")
                .layout
                .as_ref()
                .ok_or_else(|| WireError::new("invalid", "Preview view layout missing"))?
                .bounds;
            if parent.is_some() {
                surface::visible(key, visible && usable(rect)).await?;
            }
            entry.document.lock().expect("Preview document").layout = Some(ViewLayout {
                bounds: rect,
                visible,
            });
            painting(&entry, key, parent.is_some() && visible && usable(rect)).await?;
            if parent.is_some() && visible && usable(rect) {
                super::request_refresh(&entry, key, super::TEXT | super::AX);
            }
        }
        op => return Err(crate::unsupported(&format!("view.op {op}"))),
    }
    Ok(json!({}))
}
