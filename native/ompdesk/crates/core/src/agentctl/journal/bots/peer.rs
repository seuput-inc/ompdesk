//! Creation on behalf of an authenticated computer. A local tab is not evidence of that computer's home chat.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{BotRecord, Bots};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerCreate {
    pub session_id: Option<String>,
    pub mail: Option<Kickoff>,
    pub routines: Vec<Routine>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Kickoff {
    pub id: String,
    pub journaled: bool,
    pub limited: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Routine {
    pub label: String,
    pub frequency: Frequency,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Frequency {
    Daily { time: String, days: Vec<u8> },
    Interval { minutes: u16 },
}

impl Routine {
    pub fn parse(input: Option<&Value>) -> Result<Vec<Self>, &'static str> {
        let Some(input) = input else {
            return Ok(Vec::new());
        };
        let rows = input
            .as_array()
            .filter(|rows| rows.len() <= 2)
            .ok_or("A bot takes at most two template routines.")?;
        rows.iter().map(|row| {
            if !row.is_object() || !row["frequency"].is_object() {
                return Err("Invalid template routine.");
            }
            let routine = Self::deserialize(row).map_err(|_| "Invalid template routine.")?;
            if routine.label.trim().is_empty() || routine.label.chars().count() > 80
                || routine.label.chars().any(char::is_control) {
                return Err("A routine needs a label of 1 to 80 characters.");
            }
            let ok = match &routine.frequency {
                Frequency::Interval { minutes } => (5..=10_080).contains(minutes),
                Frequency::Daily { time, days } => {
                    matches!(time.as_bytes(), [a @ b'0'..=b'2', b @ b'0'..=b'9', b':', b'0'..=b'5', b'0'..=b'9'] if *a != b'2' || *b <= b'3')
                        && days.len() <= 7 && days.iter().enumerate().all(|(i, day)| *day < 7 && !days[..i].contains(day))
                }
            };
            if !ok { return Err("Invalid template routine frequency."); }
            Ok(routine)
        }).collect()
    }
}

impl Bots {
    pub fn schedules_file(&self) -> Result<std::path::PathBuf, String> {
        Ok(self
            .file
            .as_deref()
            .ok_or("No durable bot registry.")?
            .with_file_name("schedules.json"))
    }

    pub fn install_routines(&mut self, id: &str) -> Result<(), String> {
        let file = self.schedules_file()?;
        let bot = self.find(id).ok_or("Bot not found.")?;
        crate::schedules::install_bot_routines(&file, bot)?;
        self.change_peer(id, |bot| {
            bot.peer_create
                .as_mut()
                .expect("verified peer bot")
                .routines
                .clear()
        })
    }

    pub fn change_peer(
        &mut self,
        id: &str,
        change: impl FnOnce(&mut BotRecord),
    ) -> Result<(), String> {
        let at = self
            .bots
            .iter()
            .position(|bot| bot.id == id)
            .ok_or("Bot not found.")?;
        let before = self.bots[at].clone();
        change(&mut self.bots[at]);
        if let Err(error) = self.save_peer() {
            self.bots[at] = before;
            self.save();
            return Err(error);
        }
        Ok(())
    }
}
