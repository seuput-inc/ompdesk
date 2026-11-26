//! Windows: the boot shell (scripts/boot-shell.ts, the page's first frame) drawn natively while WebView2 starts. A
//! cold WebView2 start can take most of a minute before its browser process even runs, all of it inside the host's
//! `build` of the window (no-loading-screens › Native boot shell), so the window shows and is drawn from here, as
//! soon as wry's WebView container exists, instead of staying hidden or one flat colour.
//!
//! wry puts the WebView in a container child window (`WRY_WEBVIEW`, no background brush) and creates WebView2's own
//! window inside it once the controller exists. That window is transparent until the page's first paint
//! (main.rs `ready_to_show`), so the drawing shows through it until the page's own frame replaces it, and is never
//! seen again after that: it needs no teardown.
//!
//! What is drawn, in the page's colours (src/shared/window-background.json `bootShell`, pinned to the stylesheet by
//! tokens.test.ts) and geometry (src/shared/boot-shell-geometry.json, pinned by boot-shell-geometry.test.ts): the
//! sidebar band at the width and visibility the `sidebarWidth`/`sidebarVisible` prefs left it, the composer box, and the
//! π between the top bar and the composer. The skeleton bars inside them are left out: they shimmer in the page.
#![allow(unsafe_code)]

use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::Instant;

use serde::Deserialize;
use serde_json::{Value, json};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BeginPaint, BitBlt, CreateCompatibleDC, CreateDIBSection,
    CreatePen, CreateSolidBrush, DIB_RGB_COLORS, DeleteDC, DeleteObject, EndPaint, FillRect,
    GdiFlush, GetDC, HDC, HGDIOBJ, InvalidateRect, PAINTSTRUCT, PS_SOLID, ReleaseDC, RoundRect,
    SRCCOPY, SelectObject,
};
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CBT_CREATEWNDW, CallNextHookEx, CallWindowProcW, DefWindowProcW, GWLP_WNDPROC, GetClassNameW,
    GetClientRect, HCBT_CREATEWND, HHOOK, SW_SHOW, SW_SHOWMAXIMIZED, SW_SHOWNOACTIVATE,
    SetWindowLongPtrW, SetWindowsHookExW, ShowWindow, UnhookWindowsHookEx, WH_CBT, WM_ERASEBKGND,
    WM_NCDESTROY, WM_PAINT, WNDPROC,
};

use crate::log;

const GEOMETRY: &str = include_str!("../../../../../src/shared/boot-shell-geometry.json");
const COLOURS: &str = include_str!("../../../../../src/shared/window-background.json");

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
struct SidebarWidth {
    min: f64,
    max: f64,
    default: f64,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
struct ColumnPad {
    min: f64,
    share: f64,
    max: f64,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
struct ComposerBox {
    desktop: f64,
}

/// `PiOptions` of src/shared/brand-mark.ts on its 512-unit grid centred at the origin.
#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
struct Mark {
    width: f64,
    stroke: f64,
    leg_gap: f64,
    height: f64,
    left_leg: f64,
    foot: f64,
    foot_gap: f64,
    bar_radius: f64,
    end_radius: f64,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
struct Geometry {
    sidebar_width: SidebarWidth,
    composer_box_px: ComposerBox,
    topbar_px: f64,
    composer_gap_px: f64,
    composer_bottom_px: f64,
    composer_radius_px: f64,
    column_reading_px: f64,
    column_pad_px: ColumnPad,
    scrollbar_px: f64,
    mark_px: f64,
    mica_sidebar_share: f64,
    mark: Mark,
}

impl Geometry {
    fn parse() -> Option<Self> {
        serde_json::from_str(GEOMETRY).ok()
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Fill {
    Background,
    Surface,
    Border,
    Field,
    Ink,
    Accent,
}

/// A shape in DIP: a rectangle with all four corners rounded by `radius`, filled, with a 1 DIP `outline` if any.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Shape {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    radius: f64,
    fill: Fill,
    outline: Option<Fill>,
}

impl Shape {
    fn rect(x: f64, y: f64, w: f64, h: f64, fill: Fill) -> Self {
        Self {
            x,
            y,
            w,
            h,
            radius: 0.0,
            fill,
            outline: None,
        }
    }
}

/// The boot shell's shapes for a `width` × `height` DIP client area, back to front. `sidebar` is the docked sidebar's
/// width, `None` when it was left collapsed.
fn layout(g: &Geometry, width: f64, height: f64, sidebar: Option<f64>) -> Vec<Shape> {
    let mut shapes = vec![Shape::rect(0.0, 0.0, width, height, Fill::Background)];
    let main_x = match sidebar {
        Some(w) => {
            let w = w.clamp(g.sidebar_width.min, g.sidebar_width.max).min(width);
            shapes.push(Shape::rect(0.0, 0.0, w, height, Fill::Surface));
            // `border-r` inside the sidebar's width (border-box).
            shapes.push(Shape::rect(w - 1.0, 0.0, 1.0, height, Fill::Border));
            w
        }
        None => 0.0,
    };
    let main_w = width - main_x;
    // .omp-composer-region keeps the scrollbar's width free on its right; .omp-composer-shell is the reading column
    // plus its pad on each side, centred in what is left, and the box fills the shell inside the pad.
    let region_w = (main_w - g.scrollbar_px).max(0.0);
    let pad = (g.column_pad_px.share * main_w).clamp(g.column_pad_px.min, g.column_pad_px.max);
    let shell_w = region_w.min(g.column_reading_px + 2.0 * pad);
    let box_w = shell_w - 2.0 * pad;
    let box_h = g.composer_box_px.desktop;
    let box_y = height - g.composer_bottom_px - box_h;
    if box_w > 0.0 && box_y > g.topbar_px {
        shapes.push(Shape {
            x: main_x + (region_w - shell_w) / 2.0 + pad,
            y: box_y,
            w: box_w,
            h: box_h,
            radius: g.composer_radius_px,
            fill: Fill::Field,
            outline: Some(Fill::Border),
        });
    }
    // The mark is centred in the pane between the top bar and the empty region above the composer.
    let mark_top = g.topbar_px;
    let mark_bottom = box_y - g.composer_gap_px;
    if mark_bottom - mark_top >= g.mark_px && main_w >= g.mark_px {
        let centre = (main_x + main_w / 2.0, (mark_top + mark_bottom) / 2.0);
        shapes.extend(mark(&g.mark, g.mark_px / 512.0, centre));
    }
    shapes
}

/// `piGeometry` (src/shared/brand-mark.ts) as rectangles, scaled by `k` around `centre`. GDI rounds all four corners
/// alike, so the corners a path rounds less (the cut above the foot, `cutRadius`) are square here.
fn mark(m: &Mark, k: f64, (cx, cy): (f64, f64)) -> Vec<Shape> {
    let top = -m.height / 2.0;
    let bar_bottom = top + m.stroke;
    let left_x = -m.leg_gap / 2.0 - m.stroke;
    let right_x = m.leg_gap / 2.0;
    let leg_top = top + m.stroke / 2.0;
    let foot_top = bar_bottom + m.left_leg - m.foot;
    let foot_bottom = bar_bottom + m.left_leg;
    let left_ink_bottom = if m.foot_gap > 0.0 {
        foot_top - m.foot_gap
    } else {
        foot_top + m.foot / 2.0
    };
    let at = |x: f64, y: f64, w: f64, h: f64, radius: f64, fill: Fill| Shape {
        x: cx + x * k,
        y: cy + y * k,
        w: w * k,
        h: h * k,
        radius: radius * k,
        fill,
        outline: None,
    };
    vec![
        at(
            -m.width / 2.0,
            top,
            m.width,
            m.stroke,
            m.bar_radius,
            Fill::Ink,
        ),
        at(
            left_x,
            leg_top,
            m.stroke,
            left_ink_bottom - leg_top,
            0.0,
            Fill::Ink,
        ),
        at(
            right_x,
            leg_top,
            m.stroke,
            m.height / 2.0 - leg_top,
            m.end_radius,
            Fill::Ink,
        ),
        // The foot: rounded at its free end, square at the cut (its top half drawn over square).
        at(
            left_x,
            foot_top,
            m.stroke,
            foot_bottom - foot_top,
            m.end_radius,
            Fill::Accent,
        ),
        at(
            left_x,
            foot_top,
            m.stroke,
            (foot_bottom - foot_top) / 2.0,
            0.0,
            Fill::Accent,
        ),
    ]
}

/// The sidebar the page will open with: `sidebarVisible` and `sidebarWidth` of `<userData>/prefs.json`, as the
/// renderer reads them (a missing width is the first-run default).
fn sidebar_from_prefs(prefs: &Value, g: &Geometry) -> Option<f64> {
    if prefs["sidebarVisible"] == Value::Bool(false) {
        return None;
    }
    Some(
        prefs["sidebarWidth"]
            .as_f64()
            .unwrap_or(g.sidebar_width.default),
    )
}

/// `COLORREF`s of each fill in one scheme.
#[derive(Clone, Copy)]
struct Palette {
    fills: [u32; 6],
    /// Opacity of the sidebar band: under the Mica backdrop the page tints it over the backdrop (`micaSidebarShare`).
    sidebar_alpha: u8,
}

impl Palette {
    fn parse(dark: bool, mica: bool, geometry: &Geometry) -> Option<Self> {
        let colours: Value = serde_json::from_str(COLOURS).ok()?;
        let scheme = if dark { "dark" } else { "light" };
        let boot = &colours["bootShell"][scheme];
        let colour = |value: &Value| colorref(value.as_str()?);
        Some(Self {
            fills: [
                colour(&colours[scheme])?,
                colour(&boot["surface"])?,
                colour(&boot["border"])?,
                colour(&boot["field"])?,
                colour(&boot["ink"])?,
                colour(&boot["accent"])?,
            ],
            sidebar_alpha: if mica {
                (geometry.mica_sidebar_share * 255.0).round() as u8
            } else {
                255
            },
        })
    }

    fn of(&self, fill: Fill) -> u32 {
        self.fills[fill as usize]
    }
}

fn colorref(hex: &str) -> Option<u32> {
    let digits = hex.strip_prefix('#').filter(|digits| digits.len() == 6)?;
    let rgb = u32::from_str_radix(digits, 16).ok()?;
    Some(((rgb & 0xff) << 16) | (rgb & 0xff00) | (rgb >> 16))
}

/// How the window may show while its WebView is being made (`app_window` `first_show`), before Tauri hands it back.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum EarlyShow {
    /// `show`: activated, maximized when its launch asked for it.
    Show { maximize: bool },
    /// `showInactive`: behind the active window.
    Inactive,
}

impl EarlyShow {
    /// The early show for a window `op` first shows with, if it has one: a minimized or hidden window, and a maximized
    /// one that must not take activation, wait for Tauri.
    pub fn for_first_show(op: Option<&str>, maximize: bool) -> Option<Self> {
        match op {
            Some("show") => Some(Self::Show { maximize }),
            Some("showInactive") if !maximize => Some(Self::Inactive),
            _ => None,
        }
    }
}

/// What the window being built will draw, waiting for its container to be created.
struct Pending {
    /// `window.boot_shell`'s fields known before the window exists.
    fields: Value,
    geometry: Geometry,
    palette: Palette,
    sidebar: Option<f64>,
    show: Option<EarlyShow>,
    armed: Instant,
    shown: bool,
}

struct Painting {
    wc: u64,
    hwnd: isize,
    previous: WNDPROC,
    geometry: Geometry,
    palette: Palette,
    sidebar: Option<f64>,
    painted: bool,
    /// The page has painted: the container draws nothing from here on, so a Mica window's backdrop shows through the
    /// page's translucent parts instead of the shell.
    cleared: bool,
}

static PENDING: Mutex<Option<Pending>> = Mutex::new(None);
static PAINTINGS: Mutex<Vec<Painting>> = Mutex::new(Vec::new());

fn lock<T>(mutex: &'static Mutex<T>) -> MutexGuard<'static, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The boot shell armed around one `WebviewWindowBuilder::build` on the UI thread. wry makes the WebView's container
/// window and then waits, pumping messages, for WebView2's environment and controller: the whole cold start happens
/// inside `build`, before Tauri returns the window. A thread hook sees the container being created, draws the shell
/// into it and into its parent from then on, and shows the window as its launch asked.
pub struct Armed {
    hook: HHOOK,
}

/// Arms the boot shell for the app window `wc` about to be built on this thread.
pub fn arm(
    wc: u64,
    user_data: &Path,
    dark: bool,
    mica: bool,
    show: Option<EarlyShow>,
) -> Option<Armed> {
    let geometry = Geometry::parse()?;
    let palette = Palette::parse(dark, mica, &geometry)?;
    let prefs = std::fs::read(user_data.join("prefs.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .unwrap_or(Value::Null);
    let sidebar = sidebar_from_prefs(&prefs, &geometry);
    *lock(&PENDING) = Some(Pending {
        fields: json!({"wcId": wc, "dark": dark, "mica": mica, "sidebar": sidebar}),
        geometry,
        palette,
        sidebar,
        show,
        armed: Instant::now(),
        shown: false,
    });
    // SAFETY: a CBT hook for this thread only, with a procedure of this module; `Armed` removes it.
    let hook = unsafe {
        SetWindowsHookExW(
            WH_CBT,
            Some(cbt_proc),
            std::ptr::null_mut(),
            GetCurrentThreadId(),
        )
    };
    if hook.is_null() {
        lock(&PENDING).take();
        return None;
    }
    Some(Armed { hook })
}

impl Armed {
    /// `build` returned: the hook comes off. Whether the window was shown while it ran (its `first_show` has then been
    /// done natively, and the caller does it again through Tauri so Tauri's own state agrees).
    pub fn finish(self) -> bool {
        let shown = lock(&PENDING).take().is_some_and(|pending| pending.shown);
        drop(self);
        shown
    }
}

impl Drop for Armed {
    fn drop(&mut self) {
        // SAFETY: the hook `arm` set on this thread.
        unsafe { UnhookWindowsHookEx(self.hook) };
        // A build that failed before making its container leaves nothing armed for the next window.
        lock(&PENDING).take();
    }
}

fn is_container(hwnd: HWND) -> bool {
    let mut name = [0u16; 32];
    // SAFETY: the class name of a window this thread is creating, into a buffer of the length passed.
    let len = unsafe { GetClassNameW(hwnd, name.as_mut_ptr(), name.len() as i32) };
    String::from_utf16_lossy(&name[..len.max(0) as usize]) == "WRY_WEBVIEW"
}

unsafe extern "system" fn cbt_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HCBT_CREATEWND as i32 {
        let hwnd = wparam as HWND;
        // SAFETY: for HCBT_CREATEWND lparam points to the CBT_CREATEWNDW of the window being created.
        let parent = unsafe { (*(*(lparam as *const CBT_CREATEWNDW)).lpcs).hwndParent };
        if !parent.is_null() && is_container(hwnd) {
            // A panic must not unwind out of a hook procedure.
            let _ = std::panic::catch_unwind(|| container_created(hwnd, parent));
        }
    }
    // SAFETY: the next hook in the chain, with what this one was given.
    unsafe { CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam) }
}

/// wry's container for the window being built exists: from here until WebView2 covers it, it paints the shell. The
/// parent shows now, drawn with the shell before the container is visible over it, so a cold start that holds the
/// thread before its first message pump still has the shell on screen.
fn container_created(container: HWND, parent: HWND) {
    let (mut fields, geometry, palette, sidebar, show, armed) = {
        let mut pending = lock(&PENDING);
        let Some(pending) = pending.as_mut() else {
            return;
        };
        pending.shown |= pending.show.is_some();
        let taken = (
            pending.fields.clone(),
            pending.geometry,
            pending.palette,
            pending.sidebar,
            pending.show,
            pending.armed,
        );
        // One container per build: a second WebView made inside it is not this window's.
        pending.show = None;
        taken
    };
    // SAFETY: GWLP_WNDPROC of a window this thread is creating takes a window procedure and returns the one it
    // replaces.
    let previous = unsafe {
        SetWindowLongPtrW(
            container,
            GWLP_WNDPROC,
            container_proc as *const () as usize as isize,
        )
    };
    if previous != 0 {
        // SAFETY: the value GWLP_WNDPROC held is the address of a window procedure, a WNDPROC.
        let previous = unsafe {
            std::mem::transmute::<*const (), WNDPROC>(std::ptr::with_exposed_provenance(
                previous as usize,
            ))
        };
        lock(&PAINTINGS).push(Painting {
            wc: fields["wcId"].as_u64().unwrap_or_default(),
            hwnd: container as isize,
            previous,
            geometry,
            palette,
            sidebar,
            painted: false,
            cleared: false,
        });
    }
    if let Some(show) = show {
        let command = match show {
            EarlyShow::Show { maximize: true } => SW_SHOWMAXIMIZED,
            EarlyShow::Show { maximize: false } => SW_SHOW,
            EarlyShow::Inactive => SW_SHOWNOACTIVATE,
        };
        // SAFETY: the window this thread is building, complete before its children are created; its client DC is
        // released below, and the container is not visible yet, so nothing clips the drawing.
        unsafe {
            ShowWindow(parent, command);
            let dc = GetDC(parent);
            if !dc.is_null() {
                render(parent, dc, &geometry, &palette, sidebar, false);
                ReleaseDC(parent, dc);
            }
        }
    }
    fields["hwnd"] = json!(parent as isize);
    fields["shown"] = json!(show.map(|show| format!("{show:?}")));
    fields["ms"] = json!(armed.elapsed().as_millis());
    log::log("window.boot_shell", fields);
}

unsafe extern "system" fn container_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    let found = lock(&PAINTINGS)
        .iter()
        .find(|painting| painting.hwnd == hwnd as isize)
        .map(|painting| {
            (
                painting.previous,
                painting.geometry,
                painting.palette,
                painting.sidebar,
                painting.cleared,
            )
        });
    let Some((previous, geometry, palette, sidebar, cleared)) = found else {
        // SAFETY: the default procedure for a message this thread is dispatching to a window it owns.
        return unsafe { DefWindowProcW(hwnd, message, wparam, lparam) };
    };
    match message {
        // Everything is painted in WM_PAINT, background included, so nothing flashes between erase and paint.
        WM_ERASEBKGND => 1,
        WM_PAINT => {
            // A panic must not unwind out of a window procedure.
            let _ = std::panic::catch_unwind(|| {
                // SAFETY: the BeginPaint/EndPaint pair of a window of this thread inside its WM_PAINT.
                unsafe {
                    let mut ps: PAINTSTRUCT = std::mem::zeroed();
                    let dc = BeginPaint(hwnd, &mut ps);
                    if !dc.is_null() {
                        render(hwnd, dc, &geometry, &palette, sidebar, cleared);
                    }
                    EndPaint(hwnd, &ps);
                }
            });
            let first = lock(&PAINTINGS)
                .iter_mut()
                .find(|painting| painting.hwnd == hwnd as isize)
                .is_some_and(|painting| !std::mem::replace(&mut painting.painted, true));
            if first {
                log::log("window.boot_shell_painted", json!({}));
            }
            0
        }
        WM_NCDESTROY => {
            // SAFETY: the procedure this one replaced, with the message it was given.
            let result = unsafe { CallWindowProcW(previous, hwnd, message, wparam, lparam) };
            lock(&PAINTINGS).retain(|painting| painting.hwnd != hwnd as isize);
            result
        }
        // SAFETY: as for WM_NCDESTROY.
        _ => unsafe { CallWindowProcW(previous, hwnd, message, wparam, lparam) },
    }
}

/// The page of `wc` painted its own first frame: the shell under it goes, so a translucent page (a Mica window's
/// sidebar and canvas) shows the backdrop through itself, not the shell.
pub fn clear(wc: u64) {
    let containers: Vec<isize> = lock(&PAINTINGS)
        .iter_mut()
        .filter(|painting| painting.wc == wc && !painting.cleared)
        .map(|painting| {
            painting.cleared = true;
            painting.hwnd
        })
        .collect();
    for hwnd in containers {
        // SAFETY: a window of this thread, still alive (a destroyed one leaves PAINTINGS in WM_NCDESTROY).
        unsafe { InvalidateRect(hwnd as HWND, std::ptr::null(), 0) };
    }
}

/// Draws the shell over `hwnd`'s whole client area into `dc` (nothing, fully transparent, once `cleared`): off screen
/// first, then in one blit, so a resize never shows a half-drawn frame.
///
/// # Safety
/// `dc` is a live device context of `hwnd`, a window of this thread.
unsafe fn render(
    hwnd: HWND,
    dc: HDC,
    geometry: &Geometry,
    palette: &Palette,
    sidebar: Option<f64>,
    cleared: bool,
) {
    // SAFETY: per the caller; every GDI object made here is selected out and deleted before returning, and the DIB's
    // pixels are read only while it lives, after GdiFlush.
    unsafe {
        let mut client: RECT = std::mem::zeroed();
        GetClientRect(hwnd, &mut client);
        let (w, h) = (client.right - client.left, client.bottom - client.top);
        if w <= 0 || h <= 0 {
            return;
        }
        let scale = f64::from(GetDpiForWindow(hwnd).max(96)) / 96.0;
        let shapes = if cleared {
            Vec::new()
        } else {
            layout(
                geometry,
                f64::from(w) / scale,
                f64::from(h) / scale,
                sidebar,
            )
        };
        // A 32-bit DIB, so every pixel carries its alpha: a Mica window composes the client area by it, and GDI
        // alone leaves it 0 (transparent).
        let mut info: BITMAPINFO = std::mem::zeroed();
        info.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -h,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            ..std::mem::zeroed()
        };
        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let memory = CreateCompatibleDC(dc);
        let bitmap = CreateDIBSection(
            memory,
            &info,
            DIB_RGB_COLORS,
            &mut bits,
            std::ptr::null_mut(),
            0,
        );
        if bitmap.is_null() || bits.is_null() {
            DeleteDC(memory);
            return;
        }
        let old_bitmap = SelectObject(memory, bitmap as HGDIOBJ);
        for shape in &shapes {
            draw(memory, shape, palette, scale);
        }
        GdiFlush();
        let band = shapes
            .iter()
            .find(|shape| shape.fill == Fill::Surface)
            .map(|shape| {
                let px = |v: f64| (v * scale).round() as usize;
                px(shape.x)..px(shape.x + shape.w - 1.0)
            });
        let pixels = std::slice::from_raw_parts_mut(bits.cast::<u32>(), (w * h) as usize);
        for (i, pixel) in pixels.iter_mut().enumerate() {
            let in_band = band
                .as_ref()
                .is_some_and(|band| band.contains(&(i % w as usize)));
            let alpha = if cleared {
                0
            } else if in_band {
                palette.sidebar_alpha
            } else {
                255
            };
            *pixel = premultiplied(*pixel, alpha);
        }
        BitBlt(dc, 0, 0, w, h, memory, 0, 0, SRCCOPY);
        SelectObject(memory, old_bitmap);
        DeleteObject(bitmap as HGDIOBJ);
        DeleteDC(memory);
    }
}

/// A DIB pixel (`0x00RRGGBB`) with alpha `a`, its colour premultiplied as DWM composes it.
fn premultiplied(pixel: u32, a: u8) -> u32 {
    let a = u32::from(a);
    let channel = |shift: u32| (((pixel >> shift) & 0xff) * a / 255) << shift;
    (a << 24) | channel(16) | channel(8) | channel(0)
}

/// # Safety
/// `dc` is a live device context of this thread.
unsafe fn draw(dc: HDC, shape: &Shape, palette: &Palette, scale: f64) {
    let px = |v: f64| (v * scale).round() as i32;
    let (left, top) = (px(shape.x), px(shape.y));
    let (right, bottom) = (px(shape.x + shape.w), px(shape.y + shape.h));
    // SAFETY: per the caller; the brush and pen are selected out and deleted before returning.
    unsafe {
        let brush = CreateSolidBrush(palette.of(shape.fill));
        if shape.radius <= 0.0 && shape.outline.is_none() {
            FillRect(
                dc,
                &RECT {
                    left,
                    top,
                    right,
                    bottom,
                },
                brush,
            );
        } else {
            let line = shape.outline.unwrap_or(shape.fill);
            let pen = CreatePen(PS_SOLID, px(1.0).max(1), palette.of(line));
            let old_pen = SelectObject(dc, pen as HGDIOBJ);
            let old_brush = SelectObject(dc, brush as HGDIOBJ);
            let corner = px(2.0 * shape.radius);
            RoundRect(dc, left, top, right, bottom, corner, corner);
            SelectObject(dc, old_brush);
            SelectObject(dc, old_pen);
            DeleteObject(pen as HGDIOBJ);
        }
        DeleteObject(brush as HGDIOBJ);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn geometry() -> Geometry {
        Geometry::parse().expect("boot-shell-geometry.json")
    }

    fn find(shapes: &[Shape], fill: Fill) -> Vec<Shape> {
        shapes
            .iter()
            .copied()
            .filter(|shape| shape.fill == fill)
            .collect()
    }

    #[test]
    fn the_sidebar_is_drawn_as_the_prefs_left_it() {
        let g = geometry();
        assert_eq!(
            sidebar_from_prefs(&json!({"sidebarWidth": 320}), &g),
            Some(320.0)
        );
        assert_eq!(
            sidebar_from_prefs(&Value::Null, &g),
            Some(g.sidebar_width.default)
        );
        assert_eq!(
            sidebar_from_prefs(&json!({"sidebarWidth": 320, "sidebarVisible": false}), &g),
            None
        );
        let shapes = layout(&g, 1400.0, 900.0, Some(9999.0));
        assert_eq!(find(&shapes, Fill::Surface)[0].w, g.sidebar_width.max);
        assert_eq!(find(&shapes, Fill::Border)[0].x, g.sidebar_width.max - 1.0);
        let collapsed = layout(&g, 1400.0, 900.0, None);
        assert!(find(&collapsed, Fill::Surface).is_empty());
    }

    #[test]
    fn the_composer_sits_in_the_reading_column_above_the_bottom_pad() {
        let g = geometry();
        let shapes = layout(&g, 1400.0, 900.0, Some(280.0));
        let composer = find(&shapes, Fill::Field)[0];
        // A 1120-wide pane: the 40 px pad caps 3% of it, and the column is narrower than the region.
        assert_eq!(composer.w, g.column_reading_px);
        let region = 1120.0 - g.scrollbar_px;
        assert_eq!(composer.x, 280.0 + (region - g.column_reading_px) / 2.0);
        assert_eq!(composer.y + composer.h, 900.0 - g.composer_bottom_px);
        assert_eq!(composer.outline, Some(Fill::Border));
        // A narrow pane: the box fills the region inside the minimum pad.
        let narrow = find(&layout(&g, 500.0, 600.0, None), Fill::Field)[0];
        assert_eq!(narrow.w, 500.0 - g.scrollbar_px - 2.0 * g.column_pad_px.min);
    }

    #[test]
    fn the_mark_is_centred_between_the_top_bar_and_the_composer() {
        let g = geometry();
        let shapes = layout(&g, 1400.0, 900.0, Some(280.0));
        let ink = find(&shapes, Fill::Ink);
        let bar = ink[0];
        let centre_x = 280.0 + 1120.0 / 2.0;
        assert!((bar.x + bar.w / 2.0 - centre_x).abs() < 1e-9);
        let composer = find(&shapes, Fill::Field)[0];
        let centre_y = (g.topbar_px + composer.y - g.composer_gap_px) / 2.0;
        let top = bar.y;
        let bottom = ink[2].y + ink[2].h;
        assert!(((top + bottom) / 2.0 - centre_y).abs() < 1e-9);
        assert!(bottom - top <= g.mark_px);
        assert_eq!(find(&shapes, Fill::Accent).len(), 2);
        // No room between the bars: no mark.
        assert!(find(&layout(&g, 1400.0, 150.0, None), Fill::Ink).is_empty());
    }

    #[test]
    fn both_schemes_have_every_colour_and_mica_tints_only_the_sidebar() {
        let g = geometry();
        for dark in [false, true] {
            assert_eq!(Palette::parse(dark, false, &g).unwrap().sidebar_alpha, 255);
            assert_eq!(Palette::parse(dark, true, &g).unwrap().sidebar_alpha, 158);
        }
        assert_eq!(colorref("#123456"), Some(0x0056_3412));
        assert_eq!(premultiplied(0x00ff_8000, 255), 0xffff_8000);
        assert_eq!(premultiplied(0x00ff_8000, 158), 0x9e9e_4f00);
    }
}
