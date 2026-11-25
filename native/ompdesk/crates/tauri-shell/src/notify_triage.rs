use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Report<'a> {
    digest: &'a str,
    now: i64,
    completion: bool,
    has_tab_window: bool,
}

#[derive(Default)]
pub(crate) struct NotifyTriage {
    last: Option<([u8; 64], i64)>,
}

impl NotifyTriage {
    pub(crate) fn admit(&mut self, params: &Value) -> Option<Value> {
        let report = Report::deserialize(params).ok()?;
        let digest: &[u8; 64] = report.digest.as_bytes().try_into().ok()?;
        if !digest.iter().all(u8::is_ascii_hexdigit) {
            return None;
        }
        if let Some((previous, at)) = &self.last
            && previous == digest
            && report.now.saturating_sub(*at) < 1500
        {
            return Some(json!("drop"));
        }
        self.last = Some((*digest, report.now));
        Some(if report.completion && report.has_tab_window {
            json!({"judgeTimeoutMs": 2500})
        } else {
            json!("deliver")
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_input_cannot_replace_the_last_admission() {
        let mut triage = NotifyTriage::default();
        let event =
            json!({"digest":"a".repeat(64), "now":100, "completion":false, "hasTabWindow":false});
        assert_eq!(triage.admit(&event), Some(json!("deliver")));
        let mut invalid = event.clone();
        invalid["digest"] = json!("not a digest");
        assert_eq!(triage.admit(&invalid), None);
        invalid["digest"] = json!("b".repeat(64));
        invalid["title"] = json!("Unexpected field");
        assert_eq!(triage.admit(&invalid), None);
        assert_eq!(triage.admit(&event), Some(json!("drop")));
    }
}
