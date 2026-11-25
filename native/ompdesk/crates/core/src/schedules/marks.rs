use std::fs;
use std::path::PathBuf;

use serde_json::{Map, Value, json};

use super::Journal;
use crate::remote::events::js;

/// FileMarks' compact JSON, key order and 0600 mode. An unchanged launch does not create or repair a file.
pub(super) struct Marks {
    path: PathBuf,
    document: Value,
    writer: Option<Journal>,
}

impl Marks {
    pub fn open(path: PathBuf) -> Self {
        let mut marks = Map::new();
        let saved = fs::read_to_string(&path).ok().and_then(|text| {
            serde_json::from_str::<Value>(&crate::json::whole_surrogates(&text)).ok()
        });
        if let Some(Value::Object(mut value)) = saved {
            let mut keep = |id, entry: Value| {
                let Value::Object(mut fields) = entry else {
                    return;
                };
                let Some(Value::String(key)) = fields.shift_remove("key") else {
                    return;
                };
                let mut entry = json!({"key":key});
                if let Some(mark) = fields.shift_remove("mark") {
                    entry["mark"] = mark;
                }
                js::set(&mut marks, id, entry);
            };
            match value.shift_remove("marks") {
                Some(Value::Object(entries)) => {
                    for (id, entry) in entries {
                        keep(id, entry);
                    }
                }
                Some(Value::Array(entries)) => {
                    for (index, entry) in entries.into_iter().enumerate() {
                        keep(index.to_string(), entry);
                    }
                }
                _ => {}
            }
        }
        Self {
            path,
            document: json!({"version":1,"marks":marks}),
            writer: None,
        }
    }

    pub fn get(&self, id: &str, key: &str) -> Option<&Value> {
        let entry = self.document["marks"].get(id)?;
        if entry["key"] == key {
            entry.get("mark")
        } else {
            None
        }
    }

    pub fn set(&mut self, id: &str, key: &str, mark: Value) {
        if self
            .get(id, key)
            .is_some_and(|old| js::same_json(old, &mark))
        {
            return;
        }
        js::set(self.entries(), id, json!({"key":key,"mark":mark}));
        self.changed();
    }

    pub fn entries(&mut self) -> &mut Map<String, Value> {
        self.document["marks"]
            .as_object_mut()
            .expect("marks document")
    }

    pub fn changed(&mut self) {
        self.writer
            .get_or_insert_with(|| {
                Journal::open(self.path.clone(), Some(0o600), "routine trigger marks")
            })
            .keep(js::stringify(&self.document));
    }

    pub fn close(&mut self) {
        if let Some(writer) = self.writer.take() {
            writer.close(&js::stringify(&self.document));
        }
    }
}

#[test]
fn keeps_the_captured_ts_marks_through_updates_close_reopen_and_pause() {
    let capture: Value =
        serde_json::from_str(include_str!("../routines/runtime/captured.json")).unwrap();
    let dir = crate::fs::disk::make_temp_dir("ompdesk-routine-marks-").unwrap();
    let path = dir.join("routine-marks.json");
    for (before, after) in [("initial", "initial"), ("changed", "afterClose")] {
        let mut marks = Marks::open(path.clone());
        for (id, entry) in capture[before].as_object().unwrap() {
            marks.set(id, entry["key"].as_str().unwrap(), entry["mark"].clone());
        }
        marks.close();
        let expected = json!({"version":1, "marks":capture[after]});
        assert_eq!(fs::read_to_string(&path).unwrap(), expected.to_string());
    }
    let mut marks = Marks::open(path.clone());
    marks.entries().clear();
    marks.changed();
    marks.close();
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        json!({"version":1,"marks":capture["afterPause"]}).to_string()
    );
    fs::remove_dir_all(dir).unwrap();
}
