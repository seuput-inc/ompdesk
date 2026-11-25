//! The calendar trigger of a routine (`{source: "calendar", url, leadMinutes}`): an ICS feed (Google, iCloud and
//! Outlook all publish one at a secret `https` address) read every `CALENDAR_POLL_MS`, and each event occurrence
//! fired once, `leadMinutes` before it starts (after Orca's Calendar `starting_soon` trigger, re-implemented on a feed
//! this computer reads itself: no Google sign-in, nothing through Orca Cloud).
//!
//! What it reads of the feed, and what it leaves: `VEVENT`s with `UID`, `SUMMARY`, `LOCATION`, `DTSTART` in UTC, in a
//! `TZID` the feed's own `VTIMEZONE` defines (its `STANDARD` and `DAYLIGHT` parts with a yearly `BYMONTH`/`BYDAY`
//! rule), as floating local time or as a whole day (this computer's zone), `EXDATE`, a cancelled `STATUS`, and an
//! `RRULE` of `FREQ=DAILY` or `WEEKLY` with `INTERVAL`, `COUNT`, `UNTIL` and (weekly) `BYDAY`. An event it cannot read,
//! a moved occurrence (`RECURRENCE-ID`) and any other recurrence are passed over: a known limit, not a failure.
//!
//! Nothing fires twice: the occurrences fired (`uid|start`) are the source's mark, kept across a relaunch and saved
//! before it fires; one that started already when the source looks is never fired late. A feed that cannot be read
//! is told once per distinct message, and read less often while it keeps failing (doubling to 30 minutes).

use std::collections::{BTreeSet, HashMap};

use serde_json::{Value, json};

use super::{Timing, wait};
use crate::schedules::rules::{Day, Local, Zone};
use crate::schedules::triggers::Context;
use crate::server::Scope;

/// How often the feed is read.
const CALENDAR_POLL_MS: u64 = 5 * 60_000;
/// How often what was read is looked at for an occurrence coming due (a lead shorter than the poll still fires).
const LOOK_MS: u64 = 30_000;
/// Longest wait between reads while the feed keeps failing.
const FAILING_POLL_MAX_MS: u64 = 30 * 60_000;
/// A feed larger than this is refused.
const FEED_MAX_BYTES: usize = 8 * 1024 * 1024;
/// Occurrences one recurrence is followed through before it is left (a runaway rule).
const OCCURRENCES_MAX: usize = 5_000;
const MINUTE_MS: i64 = 60_000;
const DAY_MS: i64 = 24 * 60 * MINUTE_MS;

/// One occurrence of an event: when it starts and what it is.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Occurrence {
    pub key: String,
    pub start: i64,
    pub summary: String,
    pub location: String,
}

pub(super) async fn run(
    event: &Value,
    mark: Option<Value>,
    context: &Context,
    scope: &Scope,
    _timing: Timing,
) {
    let url = event["url"].as_str().unwrap_or_default().to_owned();
    let lead = event["leadMinutes"].as_i64().unwrap_or(10).clamp(1, 1440) * MINUTE_MS;
    let mut fired: BTreeSet<String> = mark
        .as_ref()
        .and_then(|mark| mark["fired"].as_array())
        .map(|keys| {
            keys.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let key = "calendar".to_owned();
    let mut failures = 0u32;
    let mut events: Vec<Event> = Vec::new();
    let mut next_read = 0i64;
    loop {
        if scope.cancelled() || !context.current() {
            return;
        }
        let now = crate::schedules::system_now();
        if now >= next_read {
            match read_feed(&url).await {
                Ok(feed) => {
                    context.failure(&key, None);
                    failures = 0;
                    events = parse(&feed);
                }
                Err(error) => {
                    context.failure(&key, Some(&error));
                    failures = failures.saturating_add(1);
                }
            }
            let wait_ms = CALENDAR_POLL_MS
                .saturating_mul(1u64.checked_shl(failures).unwrap_or(u64::MAX))
                .min(FAILING_POLL_MAX_MS);
            next_read = now + wait_ms as i64;
            if scope.cancelled() || !context.current() {
                return;
            }
        }
        let due = due(&events, now, lead, &Local, &fired);
        if !due.is_empty() {
            for occurrence in &due {
                fired.insert(occurrence.key.clone());
            }
            // The mark keeps what fired within the last day, so it does not grow with the calendar.
            fired.retain(|key| key_start(key).is_none_or(|start| start > now - DAY_MS));
            let lines: Vec<String> = due
                .iter()
                .map(|occurrence| describe(occurrence, now))
                .collect();
            let mark = json!({ "fired": fired.iter().collect::<Vec<_>>() });
            if !context.publish(mark, &lines) {
                return;
            }
        }
        if !wait(scope, LOOK_MS).await {
            return;
        }
    }
}

async fn read_feed(url: &str) -> Result<String, String> {
    if !url.starts_with("https://") {
        return Err("the calendar address is not an https:// address".into());
    }
    let request = crate::http::Request {
        url,
        headers: &[("accept", "text/calendar")],
        body: None,
        proxy: None,
    };
    let answer = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        crate::http::send(request),
    )
    .await
    .map_err(|_| "the calendar did not answer within 30 s".to_owned())?
    .map_err(|failure| format!("could not read the calendar ({failure:?})"))?;
    if !(200..300).contains(&answer.status) {
        return Err(format!("the calendar answered {}", answer.status));
    }
    if answer.body.len() > FEED_MAX_BYTES {
        return Err("the calendar is larger than 8 MB".into());
    }
    Ok(String::from_utf8_lossy(&answer.body).into_owned())
}

fn key_start(key: &str) -> Option<i64> {
    key.rsplit_once('|')?.1.parse().ok()
}

/// "Starting at …: summary (location), in N min".
fn describe(occurrence: &Occurrence, now: i64) -> String {
    let minutes = (occurrence.start - now + MINUTE_MS - 1) / MINUTE_MS;
    let summary = if occurrence.summary.is_empty() {
        "(no title)"
    } else {
        &occurrence.summary
    };
    let place = if occurrence.location.is_empty() {
        String::new()
    } else {
        format!(" ({})", occurrence.location)
    };
    format!(
        "A calendar event starts in {minutes} min, at {}: {summary}{place}",
        crate::schedules::rules::iso(occurrence.start)
    )
}

/// The occurrences that come due now: those starting within `lead` from now, not started yet, not fired before.
pub(super) fn due(
    events: &[Event],
    now: i64,
    lead: i64,
    zone: &dyn Zone,
    fired: &BTreeSet<String>,
) -> Vec<Occurrence> {
    let mut due: Vec<Occurrence> = events
        .iter()
        .flat_map(|event| event.occurrences(now, now + lead, zone))
        .filter(|occurrence| occurrence.start > now && occurrence.start - lead <= now)
        .filter(|occurrence| !fired.contains(&occurrence.key))
        .collect();
    due.sort_by_key(|occurrence| occurrence.start);
    due
}

/// A time as the feed gave it.
#[derive(Clone, Debug, PartialEq)]
enum Stamp {
    /// An instant (`…Z`).
    Utc(i64),
    /// A wall-clock time in a zone the feed names (`TZID`), or none (floating: this computer's).
    Local {
        day: Day,
        minutes: u32,
        tzid: Option<String>,
    },
    /// A whole day (`VALUE=DATE`): from its midnight here.
    Date(Day),
}

/// A zone part of a `VTIMEZONE`: from when (each year, by its rule) its offset applies.
#[derive(Clone, Debug)]
struct ZonePart {
    offset_minutes: i64,
    month: u32,
    /// The nth weekday of the month (`-1` the last); none: the day of its `DTSTART`.
    nth: Option<(i64, u32)>,
    day: u32,
    minutes: u32,
}

#[derive(Clone, Debug)]
pub(super) struct Event {
    uid: String,
    summary: String,
    location: String,
    start: Stamp,
    rule: Option<Rule>,
    except: Vec<Stamp>,
    zones: std::sync::Arc<HashMap<String, Vec<ZonePart>>>,
}

#[derive(Clone, Debug, PartialEq)]
struct Rule {
    weekly: bool,
    interval: i64,
    count: Option<usize>,
    until: Option<Stamp>,
    /// Weekly: the weekdays (0 = Sunday); empty = the start's weekday.
    days: Vec<u32>,
}

impl Event {
    fn instant(&self, stamp: &Stamp, zone: &dyn Zone) -> i64 {
        match stamp {
            Stamp::Utc(at) => *at,
            Stamp::Date(day) => zone.instant(*day, 0, 0),
            Stamp::Local { day, minutes, tzid } => {
                let parts = tzid.as_ref().and_then(|tzid| self.zones.get(tzid));
                match parts {
                    Some(parts) => {
                        let wall = from_civil(*day) * DAY_MS + i64::from(*minutes) * MINUTE_MS;
                        wall - offset_at(parts, *day, *minutes) * MINUTE_MS
                    }
                    None => zone.instant(*day, minutes / 60, minutes % 60),
                }
            }
        }
    }

    /// Its occurrences that start in `(from, to]`, in order.
    fn occurrences(&self, from: i64, to: i64, zone: &dyn Zone) -> Vec<Occurrence> {
        let starts: Vec<i64> = match &self.rule {
            None => vec![self.instant(&self.start, zone)],
            Some(rule) => self.expand(rule, to, zone),
        };
        let except: Vec<i64> = self
            .except
            .iter()
            .map(|stamp| self.instant(stamp, zone))
            .collect();
        starts
            .into_iter()
            .filter(|start| *start > from && *start <= to && !except.contains(start))
            .map(|start| Occurrence {
                key: format!("{}|{start}", self.uid),
                start,
                summary: self.summary.clone(),
                location: self.location.clone(),
            })
            .collect()
    }

    /// The starts of a daily or weekly rule up to `to` (or its end), walked in the start's own wall-clock.
    fn expand(&self, rule: &Rule, to: i64, zone: &dyn Zone) -> Vec<i64> {
        let (first, make): (Day, Box<dyn Fn(Day) -> Stamp>) = match &self.start {
            Stamp::Date(day) => (*day, Box::new(Stamp::Date)),
            Stamp::Local { day, minutes, tzid } => {
                let (minutes, tzid) = (*minutes, tzid.clone());
                (
                    *day,
                    Box::new(move |day| Stamp::Local {
                        day,
                        minutes,
                        tzid: tzid.clone(),
                    }),
                )
            }
            Stamp::Utc(at_ms) => {
                let minutes = (at_ms.rem_euclid(DAY_MS) / MINUTE_MS) as u32;
                (
                    civil(at_ms.div_euclid(DAY_MS)),
                    Box::new(move |day| {
                        Stamp::Utc(from_civil(day) * DAY_MS + i64::from(minutes) * MINUTE_MS)
                    }),
                )
            }
        };
        let until = rule.until.as_ref().map(|until| self.instant(until, zone));
        let start_day = from_civil(first);
        let interval = rule.interval.max(1);
        let mut starts = Vec::new();
        let mut count = 0usize;
        let mut step = 0i64;
        while starts.len() < OCCURRENCES_MAX {
            // One period: a day, or the week (Sunday first) the start's week is `step * interval` weeks from.
            let days: Vec<i64> = if rule.weekly {
                let week = start_day - weekday(first) as i64 + step * interval * 7;
                let mut wanted = rule.days.clone();
                if wanted.is_empty() {
                    wanted.push(weekday(first));
                }
                wanted.sort_unstable();
                wanted
                    .into_iter()
                    .map(|day| week + i64::from(day))
                    .filter(|day| *day >= start_day)
                    .collect()
            } else {
                vec![start_day + step * interval]
            };
            step += 1;
            for day in days {
                let start = self.instant(&make(civil(day)), zone);
                if until.is_some_and(|until| start > until) || start > to {
                    return starts;
                }
                count += 1;
                starts.push(start);
                if rule.count.is_some_and(|max| count >= max) {
                    return starts;
                }
            }
        }
        starts
    }
}

/// The offset (minutes east of UTC) a `VTIMEZONE`'s parts give a wall-clock time: the part whose change came last
/// before it, this year or the year before.
fn offset_at(parts: &[ZonePart], day: Day, minutes: u32) -> i64 {
    let wall = (day.year, day.month, day.day, minutes);
    let mut best: Option<((i64, u32, u32, u32), i64)> = None;
    for year in [day.year - 1, day.year] {
        for part in parts {
            let change_day = match part.nth {
                Some((nth, weekday)) => nth_weekday(year, part.month, nth, weekday),
                None => part.day,
            };
            let change = (year, part.month, change_day, part.minutes);
            if change <= wall && best.is_none_or(|(at, _)| change > at) {
                best = Some((change, part.offset_minutes));
            }
        }
    }
    best.map_or_else(
        || parts.first().map_or(0, |part| part.offset_minutes),
        |(_, offset)| offset,
    )
}

/// The day of the month of the `nth` `weekday` (0 = Sunday) of `month` (`-1`: the last).
fn nth_weekday(year: i64, month: u32, nth: i64, weekday_wanted: u32) -> u32 {
    let first = Day {
        year,
        month,
        day: 1,
    };
    let first_weekday = weekday(first);
    let first_match = 1 + (7 + weekday_wanted - first_weekday) % 7;
    let length = month_length(year, month);
    if nth > 0 {
        let day = first_match + 7 * (nth as u32 - 1);
        day.min(length)
    } else {
        let mut day = first_match;
        while day + 7 <= length {
            day += 7;
        }
        day
    }
}

fn month_length(year: i64, month: u32) -> u32 {
    let next = if month == 12 {
        Day {
            year: year + 1,
            month: 1,
            day: 1,
        }
    } else {
        Day {
            year,
            month: month + 1,
            day: 1,
        }
    };
    (from_civil(next)
        - from_civil(Day {
            year,
            month,
            day: 1,
        })) as u32
}

/// Days since 1970-01-01 of a civil date (Howard Hinnant's algorithm).
fn from_civil(day: Day) -> i64 {
    let year = if day.month <= 2 {
        day.year - 1
    } else {
        day.year
    };
    let era = year.div_euclid(400);
    let yoe = year - era * 400;
    let month = i64::from(day.month);
    let doy =
        (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + i64::from(day.day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil(days: i64) -> Day {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    Day { year, month, day }
}

/// 0 = Sunday.
fn weekday(day: Day) -> u32 {
    (from_civil(day) + 4).rem_euclid(7) as u32
}

const WEEKDAYS: [&str; 7] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/// One content line: its name (upper case), its parameters, its value.
struct Line<'a> {
    name: String,
    params: Vec<(String, String)>,
    value: &'a str,
}

impl Line<'_> {
    fn param(&self, name: &str) -> Option<&str> {
        self.params
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
}

fn content_line(line: &str) -> Option<Line<'_>> {
    let mut quoted = false;
    let colon = line.char_indices().find_map(|(at, c)| {
        if c == '"' {
            quoted = !quoted;
        }
        (c == ':' && !quoted).then_some(at)
    })?;
    let (head, value) = (&line[..colon], &line[colon + 1..]);
    let mut parts = head.split(';');
    let name = parts.next()?.trim().to_ascii_uppercase();
    let params = parts
        .filter_map(|part| part.split_once('='))
        .map(|(key, value)| {
            (
                key.trim().to_ascii_uppercase(),
                value.trim_matches('"').to_owned(),
            )
        })
        .collect();
    Some(Line {
        name,
        params,
        value,
    })
}

/// A `TEXT` value without its escapes, on one line.
fn text(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n' | 'N') => out.push(' '),
            Some(other) => out.push(other),
            None => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn number(text: &str) -> Option<i64> {
    text.trim().parse().ok()
}

/// `YYYYMMDD` or `YYYYMMDDTHHMMSS[Z]`, in `tzid` when it names one.
fn stamp(value: &str, date_only: bool, tzid: Option<&str>) -> Option<Stamp> {
    let value = value.trim();
    let digits = |range: std::ops::Range<usize>| value.get(range).and_then(number);
    let day = Day {
        year: digits(0..4)?,
        month: u32::try_from(digits(4..6)?).ok()?,
        day: u32::try_from(digits(6..8)?).ok()?,
    };
    if !(1..=12).contains(&day.month) || !(1..=31).contains(&day.day) {
        return None;
    }
    if date_only || value.len() == 8 {
        return Some(Stamp::Date(day));
    }
    if value.as_bytes().get(8) != Some(&b'T') {
        return None;
    }
    let minutes = u32::try_from(digits(9..11)? * 60 + digits(11..13)?).ok()?;
    if value.ends_with('Z') {
        return Some(Stamp::Utc(
            from_civil(day) * DAY_MS + i64::from(minutes) * MINUTE_MS,
        ));
    }
    Some(Stamp::Local {
        day,
        minutes,
        tzid: tzid.map(str::to_owned),
    })
}

fn rule(value: &str, tzid: Option<&str>) -> Option<Rule> {
    let mut rule = Rule {
        weekly: false,
        interval: 1,
        count: None,
        until: None,
        days: Vec::new(),
    };
    let mut freq = None;
    for part in value.split(';') {
        let (key, value) = part.split_once('=')?;
        match key.to_ascii_uppercase().as_str() {
            "FREQ" => freq = Some(value.to_ascii_uppercase()),
            "INTERVAL" => rule.interval = number(value)?,
            "COUNT" => rule.count = Some(usize::try_from(number(value)?).ok()?),
            "UNTIL" => rule.until = Some(stamp(value, false, tzid)?),
            "BYDAY" => {
                for day in value.split(',') {
                    let day = day.trim().to_ascii_uppercase();
                    // A weekly rule names plain days; a numbered one (`2MO`) belongs to rules this reader leaves.
                    let at = WEEKDAYS.iter().position(|name| *name == day)?;
                    rule.days.push(at as u32);
                }
            }
            "WKST" => {}
            _ => return None,
        }
    }
    match freq.as_deref() {
        Some("DAILY") if rule.days.is_empty() => Some(rule),
        Some("WEEKLY") => {
            rule.weekly = true;
            Some(rule)
        }
        _ => None,
    }
}

/// A `VTIMEZONE` part's yearly rule: `FREQ=YEARLY;BYMONTH=m;BYDAY=nDD`.
fn zone_rule(value: &str) -> Option<(u32, (i64, u32))> {
    let mut month = None;
    let mut nth = None;
    for part in value.split(';') {
        let (key, value) = part.split_once('=')?;
        match key.to_ascii_uppercase().as_str() {
            "BYMONTH" => month = u32::try_from(number(value)?).ok(),
            "BYDAY" => {
                let value = value.trim().to_ascii_uppercase();
                let (count, day) = value.split_at(value.len().checked_sub(2)?);
                let day = WEEKDAYS.iter().position(|name| *name == day)? as u32;
                let count = if count.is_empty() { 1 } else { number(count)? };
                nth = Some((count, day));
            }
            _ => {}
        }
    }
    Some((month?, nth?))
}

/// `+0900`, `-0430`: minutes east of UTC.
fn offset(value: &str) -> Option<i64> {
    let value = value.trim();
    let sign = match value.as_bytes().first()? {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let hours = number(value.get(1..3)?)?;
    let minutes = number(value.get(3..5)?)?;
    Some(sign * (hours * 60 + minutes))
}

/// A `STANDARD` or `DAYLIGHT` part of a `VTIMEZONE` while it is read.
#[derive(Default)]
struct PartRead {
    offset: Option<i64>,
    start: Option<Stamp>,
    yearly: Option<(u32, (i64, u32))>,
}

/// The events of an ICS feed this reader can follow.
pub(super) fn parse(feed: &str) -> Vec<Event> {
    // Unfold: a line that starts with a space or a tab goes on the line before it.
    let mut lines: Vec<String> = Vec::new();
    for raw in feed.split('\n') {
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        match (
            raw.strip_prefix(' ').or_else(|| raw.strip_prefix('\t')),
            lines.last_mut(),
        ) {
            (Some(rest), Some(last)) => last.push_str(rest),
            _ => lines.push(raw.to_owned()),
        }
    }
    let mut zones: HashMap<String, Vec<ZonePart>> = HashMap::new();
    let mut raw_events: Vec<Vec<usize>> = Vec::new();
    let mut stack: Vec<String> = Vec::new();
    let mut zone_id = String::new();
    let mut part: Option<PartRead> = None;
    for (at, line) in lines.iter().enumerate() {
        let Some(line) = content_line(line) else {
            continue;
        };
        match line.name.as_str() {
            "BEGIN" => {
                let what = line.value.trim().to_ascii_uppercase();
                if what == "VEVENT" {
                    raw_events.push(Vec::new());
                }
                if what == "STANDARD" || what == "DAYLIGHT" {
                    part = Some(PartRead::default());
                }
                stack.push(what);
            }
            "END" => {
                let what = stack.pop().unwrap_or_default();
                if (what == "STANDARD" || what == "DAYLIGHT")
                    && let Some(PartRead {
                        offset: Some(offset_minutes),
                        start: Some(Stamp::Local { day, minutes, .. }),
                        yearly,
                    }) = part.take()
                {
                    zones.entry(zone_id.clone()).or_default().push(ZonePart {
                        offset_minutes,
                        month: yearly.map_or(day.month, |(month, _)| month),
                        nth: yearly.map(|(_, nth)| nth),
                        day: day.day,
                        minutes,
                    });
                }
            }
            "TZID" if stack.last().is_some_and(|top| top == "VTIMEZONE") => {
                zone_id = line.value.trim().to_owned();
            }
            "TZOFFSETTO" if part.is_some() => {
                if let Some(part) = part.as_mut() {
                    part.offset = offset(line.value);
                }
            }
            "DTSTART" if part.is_some() => {
                if let Some(part) = part.as_mut() {
                    part.start = stamp(line.value, false, None);
                }
            }
            "RRULE" if part.is_some() => {
                if let Some(part) = part.as_mut() {
                    part.yearly = zone_rule(line.value);
                }
            }
            _ if stack.last().is_some_and(|top| top == "VEVENT") => {
                if let Some(event) = raw_events.last_mut() {
                    event.push(at);
                }
            }
            _ => {}
        }
    }
    let zones = std::sync::Arc::new(zones);
    raw_events
        .into_iter()
        .filter_map(|indices| {
            event(
                indices.iter().filter_map(|at| content_line(&lines[*at])),
                &zones,
            )
        })
        .collect()
}

fn event<'a>(
    lines: impl Iterator<Item = Line<'a>>,
    zones: &std::sync::Arc<HashMap<String, Vec<ZonePart>>>,
) -> Option<Event> {
    let (mut uid, mut summary, mut location) = (None, String::new(), String::new());
    let (mut start, mut rule_text, mut except) = (None, None, Vec::new());
    let mut tzid = None;
    for line in lines {
        match line.name.as_str() {
            "UID" => uid = Some(line.value.trim().to_owned()),
            "SUMMARY" => summary = text(line.value),
            "LOCATION" => location = text(line.value),
            "STATUS" if line.value.trim().eq_ignore_ascii_case("CANCELLED") => return None,
            "RECURRENCE-ID" => return None,
            "DTSTART" => {
                tzid = line.param("TZID").map(str::to_owned);
                let date_only = line
                    .param("VALUE")
                    .is_some_and(|value| value.eq_ignore_ascii_case("DATE"));
                start = Some(stamp(line.value, date_only, tzid.as_deref())?);
            }
            "RRULE" => rule_text = Some(line.value.to_owned()),
            "EXDATE" => {
                let date_only = line
                    .param("VALUE")
                    .is_some_and(|value| value.eq_ignore_ascii_case("DATE"));
                let zone = line.param("TZID");
                except.extend(
                    line.value
                        .split(',')
                        .filter_map(|value| stamp(value, date_only, zone)),
                );
            }
            _ => {}
        }
    }
    let rule = match rule_text {
        Some(text) => Some(rule(&text, tzid.as_deref())?),
        None => None,
    };
    Some(Event {
        uid: uid?,
        summary,
        location,
        start: start?,
        rule,
        except,
        zones: std::sync::Arc::clone(zones),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schedules::rules::Fixed;

    const SEOUL: &str = "BEGIN:VTIMEZONE\r\nTZID:Asia/Seoul\r\nBEGIN:STANDARD\r\nTZOFFSETFROM:+0900\r\nTZOFFSETTO:+0900\r\nDTSTART:19700101T000000\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n";
    const NEW_YORK: &str = "BEGIN:VTIMEZONE\r\nTZID:America/New_York\r\nBEGIN:DAYLIGHT\r\nTZOFFSETFROM:-0500\r\nTZOFFSETTO:-0400\r\nDTSTART:19700308T020000\r\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU\r\nEND:DAYLIGHT\r\nBEGIN:STANDARD\r\nTZOFFSETFROM:-0400\r\nTZOFFSETTO:-0500\r\nDTSTART:19701101T020000\r\nRRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n";

    fn feed(zones: &str, events: &str) -> String {
        format!("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n{zones}{events}END:VCALENDAR\r\n")
    }

    fn at(text: &str) -> i64 {
        crate::schedules::rules::date_parse(text, &Fixed(0)).unwrap()
    }

    fn starts(feed: &str, from: &str, to: &str) -> Vec<(String, i64)> {
        let mut found: Vec<(String, i64)> = parse(feed)
            .iter()
            .flat_map(|event| event.occurrences(at(from), at(to), &Fixed(0)))
            .map(|occurrence| (occurrence.summary, occurrence.start))
            .collect();
        found.sort_by_key(|(_, start)| *start);
        found
    }

    #[test]
    fn reads_utc_zoned_floating_and_whole_day_starts() {
        let events = "BEGIN:VEVENT\r\nUID:a\r\nSUMMARY:Standup\\, daily\r\nDTSTART:20261201T010000Z\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:b\r\nSUMMARY:Lunch\r\nLOCATION:Cafe\r\nDTSTART;TZID=Asia/Seoul:20261201T120000\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:c\r\nSUMMARY:Review in\r\n  New York\r\nDTSTART;TZID=America/New_York:20260701T090000\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:d\r\nSUMMARY:Holiday\r\nDTSTART;VALUE=DATE:20261225\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:e\r\nSUMMARY:Called off\r\nSTATUS:CANCELLED\r\nDTSTART:20261201T020000Z\r\nEND:VEVENT\r\n";
        let all = feed(&format!("{SEOUL}{NEW_YORK}"), events);
        assert_eq!(
            starts(&all, "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z"),
            vec![
                ("Review in New York".to_owned(), at("2026-07-01T13:00:00Z")),
                ("Standup, daily".to_owned(), at("2026-12-01T01:00:00Z")),
                ("Lunch".to_owned(), at("2026-12-01T03:00:00Z")),
                ("Holiday".to_owned(), at("2026-12-25T00:00:00Z")),
            ]
        );
    }

    #[test]
    fn follows_daylight_saving_in_the_feeds_own_zone() {
        let winter = "BEGIN:VEVENT\r\nUID:w\r\nSUMMARY:Winter\r\nDTSTART;TZID=America/New_York:20261215T090000\r\nEND:VEVENT\r\n";
        assert_eq!(
            starts(
                &feed(NEW_YORK, winter),
                "2026-12-01T00:00:00Z",
                "2027-01-01T00:00:00Z"
            ),
            vec![("Winter".to_owned(), at("2026-12-15T14:00:00Z"))]
        );
    }

    #[test]
    fn expands_daily_and_weekly_rules_with_count_until_and_exceptions() {
        let events = "BEGIN:VEVENT\r\nUID:d\r\nSUMMARY:Daily\r\nDTSTART:20261130T090000Z\r\nRRULE:FREQ=DAILY;COUNT=3\r\nEXDATE:20261201T090000Z\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:w\r\nSUMMARY:Weekly\r\nDTSTART:20261130T100000Z\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261209T235959Z\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:m\r\nSUMMARY:Monthly\r\nDTSTART:20261130T110000Z\r\nRRULE:FREQ=MONTHLY;BYDAY=1MO\r\nEND:VEVENT\r\n";
        let found = starts(
            &feed("", events),
            "2026-11-29T00:00:00Z",
            "2026-12-31T00:00:00Z",
        );
        let names: Vec<(&str, i64)> = found
            .iter()
            .map(|(name, at)| (name.as_str(), *at))
            .collect();
        assert_eq!(
            names,
            vec![
                ("Daily", at("2026-11-30T09:00:00Z")),
                ("Weekly", at("2026-11-30T10:00:00Z")),
                ("Daily", at("2026-12-02T09:00:00Z")),
                ("Weekly", at("2026-12-02T10:00:00Z")),
                ("Weekly", at("2026-12-07T10:00:00Z")),
                ("Weekly", at("2026-12-09T10:00:00Z")),
            ]
        );
    }

    #[test]
    fn fires_an_occurrence_once_within_its_lead_and_never_late() {
        let events =
            "BEGIN:VEVENT\r\nUID:x\r\nSUMMARY:Demo\r\nDTSTART:20261201T100000Z\r\nEND:VEVENT\r\n";
        let parsed = parse(&feed("", events));
        let lead = 10 * MINUTE_MS;
        let mut fired = BTreeSet::new();
        assert!(due(&parsed, at("2026-12-01T09:49:00Z"), lead, &Fixed(0), &fired).is_empty());
        let now = at("2026-12-01T09:51:00Z");
        let found = due(&parsed, now, lead, &Fixed(0), &fired);
        assert_eq!(found.len(), 1);
        assert_eq!(
            describe(&found[0], now),
            "A calendar event starts in 9 min, at 2026-12-01T10:00:00.000Z: Demo"
        );
        fired.insert(found[0].key.clone());
        assert!(due(&parsed, at("2026-12-01T09:55:00Z"), lead, &Fixed(0), &fired).is_empty());
        // A source that looks only once the event started never fires it late.
        assert!(
            due(
                &parsed,
                at("2026-12-01T10:01:00Z"),
                lead,
                &Fixed(0),
                &BTreeSet::new()
            )
            .is_empty()
        );
    }
}
