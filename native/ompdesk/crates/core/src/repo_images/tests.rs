#![cfg(unix)]
use super::test_support::Fixture;
use super::*;
use crate::git::run::tests::runner;
use crate::git::{repo_at, sh};

fn picture(root: &Path, color: [u8; 4]) {
    let pixels = image::RgbaImage::from_pixel(24, 12, image::Rgba(color));
    pixels.save(root.join("logo.png")).unwrap();
}

fn folders(paths: &[&str]) -> Vec<Target> {
    paths
        .iter()
        .map(|path| Target {
            key: (*path).to_owned(),
            path: (*path).to_owned(),
            session: None,
        })
        .collect()
}

async fn metadata(service: &Arc<Service>, targets: Vec<Target>) -> serde_json::Value {
    let result = service
        .batch(targets, runner(), Scope::detached())
        .await
        .unwrap();
    serde_json::to_value(result).unwrap()
}

async fn artwork(service: &Arc<Service>, roots: &[&str]) -> serde_json::Value {
    let result = service
        .artwork(
            roots.iter().map(|root| (*root).to_owned()).collect(),
            runner(),
            Scope::detached(),
        )
        .await
        .unwrap();
    serde_json::to_value(result).unwrap()
}

#[tokio::test]
async fn checkout_heads_stay_distinct_while_worktrees_share_original_repository_artwork() {
    let temp = Fixture::new("repository-metadata-heads");
    let root = temp.dir.join("project");
    repo_at(&root);
    picture(&root, [20, 100, 180, 255]);
    let linked = temp.dir.join("linked");
    sh(
        &root,
        &[
            "worktree",
            "add",
            "-qb",
            "feature",
            linked.to_str().unwrap(),
        ],
    );
    picture(&linked, [220, 20, 10, 255]);
    let service = Arc::new(Service::default());
    let paths = [root.to_str().unwrap(), linked.to_str().unwrap()];
    let json = metadata(&service, folders(&paths)).await;
    assert_eq!(
        json[paths[0]]["repository"]["head"],
        serde_json::json!({"kind":"branch","name":"main"})
    );
    assert_eq!(
        json[paths[1]]["repository"]["head"],
        serde_json::json!({"kind":"branch","name":"feature"})
    );
    let canonical = root.canonicalize().unwrap();
    let canonical = canonical.to_str().unwrap();
    assert_eq!(json[paths[1]]["repository"]["root"], canonical);
    // The list's read never looks an image up: it is absent until asked for.
    assert!(json[paths[0]].get("image").is_none());

    let images = artwork(&service, &[canonical]).await;
    assert_eq!(images[canonical]["source"], "repository");
    assert!(
        images[canonical]["src"]
            .as_str()
            .unwrap()
            .starts_with("data:image/png;base64,")
    );
    let json = metadata(&service, folders(&paths)).await;
    assert_eq!(json[paths[0]]["image"], images[canonical]);
    assert_eq!(json[paths[1]]["image"], images[canonical]);
    assert_eq!(service.cache.lock().unwrap().images.len(), 1);

    sh(&linked, &["checkout", "--detach", "-q"]);
    let detached = metadata(&service, folders(&paths[1..])).await;
    assert_eq!(
        detached[paths[1]]["repository"]["head"],
        serde_json::json!({"kind":"detached","commit":sh(&root, &["rev-parse", "HEAD"])})
    );
}

#[tokio::test]
async fn non_repository_missing_and_unborn_targets_never_guess_a_child_repository() {
    let temp = Fixture::new("repository-metadata-targets");
    let child = temp.dir.join("child");
    std::fs::create_dir(&child).unwrap();
    sh(&child, &["init", "-qb", "unborn"]);
    let parent = temp.dir.to_string_lossy().into_owned();
    let child = child.to_string_lossy().into_owned();
    let missing = temp.dir.join("missing").to_string_lossy().into_owned();
    let json = metadata(
        &Arc::new(Service::default()),
        folders(&[&parent, &child, &missing]),
    )
    .await;
    assert!(json[&parent]["repository"].is_null());
    assert!(json[&parent].get("image").is_none());
    assert_eq!(
        json[&child]["repository"]["head"],
        serde_json::json!({"kind":"unborn","name":"unborn"})
    );
    assert!(json[&missing].is_null());
}

#[tokio::test]
async fn a_session_above_several_repositories_reads_the_one_its_tool_calls_last_worked_in() {
    let temp = Fixture::new("repository-metadata-worked");
    let parent = temp.dir.join("projects");
    let first = parent.join("first");
    let second = parent.join("second");
    repo_at(&first);
    repo_at(&second);
    std::fs::create_dir_all(second.join("src")).unwrap();
    let outside = temp.dir.join("outside");
    repo_at(&outside);
    let call = |name: &str, arguments: serde_json::Value| {
        serde_json::json!({"type":"message","message":{"role":"assistant","content":[
            {"type":"toolCall","id":"call","name":name,"arguments":arguments}
        ]}})
        .to_string()
    };
    let session = temp.dir.join("session.jsonl");
    let journal = [
        call(
            "bash",
            serde_json::json!({"command":"ls","cwd":first.to_str().unwrap()}),
        ),
        // Relative to the session's folder, naming a file not written yet: its nearest folder counts.
        call(
            "write",
            serde_json::json!({"path":"second/src/new.rs","content":""}),
        ),
        // Newest: a path outside the session's folder and an internal URL, neither its repository.
        call(
            "read",
            serde_json::json!({"path":outside.join("logo.png").to_str().unwrap()}),
        ),
        call("read", serde_json::json!({"path":"skill://anything"})),
    ];
    std::fs::write(&session, journal.join("\n")).unwrap();
    let parent_path = parent.to_str().unwrap();
    let json = metadata(
        &Arc::new(Service::default()),
        vec![Target {
            key: "row".into(),
            path: parent_path.into(),
            session: Some(session.to_str().unwrap().into()),
        }],
    )
    .await;
    assert_eq!(
        json["row"]["repository"]["root"],
        second.canonicalize().unwrap().to_str().unwrap()
    );
    assert_eq!(json["row"]["project"], "second");

    // A folder that is a repository itself is never replaced by what its tool calls named.
    let json = metadata(
        &Arc::new(Service::default()),
        vec![Target {
            key: "row".into(),
            path: first.to_str().unwrap().into(),
            session: Some(session.to_str().unwrap().into()),
        }],
    )
    .await;
    assert_eq!(json["row"]["project"], "first");
}

#[tokio::test]
async fn artwork_reads_pictures_only_from_a_repository_root() {
    let temp = Fixture::new("repository-artwork-roots");
    let root = temp.dir.join("project");
    repo_at(&root);
    let nested = root.join("nested");
    std::fs::create_dir(&nested).unwrap();
    picture(&nested, [9, 9, 9, 255]);
    let plain = temp.dir.join("plain");
    std::fs::create_dir(&plain).unwrap();
    picture(&plain, [9, 9, 9, 255]);
    let service = Arc::new(Service::default());
    let roots = [nested.to_str().unwrap(), plain.to_str().unwrap()];
    let images = artwork(&service, &roots).await;
    assert!(images[roots[0]].is_null());
    assert!(images[roots[1]].is_null());
    assert!(service.cache.lock().unwrap().images.is_empty());
}

#[tokio::test]
async fn artwork_symlinks_cannot_read_files_outside_the_repository() {
    let temp = Fixture::new("repository-artwork-symlink");
    let root = temp.dir.join("project");
    repo_at(&root);
    picture(&temp.dir, [1, 2, 3, 255]);
    std::os::unix::fs::symlink(temp.dir.join("logo.png"), root.join("logo.png")).unwrap();
    let root = root.to_str().unwrap();
    let images = artwork(&Arc::new(Service::default()), &[root]).await;
    assert!(images[root].is_null());
}

#[tokio::test]
async fn relocated_git_storage_is_not_mistaken_for_the_repository_checkout() {
    let temp = Fixture::new("repository-metadata-relocated");
    let root = temp.dir.join("project");
    let storage = temp.dir.join("git-storage");
    repo_at(&root);
    picture(&root, [40, 150, 80, 255]);
    sh(
        &root,
        &[
            "init",
            "-q",
            "--separate-git-dir",
            storage.to_str().unwrap(),
        ],
    );
    let service = Arc::new(Service::default());
    let original = root.to_str().unwrap();
    let unknown = metadata(&service, folders(&[original])).await;
    assert!(unknown[original].is_null());
    sh(&root, &["config", "core.worktree", original]);
    let linked = temp.dir.join("linked");
    sh(
        &root,
        &[
            "worktree",
            "add",
            "-qb",
            "feature",
            linked.to_str().unwrap(),
        ],
    );
    let path = linked.to_str().unwrap();
    let json = metadata(&Arc::new(Service::default()), folders(&[path])).await;
    let canonical = root.canonicalize().unwrap();
    let canonical = canonical.to_str().unwrap();
    assert_eq!(json[path]["repository"]["root"], canonical);
    assert_eq!(
        json[path]["repository"]["head"],
        serde_json::json!({"kind":"branch","name":"feature"})
    );
    let images = artwork(&Arc::new(Service::default()), &[canonical]).await;
    assert_eq!(images[canonical]["source"], "repository");
}
