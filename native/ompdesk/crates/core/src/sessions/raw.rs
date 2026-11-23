use std::borrow::Cow;
use std::collections::HashMap;

use serde::Deserialize;
use serde_json::value::RawValue;

// Journal keys and ids follow JSON.parse, including escaped spellings and lone UTF-16 surrogates.
#[derive(Deserialize, Eq, Hash, PartialEq)]
#[serde(transparent)]
pub(super) struct Text<'a>(#[serde(borrow)] pub(super) Cow<'a, [u8]>);

#[derive(Deserialize)]
#[serde(transparent)]
pub(super) struct Object<'a>(#[serde(borrow)] HashMap<Text<'a>, &'a RawValue>);

impl<'a> Object<'a> {
    pub(super) fn parse(raw: &'a RawValue) -> Option<Self> {
        if !raw.get().starts_with('{') {
            return None;
        }
        serde_json::from_str(raw.get()).ok()
    }

    pub(super) fn get(&self, key: &'static [u8]) -> Option<&'a RawValue> {
        self.0.get(&Text(Cow::Borrowed(key))).copied()
    }

    pub(super) fn string(&self, key: &'static [u8]) -> Option<&'a RawValue> {
        self.get(key).filter(|raw| raw.get().starts_with('"'))
    }

    pub(super) fn decoded(&self, key: &'static [u8]) -> Option<Text<'a>> {
        serde_json::from_str(self.string(key)?.get()).ok()
    }

    pub(super) fn is(&self, key: &'static [u8], value: &[u8]) -> bool {
        self.decoded(key).is_some_and(|s| s.0.as_ref() == value)
    }
}
