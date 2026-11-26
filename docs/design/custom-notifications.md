# OMPdesk's own notification popup

The owner asked for OMPdesk's notifications to appear as the app's own popup, like KakaoTalk's PC popup: a small card in a corner of the screen, outside the app window and over other apps, with the app mark, the session title, a one-line preview, a click that opens the session, a close button, auto-hide and stacking. On macOS and Windows alike, with the person's own notification controls folded behind a gear on the popup ("설정 아이콘으로 접어서 표현", the owner, 26 Nov 2026).

## Where it lives

The admission rules stay where they are: main's `maybeNotify`, the batch, per-session mute, dropped, presence and seen, and the shell's `app.admitNotification`. What reaches the shell is the same `notification.show {id, title, body, icon, silent, tab}` call as today, and Node hears the same `notification.event {id, name, reason}` events. The popup replaces the OS banner behind that call. It is one more destination in `crates/shell/src/notification.rs`. Nothing changes in `src/main`. A click reaches main's existing `click` listener, so it opens the tab through today's path. Closing a banner once its tab is seen (`notification.closeTab`) closes the popup's card through the same `close_any(id)`.

Each `show` takes one route, decided by one pure function (`route` in `notification_popup/mod.rs`) and logged as `notification.route {id, route, reason}`:

| Route | When |
|---|---|
| `muted` | the person muted OMPdesk's notifications from the popup's gear and the time has not passed: nothing shows and nothing sounds, and Node hears `close` with reason `muted` |
| `popup` | macOS; Windows when its OS gate says the person may be interrupted |
| `banner` (today's toast) | Windows when the OS gate says no or cannot be read; either platform when the popup's page failed or was not ready within 3 s |
| `hidden` | a test run (`OMP_GUI_HEADLESS=1`) with `OMP_GUI_TEST_NOTIFICATION_POPUP=1`: the popup's page gets the card, the window is never shown |
| none | a test run without that variable, as today (the `off` fact: Node sends nothing) |

## Do Not Disturb and Focus

A window the app draws itself bypasses the OS's suppression. Each platform therefore answers in its own way.

- **Windows.** The popup asks the OS first and hands the notification to the toast whenever the answer is not a clear yes. Windows then applies its own rule: under Do Not Disturb it keeps the entry in the notification centre without a banner or sound. The popup shows only when all three agree:
  1. `ToastNotifier.Setting` is `Enabled`. A person who turned OMPdesk's notifications off in Windows Settings gets neither. The toast path then reports `failed`, as it does today, and main says notifications are blocked.
  2. `SHQueryUserNotificationState` (documented) returns `QUNS_ACCEPTS_NOTIFICATIONS`. Busy (a full-screen app or game), presentation mode and quiet time all go to the toast.
  3. The Focus assist / Do Not Disturb profile is off. Windows has no documented API for it. The shell reads `WNF_SHEL_QUIETHOURS_ACTIVE_PROFILE_CHANGED` through `NtQueryWnfStateData` (ntdll, undocumented; [the known read](https://stackoverflow.com/questions/53407374)): 0 off, 1 priority only, 2 alarms only. Windows 11's Do Not Disturb stores itself as the priority-only profile (`Microsoft.QuietHoursProfile.PriorityOnly` in the same question's second answer). Any non-zero value, or a failed read, goes to the toast. That Windows 11's Do Not Disturb sets this WNF value is inferred, not observed. The `notification.route` log line records the reason, so one toggle on a Windows 11 machine settles it.
- **macOS.** The popup ignores Focus, by the owner's decision of 26 Nov 2026; the gear's mute is the person's control. Focus cannot be read: the only API, `INFocusStatusCenter`, needs the `com.apple.developer.usernotifications.communication` entitlement. Without it `donotdisturbd` refuses the query ("XPC connection without Communication Notifications entitlement tried to get Focus Status, will invalidate", `DNDErrorDomain Code=1004`; [home-assistant/iOS#5904](https://github.com/home-assistant/iOS/issues/5904)). That entitlement is granted only through an Apple provisioning profile, and OMPdesk is signed with its own self-signed certificate (AGENTS.md › Signing).

## Controls: the gear

Each card carries a gear (⚙, label "Notification options"/"알림 옵션") beside its ×. There is no mute button that is always visible. The gear opens a small menu inside the popup, which grows to hold it:

- **Mute for 1 hour** / "1시간 동안 알림 끄기"
- **Mute until tomorrow** / "내일까지 알림 끄기": until 08:00 local time the next day. The page computes that instant, because it knows the local time zone, and sends it as `until`. The shell refuses an `until` in the past or more than 36 h away.
- **Notification settings…** / "알림 설정…": opens Settings in the app window (the app menu's `open-settings`, whose General section holds the notification switch and chime) and shows the window.

Muting closes the cards on screen (`close` `userCanceled`) and holds every notification until the time passes. It holds at admission: while it lasts `app.admitNotification` answers `drop`, so main answers `dropped`, shows nothing (no popup, no toast) and the page plays no chime. A notice that skips admission (a notice of main's own) is routed `muted` in the shell and closes at once. The mute is OMPdesk-wide on this computer, kept in `<userData>/notification-mute.json` (`{"until": <ms>}`) so that an update's relaunch keeps it. It ends on its own; nothing else ends it early (the tray menu stays as the owner set it on 29 Oct 2026). The phone's Web Push is not affected; the phone has its own controls.

## Drawing: a small webview, not a native card

| | Native card | Webview in the app's webview environment |
|---|---|---|
| Code | Two hand-drawn cards (AppKit views and GDI or Direct2D): text layout, ellipsis, DPI, hover, buttons, a menu, theme colours | One HTML page on both platforms |
| First show | Instant | The browser process is already running for the app window. A second webview in the same environment (same data folder and, on Windows, the same browser arguments, via `sessions::configure_app` and `webview_args`) starts a renderer without a cold browser start |
| Memory | None | One small renderer process while the popup exists |

The webview wins. The cold-start risk is bounded: the window is created at the first popup and kept, and a card whose page is not ready within 3 s goes to the toast instead. Nothing is pre-warmed at launch, so launches that never notify pay nothing and test runs see no extra page.

The page is a self-contained HTML document compiled into the shell (`notification_popup/page.html`, CSP `default-src 'none'`). The window opens `about:blank` and the shell writes the page into it (`document.write`) every 250 ms until the page runs, because Tauri opens a `data:` URL only with a feature nothing else needs and reports no load of the first `about:blank`. It has no app preload, and the shell's one IPC command (`omp_ipc`) refuses the popup's label. Text goes in through `textContent` only, never markup. The shell renders through `eval(render(<json>))`. The page asks by setting its title to `ompdesk-popup:<action>?…&n=<count>` (`ready`, `click`, `close`, `menu`, `mute`, `settings`), which the shell reads through `on_document_title_changed` and parses with `action`; anything else in the title is ignored, and every navigation away from the blank page is refused. (A navigation to that scheme never reached the shell's handler in WebView2, and a new URI scheme handler would apply to every app window's webview.) Hover needs no message: every 500 ms the shell compares the pointer with the window.

## Window

- **Windows.** `decorations(false)`, `always_on_top`, `skip_taskbar` (`WS_EX_TOOLWINDOW`), `focusable(false)` (`WS_EX_NOACTIVATE`, set again natively), not resizable, Windows 11's rounded corners and shadow. It is placed and shown with `SetWindowPos(HWND_TOPMOST, SWP_NOACTIVATE | SWP_SHOWWINDOW)`, so showing it never takes focus from what the person is typing. On creation the shell reads the extended style back and logs `notification.popup.window {noActivate, toolWindow, topmost}`; the e2e asserts that line. It sits at the bottom-right of the work area, 12 px from the edges, like Windows' own toasts and KakaoTalk. The monitor is the one under the pointer, else the primary one (`place`, pure and tested).
- **macOS.** An `NSWindow` cannot click without activating its app, which would hand the keyboard to OMPdesk's hidden-behind window. So the shell moves the webview's view (wry's content view) out of its Tauri window into its own `NSPanel` with `NSWindowStyleMaskNonactivatingPanel`. That panel uses status-window level, joins all Spaces and full-screen Spaces, does not hide on deactivate and becomes key only if needed, so it is shown with `orderFrontRegardless`. The webview takes the first click (`accept_first_mouse`). The panel's corners are rounded and it carries the system shadow. It sits at the top-right of the visible frame (below the menu bar), where macOS's own banners appear, on the screen under the pointer.
- **No click-through area.** The window is sized to the stack: fixed row heights, computed in Rust. Every pixel of the window belongs to a card, the menu or the "+N more" row, so nothing beside them catches clicks.

## Behaviour

- **Card.** The app mark (the brand SVG, compiled in), the title (one line, ellipsis), the body (one line, ellipsis), the gear and a close button (×), each a 24 px target. The whole card is the click target.
- **Click.** `click` reaches Node, which focuses the app window on the tab through today's path. The card leaves. No `close` follows, as with a clicked Windows toast.
- **Close (×).** `close` with reason `userCanceled`. **Auto-hide.** After 6 s on screen, `close` with reason `timedOut`. The countdown pauses while the pointer is over the stack or the menu is open, and while the person is away (no input for 30 s, `system::idle_seconds`). A person who returns after an hour still sees what finished, as with Windows' own toasts.
- **Stack.** At most three cards show, newest nearest the corner (bottom on Windows, top on macOS). Further cards wait in order behind a "+N more"/"외 N개" row and show, with their own countdown, as slots free. A `close` from Node (tab seen, batch summary replacing its first banner) removes the card or the waiting entry.
- **Sound.** As today's banner, once at `show` when `silent` is not set: on Windows the default notification sound (`PlaySound` alias `Notification.Default`); on macOS the person's alert sound (`NSBeep`). There is none for a hidden, muted or toast-routed card, since the toast plays its own.
- **Theme.** Dark or light from the shell's effective theme (`theme.setSource`), with the page background from `src/shared/window-background.json` (the app's `--sc-bg`). With reduced motion there is no rise.
- **Motion.** The card enters with 160 ms of opacity plus an 8 px rise (`ease-out`). It leaves at once, because the window shrinks with it. No other animation.
- **Strings.** The shell's labels (`native_labels.json`, en and ko): `notificationPopup.*`.

## Settings

None. The gear's mute is the control the owner asked for, and on Windows the popup falls back to the toast on its own whenever the OS says it should not show (minimal-settings rule).

## Unchanged

The phone's Web Push, main's admission and batching, `IpcNotifyResult`, and the test run's default of no notification at all.

## Tests

- Rust unit tests (`notification_popup/mod.rs`): `route` over platform × OS gate × mute × test run, the stack (queue, "+N more", close of a shown or waiting card, countdown paused by hover, the open menu and idle, the menu's height), `place` (monitor choice, corner, a taskbar on the left), the mute (`until` bounds, expiry, the file round trip), and the parsing of `ompdesk-popup:` actions, which refuses anything else.
- `e2e/notification-popup.e2e.ts` (Windows, `OMP_GUI_TEST_NOTIFICATION_POPUP=1`): a background tab's turn finishes, the popup page shows that session's title and preview, the window log line shows the no-activate, tool-window and topmost flags, the gear opens its menu, and clicking the card makes that tab the app window's active tab. A second test mutes for an hour and sees the next finished turn routed `muted` with no card.
