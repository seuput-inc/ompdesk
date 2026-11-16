use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

use crate::transport::Transport;
use crate::{AttachedPage, Error, Event, Result};

pub struct PausedRequest {
    pub request_id: String,
    pub page: AttachedPage,
    /// Unmodified Fetch.requestPaused params, including request.method, headers, postData and optional postDataEntries.
    pub params: Arc<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestDisposition {
    Handled,
    Unhandled,
}

pub trait RequestHandler: Send + Sync {
    /// Handled means the host already completed this request with a same-session CDP response.
    fn handle(
        &self,
        request: PausedRequest,
    ) -> Pin<Box<dyn Future<Output = Result<RequestDisposition>> + Send>>;
}

pub(crate) struct Requests {
    handler: Arc<dyn RequestHandler>,
    timeout: Duration,
}

impl Requests {
    pub(crate) fn new(handler: Arc<dyn RequestHandler>, timeout: Duration) -> Self {
        Self { handler, timeout }
    }

    pub(crate) async fn handle(
        &self,
        transport: &Transport,
        target: &Value,
        event: &Event,
    ) -> Result<RequestDisposition> {
        let request_id = event
            .params
            .get("requestId")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::new("cdp", "Paused Preview request has no identity"))?
            .to_owned();
        let session = event
            .session_id
            .as_deref()
            .ok_or_else(|| Error::new("cdp", "Paused Preview request has no session"))?;
        let request = PausedRequest {
            request_id,
            page: AttachedPage::from_target(transport, target, session)?,
            params: event.params.clone(),
        };
        tokio::time::timeout(self.timeout, self.handler.handle(request))
            .await
            .map_err(|_| Error::new("timeout", "Preview host request handling timed out"))?
    }
}
