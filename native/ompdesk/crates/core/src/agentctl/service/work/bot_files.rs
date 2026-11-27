//! A bot's own files as the owner's Bots page and Settings › Bots read and change them (Orca's bot home files,
//! `settings/bots/bot-home-files.ts`): the soul, skills and memory files of a bot and the bots an import can bring over.
//!
//! Only these files: `SOUL.md`, `MEMORY.md`, `memory/<name>.md`, `memory/history/<name>.md` in the
//! bot's folder, and `.omp/skills/<name>/SKILL.md` written once at create. Nothing outside the folder.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde_json::{Value, json};

use super::super::fail::{R, fail};
use crate::disk::tree::write_atomic_if;

/// The largest soul or memory file read or written here.
const FILE_MAX: usize = 200_000;
/// The most skills a create may seed, and each one's longest text.
const SKILLS_MAX: usize = 24;
const SKILL_MAX: usize = 20_000;
/// The longest purpose a new bot is given (Orca's `BOT_PURPOSE_MAX_LENGTH`).
pub const PURPOSE_MAX: usize = 200;
/// The most sources `importSources` lists.
const SOURCES_MAX: usize = 20;

fn write(path: &Path, bytes: &[u8]) -> R<()> {
    match write_atomic_if(path, bytes, None, 0o777, &|| true) {
        Ok(_) => Ok(()),
        Err(fault) => fail(format!(
            "Could not write {}: {}",
            path.display(),
            fault.message
        )),
    }
}

fn mtime_ms(path: &Path) -> f64 {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0.0, |age| age.as_millis() as f64)
}

/// A skill's folder name: lowercase letters, digits and `-`, 1 to 64 of them.
fn skill_name_ok(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// What a new bot starts with: `SOUL.md` from `soul`, else from `purpose` (its first paragraph, which is what the state
/// reads as its specialty), and each skill's `.omp/skills/<name>/SKILL.md`. A file already there is kept.
pub fn seed(
    folder: &Path,
    name: &str,
    purpose: Option<&str>,
    soul: Option<&str>,
    skills: &[Value],
) -> R<()> {
    let purpose = purpose.map(str::trim).filter(|text| !text.is_empty());
    if purpose.is_some_and(|text| text.chars().count() > PURPOSE_MAX) {
        return fail(format!(
            "A bot's purpose is at most {PURPOSE_MAX} characters."
        ));
    }
    if skills.len() > SKILLS_MAX {
        return fail(format!("A new bot takes at most {SKILLS_MAX} skills."));
    }
    let mut seeded: Vec<(PathBuf, String)> = Vec::new();
    for skill in skills {
        let skill_name = skill.get("name").and_then(Value::as_str).unwrap_or("");
        let content = skill.get("content").and_then(Value::as_str).unwrap_or("");
        if !skill_name_ok(skill_name) {
            return fail(format!(
                "\"{skill_name}\" is not a skill name (a-z, 0-9 and -)."
            ));
        }
        if content.trim().is_empty() || content.len() > SKILL_MAX {
            return fail(format!(
                "The skill {skill_name} is empty or longer than {SKILL_MAX} bytes."
            ));
        }
        seeded.push((
            folder
                .join(".omp")
                .join("skills")
                .join(skill_name)
                .join("SKILL.md"),
            content.to_owned(),
        ));
    }
    let soul_text = match (soul.map(str::trim).filter(|text| !text.is_empty()), purpose) {
        (Some(soul), _) => Some(format!("{soul}\n")),
        (None, Some(purpose)) => Some(format!("# {name}\n\n{purpose}\n")),
        (None, None) => None,
    };
    if let Some(text) = soul_text {
        if text.len() > FILE_MAX {
            return fail("SOUL.md is too long.");
        }
        seeded.push((folder.join("SOUL.md"), text));
    }
    for (path, text) in seeded {
        if !path.exists() {
            write(&path, text.as_bytes())?;
        }
    }
    Ok(())
}

/// Update only the title that `seed` generates. The caller has checked the folder belongs to this bot.
pub(super) fn rename_soul_title(folder: &Path, old: &str, new: &str) -> R<()> {
    let path = folder.join("SOUL.md");
    let meta = match std::fs::symlink_metadata(&path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return fail(format!("Could not inspect {}: {error}", path.display())),
    };
    if !meta.is_file() || crate::fs::disk::linked(&meta) || meta.len() > FILE_MAX as u64 {
        return Ok(());
    }
    let original = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) => return fail(format!("Could not read {}: {error}", path.display())),
    };
    let Some(rest) = original
        .strip_prefix(b"# ")
        .and_then(|v| v.strip_prefix(old.as_bytes()))
    else {
        return Ok(());
    };
    if !(rest.is_empty() || rest.starts_with(b"\n") || rest.starts_with(b"\r\n"))
        || old.contains(['\r', '\n'])
        || new.contains(['\r', '\n'])
    {
        return Ok(());
    }
    let changed = [b"# ", new.as_bytes(), rest].concat();
    #[cfg(unix)]
    let mode = Some(std::os::unix::fs::PermissionsExt::mode(&meta.permissions()) & 0o777);
    #[cfg(not(unix))]
    let mode = None;
    match write_atomic_if(&path, &changed, mode, 0o777, &|| {
        std::fs::symlink_metadata(&path).is_ok_and(|m| m.is_file() && !crate::fs::disk::linked(&m))
            && std::fs::read(&path).is_ok_and(|bytes| bytes == original)
    }) {
        Ok(true) => Ok(()),
        Ok(false) => fail("SOUL.md changed during the rename."),
        Err(error) => fail(format!(
            "Could not write {}: {}",
            path.display(),
            error.message
        )),
    }
}

/// The file a `file` request names, inside `folder`: `SOUL.md`, `MEMORY.md`, `memory/<name>.md` or
/// `memory/history/<name>.md` (a name of letters, digits, `.`, `_` and `-`).
fn bot_file(folder: &Path, file: &str) -> R<PathBuf> {
    let segment_ok = |segment: &str| {
        !segment.is_empty()
            && segment != "."
            && segment != ".."
            && segment
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    };
    let parts: Vec<&str> = file.split('/').collect();
    let allowed = match parts.as_slice() {
        ["SOUL.md"] | ["MEMORY.md"] => true,
        ["memory", name] => segment_ok(name) && name.ends_with(".md"),
        ["memory", "history", name] => segment_ok(name) && name.ends_with(".md"),
        _ => false,
    };
    if !allowed {
        return fail(format!("{file} is not one of a bot's own files."));
    }
    Ok(parts
        .iter()
        .fold(folder.to_path_buf(), |path, part| path.join(part)))
}

/// The `.md` files directly in `dir`, by name.
fn md_files(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| entry.path().is_file())
                .filter_map(|entry| entry.file_name().into_string().ok())
                .filter(|name| name.ends_with(".md"))
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

/// `BotFileRequest`: reads one of the bot's own files (`{exists, content, mtimeMs, topics, history}`), or writes it
/// when `content` is given. A write names the `expectedMtimeMs` it read; a file changed since answers
/// `{changed: true, content, mtimeMs}` and keeps what is on disk (Orca's "file changed on disk"), unless `force`.
pub fn file_request(folder: &Path, request: &Value) -> R<Value> {
    let file = request.get("file").and_then(Value::as_str).unwrap_or("");
    let path = bot_file(folder, file)?;
    let read = |path: &Path| -> Value {
        let content = std::fs::read(path).ok().map(|bytes| {
            let cut = &bytes[..bytes.len().min(FILE_MAX)];
            String::from_utf8_lossy(cut).into_owned()
        });
        let memory = folder.join("memory");
        json!({
            "exists": content.is_some(),
            "content": content.unwrap_or_default(),
            "mtimeMs": mtime_ms(path),
            "topics": md_files(&memory),
            "history": md_files(&memory.join("history")),
        })
    };
    let Some(content) = request.get("content").and_then(Value::as_str) else {
        return Ok(read(&path));
    };
    if content.len() > FILE_MAX {
        return fail(format!("{file} is at most {FILE_MAX} bytes."));
    }
    let expected = request.get("expectedMtimeMs").and_then(Value::as_f64);
    let force = request
        .get("force")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !force
        && let Some(expected) = expected
        && path.exists()
        && (mtime_ms(&path) - expected).abs() > 1.0
    {
        let mut now = read(&path);
        now["changed"] = json!(true);
        return Ok(now);
    }
    write(&path, content.as_bytes())?;
    Ok(read(&path))
}

/// The bots of other apps on this computer an import can bring over (Orca's `bot-import-sources.ts`): OpenClaw's
/// agents, Hermes' profiles and OpenBot's agents, each `{app, name, folder}`. `env` reads an environment variable.
pub fn import_sources(home: &Path, env: &dyn Fn(&str) -> Option<String>) -> Vec<Value> {
    let mut sources: Vec<Value> = Vec::new();
    let dirs = |dir: &Path| -> Vec<PathBuf> {
        let mut found: Vec<PathBuf> = std::fs::read_dir(dir)
            .map(|entries| {
                entries
                    .flatten()
                    .map(|entry| entry.path())
                    .filter(|path| path.is_dir())
                    .collect()
            })
            .unwrap_or_default();
        found.sort();
        found
    };
    let base_name = |path: &Path| {
        path.file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default()
    };
    // OpenClaw: its state folder's agents, each working in `workspace-<id>` or `workspace/<id>` (`main` in `workspace`).
    let claw_root = env("OPENCLAW_STATE_DIR")
        .map(PathBuf::from)
        .into_iter()
        .chain(
            [".openclaw", ".clawdbot", ".moltbot"]
                .iter()
                .map(|name| home.join(name)),
        )
        .find(|path| path.is_dir());
    if let Some(root) = claw_root {
        let mut agents: Vec<String> = dirs(&root.join("agents"))
            .iter()
            .map(|path| base_name(path))
            .collect();
        if agents.is_empty() && root.join("workspace").is_dir() {
            agents.push("main".to_owned());
        }
        for agent in agents {
            let workspace = [
                root.join(format!("workspace-{agent}")),
                root.join("workspace").join(&agent),
                root.join("workspace"),
            ]
            .into_iter()
            .find(|path| path.is_dir() && (agent == "main" || !path.ends_with("workspace")))
            .unwrap_or_else(|| root.join("agents").join(&agent));
            let name = std::fs::read_to_string(workspace.join("IDENTITY.md"))
                .ok()
                .and_then(|text| {
                    text.lines().find_map(|line| {
                        let line = line.trim().trim_start_matches(['-', '*', ' ']);
                        line.strip_prefix("Name:")
                            .or_else(|| line.strip_prefix("**Name:**"))
                            .map(|name| name.trim().trim_matches('*').trim().to_owned())
                    })
                })
                .filter(|name| !name.is_empty())
                .unwrap_or(agent);
            sources.push(
                json!({ "app": "openclaw", "name": name, "folder": workspace.to_string_lossy() }),
            );
        }
    }
    // Hermes: its home (a profile path names its home), which is a profile itself with a SOUL.md or config.yaml.
    let hermes = env("HERMES_HOME")
        .map(|home| {
            let path = PathBuf::from(&home);
            match path.parent() {
                Some(parent) if parent.ends_with("profiles") => {
                    parent.parent().map(Path::to_path_buf).unwrap_or(path)
                }
                _ => path,
            }
        })
        .unwrap_or_else(|| home.join(".hermes"));
    if hermes.join("SOUL.md").is_file() || hermes.join("config.yaml").is_file() {
        sources
            .push(json!({ "app": "hermes", "name": "Hermes", "folder": hermes.to_string_lossy() }));
    }
    for profile in dirs(&hermes.join("profiles")) {
        sources.push(json!({ "app": "hermes", "name": base_name(&profile), "folder": profile.to_string_lossy() }));
    }
    // OpenBot: its agents' folders.
    for agent in dirs(&home.join("OpenBot").join("Agents")) {
        sources.push(json!({ "app": "openbot", "name": base_name(&agent), "folder": agent.to_string_lossy() }));
    }
    sources.truncate(SOURCES_MAX);
    sources
}

/// This computer's home folder.
pub fn home_folder() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn scratch() -> Scratch {
        Scratch(crate::fs::disk::make_temp_dir("ompdesk-bot-files-").unwrap())
    }

    #[test]
    fn a_rename_keeps_custom_titles_body_bytes_and_link_targets() {
        let scratch = scratch();
        let dir = &scratch.0;
        let path = dir.join("SOUL.md");
        for (before, after) in [
            (
                &b"# Ada\r\n# Ada\r\n\xff"[..],
                &b"# Bea\r\n# Ada\r\n\xff"[..],
            ),
            (b"# Ada's notes\n# Ada", b"# Ada's notes\n# Ada"),
            (b"Notes\n# Ada", b"Notes\n# Ada"),
            (b"# Ada", b"# Bea"),
        ] {
            std::fs::write(&path, before).unwrap();
            rename_soul_title(dir, "Ada", "Bea").unwrap();
            assert_eq!(std::fs::read(&path).unwrap(), after);
        }
        #[cfg(unix)]
        {
            let external = dir.join("external.md");
            std::fs::write(&external, b"# Ada").unwrap();
            std::fs::remove_file(&path).unwrap();
            std::os::unix::fs::symlink(&external, &path).unwrap();
            rename_soul_title(dir, "Ada", "Bea").unwrap();
            assert!(path.is_symlink());
            assert_eq!(std::fs::read(&external).unwrap(), b"# Ada");
        }
    }

    #[test]
    fn a_purpose_seeds_the_soul_and_skills_land_once() {
        let dir = scratch();
        let skills = vec![json!({ "name": "pr-review", "content": "# Review\nRead the diff." })];
        seed(&dir.0, "Ada", Some("Reviews pull requests."), None, &skills).unwrap();
        let soul = std::fs::read_to_string(dir.0.join("SOUL.md")).unwrap();
        assert_eq!(soul, "# Ada\n\nReviews pull requests.\n");
        assert_eq!(
            crate::agentctl::journal::bots::specialty(&dir.0).as_deref(),
            Some("Reviews pull requests.")
        );
        let skill = dir.0.join(".omp/skills/pr-review/SKILL.md");
        assert!(skill.is_file());
        // A second seed keeps what is there.
        seed(&dir.0, "Ada", Some("Something else."), None, &[]).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.0.join("SOUL.md")).unwrap(),
            soul
        );
        assert!(
            seed(
                &dir.0,
                "Ada",
                None,
                None,
                &[json!({ "name": "../x", "content": "x" })]
            )
            .is_err()
        );
        assert!(seed(&dir.0, "Ada", Some(&"x".repeat(PURPOSE_MAX + 1)), None, &[]).is_err());
    }

    #[test]
    fn only_the_bots_own_files_are_reached_and_a_changed_file_is_kept() {
        let dir = scratch();
        for bad in [
            "../x.md",
            "notes.md",
            "memory/../SOUL.md",
            "memory/a/b.md",
            "/etc/passwd",
            "memory/x.txt",
        ] {
            assert!(
                file_request(&dir.0, &json!({ "file": bad })).is_err(),
                "{bad}"
            );
        }
        let read = file_request(&dir.0, &json!({ "file": "MEMORY.md" })).unwrap();
        assert_eq!(read["exists"], json!(false));
        let saved = file_request(
            &dir.0,
            &json!({ "file": "MEMORY.md", "content": "- one\n" }),
        )
        .unwrap();
        assert_eq!(saved["content"], json!("- one\n"));
        let stale = file_request(
            &dir.0,
            &json!({ "file": "MEMORY.md", "content": "- mine\n", "expectedMtimeMs": 1.0 }),
        )
        .unwrap();
        assert_eq!(stale["changed"], json!(true));
        assert_eq!(
            std::fs::read_to_string(dir.0.join("MEMORY.md")).unwrap(),
            "- one\n"
        );
        file_request(
            &dir.0,
            &json!({ "file": "memory/history/2026-11-26-0300.md", "content": "- old\n" }),
        )
        .unwrap();
        let listed = file_request(&dir.0, &json!({ "file": "MEMORY.md" })).unwrap();
        assert_eq!(listed["history"], json!(["2026-11-26-0300.md"]));
    }

    #[test]
    fn other_apps_bots_are_found_in_their_folders() {
        let home = scratch();
        std::fs::create_dir_all(home.0.join(".openclaw/agents/ops")).unwrap();
        std::fs::create_dir_all(home.0.join(".openclaw/workspace-ops")).unwrap();
        std::fs::write(
            home.0.join(".openclaw/workspace-ops/IDENTITY.md"),
            "- **Name:** Clawd\n",
        )
        .unwrap();
        std::fs::create_dir_all(home.0.join(".hermes/profiles/work")).unwrap();
        std::fs::write(home.0.join(".hermes/SOUL.md"), "x").unwrap();
        std::fs::create_dir_all(home.0.join("OpenBot/Agents/Helper")).unwrap();
        let found = import_sources(&home.0, &|_| None);
        let names: Vec<(&str, &str)> = found
            .iter()
            .map(|source| {
                (
                    source["app"].as_str().unwrap(),
                    source["name"].as_str().unwrap(),
                )
            })
            .collect();
        assert_eq!(
            names,
            vec![
                ("openclaw", "Clawd"),
                ("hermes", "Hermes"),
                ("hermes", "work"),
                ("openbot", "Helper")
            ]
        );
    }
}
