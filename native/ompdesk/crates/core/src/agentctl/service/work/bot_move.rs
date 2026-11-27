//! A renamed bot's folder follows its name. Every rename leaves a rename record (`BotRecord.renamed_from`); a bot with
//! one whose folder is a real folder inside the bots folder (`~/.omp/bots`, read through every link) moves to
//! `<its parent>/<slug of the name>`, at once or, while a chat there runs a turn, at a later bot pass. A folder outside
//! the bots folder is a project of the owner's and never moves; nor does one whose target is taken, one whose path
//! holds a link, or one that is, holds or sits in another bot's folder. No folder moves only because its name differs from the bot's: a `-2` left by a clash
//! or a folder the owner named stays. A rename to the same name is how a bot renamed before rename records asks for
//! the move: it records the rename and moves the folder when it may, and does nothing once the folder matches.
//!
//! The move is one directory rename between a durable intent and its finish. The omp of its chats stop first
//! (`bots.release`: Windows refuses to rename a folder a process runs in). The intent (`BotRecord.moving`) is saved
//! before the rename; right after it the registry names the new folder, so anything that resolves the bot through the
//! registry (a wake, a send, its files) reaches the new folder and nothing recreates the old one. The finish moves the
//! bot's chats' sessions along and starts its open chats again on them in the new folder, points its routines at the
//! new folder and sessions, and clears the intent. Every step of the finish is safe to run again: a crash anywhere
//! leaves a bot the next start settles (`settle_moves`) and the next bot pass finishes (`finish_moves`).

use std::collections::HashMap;
use std::path::Path;

use super::super::AgentControl;
use super::super::fail::{R, fail};
use super::super::types::{Schedule, ScheduleResultsTo};
use crate::agentctl::journal::bots::{BotRecord, FolderMove, slug};

/// Where a bot's `folder` goes for `name`: beside it, named for the name.
pub(crate) fn folder_for(folder: &str, name: &str) -> Option<String> {
    let parent = Path::new(folder).parent()?;
    Some(parent.join(slug(name)).to_string_lossy().into_owned())
}

/// `path` is `folder` or inside it.
fn within(path: &str, folder: &str) -> bool {
    path == folder
        || path
            .strip_prefix(folder)
            .is_some_and(|rest| rest.starts_with(['/', '\\']))
}

/// `path` with its `from` part replaced by `to` (`path` within `from`).
fn rebased(path: &str, from: &str, to: &str) -> String {
    match path.strip_prefix(from) {
        Some(rest) if within(path, from) => format!("{to}{rest}"),
        _ => path.to_owned(),
    }
}

/// Why `folder` may not move, if it may not: it must sit inside the bots folder `root` with no link or junction on any
/// part of its path below `root`, and its real place must be the same path inside `root`'s real place, so no link on
/// the way leads the move into a project elsewhere.
fn unmovable(root: &Path, folder: &str) -> Option<String> {
    let path = Path::new(folder);
    let Some(rest) = path
        .strip_prefix(root)
        .ok()
        .filter(|rest| !rest.as_os_str().is_empty())
    else {
        return Some("it is not in the bots folder".to_owned());
    };
    let mut at = root.to_path_buf();
    for part in rest.components() {
        let std::path::Component::Normal(name) = part else {
            return Some("its path is not a plain one".to_owned());
        };
        at.push(name);
        match std::fs::symlink_metadata(&at) {
            Ok(meta) if crate::fs::disk::linked(&meta) => {
                return Some(format!("{} is a link to another folder", at.display()));
            }
            Ok(meta) if !meta.is_dir() => return Some(format!("{} is not a folder", at.display())),
            Ok(_) => {}
            Err(error) => return Some(format!("{} cannot be read: {error}", at.display())),
        }
    }
    match (std::fs::canonicalize(root), std::fs::canonicalize(path)) {
        (Ok(real_root), Ok(real))
            if real
                .strip_prefix(&real_root)
                .is_ok_and(|inside| inside == rest) =>
        {
            None
        }
        (Ok(_), Ok(real)) => Some(format!(
            "it leads to {}, outside the bots folder",
            real.display()
        )),
        _ => Some("its place cannot be read".to_owned()),
    }
}

#[cfg(test)]
thread_local! {
    /// Makes the next folder rename on this thread fail, as a folder something holds open fails on Windows.
    pub(crate) static FAIL_RENAME: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn rename_folder(from: &str, to: &str) -> std::io::Result<()> {
    #[cfg(test)]
    if FAIL_RENAME.with(|fail| fail.replace(false)) {
        return Err(std::io::Error::other("the folder is in use"));
    }
    std::fs::rename(from, to)
}

/// A routine title with the bot's `old` name (`<old>: …`, after an optional `[agent] `) changed to `new`; None when it
/// is not one of the bot's own titles.
pub(crate) fn renamed_title(title: &str, old: &str, new: &str) -> Option<String> {
    let prefix = super::super::wrap::AGENT_SCHEDULE_PREFIX;
    let (mark, rest) = match title.strip_prefix(prefix) {
        Some(rest) => (prefix, rest),
        None => ("", title),
    };
    let after = rest.strip_prefix(old)?;
    after
        .starts_with(':')
        .then(|| format!("{mark}{new}{after}"))
}

impl AgentControl {
    /// A running chat, or an open descendant whose session may not be rebased onto the bot's root.
    fn turn_in(&self, folder: &str) -> Option<String> {
        let state = self.host.state();
        state
            .tabs
            .iter()
            .find(|tab| {
                tab.device.is_none()
                    && within(&tab.cwd, folder)
                    && (tab.busy || tab.resuming || tab.cwd != folder)
            })
            .map(|tab| tab.name().to_owned())
    }

    /// Renames `bot`, retitles its routines, notifies an existing home, and follows its name on disk.
    pub(crate) async fn rename_bot(&self, bot: &BotRecord, name: &str) -> R<(BotRecord, String)> {
        let name = name.trim();
        if name == bot.name {
            self.change_bot(&bot.id, |record| {
                record.renamed_from.get_or_insert_with(|| bot.name.clone());
            })?;
            let folder = self.follow_name(&bot.id).await?;
            return Ok((self.bot_named(&bot.id)?, folder));
        }
        if self
            .bots()
            .find(name)
            .is_some_and(|other| other.id != bot.id)
        {
            return fail(format!("There is already a bot named \"{name}\"."));
        }
        self.change_bot(&bot.id, |record| {
            record.name = name.to_owned();
            record.renamed_from = Some(bot.name.clone());
        })?;
        if let Some(source) = self.schedule_source(None) {
            let ours = |schedule: &Schedule| {
                within(&schedule.draft.cwd, &bot.folder)
                    || schedule
                        .draft
                        .wake_session
                        .as_deref()
                        .is_some_and(|session| bot.has_session(session))
            };
            match source.schedules().await {
                Ok(schedules) => {
                    for schedule in schedules.iter().filter(|&schedule| ours(schedule)) {
                        let Some(title) = renamed_title(&schedule.draft.name, &bot.name, name)
                        else {
                            continue;
                        };
                        if let Err(error) = source
                            .update(&schedule.id, |mut draft| {
                                draft.name = title;
                                draft
                            })
                            .await
                        {
                            eprintln!(
                                "[bots] {name}: routine {} kept its title: {}",
                                schedule.id,
                                error.message()
                            );
                        }
                    }
                }
                Err(error) => eprintln!(
                    "[bots] {name}: its routines kept their titles: {}",
                    error.message()
                ),
            }
        }
        if let Some(home) = bot.home.as_deref() {
            self.note_session(
                home,
                &format!("You were renamed from {} to {name}.", bot.name),
            )
            .await;
        }
        let folder = self.follow_name(&bot.id).await?;
        Ok((self.bot_named(&bot.id)?, folder))
    }

    /// Moves the folder of a bot with a rename record to its name's slug when it may move now; a sentence on where its
    /// folder is. A folder that may never move drops the record (with the reason logged); one a chat there runs a turn
    /// in, or that something held open this launch, keeps it for a later pass.
    pub(crate) async fn follow_name(&self, id: &str) -> R<String> {
        let _move = self.bot_moves.lock().await;
        if self.bot_named(id)?.moving.is_some() {
            self.finish_move(id).await?;
        }
        let bot = self.bot_named(id)?;
        let Some(old) = bot.renamed_from.clone() else {
            return Ok(format!("Its folder is {}.", bot.folder));
        };
        let target = folder_for(&bot.folder, &bot.name).unwrap_or_default();
        // A move never carries or displaces another bot's folder: none may be this one, inside it or around it.
        let shared = self.bots().all().iter().any(|other| {
            other.id != bot.id
                && (within(&other.folder, &bot.folder) || within(&bot.folder, &other.folder))
        });
        let unmanaged = match &self.bots_root {
            None => Some("this app has no bots folder".to_owned()),
            Some(root) => unmovable(root, &bot.folder),
        }
        .or_else(|| {
            shared.then(|| "another bot's folder is it, holds it or sits in it".to_owned())
        });
        if unmanaged.is_none() && old != bot.name {
            super::bot_files::rename_soul_title(Path::new(&bot.folder), &old, &bot.name)?;
        }
        let refused = (target == bot.folder)
            .then(String::new)
            .or(unmanaged)
            .or_else(|| {
                (Path::new(&target).exists() || self.bots().of_folder(&target).is_some())
                    .then(|| format!("{target} is taken"))
            });
        if let Some(why) = refused {
            self.change_bot(&bot.id, |record| record.renamed_from = None)?;
            if why.is_empty() {
                return Ok(format!("Its folder is {}.", bot.folder));
            }
            eprintln!(
                "[bots] {} (was {old}): its folder {} stays: {why}",
                bot.name, bot.folder
            );
            return Ok(format!("Its folder stays {}: {why}.", bot.folder));
        }
        if let Some(chat) = self.turn_in(&bot.folder) {
            return Ok(format!(
                "Its folder moves to {target} once \"{chat}\" no longer uses it."
            ));
        }
        let key = format!("{}\n{}", bot.id, bot.folder);
        if self.mem().folder_unmoved.contains(&key) {
            return Ok(format!(
                "Its folder stays {} until OMPdesk starts again.",
                bot.folder
            ));
        }
        // Its chats' omp stop first: Windows refuses to rename a folder a process runs in.
        if let Err(error) = self.host.release_folder(&bot.folder).await {
            return Ok(format!(
                "Its folder stays {} for now: {}",
                bot.folder,
                error.message()
            ));
        }
        if let Err(error) = self.begin_move(&bot, &target) {
            self.mem().folder_unmoved.insert(key);
            eprintln!("[bots] {}: {}", bot.name, error.message());
            return Ok(format!(
                "Its folder stays {} for now: {}",
                bot.folder,
                error.message()
            ));
        }
        self.bots_changed();
        // The folder moved and the registry names it: what is left converges at the next bot pass if it fails now.
        if let Err(error) = self.finish_move(&bot.id).await {
            eprintln!(
                "[bots] {}: moved to {target}; its chats follow at the next pass: {}",
                bot.name,
                error.message()
            );
        }
        Ok(format!("Its folder moved from {} to {target}.", bot.folder))
    }

    /// Saves the intent, renames the directory and points the registry at `to`. A rename that fails (on Windows, a
    /// folder something holds open) clears the intent and leaves the folder where it was.
    pub(crate) fn begin_move(&self, bot: &BotRecord, to: &str) -> R<()> {
        let from = bot.folder.clone();
        let intent = FolderMove {
            from: from.clone(),
            to: to.to_owned(),
        };
        if self
            .bots()
            .change(&bot.id, |record| record.moving = Some(intent))
            .is_none()
        {
            return fail("That bot is gone.");
        }
        if let Err(error) = rename_folder(&from, to) {
            self.bots().change(&bot.id, |record| record.moving = None);
            return fail(format!(
                "Could not move {from} to {to}: {error}. Close what has the folder open."
            ));
        }
        self.bots()
            .change(&bot.id, |record| record.folder = to.to_owned());
        Ok(())
    }

    /// Finishes `id`'s move once its folder is at the target: main moves its chats' sessions (an open chat starts again
    /// on its moved file), its routines follow the folder and the sessions, and the intent and the rename record go.
    /// Runs again safely.
    pub(crate) async fn finish_move(&self, id: &str) -> R<()> {
        let bot = self.bot_named(id)?;
        let Some(FolderMove { from, to }) = bot.moving.clone() else {
            return Ok(());
        };
        let mut sessions: Vec<String> = Vec::new();
        for session in bot.home.iter().chain(bot.sessions.iter()) {
            if !sessions.contains(session) {
                sessions.push(session.clone());
            }
        }
        let moved: HashMap<String, String> = self.host.relocate_bot(&from, &to, &sessions).await?;
        if let Some(missing) = sessions
            .iter()
            .find(|s| moved.get(*s).is_none_or(String::is_empty))
        {
            return fail(format!(
                "The moved session {missing} has not been located in {to}."
            ));
        }
        let map = |path: &str| moved.get(path).cloned().unwrap_or_else(|| path.to_owned());
        if let Some(source) = self.schedule_source(None) {
            for schedule in source.schedules().await? {
                let draft = &schedule.draft;
                let wakes = draft
                    .wake_session
                    .as_deref()
                    .is_some_and(|session| moved.contains_key(session));
                let reports = matches!(&draft.results_to, Some(ScheduleResultsTo::Session { session }) if moved.contains_key(session));
                if !(wakes || reports || within(&draft.cwd, &from)) {
                    continue;
                }
                source
                    .update(&schedule.id, |mut draft| {
                        draft.cwd = rebased(&draft.cwd, &from, &to);
                        draft.wake_session = draft.wake_session.as_deref().map(map);
                        if let Some(ScheduleResultsTo::Session { session }) = &mut draft.results_to
                        {
                            *session = map(session.as_str());
                        }
                        draft
                    })
                    .await?;
            }
        }
        self.change_bot(id, |record| {
            record.folder = to.clone();
            record.home = record.home.as_deref().map(map);
            for session in &mut record.sessions {
                *session = map(session.as_str());
            }
            for worker in &mut record.workers {
                worker.opened_by_session = worker.opened_by_session.as_deref().map(map);
            }
            record.moving = None;
            record.renamed_from = None;
        })?;
        Ok(())
    }

    /// The bot pass's part: a move whose folder is already at its target is finished, and a renamed bot's folder that
    /// waited for a turn to end follows its name.
    pub(crate) async fn finish_moves(&self) {
        let owed: Vec<BotRecord> = self
            .bots()
            .all()
            .iter()
            .filter(|bot| {
                bot.renamed_from.is_some()
                    || bot.moving.as_ref().is_some_and(|mv| mv.to == bot.folder)
            })
            .cloned()
            .collect();
        for bot in owed {
            if let Err(error) = self.follow_name(&bot.id).await {
                eprintln!(
                    "[bots] {}: its folder {} has not followed its name yet: {}",
                    bot.name,
                    bot.folder,
                    error.message()
                );
            }
        }
    }

    /// At start, before any chat runs: a move a crash cut off points the registry at whichever side holds the folder;
    /// the bot pass finishes it.
    pub(crate) fn settle_moves(&self) {
        let bots: Vec<BotRecord> = self.bots().all().to_vec();
        for bot in bots {
            let Some(FolderMove { from, to }) = bot.moving.clone() else {
                continue;
            };
            match (Path::new(&from).exists(), Path::new(&to).exists()) {
                (false, true) => {
                    self.bots().change(&bot.id, |record| record.folder = to);
                }
                (true, false) => {
                    eprintln!(
                        "[bots] {}: its folder never moved to {to}; it stays in {from}",
                        bot.name
                    );
                    self.bots().change(&bot.id, |record| {
                        record.folder = from;
                        record.moving = None;
                    });
                }
                (both, _) => {
                    eprintln!(
                        "[bots] {}: {} of {from} and {to} exist; its folder stays {}",
                        bot.name,
                        if both { "both" } else { "neither" },
                        bot.folder
                    );
                    self.bots().change(&bot.id, |record| record.moving = None);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_routine_title_follows_only_its_bots_own_name() {
        assert_eq!(
            renamed_title("Ada: Look around", "Ada", "Bea").as_deref(),
            Some("Bea: Look around")
        );
        assert_eq!(
            renamed_title("[agent] Ada: digest", "Ada", "Bea").as_deref(),
            Some("[agent] Bea: digest")
        );
        assert_eq!(renamed_title("Adam: digest", "Ada", "Bea"), None);
        assert_eq!(renamed_title("Nightly", "Ada", "Bea"), None);
    }

    #[test]
    fn a_path_rebases_only_inside_its_folder() {
        assert_eq!(rebased("/b/ada/x", "/b/ada", "/b/bea"), "/b/bea/x");
        assert_eq!(rebased("/b/ada", "/b/ada", "/b/bea"), "/b/bea");
        assert_eq!(rebased("/b/adam", "/b/ada", "/b/bea"), "/b/adam");
    }
}
