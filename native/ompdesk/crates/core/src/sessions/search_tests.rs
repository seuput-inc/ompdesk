use std::fs;
use std::io::{Seek, SeekFrom, Write};
use std::path::PathBuf;

use serde_json::{Value, json};

use super::*;

struct Dir(PathBuf);

impl Dir {
    fn new() -> Self {
        Self(crate::fs::disk::make_temp_dir("ompdesk-session-search-").unwrap())
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn name(path: &Path) -> String {
    path.to_str().unwrap().to_owned()
}

async fn hits(cache: &Arc<ContentCache>, root: &Path, paths: Vec<String>, query: &str) -> Value {
    serde_json::to_value(cache.search(root, paths, &Query::Text(query.into())).await).unwrap()
}

#[tokio::test]
async fn returns_only_raw_all_token_matches_in_candidate_order_with_duplicates() {
    let dir = Dir::new();
    let first = dir.0.join("a.jsonl");
    let key = dir.0.join("key.jsonl");
    let partial = dir.0.join("partial.jsonl");
    fs::write(&first, b"not json \xff\n{\"message\":\"The Needle\"}\n").unwrap();
    fs::write(&key, b"{\"needle\":0}\n\xff").unwrap();
    fs::write(&partial, "Needle without the second token").unwrap();
    let cache = Arc::new(ContentCache::default());
    let mut paths = vec![name(&partial); 15];
    paths.extend([name(&key), name(&first), name(&key)]);
    let found = hits(&cache, &dir.0, paths, " NEEDLE\t� ").await;
    assert_eq!(
        found,
        json!([{ "path": key }, { "path": first, "snippet": "The Needle" }, { "path": key }])
    );
    assert_eq!(
        hits(&cache, &dir.0, vec![name(&first)], "\u{feff}").await,
        json!([])
    );
}

#[tokio::test]
async fn allows_only_absolute_jsonl_files_under_the_canonical_root() {
    let dir = Dir::new();
    let root = dir.0.join("sessions");
    let sibling = dir.0.join("sessions-other");
    fs::create_dir(&root).unwrap();
    fs::create_dir(&sibling).unwrap();
    let inside = root.join("inside.jsonl");
    let outside = sibling.join("outside.jsonl");
    let non_session = root.join("config.txt");
    for path in [&inside, &outside, &non_session] {
        fs::write(path, "search-me").unwrap();
    }
    let directory = root.join("directory.jsonl");
    fs::create_dir(&directory).unwrap();
    let cache = Arc::new(ContentCache::default());
    let paths = vec![
        name(&outside),
        name(&root.join("..").join("sessions-other").join("outside.jsonl")),
        "inside.jsonl".into(),
        name(&non_session),
        name(&directory),
        name(&root.join("missing.jsonl")),
        name(&inside),
    ];
    assert_eq!(
        hits(&cache, &root, paths, "search-me").await,
        json!([{ "path": inside }])
    );
}

fn link_directory(base: &Path, link: &str, target: &str) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(base.join(target), base.join(link)).unwrap();
    #[cfg(windows)]
    assert!(
        std::process::Command::new("cmd.exe")
            .current_dir(base)
            .args(["/d", "/c", "mklink", "/J", link])
            .arg(base.join(target).components().collect::<PathBuf>())
            .output()
            .unwrap()
            .status
            .success()
    );
}

#[tokio::test]
async fn keeps_in_root_aliases_but_never_follows_an_escaping_alias_even_after_resolution() {
    let dir = Dir::new();
    let root = dir.0.join("sessions");
    let project = root.join("project");
    let outside = dir.0.join("outside");
    fs::create_dir_all(&project).unwrap();
    fs::create_dir(&outside).unwrap();
    fs::write(project.join("a.jsonl"), "inside").unwrap();
    fs::write(outside.join("a.jsonl"), "outside").unwrap();
    link_directory(&root, "alias", "project");
    let alias = root.join("alias").join("a.jsonl");
    let cache = Arc::new(ContentCache::default());
    assert_eq!(
        hits(&cache, &root, vec![name(&alias)], "inside").await,
        json!([{ "path": alias }])
    );

    let resolved_before_swap = alias.canonicalize().unwrap();
    fs::rename(&project, root.join("old")).unwrap();
    link_directory(&root, "project", "../outside");
    assert!(open_checked(&resolved_before_swap).is_none());
    for query in ["inside", "outside"] {
        assert_eq!(
            hits(&cache, &root, vec![name(&alias)], query).await,
            json!([])
        );
    }
}

#[tokio::test]
async fn matches_only_the_first_eight_mib_and_replaces_a_character_cut_at_that_boundary() {
    let dir = Dir::new();
    let path = dir.0.join("large.jsonl");
    let mut file = File::create(&path).unwrap();
    file.seek(SeekFrom::Start(8 * 1024 * 1024 - 2)).unwrap();
    file.write_all("A\u{20000}tail".as_bytes()).unwrap();
    drop(file);
    let cache = Arc::new(ContentCache::default());
    assert_eq!(
        hits(&cache, &dir.0, vec![name(&path)], "A�").await,
        json!([{ "path": path }])
    );
    assert_eq!(
        hits(&cache, &dir.0, vec![name(&path)], "tail").await,
        json!([])
    );
    assert_eq!(Text::read(&mut &b"ab"[..], 4).unwrap().raw, "ab\0\0");
}

#[test]
fn sixty_four_mi_utf16_units_keep_recent_hits_not_just_recent_inserts() {
    let raw = "\u{20000}".repeat(256 * 1024);
    let text = Arc::new(Text::read(&mut raw.as_bytes(), raw.len() as u64).unwrap());
    let stamp = Stamp {
        mtime_ms: 0.0,
        size: raw.len() as u64,
    };
    let mut entries = Entries::default();
    for i in 0..64 {
        entries.store(Path::new(&i.to_string()), stamp, &text, 0);
    }
    assert!(entries.get(Path::new("0"), stamp).is_some());
    entries.store(Path::new("64"), stamp, &text, 0);
    assert!(entries.get(Path::new("1"), stamp).is_none());
    for i in [0, 2, 63, 64] {
        assert!(entries.get(Path::new(&i.to_string()), stamp).is_some());
    }
}

fn rewrite_at_same_time(path: &Path, data: &str) {
    let modified = fs::metadata(path).unwrap().modified().unwrap();
    fs::write(path, data).unwrap();
    OpenOptions::new()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(modified)
        .unwrap();
}

#[tokio::test]
async fn rereads_changed_stamps_and_forgets_only_the_invalidated_path() {
    let dir = Dir::new();
    let cache = Arc::new(ContentCache::default());
    let a = dir.0.join("a.jsonl");
    let b = dir.0.join("b.jsonl");
    let c = dir.0.join("c.jsonl");
    let paths = vec![name(&a), name(&b), name(&c)];
    for path in &paths {
        fs::write(path, "old").unwrap();
    }
    assert_eq!(
        hits(&cache, &dir.0, paths.clone(), "old").await,
        json!([{ "path": a }, { "path": b }, { "path": c }])
    );
    rewrite_at_same_time(&a, "new");
    rewrite_at_same_time(&b, "new");
    rewrite_at_same_time(&c, "new size");
    cache.invalidate(&a);
    assert_eq!(
        hits(&cache, &dir.0, paths.clone(), "new").await,
        json!([{ "path": a }, { "path": c }])
    );
    cache.clear();
    assert_eq!(
        hits(&cache, &dir.0, paths, "new").await,
        json!([{ "path": a }, { "path": b }, { "path": c }])
    );
}

#[tokio::test]
async fn invalidation_fences_a_read_that_finishes_after_a_same_stamp_rewrite() {
    let dir = Dir::new();
    let root = dir.0.canonicalize().unwrap();
    let path = root.join("rewritten.jsonl");
    let cache = Arc::new(ContentCache::default());
    for clear_all in [false, true] {
        fs::write(&path, "old").unwrap();
        let metadata = fs::metadata(&path).unwrap();
        let stamp = Stamp::from(&metadata);
        let generation = locked(&cache.entries).generation;
        let old = Arc::new(Text::read(&mut File::open(&path).unwrap(), stamp.size).unwrap());
        rewrite_at_same_time(&path, "new");
        assert!(stamp == Stamp::from(&fs::metadata(&path).unwrap()));
        if clear_all {
            cache.clear();
        } else {
            cache.invalidate(&path);
        }
        locked(&cache.entries).store(&path, stamp, &old, generation);
        assert_eq!(
            hits(&cache, &root, vec![name(&path)], "new").await,
            json!([{ "path": path }])
        );
        cache.clear();
    }
}
