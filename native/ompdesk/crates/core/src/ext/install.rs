//! Read the launcher that was actually found. No manager or launcher is executed here.

use std::borrow::Cow;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
#[cfg(test)]
use serde_json::Value;

use super::binary::{self, Platform, VenvOwner};
use super::is_line_end;
use crate::control::js::is_absolute_win32;
use crate::fs::disk;
use crate::tailscale::version_in;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Context {
    platform: Platform,
    tools_dir: String,
    brew: Option<String>,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Managed {
    Gh,
    Node,
    AgentDesktop,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Spec {
    managed: Option<Managed>,
    managed_only: bool,
    winget: Option<String>,
    #[serde(rename = "self")]
    self_update: bool,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Source {
    Cli { spec: Spec },
    GhExtension,
    Mcp { command: String },
    Omp,
    Bundle,
}

#[derive(Deserialize)]
pub(super) struct Params {
    path: String,
    /// Node resolves relative and drive-relative launchers in the caller's current directory.
    file: String,
    cwd: String,
    #[cfg(windows)]
    #[serde(default)]
    drives: std::collections::HashMap<String, String>,
    ctx: Context,
    source: Source,
}

impl Params {
    fn at(&self, path: &str) -> std::path::PathBuf {
        #[cfg(windows)]
        if let Some(base) = path.get(..2).and_then(|drive| self.drives.get(drive))
            && !is_absolute_win32(path)
        {
            return Path::new(base).join(&path[2..]);
        }
        Path::new(&self.cwd).join(path)
    }
}

#[derive(Serialize)]
#[cfg_attr(test, derive(Deserialize))]
#[serde(tag = "method", rename_all = "kebab-case")]
enum Owner {
    Brew {
        name: String,
        brew: String,
    },
    BrewCask {
        name: String,
        brew: String,
    },
    Bun {
        name: String,
        #[serde(rename = "bunRoot")]
        bun_root: String,
        root: String,
    },
    Npm {
        name: String,
        prefix: String,
        root: String,
    },
    Winget {
        id: String,
    },
    Managed {
        item: Managed,
    },
    #[serde(rename = "self")]
    SelfUpdate,
}

#[derive(Serialize)]
#[serde(untagged)]
enum InstallOwner {
    Tool(Owner),
    Venv(VenvOwner),
}

#[derive(Serialize)]
pub(super) struct Facts {
    launcher: String,
    real: String,
    owner: Option<InstallOwner>,
    skip: Option<&'static str>,
    writable: bool,
    installed: Option<String>,
    mcp: Option<binary::Facts>,
}

fn slash(path: &str) -> Cow<'_, str> {
    if path.contains('\\') {
        path.replace('\\', "/").into()
    } else {
        path.into()
    }
}

fn named<'a>(path: &'a str, marker: &str) -> Option<(&'a str, &'a str)> {
    path.match_indices(marker).find_map(|(at, _)| {
        let (name, rest) = path[at + marker.len()..].split_once('/')?;
        (!name.is_empty()).then_some((name, rest))
    })
}

/// `^(.*)<marker>((?:@[^/]+/)?[^/]+)/` takes the last matching layout. Its dot never crosses a JS newline.
fn package<'a>(path: &'a str, marker: &str) -> Option<(&'a str, &'a str, &'a str)> {
    let line = path.find(is_line_end).unwrap_or(path.len());
    path.rmatch_indices('/')
        .filter(|(at, _)| *at <= line)
        .find_map(|(at, _)| {
            let tail = path[at..].strip_prefix(marker)?;
            let (first, rest) = tail.split_once('/')?;
            if first.is_empty() {
                return None;
            }
            let name = if first.starts_with('@') && first.len() > 1 {
                rest.split_once('/')
                    .filter(|(part, _)| !part.is_empty())
                    .map_or(first, |(part, _)| &tail[..first.len() + 1 + part.len()])
            } else {
                first
            };
            Some((&path[..at], name, &path[..at + marker.len() + name.len()]))
        })
}

fn classify(real: &str, ctx: &Context, spec: &Spec) -> Result<Owner, &'static str> {
    const UNKNOWN: &str = "unknown-install";
    let win = ctx.platform == Platform::Win32;
    let p = slash(real);
    let tools = slash(&ctx.tools_dir);
    let tools = tools.trim_end_matches('/');
    let under = |p: &str, tools: &str| {
        p.strip_prefix(tools)
            .is_some_and(|tail| tail.starts_with('/'))
    };
    let managed_dir = if !win {
        under(&p, tools)
    } else if p.is_ascii() && tools.is_ascii() {
        p.as_bytes().get(tools.len()) == Some(&b'/') && p[..tools.len()].eq_ignore_ascii_case(tools)
    } else {
        under(&p.to_lowercase(), &tools.to_lowercase())
    };
    if managed_dir {
        return spec
            .managed
            .map(|item| Owner::Managed { item })
            .ok_or(UNKNOWN);
    }
    if spec.managed_only {
        return Err(UNKNOWN);
    }
    let marker = |needle: &str| {
        p.as_bytes()
            .windows(needle.len())
            .any(|s| s.eq_ignore_ascii_case(needle.as_bytes()))
    };
    if if win {
        p.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
            && p.as_bytes()
                .get(1..11)
                .is_some_and(|s| s.eq_ignore_ascii_case(b":/windows/"))
    } else {
        [
            "/usr/bin/",
            "/bin/",
            "/usr/sbin/",
            "/sbin/",
            "/usr/libexec/",
            "/System/",
            "/Library/Developer/CommandLineTools/",
            "/Applications/Xcode",
        ]
        .iter()
        .any(|dir| p.starts_with(dir))
    } {
        return Err("system");
    }
    if !win {
        for (key, cask) in [("/Cellar/", false), ("/Caskroom/", true)] {
            if let Some((name, _)) = named(&p, key) {
                let brew = ctx
                    .brew
                    .as_ref()
                    .filter(|b| !b.is_empty())
                    .ok_or(UNKNOWN)?
                    .clone();
                let name = name.to_owned();
                return Ok(if cask {
                    Owner::BrewCask { name, brew }
                } else {
                    Owner::Brew { name, brew }
                });
            }
        }
    }
    if if win {
        marker("/WindowsApps/")
    } else {
        p.contains(".app/Contents/")
    } {
        return Err("bundled");
    }
    let native = |s: &str| {
        if win {
            s.replace('/', "\\")
        } else {
            s.to_owned()
        }
    };
    for (key, bun) in [
        ("/install/global/node_modules/", true),
        (
            if win {
                "/node_modules/"
            } else {
                "/lib/node_modules/"
            },
            false,
        ),
    ] {
        if let Some((prefix, name, root)) = package(&p, key) {
            if spec.self_update {
                return Ok(Owner::SelfUpdate);
            }
            if prefix.is_empty() {
                continue;
            }
            let prefix = native(prefix);
            let name = name.to_owned();
            let root = native(root);
            return Ok(if bun {
                Owner::Bun {
                    name,
                    bun_root: prefix,
                    root,
                }
            } else {
                Owner::Npm { name, prefix, root }
            });
        }
    }
    if win
        && let Some(id) = spec.winget.as_ref().filter(|id| !id.is_empty())
        && ["/WinGet/Packages/", "/WinGet/Links/", "/GitHub CLI/"]
            .iter()
            .any(|s| marker(s))
    {
        return Ok(Owner::Winget { id: id.clone() });
    }
    if spec.self_update {
        Ok(Owner::SelfUpdate)
    } else {
        Err(UNKNOWN)
    }
}

fn sep(c: char, win: bool) -> bool {
    c == '/' || (win && c == '\\')
}

/// Length of the volume root, including a UNC share and its first trailing separator.
fn root_end(path: &str, win: bool) -> usize {
    let b = path.as_bytes();
    let s = |i: usize| b.get(i).is_some_and(|&c| sep(char::from(c), win));
    if win && b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        return 2 + usize::from(s(2));
    }
    if !s(0) {
        return 0;
    }
    if win && s(1) && b.len() > 2 && !s(2) {
        let mut i = 2;
        while i < b.len() && !s(i) {
            i += 1;
        }
        while s(i) {
            i += 1;
        }
        if i < b.len() {
            while i < b.len() && !s(i) {
                i += 1;
            }
            return i + usize::from(s(i));
        }
    }
    1
}

fn dirname(path: &str, win: bool) -> &str {
    let root = root_end(path, win);
    let tail = path[root..].trim_end_matches(|c| sep(c, win));
    match tail.rfind(|c| sep(c, win)) {
        Some(0) if !win && root == 1 => &path[..2],
        Some(i) => &path[..root + i],
        None if root != 0 => &path[..root],
        None => ".",
    }
}

fn writable_target<'a>(owner: &'a Owner, real: &'a str, ctx: &'a Context) -> &'a str {
    match owner {
        Owner::Brew { brew, .. } | Owner::BrewCask { brew, .. } => {
            dirname(dirname(brew, cfg!(windows)), cfg!(windows))
        }
        Owner::Npm { root, .. } | Owner::Bun { root, .. } => dirname(root, cfg!(windows)),
        Owner::Managed { .. } => &ctx.tools_dir,
        Owner::SelfUpdate | Owner::Winget { .. } => dirname(real, cfg!(windows)),
    }
}

/// Node joins (rather than resolves) a shim target, normalizing dot segments without following links.
fn shim_join(dir: &str, target: &str) -> String {
    let mut path = String::with_capacity(dir.len() + 1 + target.len());
    path.extend(dir.chars().map(|c| if c == '/' { '\\' } else { c }));
    path.push('\\');
    path.extend(target.chars().map(|c| if c == '/' { '\\' } else { c }));
    let unc = dir.as_bytes().get(..3).is_some_and(|s| {
        s[..2].iter().all(|&c| matches!(c, b'/' | b'\\')) && !matches!(s[2], b'/' | b'\\')
    });
    if !unc && path.starts_with("\\\\") {
        let extra = path.len() - path.trim_start_matches('\\').len() - 1;
        path.drain(..extra);
    }
    let root = root_end(&path, true);
    let absolute = is_absolute_win32(&path);
    let mut output = String::with_capacity(path.len() + 1);
    output.push_str(&path[..root]);
    if output.starts_with("\\\\") && !output.ends_with('\\') {
        output.push('\\');
    }
    let base = output.len();
    for part in path[root..]
        .split('\\')
        .filter(|s| !s.is_empty() && *s != ".")
    {
        if part == ".." {
            let tail = &output[base..];
            if !tail.is_empty() && tail.rsplit('\\').next() != Some("..") {
                output.truncate(base + tail.rfind('\\').unwrap_or(0));
                continue;
            }
            if absolute {
                continue;
            }
        }
        if output.len() != base {
            output.push('\\');
        }
        output.push_str(part);
    }
    if output.len() == base && !absolute {
        output.push('.');
    }
    if path.ends_with('\\') && !output.ends_with('\\') {
        output.push('\\');
    }
    output
}

fn cmd_target(shim: &str, mut text: &str) -> Option<String> {
    let mut last = None;
    while let Some((_, tail)) = text.split_once('"') {
        text = tail;
        let Some(after) = ["%dp0%\\", "%~dp0%\\", "%dp0\\", "%~dp0\\"]
            .iter()
            .find_map(|prefix| tail.strip_prefix(prefix))
        else {
            continue;
        };
        let Some((target, rest)) = after.split_once('"') else {
            break;
        };
        if !target.is_empty() {
            last = Some(target);
            text = rest;
        }
    }
    last.map(|s| shim_join(dirname(shim, true), s))
}

fn bun_target(exe: &str, bytes: &[u8]) -> Option<String> {
    let end = bytes.chunks_exact(2).position(|u| u == [b'"', 0])?;
    let units = bytes[..end * 2]
        .chunks_exact(2)
        .map(|u| u16::from_le_bytes([u[0], u[1]]));
    let target: String = char::decode_utf16(units)
        .map(|c| c.unwrap_or(char::REPLACEMENT_CHARACTER))
        .collect();
    (!target.is_empty() && !is_absolute_win32(&target) && !target.contains('\0'))
        .then(|| shim_join(dirname(dirname(exe, true), true), &target))
}

fn shim_target(real: &str, bun: bool) -> Option<String> {
    if super::mcp::strip_suffix_ignore_case(real, ".cmd").is_some() {
        return cmd_target(real, &String::from_utf8_lossy(&fs::read(real).ok()?));
    }
    if bun && let Some(stem) = super::mcp::strip_suffix_ignore_case(real, ".exe") {
        return bun_target(real, &fs::read(format!("{stem}.bunx")).ok()?);
    }
    None
}

fn may_write(path: &Path) -> bool {
    #[cfg(unix)]
    {
        crate::sys::may_write(path)
    }
    // libuv's W_OK checks the read-only attribute, which it ignores on directories.
    #[cfg(windows)]
    {
        fs::metadata(path).is_ok_and(|m| m.is_dir() || !m.permissions().readonly())
    }
}

fn package_version(root: &Path) -> Option<String> {
    let file = crate::git::read::resolve(&root.to_string_lossy(), "package.json");
    let bytes = fs::read(file).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    manifest_version(&crate::json::whole_surrogates(&text))
}

fn manifest_version(text: &str) -> Option<String> {
    use serde::de::{Deserializer, IgnoredAny, MapAccess, Visitor};
    use serde_json::value::RawValue;

    #[derive(Deserialize)]
    #[serde(field_identifier, rename_all = "lowercase")]
    enum Key {
        Version,
        #[serde(other)]
        Other,
    }

    // JSON.parse keeps the last duplicate key. Unrelated values need neither allocation nor a nesting limit.
    struct Version;
    impl<'de> Visitor<'de> for Version {
        type Value = Option<String>;
        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("a package manifest")
        }
        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
            let mut raw = None;
            while let Some(key) = map.next_key::<Key>()? {
                match key {
                    Key::Version => raw = Some(map.next_value::<&RawValue>()?),
                    Key::Other => {
                        map.next_value::<IgnoredAny>()?;
                    }
                }
            }
            Ok(raw
                .and_then(|s| serde_json::from_str::<String>(s.get()).ok())
                .and_then(|s| version_in(&s).map(str::to_owned)))
        }
    }
    let mut parser = serde_json::Deserializer::from_str(text);
    let version = (&mut parser).deserialize_map(Version).ok()?;
    parser.end().ok()?;
    version
}

fn brew_version(real: &str) -> Option<String> {
    let p = slash(real);
    p.match_indices('/')
        .find_map(|(at, _)| {
            let tail = p[at..]
                .strip_prefix("/Cellar/")
                .or_else(|| p[at..].strip_prefix("/Caskroom/"))?;
            let (name, tail) = tail.split_once('/')?;
            let (version, _) = tail.split_once('/')?;
            (!name.is_empty() && !version.is_empty()).then_some(version)
        })
        .and_then(version_in)
        .map(str::to_owned)
}

/// Node's realpathSync keeps the caller's spelling of ordinary components on a case-insensitive volume.
/// Canonicalizing the entire path would turn e.g. `NODE_MODULES` into a package claim Node refused.
fn launcher_path(file: &str) -> Option<String> {
    use std::path::{Component, PathBuf};

    let mut path = file.to_owned();
    let mut previous = std::collections::HashSet::new();
    loop {
        let mut base = PathBuf::new();
        let mut parts = Path::new(&path).components();
        let mut resolved = None;
        while let Some(part) = parts.next() {
            base.push(part);
            if matches!(part, Component::Prefix(_)) && !parts.as_path().as_os_str().is_empty() {
                continue;
            }
            let stat = fs::symlink_metadata(&base).ok()?;
            if !stat.file_type().is_symlink() {
                continue;
            }
            fs::metadata(&base).ok()?;
            let target = fs::read_link(&base).ok()?;
            let target = if cfg!(windows) {
                base.parent()?.join(disk::spelled(&target))
            } else {
                base.parent()?.join(target.to_string_lossy().as_ref())
            };
            let tail = parts.as_path();
            resolved = Some(crate::git::read::resolve(
                &target.to_string_lossy(),
                tail.to_str()?,
            ));
            break;
        }
        match resolved {
            Some(next) => {
                if !previous.insert(std::mem::replace(&mut path, next)) {
                    return None;
                }
            }
            None => return Some(path),
        }
    }
}

pub(super) fn facts(p: &Params) -> Facts {
    if matches!(p.source, Source::Bundle) {
        // Setup creates the managed folder under its first existing parent.
        let mut dir = p.ctx.tools_dir.as_str();
        while !p.at(dir).exists() {
            let parent = dirname(dir, cfg!(windows));
            if parent == dir {
                break;
            }
            dir = parent;
        }
        return Facts {
            launcher: p.path.clone(),
            real: p.path.clone(),
            owner: Some(InstallOwner::Tool(Owner::Managed {
                item: Managed::AgentDesktop,
            })),
            skip: None,
            writable: may_write(&p.at(dir)),
            installed: None,
            mcp: None,
        };
    }
    let found = launcher_path(&p.file);
    let follows_shims = found.is_some() && p.ctx.platform == Platform::Win32;
    let launcher = found.unwrap_or_else(|| p.path.clone());
    let bun = matches!(p.source, Source::Cli { .. } | Source::GhExtension);
    let real = if follows_shims {
        shim_target(&launcher, bun)
    } else {
        None
    }
    .unwrap_or_else(|| launcher.clone());
    let mut mcp = match &p.source {
        Source::Mcp { command } => Some(binary::facts(&real, command, p.ctx.platform, |s| p.at(s))),
        _ => None,
    };
    if let Some(evidence) = &mut mcp
        && let Some(owner) = evidence.owner.take()
    {
        let dir = match &owner {
            VenvOwner::Pipx { venv, .. } => venv,
            VenvOwner::Uv { dir, .. } => dir,
        };
        let writable = may_write(&p.at(dir));
        return Facts {
            launcher,
            real,
            owner: Some(InstallOwner::Venv(owner)),
            skip: None,
            writable,
            installed: evidence.installed.take(),
            mcp,
        };
    }
    let neutral = Spec::default();
    let spec = match &p.source {
        Source::Cli { spec } => spec,
        _ => &neutral,
    };
    let classified = if matches!(p.source, Source::GhExtension) {
        Ok(Owner::SelfUpdate)
    } else {
        classify(&real, &p.ctx, spec)
    };
    let (owner, skip) = match classified {
        Ok(o) => (Some(o), None),
        Err(s) => (None, Some(s)),
    };
    let needs_evidence = !matches!(p.source, Source::GhExtension | Source::Omp);
    let writable = !needs_evidence
        || owner.as_ref().is_some_and(|o| {
            let dir = writable_target(o, &real, &p.ctx);
            !dir.is_empty() && may_write(&p.at(dir))
        });
    let installed = match &owner {
        Some(Owner::Bun { root, .. } | Owner::Npm { root, .. }) if needs_evidence => {
            package_version(&p.at(root))
        }
        Some(Owner::Brew { .. } | Owner::BrewCask { .. }) if mcp.is_some() => brew_version(&real),
        _ => None,
    };
    let owner = owner.map(InstallOwner::Tool);
    Facts {
        launcher,
        real,
        owner,
        skip,
        writable,
        installed,
        mcp,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[cfg(windows)]
    #[test]
    fn reads_drive_relative_evidence_in_nodes_directory_for_that_drive() {
        let p: Params = serde_json::from_value(json!({
            "path": "D:bin\\x.cmd", "file": "D:\\node\\bin\\x.cmd", "cwd": "C:\\node",
            "ctx": {"platform": "win32", "toolsDir": "D:tools", "brew": null}, "source": {"kind": "omp"},
            "drives": { "D:": "D:\\node" }
        })).unwrap();
        assert_eq!(p.at("D:tools"), Path::new(r"D:\node\tools"));
        assert_eq!(p.at(r"\bin"), Path::new(r"C:\bin"));
        assert_eq!(p.at(r"D:\tools"), Path::new(r"D:\tools"));
    }

    #[test]
    fn reads_the_layouts_and_shim_targets_captured_from_typescript() {
        let data: Value = serde_json::from_str(include_str!("install-captured.json")).unwrap();
        let rows = |key: &str| data[key].as_array().unwrap();
        for row in rows("classify") {
            let ctx = serde_json::from_value(row[1].clone()).unwrap();
            let spec = serde_json::from_value(row[2].clone()).unwrap();
            let result = match classify(row[0].as_str().unwrap(), &ctx, &spec) {
                Ok(owner) => json!({"owner":owner,"skip":null}),
                Err(skip) => json!({"owner":null,"skip":skip}),
            };
            assert_eq!(result, row[3], "{row}");
        }
        for row in rows("cmd") {
            let result = cmd_target(row[0].as_str().unwrap(), row[1].as_str().unwrap());
            assert_eq!(result.as_deref(), row[2].as_str(), "{row}");
        }
        for row in rows("bun") {
            let bytes: Vec<_> = format!("{}\"", row[1].as_str().unwrap())
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect();
            assert_eq!(
                bun_target(row[0].as_str().unwrap(), &bytes).as_deref(),
                row[2].as_str(),
                "{row}"
            );
        }
        assert!(bun_target("D:\\bin\\x.exe", b"MZ\x90\x00").is_none());
        for (text, expected) in [
            (
                r#"{"version":"1.0.0","version":"build 02.3.4-rc"}"#,
                Some("02.3.4"),
            ),
            (r#"{"version":"1.2.3","version":5}"#, None),
            (r#"{"version":"v1.2"}"#, None),
            (r#"{"version":"1.2.3"} broken"#, None),
            (r#"[{"version":"1.2.3"}]"#, None),
        ] {
            assert_eq!(manifest_version(text).as_deref(), expected, "{text}");
        }
        let ctx = Context {
            platform: Platform::Darwin,
            tools_dir: "/tools".into(),
            brew: None,
        };
        for row in rows("target") {
            let owner = serde_json::from_value(row[1].clone()).unwrap();
            assert_eq!(
                writable_target(&owner, row[0].as_str().unwrap(), &ctx),
                row[2].as_str().unwrap()
            );
        }
    }
}
