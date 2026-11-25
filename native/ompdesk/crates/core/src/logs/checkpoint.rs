use std::collections::{HashMap, VecDeque};

use serde::{Deserialize, Serialize};

use super::tail::Identity;

/// The app holds these words opaquely. An inode or byte offset may not fit a JavaScript number.
#[derive(Deserialize, Serialize)]
pub(super) struct Mark([[u32; 2]; 4]);

impl Mark {
    pub(super) fn new(identity: Identity, line_start: u64, observed: u64) -> Self {
        Self([identity.0, identity.1, line_start, observed].map(|n| [(n >> 32) as u32, n as u32]))
    }

    pub(super) fn positions(self) -> (Identity, u64, u64) {
        let [dev, ino, start, end] = self.0.map(|[hi, lo]| (u64::from(hi) << 32) | u64::from(lo));
        ((dev, ino), start, end)
    }
}

pub(super) type Changes = HashMap<String, Option<Mark>>;

#[derive(Deserialize)]
pub(super) struct Checkpoint {
    pub files: HashMap<String, Mark>,
    pub lines: VecDeque<String>,
}
