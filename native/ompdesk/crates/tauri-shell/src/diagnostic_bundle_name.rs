use icu_normalizer::ComposingNormalizerBorrowed;
use icu_properties::CodePointMapData;
use icu_properties::props::{GeneralCategory, GeneralCategoryGroup};
use serde::Deserialize;
use serde_json::Value;
use std::fmt::Write;

const TITLE_UNITS: usize = 40;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Name<'a> {
    title: &'a str,
    local_date: [i32; 3],
    anonymized: bool,
}

pub(crate) fn file_name(params: &Value) -> Result<String, serde_json::Error> {
    let Name {
        title,
        local_date: [year, month, day],
        anonymized,
    } = Name::deserialize(params)?;
    let categories = CodePointMapData::<GeneralCategory>::new();
    let mut name = String::with_capacity(32 + title.len().min(3 * TITLE_UNITS));
    name.push_str("omp-dump");
    let mut units = 0;
    for c in ComposingNormalizerBorrowed::new_nfc().normalize_iter(title.chars()) {
        let category = categories.get(c);
        let word = GeneralCategoryGroup::Letter.contains(category)
            || GeneralCategoryGroup::Number.contains(category);
        if units == 0 && !word {
            continue;
        }
        let c = if word || matches!(c, '.' | '_') {
            c
        } else if name.ends_with('-') {
            continue;
        } else {
            '-'
        };
        if units + c.len_utf16() > TITLE_UNITS {
            break;
        }
        if units == 0 {
            name.push('-');
        }
        name.push(c);
        units += c.len_utf16();
    }
    name.truncate(name.trim_end_matches(['-', '.', '_']).len());
    write!(name, "-{year}-{month:02}-{day:02}").expect("writing to a String cannot fail");
    name.push_str(if anonymized { "-anon.zip" } else { ".zip" });
    Ok(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn omits_an_empty_slug_and_keeps_the_callers_local_calendar_fields() {
        let params = json!({
            "title": "../___",
            "localDate": [99, 1, 2],
            "anonymized": false
        });
        assert_eq!(file_name(&params).unwrap(), "omp-dump-99-01-02.zip");
    }
}
