#![allow(unsafe_code)]

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::ffi::c_void;
use std::ptr::{null, null_mut};
use std::rc::Rc;
use std::sync::{Arc, LazyLock, Mutex};

use super::super::model::{
    AxAction, AxActionKind, AxNode, AxTarget, AxValue, Bounds, EditCommand, EncodedFrame, Input,
    KeyKind, MouseButton, MouseKind, SurfaceError, SurfaceKey, TextContent, TextInputState,
    TextQuery, TextRange as ModelTextRange, TextReply, TextUnit as ModelTextUnit, TouchKind,
    TouchPoint, WheelUnit,
};
use super::super::shared::Shared;
use shell_core::hotkey::Mods;
use windows::Win32::Foundation::{HWND as WinHwnd, LPARAM as WinLparam, WPARAM as WinWparam};
use windows::Win32::Graphics::Imaging::{
    CLSID_WICImagingFactory, GUID_WICPixelFormat32bppBGRA, IWICImagingFactory, IWICPalette,
    WICBitmapDitherTypeNone, WICBitmapPaletteTypeCustom, WICDecodeMetadataCacheOnLoad,
};
use windows::Win32::System::Com::SAFEARRAY;
use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance};
use windows::Win32::System::Ole::{SafeArrayCreateVector, SafeArrayDestroy, SafeArrayPutElement};
use windows::Win32::System::Variant::{VARIANT, VT_I4, VT_R8, VT_UNKNOWN};
use windows::Win32::UI::Accessibility::*;
use windows::core::{BOOL, BSTR, HRESULT, IUnknown, IUnknown_Vtbl, Interface, PCWSTR, implement};
use windows_sys::Win32::Foundation::POINT;
use windows_sys::Win32::Foundation::RECT;
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::Globalization::{
    FIND_FROMEND, FIND_FROMSTART, FindNLSStringEx, LINGUISTIC_IGNORECASE, LOCALE_NAME_INVARIANT,
};
use windows_sys::Win32::Graphics::Gdi::ScreenToClient;
use windows_sys::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BeginPaint, DIB_RGB_COLORS, EndPaint, GetDC, PAINTSTRUCT,
    ReleaseDC, SRCCOPY, StretchDIBits,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::Input::Ime::{
    CANDIDATEFORM, CFS_CANDIDATEPOS, CFS_POINT, COMPOSITIONFORM, CPS_CANCEL, GCS_COMPSTR,
    GCS_CURSORPOS, GCS_RESULTSTR, ImmGetCompositionStringW, ImmGetContext, ImmNotifyIME,
    ImmReleaseContext, ImmSetCandidateWindow, ImmSetCompositionWindow, NI_COMPOSITIONSTR,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetCapture, GetKeyState, ReleaseCapture, SetCapture, SetFocus, TME_LEAVE, TRACKMOUSEEVENT,
    TrackMouseEvent, VK_CONTROL, VK_LBUTTON, VK_LWIN, VK_MBUTTON, VK_MENU, VK_RBUTTON, VK_RWIN,
    VK_SHIFT, VK_XBUTTON1, VK_XBUTTON2,
};
use windows_sys::Win32::UI::Input::Pointer::{
    GetPointerTouchInfo, GetPointerType, POINTER_FLAG_CANCELED, POINTER_TOUCH_INFO,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CREATESTRUCTW, CS_DBLCLKS, CreateWindowExW, DefWindowProcW, DestroyWindow, GWLP_USERDATA,
    GetClientRect, GetCursorPos, GetWindowLongPtrW, GetWindowThreadProcessId, IsWindow, PT_TOUCH,
    RegisterClassW, SW_HIDE, SW_SHOWNA, SWP_NOACTIVATE, SWP_NOZORDER, SetWindowLongPtrW,
    SetWindowPos, ShowWindow, TOUCH_MASK_CONTACTAREA, TOUCH_MASK_PRESSURE, WM_CHAR, WM_COPY,
    WM_CUT, WM_GETOBJECT, WM_IME_COMPOSITION, WM_IME_ENDCOMPOSITION, WM_IME_STARTCOMPOSITION,
    WM_KEYDOWN, WM_KEYUP, WM_KILLFOCUS, WM_LBUTTONDBLCLK, WM_LBUTTONDOWN, WM_LBUTTONUP,
    WM_MBUTTONDBLCLK, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MOUSEHWHEEL, WM_MOUSEMOVE, WM_MOUSEWHEEL,
    WM_NCCREATE, WM_NCDESTROY, WM_PAINT, WM_PASTE, WM_POINTERCAPTURECHANGED, WM_POINTERDOWN,
    WM_POINTERUP, WM_POINTERUPDATE, WM_RBUTTONDBLCLK, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_SETFOCUS,
    WM_SYSKEYDOWN, WM_SYSKEYUP, WM_UNDO, WM_XBUTTONDBLCLK, WM_XBUTTONDOWN, WM_XBUTTONUP, WNDCLASSW,
    WS_CHILD, WS_CLIPCHILDREN, WS_CLIPSIBLINGS,
};

const CLASS: &[u16] = &[
    79, 77, 80, 100, 101, 115, 107, 80, 114, 101, 118, 105, 101, 119, 67, 104, 105, 108, 100, 0,
];
const WM_MOUSELEAVE: u32 = 0x02a3;

pub(super) struct Parent {
    hwnd: HWND,
    thread: u32,
}

impl Parent {
    pub(super) fn from_raw(hwnd: *mut c_void) -> Result<Self, SurfaceError> {
        // SAFETY: IsWindow and GetWindowThreadProcessId accept arbitrary HWND values.
        unsafe {
            if hwnd.is_null() || IsWindow(hwnd) == 0 {
                return Err(SurfaceError::Native("invalid Preview parent window".into()));
            }
            let thread = GetWindowThreadProcessId(hwnd, null_mut());
            if thread == 0 || thread != GetCurrentThreadId() {
                return Err(SurfaceError::WrongThread);
            }
            Ok(Self { hwnd, thread })
        }
    }
}

struct Context {
    hwnd: Cell<HWND>,
    shared: Arc<Shared>,
    thread: u32,
    pixels: RefCell<Option<Pixels>>,
    composition: Cell<Option<SurfaceKey>>,
    high_surrogate: Cell<Option<u16>>,
    touches: RefCell<BTreeMap<u32, TouchPoint>>,
    mouse_position: Cell<Option<(f64, f64)>>,
}

pub(super) struct Child {
    context: Rc<Context>,
}

struct Pixels {
    width: u32,
    height: u32,
    data: Vec<u8>,
}

fn native_error(message: &str) -> SurfaceError {
    SurfaceError::Native(format!("{message}: {}", std::io::Error::last_os_error()))
}

fn decode(frame: &EncodedFrame) -> Result<Pixels, SurfaceError> {
    if frame.png.len() > u32::MAX as usize {
        return Err(SurfaceError::Invalid(
            "Preview PNG exceeds WIC stream limit".into(),
        ));
    }
    let result = (|| -> windows::core::Result<Pixels> {
        // SAFETY: WIC consumes the memory synchronously; frame retains the immutable bytes until all COM objects drop.
        unsafe {
            let factory: IWICImagingFactory =
                CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)?;
            let stream = factory.CreateStream()?;
            stream.InitializeFromMemory(frame.png.as_slice())?;
            let decoder =
                factory.CreateDecoderFromStream(&*stream, null(), WICDecodeMetadataCacheOnLoad)?;
            let source = decoder.GetFrame(0)?;
            let mut width = 0;
            let mut height = 0;
            source.GetSize(&mut width, &mut height)?;
            let stride = width.checked_mul(4).ok_or_else(|| {
                windows::core::Error::from(windows::core::HRESULT(0x80070057u32 as i32))
            })?;
            let size = stride.checked_mul(height).ok_or_else(|| {
                windows::core::Error::from(windows::core::HRESULT(0x80070057u32 as i32))
            })?;
            if width == 0 || height == 0 || width > i32::MAX as u32 || height > i32::MAX as u32 {
                return Err(windows::core::Error::from(windows::core::HRESULT(
                    0x80070057u32 as i32,
                )));
            }
            let converter = factory.CreateFormatConverter()?;
            converter.Initialize(
                &source,
                &GUID_WICPixelFormat32bppBGRA,
                WICBitmapDitherTypeNone,
                None::<&IWICPalette>,
                0.0,
                WICBitmapPaletteTypeCustom,
            )?;
            let mut data = vec![0; size as usize];
            converter.CopyPixels(null(), stride, &mut data)?;
            Ok(Pixels {
                width,
                height,
                data,
            })
        }
    })();
    result.map_err(|error| SurfaceError::Native(format!("decode Preview PNG: {error}")))
}

fn draw(
    hwnd: HWND,
    dc: windows_sys::Win32::Graphics::Gdi::HDC,
    pixels: &Pixels,
) -> Result<(), SurfaceError> {
    let mut rect = RECT::default();
    // SAFETY: rect is writable and hwnd is live while the surface owns its window.
    if unsafe { GetClientRect(hwnd, &mut rect) } == 0 {
        return Err(native_error("read Preview client bounds"));
    }
    let info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: pixels.width as i32,
            biHeight: -(pixels.height as i32),
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            ..Default::default()
        },
        ..Default::default()
    };
    // SAFETY: the DIB describes exactly the retained 32-bit pixel buffer, and dc is valid for this draw.
    let copied = unsafe {
        StretchDIBits(
            dc,
            0,
            0,
            rect.right - rect.left,
            rect.bottom - rect.top,
            0,
            0,
            pixels.width as i32,
            pixels.height as i32,
            pixels.data.as_ptr().cast(),
            &info,
            DIB_RGB_COLORS,
            SRCCOPY,
        )
    };
    if copied == 0 || copied == -1 {
        Err(native_error("paint Preview frame"))
    } else {
        Ok(())
    }
}

fn register_class() -> Result<(), SurfaceError> {
    static REGISTERED: LazyLock<bool> = LazyLock::new(|| {
        // SAFETY: the module handle is process-owned and CLASS is NUL-terminated static storage.
        unsafe {
            let instance = GetModuleHandleW(null());
            if instance.is_null() {
                return false;
            }
            let class = WNDCLASSW {
                style: CS_DBLCLKS,
                lpfnWndProc: Some(window_proc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: instance,
                hIcon: null_mut(),
                hCursor: null_mut(),
                hbrBackground: null_mut(),
                lpszMenuName: null(),
                lpszClassName: CLASS.as_ptr(),
            };
            RegisterClassW(&class) != 0
        }
    });
    if *REGISTERED {
        Ok(())
    } else {
        Err(native_error("register Preview window class"))
    }
}

impl Child {
    pub(super) fn new(
        parent: &Parent,
        bounds: Bounds,
        shared: Arc<Shared>,
    ) -> Result<Self, SurfaceError> {
        // SAFETY: both functions only inspect the supplied HWND and current thread.
        unsafe {
            if parent.thread != GetCurrentThreadId() {
                return Err(SurfaceError::WrongThread);
            }
            if IsWindow(parent.hwnd) == 0
                || GetWindowThreadProcessId(parent.hwnd, null_mut()) != parent.thread
            {
                return Err(SurfaceError::Disposed);
            }
        }
        register_class()?;
        let context = Rc::new(Context {
            hwnd: Cell::new(null_mut()),
            shared,
            thread: parent.thread,
            pixels: RefCell::new(None),
            composition: Cell::new(None),
            high_surrogate: Cell::new(None),
            touches: RefCell::new(BTreeMap::new()),
            mouse_position: Cell::new(None),
        });
        let (x, y, width, height) = physical_bounds(bounds)?;
        // SAFETY: context stays alive during CreateWindowExW; WM_NCCREATE acquires an OS-owned Rc.
        let hwnd = unsafe {
            CreateWindowExW(
                0,
                CLASS.as_ptr(),
                CLASS.as_ptr(),
                WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
                x,
                y,
                width,
                height,
                parent.hwnd,
                null_mut(),
                GetModuleHandleW(null()),
                Rc::as_ptr(&context).cast(),
            )
        };
        if hwnd.is_null() {
            return Err(native_error("create Preview child window"));
        }
        Ok(Self { context })
    }

    fn hwnd(&self) -> Result<HWND, SurfaceError> {
        // SAFETY: reading the calling thread id has no preconditions.
        if unsafe { GetCurrentThreadId() } != self.context.thread {
            return Err(SurfaceError::WrongThread);
        }
        let hwnd = self.context.hwnd.get();
        if hwnd.is_null() {
            Err(SurfaceError::Disposed)
        } else {
            Ok(hwnd)
        }
    }

    pub(super) fn check(&self) -> Result<(), SurfaceError> {
        self.hwnd().map(|_| ())
    }

    pub(super) fn present(&self, frame: &EncodedFrame) -> Result<(), SurfaceError> {
        let hwnd = self.hwnd()?;
        self.context.shared.check_key(frame.key)?;
        let pixels = decode(frame)?;
        if pixels.width != frame.pixel_width || pixels.height != frame.pixel_height {
            return Err(SurfaceError::Invalid(
                "Preview PNG dimensions do not match frame".into(),
            ));
        }
        self.context.shared.check_key(frame.key)?;
        self.hwnd()?;
        // SAFETY: the live child is owned by this UI thread and ReleaseDC balances GetDC.
        let dc = unsafe { GetDC(hwnd) };
        if dc.is_null() {
            return Err(native_error("acquire Preview paint context"));
        }
        let result = draw(hwnd, dc, &pixels);
        // SAFETY: dc was acquired from this window above.
        unsafe {
            ReleaseDC(hwnd, dc);
        }
        result?;
        self.context.shared.check_key(frame.key)?;
        self.hwnd()?;
        *self.context.pixels.borrow_mut() = Some(pixels);
        Ok(())
    }

    pub(super) fn set_bounds(&self, bounds: Bounds) -> Result<(), SurfaceError> {
        let hwnd = self.hwnd()?;
        let (x, y, width, height) = physical_bounds(bounds)?;
        // SAFETY: hwnd belongs to this UI thread and the window remains owned for this call.
        if unsafe {
            SetWindowPos(
                hwnd,
                null_mut(),
                x,
                y,
                width,
                height,
                SWP_NOACTIVATE | SWP_NOZORDER,
            )
        } == 0
        {
            return Err(native_error("move Preview child window"));
        }
        Ok(())
    }

    pub(super) fn set_visible(&self, visible: bool) -> Result<(), SurfaceError> {
        let hwnd = self.hwnd()?;
        // SAFETY: hwnd belongs to this UI thread. ShowWindow returns previous visibility, not success.
        unsafe {
            ShowWindow(hwnd, if visible { SW_SHOWNA } else { SW_HIDE });
        }
        Ok(())
    }

    pub(super) fn focus(&self) -> Result<(), SurfaceError> {
        let hwnd = self.hwnd()?;
        // SAFETY: hwnd is a live window on the calling UI thread.
        unsafe {
            SetFocus(hwnd);
        }
        // SAFETY: GetFocus reads the calling thread's focus window.
        if unsafe { windows_sys::Win32::UI::Input::KeyboardAndMouse::GetFocus() } != hwnd {
            return Err(native_error("focus Preview child window"));
        }
        Ok(())
    }

    pub(super) fn set_text_input_state(&self, state: &TextInputState) -> Result<(), SurfaceError> {
        let hwnd = self.hwnd()?;
        let point = if let Some(caret) = state.caret {
            let scale = self.context.shared.bounds().scale;
            let x = caret.x * scale;
            let y = (caret.y + caret.height) * scale;
            if !x.is_finite()
                || !y.is_finite()
                || x < i32::MIN as f64
                || x > i32::MAX as f64
                || y < i32::MIN as f64
                || y > i32::MAX as f64
            {
                return Err(SurfaceError::Invalid("invalid Preview caret bounds".into()));
            }
            Some(POINT {
                x: x.round() as i32,
                y: y.round() as i32,
            })
        } else {
            None
        };
        // SAFETY: hwnd is a live UI-thread window and ImmReleaseContext balances the acquired context.
        unsafe {
            let imc = ImmGetContext(hwnd);
            if imc.is_null() {
                return Err(native_error("acquire Preview IME context"));
            }
            let candidate = point.map_or_else(CANDIDATEFORM::default, |point| CANDIDATEFORM {
                dwStyle: CFS_CANDIDATEPOS,
                ptCurrentPos: point,
                ..Default::default()
            });
            let composition =
                point.map_or_else(COMPOSITIONFORM::default, |point| COMPOSITIONFORM {
                    dwStyle: CFS_POINT,
                    ptCurrentPos: point,
                    ..Default::default()
                });
            let success = ImmSetCandidateWindow(imc, &candidate) != 0
                && ImmSetCompositionWindow(imc, &composition) != 0;
            ImmReleaseContext(hwnd, imc);
            if !success {
                return Err(native_error("position Preview IME"));
            }
        }
        Ok(())
    }

    pub(super) fn cancel_ime(&self) -> Result<(), SurfaceError> {
        let hwnd = self.hwnd()?;
        cancel_composition(&self.context, hwnd)
    }

    pub(super) fn destroy(&self) -> Result<(), SurfaceError> {
        let hwnd = self.hwnd()?;
        // SAFETY: hwnd is a live child owned by the current thread. WM_NCDESTROY drops the OS reference.
        if unsafe { DestroyWindow(hwnd) } == 0 {
            return Err(native_error("destroy Preview child window"));
        }
        Ok(())
    }
}

impl Drop for Child {
    fn drop(&mut self) {
        if !self.context.hwnd.get().is_null() {
            if let Err(error) = self.destroy() {
                self.context.shared.report_error(error);
            }
        }
    }
}

fn physical_bounds(bounds: Bounds) -> Result<(i32, i32, i32, i32), SurfaceError> {
    let values = [
        bounds.rect.x * bounds.scale,
        bounds.rect.y * bounds.scale,
        bounds.rect.width * bounds.scale,
        bounds.rect.height * bounds.scale,
    ];
    if !bounds.scale.is_finite()
        || bounds.scale <= 0.0
        || values
            .iter()
            .any(|v| !v.is_finite() || *v < i32::MIN as f64 || *v > i32::MAX as f64)
        || values[2] < 0.0
        || values[3] < 0.0
    {
        return Err(SurfaceError::Invalid("invalid Preview bounds".into()));
    }
    Ok((
        values[0].round() as i32,
        values[1].round() as i32,
        values[2].round() as i32,
        values[3].round() as i32,
    ))
}

fn modifiers() -> Mods {
    // SAFETY: GetKeyState accepts virtual-key codes and reads the calling thread's input state.
    let pressed = |key: u16| unsafe { GetKeyState(i32::from(key)) < 0 };
    Mods {
        ctrl: pressed(VK_CONTROL),
        alt: pressed(VK_MENU),
        shift: pressed(VK_SHIFT),
        meta: pressed(VK_LWIN) || pressed(VK_RWIN),
    }
}

fn key_names(vk: u32, shift: bool) -> (String, String) {
    if (0x41..=0x5a).contains(&vk) {
        let letter = char::from_u32(vk).unwrap_or('\u{fffd}');
        return (
            if shift {
                letter
            } else {
                letter.to_ascii_lowercase()
            }
            .to_string(),
            format!("Key{letter}"),
        );
    }
    if (0x30..=0x39).contains(&vk) {
        let digit = char::from_u32(vk).unwrap_or('\u{fffd}');
        return (digit.to_string(), format!("Digit{digit}"));
    }
    let name = match vk {
        0x08 => "Backspace",
        0x09 => "Tab",
        0x0d => "Enter",
        0x10 => "Shift",
        0x11 => "Control",
        0x12 => "Alt",
        0x1b => "Escape",
        0x20 => " ",
        0x21 => "PageUp",
        0x22 => "PageDown",
        0x23 => "End",
        0x24 => "Home",
        0x25 => "ArrowLeft",
        0x26 => "ArrowUp",
        0x27 => "ArrowRight",
        0x28 => "ArrowDown",
        0x2d => "Insert",
        0x2e => "Delete",
        _ => "Unidentified",
    };
    let code = match name {
        " " => "Space",
        "Shift" => "ShiftLeft",
        "Control" => "ControlLeft",
        "Alt" => "AltLeft",
        _ => name,
    };
    (name.to_owned(), code.to_owned())
}

fn ime_text(
    imc: windows_sys::Win32::UI::Input::Ime::HIMC,
    kind: u32,
) -> Result<Vec<u16>, SurfaceError> {
    // SAFETY: imc is acquired for the duration of this callback; a null buffer requests the byte count.
    let bytes = unsafe { ImmGetCompositionStringW(imc, kind, null_mut(), 0) };
    if bytes < 0 || bytes % 2 != 0 {
        return Err(native_error("read Preview IME text length"));
    }
    let mut text = vec![0u16; bytes as usize / 2];
    if bytes != 0 {
        // SAFETY: text has exactly bytes bytes of writable, aligned UTF-16 storage.
        let actual =
            unsafe { ImmGetCompositionStringW(imc, kind, text.as_mut_ptr().cast(), bytes as u32) };
        if actual != bytes {
            return Err(native_error("read Preview IME text"));
        }
    }
    Ok(text)
}

fn ime(context: &Context, hwnd: HWND, message: u32, flags: LPARAM) -> Result<(), SurfaceError> {
    if message == WM_IME_STARTCOMPOSITION {
        context.composition.set(Some(context.shared.key()));
        return Ok(());
    }
    let Some(key) = context.composition.get() else {
        return Ok(());
    };
    context.shared.check_key(key)?;
    if message == WM_IME_ENDCOMPOSITION {
        context.composition.set(None);
        return context.shared.input(Input::CancelIme);
    }
    // SAFETY: hwnd is valid during its callback and the IME context is always released below.
    let imc = unsafe { ImmGetContext(hwnd) };
    if imc.is_null() {
        return Err(native_error("acquire Preview IME context"));
    }
    let result = (|| {
        if flags as u32 & GCS_RESULTSTR != 0 {
            let text = String::from_utf16(&ime_text(imc, GCS_RESULTSTR)?)
                .map_err(|_| SurfaceError::Invalid("invalid UTF-16 IME result".into()))?;
            context.shared.check_key(key)?;
            context.shared.input(Input::CommitText {
                text,
                replacement: None,
            })?;
            context.composition.set(None);
        }
        if flags as u32 & GCS_COMPSTR != 0 {
            let text = ime_text(imc, GCS_COMPSTR)?;
            // SAFETY: GCS_CURSORPOS returns a position directly and does not access a buffer.
            let cursor = unsafe { ImmGetCompositionStringW(imc, GCS_CURSORPOS, null_mut(), 0) };
            if cursor < 0 || cursor as usize > text.len() {
                return Err(SurfaceError::Invalid("invalid Preview IME cursor".into()));
            }
            context.shared.check_key(key)?;
            context.composition.set(Some(key));
            context.shared.input(Input::Ime {
                utf16text: text,
                selection_start: cursor as u32,
                selection_end: cursor as u32,
                replacement: None,
            })?;
        }
        Ok(())
    })();
    // SAFETY: imc came from ImmGetContext for this hwnd above.
    unsafe {
        ImmReleaseContext(hwnd, imc);
    }
    result
}

fn touch(context: &Context, hwnd: HWND, message: u32, id: u32) -> Result<bool, SurfaceError> {
    if message == WM_POINTERCAPTURECHANGED {
        let points = {
            let mut touches = context.touches.borrow_mut();
            if touches.remove(&id).is_none() {
                return Ok(false);
            }
            touches.values().cloned().collect()
        };
        context.shared.input(Input::Touch {
            kind: TouchKind::Cancel,
            points,
            modifiers: modifiers(),
        })?;
        return Ok(true);
    }
    let mut kind = 0;
    // SAFETY: kind is writable storage and Windows owns the pointer ID for this callback.
    if unsafe { GetPointerType(id, &mut kind) } == 0 {
        return Err(native_error("read Preview pointer type"));
    }
    if kind != PT_TOUCH {
        return Ok(false);
    }
    let mut info = POINTER_TOUCH_INFO::default();
    // SAFETY: info is writable and id names the current touch pointer.
    if unsafe { GetPointerTouchInfo(id, &mut info) } == 0 {
        return Err(native_error("read Preview touch"));
    }
    let mut point = info.pointerInfo.ptPixelLocation;
    // SAFETY: hwnd is live and point contains screen coordinates supplied by Windows.
    if unsafe { ScreenToClient(hwnd, &mut point) } == 0 {
        return Err(native_error("convert Preview touch coordinates"));
    }
    let scale = context.shared.bounds().scale;
    let contact = info.touchMask & TOUCH_MASK_CONTACTAREA != 0;
    let touch = TouchPoint {
        id,
        x: f64::from(point.x) / scale,
        y: f64::from(point.y) / scale,
        radius_x: if contact {
            f64::from(info.rcContact.right - info.rcContact.left) / (2.0 * scale)
        } else {
            0.0
        },
        radius_y: if contact {
            f64::from(info.rcContact.bottom - info.rcContact.top) / (2.0 * scale)
        } else {
            0.0
        },
        pressure: if info.touchMask & TOUCH_MASK_PRESSURE != 0 {
            f64::from(info.pressure) / 1024.0
        } else {
            0.0
        },
    };
    let kind = if info.pointerInfo.pointerFlags & POINTER_FLAG_CANCELED != 0 {
        TouchKind::Cancel
    } else if message == WM_POINTERDOWN {
        TouchKind::Start
    } else if message == WM_POINTERUP {
        TouchKind::End
    } else {
        TouchKind::Move
    };
    let points = {
        let mut touches = context.touches.borrow_mut();
        touches.insert(id, touch);
        if matches!(kind, TouchKind::End | TouchKind::Cancel) {
            touches.remove(&id);
        }
        touches.values().cloned().collect()
    };
    context.shared.input(Input::Touch {
        kind,
        points,
        modifiers: modifiers(),
    })?;
    Ok(true)
}

fn cancel_composition(context: &Context, hwnd: HWND) -> Result<(), SurfaceError> {
    context.high_surrogate.set(None);
    context.touches.borrow_mut().clear();
    let Some(key) = context.composition.replace(None) else {
        return Ok(());
    };
    context.shared.check_key(key)?;
    // SAFETY: hwnd is a live UI-thread window and the IME context is released before returning.
    unsafe {
        let imc = ImmGetContext(hwnd);
        if imc.is_null() {
            return Err(native_error("acquire Preview IME context"));
        }
        let result = ImmNotifyIME(imc, NI_COMPOSITIONSTR, CPS_CANCEL, 0);
        ImmReleaseContext(hwnd, imc);
        if result == 0 {
            return Err(native_error("cancel Preview IME"));
        }
    }
    context.shared.input(Input::CancelIme)
}

fn client_point_dip(point: POINT, scale: f64) -> (f64, f64) {
    (f64::from(point.x) / scale, f64::from(point.y) / scale)
}

fn dispatch(context: &Context, hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> bool {
    let entry_key = context.shared.key();
    if message == WM_KILLFOCUS {
        if let Err(error) = cancel_composition(context, hwnd) {
            context.shared.report_error(error);
        }
    }
    if matches!(
        message,
        WM_POINTERDOWN | WM_POINTERUPDATE | WM_POINTERUP | WM_POINTERCAPTURECHANGED
    ) {
        return match touch(context, hwnd, message, (wparam & 0xffff) as u32) {
            Ok(handled) => handled,
            Err(error) => {
                context.shared.report_error(error);
                true
            }
        };
    }
    if message == WM_CHAR {
        let unit = wparam as u16;
        if (0xd800..=0xdbff).contains(&unit) {
            context.high_surrogate.set(Some(unit));
            return true;
        }
        let mut units = [0u16; 2];
        let text = if (0xdc00..=0xdfff).contains(&unit) {
            if let Some(high) = context.high_surrogate.take() {
                units[0] = high;
                units[1] = unit;
                String::from_utf16(&units)
            } else {
                context.shared.report_error(SurfaceError::Invalid(
                    "unpaired UTF-16 keyboard input".into(),
                ));
                return true;
            }
        } else {
            context.high_surrogate.set(None);
            String::from_utf16(&[unit])
        };
        match text {
            Ok(text) if !text.chars().any(char::is_control) => {
                if let Err(error) = context.shared.input(Input::CommitText {
                    text,
                    replacement: None,
                }) {
                    context.shared.report_error(error);
                }
            }
            Ok(_) => {}
            Err(_) => context.shared.report_error(SurfaceError::Invalid(
                "invalid UTF-16 keyboard input".into(),
            )),
        }
        return true;
    }
    let scale = context.shared.bounds().scale;
    if message == WM_MOUSELEAVE {
        context.mouse_position.set(None);
        let mut point = POINT { x: 0, y: 0 };
        // SAFETY: point is writable storage and hwnd is the live child handling this message.
        if unsafe { GetCursorPos(&mut point) } == 0 {
            context
                .shared
                .report_error(native_error("read Preview leave cursor position"));
            return true;
        }
        // SAFETY: point holds actual screen coordinates and hwnd is this same live child.
        if unsafe { ScreenToClient(hwnd, &mut point) } == 0 {
            context
                .shared
                .report_error(native_error("convert Preview leave coordinates"));
            return true;
        }
        let (x, y) = client_point_dip(point, scale);
        // SAFETY: GetKeyState reads this UI thread's actual mouse button state.
        let buttons = unsafe {
            u32::from(GetKeyState(i32::from(VK_LBUTTON)) < 0)
                | (u32::from(GetKeyState(i32::from(VK_RBUTTON)) < 0) << 1)
                | (u32::from(GetKeyState(i32::from(VK_MBUTTON)) < 0) << 2)
                | (u32::from(GetKeyState(i32::from(VK_XBUTTON1)) < 0) << 3)
                | (u32::from(GetKeyState(i32::from(VK_XBUTTON2)) < 0) << 4)
        };
        let event = Input::Mouse {
            kind: MouseKind::Move,
            x,
            y,
            button: MouseButton::None,
            buttons,
            click_count: 0,
            modifiers: modifiers(),
        };
        if let Err(error) = context
            .shared
            .check_key(entry_key)
            .and_then(|()| context.shared.input(event))
        {
            context.shared.report_error(error);
        }
        return true;
    }
    let mut point = POINT {
        x: (lparam as u16 as i16) as i32,
        y: ((lparam >> 16) as u16 as i16) as i32,
    };
    if message == WM_MOUSEWHEEL || message == WM_MOUSEHWHEEL {
        // SAFETY: point is valid writable storage and hwnd is live during its window procedure.
        if unsafe { ScreenToClient(hwnd, &mut point) } == 0 {
            context
                .shared
                .report_error(native_error("convert Preview wheel coordinates"));
            return true;
        }
    }
    let (x, y) = client_point_dip(point, scale);
    if message == WM_MOUSEMOVE {
        let entering = context.mouse_position.replace(Some((x, y))).is_none();
        if entering {
            let mut tracking = TRACKMOUSEEVENT {
                cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                dwFlags: TME_LEAVE,
                hwndTrack: hwnd,
                dwHoverTime: 0,
            };
            // SAFETY: tracking is initialized and hwnd is the live child processing this event.
            if unsafe { TrackMouseEvent(&mut tracking) } == 0 {
                context
                    .shared
                    .report_error(native_error("track Preview mouse leave"));
            }
            let flags = wparam as u32;
            let buttons = (flags & 3) | ((flags & 16) >> 2) | ((flags & 96) >> 2);
            let event = Input::Mouse {
                kind: MouseKind::Enter,
                x,
                y,
                button: MouseButton::None,
                buttons,
                click_count: 0,
                modifiers: modifiers(),
            };
            if let Err(error) = context
                .shared
                .check_key(entry_key)
                .and_then(|()| context.shared.input(event))
            {
                context.shared.report_error(error);
            }
        }
    }
    let input = match message {
        WM_SETFOCUS => Input::Focus(true),
        WM_KILLFOCUS => Input::Focus(false),
        WM_KEYDOWN | WM_KEYUP | WM_SYSKEYDOWN | WM_SYSKEYUP => {
            let modifiers = modifiers();
            let vk = wparam as u32;
            let (key, code) = key_names(vk, modifiers.shift);
            Input::Key {
                kind: if message == WM_KEYDOWN || message == WM_SYSKEYDOWN {
                    KeyKind::Down
                } else {
                    KeyKind::Up
                },
                key,
                code,
                windows_virtual_key_code: vk,
                native_virtual_key_code: ((lparam >> 16) & 0xff) as u32,
                modifiers,
                text: None,
                repeat: (lparam & (1 << 30)) != 0,
            }
        }
        WM_COPY => Input::Edit(EditCommand::Copy),
        WM_CUT => Input::Edit(EditCommand::Cut),
        WM_PASTE => Input::Edit(EditCommand::Paste),
        WM_UNDO => Input::Edit(EditCommand::Undo),
        WM_MOUSEMOVE | WM_LBUTTONDOWN | WM_LBUTTONUP | WM_LBUTTONDBLCLK | WM_RBUTTONDOWN
        | WM_RBUTTONUP | WM_RBUTTONDBLCLK | WM_MBUTTONDOWN | WM_MBUTTONUP | WM_MBUTTONDBLCLK
        | WM_XBUTTONDOWN | WM_XBUTTONUP | WM_XBUTTONDBLCLK => {
            let (kind, button, clicks) = match message {
                WM_LBUTTONDOWN | WM_LBUTTONDBLCLK => (
                    MouseKind::Down,
                    MouseButton::Left,
                    if message == WM_LBUTTONDBLCLK { 2 } else { 1 },
                ),
                WM_LBUTTONUP => (MouseKind::Up, MouseButton::Left, 1),
                WM_RBUTTONDOWN | WM_RBUTTONDBLCLK => (
                    MouseKind::Down,
                    MouseButton::Right,
                    if message == WM_RBUTTONDBLCLK { 2 } else { 1 },
                ),
                WM_RBUTTONUP => (MouseKind::Up, MouseButton::Right, 1),
                WM_MBUTTONDOWN | WM_MBUTTONDBLCLK => (
                    MouseKind::Down,
                    MouseButton::Middle,
                    if message == WM_MBUTTONDBLCLK { 2 } else { 1 },
                ),
                WM_MBUTTONUP => (MouseKind::Up, MouseButton::Middle, 1),
                WM_XBUTTONDOWN | WM_XBUTTONDBLCLK | WM_XBUTTONUP => {
                    let button = if (wparam >> 16) as u16 == 1 {
                        MouseButton::Back
                    } else {
                        MouseButton::Forward
                    };
                    (
                        if message == WM_XBUTTONUP {
                            MouseKind::Up
                        } else {
                            MouseKind::Down
                        },
                        button,
                        if message == WM_XBUTTONDBLCLK { 2 } else { 1 },
                    )
                }
                _ => (MouseKind::Move, MouseButton::None, 0),
            };
            let flags = wparam as u32;
            let buttons = (flags & 3) | ((flags & 16) >> 2) | ((flags & 96) >> 2);
            if kind == MouseKind::Down {
                // SAFETY: hwnd is the live window processing this mouse message.
                unsafe {
                    SetFocus(hwnd);
                }
                if context.hwnd.get() != hwnd || context.shared.check_key(entry_key).is_err() {
                    return true;
                }
                // SAFETY: focus callbacks did not destroy the window or change the document.
                unsafe {
                    SetCapture(hwnd);
                }
            } else if kind == MouseKind::Up && buttons == 0 {
                // SAFETY: capture is released only when this window currently owns it.
                unsafe {
                    if GetCapture() == hwnd {
                        ReleaseCapture();
                    }
                }
            }
            Input::Mouse {
                kind,
                x,
                y,
                button,
                buttons,
                click_count: clicks,
                modifiers: modifiers(),
            }
        }
        WM_MOUSEWHEEL | WM_MOUSEHWHEEL => {
            let delta = f64::from((wparam >> 16) as u16 as i16) / 120.0;
            Input::Wheel {
                x,
                y,
                delta_x: if message == WM_MOUSEHWHEEL {
                    delta
                } else {
                    0.0
                },
                delta_y: if message == WM_MOUSEWHEEL {
                    -delta
                } else {
                    0.0
                },
                unit: WheelUnit::Line,
                modifiers: modifiers(),
            }
        }
        _ => return false,
    };
    if let Err(error) = context
        .shared
        .check_key(entry_key)
        .and_then(|()| context.shared.input(input))
    {
        context.shared.report_error(error);
    }
    true
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_NCCREATE {
        // SAFETY: Windows supplies a valid CREATESTRUCTW for WM_NCCREATE. The caller retains the Rc through creation.
        let context =
            unsafe { (*(lparam as *const CREATESTRUCTW)).lpCreateParams as *const Context };
        if context.is_null() {
            return 0;
        }
        // SAFETY: the pointer comes from Rc::as_ptr and is live until CreateWindowExW returns.
        unsafe {
            Rc::increment_strong_count(context);
        }
        // SAFETY: GWLP_USERDATA is reserved for this window's context pointer.
        unsafe {
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, context as isize);
        }
        // SAFETY: context is held by both the caller and the newly acquired window reference.
        unsafe {
            (*context).hwnd.set(hwnd);
        }
    } else if message == WM_NCDESTROY {
        // SAFETY: this window alone owns GWLP_USERDATA.
        let context = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const Context };
        if !context.is_null() {
            // SAFETY: remove the pointer before releasing the one reference acquired in WM_NCCREATE.
            unsafe {
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
            }
            // SAFETY: the stored pointer owns exactly one strong count until this message.
            let owned = unsafe { Rc::from_raw(context) };
            owned.hwnd.set(null_mut());
            if let Err(error) = owned.shared.close() {
                owned.shared.report_error(error);
            }
        }
    }
    if message != WM_NCCREATE && message != WM_NCDESTROY {
        // SAFETY: the window holds one strong Rc count in GWLP_USERDATA until WM_NCDESTROY.
        let pointer = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const Context };
        if !pointer.is_null() {
            // SAFETY: retain the context across callbacks, which may synchronously destroy the window.
            unsafe {
                Rc::increment_strong_count(pointer);
            }
            // SAFETY: the increment above transfers one strong count to this Rc.
            let context = unsafe { Rc::from_raw(pointer) };
            if message == WM_GETOBJECT && lparam as i32 == UiaRootObjectId {
                if let Some(tree) = context.shared.ax_tree() {
                    if let Some(id) = tree.snapshot.root_id.as_deref() {
                        match Provider::new(context.shared.clone(), hwnd, id) {
                            Ok(provider) => {
                                let raw: RawSimple = provider.into();
                                let provider: IRawElementProviderSimple = match raw.cast() {
                                    Ok(value) => value,
                                    Err(error) => {
                                        context.shared.report_error(SurfaceError::Native(format!(
                                            "query Preview UIA provider: {error}"
                                        )));
                                        return 0;
                                    }
                                };
                                // SAFETY: UIA receives this live child HWND and a COM provider for its actual root.
                                return unsafe {
                                    UiaReturnRawElementProvider(
                                        WinHwnd(hwnd),
                                        WinWparam(wparam),
                                        WinLparam(lparam),
                                        &provider,
                                    )
                                    .0
                                };
                            }
                            Err(error) => context.shared.report_error(SurfaceError::Native(
                                format!("create Preview UIA provider: {error}"),
                            )),
                        }
                    }
                }
                return 0;
            }
            if matches!(
                message,
                WM_IME_STARTCOMPOSITION | WM_IME_COMPOSITION | WM_IME_ENDCOMPOSITION
            ) {
                if let Err(error) = ime(&context, hwnd, message, lparam) {
                    context.shared.report_error(error);
                }
                return 0;
            }
            if message == WM_PAINT {
                let mut paint = PAINTSTRUCT::default();
                // SAFETY: BeginPaint and EndPaint are paired during this WM_PAINT.
                let dc = unsafe { BeginPaint(hwnd, &mut paint) };
                let result = if dc.is_null() {
                    Err(native_error("begin Preview paint"))
                } else {
                    let pixels = context.pixels.borrow();
                    pixels
                        .as_ref()
                        .map_or(Ok(()), |pixels| draw(hwnd, dc, pixels))
                };
                // SAFETY: paint was initialized by BeginPaint above.
                unsafe {
                    EndPaint(hwnd, &paint);
                }
                if let Err(error) = result {
                    context.shared.report_error(error);
                }
                return 0;
            }
            if dispatch(&context, hwnd, message, wparam, lparam) {
                return if matches!(message, WM_XBUTTONDOWN | WM_XBUTTONUP | WM_XBUTTONDBLCLK) {
                    1
                } else {
                    0
                };
            }
        }
    }
    // SAFETY: all unhandled messages are delegated to the documented default window procedure.
    unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}

fn uia_unavailable() -> windows::core::Error {
    windows::core::Error::from(HRESULT(UIA_E_ELEMENTNOTAVAILABLE as i32))
}

fn uia_unsupported() -> windows::core::Error {
    windows::core::Error::from(HRESULT(0x80004001u32 as i32))
}

#[windows::core::interface("d6dd68d1-86fd-4332-8666-9abedea2d24c")]
unsafe trait RawSimple: IUnknown {
    fn ProviderOptions(&self, result: *mut ProviderOptions) -> HRESULT;
    fn GetPatternProvider(&self, pattern: UIA_PATTERN_ID, result: *mut *mut c_void) -> HRESULT;
    fn GetPropertyValue(&self, property: UIA_PROPERTY_ID, result: *mut VARIANT) -> HRESULT;
    fn HostRawElementProvider(&self, result: *mut *mut c_void) -> HRESULT;
}

#[windows::core::interface("f7063da8-8359-439c-9297-bbc5299a7d87")]
unsafe trait RawFragment: IUnknown {
    fn Navigate(&self, direction: NavigateDirection, result: *mut *mut c_void) -> HRESULT;
    fn GetRuntimeId(&self, result: *mut *mut SAFEARRAY) -> HRESULT;
    fn BoundingRectangle(&self, result: *mut UiaRect) -> HRESULT;
    fn GetEmbeddedFragmentRoots(&self, result: *mut *mut SAFEARRAY) -> HRESULT;
    fn SetFocus(&self) -> HRESULT;
    fn FragmentRoot(&self, result: *mut *mut c_void) -> HRESULT;
}

#[windows::core::interface("620ce2a5-ab8f-40a9-86cb-de3c75599b58")]
unsafe trait RawRoot: IUnknown {
    fn ElementProviderFromPoint(&self, x: f64, y: f64, result: *mut *mut c_void) -> HRESULT;
    fn GetFocus(&self, result: *mut *mut c_void) -> HRESULT;
}

unsafe fn write_interface<T: Interface>(
    output: *mut *mut c_void,
    value: windows::core::Result<T>,
    optional: bool,
) -> HRESULT {
    if output.is_null() {
        return HRESULT(0x80004003u32 as i32);
    }
    // SAFETY: output is a non-null COM out parameter supplied by the caller.
    unsafe {
        output.write(null_mut());
    }
    match value {
        Ok(value) => {
            // SAFETY: output is valid and ownership of the COM reference transfers to its caller.
            unsafe {
                output.write(value.into_raw());
            }
            HRESULT(0)
        }
        Err(error) if optional && error.code() == HRESULT(0x80004001u32 as i32) => HRESULT(0),
        Err(error) => error.into(),
    }
}

unsafe fn write_value<T>(output: *mut T, value: windows::core::Result<T>) -> HRESULT {
    if output.is_null() {
        return HRESULT(0x80004003u32 as i32);
    }
    match value {
        Ok(value) => {
            // SAFETY: output is a non-null COM out parameter supplied by the caller.
            unsafe {
                output.write(value);
            }
            HRESULT(0)
        }
        Err(error) => error.into(),
    }
}

impl RawSimple_Impl for Provider_Impl {
    unsafe fn ProviderOptions(&self, result: *mut ProviderOptions) -> HRESULT {
        // SAFETY: the COM caller provides the output pointer.
        unsafe {
            write_value(
                result,
                IRawElementProviderSimple_Impl::ProviderOptions(self),
            )
        }
    }
    unsafe fn GetPatternProvider(
        &self,
        pattern: UIA_PATTERN_ID,
        result: *mut *mut c_void,
    ) -> HRESULT {
        // SAFETY: the COM caller provides the output pointer.
        unsafe {
            write_interface(
                result,
                IRawElementProviderSimple_Impl::GetPatternProvider(self, pattern),
                true,
            )
        }
    }
    unsafe fn GetPropertyValue(&self, property: UIA_PROPERTY_ID, result: *mut VARIANT) -> HRESULT {
        // SAFETY: the COM caller provides the output pointer.
        unsafe {
            write_value(
                result,
                IRawElementProviderSimple_Impl::GetPropertyValue(self, property),
            )
        }
    }
    unsafe fn HostRawElementProvider(&self, result: *mut *mut c_void) -> HRESULT {
        // SAFETY: the COM caller provides the output pointer.
        unsafe {
            write_interface(
                result,
                IRawElementProviderSimple_Impl::HostRawElementProvider(self),
                true,
            )
        }
    }
}

impl RawFragment_Impl for Provider_Impl {
    unsafe fn Navigate(&self, direction: NavigateDirection, result: *mut *mut c_void) -> HRESULT {
        // SAFETY: the COM caller provides the output pointer.
        unsafe {
            write_interface(
                result,
                IRawElementProviderFragment_Impl::Navigate(self, direction),
                true,
            )
        }
    }
    unsafe fn GetRuntimeId(&self, result: *mut *mut SAFEARRAY) -> HRESULT {
        // SAFETY: the COM caller provides the output pointer.
        unsafe { write_value(result, IRawElementProviderFragment_Impl::GetRuntimeId(self)) }
    }
    unsafe fn BoundingRectangle(&self, result: *mut UiaRect) -> HRESULT {
        // SAFETY: the COM caller provides the output pointer.
        unsafe {
            write_value(
                result,
                IRawElementProviderFragment_Impl::BoundingRectangle(self),
            )
        }
    }
    unsafe fn GetEmbeddedFragmentRoots(&self, result: *mut *mut SAFEARRAY) -> HRESULT {
        // SAFETY: the COM caller provides the output pointer.
        unsafe {
            write_value(
                result,
                IRawElementProviderFragment_Impl::GetEmbeddedFragmentRoots(self),
            )
        }
    }
    unsafe fn SetFocus(&self) -> HRESULT {
        IRawElementProviderFragment_Impl::SetFocus(self).into()
    }
    unsafe fn FragmentRoot(&self, result: *mut *mut c_void) -> HRESULT {
        // SAFETY: the COM caller provides the output pointer.
        unsafe {
            write_interface(
                result,
                IRawElementProviderFragment_Impl::FragmentRoot(self),
                false,
            )
        }
    }
}

impl RawRoot_Impl for Provider_Impl {
    unsafe fn ElementProviderFromPoint(&self, x: f64, y: f64, result: *mut *mut c_void) -> HRESULT {
        // SAFETY: the COM caller provides the output pointer.
        unsafe {
            write_interface(
                result,
                IRawElementProviderFragmentRoot_Impl::ElementProviderFromPoint(self, x, y),
                true,
            )
        }
    }
    unsafe fn GetFocus(&self, result: *mut *mut c_void) -> HRESULT {
        // SAFETY: the COM caller provides the output pointer.
        unsafe {
            write_interface(
                result,
                IRawElementProviderFragmentRoot_Impl::GetFocus(self),
                true,
            )
        }
    }
}

#[implement(
    RawSimple,
    RawFragment,
    RawRoot,
    IInvokeProvider,
    IValueProvider,
    RawTextProvider
)]
struct Provider {
    shared: Arc<Shared>,
    hwnd: isize,
    key: SurfaceKey,
    id: String,
    frame: Option<String>,
    backend: Option<i64>,
}

impl Provider {
    fn new(shared: Arc<Shared>, hwnd: HWND, id: &str) -> windows::core::Result<Self> {
        let tree = shared.ax_tree().ok_or_else(uia_unavailable)?;
        let node = tree.node(id).ok_or_else(uia_unavailable)?;
        let result = Self {
            shared: shared.clone(),
            hwnd: hwnd as isize,
            key: tree.snapshot.key,
            id: id.to_owned(),
            frame: node.frame_id.clone(),
            backend: node.backend_dom_node_id,
        };
        shared
            .check_key(result.key)
            .map_err(|_| uia_unavailable())?;
        Ok(result)
    }

    fn with_node<T>(
        &self,
        f: impl FnOnce(&AxNode, &super::super::shared::AxTree) -> windows::core::Result<T>,
    ) -> windows::core::Result<T> {
        self.shared
            .check_key(self.key)
            .map_err(|_| uia_unavailable())?;
        let tree = self.shared.ax_tree().ok_or_else(uia_unavailable)?;
        if tree.snapshot.key != self.key || tree.snapshot.generation != self.key.generation {
            return Err(uia_unavailable());
        }
        let node = tree.node(&self.id).ok_or_else(uia_unavailable)?;
        if node.frame_id != self.frame || node.backend_dom_node_id != self.backend {
            return Err(uia_unavailable());
        }
        f(node, &tree)
    }

    fn related(&self, id: &str) -> windows::core::Result<Self> {
        let provider = Self::new(self.shared.clone(), self.hwnd as HWND, id)?;
        if provider.key != self.key
            || (id == self.id && (provider.backend != self.backend || provider.frame != self.frame))
        {
            return Err(uia_unavailable());
        }
        self.shared
            .check_key(self.key)
            .map_err(|_| uia_unavailable())?;
        Ok(provider)
    }

    fn fragment(&self, id: &str) -> windows::core::Result<IRawElementProviderFragment> {
        let raw: RawFragment = self.related(id)?.into();
        raw.cast()
    }

    fn text_data(&self) -> windows::core::Result<(Option<Vec<u16>>, u32, Option<ModelTextRange>)> {
        self.with_node(|node, _| {
            let text = self.shared.text_input_state().filter(|text| {
                text.key == self.key
                    && text.backend_dom_node_id == node.backend_dom_node_id
                    && node.backend_dom_node_id.is_some()
            });
            if let Some(text) = text {
                let (content, length) = match &text.content {
                    TextContent::Plain(value) if !node.secure => {
                        let units: Vec<_> = value.encode_utf16().collect();
                        let length = u32::try_from(units.len()).map_err(|_| uia_unavailable())?;
                        (Some(units), length)
                    }
                    TextContent::Protected { utf16_length } => (None, *utf16_length),
                    _ => return Err(uia_unavailable()),
                };
                Ok((content, length, Some(text.selection)))
            } else if let AxValue::Text(value) = &node.value {
                if node.secure {
                    return Err(uia_unavailable());
                }
                let units: Vec<_> = value.encode_utf16().collect();
                let length = u32::try_from(units.len()).map_err(|_| uia_unavailable())?;
                Ok((Some(units), length, node.selected_text_range))
            } else {
                Err(uia_unavailable())
            }
        })
    }

    fn action(&self, action: AxAction) -> windows::core::Result<()> {
        self.with_node(|node, tree| {
            let target = AxTarget {
                node_id: node.node_id.clone(),
                frame_id: node.frame_id.clone(),
                backend_dom_node_id: node.backend_dom_node_id.ok_or_else(uia_unsupported)?,
            };
            self.shared
                .accessibility(tree.snapshot.generation, target, action)
                .map_err(|error| {
                    self.shared.report_error(error);
                    uia_unavailable()
                })
        })
    }

    fn query(&self, query: TextQuery) -> windows::core::Result<TextReply> {
        self.with_node(|node, tree| {
            let target = AxTarget {
                node_id: node.node_id.clone(),
                frame_id: node.frame_id.clone(),
                backend_dom_node_id: node.backend_dom_node_id.ok_or_else(uia_unsupported)?,
            };
            self.shared
                .text_query(tree.snapshot.generation, target, query)
                .map_err(|error| {
                    self.shared.report_error(error);
                    uia_unavailable()
                })
        })
    }
}

impl IRawElementProviderSimple_Impl for Provider_Impl {
    fn ProviderOptions(&self) -> windows::core::Result<ProviderOptions> {
        self.with_node(|_, _| Ok(ProviderOptions_ServerSideProvider))
    }
    fn GetPatternProvider(&self, pattern: UIA_PATTERN_ID) -> windows::core::Result<IUnknown> {
        self.with_node(|node, _| {
            if pattern == UIA_InvokePatternId && node.actions.contains(&AxActionKind::Default) {
                let value: IInvokeProvider = self.related(&self.id)?.into();
                value.cast()
            } else if pattern == UIA_ValuePatternId
                && !node.secure
                && matches!(&node.value, AxValue::Text(_))
            {
                let value: IValueProvider = self.related(&self.id)?.into();
                value.cast()
            } else if pattern == UIA_TextPatternId && node.editable && self.text_data().is_ok() {
                let value: RawTextProvider = self.related(&self.id)?.into();
                value.cast()
            } else {
                Err(uia_unsupported())
            }
        })
    }

    fn GetPropertyValue(&self, property: UIA_PROPERTY_ID) -> windows::core::Result<VARIANT> {
        self.with_node(|node, _| {
            let result = if property == UIA_NamePropertyId {
                VARIANT::from(node.name.as_deref().unwrap_or(""))
            } else if property == UIA_HelpTextPropertyId {
                VARIANT::from(node.description.as_deref().unwrap_or(""))
            } else if property == UIA_AutomationIdPropertyId {
                VARIANT::from(node.node_id.as_str())
            } else if property == UIA_IsEnabledPropertyId {
                VARIANT::from(!node.disabled)
            } else if property == UIA_IsKeyboardFocusablePropertyId {
                VARIANT::from(node.focusable)
            } else if property == UIA_HasKeyboardFocusPropertyId {
                VARIANT::from(node.focused)
            } else if property == UIA_IsPasswordPropertyId {
                VARIANT::from(node.secure)
            } else if property == UIA_IsRequiredForFormPropertyId {
                VARIANT::from(node.required)
            } else if property == UIA_SelectionItemIsSelectedPropertyId {
                VARIANT::from(node.selected)
            } else if property == UIA_ValueIsReadOnlyPropertyId {
                VARIANT::from(node.read_only)
            } else if property == UIA_ValueValuePropertyId && !node.secure {
                match &node.value {
                    AxValue::Text(text) => VARIANT::from(text.as_str()),
                    _ => VARIANT::default(),
                }
            } else if property == UIA_ExpandCollapseExpandCollapseStatePropertyId {
                node.expanded.map_or_else(VARIANT::default, |value| {
                    VARIANT::from(if value {
                        ExpandCollapseState_Expanded.0
                    } else {
                        ExpandCollapseState_Collapsed.0
                    })
                })
            } else if property == UIA_ToggleToggleStatePropertyId {
                node.checked.map_or_else(VARIANT::default, |value| {
                    VARIANT::from(match value {
                        super::super::model::Checked::Off => ToggleState_Off.0,
                        super::super::model::Checked::On => ToggleState_On.0,
                        super::super::model::Checked::Mixed => ToggleState_Indeterminate.0,
                    })
                })
            } else if property == UIA_ControlTypePropertyId {
                let control = match node.role.as_str() {
                    "button" => UIA_ButtonControlTypeId,
                    "checkbox" => UIA_CheckBoxControlTypeId,
                    "combobox" => UIA_ComboBoxControlTypeId,
                    "textbox" | "searchbox" => UIA_EditControlTypeId,
                    "link" => UIA_HyperlinkControlTypeId,
                    "image" => UIA_ImageControlTypeId,
                    "list" => UIA_ListControlTypeId,
                    "listitem" => UIA_ListItemControlTypeId,
                    "menu" => UIA_MenuControlTypeId,
                    "tablist" => UIA_TabControlTypeId,
                    "table" | "grid" => UIA_TableControlTypeId,
                    "tree" => UIA_TreeControlTypeId,
                    "slider" => UIA_SliderControlTypeId,
                    "progressbar" => UIA_ProgressBarControlTypeId,
                    "document" | "RootWebArea" => UIA_DocumentControlTypeId,
                    "StaticText" => UIA_TextControlTypeId,
                    _ => UIA_CustomControlTypeId,
                };
                VARIANT::from(control.0)
            } else {
                VARIANT::default()
            };
            Ok(result)
        })
    }

    fn HostRawElementProvider(&self) -> windows::core::Result<IRawElementProviderSimple> {
        self.with_node(|_, tree| {
            if tree.snapshot.root_id.as_deref() != Some(self.id.as_str()) {
                return Err(uia_unsupported());
            }
            // SAFETY: the HWND is the live window captured by the provider and checked through Shared.
            unsafe { UiaHostProviderFromHwnd(WinHwnd(self.hwnd as *mut c_void)) }
        })
    }
}

impl IInvokeProvider_Impl for Provider_Impl {
    fn Invoke(&self) -> windows::core::Result<()> {
        self.action(AxAction::Default)
    }
}

impl IValueProvider_Impl for Provider_Impl {
    fn SetValue(&self, value: &PCWSTR) -> windows::core::Result<()> {
        // SAFETY: UI Automation supplies a valid NUL-terminated string for this COM call.
        let value = unsafe { value.to_string() }.map_err(|_| uia_unsupported())?;
        self.action(AxAction::SetValue(value))
    }
    fn Value(&self) -> windows::core::Result<BSTR> {
        self.with_node(|node, _| match &node.value {
            AxValue::Text(value) if !node.secure => Ok(BSTR::from(value.as_str())),
            _ => Err(uia_unsupported()),
        })
    }
    fn IsReadOnly(&self) -> windows::core::Result<BOOL> {
        self.with_node(|node, _| {
            Ok(BOOL::from(
                node.read_only || !node.actions.contains(&AxActionKind::SetValue),
            ))
        })
    }
}

impl IRawElementProviderFragment_Impl for Provider_Impl {
    fn Navigate(
        &self,
        direction: NavigateDirection,
    ) -> windows::core::Result<IRawElementProviderFragment> {
        self.with_node(|node, tree| {
            let id = if direction == NavigateDirection_Parent {
                tree.parent(&self.id)
            } else if direction == NavigateDirection_FirstChild {
                node.children.first().map(String::as_str)
            } else if direction == NavigateDirection_LastChild {
                node.children.last().map(String::as_str)
            } else {
                let parent = tree.parent(&self.id).and_then(|id| tree.node(id));
                parent.and_then(|parent| {
                    let index = parent.children.iter().position(|id| id == &self.id)?;
                    let next = if direction == NavigateDirection_NextSibling {
                        index.checked_add(1)
                    } else if direction == NavigateDirection_PreviousSibling {
                        index.checked_sub(1)
                    } else {
                        None
                    }?;
                    parent.children.get(next).map(String::as_str)
                })
            };
            self.fragment(id.ok_or_else(uia_unsupported)?)
        })
    }

    fn GetRuntimeId(&self) -> windows::core::Result<*mut SAFEARRAY> {
        self.with_node(|_, _| {
            let mut values = vec![
                UiaAppendRuntimeId as i32,
                self.key.generation as i32,
                (self.key.generation >> 32) as i32,
            ];
            values.extend(self.id.encode_utf16().map(i32::from));
            // SAFETY: SafeArrayCreateVector allocates a one-dimensional array of the requested size.
            let array = unsafe { SafeArrayCreateVector(VT_I4, 0, values.len() as u32) };
            if array.is_null() {
                return Err(uia_unavailable());
            }
            for (index, value) in values.iter().enumerate() {
                let index = index as i32;
                // SAFETY: index is within the allocated array and value points to a valid i32.
                if let Err(error) =
                    unsafe { SafeArrayPutElement(array, &index, (value as *const i32).cast()) }
                {
                    // SAFETY: array is still owned locally after the failed insertion.
                    let _ = unsafe { SafeArrayDestroy(array) };
                    return Err(error);
                }
            }
            Ok(array)
        })
    }

    fn BoundingRectangle(&self) -> windows::core::Result<UiaRect> {
        self.with_node(|node, _| {
            let bounds = node.bounds.ok_or_else(uia_unavailable)?;
            let scale = self.shared.bounds().scale;
            let mut origin = POINT { x: 0, y: 0 };
            // SAFETY: the HWND belongs to this provider and origin is writable.
            if unsafe {
                windows_sys::Win32::Graphics::Gdi::ClientToScreen(self.hwnd as HWND, &mut origin)
            } == 0
            {
                return Err(uia_unavailable());
            }
            Ok(UiaRect {
                left: f64::from(origin.x) + bounds.x * scale,
                top: f64::from(origin.y) + bounds.y * scale,
                width: bounds.width * scale,
                height: bounds.height * scale,
            })
        })
    }

    fn GetEmbeddedFragmentRoots(&self) -> windows::core::Result<*mut SAFEARRAY> {
        self.with_node(|_, _| Ok(null_mut()))
    }

    fn SetFocus(&self) -> windows::core::Result<()> {
        self.action(AxAction::Focus)
    }

    fn FragmentRoot(&self) -> windows::core::Result<IRawElementProviderFragmentRoot> {
        self.with_node(|_, tree| {
            let id = tree
                .snapshot
                .root_id
                .as_deref()
                .ok_or_else(uia_unavailable)?;
            let raw: RawRoot = self.related(id)?.into();
            raw.cast()
        })
    }
}

impl IRawElementProviderFragmentRoot_Impl for Provider_Impl {
    fn ElementProviderFromPoint(
        &self,
        x: f64,
        y: f64,
    ) -> windows::core::Result<IRawElementProviderFragment> {
        self.with_node(|_, tree| {
            let scale = self.shared.bounds().scale;
            let mut origin = POINT { x: 0, y: 0 };
            // SAFETY: the live HWND and writable point are valid for ClientToScreen.
            if unsafe {
                windows_sys::Win32::Graphics::Gdi::ClientToScreen(self.hwnd as HWND, &mut origin)
            } == 0
            {
                return Err(uia_unavailable());
            }
            let px = (x - f64::from(origin.x)) / scale;
            let py = (y - f64::from(origin.y)) / scale;
            let contains = |node: &AxNode| {
                node.bounds.is_some_and(|r| {
                    px >= r.x && py >= r.y && px < r.x + r.width && py < r.y + r.height
                })
            };
            let mut candidate: Option<&AxNode> = None;
            for node in tree.snapshot.nodes.iter().filter(|node| contains(node)) {
                if let Some(previous) = candidate {
                    let mut parent = tree.parent(&node.node_id);
                    let mut node_inside_previous = false;
                    while let Some(id) = parent {
                        if id == previous.node_id {
                            node_inside_previous = true;
                            break;
                        }
                        parent = tree.parent(id);
                    }
                    if node_inside_previous {
                        candidate = Some(node);
                        continue;
                    }
                    let mut parent = tree.parent(&previous.node_id);
                    let mut previous_inside_node = false;
                    while let Some(id) = parent {
                        if id == node.node_id {
                            previous_inside_node = true;
                            break;
                        }
                        parent = tree.parent(id);
                    }
                    if !previous_inside_node {
                        return Err(uia_unavailable());
                    }
                } else {
                    candidate = Some(node);
                }
            }
            self.fragment(&candidate.ok_or_else(uia_unsupported)?.node_id)
        })
    }

    fn GetFocus(&self) -> windows::core::Result<IRawElementProviderFragment> {
        self.with_node(|_, tree| {
            let node = tree
                .snapshot
                .nodes
                .iter()
                .find(|node| node.focused)
                .ok_or_else(uia_unsupported)?;
            self.fragment(&node.node_id)
        })
    }
}

fn text_range(
    provider: &Provider,
    range: ModelTextRange,
) -> windows::core::Result<ITextRangeProvider> {
    let (_, length, _) = provider.text_data()?;
    if range.start > length || range.length > length - range.start {
        return Err(uia_unavailable());
    }
    let provider = provider.related(&provider.id)?;
    let raw: RawTextRange = TextRangeProvider {
        provider,
        range: Mutex::new(range),
    }
    .into();
    raw.cast()
}

fn ranges_array(
    provider: &Provider,
    ranges: &[ModelTextRange],
) -> windows::core::Result<*mut SAFEARRAY> {
    let count = u32::try_from(ranges.len()).map_err(|_| uia_unavailable())?;
    // SAFETY: the array is populated only with live COM text ranges and owns their references.
    unsafe {
        let array = SafeArrayCreateVector(VT_UNKNOWN, 0, count);
        if array.is_null() {
            return Err(uia_unavailable());
        }
        for (index, range) in ranges.iter().enumerate() {
            let item = match text_range(provider, *range) {
                Ok(item) => item,
                Err(error) => {
                    let _ = SafeArrayDestroy(array);
                    return Err(error);
                }
            };
            if let Err(error) = SafeArrayPutElement(array, &(index as i32), item.as_raw()) {
                let _ = SafeArrayDestroy(array);
                return Err(error);
            }
        }
        Ok(array)
    }
}

impl Provider {
    fn text_selection(&self) -> windows::core::Result<*mut SAFEARRAY> {
        let (_, _, selection) = self.text_data()?;
        ranges_array(self, &[selection.ok_or_else(uia_unavailable)?])
    }
    fn text_visible_ranges(&self) -> windows::core::Result<*mut SAFEARRAY> {
        match self.query(TextQuery::VisibleRanges)? {
            TextReply::Ranges(ranges) => ranges_array(self, &ranges),
            _ => Err(uia_unavailable()),
        }
    }
    fn text_range_from_child(
        &self,
        child: Option<&IRawElementProviderSimple>,
    ) -> windows::core::Result<Option<ITextRangeProvider>> {
        let child = child.ok_or_else(uia_unsupported)?.cast::<RawSimple>()?;
        if !child.is_object::<Provider>() {
            return Err(uia_unsupported());
        }
        // SAFETY: is_object verified this COM interface belongs to our Provider implementation.
        let child = unsafe { <RawSimple as windows::core::AsImpl<Provider>>::as_impl(&child) };
        child.with_node(|node, _| {
            if child.key != self.key {
                return Err(uia_unavailable());
            }
            let target = AxTarget {
                node_id: node.node_id.clone(),
                frame_id: node.frame_id.clone(),
                backend_dom_node_id: node.backend_dom_node_id.ok_or_else(uia_unsupported)?,
            };
            match self.query(TextQuery::RangeFromChild { child: target })? {
                TextReply::Range(Some(range)) => Ok(Some(text_range(self, range)?)),
                TextReply::Range(None) => Ok(None),
                _ => Err(uia_unavailable()),
            }
        })
    }
    fn text_range_from_point(
        &self,
        point: UiaPoint,
    ) -> windows::core::Result<Option<ITextRangeProvider>> {
        self.shared
            .check_key(self.key)
            .map_err(|_| uia_unavailable())?;
        let mut origin = POINT { x: 0, y: 0 };
        // SAFETY: the child HWND is live and origin is writable.
        if unsafe {
            windows_sys::Win32::Graphics::Gdi::ClientToScreen(self.hwnd as HWND, &mut origin)
        } == 0
        {
            return Err(uia_unavailable());
        }
        let scale = self.shared.bounds().scale;
        match self.query(TextQuery::OffsetAtPoint {
            x: (point.x - f64::from(origin.x)) / scale,
            y: (point.y - f64::from(origin.y)) / scale,
        })? {
            TextReply::Offset(Some(start)) => {
                Ok(Some(text_range(self, ModelTextRange { start, length: 0 })?))
            }
            TextReply::Offset(None) => Ok(None),
            _ => Err(uia_unavailable()),
        }
    }
    fn text_document_range(&self) -> windows::core::Result<ITextRangeProvider> {
        let (_, length, _) = self.text_data()?;
        text_range(self, ModelTextRange { start: 0, length })
    }
    fn text_supported_selection(&self) -> windows::core::Result<SupportedTextSelection> {
        self.with_node(|node, _| {
            Ok(if node.actions.contains(&AxActionKind::SetSelection) {
                SupportedTextSelection_Single
            } else {
                SupportedTextSelection_None
            })
        })
    }
}

#[windows::core::interface("3589c92c-63f3-4367-99bb-ada653b77cf2")]
unsafe trait RawTextProvider: IUnknown {
    fn GetSelection(&self, result: *mut *mut SAFEARRAY) -> HRESULT;
    fn GetVisibleRanges(&self, result: *mut *mut SAFEARRAY) -> HRESULT;
    fn RangeFromChild(&self, child: *mut c_void, result: *mut *mut c_void) -> HRESULT;
    fn RangeFromPoint(&self, point: UiaPoint, result: *mut *mut c_void) -> HRESULT;
    fn DocumentRange(&self, result: *mut *mut c_void) -> HRESULT;
    fn SupportedTextSelection(&self, result: *mut SupportedTextSelection) -> HRESULT;
}

impl RawTextProvider_Impl for Provider_Impl {
    unsafe fn GetSelection(&self, out: *mut *mut SAFEARRAY) -> HRESULT {
        // SAFETY: out is supplied by the COM caller.
        unsafe { write_value(out, self.text_selection()) }
    }
    unsafe fn GetVisibleRanges(&self, out: *mut *mut SAFEARRAY) -> HRESULT {
        // SAFETY: out is supplied by the COM caller.
        unsafe { write_value(out, self.text_visible_ranges()) }
    }
    unsafe fn RangeFromChild(&self, child: *mut c_void, out: *mut *mut c_void) -> HRESULT {
        // SAFETY: COM supplies an optional borrowed provider and a valid output pointer.
        unsafe {
            write_optional_interface(
                out,
                self.text_range_from_child(IRawElementProviderSimple::from_raw_borrowed(&child)),
            )
        }
    }
    unsafe fn RangeFromPoint(&self, point: UiaPoint, out: *mut *mut c_void) -> HRESULT {
        // SAFETY: out is supplied by the COM caller.
        unsafe { write_optional_interface(out, self.text_range_from_point(point)) }
    }
    unsafe fn DocumentRange(&self, out: *mut *mut c_void) -> HRESULT {
        // SAFETY: out is supplied by the COM caller.
        unsafe { write_interface(out, self.text_document_range(), false) }
    }
    unsafe fn SupportedTextSelection(&self, out: *mut SupportedTextSelection) -> HRESULT {
        // SAFETY: out is supplied by the COM caller.
        unsafe { write_value(out, self.text_supported_selection()) }
    }
}
#[windows::core::interface("5347ad7b-c355-46f8-aff5-909033582f63")]
unsafe trait RawTextRange: IUnknown {
    fn Clone(&self, result: *mut *mut c_void) -> HRESULT;
    fn Compare(&self, range: *mut c_void, result: *mut BOOL) -> HRESULT;
    fn CompareEndpoints(
        &self,
        endpoint: TextPatternRangeEndpoint,
        range: *mut c_void,
        target: TextPatternRangeEndpoint,
        result: *mut i32,
    ) -> HRESULT;
    fn ExpandToEnclosingUnit(&self, unit: TextUnit) -> HRESULT;
    fn FindAttribute(
        &self,
        id: UIA_TEXTATTRIBUTE_ID,
        value: std::mem::MaybeUninit<VARIANT>,
        backward: BOOL,
        result: *mut *mut c_void,
    ) -> HRESULT;
    fn FindText(
        &self,
        text: std::mem::MaybeUninit<BSTR>,
        backward: BOOL,
        ignorecase: BOOL,
        result: *mut *mut c_void,
    ) -> HRESULT;
    fn GetAttributeValue(&self, id: UIA_TEXTATTRIBUTE_ID, result: *mut VARIANT) -> HRESULT;
    fn GetBoundingRectangles(&self, result: *mut *mut SAFEARRAY) -> HRESULT;
    fn GetEnclosingElement(&self, result: *mut *mut c_void) -> HRESULT;
    fn GetText(&self, maxlength: i32, result: *mut BSTR) -> HRESULT;
    fn Move(&self, unit: TextUnit, count: i32, result: *mut i32) -> HRESULT;
    fn MoveEndpointByUnit(
        &self,
        endpoint: TextPatternRangeEndpoint,
        unit: TextUnit,
        count: i32,
        result: *mut i32,
    ) -> HRESULT;
    fn MoveEndpointByRange(
        &self,
        endpoint: TextPatternRangeEndpoint,
        range: *mut c_void,
        target: TextPatternRangeEndpoint,
    ) -> HRESULT;
    fn Select(&self) -> HRESULT;
    fn AddToSelection(&self) -> HRESULT;
    fn RemoveFromSelection(&self) -> HRESULT;
    fn ScrollIntoView(&self, align: BOOL) -> HRESULT;
    fn GetChildren(&self, result: *mut *mut SAFEARRAY) -> HRESULT;
}

unsafe fn write_optional_interface<T: Interface>(
    output: *mut *mut c_void,
    value: windows::core::Result<Option<T>>,
) -> HRESULT {
    if output.is_null() {
        return HRESULT(0x80004003u32 as i32);
    }
    // SAFETY: output is a valid COM out parameter supplied by the caller.
    unsafe {
        output.write(null_mut());
    }
    match value {
        Ok(Some(value)) => {
            // SAFETY: ownership of the COM reference transfers to the caller.
            unsafe {
                output.write(value.into_raw());
            }
            HRESULT(0)
        }
        Ok(None) => HRESULT(0),
        Err(error) => error.into(),
    }
}
impl RawTextRange_Impl for TextRangeProvider_Impl {
    unsafe fn Clone(&self, out: *mut *mut c_void) -> HRESULT {
        // SAFETY: out is supplied by the COM caller.
        unsafe { write_interface(out, TextRangeProvider::Clone(self), false) }
    }
    unsafe fn Compare(&self, target: *mut c_void, out: *mut BOOL) -> HRESULT {
        // SAFETY: COM supplies an optional borrowed ITextRangeProvider and a valid out pointer.
        unsafe {
            write_value(
                out,
                TextRangeProvider::Compare(self, ITextRangeProvider::from_raw_borrowed(&target)),
            )
        }
    }
    unsafe fn CompareEndpoints(
        &self,
        endpoint: TextPatternRangeEndpoint,
        target: *mut c_void,
        other: TextPatternRangeEndpoint,
        out: *mut i32,
    ) -> HRESULT {
        // SAFETY: COM supplies an optional borrowed ITextRangeProvider and a valid out pointer.
        unsafe {
            write_value(
                out,
                TextRangeProvider::CompareEndpoints(
                    self,
                    endpoint,
                    ITextRangeProvider::from_raw_borrowed(&target),
                    other,
                ),
            )
        }
    }
    unsafe fn ExpandToEnclosingUnit(&self, unit: TextUnit) -> HRESULT {
        TextRangeProvider::ExpandToEnclosingUnit(self, unit).into()
    }
    unsafe fn FindAttribute(
        &self,
        id: UIA_TEXTATTRIBUTE_ID,
        value: std::mem::MaybeUninit<VARIANT>,
        backward: BOOL,
        out: *mut *mut c_void,
    ) -> HRESULT {
        // SAFETY: COM passes an initialized borrowed VARIANT and valid out pointer.
        unsafe {
            write_optional_interface(out, self.find_attribute(id, &*value.as_ptr(), backward))
        }
    }
    unsafe fn FindText(
        &self,
        text: std::mem::MaybeUninit<BSTR>,
        backward: BOOL,
        ignorecase: BOOL,
        out: *mut *mut c_void,
    ) -> HRESULT {
        // SAFETY: COM passes an initialized borrowed BSTR and valid out pointer.
        unsafe {
            write_optional_interface(out, self.find_text(&*text.as_ptr(), backward, ignorecase))
        }
    }
    unsafe fn GetAttributeValue(&self, id: UIA_TEXTATTRIBUTE_ID, out: *mut VARIANT) -> HRESULT {
        // SAFETY: out is supplied by the COM caller.
        unsafe { write_value(out, TextRangeProvider::GetAttributeValue(self, id)) }
    }
    unsafe fn GetBoundingRectangles(&self, out: *mut *mut SAFEARRAY) -> HRESULT {
        // SAFETY: out is supplied by the COM caller.
        unsafe { write_value(out, TextRangeProvider::GetBoundingRectangles(self)) }
    }
    unsafe fn GetEnclosingElement(&self, out: *mut *mut c_void) -> HRESULT {
        // SAFETY: out is supplied by the COM caller.
        unsafe { write_interface(out, TextRangeProvider::GetEnclosingElement(self), false) }
    }
    unsafe fn GetText(&self, max: i32, out: *mut BSTR) -> HRESULT {
        // SAFETY: out is supplied by the COM caller.
        unsafe { write_value(out, TextRangeProvider::GetText(self, max)) }
    }
    unsafe fn Move(&self, unit: TextUnit, count: i32, out: *mut i32) -> HRESULT {
        // SAFETY: out is supplied by the COM caller.
        unsafe { write_value(out, TextRangeProvider::Move(self, unit, count)) }
    }
    unsafe fn MoveEndpointByUnit(
        &self,
        endpoint: TextPatternRangeEndpoint,
        unit: TextUnit,
        count: i32,
        out: *mut i32,
    ) -> HRESULT {
        // SAFETY: out is supplied by the COM caller.
        unsafe {
            write_value(
                out,
                TextRangeProvider::MoveEndpointByUnit(self, endpoint, unit, count),
            )
        }
    }
    unsafe fn MoveEndpointByRange(
        &self,
        endpoint: TextPatternRangeEndpoint,
        target: *mut c_void,
        other: TextPatternRangeEndpoint,
    ) -> HRESULT {
        // SAFETY: COM supplies an optional borrowed ITextRangeProvider.
        TextRangeProvider::MoveEndpointByRange(
            self,
            endpoint,
            unsafe { ITextRangeProvider::from_raw_borrowed(&target) },
            other,
        )
        .into()
    }
    unsafe fn Select(&self) -> HRESULT {
        TextRangeProvider::Select(self).into()
    }
    unsafe fn AddToSelection(&self) -> HRESULT {
        TextRangeProvider::AddToSelection(self).into()
    }
    unsafe fn RemoveFromSelection(&self) -> HRESULT {
        TextRangeProvider::RemoveFromSelection(self).into()
    }
    unsafe fn ScrollIntoView(&self, align: BOOL) -> HRESULT {
        TextRangeProvider::ScrollIntoView(self, align).into()
    }
    unsafe fn GetChildren(&self, out: *mut *mut SAFEARRAY) -> HRESULT {
        // SAFETY: out is supplied by the COM caller.
        unsafe { write_value(out, TextRangeProvider::GetChildren(self)) }
    }
}

#[implement(RawTextRange)]
struct TextRangeProvider {
    provider: Provider,
    range: Mutex<ModelTextRange>,
}

impl TextRangeProvider {
    fn current(&self) -> windows::core::Result<ModelTextRange> {
        let (_, length, _) = self.provider.text_data()?;
        let range = *self.range.lock().map_err(|_| uia_unavailable())?;
        if range.start > length || range.length > length - range.start {
            return Err(uia_unavailable());
        }
        Ok(range)
    }

    fn boundaries(&self, unit: TextUnit) -> windows::core::Result<Vec<u32>> {
        let unit = match unit {
            TextUnit_Character => ModelTextUnit::Character,
            TextUnit_Format => ModelTextUnit::Format,
            TextUnit_Word => ModelTextUnit::Word,
            TextUnit_Line => ModelTextUnit::Line,
            TextUnit_Paragraph => ModelTextUnit::Paragraph,
            TextUnit_Page => ModelTextUnit::Page,
            TextUnit_Document => ModelTextUnit::Document,
            _ => return Err(windows::core::Error::from(HRESULT(0x80070057u32 as i32))),
        };
        match self.provider.query(TextQuery::UnitBoundaries { unit })? {
            TextReply::Boundaries(boundaries) => {
                let (_, length, _) = self.provider.text_data()?;
                if boundaries.last() != Some(&length) {
                    return Err(uia_unavailable());
                }
                Ok(boundaries)
            }
            _ => Err(uia_unavailable()),
        }
    }

    fn other(&self, target: Option<&ITextRangeProvider>) -> windows::core::Result<ModelTextRange> {
        let target = target.ok_or_else(uia_unsupported)?.cast::<RawTextRange>()?;
        if !target.is_object::<Self>() {
            return Err(uia_unsupported());
        }
        // SAFETY: is_object confirmed the generated Self implementation for this interface.
        let target = unsafe { <RawTextRange as windows::core::AsImpl<Self>>::as_impl(&target) };
        if target.provider.key != self.provider.key
            || target.provider.id != self.provider.id
            || target.provider.frame != self.provider.frame
            || target.provider.backend != self.provider.backend
        {
            return Err(uia_unavailable());
        }
        target.current()
    }

    fn endpoint(
        range: ModelTextRange,
        endpoint: TextPatternRangeEndpoint,
    ) -> windows::core::Result<u32> {
        if endpoint == TextPatternRangeEndpoint_Start {
            Ok(range.start)
        } else if endpoint == TextPatternRangeEndpoint_End {
            Ok(range.start + range.length)
        } else {
            Err(uia_unsupported())
        }
    }
}

#[allow(non_snake_case)]
impl TextRangeProvider {
    fn Clone(&self) -> windows::core::Result<ITextRangeProvider> {
        text_range(&self.provider, self.current()?)
    }
    fn Compare(&self, range: Option<&ITextRangeProvider>) -> windows::core::Result<BOOL> {
        let a = self.current()?;
        let b = self.other(range)?;
        Ok(BOOL::from(a == b))
    }
    fn CompareEndpoints(
        &self,
        endpoint: TextPatternRangeEndpoint,
        target: Option<&ITextRangeProvider>,
        target_endpoint: TextPatternRangeEndpoint,
    ) -> windows::core::Result<i32> {
        let a = Self::endpoint(self.current()?, endpoint)?;
        let b = Self::endpoint(self.other(target)?, target_endpoint)?;
        Ok(match a.cmp(&b) {
            std::cmp::Ordering::Less => -1,
            std::cmp::Ordering::Equal => 0,
            std::cmp::Ordering::Greater => 1,
        })
    }
    fn find_text(
        &self,
        needle: &BSTR,
        backward: BOOL,
        ignorecase: BOOL,
    ) -> windows::core::Result<Option<ITextRangeProvider>> {
        let range = self.current()?;
        let (text, _, _) = self.provider.text_data()?;
        let text = text.ok_or_else(uia_unsupported)?;
        let source = &text[range.start as usize..(range.start + range.length) as usize];
        let needle = needle.as_wide();
        let found = if needle.is_empty() {
            Some((if backward.as_bool() { source.len() } else { 0 }, 0))
        } else if source.is_empty() {
            None
        } else if !ignorecase.as_bool() {
            if needle.len() > source.len() {
                None
            } else {
                let mut positions = source.windows(needle.len());
                let position = if backward.as_bool() {
                    positions.rposition(|part| part == needle)
                } else {
                    positions.position(|part| part == needle)
                };
                position.map(|position| (position, needle.len()))
            }
        } else {
            let source_len = i32::try_from(source.len()).map_err(|_| uia_unavailable())?;
            let needle_len = i32::try_from(needle.len()).map_err(|_| uia_unavailable())?;
            let mut matched = 0;
            let direction = if backward.as_bool() {
                FIND_FROMEND
            } else {
                FIND_FROMSTART
            };
            // SAFETY: the supplied UTF-16 slices remain valid for the synchronous NLS search.
            let position = unsafe {
                FindNLSStringEx(
                    LOCALE_NAME_INVARIANT,
                    direction | LINGUISTIC_IGNORECASE,
                    source.as_ptr(),
                    source_len,
                    needle.as_ptr(),
                    needle_len,
                    &mut matched,
                    null(),
                    null(),
                    0,
                )
            };
            if position < 0 {
                // SAFETY: GetLastError reads the calling thread's last-error slot.
                if unsafe { windows_sys::Win32::Foundation::GetLastError() } != 0 {
                    return Err(uia_unavailable());
                }
                None
            } else {
                Some((position as usize, matched as usize))
            }
        };
        match found {
            Some((start, length)) => Ok(Some(text_range(
                &self.provider,
                ModelTextRange {
                    start: range.start + start as u32,
                    length: length as u32,
                },
            )?)),
            None => Ok(None),
        }
    }

    fn find_attribute(
        &self,
        id: UIA_TEXTATTRIBUTE_ID,
        value: &VARIANT,
        _backward: BOOL,
    ) -> windows::core::Result<Option<ITextRangeProvider>> {
        let range = self.current()?;
        if id != UIA_IsReadOnlyAttributeId {
            return Ok(None);
        }
        let expected = bool::try_from(value).map_err(|_| uia_unsupported())?;
        let actual = self.provider.with_node(|node, _| {
            if node.children.is_empty() {
                Ok(Some(node.read_only))
            } else {
                Ok(None)
            }
        })?;
        if actual == Some(expected) {
            Ok(Some(text_range(&self.provider, range)?))
        } else {
            Ok(None)
        }
    }
    fn ExpandToEnclosingUnit(&self, unit: TextUnit) -> windows::core::Result<()> {
        let current = self.current()?;
        let boundaries = self.boundaries(unit)?;
        if current.length > 0
            && boundaries.binary_search(&current.start).is_ok()
            && boundaries
                .binary_search(&(current.start + current.length))
                .is_ok()
        {
            return Ok(());
        }
        let start_index = boundaries
            .partition_point(|position| *position <= current.start)
            .saturating_sub(1);
        let start = boundaries[start_index];
        let end = boundaries.get(start_index + 1).copied().unwrap_or(start);
        *self.range.lock().map_err(|_| uia_unavailable())? = ModelTextRange {
            start,
            length: end - start,
        };
        Ok(())
    }
    fn GetAttributeValue(&self, id: UIA_TEXTATTRIBUTE_ID) -> windows::core::Result<VARIANT> {
        self.current()?;
        if id == UIA_IsReadOnlyAttributeId {
            if let Some(value) = self.provider.with_node(|node, _| {
                Ok(if node.children.is_empty() {
                    Some(node.read_only)
                } else {
                    None
                })
            })? {
                return Ok(VARIANT::from(value));
            }
        }
        // SAFETY: UI Automation returns the standard process-wide reserved COM value.
        unsafe { UiaGetReservedNotSupportedValue().map(VARIANT::from) }
    }
    fn GetBoundingRectangles(&self) -> windows::core::Result<*mut SAFEARRAY> {
        self.provider
            .shared
            .check_key(self.provider.key)
            .map_err(|_| uia_unavailable())?;
        let range = self.current()?;
        let rectangles = match self.provider.query(TextQuery::RangeRects { range })? {
            TextReply::Rects(rectangles) => rectangles,
            _ => return Err(uia_unavailable()),
        };
        let mut origin = POINT { x: 0, y: 0 };
        // SAFETY: the child HWND is live and origin is writable.
        if unsafe {
            windows_sys::Win32::Graphics::Gdi::ClientToScreen(
                self.provider.hwnd as HWND,
                &mut origin,
            )
        } == 0
        {
            return Err(uia_unavailable());
        }
        let scale = self.provider.shared.bounds().scale;
        let count = u32::try_from(
            rectangles
                .len()
                .checked_mul(4)
                .ok_or_else(uia_unavailable)?,
        )
        .map_err(|_| uia_unavailable())?;
        // SAFETY: the new array is populated with exactly count f64 values.
        unsafe {
            let array = SafeArrayCreateVector(VT_R8, 0, count);
            if array.is_null() {
                return Err(uia_unavailable());
            }
            for (index, value) in rectangles
                .iter()
                .flat_map(|rect| {
                    [
                        f64::from(origin.x) + rect.x * scale,
                        f64::from(origin.y) + rect.y * scale,
                        rect.width * scale,
                        rect.height * scale,
                    ]
                })
                .enumerate()
            {
                let index = index as i32;
                if let Err(error) =
                    SafeArrayPutElement(array, &index, (&value as *const f64).cast())
                {
                    let _ = SafeArrayDestroy(array);
                    return Err(error);
                }
            }
            Ok(array)
        }
    }
    fn GetEnclosingElement(&self) -> windows::core::Result<IRawElementProviderSimple> {
        self.current()?;
        let raw: RawSimple = self.provider.related(&self.provider.id)?.into();
        raw.cast()
    }
    fn GetText(&self, maxlength: i32) -> windows::core::Result<BSTR> {
        let range = self.current()?;
        let (text, _, _) = self.provider.text_data()?;
        let text = text.ok_or_else(uia_unsupported)?;
        let length = if maxlength < 0 {
            range.length
        } else {
            range.length.min(maxlength as u32)
        };
        let start = range.start as usize;
        BSTR::from_wide(&text[start..start + length as usize])
    }
    fn Move(&self, unit: TextUnit, count: i32) -> windows::core::Result<i32> {
        let current = self.current()?;
        if count == 0 {
            return Ok(0);
        }
        let boundaries = self.boundaries(unit)?;
        let start = if current.length == 0 && count < 0 {
            boundaries.partition_point(|position| *position < current.start) as i64
        } else {
            boundaries
                .partition_point(|position| *position <= current.start)
                .saturating_sub(1) as i64
        };
        let maximum = boundaries
            .len()
            .saturating_sub(if current.length == 0 { 1 } else { 2 }) as i64;
        let next = (start + i64::from(count)).clamp(0, maximum);
        let new_start = boundaries[next as usize];
        let new_end = if current.length == 0 {
            new_start
        } else {
            boundaries
                .get(next as usize + 1)
                .copied()
                .unwrap_or(new_start)
        };
        *self.range.lock().map_err(|_| uia_unavailable())? = ModelTextRange {
            start: new_start,
            length: new_end - new_start,
        };
        let shift = next - start;
        Ok(shift as i32)
    }
    fn MoveEndpointByUnit(
        &self,
        endpoint: TextPatternRangeEndpoint,
        unit: TextUnit,
        count: i32,
    ) -> windows::core::Result<i32> {
        if endpoint != TextPatternRangeEndpoint_Start && endpoint != TextPatternRangeEndpoint_End {
            return Err(uia_unsupported());
        }
        let current = self.current()?;
        if count == 0 {
            return Ok(0);
        }
        let boundaries = self.boundaries(unit)?;
        let old = if endpoint == TextPatternRangeEndpoint_Start {
            current.start
        } else {
            current.start + current.length
        };
        let first_greater = boundaries.partition_point(|position| *position <= old);
        let first_not_less = boundaries.partition_point(|position| *position < old);
        let exact = boundaries.get(first_not_less) == Some(&old);
        let base = if count > 0 {
            first_greater as i64 - 1
        } else {
            first_not_less as i64
        };
        let old_index = if exact { first_not_less as i64 } else { base };
        let new_index = (base + i64::from(count)).clamp(0, boundaries.len() as i64 - 1);
        let position = boundaries[new_index as usize];
        let other = if endpoint == TextPatternRangeEndpoint_Start {
            current.start + current.length
        } else {
            current.start
        };
        let (start, end) = if endpoint == TextPatternRangeEndpoint_Start {
            (position, other.max(position))
        } else {
            (other.min(position), position)
        };
        *self.range.lock().map_err(|_| uia_unavailable())? = ModelTextRange {
            start,
            length: end - start,
        };
        Ok((new_index - old_index) as i32)
    }
    fn MoveEndpointByRange(
        &self,
        endpoint: TextPatternRangeEndpoint,
        target: Option<&ITextRangeProvider>,
        target_endpoint: TextPatternRangeEndpoint,
    ) -> windows::core::Result<()> {
        let current = self.current()?;
        let position = Self::endpoint(self.other(target)?, target_endpoint)?;
        let other = if endpoint == TextPatternRangeEndpoint_Start {
            current.start + current.length
        } else if endpoint == TextPatternRangeEndpoint_End {
            current.start
        } else {
            return Err(uia_unsupported());
        };
        let (start, end) = if endpoint == TextPatternRangeEndpoint_Start {
            (position, other.max(position))
        } else {
            (other.min(position), position)
        };
        *self.range.lock().map_err(|_| uia_unavailable())? = ModelTextRange {
            start,
            length: end - start,
        };
        Ok(())
    }
    fn Select(&self) -> windows::core::Result<()> {
        self.provider
            .action(AxAction::SetSelection(self.current()?))
    }
    fn AddToSelection(&self) -> windows::core::Result<()> {
        Err(windows::core::Error::from(HRESULT(
            UIA_E_INVALIDOPERATION as i32,
        )))
    }
    fn RemoveFromSelection(&self) -> windows::core::Result<()> {
        Err(windows::core::Error::from(HRESULT(
            UIA_E_INVALIDOPERATION as i32,
        )))
    }
    fn ScrollIntoView(&self, align: BOOL) -> windows::core::Result<()> {
        match self.provider.query(TextQuery::ScrollIntoView {
            range: self.current()?,
            align_to_top: align.as_bool(),
        })? {
            TextReply::Scrolled => Ok(()),
            _ => Err(uia_unavailable()),
        }
    }
    fn GetChildren(&self) -> windows::core::Result<*mut SAFEARRAY> {
        let selected = self.current()?;
        let children = self.provider.with_node(|node, tree| {
            let mut result = Vec::new();
            for id in &node.children {
                let child = tree.node(id).ok_or_else(uia_unavailable)?;
                let target = AxTarget {
                    node_id: child.node_id.clone(),
                    frame_id: child.frame_id.clone(),
                    backend_dom_node_id: child.backend_dom_node_id.ok_or_else(uia_unavailable)?,
                };
                if let TextReply::Range(Some(range)) = self
                    .provider
                    .query(TextQuery::RangeFromChild { child: target })?
                {
                    if range.start < selected.start + selected.length
                        && selected.start < range.start + range.length
                    {
                        let raw: RawSimple = self.provider.related(id)?.into();
                        let provider: IRawElementProviderSimple = raw.cast()?;
                        result.push(provider);
                    }
                }
            }
            Ok(result)
        })?;
        let count = u32::try_from(children.len()).map_err(|_| uia_unavailable())?;
        // SAFETY: each array element is a live COM provider and the array takes its own reference.
        unsafe {
            let array = SafeArrayCreateVector(VT_UNKNOWN, 0, count);
            if array.is_null() {
                return Err(uia_unavailable());
            }
            for (index, child) in children.iter().enumerate() {
                if let Err(error) = SafeArrayPutElement(array, &(index as i32), child.as_raw()) {
                    let _ = SafeArrayDestroy(array);
                    return Err(error);
                }
            }
            Ok(array)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::super::model::{AxSnapshot, Consumer, FrameDisposition, FrameMetadata, Rect};
    use super::super::{NativeParent, Surface};
    use super::*;
    use windows::Win32::System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx, CoUninitialize};
    use windows_sys::Win32::Graphics::Gdi::GetPixel;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SendMessageW, WS_OVERLAPPEDWINDOW, WS_VISIBLE,
    };

    #[test]
    fn outside_client_points_keep_signed_coordinates_at_the_view_scale() {
        for (point, expected) in [
            (POINT { x: -27, y: 210 }, (-18.0, 140.0)),
            (POINT { x: 330, y: -12 }, (220.0, -8.0)),
        ] {
            assert_eq!(client_point_dip(point, 1.5), expected);
        }
    }

    #[derive(Default)]
    struct ConsumerLog {
        input: Mutex<Vec<Input>>,
        actions: Mutex<Vec<AxAction>>,
        frames: Mutex<Vec<FrameDisposition>>,
        errors: Mutex<Vec<SurfaceError>>,
    }

    impl Consumer for ConsumerLog {
        fn schedule_present(&self, _key: SurfaceKey) -> Result<(), SurfaceError> {
            Ok(())
        }
        fn presented(
            &self,
            _key: SurfaceKey,
            _ack: i64,
            disposition: FrameDisposition,
        ) -> Result<(), SurfaceError> {
            self.frames.lock().unwrap().push(disposition);
            Ok(())
        }
        fn input(&self, _key: SurfaceKey, event: Input) -> Result<(), SurfaceError> {
            self.input.lock().unwrap().push(event);
            Ok(())
        }
        fn accessibility(
            &self,
            _key: SurfaceKey,
            _generation: u64,
            _target: AxTarget,
            action: AxAction,
        ) -> Result<(), SurfaceError> {
            self.actions.lock().unwrap().push(action);
            Ok(())
        }
        fn text_query(
            &self,
            _key: SurfaceKey,
            _generation: u64,
            _target: AxTarget,
            _query: TextQuery,
        ) -> Result<TextReply, SurfaceError> {
            Err(SurfaceError::Native(
                "fixture has no BrowserPage text query".into(),
            ))
        }
        fn failed(&self, _key: SurfaceKey, error: SurfaceError) {
            self.errors.lock().unwrap().push(error);
        }
    }

    #[test]
    fn real_child_frame_input_ime_uia_and_parent_destruction() {
        // SAFETY: the test creates and destroys all native objects on this one COM/UI thread.
        unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().unwrap();
            let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
            let parent = CreateWindowExW(
                0,
                class.as_ptr(),
                class.as_ptr(),
                WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                0,
                0,
                320,
                240,
                null_mut(),
                null_mut(),
                GetModuleHandleW(null()),
                null(),
            );
            assert!(!parent.is_null());
            let owner = NativeParent::from_hwnd(parent as isize).unwrap();
            let key = SurfaceKey {
                view: 4,
                wc: 7,
                generation: 1,
            };
            let rect = Rect {
                x: 8.0,
                y: 9.0,
                width: 100.0,
                height: 80.0,
            };
            let log = Arc::new(ConsumerLog::default());
            let mut surface =
                Surface::new(owner, key, Bounds { rect, scale: 1.0 }, log.clone()).unwrap();
            let hwnd = surface.child.hwnd().unwrap();

            let png = Arc::new(
                include_bytes!("../../../../core/src/web/testdata/static/icons/icon.png").to_vec(),
            );
            let width = u32::from_be_bytes(png[16..20].try_into().unwrap());
            let height = u32::from_be_bytes(png[20..24].try_into().unwrap());
            surface
                .publisher()
                .submit(EncodedFrame {
                    key,
                    ack: 17,
                    png,
                    pixel_width: width,
                    pixel_height: height,
                    scale: 1.0,
                    metadata: FrameMetadata {
                        device_width: width as f64,
                        device_height: height as f64,
                        page_scale_factor: 1.0,
                        offset_top: 0.0,
                        scroll_offset_x: 0.0,
                        scroll_offset_y: 0.0,
                    },
                })
                .unwrap();
            surface.drain_frame().unwrap();
            assert_eq!(
                *log.frames.lock().unwrap(),
                vec![FrameDisposition::Presented]
            );
            let dc = GetDC(hwnd);
            assert!(!dc.is_null());
            assert_ne!(GetPixel(dc, 1, 1), u32::MAX);
            ReleaseDC(hwnd, dc);
            let mut actual = RECT::default();
            assert_ne!(GetClientRect(hwnd, &mut actual), 0);
            assert_eq!((actual.right, actual.bottom), (100, 80));
            surface.focus().unwrap();
            assert_eq!(
                windows_sys::Win32::UI::Input::KeyboardAndMouse::GetFocus(),
                hwnd
            );
            SendMessageW(hwnd, WM_KEYDOWN, 0x41, 0);
            SendMessageW(hwnd, WM_IME_STARTCOMPOSITION, 0, 0);
            SendMessageW(hwnd, WM_IME_ENDCOMPOSITION, 0, 0);
            assert!(log.input.lock().unwrap().iter().any(|event| matches!(
                event,
                Input::Key {
                    windows_virtual_key_code: 0x41,
                    ..
                }
            )));
            assert!(
                log.input
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|event| matches!(event, Input::CancelIme))
            );

            let node = AxNode {
                node_id: "node".into(),
                frame_id: Some("frame".into()),
                backend_dom_node_id: Some(12),
                role: "textbox".into(),
                name: Some("Actual input".into()),
                description: None,
                value: AxValue::Text("hello".into()),
                children: Vec::new(),
                bounds: Some(rect),
                disabled: false,
                focused: true,
                focusable: true,
                editable: true,
                read_only: false,
                secure: false,
                multiline: false,
                required: false,
                selected: false,
                expanded: None,
                checked: None,
                selected_text_range: Some(ModelTextRange {
                    start: 1,
                    length: 2,
                }),
                actions: vec![
                    AxActionKind::Default,
                    AxActionKind::Focus,
                    AxActionKind::SetValue,
                    AxActionKind::SetSelection,
                ],
            };
            surface
                .set_accessibility(Arc::new(AxSnapshot {
                    key,
                    generation: 1,
                    root_id: Some("node".into()),
                    nodes: vec![node.clone()],
                }))
                .unwrap();
            SendMessageW(hwnd, WM_GETOBJECT, 0, UiaRootObjectId as isize);
            let invoke: IInvokeProvider = Provider::new(surface.shared.clone(), hwnd, "node")
                .unwrap()
                .into();
            invoke.Invoke().unwrap();
            let text_raw: RawTextProvider = Provider::new(surface.shared.clone(), hwnd, "node")
                .unwrap()
                .into();
            let text: ITextProvider = text_raw.cast().unwrap();
            let document = text.DocumentRange().unwrap();
            let missing = BSTR::from("absent");
            let mut found = null_mut();
            assert_eq!(
                (Interface::vtable(&document).FindText)(
                    document.as_raw(),
                    missing.as_wide().as_ptr().cast_mut().cast(),
                    BOOL(0),
                    BOOL(0),
                    &mut found
                ),
                HRESULT(0)
            );
            assert!(found.is_null());
            let needle = BSTR::from("ELL");
            assert_eq!(
                (Interface::vtable(&document).FindText)(
                    document.as_raw(),
                    needle.as_wide().as_ptr().cast_mut().cast(),
                    BOOL(0),
                    BOOL(1),
                    &mut found
                ),
                HRESULT(0)
            );
            assert!(!found.is_null());
            let found = ITextRangeProvider::from_raw(found);
            assert_eq!(found.GetText(-1).unwrap().to_string(), "ell");
            document.Select().unwrap();
            assert!(
                log.actions
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|action| matches!(action, AxAction::Default))
            );
            assert!(log.actions.lock().unwrap().iter().any(|action| matches!(
                action,
                AxAction::SetSelection(ModelTextRange {
                    start: 0,
                    length: 5
                })
            )));
            let next = SurfaceKey {
                generation: 2,
                ..key
            };
            surface.set_document(next).unwrap();
            assert_eq!(
                invoke.Invoke().unwrap_err().code(),
                HRESULT(UIA_E_ELEMENTNOTAVAILABLE as i32)
            );
            let mut protected = node;
            protected.secure = true;
            protected.value = AxValue::Protected;
            protected
                .actions
                .retain(|action| *action != AxActionKind::SetValue);
            surface
                .set_accessibility(Arc::new(AxSnapshot {
                    key: next,
                    generation: 2,
                    root_id: Some("node".into()),
                    nodes: vec![protected],
                }))
                .unwrap();
            let value: IValueProvider = Provider::new(surface.shared.clone(), hwnd, "node")
                .unwrap()
                .into();
            assert!(value.Value().is_err());
            let fresh: IInvokeProvider = Provider::new(surface.shared.clone(), hwnd, "node")
                .unwrap()
                .into();
            assert_ne!(DestroyWindow(parent), 0);
            assert_eq!(
                fresh.Invoke().unwrap_err().code(),
                HRESULT(UIA_E_ELEMENTNOTAVAILABLE as i32)
            );
            assert!(surface.child.hwnd().is_err());
            drop(surface);
            CoUninitialize();
        }
    }
}
