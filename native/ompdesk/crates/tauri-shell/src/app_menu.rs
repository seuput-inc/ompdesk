//! The application menu (docs/rust-node-removal.md W3; was `src/main/menu.ts`): the macOS menu bar, and on Windows the
//! same items' accelerators while an app window has the keyboard. Node pushes its UI language (`app.language`), the
//! shell builds the menu in it and runs every item itself: a page's action goes to the target window's page
//! (`menu:action`), a window's or the app's work runs here.
//!
//! Chord rule: a shortcut the renderer keymap owns is never a menu accelerator here. The menu resolves its accelerators
//! before the page sees the key, so a duplicate would fire while the person's remap of the same action stayed dead.
//! The menu's own chords are `NATIVE_CHORDS` (src/shared/hotkeys.ts), which the keymap reads as reserved.

use crate::host::Call;
use crate::labels::{Lang, text};
use crate::{entry, log, quit_chain, runtime, tray};
use serde_json::json;
use shell_core::menu_model::{Hit, Item, Kind};
use std::cell::RefCell;

#[cfg(windows)]
use shell_core::sys::menu as platform;
#[cfg(target_os = "macos")]
use shell_core::sys_mac::menu as platform;

/// `PRODUCT_REPO_URL` (src/shared/product-repo.ts).
const DOCUMENTATION: &str = "https://github.com/seuput-inc/ompdesk";

/// What choosing an item does.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Action {
    /// `MenuAction` (src/shared/ipc-types.ts) for the target window's page.
    Page(&'static str),
    NewWindow,
    CloseWindow,
    /// The quit chain's `ask`, logged as the app menu's Quit.
    Quit,
    Documentation,
    /// Electron's role on the focused window, as the shim ran it: reload, zoom, developer tools, full screen, minimize,
    /// and on Windows the edit commands.
    Role(&'static str),
}

/// An item of the template. `role` is one AppKit runs itself (macOS); such an item has no action.
enum Entry {
    Item {
        label: &'static str,
        accelerator: Option<&'static str>,
        action: Option<Action>,
        role: Option<&'static str>,
    },
    Separator,
    Submenu(&'static str, Vec<Entry>),
}

fn page(label: &'static str, action: &'static str) -> Entry {
    run(label, None, Action::Page(action))
}

fn run(label: &'static str, accelerator: Option<&'static str>, action: Action) -> Entry {
    Entry::Item {
        label,
        accelerator,
        action: Some(action),
        role: None,
    }
}

fn native(label: &'static str, role: &'static str, accelerator: Option<&'static str>) -> Entry {
    Entry::Item {
        label,
        accelerator,
        action: None,
        role: Some(role),
    }
}

/// An edit command: AppKit's first responder on macOS, the shim's role action elsewhere.
fn edit(label: &'static str, role: &'static str, accelerator: &'static str, mac: bool) -> Entry {
    if mac {
        native(label, role, Some(accelerator))
    } else {
        run(label, Some(accelerator), Action::Role(role))
    }
}

/// The menu as `createMenu` built it, with Electron's default accelerator of each role (the shim's `ROLES`).
fn template(mac: bool) -> Vec<Entry> {
    use Entry::{Separator, Submenu};
    let pick = |on_mac: &'static str, elsewhere: &'static str| if mac { on_mac } else { elsewhere };
    let mut menu = Vec::new();
    if mac {
        menu.push(Submenu(
            "app",
            vec![
                native("menu.about", "about", None),
                page("menu.checkUpdates", "check-updates"),
                Separator,
                // No accelerator: ⌘, (and its ⌃, twin) belong to the renderer keymap so people can remap them.
                page("menu.settings", "open-settings"),
                Separator,
                native("menu.services", "services", None),
                Separator,
                native("menu.hide", "hide", None),
                native("menu.hideOthers", "hideOthers", None),
                native("menu.showAll", "unhide", None),
                Separator,
                run("menu.quit", Some("Command+Q"), Action::Quit),
            ],
        ));
    }
    let mut file = vec![
        // No accelerator: ⌘⇧O is the shell's global window toggle (entry.rs). Registering it here too makes macOS fire
        // both (dialog + hide) and Windows swallow the menu shortcut entirely.
        page("menu.openProject", "open-project"),
        Separator,
        run(
            "menu.newSession",
            Some("CmdOrCtrl+N"),
            Action::Page("new-session"),
        ),
        // No accelerator: ⌘T/⇧⌘T live in the renderer keymap so people can remap them.
        page("menu.newTab", "new-tab"),
        page("menu.newChatTab", "new-chat-tab"),
        run(
            "menu.newWindow",
            Some("CmdOrCtrl+Shift+N"),
            Action::NewWindow,
        ),
    ];
    if !mac {
        file.extend([Separator, page("menu.settings", "open-settings")]);
    }
    menu.push(Submenu("menu.file", file));
    menu.push(Submenu(
        "menu.edit",
        vec![
            edit("menu.undo", "undo", "CommandOrControl+Z", mac),
            edit(
                "menu.redo",
                "redo",
                pick("Shift+CommandOrControl+Z", "Control+Y"),
                mac,
            ),
            Separator,
            edit("menu.cut", "cut", "CommandOrControl+X", mac),
            edit("menu.copy", "copy", "CommandOrControl+C", mac),
            edit("menu.paste", "paste", "CommandOrControl+V", mac),
            edit("menu.selectAll", "selectAll", "CommandOrControl+A", mac),
        ],
    ));
    let role = |label, role, accelerator| run(label, Some(accelerator), Action::Role(role));
    menu.push(Submenu(
        "menu.view",
        vec![
            page("menu.commandCenter", "open-command-center"),
            page("menu.contextReport", "open-context-report"),
            page("menu.stats", "open-stats"),
            page("menu.jobs", "open-jobs"),
            page("menu.hotkeys", "open-hotkeys"),
            Separator,
            // No accelerators: ⌘B and ⌘J belong to the renderer keymap.
            page("menu.toggleSidebar", "toggle-sidebar"),
            page("menu.togglePanel", "toggle-panel"),
            Separator,
            role("menu.reload", "reload", "CommandOrControl+R"),
            role(
                "menu.forceReload",
                "forceReload",
                "Shift+CommandOrControl+R",
            ),
            role(
                "menu.toggleDevTools",
                "toggleDevTools",
                pick("Alt+Command+I", "Control+Shift+I"),
            ),
            Separator,
            role("menu.actualSize", "resetZoom", "CommandOrControl+0"),
            role("menu.zoomIn", "zoomIn", "CommandOrControl+Plus"),
            role("menu.zoomOut", "zoomOut", "CommandOrControl+-"),
            Separator,
            role(
                "menu.toggleFullScreen",
                "togglefullscreen",
                pick("Control+Command+F", "F11"),
            ),
        ],
    ));
    // The macOS habit: ⌘W closes a tab, ⇧⌘W the window (a window-level close at ⌘W took every tab with it).
    let mut window = vec![
        // No accelerator: ⌘W belongs to the renderer keymap so people can remap it.
        page("menu.closeTab", "close-tab"),
        run(
            "menu.closeWindow",
            Some("CmdOrCtrl+Shift+W"),
            Action::CloseWindow,
        ),
        Separator,
        role("menu.minimize", "minimize", "CommandOrControl+M"),
    ];
    if mac {
        window.extend([
            native("menu.zoom", "zoom", None),
            Separator,
            native("menu.bringAllToFront", "front", None),
        ]);
    }
    menu.push(Submenu("menu.window", window));
    menu.push(Submenu(
        "menu.session",
        vec![
            page("menu.importSession", "open-import"),
            page("menu.branchPicker", "open-branch-picker"),
            page("menu.sessionTree", "open-session-tree"),
            Separator,
            page("menu.sessionInfo", "open-session-info"),
            page("menu.shareSession", "open-share-session"),
            run(
                "menu.exportHtml",
                Some("CmdOrCtrl+E"),
                Action::Page("export-html"),
            ),
            page("menu.handoff", "handoff"),
        ],
    ));
    menu.push(Submenu(
        "menu.tools",
        vec![
            page("menu.agentHub", "open-agent-hub"),
            page("menu.modes", "open-modes"),
            page("menu.providers", "open-providers"),
            page("menu.modelRoles", "open-model-roles"),
            page("menu.modelPicker", "open-model-picker"),
            page("menu.capabilities", "open-capabilities"),
            page("menu.usage", "open-usage"),
            Separator,
            page("menu.extensions", "open-extensions"),
            page("menu.inventory", "open-inventory"),
            page("menu.prCenter", "open-pr-center"),
            page("menu.workspaceDirs", "open-workspace-dirs"),
            page("menu.workspaceChanges", "open-git"),
            page("menu.restartCore", "restart-sidecar"),
            Separator,
            page("menu.debugConsole", "open-debug"),
        ],
    ));
    // macOS has Check for Updates in the app menu; Windows has no app menu.
    let mut help = vec![native("menu.about", "about", None)];
    if !mac {
        help.push(page("menu.checkUpdates", "check-updates"));
    }
    help.extend([
        page("menu.reportIssue", "open-feedback"),
        run("menu.documentation", None, Action::Documentation),
    ]);
    menu.push(Submenu("menu.help", help));
    menu
}

/// The template as the platform takes it: each item's id is its index in the second list, which holds its label and
/// what it does.
fn build(
    lang: Lang,
    entries: Vec<Entry>,
    choices: &mut Vec<(&'static str, Option<Action>)>,
) -> Vec<Item> {
    let item =
        |id: String, label: &str, kind, accelerator: Option<&str>, role: Option<&str>, submenu| {
            Item {
                id,
                label: label.to_owned(),
                kind,
                enabled: true,
                visible: true,
                checked: false,
                accelerator: accelerator.map(str::to_owned),
                sublabel: None,
                tool_tip: None,
                role: role.map(str::to_owned),
                submenu,
            }
        };
    entries
        .into_iter()
        .map(|entry| match entry {
            Entry::Separator => item(String::new(), "", Kind::Separator, None, None, Vec::new()),
            Entry::Submenu(label, entries) => {
                // The macOS app menu's title is the app's name, whatever it says.
                let title = if label == "app" {
                    "OMPdesk"
                } else {
                    text(lang, label)
                };
                let submenu = build(lang, entries, choices);
                item(String::new(), title, Kind::Submenu, None, None, submenu)
            }
            Entry::Item {
                label,
                accelerator,
                action,
                role,
            } => {
                let label = text(lang, label);
                choices.push((label, action));
                let id = (choices.len() - 1).to_string();
                item(id, label, Kind::Normal, accelerator, role, Vec::new())
            }
        })
        .collect()
}

thread_local! {
    /// The installed menu's items by id: their labels and what they do.
    static CHOICES: RefCell<Vec<(&'static str, Option<Action>)>> = const { RefCell::new(Vec::new()) };
}

/// Installs the menu in `lang` (Node's `app.language`, at start and on every change). UI thread.
pub fn install(lang: Lang) {
    let mut choices = Vec::new();
    let items = build(lang, template(cfg!(target_os = "macos")), &mut choices);
    CHOICES.with(|c| *c.borrow_mut() = choices);
    if let Err(error) = platform::set_application(Some(&items), hit) {
        log::log("menu.install_failed", json!({"error":error}));
    }
}

/// An item chosen, or its accelerator pressed. UI thread.
fn hit(hit: Hit) {
    let action = CHOICES.with(|c| {
        let index: usize = hit.id.parse().ok()?;
        c.borrow().get(index)?.1
    });
    if let Some(action) = action {
        perform(action);
    }
}

/// `menu.testClick {menu: "app" | "tray", label}`: the test inspector's click (`OMP_GUI_TEST_NODE_INSPECT=1`, Node's
/// `__ompdeskMenus`) on the item named `label`, chosen as a person chooses it. scripts/mac-launch-check.sh quits from
/// both menus with it and e2e/desktop.e2e.ts checks for updates. UI thread.
pub fn test_click(call: Call) {
    if std::env::var("OMP_GUI_TEST_NODE_INSPECT").as_deref() != Ok("1") {
        return call.unsupported();
    }
    let label = call.str("label").unwrap_or_default();
    match call.params["menu"].as_str() {
        Some("app") => {
            let action = CHOICES.with(|c| {
                c.borrow()
                    .iter()
                    .find(|(l, _)| *l == label)
                    .map(|(_, a)| *a)
            });
            let Some(action) = action else {
                return call.err("gone", format!("the app menu has no item {label}"));
            };
            call.ok(json!({}));
            if let Some(action) = action {
                perform(action);
            }
        }
        Some("tray") => tray::test_click(label, call),
        _ => call.err("invalid", "menu.testClick needs menu app or tray"),
    }
}

fn perform(action: Action) {
    match action {
        Action::Page(name) => entry::menu_action(name),
        Action::NewWindow => entry::new_window(),
        Action::CloseWindow => entry::close_target(),
        Action::Quit => quit_chain::ask("app-menu"),
        Action::Documentation => open_documentation(),
        Action::Role(role) => focused_role(role),
    }
}

fn open_documentation() {
    #[cfg(windows)]
    use shell_core::sys::shellops::open_external;
    #[cfg(target_os = "macos")]
    use shell_core::sys_mac::shellops::open_external;
    if let Err(error) = open_external(DOCUMENTATION) {
        log::log("shell.open_external_failed", json!({"error":error}));
    }
}

/// The role's work on the focused app window, through the same `win.op`/`wc.op` Node's calls took, so Node's mirror
/// hears it; nothing without a focused window, as Electron's role did nothing then.
fn focused_role(role: &'static str) {
    let Some((win, window)) = entry::app_windows()
        .into_iter()
        .find(|(_, window)| crate::window_focused(window).unwrap_or(false))
    else {
        return;
    };
    let Some((wc, zoom)) = runtime()
        .registry
        .lock()
        .expect("registry")
        .by_window(win)
        .map(|page| (page.identity.wc, page.zoom))
    else {
        return;
    };
    let wc_op = |op: &str, args| crate::wc_apply(&json!({"wcId":wc,"op":op,"args":args})).map(drop);
    let win_op =
        |op: &str, args| crate::win_op(&json!({"winId":win,"op":op,"args":args})).map(drop);
    let result = match role {
        "toggleDevTools" if window.is_devtools_open() => wc_op("closeDevTools", json!({})),
        "toggleDevTools" => wc_op("openDevTools", json!({})),
        "forceReload" => wc_op("reloadIgnoringCache", json!({})),
        "resetZoom" => wc_op("setZoomFactor", json!({"factor":1.0})),
        "zoomIn" => wc_op("setZoomFactor", json!({"factor":(zoom * 1.2).min(5.0)})),
        "zoomOut" => wc_op("setZoomFactor", json!({"factor":(zoom / 1.2).max(0.25)})),
        "togglefullscreen" => win_op(
            "setFullScreen",
            json!({"on":!window.is_fullscreen().unwrap_or(false)}),
        ),
        "minimize" => win_op("minimize", json!({})),
        // reload and the edit commands keep their names.
        other => wc_op(other, json!({})),
    };
    if let Err(error) = result {
        log::log(
            "menu.role_failed",
            json!({"role":role,"winId":win,"error":error.message}),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn built(lang: Lang, mac: bool) -> (Vec<Item>, Vec<(&'static str, Option<Action>)>) {
        let mut choices = Vec::new();
        let items = build(lang, template(mac), &mut choices);
        (items, choices)
    }

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

    fn submenu<'a>(items: &'a [Item], label: &str) -> &'a [Item] {
        &items
            .iter()
            .find(|item| item.label == label)
            .unwrap()
            .submenu
    }

    fn find<'a>(items: &'a [Item], label: &str) -> &'a Item {
        items
            .iter()
            .flat_map(|top| top.submenu.iter())
            .find(|item| item.label == label)
            .unwrap_or_else(|| panic!("no {label}"))
    }

    #[test]
    fn macos_has_the_app_menu_and_windows_does_not() {
        let (mac, _) = built(Lang::En, true);
        let (windows, _) = built(Lang::En, false);
        assert_eq!(
            labels(&mac),
            [
                "OMPdesk", "File", "Edit", "View", "Window", "Session", "Tools", "Help"
            ]
        );
        assert_eq!(
            labels(&windows),
            ["File", "Edit", "View", "Window", "Session", "Tools", "Help"]
        );
        assert_eq!(
            labels(submenu(&mac, "OMPdesk")),
            [
                "About OMPdesk",
                "Check for Updates…",
                "---",
                "Settings…",
                "---",
                "Services",
                "---",
                "Hide OMPdesk",
                "Hide Others",
                "Show All",
                "---",
                "Quit OMPdesk"
            ]
        );
    }

    #[test]
    fn settings_and_check_for_updates_move_with_the_app_menu() {
        let (mac, _) = built(Lang::En, true);
        let (windows, _) = built(Lang::En, false);
        let file = [
            "Open Project…",
            "---",
            "New Session",
            "New Tab",
            "New Chat Tab",
            "New Window",
        ];
        assert_eq!(labels(submenu(&mac, "File")), file);
        assert_eq!(
            labels(submenu(&windows, "File")),
            [&file[..], &["---", "Settings…"]].concat()
        );
        assert_eq!(
            labels(submenu(&mac, "Help")),
            ["About OMPdesk", "Send Feedback…", "Documentation"]
        );
        assert_eq!(
            labels(submenu(&windows, "Help")),
            [
                "About OMPdesk",
                "Check for Updates…",
                "Send Feedback…",
                "Documentation"
            ]
        );
        assert_eq!(
            labels(submenu(&mac, "Window")),
            [
                "Close Tab",
                "Close Window",
                "---",
                "Minimize",
                "Zoom",
                "---",
                "Bring All to Front"
            ]
        );
        assert_eq!(
            labels(submenu(&windows, "Window")),
            ["Close Tab", "Close Window", "---", "Minimize"]
        );
    }

    #[test]
    fn speaks_korean_when_node_says_so() {
        let (items, _) = built(Lang::Ko, false);
        assert_eq!(
            labels(&items),
            ["파일", "편집", "보기", "창", "세션", "도구", "도움말"]
        );
        assert_eq!(
            find(&items, "새 세션").accelerator.as_deref(),
            Some("CmdOrCtrl+N")
        );
    }

    #[test]
    fn maps_the_native_chords_and_the_role_defaults() {
        for mac in [true, false] {
            let (items, _) = built(Lang::En, mac);
            let accelerator =
                |label: &str| find(&items, label).accelerator.clone().unwrap_or_default();
            // NATIVE_CHORDS (src/shared/hotkeys.ts), pinned there by menu-actions.test.ts.
            assert_eq!(accelerator("New Session"), "CmdOrCtrl+N");
            assert_eq!(accelerator("New Window"), "CmdOrCtrl+Shift+N");
            assert_eq!(accelerator("Close Window"), "CmdOrCtrl+Shift+W");
            assert_eq!(accelerator("Export HTML"), "CmdOrCtrl+E");
            // The keymap's own chords are never accelerators here.
            for label in [
                "Open Project…",
                "New Tab",
                "Close Tab",
                "Toggle Sidebar",
                "Toggle Side Panel",
                "Settings…",
            ] {
                assert_eq!(accelerator(label), "", "{label}");
            }
            assert_eq!(accelerator("Reload"), "CommandOrControl+R");
            assert_eq!(accelerator("Zoom In"), "CommandOrControl+Plus");
            assert_eq!(accelerator("Minimize"), "CommandOrControl+M");
            assert_eq!(accelerator("Copy"), "CommandOrControl+C");
        }
        let (mac, _) = built(Lang::En, true);
        let (windows, _) = built(Lang::En, false);
        let accelerator = |items: &[Item], label: &str| find(items, label).accelerator.clone();
        assert_eq!(
            accelerator(&mac, "Redo").as_deref(),
            Some("Shift+CommandOrControl+Z")
        );
        assert_eq!(accelerator(&windows, "Redo").as_deref(), Some("Control+Y"));
        assert_eq!(
            accelerator(&mac, "Toggle Full Screen").as_deref(),
            Some("Control+Command+F")
        );
        assert_eq!(
            accelerator(&windows, "Toggle Full Screen").as_deref(),
            Some("F11")
        );
        assert_eq!(
            accelerator(&mac, "Toggle Developer Tools").as_deref(),
            Some("Alt+Command+I")
        );
        assert_eq!(
            accelerator(&windows, "Toggle Developer Tools").as_deref(),
            Some("Control+Shift+I")
        );
        assert_eq!(
            accelerator(&mac, "Quit OMPdesk").as_deref(),
            Some("Command+Q")
        );
    }

    #[test]
    fn appkit_runs_its_own_roles_and_the_shell_runs_the_rest() {
        let (mac, mac_choices) = built(Lang::En, true);
        let (windows, windows_choices) = built(Lang::En, false);
        let role = |items: &[Item], label: &str| find(items, label).role.clone();
        for label in [
            "About OMPdesk",
            "Services",
            "Hide OMPdesk",
            "Hide Others",
            "Show All",
            "Bring All to Front",
        ] {
            assert!(role(&mac, label).is_some(), "{label}");
        }
        assert_eq!(role(&mac, "Copy").as_deref(), Some("copy"));
        assert_eq!(role(&mac, "Zoom").as_deref(), Some("zoom"));
        assert_eq!(role(&windows, "Copy"), None);
        assert_eq!(role(&mac, "Reload"), None);
        let action = |choices: &[(&str, Option<Action>)], label: &str| {
            choices.iter().find(|(l, _)| *l == label).unwrap().1
        };
        assert_eq!(action(&mac_choices, "Copy"), None);
        assert_eq!(action(&windows_choices, "Copy"), Some(Action::Role("copy")));
        assert_eq!(action(&mac_choices, "Quit OMPdesk"), Some(Action::Quit));
        assert_eq!(action(&mac_choices, "New Window"), Some(Action::NewWindow));
        assert_eq!(
            action(&mac_choices, "Close Window"),
            Some(Action::CloseWindow)
        );
        assert_eq!(
            action(&mac_choices, "Documentation"),
            Some(Action::Documentation)
        );
        assert_eq!(
            action(&windows_choices, "Check for Updates…"),
            Some(Action::Page("check-updates"))
        );
        assert_eq!(
            action(&windows_choices, "Toggle Full Screen"),
            Some(Action::Role("togglefullscreen"))
        );
    }

    #[test]
    fn every_item_names_its_choice_and_every_page_action_is_sent_once() {
        for mac in [true, false] {
            let (items, choices) = built(Lang::En, mac);
            let ids: Vec<&str> = items
                .iter()
                .flat_map(|top| top.submenu.iter())
                .filter(|item| item.kind == Kind::Normal)
                .map(|item| item.id.as_str())
                .collect();
            assert_eq!(ids.len(), choices.len());
            for (index, id) in ids.iter().enumerate() {
                assert_eq!(*id, index.to_string());
            }
            let mut sent: Vec<&str> = choices
                .iter()
                .filter_map(|(_, action)| match action {
                    Some(Action::Page(name)) => Some(*name),
                    _ => None,
                })
                .collect();
            let count = sent.len();
            sent.sort_unstable();
            sent.dedup();
            assert_eq!(sent.len(), count, "a page action sent twice");
            assert!(count > 20);
        }
    }
}
