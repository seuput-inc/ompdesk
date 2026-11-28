use serde::{Deserialize, Serialize};

use super::Items;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ItemMailState {
    Pending(String),
    Delivered,
    HolderChanged,
    AccessRevoked,
    UnsupportedReceiver,
    Expired,
}

impl ItemMailState {
    pub(crate) fn status(&self) -> &'static str {
        match self {
            Self::Pending(_) => "accepted_pending_delivery",
            Self::Delivered => "delivered",
            Self::HolderChanged => "holder_changed",
            Self::AccessRevoked => "access_revoked",
            Self::UnsupportedReceiver => "unsupported_receiver",
            Self::Expired => "expired",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ItemMail {
    pub generation: u64,
    pub sender: String,
    pub session: String,
    pub device: Option<String>,
    pub input: String,
    pub at: f64,
    pub state: ItemMailState,
}

impl Items {
    pub(crate) fn pending_worker_mail(&self) -> Vec<(String, String)> {
        self.items
            .iter()
            .flat_map(|item| {
                item.mail
                    .iter()
                    .filter(|(_, mail)| matches!(mail.state, ItemMailState::Pending(_)))
                    .map(move |(key, _)| (item.id.clone(), key.clone()))
            })
            .collect()
    }

    /// An acceptance and its final receipt use the same write barrier as the assignment, under the same item lock.
    pub(crate) fn commit_mail(
        &mut self,
        item: &str,
        key: &str,
        mail: ItemMail,
    ) -> Result<(), String> {
        let Some(&index) = self.by_id.get(item) else {
            return Err("That item is gone.".into());
        };
        if !self.items[index].mail.contains_key(key)
            && self
                .items
                .iter()
                .flat_map(|row| row.mail.values())
                .filter(|m| matches!(m.state, ItemMailState::Pending(_)))
                .nth(super::super::send_outbox::SEND_OUTBOX_MAX - 1)
                .is_some()
        {
            return Err("The item mail outbox is full; no message was accepted.".into());
        }
        self.persist_row(item, |row| {
            row.mail.insert(key.to_owned(), mail);
        })
    }
}
