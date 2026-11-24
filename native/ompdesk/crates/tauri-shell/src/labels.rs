//! The words of the app menu and the tray in each UI language (`native_labels.json`; Node's text-field context menu
//! and `native-labels.test.ts` read the same file).

use serde::Deserialize;
use std::collections::HashMap;
use std::sync::LazyLock;

/// `UiLanguage` (src/shared/ui-language.ts).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Lang {
    #[default]
    En,
    Ko,
}

impl Lang {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "en" => Some(Self::En),
            "ko" => Some(Self::Ko),
            _ => None,
        }
    }
}

#[derive(Deserialize)]
struct Words {
    en: String,
    ko: String,
}

static LABELS: LazyLock<HashMap<String, Words>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("native_labels.json")).expect("native_labels.json")
});

/// `key`'s words in `lang`. Every key the shell names is in the file: the menu and tray tests build every item.
pub fn text(lang: Lang, key: &str) -> &'static str {
    let words = LABELS
        .get(key)
        .unwrap_or_else(|| panic!("native_labels.json has no {key}"));
    match lang {
        Lang::En => &words.en,
        Lang::Ko => &words.ko,
    }
}

/// `text` with `{name}` filled from `params`, as `fillText` fills it.
pub fn fill(lang: Lang, key: &str, params: &[(&str, &str)]) -> String {
    params
        .iter()
        .fold(text(lang, key).to_owned(), |text, (name, value)| {
            text.replace(&format!("{{{name}}}"), value)
        })
}
