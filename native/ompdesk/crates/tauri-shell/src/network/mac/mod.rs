//! CFNetwork HTTP streams preserve first-byte delivery and OS proxy/PAC and TLS policy.
//! The callable public HTTP stream API is deprecated by Apple; no private API is used.

mod sys;

use std::sync::Arc;

use super::Transfer;

pub(super) fn start(transfer: Arc<Transfer>, body: Option<Vec<u8>>) -> Result<(), String> {
    sys::start(transfer, body)
}
