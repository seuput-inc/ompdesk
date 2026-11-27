//! A tab's activity (`TabActivity` of the pool, as main sends it) and the sweep of the opened sessions it asks for.

use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;

use super::{Runtime, is_outside};
use crate::agentctl::service::types::ReleasedSession;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ActivityKind {
    Busy,
    Idle,
    Ask,
    AskClosed,
    Released,
    Step,
}

/// How a turn ended (`IpcTabRunOutcome`), as far as the runtime reads it.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Outcome {
    pub stop_reason: Option<String>,
    pub error_message: Option<String>,
}

/// How an `askClosed` was answered.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct Answered {
    pub title: String,
    pub choice: String,
}

/// One pool activity with what only main knows at that moment.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    #[serde(rename = "type")]
    pub kind: ActivityKind,
    pub tab_id: String,
    /// An `ask` or `askClosed`: the request's id.
    #[serde(default)]
    pub request_id: Option<String>,
    /// An `askClosed` a window, a page or an agent answered: the card's title and the choice in its words.
    #[serde(default)]
    pub answered: Option<Answered>,
    /// An `idle`: how the turn ended.
    #[serde(default)]
    pub outcome: Option<Outcome>,
    /// The tab that opened this one (`#openerOf`: the one this launch saw open it, else the pool's across a relaunch).
    #[serde(default)]
    pub parent: Option<String>,
    /// An `ask` or `askClosed` its opener is to hear of: not an Autopilot run's child (the run reads those itself).
    #[serde(default)]
    pub announce: bool,
    /// A `released`: the saved session the tab held, with the hidden mark and the opener's session file, when main
    /// does not hold the tab's session back (a quit releases tabs that come back at the next launch).
    #[serde(default)]
    pub session: Option<ReleasedSession>,
}

impl Runtime {
    /// One pool activity (`observeTabs` of the TypeScript host).
    pub fn activity(self: &Arc<Self>, activity: Activity) {
        let tab = activity.tab_id.as_str();
        let released = activity.kind == ActivityKind::Released;
        let parent = activity.parent.clone().or_else(|| {
            released
                .then(|| self.rt().listed_in.get(tab).cloned())
                .flatten()
        });
        self.wake_activity(&activity);
        // A running child moved on: the next live read takes its step and cost; nothing else changed.
        if activity.kind == ActivityKind::Step {
            if parent.is_some() {
                self.rt().moved.insert(tab.to_owned());
            }
            return;
        }
        // A bot chat's tab came or changed: it joins its bot, and bot chats hear what changed.
        {
            let control = self.control.clone();
            tokio::spawn(async move { control.bots_tick().await });
        }
        if let Some(parent) = &parent {
            self.push_review(parent);
        }
        // A child's question card tells its opener (local and paired-device children alike); an Autopilot run's
        // children are answered by its approver, and the run reads them itself.
        if activity.kind == ActivityKind::Ask
            && activity.announce
            && let (Some(parent), Some(request)) = (&parent, &activity.request_id)
        {
            let control = self.control.clone();
            let (parent, child, request) = (parent.clone(), tab.to_owned(), request.clone());
            tokio::spawn(async move {
                let _ = control.child_asked(&parent, &child, &request).await;
            });
        }
        // A card routed to a bot closed: the bot hears how, unless its own answer closed it (`service/route.rs`).
        if activity.kind == ActivityKind::AskClosed
            && let Some(request) = &activity.request_id
        {
            let control = self.control.clone();
            let (child, request) = (tab.to_owned(), request.clone());
            let choice = activity
                .answered
                .as_ref()
                .map(|answered| answered.choice.clone());
            tokio::spawn(async move {
                control
                    .routed_ask_closed(&child, &request, choice.as_deref())
                    .await;
            });
        }
        // The card its opener was told of closed without the opener's answer: the opener hears how, once.
        if activity.kind == ActivityKind::AskClosed
            && activity.announce
            && let (Some(parent), Some(request)) = (&parent, &activity.request_id)
        {
            let control = self.control.clone();
            let (parent, child, request) = (parent.clone(), tab.to_owned(), request.clone());
            let answered = activity.answered.clone();
            tokio::spawn(async move {
                let choice = answered.as_ref().map(|answered| answered.choice.as_str());
                control
                    .child_ask_closed(&parent, &child, &request, choice)
                    .await;
            });
        }
        // A turn that ended changed the session's own cost, the base of its family's (sidebar chip, Work tree).
        if activity.kind == ActivityKind::Idle {
            self.push_review(tab);
        }
        // A child finishing, or an opener going idle (it can no longer collect), may let a child close.
        self.sweep_soon(parent.as_deref().unwrap_or(tab));
        if released {
            {
                let mut rt = self.rt();
                rt.review_sent.remove(tab);
                rt.children_sent.remove(tab);
                rt.moved.remove(tab);
                rt.listed_in.remove(tab);
            }
            // Its resting children close with it; none while the app quits (the session is left out then, and
            // the next launch restores those tabs).
            let orphans = self.control.opened_of(tab);
            let _ = self.control.released(tab, activity.session.as_ref());
            if let Some(session) = &activity.session
                && !orphans.is_empty()
            {
                let (control, opener) = (self.control.clone(), session.path.clone());
                tokio::spawn(async move { control.close_orphans(orphans, Some(opener)).await });
            }
        }
    }

    /// Looks for sessions to close shortly: one pass absorbs a burst of activity (`#sweepSoon`).
    pub fn sweep_soon(self: &Arc<Self>, tab: &str) {
        let mut rt = self.rt();
        if rt.sweep_timers.contains_key(tab) {
            return;
        }
        let (me, id) = (self.clone(), tab.to_owned());
        let settle = Duration::from_millis(self.config.sweep_settle_ms);
        let timer = tokio::spawn(async move {
            tokio::time::sleep(settle).await;
            me.rt().sweep_timers.remove(&id);
            let _ = me.control.auto_close(&id).await;
        });
        rt.sweep_timers.insert(tab.to_owned(), timer);
    }

    /// Every opener with children, on the timer: a merge, push or commit outside the app is no tab activity, so
    /// neither the auto-close pass nor the work board's review list would otherwise notice that a child's work landed
    /// (it leaves the queue) or appeared (it joins).
    pub fn sweep_all(self: &Arc<Self>) {
        for opener in self.openers() {
            self.sweep_soon(&opener);
            if is_outside(&opener) || !self.rt().sweep_reviews.insert(opener.clone()) {
                continue;
            }
            let me = self.clone();
            tokio::spawn(async move {
                if let Ok(review) = me.control.review(&opener).await {
                    let last = me
                        .rt()
                        .review_sent
                        .get(&opener)
                        .cloned()
                        .unwrap_or_else(|| super::no_review().to_string());
                    let now = review.to_string();
                    if last != now {
                        me.send_review(&opener, review);
                    }
                }
                me.rt().sweep_reviews.remove(&opener);
            });
        }
    }
}
