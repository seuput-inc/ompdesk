mod sys;

use std::sync::Arc;

use super::Transfer;

pub(super) fn start(transfer: Arc<Transfer>, body: Option<Vec<u8>>) -> Result<(), String> {
    sys::start(transfer, body)
}
