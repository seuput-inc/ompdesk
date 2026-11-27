//! The key is minted by the accepting host, not supplied by the paired device.

use std::io::ErrorKind;

use serde::{Deserialize, Serialize};

use super::{BotRecord, Bots, write_text};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CreationReceipt {
    pub device: String,
    pub key: String,
}

impl Bots {
    pub(super) fn save_peer(&self) -> Result<(), String> {
        let file = self
            .file
            .as_deref()
            .ok_or("The bot registry is not available.")?;
        let text = serde_json::to_string(&self.bots).map_err(|error| error.to_string())?;
        write_text(file, &text, Some(0o600))
    }

    pub fn add_peer(&mut self, bot: BotRecord) -> Result<(), String> {
        self.bots.push(bot);
        if let Err(error) = self.save_peer() {
            self.bots.pop();
            // Replace a deferred disk-full write with the state the caller actually accepted.
            self.save();
            return Err(error);
        }
        Ok(())
    }

    /// For settling a completed create whose answer was lost. A read error is never a negative receipt.
    pub fn peer_created(&self, device: &str, key: &str) -> Result<bool, String> {
        let file = self
            .file
            .as_deref()
            .ok_or("The bot registry is not available.")?;
        let data = match std::fs::read(file) {
            Ok(data) => data,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error.to_string()),
        };
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Row {
            id: String,
            name: String,
            folder: String,
            creation_receipt: Option<CreationReceipt>,
        }
        let rows: Vec<Row> = serde_json::from_slice(&data).map_err(|error| error.to_string())?;
        if rows
            .iter()
            .any(|row| row.id.is_empty() || row.name.is_empty() || row.folder.is_empty())
        {
            return Err("Unreadable bot in registry.".to_owned());
        }
        Ok(rows.iter().any(|row| {
            row.creation_receipt
                .as_ref()
                .is_some_and(|receipt| receipt.device == device && receipt.key == key)
        }))
    }
}
