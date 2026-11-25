//! The options the Files panel may send to stock's pi-natives grep.
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

use crate::server::Fault;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Search<'a> {
    // V8 already checked the pattern. Keep its JSON spelling, including lone UTF-16 surrogates.
    #[serde(borrow)]
    root: &'a RawValue,
    pattern: &'a RawValue,
    glob: Option<&'a RawValue>,
    match_case: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Grep<'a> {
    pattern: &'a RawValue,
    path: &'a RawValue,
    #[serde(skip_serializing_if = "Option::is_none")]
    glob: Option<&'a RawValue>,
    ignore_case: bool,
    hidden: bool,
    gitignore: bool,
    max_count: u32,
    max_columns: u32,
    max_count_per_file: u32,
    timeout_ms: u32,
}

#[derive(Serialize)]
struct Line<'a> {
    id: u64,
    method: &'static str,
    params: Grep<'a>,
}

pub(super) fn request_line(id: u64, bytes: &[u8]) -> Result<Vec<u8>, Fault> {
    let search: Search<'_> = serde_json::from_slice(bytes)
        .map_err(|error| Fault::new("invalid_params", error.to_string()))?;
    let frame = Line {
        id,
        method: "search.text",
        params: Grep {
            pattern: search.pattern,
            path: search.root,
            glob: search.glob,
            ignore_case: !search.match_case,
            hidden: false,
            gitignore: true,
            max_count: 500,
            max_columns: 240,
            max_count_per_file: 50,
            timeout_ms: 15_000,
        },
    };
    let mut line = Vec::with_capacity(bytes.len() + 160);
    serde_json::to_writer(&mut line, &frame)
        .map_err(|error| Fault::new("internal", error.to_string()))?;
    line.push(b'\n');
    Ok(line)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passes_the_hosts_js_strings_through_without_decoding_or_replacing_them() {
        let frame = request_line(
            7,
            br#"{"root":"/repo","pattern":"\ud800[\\\\]","glob":"*.\udfff","matchCase":false}"#,
        )
        .unwrap();
        let text = std::str::from_utf8(&frame).unwrap();
        assert!(text.contains(r#""pattern":"\ud800[\\\\]""#));
        assert!(text.contains(r#""glob":"*.\udfff""#));
        assert!(text.ends_with('\n'));
    }
}
