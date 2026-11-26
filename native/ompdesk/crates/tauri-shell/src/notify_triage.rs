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
    /// `muted`: the popup's gear muted notifications (notification_popup/window.rs); every notice is dropped, so the
    /// page plays no chime either.
    pub(crate) fn admit(&mut self, params: &Value, muted: bool) -> Option<Value> {
        let report = Report::deserialize(params).ok()?;
        let digest: &[u8; 64] = report.digest.as_bytes().try_into().ok()?;
        if !digest.iter().all(u8::is_ascii_hexdigit) {
            return None;
        }
        if muted {
            return Some(json!("drop"));
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
        assert_eq!(triage.admit(&event, false), Some(json!("deliver")));
        let mut invalid = event.clone();
        invalid["digest"] = json!("not a digest");
        assert_eq!(triage.admit(&invalid, false), None);
        invalid["digest"] = json!("b".repeat(64));
        invalid["title"] = json!("Unexpected field");
        assert_eq!(triage.admit(&invalid, false), None);
        assert_eq!(triage.admit(&event, false), Some(json!("drop")));
    }

    #[test]
    fn a_mute_drops_every_notice_without_taking_the_repeat_slot() {
        let mut triage = NotifyTriage::default();
        let completion =
            json!({"digest":"c".repeat(64), "now":100, "completion":true, "hasTabWindow":true});
        assert_eq!(triage.admit(&completion, true), Some(json!("drop")));
        assert_eq!(triage.admit(&json!({"digest":"x"}), true), None);
        // The mute over, the same notice is news, not a repeat.
        assert_eq!(
            triage.admit(&completion, false),
            Some(json!({"judgeTimeoutMs": 2500}))
        );
    }
}
