//! A schedule's five-field cron (`ScheduleFrequency` `cron`, FK-A04, after Orca's custom cron panel
//! `automations/authoring/AutomationCustomCronPanel.tsx`): minute, hour, day of month, month, day of week (0 or 7 =
//! Sunday), each `*`, a number, a range `a-b`, a step `*/n`, `a/n` or `a-b/n`, or a comma list of them, in this
//! computer's local time. When both day fields are restricted a day matching either runs, as cron reads them.

use super::rules::{Zone, civil, days, weekday};

/// The furthest a next start is looked for: a 29 February comes within four years and a leap day.
const LOOKAHEAD_DAYS: i64 = 4 * 366;

pub struct Cron {
    minutes: Vec<bool>,
    hours: Vec<bool>,
    month_days: Vec<bool>,
    months: Vec<bool>,
    weekdays: Vec<bool>,
    /// A day field written from `*`: it restricts nothing, so the other alone decides.
    any_month_day: bool,
    any_weekday: bool,
}

fn number(text: &str) -> Option<u32> {
    (!text.is_empty() && text.len() <= 2 && text.bytes().all(|byte| byte.is_ascii_digit()))
        .then(|| text.parse().ok())?
}

/// One field's values from `min` to `max`; none when it is not a field.
fn field(text: &str, min: u32, max: u32) -> Option<Vec<bool>> {
    let mut set = vec![false; max as usize + 1];
    for item in text.split(',') {
        let (range, step) = match item.split_once('/') {
            Some((range, step)) => (range, number(step).filter(|step| *step > 0)?),
            None => (item, 1),
        };
        let (from, to) = match range.split_once('-') {
            _ if range == "*" => (min, max),
            Some((from, to)) => (number(from)?, number(to)?),
            // `a/n` runs from `a` to the field's end.
            None if item.contains('/') => (number(range)?, max),
            None => (number(range)?, number(range)?),
        };
        if from < min || to > max || from > to {
            return None;
        }
        for value in (from..=to).step_by(step as usize) {
            set[value as usize] = true;
        }
    }
    Some(set)
}

/// The cron an expression says; none when it is not one.
pub fn parse(expr: &str) -> Option<Cron> {
    let fields: Vec<&str> = expr.split_whitespace().collect();
    let [minute, hour, month_day, month, weekday] = fields[..] else {
        return None;
    };
    let mut weekdays = field(weekday, 0, 7)?;
    // 7 is Sunday too.
    if weekdays[7] {
        weekdays[0] = true;
    }
    weekdays.truncate(7);
    Some(Cron {
        minutes: field(minute, 0, 59)?,
        hours: field(hour, 0, 23)?,
        month_days: field(month_day, 1, 31)?,
        months: field(month, 1, 12)?,
        weekdays,
        any_month_day: month_day.starts_with('*'),
        any_weekday: weekday.starts_with('*'),
    })
}

/// The first start strictly after `now`; none when the cron never comes (a 31 February).
pub fn next(cron: &Cron, now: i64, zone: &dyn Zone) -> Option<i64> {
    let today = days(zone.day(now));
    for offset in 0..=LOOKAHEAD_DAYS {
        let day = civil(today + offset);
        if !cron.months[day.month as usize] {
            continue;
        }
        let by_date = cron.month_days[day.day as usize];
        let by_weekday = cron.weekdays[weekday(day) as usize];
        let runs = match (cron.any_month_day, cron.any_weekday) {
            (true, true) => true,
            (true, false) => by_weekday,
            (false, true) => by_date,
            (false, false) => by_date || by_weekday,
        };
        if !runs {
            continue;
        }
        for hour in (0..24_u32).filter(|hour| cron.hours[*hour as usize]) {
            for minute in (0..60_u32).filter(|minute| cron.minutes[*minute as usize]) {
                let at = zone.instant(day, hour, minute);
                if at > now {
                    return Some(at);
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::super::rules::{Fixed, date_parse, iso};
    use super::*;

    fn next_of(expr: &str, now: &str) -> Option<String> {
        let zone = Fixed(0);
        let now = date_parse(now, &zone).unwrap();
        next(&parse(expr).unwrap(), now, &zone).map(iso)
    }

    #[test]
    fn reads_only_five_fields_in_range() {
        for bad in [
            "* * * *",
            "* * * * * *",
            "60 * * * *",
            "* 24 * * *",
            "* * 0 * *",
            "* * * 13 *",
            "* * * * 8",
            "*/0 * * * *",
            "5-1 * * * *",
            "a * * * *",
            "1,,2 * * * *",
        ] {
            assert!(parse(bad).is_none(), "{bad}");
        }
        for good in [
            "* * * * *",
            "*/15 9-17 * * 1-5",
            "0 0 1,15 * 7",
            "5/20 * * * *",
        ] {
            assert!(parse(good).is_some(), "{good}");
        }
    }

    #[test]
    fn finds_the_next_start_in_local_time() {
        // 26 Nov 2026 is a Thursday.
        assert_eq!(
            next_of("30 9 * * 1-5", "2026-11-26T10:00:00.000Z").as_deref(),
            Some("2026-11-27T09:30:00.000Z")
        );
        assert_eq!(
            next_of("*/15 * * * *", "2026-11-26T10:00:00.000Z").as_deref(),
            Some("2026-11-26T10:15:00.000Z")
        );
        assert_eq!(
            next_of("0 0 29 2 *", "2026-03-01T00:00:00.000Z").as_deref(),
            Some("2028-02-29T00:00:00.000Z")
        );
        // Both day fields restricted: either one runs it (Sunday 29 Nov comes before 1 Dec).
        assert_eq!(
            next_of("0 12 1 * 0", "2026-11-26T10:00:00.000Z").as_deref(),
            Some("2026-11-29T12:00:00.000Z")
        );
        assert_eq!(next_of("0 0 31 2 *", "2026-11-26T10:00:00.000Z"), None);
        let zone = Fixed(9 * 60);
        let now = date_parse("2026-11-26T00:00:00.000Z", &zone).unwrap();
        // 09:00 in a zone nine hours ahead of UTC is midnight UTC.
        assert_eq!(
            next(&parse("0 9 * * *").unwrap(), now, &zone)
                .map(iso)
                .as_deref(),
            Some("2026-11-27T00:00:00.000Z")
        );
    }
}
