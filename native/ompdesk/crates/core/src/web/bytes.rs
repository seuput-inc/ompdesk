//! The web edge's upload and blob operations. The asset archive belongs to the listener lifecycle.

use crate::server::Registry;

pub fn register(registry: &mut Registry) {
    super::uploads::register(registry);
    super::blobs::register(registry);
}
