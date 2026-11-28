//! A bot as one local package file (Orca's `main/bots/sharing/bot-package-archive.ts` and the `bot.json` of
//! `shared/bots/bot-package.ts`, re-implemented for files on this computer only; Orca Cloud's share links stay out):
//! the owner exports a bot to a file and imports one, here or on another computer. The package is one JSON document:
//! its name, `SOUL.md`, its own skills (`.omp/skills/<name>/SKILL.md`), its memory topic files (`memory/<topic>.md`),
//! and its Look around, notification and item settings. `MEMORY.md` (what it keeps about its owner), its
//! chats, items and history stay home, as in Orca's package; one whose text holds a credential is refused.

use std::io::Read;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::super::fail::{R, fail};
use super::bot_files;
use crate::agentctl::journal::bots::BotRecord;
use crate::agentctl::journal::looks::{LookSetting, secret_like};

/// What a package file says it is.
pub const FORMAT: &str = "ompdesk-bot";
pub const VERSION: u64 = 1;
/// The largest package read.
const PACKAGE_MAX: u64 = 4 * 1024 * 1024;
/// The most skills and memory topics one package carries, and each text's longest.
const SKILLS_MAX: usize = 24;
const TOPICS_MAX: usize = 64;
const TEXT_MAX: usize = 200_000;

/// One skill: its folder name and its `SKILL.md`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PackageSkill {
    pub name: String,
    pub content: String,
}

/// One memory topic file: `memory/<topic>.md`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PackageTopic {
    pub topic: String,
    pub text: String,
}

/// A bot as a package file holds it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Package {
    pub format: String,
    pub version: u64,
    pub name: String,
    pub soul: Option<String>,
    pub skills: Vec<PackageSkill>,
    pub memory: Vec<PackageTopic>,
    pub look_around: Option<LookSetting>,
    pub quiet: Vec<String>,
    pub stale_days: Option<f64>,
}

fn read_text(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    (bytes.len() <= TEXT_MAX).then(|| String::from_utf8_lossy(&bytes).into_owned())
}

/// The names in `dir` that pass `keep`, sorted.
fn names(dir: &Path, keep: impl Fn(&Path) -> bool) -> Vec<String> {
    let mut found: Vec<String> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| keep(&entry.path()))
                .filter_map(|entry| entry.file_name().into_string().ok())
                .collect()
        })
        .unwrap_or_default();
    found.sort();
    found
}

/// A skill or topic name: lowercase letters, digits, `-` and `_`, 1 to 64 of them.
fn part_name_ok(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/// The package of `bot`, read from its folder; refused when a text in it looks like it holds a credential.
pub fn export(bot: &BotRecord) -> R<Package> {
    let folder = Path::new(&bot.folder);
    let skills_dir = folder.join(".omp").join("skills");
    let skills: Vec<PackageSkill> = names(&skills_dir, |path| path.join("SKILL.md").is_file())
        .into_iter()
        .filter(|name| part_name_ok(name))
        .take(SKILLS_MAX)
        .filter_map(|name| {
            let content = read_text(&skills_dir.join(&name).join("SKILL.md"))?;
            Some(PackageSkill { name, content })
        })
        .collect();
    let memory_dir = folder.join("memory");
    let memory: Vec<PackageTopic> = names(&memory_dir, |path| {
        path.is_file() && path.extension().is_some_and(|ext| ext == "md")
    })
    .into_iter()
    .filter_map(|file| {
        let topic = file.strip_suffix(".md")?.to_owned();
        part_name_ok(&topic).then_some(topic)
    })
    .take(TOPICS_MAX)
    .filter_map(|topic| {
        let text = read_text(&memory_dir.join(format!("{topic}.md")))?;
        Some(PackageTopic { topic, text })
    })
    .collect();
    let package = Package {
        format: FORMAT.to_owned(),
        version: VERSION,
        name: bot.name.clone(),
        soul: read_text(&folder.join("SOUL.md")),
        skills,
        memory,
        look_around: Some(bot.look()),
        quiet: bot.quiet.clone(),
        stale_days: bot.stale_days,
    };
    let texts = package
        .soul
        .iter()
        .map(|soul| ("SOUL.md".to_owned(), soul))
        .chain(
            package
                .skills
                .iter()
                .map(|skill| (format!("the skill {}", skill.name), &skill.content)),
        )
        .chain(
            package
                .memory
                .iter()
                .map(|topic| (format!("memory/{}.md", topic.topic), &topic.text)),
        );
    for (what, text) in texts {
        if secret_like(text) {
            return fail(format!(
                "{what} looks like it holds a credential: take it out, then export again."
            ));
        }
    }
    Ok(package)
}

/// Writes `package` to `file` (an absolute path the owner picked).
pub fn write(file: &str, package: &Package) -> R<()> {
    if !Path::new(file).is_absolute() {
        return fail("The package file must be an absolute path.");
    }
    let text = serde_json::to_string_pretty(package).unwrap_or_default();
    if let Err(error) = crate::agentctl::journal::write_text(Path::new(file), &text, None) {
        return fail(format!("Could not write {file}: {error}"));
    }
    Ok(())
}

/// Read only the open file granted by the picker. Bound the actual read even if the file grows.
pub fn read(file: std::fs::File) -> R<Package> {
    if !file.metadata().is_ok_and(|meta| meta.len() <= PACKAGE_MAX) {
        return fail("The selected bot package is too large or unavailable.");
    }
    let mut text = String::new();
    if file
        .take(PACKAGE_MAX + 1)
        .read_to_string(&mut text)
        .is_err()
        || text.len() as u64 > PACKAGE_MAX
    {
        return fail("Could not read the selected bot package (invalid text or too large).");
    }
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return fail("The selected file is no bot package.");
    };
    if value.get("format").and_then(Value::as_str) != Some(FORMAT) {
        return fail("The selected file is no bot package.");
    }
    if value
        .get("version")
        .and_then(Value::as_u64)
        .is_none_or(|version| version > VERSION)
    {
        return fail("This bot package is from a newer OMPdesk: update OMPdesk, then import it.");
    }
    let Ok(package) = serde_json::from_value::<Package>(value) else {
        return fail("The selected file is no bot package.");
    };
    let name = package.name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return fail("The package's bot has no usable name.");
    }
    if package.skills.len() > SKILLS_MAX || package.memory.len() > TOPICS_MAX {
        return fail("The package holds more skills or memory files than a bot takes.");
    }
    let parts_ok = package
        .skills
        .iter()
        .all(|skill| part_name_ok(&skill.name) && skill.content.len() <= TEXT_MAX)
        && package
            .memory
            .iter()
            .all(|topic| part_name_ok(&topic.topic) && topic.text.len() <= TEXT_MAX)
        && package
            .soul
            .as_ref()
            .is_none_or(|soul| soul.len() <= TEXT_MAX);
    if !parts_ok {
        return fail("The package holds a part with a bad name or too much text.");
    }
    Ok(package)
}

/// Writes what a new bot takes from `package` into its folder: its soul and skills (`bot_files::seed`, which checks
/// them before anything is written) and its memory topics.
pub fn seed(folder: &Path, name: &str, package: &Package) -> R<()> {
    let skills: Vec<Value> = package
        .skills
        .iter()
        .map(|skill| json!({ "name": skill.name, "content": skill.content }))
        .collect();
    bot_files::seed(folder, name, None, package.soul.as_deref(), &skills)?;
    for topic in &package.memory {
        bot_files::file_request(
            folder,
            &json!({ "file": format!("memory/{}.md", topic.topic), "content": topic.text }),
        )?;
    }
    Ok(())
}
