//! Windows toast notifications (WinRT `ToastNotificationManager`), keyed on the AppUserModelID the shell set for the
//! process (`system::set_app_user_model_id`). An unpackaged app only shows toasts when a Start-menu shortcut carries
//! that same ID (the installer makes it); without one `Show` succeeds and nothing appears, which Windows does not report.
//!
//! `show` and `close` belong to one thread (CEF's UI thread, a COM apartment): the WinRT objects live in a
//! thread-local. The toast's events arrive on other threads and only carry the id, so they go straight to `emit`.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Mutex;

use windows::Data::Xml::Dom::XmlDocument;
use windows::Foundation::TypedEventHandler;
use windows::UI::Notifications::{
    NotificationSetting, ToastDismissalReason, ToastDismissedEventArgs, ToastFailedEventArgs,
    ToastNotification, ToastNotificationManager, ToastNotifier,
};
use windows::core::{HSTRING, IInspectable};
use windows_sys::Win32::Foundation::HMODULE;
use windows_sys::Win32::Media::Audio::{PlaySoundW, SND_ALIAS, SND_ASYNC, SND_NODEFAULT};
use windows_sys::Win32::System::Com::CoTaskMemFree;
use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
use windows_sys::Win32::UI::Shell::{
    GetCurrentProcessExplicitAppUserModelID, QUERY_USER_NOTIFICATION_STATE,
    QUNS_ACCEPTS_NOTIFICATIONS, SHQueryUserNotificationState,
};

use super::comthread;
use crate::notify_spec::{ToastSpec, dismissal_reason};

/// Where a toast's events go: `(id, "click" | "close" | "failed", reason)`. Called from any thread.
pub type Emit = fn(u64, &'static str, Option<String>);

thread_local! {
    static LIVE: RefCell<HashMap<u64, (ToastNotifier, ToastNotification)>> = RefCell::new(HashMap::new());
}

/// Ids whose toast ended (dismissed, failed) on a WinRT thread; `show` and `close` drop their objects.
static ENDED: Mutex<Vec<u64>> = Mutex::new(Vec::new());

fn sweep() {
    let ended = std::mem::take(&mut *ENDED.lock().unwrap_or_else(|e| e.into_inner()));
    if !ended.is_empty() {
        LIVE.with(|live| {
            let mut live = live.borrow_mut();
            for id in ended {
                live.remove(&id);
            }
        });
    }
}

fn ended(id: u64) {
    ENDED.lock().unwrap_or_else(|e| e.into_inner()).push(id);
}

fn app_user_model_id() -> Option<String> {
    let mut raw: *mut u16 = std::ptr::null_mut();
    // SAFETY: a valid out-pointer; on success the system hands back a CoTaskMem string that is read once and freed.
    unsafe {
        if GetCurrentProcessExplicitAppUserModelID(&mut raw) < 0 || raw.is_null() {
            return None;
        }
        let len = (0..).take_while(|&i| *raw.add(i) != 0).count();
        let id = String::from_utf16_lossy(std::slice::from_raw_parts(raw, len));
        CoTaskMemFree(raw.cast());
        (!id.is_empty()).then_some(id)
    }
}

fn setting_text(setting: NotificationSetting) -> &'static str {
    match setting {
        NotificationSetting::DisabledForApplication => {
            "notifications are turned off for this app in Windows settings"
        }
        NotificationSetting::DisabledForUser => {
            "notifications are turned off for this user in Windows settings"
        }
        NotificationSetting::DisabledByGroupPolicy => {
            "notifications are turned off by group policy"
        }
        NotificationSetting::DisabledByManifest => {
            "notifications are turned off by the app manifest"
        }
        _ => "notifications are not enabled",
    }
}

fn context(what: &'static str) -> impl Fn(windows::core::Error) -> String {
    move |e| {
        format!(
            "{what}: {} (0x{:08X})",
            e.message().trim(),
            e.code().0 as u32
        )
    }
}

/// The notifier for this process's AppUserModelID.
fn notifier() -> Result<ToastNotifier, String> {
    let aumid = app_user_model_id()
        .ok_or("the process has no AppUserModelID, so Windows cannot attribute a toast to it")?;
    ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(aumid))
        .map_err(context("creating the toast notifier"))
}

/// Shows the toast. `Err` says why it could not (the caller reports `failed`); events then follow through `emit`.
pub fn show(spec: &ToastSpec, emit: Emit) -> Result<(), String> {
    comthread::init();
    sweep();
    let notifier = notifier()?;
    match notifier.Setting() {
        Ok(NotificationSetting::Enabled) => {}
        Ok(other) => return Err(setting_text(other).into()),
        // The setting cannot be read for an ID Windows has not met yet (E_NOTFOUND until a first toast): that is not
        // proof that the toast cannot be shown, so try it.
        Err(_) => {}
    }

    let document = XmlDocument::new().map_err(context("creating the toast document"))?;
    document
        .LoadXml(&HSTRING::from(spec.xml()))
        .map_err(context("reading the toast document"))?;
    let toast = ToastNotification::CreateToastNotification(&document)
        .map_err(context("creating the toast"))?;

    let id = spec.id;
    toast
        .Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(
            move |_, _| {
                // A click on the toast body: the only kind of activation this app asks for (no buttons in the document).
                emit(id, "click", None);
                Ok(())
            },
        ))
        .map_err(context("listening for clicks"))?;
    toast
        .Dismissed(&TypedEventHandler::<
            ToastNotification,
            ToastDismissedEventArgs,
        >::new(move |_, args| {
            let reason = args
                .as_ref()
                .and_then(|a| a.Reason().ok())
                .unwrap_or(ToastDismissalReason::UserCanceled);
            ended(id);
            emit(id, "close", Some(dismissal_reason(reason.0).to_string()));
            Ok(())
        }))
        .map_err(context("listening for dismissals"))?;
    toast
        .Failed(
            &TypedEventHandler::<ToastNotification, ToastFailedEventArgs>::new(move |_, args| {
                let code = args
                    .as_ref()
                    .and_then(|a| a.ErrorCode().ok())
                    .map_or(0, |hr| hr.0 as u32);
                ended(id);
                emit(
                    id,
                    "failed",
                    Some(format!("Windows could not show the toast (0x{code:08X})")),
                );
                Ok(())
            }),
        )
        .map_err(context("listening for failures"))?;

    notifier
        .Show(&toast)
        .map_err(context("showing the toast"))?;
    LIVE.with(|live| live.borrow_mut().insert(id, (notifier, toast)));
    Ok(())
}

/// Takes the toast off the screen and out of the notification centre; an unknown id is not an error (it may be gone).
pub fn close(id: u64) {
    sweep();
    let found = LIVE.with(|live| live.borrow_mut().remove(&id));
    if let Some((notifier, toast)) = found {
        let _ = notifier.Hide(&toast);
    }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Whether a window the app draws itself may interrupt the person now (docs/design/custom-notifications.md). `Err`
/// says why not; the caller then hands the notification to the toast, which Windows quiets by its own rules. Every
/// answer that is not a clear yes is a no.
pub fn popup_gate() -> Result<(), String> {
    comthread::init();
    match notifier()?.Setting() {
        Ok(NotificationSetting::Enabled) => {}
        Ok(other) => return Err(setting_text(other).into()),
        Err(error) => return Err(context("reading the notification setting")(error)),
    }
    let mut state: QUERY_USER_NOTIFICATION_STATE = 0;
    // SAFETY: a valid out-pointer for the state.
    let read = unsafe { SHQueryUserNotificationState(&mut state) };
    if read < 0 {
        return Err(format!(
            "SHQueryUserNotificationState failed (0x{:08X})",
            read as u32
        ));
    }
    if state != QUNS_ACCEPTS_NOTIFICATIONS {
        return Err(format!(
            "the user notification state is {state}, not accepting"
        ));
    }
    match quiet_hours_profile()? {
        0 => Ok(()),
        profile => Err(format!(
            "Do Not Disturb or Focus assist is on (quiet hours profile {profile})"
        )),
    }
}

/// `WNF_SHEL_QUIETHOURS_ACTIVE_PROFILE_CHANGED`: 0 off, 1 priority only (Windows 11's Do Not Disturb), 2 alarms only.
/// Windows documents no API for Focus assist; this state is the known undocumented read
/// (https://stackoverflow.com/questions/53407374). A state never written has no data: off.
fn quiet_hours_profile() -> Result<u32, String> {
    type Query = unsafe extern "system" fn(
        state: *const u64,
        type_id: *const std::ffi::c_void,
        scope: *const std::ffi::c_void,
        stamp: *mut u32,
        buffer: *mut std::ffi::c_void,
        size: *mut u32,
    ) -> i32;
    const STATE: u64 = 0x0D83_063E_A3BF_1C75;
    let ntdll = wide("ntdll.dll");
    // SAFETY: ntdll is loaded in every process; the name is NUL-terminated.
    let module: HMODULE = unsafe { GetModuleHandleW(ntdll.as_ptr()) };
    if module.is_null() {
        return Err("ntdll is not loaded".into());
    }
    // SAFETY: a loaded module and a NUL-terminated ASCII name.
    let found = unsafe { GetProcAddress(module, c"NtQueryWnfStateData".as_ptr().cast()) }
        .ok_or("ntdll has no NtQueryWnfStateData")?;
    // SAFETY: NtQueryWnfStateData has had this signature since Windows 8 (the answer above declares it the same way).
    let query: Query = unsafe { std::mem::transmute(found) };
    let (mut stamp, mut profile, mut size) = (0u32, 0u32, 4u32);
    // SAFETY: the state name, stamp, buffer and size point at live locals; the buffer holds `size` bytes.
    let status = unsafe {
        query(
            &STATE,
            std::ptr::null(),
            std::ptr::null(),
            &mut stamp,
            (&mut profile as *mut u32).cast(),
            &mut size,
        )
    };
    if status < 0 {
        return Err(format!(
            "the quiet hours profile could not be read (NTSTATUS 0x{:08X})",
            status as u32
        ));
    }
    Ok(if size == 0 { 0 } else { profile })
}

/// Windows' default notification sound, as a toast without `silent` plays it. Asynchronous; silence when the person
/// set no sound for it.
pub fn play_default_sound() {
    let alias = wide("Notification.Default");
    // SAFETY: a NUL-terminated alias name; SND_ASYNC copies what it needs before returning.
    unsafe {
        PlaySoundW(
            alias.as_ptr(),
            std::ptr::null_mut(),
            SND_ALIAS | SND_ASYNC | SND_NODEFAULT,
        )
    };
}
