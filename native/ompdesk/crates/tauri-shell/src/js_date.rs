use std::fmt::Write;
use time::OffsetDateTime;

/// `Date#toISOString` for a timestamp within the ECMAScript Date range.
pub(crate) fn iso_ms(ms: i64) -> String {
    let at = OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .expect("validated JavaScript timestamp");
    let year = at.year();
    let mut out = String::with_capacity(27);
    if (0..=9999).contains(&year) {
        write!(out, "{year:04}").unwrap();
    } else {
        write!(out, "{year:+07}").unwrap();
    }
    write!(
        out,
        "-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        at.month() as u8,
        at.day(),
        at.hour(),
        at.minute(),
        at.second(),
        at.millisecond()
    )
    .unwrap();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_the_full_js_date_range() {
        for (ms, expected) in [
            (-8_640_000_000_000_000, "-271821-04-20T00:00:00.000Z"),
            (-1, "1969-12-31T23:59:59.999Z"),
            (8_640_000_000_000_000, "+275760-09-13T00:00:00.000Z"),
        ] {
            assert_eq!(iso_ms(ms), expected);
        }
    }
}
