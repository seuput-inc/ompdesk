//! `fs.list` (the Files panel's tree and the `@` list) and `fs.listDirs` (a paired device's folder picker).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize, Serializer};
use serde_json::Value;

use super::disk::{self, Kind};
use super::error::{Codes, IO};
use super::ignore::Scopes;
use super::order::{NameOrder, js_trim};
use crate::server::{Fault, Reply};

const LIST_DEFAULT_DEPTH: f64 = 8.0;
const LIST_MAX_DEPTH: f64 = 16.0;
/// The folder picker's bound: one level, so a huge folder cannot flood the link; its name filter reaches past it.
const LIST_DIRS_MAX_ENTRIES: usize = 2000;

/// Files one listing returns: `default` without a `maxEntries`, never more than `max`.
#[derive(Deserialize)]
pub struct FileCaps {
    default: f64,
    max: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListParams {
    /// The workspace root (its `.gitignore` applies).
    root: String,
    /// The folder to walk, `root` joined with `prefix`, resolved and confined by main.
    dir: String,
    /// `dir` relative to `root`, `/`-separated, without leading or trailing `/`.
    prefix: String,
    max_depth: Option<Value>,
    max_entries: Option<Value>,
    #[serde(default)]
    hide_dotfiles: bool,
    #[serde(default)]
    show_ignored: bool,
    caps: FileCaps,
    locale: String,
}

struct Node {
    name: String,
    path: String,
    dir: bool,
    children: Vec<usize>,
}

/// The tree as `FsTreeEntry[]`, serialized from the walk's arena without copying it.
struct Tree<'a> {
    nodes: &'a [Node],
    ids: &'a [usize],
}

impl Serialize for Tree<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_seq(self.ids.iter().map(|&id| TreeEntry {
            nodes: self.nodes,
            node: &self.nodes[id],
        }))
    }
}

struct TreeEntry<'a> {
    nodes: &'a [Node],
    node: &'a Node,
}

impl Serialize for TreeEntry<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let node = self.node;
        let mut map = serializer.serialize_map(Some(if node.dir { 4 } else { 3 }))?;
        map.serialize_entry("name", &node.name)?;
        map.serialize_entry("path", &node.path)?;
        map.serialize_entry("kind", if node.dir { "dir" } else { "file" })?;
        if node.dir {
            map.serialize_entry(
                "children",
                &Tree {
                    nodes: self.nodes,
                    ids: &node.children,
                },
            )?;
        }
        map.end()
    }
}

#[derive(Serialize)]
struct Listing<'a> {
    entries: Tree<'a>,
    truncated: bool,
}

/// The workspace tree under `dir`: gitignore-aware, depth- and file-capped.
pub fn list(params: &ListParams) -> Result<Reply, Fault> {
    let max_depth = super::clamp_int(
        params.max_depth.as_ref(),
        1.0,
        LIST_MAX_DEPTH,
        LIST_DEFAULT_DEPTH,
    ) as usize;
    let max_files = super::clamp_int(
        params.max_entries.as_ref(),
        1.0,
        params.caps.max,
        params.caps.default,
    ) as usize;
    let stat = disk::stat(&params.dir).map_err(|error| error.fault(Codes::None))?;
    if !stat.is_dir() {
        return Err(Fault::new("not_a_directory", "Not a directory"));
    }
    let order = NameOrder::new(&params.locale);
    let mut walk = Walk {
        nodes: Vec::new(),
        max_files,
        hide_dotfiles: params.hide_dotfiles,
        file_count: 0,
        truncated: false,
    };
    let top = walk.run(params, max_depth, &order);
    Reply::json(&Listing {
        entries: Tree {
            nodes: &walk.nodes,
            ids: &top,
        },
        truncated: walk.truncated,
    })
}

struct Walk {
    nodes: Vec<Node>,
    max_files: usize,
    hide_dotfiles: bool,
    file_count: usize,
    truncated: bool,
}

/// A folder the next level reads, and where its children go (`None`: the top).
struct Pending {
    abs: PathBuf,
    rel: String,
    parent: Option<usize>,
    scope: usize,
}

impl Walk {
    /// Breadth-first: folders first, then files, each in name order. Level by level, so when the file cap stops the
    /// walk it is the deepest files that are missing, never every file of a folder that merely sorts late; every
    /// folder seen is in the tree, with the children the walk got to.
    fn run(&mut self, params: &ListParams, max_depth: usize, order: &NameOrder) -> Vec<usize> {
        let mut top = Vec::new();
        let mut scopes = Scopes::new();
        let mut scope = 0;
        let mut dir = PathBuf::from(&params.root);
        let mut prefix = String::with_capacity(params.prefix.len());
        for part in params.prefix.split('/').filter(|part| !part.is_empty()) {
            if std::path::Path::new(part).file_name() != Some(part.as_ref()) {
                return top;
            }
            if !params.show_ignored {
                scope = scopes.enter(scope, &dir, &prefix);
            }
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(part);
            dir.push(part);
            if (self.hide_dotfiles && part.starts_with('.'))
                || scopes.ignored(scope, &prefix, true)
                || !std::fs::symlink_metadata(&dir)
                    .is_ok_and(|meta| meta.is_dir() && !disk::linked(&meta))
            {
                return top;
            }
        }
        let mut level = vec![Pending {
            abs: dir,
            rel: prefix,
            parent: None,
            scope,
        }];
        let mut depth = 0;
        while !level.is_empty() && !self.truncated {
            let mut next = Vec::new();
            for folder in level {
                if self.truncated {
                    break;
                }
                // An unreadable folder (permissions) is skipped; the walk goes on.
                let Ok(mut entries) = disk::entries(&folder.abs) else {
                    continue;
                };
                entries.retain(|entry| entry.kind != Kind::Link);
                let scope = if !params.show_ignored
                    && entries
                        .iter()
                        .any(|e| e.kind == Kind::File && e.name == ".gitignore")
                {
                    scopes.enter(folder.scope, &folder.abs, &folder.rel)
                } else {
                    folder.scope
                };
                entries.sort_by(|a, b| order.compare(&a.name, &b.name));
                let mut files = Vec::new();
                for entry in entries {
                    if self.hide_dotfiles && entry.name.starts_with('.') {
                        continue;
                    }
                    let is_dir = match entry.kind {
                        Kind::Dir => true,
                        Kind::File => false,
                        _ => continue,
                    };
                    let rel = if folder.rel.is_empty() {
                        entry.name.clone()
                    } else {
                        format!("{}/{}", folder.rel, entry.name)
                    };
                    if scopes.ignored(scope, &rel, is_dir) {
                        continue;
                    }
                    if is_dir {
                        let id = self.push(entry.name, rel.clone(), true);
                        self.attach(folder.parent, &mut top, id);
                        if depth < max_depth {
                            next.push(Pending {
                                abs: folder.abs.join(&entry.raw),
                                rel,
                                parent: Some(id),
                                scope,
                            });
                        }
                    } else if self.file_count >= self.max_files {
                        self.truncated = true;
                        break;
                    } else {
                        self.file_count += 1;
                        files.push(self.push(entry.name, rel, false));
                    }
                }
                for id in files {
                    self.attach(folder.parent, &mut top, id);
                }
            }
            level = next;
            depth += 1;
        }
        top
    }

    fn push(&mut self, name: String, path: String, dir: bool) -> usize {
        self.nodes.push(Node {
            name,
            path,
            dir,
            children: Vec::new(),
        });
        self.nodes.len() - 1
    }

    fn attach(&mut self, parent: Option<usize>, top: &mut Vec<usize>, id: usize) {
        match parent {
            Some(parent) => self.nodes[parent].children.push(id),
            None => top.push(id),
        }
    }
}

#[derive(Deserialize)]
pub struct ListDirsParams {
    /// The absolute folder, resolved by main.
    dir: String,
    query: Option<Value>,
    locale: String,
    web: Option<WebPicker>,
}

#[derive(Deserialize)]
struct WebPicker {
    files: bool,
    limit: usize,
    #[serde(rename = "packageCaller")]
    package_caller: Option<String>,
}

#[derive(Serialize)]
struct DirNames {
    names: Vec<String>,
    truncated: bool,
}

#[derive(Serialize)]
struct WebEntry {
    name: String,
    // Folders have no byte size in WebHostEntry.
    size: Option<u64>,
    #[serde(rename = "selectionId", skip_serializing_if = "Option::is_none")]
    selection_id: Option<String>,
}

#[derive(Serialize)]
struct WebEntries {
    entries: Vec<WebEntry>,
    truncated: bool,
}

/// One directory level. The computer picker lists real folders; the web picker also follows links
/// and can list files with their sizes. Both filter and sort before applying their limit.
pub fn list_dirs(params: &ListDirsParams) -> Result<Reply, Fault> {
    let order = NameOrder::new(&params.locale);
    let needle = match &params.query {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(query)) => order.lowercase(js_trim(query)),
        Some(_) => {
            return Err(Fault::new(
                "invalid_params",
                "query?.trim is not a function",
            ));
        }
    };
    let entries = disk::read_dir(&params.dir).map_err(|error| match error.code {
        "ENOTDIR" => Fault::new("not_a_directory", "Not a directory"),
        // Windows' directory search can report ENOENT for an existing file as well as a missing path.
        #[cfg(windows)]
        _ if std::fs::metadata(&params.dir).is_ok_and(|meta| !meta.is_dir()) => {
            Fault::new("not_a_directory", "Not a directory")
        }
        "ENOENT" => Fault::new("file_not_found", "Directory not found"),
        _ => Fault::new(IO, error.message),
    })?;
    let visible = |name: &str| {
        !name.starts_with('.') && (needle.is_empty() || order.lowercase(name).contains(&needle))
    };
    if let Some(web) = &params.web {
        let dir = std::path::Path::new(&params.dir);
        let mut found: Vec<_> = entries
            .into_iter()
            .filter(|entry| visible(&entry.name))
            .filter_map(|entry| {
                let size = match entry.kind {
                    Kind::Dir => None,
                    Kind::Link | Kind::File => {
                        let meta = std::fs::metadata(dir.join(&entry.name)).ok()?;
                        if !meta.is_dir() && !web.files {
                            return None;
                        }
                        (!meta.is_dir()).then_some(meta.len())
                    }
                    #[cfg(not(windows))]
                    Kind::Other => return None,
                };
                Some(WebEntry {
                    name: entry.name,
                    size,
                    selection_id: None,
                })
            })
            .collect();
        found.sort_by(|a, b| {
            a.size
                .is_some()
                .cmp(&b.size.is_some())
                .then_with(|| order.compare(&a.name, &b.name))
        });
        let truncated = found.len() > web.limit;
        found.truncate(web.limit);
        if let (Some(caller), Some(Value::String(name))) = (&web.package_caller, &params.query)
            && Path::new(name)
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
            && let Some(entry) = found
                .iter_mut()
                .find(|e| e.size.is_some() && e.name == *name)
        {
            entry.selection_id = Some(super::bot_package_pick::offer(
                caller,
                &dir.join(&entry.name),
            )?);
        }
        return Reply::json(&WebEntries {
            entries: found,
            truncated,
        });
    }
    let mut names: Vec<String> = entries
        .into_iter()
        .filter(|entry| entry.kind == Kind::Dir && visible(&entry.name))
        .map(|entry| entry.name)
        .collect();
    names.sort_by(|a, b| order.compare(a, b));
    let truncated = names.len() > LIST_DIRS_MAX_ENTRIES;
    names.truncate(LIST_DIRS_MAX_ENTRIES);
    Reply::json(&DirNames { names, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn package_selection_names_only_a_returned_file_and_survives_path_replacement() {
        use std::io::Read;

        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("picked.json");
        fs::write(&file, "original").unwrap();
        let list = |query: &str| {
            let params = serde_json::from_value(serde_json::json!({
                "dir": dir.path(), "locale": "en-US", "query": query,
                "web": {"files": true, "limit": 10, "packageCaller": "picker-page"}
            }))
            .unwrap();
            let reply = list_dirs(&params).unwrap();
            serde_json::from_str::<Value>(reply.result.get()).unwrap()["entries"].clone()
        };
        assert!(list("picked")[0].get("selectionId").is_none());
        assert_eq!(list("../picked.json"), serde_json::json!([]));
        let entries = list("picked.json");
        let id = entries[0]["selectionId"].as_str().unwrap();
        fs::rename(&file, dir.path().join("moved")).unwrap();
        fs::write(&file, "replacement").unwrap();
        let mut text = String::new();
        crate::fs::bot_package_pick::take("picker-page", id)
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        assert_eq!(text, "original");
    }

    #[test]
    fn root_walk_and_direct_subtree_use_the_same_scoped_ignores() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        for dir in ["left", "right", "excluded"] {
            fs::create_dir(root.join(dir)).unwrap();
            for file in ["pass.log", "local", ".note"] {
                fs::write(root.join(dir).join(file), "").unwrap();
            }
        }
        fs::write(root.join(".gitignore"), "*.log\nexcluded/\n").unwrap();
        fs::write(root.join("left/.gitignore"), "!/pass.log\n/local\n").unwrap();
        fs::write(root.join("excluded/.gitignore"), "!pass.log\n").unwrap();

        let entries = |prefix: &str, hide_dotfiles, show_ignored| {
            let reply = list(&ListParams {
                root: root.to_str().unwrap().into(),
                dir: root.join(prefix).to_str().unwrap().into(),
                prefix: prefix.into(),
                max_depth: None,
                max_entries: None,
                hide_dotfiles,
                show_ignored,
                caps: FileCaps {
                    default: 50.0,
                    max: 50.0,
                },
                locale: "en-US".into(),
            })
            .unwrap();
            serde_json::from_str::<Value>(reply.result.get()).unwrap()["entries"].clone()
        };
        let tree = entries("", true, false);
        let left = entries("left", true, false);
        assert_eq!(tree[0]["children"], left);
        let names = |rows: &Value| -> Vec<String> {
            rows.as_array()
                .unwrap()
                .iter()
                .map(|row| row["name"].as_str().unwrap().to_owned())
                .collect()
        };
        assert_eq!(names(&tree), ["left", "right"]);
        assert_eq!(names(&left), ["pass.log"]);
        assert_eq!(names(&tree[1]["children"]), ["local"]);
        assert!(names(&entries("excluded", false, false)).is_empty());
        assert_eq!(names(&entries("left", true, true)), ["local", "pass.log"]);
        let visible = names(&entries("left", false, false));
        assert!(visible.iter().any(|name| name == ".note"));
        assert!(!visible.iter().any(|name| name == "local"));
    }

    #[test]
    fn a_direct_deep_listing_inherits_intermediate_rules_but_not_sibling_rules() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        for dir in ["a/deep", "b/deep"] {
            fs::create_dir_all(root.join(dir)).unwrap();
            fs::write(root.join(dir).join("hidden"), "").unwrap();
        }
        fs::write(root.join("a/.gitignore"), "/deep/hidden\n").unwrap();
        for (prefix, expected) in [("a/deep", 0), ("b/deep", 1)] {
            let params = serde_json::from_value(serde_json::json!({
                "root": root, "dir": root.join(prefix), "prefix": prefix,
                "caps": {"default": 50, "max": 50}, "locale": "en-US",
            }))
            .unwrap();
            let reply = list(&params).unwrap();
            let tree: Value = serde_json::from_str(reply.result.get()).unwrap();
            assert_eq!(
                tree["entries"].as_array().unwrap().len(),
                expected,
                "{prefix}"
            );
        }
    }
}
