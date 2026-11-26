//! OMPdesk's own notification popup (docs/design/custom-notifications.md): a small always-on-top card stack in the
//! corner of the screen, shown instead of the OS banner where the OS says the person may be interrupted. This module
//! holds the rules (which route a notification takes, the stack, where the window goes, what the page may ask);
//! `window.rs` holds the window and its page.

use std::collections::VecDeque;

use serde_json::{Value, json};

pub mod window;

/// Logical size of the stack: every pixel of the window is a card or the "+N more" row, so nothing beside a card
/// catches a click.
pub const WIDTH: f64 = 360.0;
pub const CARD_HEIGHT: f64 = 64.0;
pub const MORE_HEIGHT: f64 = 28.0;
/// Logical distance from the work area's right and bottom edges.
pub const MARGIN: f64 = 12.0;
/// Cards on screen at once; the rest wait behind "+N more".
pub const VISIBLE: usize = 3;
/// Time a card stays on screen while it counts down.
pub const SHOWN_MS: u64 = 6_000;
/// Input older than this pauses the countdown: a person who is away still finds the card when they return.
pub const AWAY_IDLE_SECONDS: u64 = 30;
/// A card whose page is not ready by then goes to the OS banner.
pub const READY_MS: u64 = 3_000;

/// Where one `notification.show` goes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Route {
    /// The popup, on screen.
    Popup,
    /// Today's OS banner (Windows toast, macOS Notification Center).
    Banner,
    /// A test run's popup: the page gets the card, the window never shows.
    Hidden,
}

impl Route {
    pub fn name(self) -> &'static str {
        match self {
            Self::Popup => "popup",
            Self::Banner => "banner",
            Self::Hidden => "hidden",
        }
    }
}

/// What kind of run this is, for `route`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Host {
    /// `OMP_GUI_HEADLESS=1` with `OMP_GUI_TEST_NOTIFICATION_POPUP=1`.
    Test,
    Windows,
    MacOs,
}

/// The route of one notification and why. `gate` asks the OS whether the person may be interrupted now (Windows); it
/// is only called where its answer decides.
pub fn route(host: Host, gate: impl FnOnce() -> Result<(), String>) -> (Route, String) {
    match host {
        Host::Test => (Route::Hidden, "test run".into()),
        // INFocusStatusCenter needs an entitlement a self-signed app cannot carry, so Focus is unknown: Notification
        // Center filters by Focus itself.
        Host::MacOs => (Route::Banner, "macOS Focus state is unknown".into()),
        Host::Windows => match gate() {
            Ok(()) => (Route::Popup, "the OS accepts notifications".into()),
            Err(why) => (Route::Banner, why),
        },
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Card {
    pub id: u64,
    pub title: String,
    pub body: String,
    /// Countdown left while on screen.
    pub left_ms: u64,
}

impl Card {
    pub fn new(id: u64, title: &str, body: &str) -> Self {
        Self {
            id,
            title: title.to_owned(),
            body: body.to_owned(),
            left_ms: SHOWN_MS,
        }
    }
}

/// The cards on screen, oldest first (the newest sits nearest the corner), and those waiting for a slot, in order.
#[derive(Debug, Default)]
pub struct Stack {
    shown: Vec<Card>,
    waiting: VecDeque<Card>,
}

impl Stack {
    pub fn push(&mut self, card: Card) {
        self.waiting.push_back(card);
        self.fill();
    }

    fn fill(&mut self) {
        while self.shown.len() < VISIBLE {
            let Some(card) = self.waiting.pop_front() else {
                break;
            };
            self.shown.push(card);
        }
    }

    /// Takes card `id` out, on screen or waiting; a waiting card moves up into a freed slot.
    pub fn remove(&mut self, id: u64) -> bool {
        let before = self.len();
        self.shown.retain(|card| card.id != id);
        self.waiting.retain(|card| card.id != id);
        self.fill();
        self.len() != before
    }

    /// `elapsed_ms` passed. The on-screen cards count down unless the pointer is over the stack or the person has
    /// been idle `AWAY_IDLE_SECONDS`. Returns the cards whose time ran out, now gone.
    pub fn tick(&mut self, elapsed_ms: u64, hovered: bool, idle_seconds: u64) -> Vec<u64> {
        if hovered || idle_seconds >= AWAY_IDLE_SECONDS {
            return Vec::new();
        }
        let mut expired = Vec::new();
        self.shown.retain_mut(|card| {
            card.left_ms = card.left_ms.saturating_sub(elapsed_ms);
            let done = card.left_ms == 0;
            if done {
                expired.push(card.id);
            }
            !done
        });
        self.fill();
        expired
    }

    pub fn len(&self) -> usize {
        self.shown.len() + self.waiting.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Logical window size for what is on screen.
    pub fn size(&self) -> (f64, f64) {
        let more = if self.waiting.is_empty() {
            0.0
        } else {
            MORE_HEIGHT
        };
        (WIDTH, self.shown.len() as f64 * CARD_HEIGHT + more)
    }

    /// What the page draws: the on-screen cards, oldest first, and how many wait.
    pub fn view(&self) -> Value {
        json!({
            "cards": self.shown.iter().map(|card| json!({"id": card.id, "title": card.title, "body": card.body})).collect::<Vec<_>>(),
            "more": self.waiting.len(),
        })
    }
}

/// A rectangle in physical pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Rect {
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= f64::from(self.x)
            && y >= f64::from(self.y)
            && x < f64::from(self.x) + f64::from(self.width)
            && y < f64::from(self.y) + f64::from(self.height)
    }
}

/// One monitor: its whole rectangle, its work area (without the taskbar) and its scale.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Screen {
    pub bounds: Rect,
    pub work_area: Rect,
    pub scale: f64,
}

/// Where the stack of logical `size` goes, in physical pixels: the bottom-right of the work area of the monitor under
/// the pointer (the screen the person looks at), else the primary one, else the first.
pub fn place(
    screens: &[Screen],
    primary: Option<usize>,
    pointer: Option<(f64, f64)>,
    size: (f64, f64),
) -> Option<Rect> {
    let screen = pointer
        .and_then(|(x, y)| screens.iter().find(|screen| screen.bounds.contains(x, y)))
        .or_else(|| primary.and_then(|at| screens.get(at)))
        .or_else(|| screens.first())?;
    let physical = |logical: f64| (logical * screen.scale).round();
    let (width, height) = (physical(size.0), physical(size.1));
    let margin = physical(MARGIN);
    let area = screen.work_area;
    Some(Rect {
        x: (f64::from(area.x) + f64::from(area.width) - width - margin) as i32,
        y: (f64::from(area.y) + f64::from(area.height) - height - margin) as i32,
        width: width as u32,
        height: height as u32,
    })
}

/// What the page asks, by navigating to `ompdesk-popup:<action>?id=<id>` (cancelled by the shell).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    /// The card was clicked: open its session.
    Click(u64),
    /// Its close button was clicked.
    Close(u64),
}

pub const SCHEME: &str = "ompdesk-popup";

/// The page's request in `url`, if it is one.
pub fn action(url: &url::Url) -> Option<Action> {
    if url.scheme() != SCHEME {
        return None;
    }
    let id = url
        .query_pairs()
        .find(|(key, _)| key == "id")?
        .1
        .parse()
        .ok()?;
    match url.path() {
        "click" => Some(Action::Click(id)),
        "close" => Some(Action::Close(id)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(id: u64) -> Card {
        Card::new(id, &format!("title {id}"), "body")
    }

    fn ids(stack: &Stack) -> Vec<u64> {
        stack.view()["cards"]
            .as_array()
            .unwrap()
            .iter()
            .map(|card| card["id"].as_u64().unwrap())
            .collect()
    }

    #[test]
    fn a_test_run_hides_macos_uses_the_banner_and_windows_asks_the_os() {
        let unasked = || -> Result<(), String> { panic!("the gate decides nothing here") };
        assert_eq!(route(Host::Test, unasked).0, Route::Hidden);
        assert_eq!(route(Host::MacOs, unasked).0, Route::Banner);
        assert_eq!(route(Host::Windows, || Ok(())).0, Route::Popup);
        assert_eq!(
            route(Host::Windows, || Err("Do Not Disturb is on".into())),
            (Route::Banner, "Do Not Disturb is on".to_string())
        );
    }

    #[test]
    fn three_cards_show_and_the_rest_wait_in_order_behind_more() {
        let mut stack = Stack::default();
        for id in 1..=5 {
            stack.push(card(id));
        }
        assert_eq!(ids(&stack), [1, 2, 3]);
        assert_eq!(stack.view()["more"], 2);
        assert_eq!(stack.size(), (WIDTH, 3.0 * CARD_HEIGHT + MORE_HEIGHT));
        assert!(stack.remove(2));
        assert_eq!(ids(&stack), [1, 3, 4]);
        assert_eq!(stack.view()["more"], 1);
        // A waiting card closed from Node (its tab was seen) leaves without ever showing.
        assert!(stack.remove(5));
        assert_eq!(stack.view()["more"], 0);
        assert_eq!(stack.size(), (WIDTH, 3.0 * CARD_HEIGHT));
        assert!(!stack.remove(5));
    }

    #[test]
    fn cards_count_down_only_on_screen_and_not_while_hovered_or_idle() {
        let mut stack = Stack::default();
        for id in 1..=4 {
            stack.push(card(id));
        }
        assert!(stack.tick(SHOWN_MS, true, 0).is_empty());
        assert!(stack.tick(SHOWN_MS, false, AWAY_IDLE_SECONDS).is_empty());
        assert!(stack.tick(SHOWN_MS - 1, false, 0).is_empty());
        assert_eq!(stack.tick(1, false, AWAY_IDLE_SECONDS - 1), [1, 2, 3]);
        // The waiting card got its slot with a full countdown of its own.
        assert_eq!(ids(&stack), [4]);
        assert!(stack.tick(SHOWN_MS - 1, false, 0).is_empty());
        assert_eq!(stack.tick(1, false, 0), [4]);
        assert!(stack.is_empty());
        assert_eq!(stack.size(), (WIDTH, 0.0));
    }

    const LEFT: Screen = Screen {
        bounds: Rect {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        },
        // Taskbar at the bottom.
        work_area: Rect {
            x: 0,
            y: 0,
            width: 1920,
            height: 1032,
        },
        scale: 1.0,
    };
    const RIGHT: Screen = Screen {
        bounds: Rect {
            x: 1920,
            y: -200,
            width: 2880,
            height: 1800,
        },
        // Taskbar on the left, 96 physical pixels at 150 %.
        work_area: Rect {
            x: 2016,
            y: -200,
            width: 2784,
            height: 1800,
        },
        scale: 1.5,
    };

    #[test]
    fn the_stack_sits_in_the_work_area_corner_of_the_pointer_s_monitor() {
        let size = (WIDTH, 2.0 * CARD_HEIGHT);
        assert_eq!(
            place(&[LEFT, RIGHT], Some(0), Some((2500.0, 300.0)), size),
            Some(Rect {
                x: 2016 + 2784 - 540 - 18,
                y: -200 + 1800 - 192 - 18,
                width: 540,
                height: 192,
            })
        );
        // No pointer, or one between monitors: the primary monitor, above its taskbar.
        let on_primary = Some(Rect {
            x: 1920 - 360 - 12,
            y: 1032 - 128 - 12,
            width: 360,
            height: 128,
        });
        assert_eq!(place(&[LEFT, RIGHT], Some(0), None, size), on_primary);
        assert_eq!(
            place(&[LEFT, RIGHT], Some(0), Some((-5.0, 10.0)), size),
            on_primary
        );
        assert_eq!(place(&[], None, None, size), None);
    }

    #[test]
    fn the_page_may_only_click_or_close_a_card() {
        let parse = |text: &str| action(&url::Url::parse(text).unwrap());
        assert_eq!(parse("ompdesk-popup:click?id=7"), Some(Action::Click(7)));
        assert_eq!(parse("ompdesk-popup:close?id=7"), Some(Action::Close(7)));
        assert_eq!(parse("ompdesk-popup:open?id=7"), None);
        assert_eq!(parse("ompdesk-popup:click?id=x"), None);
        assert_eq!(parse("ompdesk-popup:click"), None);
        assert_eq!(parse("https://example.com/click?id=7"), None);
    }
}
