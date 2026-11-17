use serde_json::Value;

#[derive(Default)]
pub struct Pending {
    request: Option<String>,
    frame: Option<String>,
    url: Option<String>,
}
pub struct Failure {
    pub error: String,
    pub url: String,
}
impl Pending {
    pub fn observe(&mut self, method: &str, params: &Value, root: Option<&str>) -> Option<Failure> {
        match method {
            "Network.requestWillBeSent"
                if params["type"].as_str() == Some("Document")
                    && params["frameId"].as_str() == root
                    && root.is_some() =>
            {
                self.request = params["requestId"].as_str().map(str::to_owned);
                self.frame = params["frameId"].as_str().map(str::to_owned);
                self.url = params
                    .pointer("/request/url")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                None
            }
            "Network.loadingFailed"
                if params["requestId"].as_str() == self.request.as_deref()
                    && self.request.is_some()
                    && self.frame.as_deref() == root =>
            {
                self.request = None;
                Some(Failure {
                    error: params["errorText"].as_str()?.to_owned(),
                    url: self.url.take()?,
                })
            }
            "Network.loadingFinished"
                if params["requestId"].as_str() == self.request.as_deref() =>
            {
                self.request = None;
                self.url = None;
                None
            }
            _ => None,
        }
    }
}

/// Numbers a page's loads. A `Page.navigate` reply arrives after later operations already ran, so only the newest
/// load's reply may speak for the page: an older one failing is that load being replaced, not the page failing.
#[derive(Default)]
pub struct Loads(u64);
impl Loads {
    pub fn begin(&mut self) -> u64 {
        self.0 += 1;
        self.0
    }
    pub fn is_current(&self, load: u64) -> bool {
        self.0 == load
    }
}

pub enum Admission {
    Report,
    Duplicate,
    Superseded,
}

/// Decides under the document's lock whether a load failure speaks for the page now. `load` is set for the failure
/// a `Page.navigate` reply carries: once a newer load has begun it is that load being replaced, not the page failing.
pub fn admit(
    loads: &Loads,
    last_failure: &mut Option<(u64, String)>,
    generation: u64,
    loading: bool,
    message: &str,
    load: Option<u64>,
) -> Admission {
    if load.is_some_and(|load| !loads.is_current(load)) {
        return Admission::Superseded;
    }
    // The host clears a reported error when the page starts loading again. Only a page that is still stopped
    // has the earlier report in force; one that started loading since needs the failure again.
    let duplicate = !loading
        && last_failure
            .as_ref()
            .is_some_and(|(epoch, error)| *epoch == generation && error == message);
    if duplicate {
        return Admission::Duplicate;
    }
    *last_failure = Some((generation, message.to_owned()));
    Admission::Report
}

/// Whether a `Page.navigate` with these parameters replaces the root document's load: it names no frame, or the root.
pub fn replaces_main_load(params: &Value, root: Option<&str>) -> bool {
    params["frameId"]
        .as_str()
        .is_none_or(|frame| Some(frame) == root)
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn subresource_and_superseded_failures_cannot_fail_the_current_document() {
        let mut pending = Pending::default();
        for (id, url) in [
            ("old", "https://old.invalid"),
            ("new", "https://new.invalid"),
        ] {
            pending.observe(
                "Network.requestWillBeSent",
                &json!({"type":"Document","frameId":"root","requestId":id,"request":{"url":url}}),
                Some("root"),
            );
        }
        assert!(
            pending
                .observe(
                    "Network.loadingFailed",
                    &json!({"requestId":"image","errorText":"net::ERR_FAILED"}),
                    Some("root")
                )
                .is_none()
        );
        assert!(
            pending
                .observe(
                    "Network.loadingFailed",
                    &json!({"requestId":"old","errorText":"net::ERR_ABORTED"}),
                    Some("root")
                )
                .is_none()
        );
        let error = pending
            .observe(
                "Network.loadingFailed",
                &json!({"requestId":"new","errorText":"net::ERR_NAME_NOT_RESOLVED"}),
                Some("root"),
            )
            .unwrap();
        assert_eq!(error.url, "https://new.invalid");
        assert_eq!(error.error, "net::ERR_NAME_NOT_RESOLVED");
    }
    #[test]
    fn a_replaced_loads_failed_reply_cannot_fail_the_page() {
        let mut loads = Loads::default();
        let mut last = None;
        let stopped = loads.begin();
        assert!(matches!(
            admit(
                &loads,
                &mut last,
                3,
                true,
                "net::ERR_ABORTED",
                Some(stopped)
            ),
            Admission::Report
        ));
        let replacement = loads.begin();
        last = None;
        assert!(matches!(
            admit(
                &loads,
                &mut last,
                3,
                true,
                "net::ERR_ABORTED",
                Some(stopped)
            ),
            Admission::Superseded
        ));
        assert!(last.is_none());
        assert!(matches!(
            admit(
                &loads,
                &mut last,
                3,
                true,
                "net::ERR_EMPTY_RESPONSE",
                Some(replacement)
            ),
            Admission::Report
        ));
        assert!(matches!(
            admit(&loads, &mut last, 3, false, "net::ERR_EMPTY_RESPONSE", None),
            Admission::Duplicate
        ));
        assert!(matches!(
            admit(&loads, &mut last, 3, true, "net::ERR_EMPTY_RESPONSE", None),
            Admission::Report
        ));
    }
    #[test]
    fn only_a_root_navigation_replaces_the_pending_load() {
        assert!(replaces_main_load(
            &json!({"url":"https://a.invalid"}),
            Some("root")
        ));
        assert!(replaces_main_load(
            &json!({"url":"https://a.invalid","frameId":"root"}),
            Some("root")
        ));
        assert!(!replaces_main_load(
            &json!({"url":"https://a.invalid","frameId":"child"}),
            Some("root")
        ));
    }
    #[test]
    fn failing_child_frame_does_not_replace_the_main_navigation() {
        let mut pending = Pending::default();
        pending.observe("Network.requestWillBeSent",&json!({"type":"Document","frameId":"child","requestId":"child-request","request":{"url":"https://child.invalid"}}),Some("root"));
        assert!(
            pending
                .observe(
                    "Network.loadingFailed",
                    &json!({"requestId":"child-request","errorText":"net::ERR_FAILED"}),
                    Some("root")
                )
                .is_none()
        );
    }
}
