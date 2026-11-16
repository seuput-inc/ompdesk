//! A supervised Chromium Preview target over private CDP pipes, independent of the application webview.

mod browser;
mod initialization;
mod request;
mod sys;
mod transport;

pub use browser::{
    Browser, LaunchConfig, Navigation, NavigationHandler, Page, Partition, Viewport,
};
pub use initialization::{AttachedPage, PageInitializer};
pub use request::{PausedRequest, RequestDisposition, RequestHandler};
pub use transport::{CommandReply, EventReceiver};

use std::fmt;
use std::sync::Arc;

#[derive(Debug, Clone)]
pub struct Error {
    pub code: &'static str,
    pub message: String,
}

impl Error {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for Error {}

impl From<std::io::Error> for Error {
    fn from(_: std::io::Error) -> Self {
        Self::new("failed", "Preview browser I/O failed")
    }
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

#[derive(Debug, Clone)]
pub struct Event {
    pub method: String,
    pub params: Arc<serde_json::Value>,
    pub session_id: Option<String>,
}
