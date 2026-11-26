# OMPdesk's own notification popup

The owner asked for OMPdesk's notifications to appear as the app's own popup, like KakaoTalk's PC popup: a small card in a corner of the screen, outside the app window and over other apps, with the app mark, the session title, a one-line preview, a click that opens the session, a close button, auto-hide and stacking.

## Where it lives

The admission rules stay where they are: main's `maybeNotify`, the batch, mute, dropped, presence and seen, and the shell's `app.admitNotification`. What reaches the shell is the same `notification.show {id, title, body, icon, silent, tab}` call as today, and Node hears the same `notification.event {id, name, reason}` events. The popup replaces the OS banner behind that call. It is one more destination in `crates/shell/src/notification.rs`. Nothing changes in `src/main`. A click reaches main's existing `click` listener, so it opens the tab through today's path. Closing a banner once its tab is seen (`notification.closeTab`, which orca-core-port is moving into the shell) closes the popup's card through the same `close_any(id)`.

Each `show` takes one route, decided by one pure function (`route` in `notification_popup.rs`) and logged as `notification.route {id, route, reason}`:

| Route | When |
|---|---|
| `popup` | Windows, the OS gate says the person may be interrupted, the popup page is ready (or becomes ready within 3 s) |
| `banner` (today's OS toast or Notification Center entry) | macOS always (see Focus below); Windows when the OS gate says no or cannot be read; the popup page failed or was not ready within 3 s |
| `hidden` | a test run (`OMP_GUI_HEADLESS=1`) with `OMP_GUI_TEST_NOTIFICATION_POPUP=1`: the popup's page gets the card, the window is never shown |
| none | a test run without that variable, as today (the `off` fact: Node sends nothing) |

## Do Not Disturb and Focus

A window the app draws itself bypasses the OS's suppression, so the popup asks the OS first and hands the notification to the OS banner whenever the answer is not a clear yes. The OS then applies its own rule: under Do Not Disturb it keeps the entry in the notification centre without a banner or sound.

- **Windows.** The popup shows only when all three agree:
  1. `ToastNotifier.Setting` is `Enabled`. A person who turned OMPdesk's notifications off in Windows Settings gets neither. The toast path then reports `failed`, as it does today, and main says notifications are blocked.
  2. `SHQueryUserNotificationState` (documented) returns `QUNS_ACCEPTS_NOTIFICATIONS`. Busy (a full-screen app or game), presentation mode and quiet time all go to the banner.
  3. The Focus assist / Do Not Disturb profile is off. Windows has no documented API for it. The shell reads `WNF_SHEL_QUIETHOURS_ACTIVE_PROFILE_CHANGED` through `NtQueryWnfStateData` (ntdll, undocumented; [the known read](https://stackoverflow.com/questions/53407374)): 0 off, 1 priority only, 2 alarms only. Windows 11's Do Not Disturb stores itself as the priority-only profile (`Microsoft.QuietHoursProfile.PriorityOnly` in the same question's second answer). Any non-zero value, or a failed read, goes to the banner. That Windows 11's Do Not Disturb sets this WNF value is inferred, not observed. The `notification.route` log line records what was read, so one toggle on a Windows 11 machine settles it.
- **macOS.** The banner, always. The only API for Focus state, `INFocusStatusCenter`, needs the `com.apple.developer.usernotifications.communication` entitlement. Without it `donotdisturbd` refuses the query ("XPC connection without Communication Notifications entitlement tried to get Focus Status, will invalidate", `DNDErrorDomain Code=1004`; [home-assistant/iOS#5904](https://github.com/home-assistant/iOS/issues/5904)). That entitlement is granted only through an Apple provisioning profile, and OMPdesk is signed with its own self-signed certificate (AGENTS.md › Signing). With the entitlement, `isFocused` would be the right answer: an app the Focus allows never sees the person as focused. Without it the state is unknown on every Mac, so per the rule "Focus on or unknown → OS banner", macOS keeps Notification Center, which filters itself. No popup window code is built for macOS. If the owner prefers a popup that ignores Focus on macOS, that is a separate product decision.

## Drawing: a small webview, not a native card

| | Native card | Webview in the app's WebView2 environment |
|---|---|---|
| Windows code | Hand-drawn GDI or Direct2D: text layout, ellipsis, DPI, hover, close button, theme colours. Hundreds of lines of unsafe Win32 | One HTML page, plus four window flags through existing `winops` helpers |
| First show | Instant | The browser process is already running for the app window. A second WebView2 in the same environment (same user-data folder and browser arguments, via `sessions::configure_app` and `webview_args`) starts a renderer without a cold browser start |
| Memory | None | One small renderer process while the popup exists |

The webview wins on Windows, the only platform that shows the popup. The cold-start risk is bounded: the window is created at the first popup and kept, and a card whose page is not ready within 3 s goes to the OS banner instead. Nothing is pre-warmed at launch, so launches that never notify pay nothing and test runs see no extra page.

The page is a self-contained HTML document compiled into the shell (`notification_popup.html`), loaded as a `data:` URL with `default-src 'none'`. It carries no app preload and no app IPC. Text goes in through `textContent` only, never markup. The shell renders through `eval(render(<json>))`. The page reports `click`, `close` and `hover` by navigating to `ompdesk-popup:<action>?id=…`. The shell's `on_navigation` reads and cancels those navigations, and every other navigation is refused.

## Window

- `decorations(false)`, `always_on_top`, `skip_taskbar` (`WS_EX_TOOLWINDOW`), `focusable(false)` (`WS_EX_NOACTIVATE`), not resizable, shadow on (Windows 11 rounds its corners). It is shown with `SW_SHOWNOACTIVATE` (`winops::show_no_activate`), so showing it never takes focus from what the person is typing. On creation the shell reads the extended style back and logs `notification.popup.window {noActivate, toolWindow, topmost}`; the e2e asserts that line.
- **No click-through area.** The window is sized to the stack: fixed row heights, computed in Rust. Every pixel of the window belongs to a card, so nothing beside a card catches clicks.
- **Where.** The bottom-right of the work area, 12 px from the taskbar side and the right edge, like Windows' own toasts and KakaoTalk. It goes on the monitor under the pointer, the screen the person is looking at, else the primary monitor. The position is recomputed at each change (`place`, pure, tested with two monitors and a left or top taskbar).

## Behaviour

- **Card.** The app mark (the brand SVG, compiled in), the title (one line, ellipsis), the body (one line, ellipsis), and a close button (×, 24 px target, label "Close"/"닫기"). The whole card is the click target.
- **Click.** `click` reaches Node, which focuses the app window on the tab through today's path. The card leaves. No `close` follows, as with a clicked Windows toast.
- **Close (×).** `close` with reason `userCanceled`. **Auto-hide.** After 6 s on screen, `close` with reason `timedOut`. The countdown pauses while the pointer is over the stack, and while the person is away (no input for 30 s, `system::idle_seconds`). A person who returns after an hour still sees what finished, as with Windows' own toasts.
- **Stack.** At most three cards show, newest nearest the corner. Further cards wait in order behind a "+N more"/"외 N개" row and show, with their own countdown, as slots free. A `close` from Node (tab seen, batch summary replacing its first banner) removes the card or the waiting entry.
- **Sound.** As today's toast: Windows' default notification sound (`PlaySound` alias `Notification.Default`, async) when `silent` is not set, once at `show`, and never for a hidden or banner-routed card. The banner plays its own.
- **Theme.** Dark or light from the shell's effective theme (`theme.setSource`), with the page background from `src/shared/window-background.json` (the app's `--sc-bg`). With reduced motion there is no slide, only the card.
- **Motion.** The card enters with 160 ms of opacity plus an 8 px rise (`ease-out`) and leaves with 120 ms of opacity. No other animation.
- **Strings.** The shell's labels (`native_labels.json`, en and ko): `notificationPopup.close`, `notificationPopup.more`.

## Settings

None. The owner asked for the popup, and it falls back to the banner on its own whenever it should not or cannot show (minimal-settings rule).

## Unchanged

The phone's Web Push, main's admission and batching, `IpcNotifyResult`, macOS notifications, and the test run's default of no notification at all.

## Tests

- Rust unit tests (`notification_popup.rs`): `route` over platform × OS gate × page state × test run, the stack (queue, "+N more", close of a shown or waiting card, countdown paused by hover and by idle), `place` (monitor choice, corner, taskbar edges), and the parsing of `ompdesk-popup:` actions, which refuses anything else.
- `e2e/notification-popup.e2e.ts` (Windows, `OMP_GUI_TEST_NOTIFICATION_POPUP=1`): a background tab's turn finishes, the popup page shows that session's title and preview, the window log line shows the no-activate, tool-window and topmost flags, and clicking the card makes that tab the app window's active tab.
