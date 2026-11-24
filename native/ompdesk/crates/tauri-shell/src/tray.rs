//! The tray (docs/rust-node-removal.md W3; was `src/main/tray.ts` and `tray-labels.ts`): the notification-area icon
//! (Windows) or menu-bar item (macOS), its hover text and its menu: Open/Hide, one item that follows the updater, and
//! Quit (the owner's decision of 29 Oct 2026). None in a test run (`OMP_GUI_HEADLESS=1`).
//!
//! The hover text is the one thing the tray shows without a click, so it follows what each window's page pushes
//! (`tray:state-push`), loudest first. The menu is built each time it opens: it reads the windows then and asks Node
//! for the updater's status (`tray.update`), so it never shows a stale state and nothing replaces it while it is open.
//! The pages' run progress (`progress:set`) is gathered the same way for the Dock badge and the taskbar.

use crate::entry::{self, Open};
use crate::host::{self, Call};
use crate::ipc_router::Caller;
use crate::labels::{Lang, fill, text};
use crate::{log, quit_chain, ui};
use serde_json::{Value, json};
use shell_core::menu_model::{self, Item, Kind};
use shell_core::tray_image;
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, Once};
use std::time::Duration;
use tray_icon::{Icon, MouseButton, MouseButtonState, TrayIcon, TrayIconAttributes, TrayIconEvent};

#[cfg(windows)]
use shell_core::sys::menu as platform;
#[cfg(target_os = "macos")]
use shell_core::sys_mac::menu as platform;

/// How long a finished check that found nothing keeps saying "up to date" before the item offers a check again.
const UP_TO_DATE_MS: f64 = 30_000.0;
/// How long the menu waits for Node's updater status; then it opens with the item offering a check.
const NODE_WAIT: Duration = Duration::from_secs(2);

/// `TrayState["status"]`, loudest first: an error, what a window needs from the person (a question, an approval, a
/// waiting child), work going on, then idle.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Status {
    Error,
    Question,
    Approval,
    ChildWaiting,
    Streaming,
    Idle,
}

impl Status {
    /// A status this build does not know (a newer page's) is none, never louder than an error.
    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "error" => Self::Error,
            "question" => Self::Question,
            "approval" => Self::Approval,
            "childWaiting" => Self::ChildWaiting,
            "streaming" => Self::Streaming,
            "idle" => Self::Idle,
            _ => return None,
        })
    }

    /// The renderer's words for it (`native-labels.test.ts` holds them to `attention.*` and `titlebar.status.*`).
    fn label(self, lang: Lang) -> &'static str {
        text(
            lang,
            match self {
                Self::Error => "tray.statusError",
                Self::Question => "tray.statusQuestion",
                Self::Approval => "tray.statusApproval",
                Self::ChildWaiting => "tray.statusChildWaiting",
                Self::Streaming => "tray.statusStreaming",
                Self::Idle => "tray.statusIdle",
            },
        )
    }
}

/// The loudest window's status: app-global, so the first window's state never hides a louder later one.
fn loudest(statuses: impl IntoIterator<Item = Option<Status>>) -> Status {
    statuses.into_iter().flatten().min().unwrap_or(Status::Idle)
}

/// `RunProgressState`: one window waiting on the person outranks one working, as the statuses do.
fn progress(states: impl IntoIterator<Item = Option<&'static str>>) -> &'static str {
    let mut working = false;
    for state in states.into_iter().flatten() {
        match state {
            "waiting" => return "waiting",
            "working" => working = true,
            _ => {}
        }
    }
    if working { "working" } else { "idle" }
}

fn progress_state(value: &Value) -> Option<&'static str> {
    match value.as_str()? {
        "waiting" => Some("waiting"),
        "working" => Some("working"),
        _ => None,
    }
}

/// The latest push, with the status of every window.
struct Shown {
    lang: Lang,
    project: String,
    status: Status,
}

/// Hover text: the icon itself stays a static mark by design.
fn tooltip(shown: Option<&Shown>) -> String {
    match shown {
        None => "OMPdesk".into(),
        Some(shown) => format!(
            "OMPdesk — {} · {}",
            shown.project,
            shown.status.label(shown.lang)
        ),
    }
}

#[derive(Default)]
struct Pushes {
    /// Node's UI language (`app.language`), for a menu before any page reported its own.
    lang: Lang,
    /// Each app page's status and run progress, by webContents id, until its window closes.
    statuses: HashMap<u64, Option<Status>>,
    progress: HashMap<u64, Option<&'static str>>,
    shown: Option<Shown>,
}

static PUSHES: LazyLock<Mutex<Pushes>> = LazyLock::new(Mutex::default);

fn pushes() -> std::sync::MutexGuard<'static, Pushes> {
    PUSHES.lock().expect("tray pushes")
}

/// `tray:state-push` from an app page (`TrayState`): the hover text shows the latest push with the loudest status.
pub fn state_push(caller: &Caller, state: &Value) -> Value {
    let Caller::Page(id) = caller else {
        return Value::Null;
    };
    {
        let mut pushes = pushes();
        pushes
            .statuses
            .insert(id.wc, state["status"].as_str().and_then(Status::parse));
        let status = loudest(pushes.statuses.values().copied());
        let lang = state["language"]
            .as_str()
            .and_then(Lang::parse)
            .unwrap_or(pushes.lang);
        let project = state["projectName"].as_str().unwrap_or_default().to_owned();
        pushes.shown = Some(Shown {
            lang,
            project,
            status,
        });
    }
    ui::run(show_tooltip);
    Value::Null
}

/// `progress:set` from an app page (`RunProgressState`).
pub fn progress_push(caller: &Caller, state: &Value) -> Value {
    if let Caller::Page(id) = caller {
        pushes().progress.insert(id.wc, progress_state(state));
        ui::run(|| {
            let state = progress(pushes().progress.values().copied());
            crate::app_window::set_run_progress(state);
        });
    }
    Value::Null
}

/// A window's page went: its status and progress no longer count.
pub fn forget(wc: u64) {
    let mut pushes = pushes();
    pushes.statuses.remove(&wc);
    pushes.progress.remove(&wc);
}

pub fn set_language(lang: Lang) {
    pushes().lang = lang;
}

struct Tray {
    icon: TrayIcon,
    tooltip: String,
}

thread_local! {
    static TRAY: RefCell<Option<Tray>> = const { RefCell::new(None) };
}

/// Sets the hover text when what a person reads changed. UI thread.
fn show_tooltip() {
    let next = tooltip(pushes().shown.as_ref());
    TRAY.with(|tray| {
        let mut tray = tray.borrow_mut();
        let Some(tray) = tray.as_mut().filter(|tray| tray.tooltip != next) else {
            return;
        };
        if let Err(error) = tray.icon.set_tooltip(Some(&next)) {
            log::log("tray.tooltip_failed", json!({"error":error.to_string()}));
        }
        tray.tooltip = next;
    });
}

/// The OMPdesk mark (scripts/gen-icons.ts): macOS's monochrome template, which the system tints for light and dark and
/// selected menu-bar states; on Windows the full-color tile, visible on light and dark taskbars. The run status is the
/// hover text: painting it here would turn the mark into a noisy status dot.
fn icon() -> Result<Icon, String> {
    let images: [&[u8]; 2] = if cfg!(target_os = "macos") {
        [
            include_bytes!("../../../../../resources/brand/trayTemplate.png"),
            include_bytes!("../../../../../resources/brand/trayTemplate@2x.png"),
        ]
    } else {
        [
            include_bytes!("../../../../../resources/brand/tray.png"),
            include_bytes!("../../../../../resources/brand/tray@2x.png"),
        ]
    };
    let scale = crate::menu::display_scale();
    let index = tray_image::pick(&[1.0, 2.0], scale).unwrap_or(0);
    let image = tray_image::decode_image(images[index], (16.0 * scale).round() as u32)?;
    Icon::from_rgba(image.data, image.width, image.height)
        .map_err(|error| format!("the tray image is unusable: {error}"))
}

static HANDLER: Once = Once::new();

/// Node's startup windows exist (`session.ready`, where Node created its tray). Not in a test run: the menu bar is
/// shared with the person's own OMPdesk, and a test's status item once stalled the app (release run 38048085831).
pub fn create() {
    if std::env::var("OMP_GUI_HEADLESS").as_deref() == Ok("1") {
        return;
    }
    ui::run(|| {
        if TRAY.with(|tray| tray.borrow().is_some()) {
            return;
        }
        HANDLER.call_once(|| {
            TrayIconEvent::set_event_handler(Some(|event: TrayIconEvent| {
                ui::post(move || on_event(event))
            }));
        });
        let tooltip = tooltip(pushes().shown.as_ref());
        let made = icon().and_then(|icon| {
            TrayIcon::new(TrayIconAttributes {
                #[cfg(target_os = "macos")]
                icon_is_template: true,
                icon: Some(icon),
                tooltip: Some(tooltip.clone()),
                ..Default::default()
            })
            .map_err(|error| error.to_string())
        });
        match made {
            Ok(icon) => TRAY.with(|tray| *tray.borrow_mut() = Some(Tray { icon, tooltip })),
            Err(error) => log::log("tray.create_failed", json!({"error":error})),
        }
    });
}

/// The quit's teardown: the icon leaves the notification area.
pub fn remove() {
    ui::run(|| drop(TRAY.with(|tray| tray.borrow_mut().take())));
}

/// A mouse event of the icon. Windows: a left click brings the window back, a right click opens the menu. macOS: a
/// click opens the menu. UI thread.
fn on_event(event: TrayIconEvent) {
    let TrayIconEvent::Click {
        button,
        button_state: MouseButtonState::Up,
        ..
    } = event
    else {
        return;
    };
    match button {
        MouseButton::Left if cfg!(target_os = "macos") => open(None),
        MouseButton::Left => show_target(),
        MouseButton::Right if cfg!(windows) => open(None),
        _ => {}
    }
}

/// The target window comes forward, or one opens.
fn show_target() {
    match entry::target(&entry::app_windows()) {
        Some(win) => {
            entry::op(win, "show");
            entry::op(win, "focus");
        }
        None => entry::push(Open::Spawn),
    }
}

/// What clicking the update item does: the updater's check, download or install, in Node.
#[derive(Clone, Copy, Debug, PartialEq)]
enum UpdateAction {
    Check,
    Download,
    Install,
}

impl UpdateAction {
    fn name(self) -> &'static str {
        match self {
            Self::Check => "check",
            Self::Download => "download",
            Self::Install => "install",
        }
    }
}

#[derive(Debug, PartialEq)]
struct UpdateItem {
    label: String,
    /// None when it only reports.
    action: Option<UpdateAction>,
}

/// The update item for the updater's `UpdateStatus`. `up_to_date` is whether a finished "no update" check is still
/// announced; after that the item offers a check again.
fn update_item(lang: Lang, status: &Value, up_to_date: bool) -> UpdateItem {
    use UpdateAction::*;
    let version = status["version"].as_str().unwrap_or_default();
    let manual = status["mode"] == "manual";
    let named = |key| fill(lang, key, &[("version", version)]);
    let (label, action) = match status["state"].as_str() {
        Some("checking") => (text(lang, "tray.updateChecking").into(), None),
        Some("available") if manual => (named("tray.updateDownload"), Some(Download)),
        Some("available") => (named("tray.updateDownloading"), None),
        Some("downloading") => {
            let percent = status["percent"].to_string();
            let params = [("version", version), ("percent", percent.as_str())];
            (fill(lang, "tray.updateDownloadingPercent", &params), None)
        }
        Some("downloaded") if status["installing"] == true => {
            (named("tray.updateInstalling"), None)
        }
        Some("downloaded") if manual => (named("tray.updateOpenInstaller"), Some(Install)),
        Some("downloaded") => (named("tray.updateRestart"), Some(Install)),
        Some("not-available") if up_to_date => (text(lang, "tray.updateUpToDate").into(), None),
        Some("error") => (text(lang, "tray.updateFailed").into(), Some(Check)),
        _ => (text(lang, "tray.updateCheck").into(), Some(Check)),
    };
    UpdateItem { label, action }
}

/// Node's answer to `tray.update`: `{status, notAvailableAt}` (epoch ms of the last check that found nothing).
fn update_of(answer: &Value, lang: Lang, now_ms: f64) -> UpdateItem {
    let up_to_date = answer["notAvailableAt"]
        .as_f64()
        .is_some_and(|at| now_ms - at < UP_TO_DATE_MS);
    update_item(lang, &answer["status"], up_to_date)
}

#[derive(Debug, PartialEq)]
enum Choice {
    Toggle,
    Update(UpdateAction),
    Quit,
}

/// The whole menu: show/hide, the update item, Quit.
fn items(lang: Lang, window_visible: bool, update: &UpdateItem) -> Vec<Item> {
    let item = |id: &str, label: &str, enabled| Item {
        id: id.into(),
        label: label.into(),
        kind: if id.is_empty() {
            Kind::Separator
        } else {
            Kind::Normal
        },
        enabled,
        visible: true,
        checked: false,
        accelerator: None,
        sublabel: None,
        tool_tip: None,
        role: None,
        submenu: Vec::new(),
    };
    let toggle = if window_visible {
        "tray.hide"
    } else {
        "tray.open"
    };
    vec![
        item("toggle", text(lang, toggle), true),
        item("update", &update.label, update.action.is_some()),
        item("", "", true),
        item("quit", text(lang, "tray.quit"), true),
    ]
}

/// What the item `id` does; nothing for an update item that only reports.
fn choice(id: &str, update: &UpdateItem) -> Option<Choice> {
    match id {
        "toggle" => Some(Choice::Toggle),
        "update" => update.action.map(Choice::Update),
        "quit" => Some(Choice::Quit),
        _ => None,
    }
}

/// Opens the menu: Node's updater status first (off the UI thread), then the menu at the cursor. `test` is the test
/// inspector's click on the item it names, in place of the person's.
fn open(test: Option<(String, Call)>) {
    std::thread::spawn(move || {
        let answer =
            host::request_blocking("tray.update", json!({}), NODE_WAIT).unwrap_or_else(|error| {
                log::log(
                    "tray.update_unanswered",
                    json!({"code":error.code,"error":error.message}),
                );
                Value::Null
            });
        ui::run(move || show(&answer, test));
    });
}

/// UI thread.
fn show(answer: &Value, test: Option<(String, Call)>) {
    let lang = {
        let pushes = pushes();
        pushes
            .shown
            .as_ref()
            .map_or(pushes.lang, |shown| shown.lang)
    };
    let windows = entry::app_windows();
    let visible = entry::target(&windows)
        .and_then(|win| windows.iter().find(|(w, _)| *w == win))
        .is_some_and(|(_, window)| window.is_visible().unwrap_or(false));
    let update = update_of(answer, lang, crate::wall_clock_ms() as f64);
    let items = items(lang, visible, &update);
    let chosen = match test {
        Some((label, call)) => match items.iter().find(|item| item.label == label) {
            Some(item) => {
                call.ok(json!({}));
                Some(item.id.clone())
            }
            None => return call.err("gone", format!("the tray menu has no item {label}")),
        },
        None => {
            let popup = menu_model::build_popup(&items, cfg!(target_os = "macos"));
            match platform::popup(0, &popup.entries, None, || {}, || {}) {
                Ok(cmd) => cmd.and_then(|cmd| popup.id_of(cmd)).map(str::to_owned),
                Err(error) => {
                    log::log("tray.menu_failed", json!({"error":error}));
                    None
                }
            }
        }
    };
    match chosen.and_then(|id| choice(&id, &update)) {
        Some(Choice::Toggle) => toggle(),
        Some(Choice::Update(action)) => {
            host::event("tray.runUpdate", json!({"action":action.name()}));
        }
        Some(Choice::Quit) => quit_chain::ask("tray"),
        None => {}
    }
}

/// Open/Hide acts on the window the person is looking at (the focused one, else the first), or opens one.
fn toggle() {
    let windows = entry::app_windows();
    let Some(win) = entry::target(&windows) else {
        return entry::push(Open::Spawn);
    };
    let visible = windows
        .iter()
        .find(|(w, _)| *w == win)
        .is_some_and(|(_, window)| window.is_visible().unwrap_or(false));
    if visible {
        entry::op(win, "hide");
    } else {
        entry::op(win, "show");
        entry::op(win, "focus");
    }
}

/// `menu.testClick {menu: "tray", label}` (app_menu.rs): the menu opens as for a click and `label` is chosen. UI thread.
pub fn test_click(label: String, call: Call) {
    if TRAY.with(|tray| tray.borrow().is_none()) {
        return call.err("gone", "there is no tray");
    }
    open(Some((label, call)));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(items: &[Item]) -> Vec<&str> {
        items
            .iter()
            .map(|item| {
                if item.kind == Kind::Separator {
                    "---"
                } else {
                    item.label.as_str()
                }
            })
            .collect()
    }

    fn update(status: Value) -> UpdateItem {
        update_item(Lang::En, &status, true)
    }

    #[test]
    fn the_menu_is_open_or_hide_the_update_item_and_quit() {
        let check = update(json!({"state":"idle"}));
        assert_eq!(
            labels(&items(Lang::En, true, &check)),
            ["Hide OMPdesk", "Check for updates", "---", "Quit"]
        );
        assert_eq!(labels(&items(Lang::En, false, &check))[0], "Open OMPdesk");
        assert_eq!(
            labels(&items(Lang::Ko, false, &check)),
            ["OMPdesk 열기", "Check for updates", "---", "종료"]
        );
    }

    #[test]
    fn words_the_update_item_for_each_updater_state() {
        for (status, label, enabled) in [
            (json!({"state":"idle"}), "Check for updates", true),
            (
                json!({"state":"auth-required","reason":"missing"}),
                "Check for updates",
                true,
            ),
            (json!({"state":"checking"}), "Checking for updates…", false),
            (
                json!({"state":"available","version":"1.2.3","mode":"automatic"}),
                "Downloading v1.2.3…",
                false,
            ),
            (
                json!({"state":"available","version":"1.2.3","mode":"manual"}),
                "Download v1.2.3",
                true,
            ),
            (
                json!({"state":"downloading","version":"1.2.3","mode":"relaunch","percent":42}),
                "Downloading v1.2.3… 42%",
                false,
            ),
            (
                json!({"state":"downloaded","version":"1.2.3","mode":"relaunch"}),
                "Restart to update to v1.2.3",
                true,
            ),
            (
                json!({"state":"downloaded","version":"1.2.3","mode":"automatic","restartAt":5}),
                "Restart to update to v1.2.3",
                true,
            ),
            (
                json!({"state":"downloaded","version":"1.2.3","mode":"manual"}),
                "Open installer for v1.2.3",
                true,
            ),
            (
                json!({"state":"downloaded","version":"1.2.3","mode":"automatic","installing":true}),
                "Installing v1.2.3…",
                false,
            ),
            (
                json!({"state":"not-available","version":"1.0.0"}),
                "OMPdesk is up to date",
                false,
            ),
            (
                json!({"state":"error","message":"x"}),
                "Update failed — try again",
                true,
            ),
        ] {
            let item = update(status.clone());
            let menu = items(Lang::En, true, &item);
            assert_eq!(menu[1].label, label, "{status}");
            assert_eq!(menu[1].enabled, enabled, "{status}");
            assert_eq!(menu.len(), 4);
        }
    }

    #[test]
    fn offers_a_check_again_once_the_up_to_date_notice_has_run_out() {
        let answer =
            json!({"status":{"state":"not-available","version":"1.0.0"},"notAvailableAt":1_000});
        assert_eq!(
            update_of(&answer, Lang::En, 1_000.0 + 29_999.0).label,
            "OMPdesk is up to date"
        );
        let gone = update_of(&answer, Lang::En, 1_000.0 + 30_000.0);
        assert_eq!(gone.label, "Check for updates");
        assert_eq!(gone.action, Some(UpdateAction::Check));
        // Node did not answer: the item offers a check.
        assert_eq!(
            update_of(&Value::Null, Lang::En, 0.0),
            update(json!({"state":"idle"}))
        );
    }

    #[test]
    fn speaks_korean_when_the_page_reports_it() {
        let item = update_item(
            Lang::Ko,
            &json!({"state":"downloaded","version":"1.2.3","mode":"relaunch"}),
            true,
        );
        assert_eq!(item.label, "다시 시작해서 v1.2.3 업데이트");
    }

    #[test]
    fn runs_the_check_the_download_or_the_install_its_label_names_and_nothing_for_a_report() {
        let click = |status: Value| choice("update", &update(status));
        use UpdateAction::*;
        assert_eq!(click(json!({"state":"idle"})), Some(Choice::Update(Check)));
        assert_eq!(
            click(json!({"state":"error","message":"x"})),
            Some(Choice::Update(Check))
        );
        assert_eq!(
            click(json!({"state":"available","version":"1.2.3","mode":"manual"})),
            Some(Choice::Update(Download))
        );
        assert_eq!(
            click(json!({"state":"downloaded","version":"1.2.3","mode":"relaunch"})),
            Some(Choice::Update(Install))
        );
        assert_eq!(click(json!({"state":"checking"})), None);
        assert_eq!(
            click(json!({"state":"downloading","version":"1.2.3","mode":"automatic","percent":1})),
            None
        );
        let check = update(json!({"state":"idle"}));
        assert_eq!(choice("toggle", &check), Some(Choice::Toggle));
        assert_eq!(choice("quit", &check), Some(Choice::Quit));
        assert_eq!(choice("", &check), None);
    }

    #[test]
    fn the_menu_is_built_from_what_holds_when_it_opens() {
        // What a rebuilt menu could differ in; the same facts give the same menu, any change of them another.
        let menu =
            |lang, visible, status: Value| items(lang, visible, &update_item(lang, &status, true));
        let base = menu(Lang::En, true, json!({"state":"idle"}));
        assert_eq!(menu(Lang::En, true, json!({"state":"idle"})), base);
        assert_ne!(menu(Lang::En, false, json!({"state":"idle"})), base);
        assert_ne!(menu(Lang::Ko, true, json!({"state":"idle"})), base);
        assert_ne!(menu(Lang::En, true, json!({"state":"checking"})), base);
        let downloading = |percent| json!({"state":"downloading","version":"1.2.3","mode":"automatic","percent":percent});
        assert_ne!(
            menu(Lang::En, true, downloading(1)),
            menu(Lang::En, true, downloading(2))
        );
    }

    #[test]
    fn names_the_run_state_in_the_hover_text() {
        let shown = |status, lang| Shown {
            lang,
            project: "alpha".into(),
            status,
        };
        assert_eq!(
            tooltip(Some(&shown(Status::Streaming, Lang::En))),
            "OMPdesk — alpha · Working"
        );
        assert_eq!(
            tooltip(Some(&shown(Status::Approval, Lang::Ko))),
            "OMPdesk — alpha · 승인 필요"
        );
        assert!(tooltip(Some(&shown(Status::Error, Lang::En))).contains("Error"));
        assert!(tooltip(Some(&shown(Status::Idle, Lang::En))).contains("Ready"));
        assert_eq!(tooltip(None), "OMPdesk");
        let all = [
            Status::Idle,
            Status::Streaming,
            Status::Question,
            Status::Approval,
            Status::ChildWaiting,
            Status::Error,
        ];
        for lang in [Lang::En, Lang::Ko] {
            let mut words: Vec<&str> = all.iter().map(|s| s.label(lang)).collect();
            words.sort_unstable();
            words.dedup();
            assert_eq!(words.len(), all.len(), "every status has its own words");
        }
    }

    #[test]
    fn the_loudest_window_wins_whatever_the_push_order() {
        let windows = |statuses: &[&str]| loudest(statuses.iter().map(|s| Status::parse(s)));
        assert_eq!(windows(&["streaming", "error"]), Status::Error);
        assert_eq!(windows(&["idle", "error"]), Status::Error);
        assert_eq!(windows(&["approval", "streaming"]), Status::Approval);
        assert_eq!(
            windows(&["streaming", "childWaiting"]),
            Status::ChildWaiting
        );
        assert_eq!(windows(&["idle", "streaming"]), Status::Streaming);
        assert_eq!(windows(&["approval", "question"]), Status::Question);
        // A status this build does not know never hides an error or a wait.
        assert_eq!(windows(&["someday", "error"]), Status::Error);
        assert_eq!(windows(&["question", "someday"]), Status::Question);
        assert_eq!(windows(&["someday"]), Status::Idle);
        assert_eq!(windows(&[]), Status::Idle);
        assert_eq!(windows(&["idle"]), Status::Idle);
    }

    #[test]
    fn the_app_icon_waits_while_any_window_waits_on_the_person() {
        let states = |states: &[&str]| progress(states.iter().map(|s| progress_state(&json!(s))));
        assert_eq!(states(&["working", "waiting"]), "waiting");
        assert_eq!(states(&["waiting", "working", "idle"]), "waiting");
        assert_eq!(states(&["idle", "working"]), "working");
        assert_eq!(states(&[]), "idle");
    }
}
