//! What each live connection of a paired web page last reported about unsaved edits in its Files editor (main's
//! `FileEditReports` until C2). A report belongs to the connection that sent it, never to the device: a device may
//! hold up to four connections (browser tabs, a reload overlapping its predecessor) sharing one window, each with its
//! own Files state, so one page's fresh "nothing dirty" never erases another's unsaved edit. A connection's report
//! stands until that connection ends; an offline page may edit a file the computer never hears about, so its old
//! word stops counting. The page reports on every change and on every (re)connect (`FileEditReporter.tsx`).
//!
//! The router keeps this inside its `State`: `receive` records a report under the lock that also ends connections,
//! so no report lands after its connection's `finish`. `edits` is what an agent's close reads (`tab_close_step`) and
//! what the pool's release checks in the step that removes the tab (`pool/windows.rs` `release_entry`).

use std::collections::HashMap;

use serde_json::Value;
use serde_json::value::RawValue;

/// What a device's live reports say about one of its tabs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileEdits {
    /// Some live connection reported, and none names the tab.
    Clean,
    /// A live connection names the tab.
    Dirty,
    /// No live connection has reported: never assumed clean.
    Unreported,
}

impl FileEdits {
    pub fn as_str(self) -> &'static str {
        match self {
            FileEdits::Clean => "clean",
            FileEdits::Dirty => "dirty",
            FileEdits::Unreported => "unreported",
        }
    }
}

struct Report {
    device: String,
    /// The tab whose Files editor holds unsaved edits, `None` for none (a page has at most one).
    dirty: Option<String>,
}

#[derive(Default)]
pub struct FileEditReports {
    /// Connection id -> its latest report; absent = that connection has not reported, or ended.
    by_conn: HashMap<String, Report>,
}

impl FileEditReports {
    /// The page behind `conn_id`, a connection of `device`, reports the tab holding its unsaved edits, or none.
    pub fn report(&mut self, device: &str, conn_id: &str, dirty: Option<String>) {
        let device = device.to_owned();
        self.by_conn
            .insert(conn_id.to_owned(), Report { device, dirty });
    }

    /// The connection ended: its report no longer counts (other connections' reports stand).
    pub fn forget(&mut self, conn_id: &str) {
        self.by_conn.remove(conn_id);
    }

    pub fn edits(&self, device: &str, tab: &str) -> FileEdits {
        let mut reported = false;
        for report in self.by_conn.values().filter(|r| r.device == device) {
            if report.dirty.as_deref() == Some(tab) {
                return FileEdits::Dirty;
            }
            reported = true;
        }
        if reported {
            FileEdits::Clean
        } else {
            FileEdits::Unreported
        }
    }
}

/// A `FILE_EDIT_REPORT` call's arguments exactly as the page sends them (one `{dirtyTabId}`, a string or null), or
/// `None` for anything else, which is dropped as main's handler dropped it.
pub fn parse_report(args: &RawValue) -> Option<Option<String>> {
    let args: Vec<Value> = serde_json::from_str(args.get()).ok()?;
    let [Value::Object(payload)] = args.as_slice() else {
        return None;
    };
    if payload.len() != 1 {
        return None;
    }
    match payload.get("dirtyTabId")? {
        Value::Null => Some(None),
        Value::String(tab) => Some(Some(tab.clone())),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(args: Value) -> Option<Option<String>> {
        parse_report(&RawValue::from_string(args.to_string()).unwrap())
    }

    #[test]
    fn accepts_exactly_one_dirty_tab_id_holding_a_tab_id_or_null() {
        assert_eq!(
            parse(json!([{"dirtyTabId": "t1"}])),
            Some(Some("t1".into()))
        );
        assert_eq!(parse(json!([{"dirtyTabId": null}])), Some(None));
    }

    #[test]
    fn refuses_any_other_shape() {
        let picture =
            json!({"type": "image", "mimeType": "image/png", "upload": "/up/dev1/a/image.png"});
        for args in [
            json!([{"dirtyTabId": "t1", "x": 1}]),
            json!([{"dirtyTabId": "t1", "extra": picture}]),
            json!([{"dirtyTabId": "t1"}, picture]),
            json!([{"dirtyTabId": 7}]),
            json!([{}]),
            json!([["t1"]]),
            json!([null]),
            json!([]),
            json!({"dirtyTabId": "t1"}),
        ] {
            assert_eq!(parse(args.clone()), None, "{args}");
        }
    }

    #[test]
    fn knows_nothing_until_a_report_and_never_reads_that_as_clean() {
        assert_eq!(
            FileEditReports::default().edits("d1", "t1"),
            FileEdits::Unreported
        );
    }

    #[test]
    fn dirty_for_the_reported_tab_clean_for_others_unreported_for_another_device() {
        let mut reports = FileEditReports::default();
        reports.report("d1", "a", Some("t1".into()));
        assert_eq!(reports.edits("d1", "t1"), FileEdits::Dirty);
        assert_eq!(reports.edits("d1", "t2"), FileEdits::Clean);
        assert_eq!(reports.edits("d2", "t1"), FileEdits::Unreported);
        reports.report("d1", "a", None);
        assert_eq!(reports.edits("d1", "t1"), FileEdits::Clean);
    }

    #[test]
    fn one_report_per_connection_and_the_remaining_one_decides_after_a_drop() {
        let mut reports = FileEditReports::default();
        reports.report("d1", "a", Some("t1".into()));
        reports.report("d1", "b", None);
        assert_eq!(reports.edits("d1", "t1"), FileEdits::Dirty);
        reports.forget("a");
        assert_eq!(reports.edits("d1", "t1"), FileEdits::Clean);
        reports.forget("b");
        assert_eq!(reports.edits("d1", "t1"), FileEdits::Unreported);
        reports.report("d1", "c", Some("t1".into()));
        assert_eq!(reports.edits("d1", "t1"), FileEdits::Dirty);
    }

    /// Every order of up to 5 events over connections `a`, `b` (device d1) and `c` (d2): a report of t1, t2 or none,
    /// or a drop, after which that connection says nothing more (the router refuses an ended connection's frames).
    #[test]
    fn every_order_of_report_and_drop_reads_as_the_live_connections_latest_word() {
        const CONNS: [(&str, &str); 3] = [("a", "d1"), ("b", "d1"), ("c", "d2")];
        #[derive(Clone, Copy)]
        enum Event {
            Report(usize, Option<&'static str>),
            Drop(usize),
        }
        let mut alphabet = Vec::new();
        for conn in 0..CONNS.len() {
            for dirty in [Some("t1"), Some("t2"), None] {
                alphabet.push(Event::Report(conn, dirty));
            }
            alphabet.push(Event::Drop(conn));
        }
        let conn_of = |event: &Event| match *event {
            Event::Report(conn, _) | Event::Drop(conn) => conn,
        };
        fn expected(
            history: &[Event],
            conns: &[(&str, &str)],
            device: &str,
            tab: &str,
        ) -> FileEdits {
            let mut latest = Vec::new();
            for (index, (_, of)) in conns.iter().enumerate() {
                if *of != device
                    || history
                        .iter()
                        .any(|e| matches!(e, Event::Drop(c) if *c == index))
                {
                    continue;
                }
                let last = history.iter().rev().find_map(|e| match e {
                    Event::Report(c, dirty) if *c == index => Some(*dirty),
                    _ => None,
                });
                if let Some(dirty) = last {
                    latest.push(dirty);
                }
            }
            if latest.is_empty() {
                FileEdits::Unreported
            } else if latest.contains(&Some(tab)) {
                FileEdits::Dirty
            } else {
                FileEdits::Clean
            }
        }
        let mut stack: Vec<Vec<Event>> = vec![Vec::new()];
        let mut checked = 0;
        while let Some(history) = stack.pop() {
            let mut reports = FileEditReports::default();
            for event in &history {
                match *event {
                    Event::Report(conn, dirty) => {
                        let (id, device) = CONNS[conn];
                        reports.report(device, id, dirty.map(str::to_owned));
                    }
                    Event::Drop(conn) => reports.forget(CONNS[conn].0),
                }
            }
            for device in ["d1", "d2", "d3"] {
                for tab in ["t1", "t2", "t3"] {
                    assert_eq!(
                        reports.edits(device, tab),
                        expected(&history, &CONNS, device, tab),
                        "{device}/{tab} after {} events",
                        history.len()
                    );
                }
            }
            checked += 1;
            if history.len() < 5 {
                for event in &alphabet {
                    let conn = conn_of(event);
                    if history
                        .iter()
                        .any(|e| matches!(e, Event::Drop(c) if *c == conn))
                    {
                        continue;
                    }
                    let mut next = history.clone();
                    next.push(*event);
                    stack.push(next);
                }
            }
        }
        assert!(checked > 100_000, "{checked}");
    }
}
