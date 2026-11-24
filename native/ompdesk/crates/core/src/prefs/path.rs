//! A key written in dot notation and what `get`, `has`, `set` and `delete` do along it: the rules of conf 16 (the
//! `electron-store` the prefs were kept in), whose paths are `dot-prop` 10's `parsePath`. Both are ported from
//! Sindre Sorhus's MIT code (`LICENSES/MIT-sindresorhus.txt`); `vectors.json` holds what conf did for each key,
//! captured before it was removed (`tests.rs`).

use serde_json::{Map, Value};

use crate::server::Fault;

/// One step of a path: an object's key, or an array's index (an index is also the key of that number on an object).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Part {
    Key(String),
    Index(usize),
}

/// The bookkeeping key conf kept for itself; no caller reads or writes it.
pub const INTERNAL_KEY: &str = "__internal__";

/// `dot-prop`'s `MAX_ARRAY_INDEX`.
const MAX_INDEX: usize = 1_000_000;

fn disallowed(segment: &str) -> bool {
    matches!(segment, "__proto__" | "prototype" | "constructor")
}

/// A segment between dots: a non-negative integer without leading zeros up to `MAX_INDEX` is an index.
fn segment(segment: &str, parts: &mut Vec<Part>) -> bool {
    if disallowed(segment) {
        return false;
    }
    // "0", or digits without a leading zero, up to `MAX_INDEX`.
    let canonical = !segment.is_empty()
        && (segment == "0" || !segment.starts_with('0'))
        && segment.bytes().all(|b| b.is_ascii_digit());
    let index = if canonical {
        segment.parse::<usize>().ok().filter(|n| *n <= MAX_INDEX)
    } else {
        None
    };
    parts.push(match index {
        Some(index) => Part::Index(index),
        None => Part::Key(segment.to_string()),
    });
    true
}

#[derive(PartialEq, Eq, Clone, Copy)]
enum At {
    Start,
    Property,
    Index,
    IndexEnd,
}

/// `parsePath`: `Ok(None)` for a key it refuses by naming no parts (`__proto__`), `Err` for one it cannot read.
pub fn parse(key: &str) -> Result<Option<Vec<Part>>, ()> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut index = String::new();
    let mut had_property = false;
    let mut at = At::Start;
    let mut escaping = false;
    for character in key.chars() {
        if escaping {
            current.push(character);
            escaping = false;
            continue;
        }
        if character == '\\' {
            if matches!(at, At::Index | At::IndexEnd) {
                return Err(());
            }
            escaping = true;
            if at == At::Start {
                at = At::Property;
            }
            continue;
        }
        match character {
            '.' => match at {
                At::Index => return Err(()),
                At::IndexEnd => at = At::Property,
                _ => {
                    if !segment(&current, &mut parts) {
                        return Ok(None);
                    }
                    current.clear();
                    at = At::Property;
                }
            },
            '[' => match at {
                At::Index => return Err(()),
                At::IndexEnd => at = At::Index,
                _ => {
                    if at == At::Property && disallowed(&current) {
                        return Ok(None);
                    }
                    had_property = at == At::Property;
                    at = At::Index;
                }
            },
            ']' => match at {
                At::IndexEnd => return Err(()),
                At::Start | At::Property => {
                    at = At::Property;
                    current.push(']');
                }
                At::Index if index.is_empty() => {
                    current.push_str("[]");
                    at = At::Property;
                }
                At::Index => {
                    if (!current.is_empty() || had_property) && !segment(&current, &mut parts) {
                        return Ok(None);
                    }
                    current.clear();
                    had_property = false;
                    let valid = index
                        .parse::<usize>()
                        .ok()
                        .filter(|n| *n <= MAX_INDEX && n.to_string() == index);
                    parts.push(match valid {
                        Some(n) => Part::Index(n),
                        None => Part::Key(std::mem::take(&mut index)),
                    });
                    index.clear();
                    at = At::IndexEnd;
                }
            },
            _ => match at {
                At::Index if !character.is_ascii_digit() => return Err(()),
                At::Index => index.push(character),
                At::IndexEnd => return Err(()),
                _ => {
                    at = At::Property;
                    current.push(character);
                }
            },
        }
    }
    if escaping {
        current.push('\\');
    }
    match at {
        At::Property => {
            if !segment(&current, &mut parts) {
                return Ok(None);
            }
        }
        At::Index => return Err(()),
        At::Start => parts.push(Part::Key(String::new())),
        At::IndexEnd => {}
    }
    Ok(Some(parts))
}

fn unreadable(key: &str) -> Fault {
    Fault::new(
        "invalid_key",
        format!("The key `{key}` is not a key a value can be written to."),
    )
}

/// The parts of `key`, `None` for a key nothing is held under, a fault for one that cannot be read.
pub fn parts_of(key: &str) -> Result<Option<Vec<Part>>, Fault> {
    parse(key).map_err(|()| unreadable(key))
}

/// Whether `key` reaches conf's bookkeeping, which `set` and `delete` refuse.
pub fn is_reserved(key: &str) -> bool {
    if !key.contains(['.', '[', ']', '\\']) {
        return key == INTERNAL_KEY;
    }
    matches!(parse(key), Ok(Some(parts)) if parts.first() == Some(&Part::Key(INTERNAL_KEY.to_string())))
}

pub fn reserved_fault() -> Fault {
    Fault::new(
        "reserved_key",
        format!(
            "Please don't use the {INTERNAL_KEY} key, as it's used to manage this module internal operations."
        ),
    )
}

/// The key a part names on an object.
fn name(part: &Part) -> String {
    match part {
        Part::Key(key) => key.clone(),
        Part::Index(index) => index.to_string(),
    }
}

/// An array's element a part names, as JavaScript reads `array[part]`.
fn element(part: &Part) -> Option<usize> {
    match part {
        Part::Index(index) => Some(*index),
        Part::Key(key) => key.parse::<usize>().ok().filter(|n| n.to_string() == *key),
    }
}

/// `propertyIsEnumerable`: an own key of an object, an element of an array.
fn child<'a>(value: &'a Value, part: &Part) -> Option<&'a Value> {
    match value {
        Value::Object(map) => map.get(&name(part)),
        Value::Array(items) => element(part).and_then(|index| items.get(index)),
        _ => None,
    }
}

fn child_mut<'a>(value: &'a mut Value, part: &Part) -> Option<&'a mut Value> {
    match value {
        Value::Object(map) => map.get_mut(&name(part)),
        Value::Array(items) => element(part).and_then(|index| items.get_mut(index)),
        _ => None,
    }
}

/// The value at `parts`; a `null` is a value, a missing key none.
pub fn get<'a>(store: &'a Map<String, Value>, parts: &[Part]) -> Option<&'a Value> {
    let (first, rest) = parts.split_first()?;
    let mut value = store.get(&name(first))?;
    for part in rest {
        value = child(value, part)?;
    }
    Some(value)
}

/// Puts `value` at `parts`, making the objects (or, before an index, arrays) the rest of the path needs.
pub fn set(
    store: &mut Map<String, Value>,
    key: &str,
    parts: &[Part],
    value: Value,
) -> Result<(), Fault> {
    let Some((first, rest)) = parts.split_first() else {
        return Ok(());
    };
    let top = name(first);
    let Some((last, middle)) = rest.split_last() else {
        store.insert(top, value);
        return Ok(());
    };
    let next = middle.first().unwrap_or(last);
    let mut object = match store.get(&top) {
        Some(Value::Object(_) | Value::Array(_)) => store.get_mut(&top),
        _ => {
            store.insert(top.clone(), container_for(next));
            store.get_mut(&top)
        }
    }
    .expect("the key was just checked or put in");
    for (position, part) in middle.iter().enumerate() {
        refuse_name_on_array(object, key, part)?;
        let next = middle.get(position + 1).unwrap_or(last);
        if !matches!(
            child(object, part),
            Some(Value::Object(_) | Value::Array(_))
        ) {
            assign(object, part, container_for(next));
        }
        object = child_mut(object, part).expect("the container was just checked or put in");
    }
    refuse_name_on_array(object, key, last)?;
    assign(object, last, value);
    Ok(())
}

fn container_for(next: &Part) -> Value {
    match next {
        Part::Index(_) => Value::Array(Vec::new()),
        Part::Key(_) => Value::Object(Map::new()),
    }
}

fn refuse_name_on_array(object: &Value, key: &str, part: &Part) -> Result<(), Fault> {
    match (object, part) {
        (Value::Array(_), Part::Key(name)) => Err(Fault::new(
            "invalid_key",
            format!(
                "The key `{key}` only holds the elements of an array, so `{name}` cannot be set on it"
            ),
        )),
        _ => Ok(()),
    }
}

/// `object[part] = value`; an index past an array's end leaves holes, which JSON writes as `null`.
fn assign(object: &mut Value, part: &Part, value: Value) {
    match object {
        Value::Object(map) => {
            map.insert(name(part), value);
        }
        Value::Array(items) => {
            if let Part::Index(index) = part {
                if *index >= items.len() {
                    items.resize(*index + 1, Value::Null);
                }
                items[*index] = value;
            }
        }
        _ => {}
    }
}

/// Takes out what `parts` names; an array's element is taken out of the array, not left as a hole.
pub fn delete(store: &mut Map<String, Value>, parts: &[Part]) {
    let Some((first, rest)) = parts.split_first() else {
        return;
    };
    let top = name(first);
    let Some((last, middle)) = rest.split_last() else {
        store.shift_remove(&top);
        return;
    };
    let Some(mut object) = store.get_mut(&top) else {
        return;
    };
    for part in middle {
        let Some(next) = child_mut(object, part) else {
            return;
        };
        if !matches!(next, Value::Object(_) | Value::Array(_)) {
            return;
        }
        object = next;
    }
    match object {
        Value::Array(items) => {
            if let Part::Index(index) = last
                && *index < items.len()
            {
                items.remove(*index);
            }
        }
        Value::Object(map) => {
            map.shift_remove(&name(last));
        }
        _ => {}
    }
}
