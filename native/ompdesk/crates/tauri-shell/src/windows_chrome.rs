//! WebView2 is a child HWND. A hit test on the app HWND alone never sees a real pointer over its
//! page. Put a shaped, non-activating input window over just the non-client pixels of the row.
#![allow(unsafe_code)]

use crate::chrome_hit::{self, Cell, Hit};
use crate::registry::Identity;
use serde_json::{Value, json};
use std::cell::RefCell;
use std::collections::HashMap;
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    BLACK_BRUSH, CombineRgn, CreateRectRgn, DeleteObject, GetStockObject, RGN_DIFF, RGN_OR,
    ScreenToClient, SetRectRgn, SetWindowRgn,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT, TrackMouseEvent,
};
use windows_sys::Win32::UI::WindowsAndMessaging::*;

struct Row {
    identity: Identity,
    child: HWND,
    cells: Vec<Cell>,
    width: i32,
    edge: i32,
    hover: Option<&'static str>,
}

thread_local! {
    // The HWND procedures and layout changes all run on this window's UI thread.
    static ROWS: RefCell<HashMap<HWND, Row>> = RefCell::default();
}

fn error() -> String {
    std::io::Error::last_os_error().to_string()
}

pub(super) fn page_zoom(view: &tauri::webview::PlatformWebview) -> Result<f64, String> {
    let mut zoom = 0.0;
    // SAFETY: with_webview supplies the live controller on its owning thread. Read its current
    // factor, including keyboard zoom, not the last factor Node requested.
    unsafe { view.controller().ZoomFactor(&mut zoom) }.map_err(|e| e.to_string())?;
    (zoom.is_finite() && zoom > 0.0)
        .then_some(zoom)
        .ok_or_else(|| "invalid WebView2 zoom".into())
}

fn parse(value: &Value, row: &chrome_hit::RowBounds) -> Result<(i32, i32, Vec<Cell>), String> {
    let coord = |n: &Value| n.as_u64().filter(|n| *n <= 65535).map(|n| n as i32);
    let width = coord(&value["width"]).ok_or("invalid title bar width")?;
    let height = coord(&value["height"]).ok_or("invalid title bar height")?;
    let raw = value["cells"]
        .as_array()
        .ok_or("invalid title bar regions")?;
    if !row.accepts(width, height, raw.len()) {
        return Err("regions exceed the native title bar".into());
    }
    let mut cells = Vec::with_capacity(raw.len());
    for item in raw {
        let hit = match item[0].as_str() {
            Some("client") => Hit::Client,
            Some("drag") => Hit::Caption,
            Some("minimize") => Hit::Minimize,
            Some("maximize") => Hit::Maximize,
            Some("close") => Hit::Close,
            _ => return Err("unknown title bar region".into()),
        };
        let [Some(l), Some(t), Some(r), Some(b)] = [1, 2, 3, 4].map(|i| coord(&item[i])) else {
            return Err("invalid title bar bounds".into());
        };
        let cell = Cell {
            hit,
            bounds: [l, t, r.min(row.width), b],
        };
        if r > width || !row.contains(&cell) {
            return Err("title bar region outside its cell".into());
        }
        cells.push(cell);
    }
    Ok((row.width, height, cells))
}

pub(super) fn layout(
    parent: HWND,
    identity: Identity,
    value: &Value,
    zoom: f64,
) -> Result<(), String> {
    let (actual, _, _) = geometry(parent);
    // SAFETY: the calling app's actual window, on its owning UI thread.
    let scale = f64::from(unsafe { GetDpiForWindow(parent) }) / 96.0 * zoom;
    let (width, height, cells) = parse(
        value,
        &chrome_hit::RowBounds {
            width: actual,
            scale,
        },
    )?;
    let existing = ROWS.with_borrow(|rows| rows.get(&parent).map(|r| r.child));
    // SAFETY: created on the owning thread. The parent owns the child through WM_DESTROY.
    let child = match existing {
        Some(child) => child,
        None => unsafe {
            let class = windows_sys::w!("OMPdeskTitleBarInput");
            let instance = GetModuleHandleW(null());
            // WindowFromPoint skips static text controls; the input window needs its own class.
            // RegisterClassW may report already registered on later app windows.
            RegisterClassW(&WNDCLASSW {
                style: CS_DBLCLKS,
                lpfnWndProc: Some(input),
                hInstance: instance,
                hbrBackground: GetStockObject(BLACK_BRUSH),
                lpszClassName: class,
                ..Default::default()
            });
            let child = CreateWindowExW(
                WS_EX_LAYERED | WS_EX_NOACTIVATE,
                class,
                null(),
                WS_CHILD,
                0,
                0,
                0,
                0,
                parent,
                null_mut(),
                instance,
                null(),
            );
            if child.is_null() {
                return Err(error());
            }
            // Alpha zero makes a layered window input-transparent too; one keeps the page visible.
            if SetLayeredWindowAttributes(child, 0, 1, LWA_ALPHA) == 0 {
                let err = error();
                DestroyWindow(child);
                return Err(err);
            }
            child
        },
    };
    let (_, edge, _) = geometry(parent);
    if let Err(err) = shape(child, &cells, width, edge) {
        if existing.is_none() {
            // SAFETY: discard the new child if its input mask could not be installed.
            unsafe {
                DestroyWindow(child);
            }
        }
        return Err(err);
    }
    ROWS.with_borrow_mut(|rows| {
        let hover = rows.get(&parent).and_then(|row| row.hover);
        rows.insert(
            parent,
            Row {
                identity,
                child,
                cells,
                width,
                edge,
                hover,
            },
        );
    });
    // SAFETY: position only the owned input child, never activate or move a different app window.
    if unsafe {
        SetWindowPos(
            child,
            HWND_TOP,
            0,
            0,
            width,
            height.max(edge),
            SWP_NOACTIVATE,
        )
    } == 0
    {
        return Err(error());
    }
    resized(parent);
    Ok(())
}

fn shape(child: HWND, cells: &[Cell], width: i32, edge: i32) -> Result<(), String> {
    // SAFETY: temporary regions belong to this thread. SetWindowRgn takes ownership on success.
    unsafe {
        let mask = CreateRectRgn(0, 0, 0, 0);
        let rect = CreateRectRgn(0, 0, 0, 0);
        let mut ok = !mask.is_null() && !rect.is_null();
        for cell in cells {
            let [l, t, r, b] = cell.bounds;
            ok = ok
                && SetRectRgn(rect, l, t, r, b) != 0
                && CombineRgn(
                    mask,
                    mask,
                    rect,
                    if cell.hit == Hit::Client {
                        RGN_DIFF
                    } else {
                        RGN_OR
                    },
                ) != 0;
        }
        if edge > 0 {
            ok = ok
                && SetRectRgn(rect, 0, 0, width, edge) != 0
                && CombineRgn(mask, mask, rect, RGN_OR) != 0;
        }
        ok = ok && SetWindowRgn(child, mask, 1) != 0;
        DeleteObject(rect);
        if !ok {
            DeleteObject(mask);
            return Err("could not shape the title bar input region".into());
        }
    }
    Ok(())
}

fn geometry(parent: HWND) -> (i32, i32, bool) {
    // SAFETY: tao 0.37.2 WindowFlags::to_window_styles keeps WS_SYSMENU on a frameless app HWND
    // and removes WS_OVERLAPPEDWINDOW (including WS_SYSMENU) for native full screen.
    unsafe {
        let mut bounds = RECT::default();
        GetClientRect(parent, &mut bounds);
        let style = GetWindowLongPtrW(parent, GWL_STYLE) as u32;
        let resize = if style & WS_THICKFRAME != 0 && IsZoomed(parent) == 0 {
            GetSystemMetricsForDpi(SM_CYFRAME, GetDpiForWindow(parent))
        } else {
            0
        };
        (bounds.right, resize, style & WS_SYSMENU == 0)
    }
}

pub(super) fn resized(parent: HWND) {
    let (actual, edge, fullscreen) = geometry(parent);
    let update = ROWS.with_borrow_mut(|rows| {
        let row = rows.get_mut(&parent)?;
        let visible = !fullscreen && row.width.abs_diff(actual) <= 1;
        let new_mask = if visible && edge != row.edge {
            // Build outside the RefCell borrow: SetWindowRgn can dispatch window messages.
            Some(row.cells.clone())
        } else {
            None
        };
        row.edge = if visible { edge } else { -1 };
        Some((row.child, visible, new_mask))
    });
    if let Some((child, visible, new_mask)) = update {
        let ready = new_mask.is_none_or(|cells| shape(child, &cells, actual, edge).is_ok());
        let show = if visible && ready {
            SWP_SHOWWINDOW
        } else {
            SWP_HIDEWINDOW
        };
        // SAFETY: Tauri reorders its own resize child in WM_SIZE. Put our shaped row above it.
        unsafe {
            SetWindowPos(
                child,
                HWND_TOP,
                0,
                0,
                0,
                0,
                show | SWP_NOACTIVATE | SWP_NOSIZE | SWP_NOMOVE,
            );
        }
    }
}

pub(super) fn forget(parent: HWND) {
    let old = ROWS.with_borrow_mut(|rows| rows.remove(&parent));
    if let Some(row) = old {
        // SAFETY: rows are forgotten on navigation and at WM_DESTROY on their owner's thread.
        unsafe {
            DestroyWindow(row.child);
        }
    }
}

pub(super) fn hit(parent: HWND, packed: LPARAM) -> Option<LRESULT> {
    let mut point = POINT {
        x: i32::from(packed as i16),
        y: i32::from((packed >> 16) as i16),
    };
    // SAFETY: signed screen coordinates from WM_NCHITTEST, transformed at the window's actual DPI.
    if unsafe { ScreenToClient(parent, &mut point) } == 0 {
        return None;
    }
    let (width, resize, fullscreen) = geometry(parent);
    let part = ROWS.with_borrow(|rows| {
        let row = rows.get(&parent)?;
        let cells = if row.width.abs_diff(width) <= 1 {
            &row.cells[..]
        } else {
            &[]
        };
        Some(chrome_hit::at(
            cells, point.x, point.y, width, resize, fullscreen,
        ))
    })?;
    Some(match part {
        Hit::Top => HTTOP,
        Hit::TopLeft => HTTOPLEFT,
        Hit::TopRight => HTTOPRIGHT,
        Hit::Caption => HTCAPTION,
        Hit::Minimize => HTMINBUTTON,
        Hit::Maximize => HTMAXBUTTON,
        Hit::Close => HTCLOSE,
        Hit::Client if fullscreen => HTCLIENT,
        Hit::Client => return None, // tao still owns the other three window edges and corners.
    } as isize)
}

fn hover(parent: HWND, button: WPARAM) {
    let name = match button as u32 {
        HTMINBUTTON => Some("minimize"),
        HTMAXBUTTON => Some("maximize"),
        HTCLOSE => Some("close"),
        _ => None,
    };
    let change = ROWS.with_borrow_mut(|rows| {
        let row = rows.get_mut(&parent)?;
        if row.hover == name {
            return None;
        }
        row.hover = name;
        Some(row.identity)
    });
    if let Some(id) = change {
        crate::page_push::detached(id, "window-chrome:hover", &[json!(name)]);
    }
}

unsafe extern "system" fn input(child: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    // SAFETY: parent and child are on this UI thread. Forward the actual non-client messages to the
    // decorated window procedure (including caption tracking, Snap, and the normal close request).
    unsafe {
        let parent = GetParent(child);
        match msg {
            WM_NCHITTEST => return hit(parent, lp).unwrap_or(HTTRANSPARENT as isize),
            WM_NCMOUSEMOVE => {
                hover(parent, wp);
                TrackMouseEvent(&mut TRACKMOUSEEVENT {
                    cbSize: size_of::<TRACKMOUSEEVENT>() as u32,
                    dwFlags: TME_LEAVE | TME_NONCLIENT,
                    hwndTrack: child,
                    dwHoverTime: 0,
                });
                return SendMessageW(parent, msg, wp, lp);
            }
            WM_NCMOUSELEAVE => {
                hover(parent, 0);
                return SendMessageW(parent, msg, wp, lp);
            }
            WM_NCLBUTTONDOWN | WM_NCLBUTTONUP | WM_NCLBUTTONDBLCLK | WM_NCRBUTTONDOWN
            | WM_NCRBUTTONUP => {
                return SendMessageW(parent, msg, wp, lp);
            }
            _ => {}
        }
        DefWindowProcW(child, msg, wp, lp)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalid_payloads_never_install_a_partial_input_mask() {
        let row = chrome_hit::RowBounds {
            width: 1000,
            scale: 1.5,
        };
        let payload = |cells| json!({"width": 1000, "height": 54, "cells": cells});
        assert!(parse(&payload(json!([["close", 931, 0, 1000, 54]])), &row).is_ok());
        let mut cells = vec![json!(["drag", 0, 0, 1000, 54]); 2048];
        cells.push(json!(["close", 931, 0, 1000, 54]));
        assert!(parse(&payload(Value::Array(cells)), &row).is_err());
        for invalid in [
            json!(["drag", 0, 0, 1000, 55]),
            json!(["close", 0, 0, 1000, 54]),
            json!(["client", 5, 1, 3, 4]),
        ] {
            assert!(parse(&payload(json!([["drag", 0, 0, 1000, 54], invalid])), &row).is_err());
        }
    }
}
