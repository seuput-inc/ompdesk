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
