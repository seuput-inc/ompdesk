#![cfg(unix)]
use crate::models::test_rig::Fixture;
use super::*;
use crate::git::session_lifecycle::test_support::{repo_at, runner, sh};

fn picture(root: &Path, color: [u8; 4]) {
    let pixels = image::RgbaImage::from_pixel(24, 12, image::Rgba(color));
    pixels.save(root.join("logo.png")).unwrap();
}

#[tokio::test]
async fn checkout_heads_stay_distinct_while_worktrees_share_original_repository_artwork() {
    let temp = Fixture::new("repository-metadata-heads");
    let root = temp.dir.join("project");
    repo_at(&root);
    picture(&root, [20, 100, 180, 255]);
    let linked = temp.dir.join("linked");
    sh(&root, &["worktree", "add", "-qb", "feature", linked.to_str().unwrap()]);
    picture(&linked, [220, 20, 10, 255]);
    let service = Arc::new(Service::default());
    let paths = vec![root.to_string_lossy().into_owned(), linked.to_string_lossy().into_owned()];
    let result = service.batch(paths.clone(), runner(), Scope::detached()).await.unwrap();
    let json = serde_json::to_value(result).unwrap();
    assert_eq!(json[&paths[0]]["repository"]["head"], serde_json::json!({"kind":"branch","name":"main"}));
    assert_eq!(json[&paths[1]]["repository"]["head"], serde_json::json!({"kind":"branch","name":"feature"}));
    assert_eq!(json[&paths[1]]["repository"]["root"], root.canonicalize().unwrap().to_str().unwrap());
    assert_eq!(json[&paths[0]]["image"], json[&paths[1]]["image"]);
    assert_eq!(json[&paths[0]]["image"]["source"], "repository");
    assert_eq!(service.cache.lock().unwrap().images.len(), 1);
    sh(&linked, &["checkout", "--detach", "-q"]);
    let detached = service.batch(vec![paths[1].clone()], runner(), Scope::detached()).await.unwrap();
    let detached = serde_json::to_value(detached).unwrap();
    assert_eq!(detached[&paths[1]]["repository"]["head"]["kind"], "detached");
    assert_eq!(detached[&paths[1]]["repository"]["head"]["sha"], sh(&root, &["rev-parse", "HEAD"]));
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
    let result = Arc::new(Service::default()).batch(vec![parent.clone(), child.clone(), missing.clone()], runner(), Scope::detached()).await.unwrap();
    let json = serde_json::to_value(result).unwrap();
    assert!(json[&parent]["repository"].is_null());
    assert!(json[&parent]["image"].is_null());
    assert_eq!(json[&child]["repository"]["head"], serde_json::json!({"kind":"unborn","name":"unborn"}));
    assert!(json[&missing].is_null());
}

#[cfg(unix)]
#[tokio::test]
async fn artwork_symlinks_cannot_read_files_outside_the_repository() {
    let temp = Fixture::new("repository-artwork-symlink");
    let root = temp.dir.join("project");
    repo_at(&root);
    picture(&temp.dir, [1, 2, 3, 255]);
    std::os::unix::fs::symlink(temp.dir.join("logo.png"), root.join("logo.png")).unwrap();
    let path = root.to_string_lossy().into_owned();
    let result = Arc::new(Service::default()).batch(vec![path.clone()], runner(), Scope::detached()).await.unwrap();
    assert!(serde_json::to_value(result).unwrap()[&path]["image"].is_null());
}

#[tokio::test]
async fn a_head_changed_while_artwork_waits_never_returns_an_old_snapshot() {
    let temp = Fixture::new("repository-metadata-inflight");
    let root = temp.dir.join("project");
    repo_at(&root);
    let path = root.to_string_lossy().into_owned();
    let canonical = root.canonicalize().unwrap();
    let service = Arc::new(Service::default());
    let (finish, waiting) = watch::channel(None);
    service.cache.lock().unwrap().loading.insert(canonical, waiting);
    let work = {
        let service = Arc::clone(&service);
        let path = path.clone();
        tokio::spawn(async move { service.batch(vec![path], runner(), Scope::detached()).await })
    };
    service.image_waiting.notified().await;
    sh(&root, &["checkout", "-qb", "replacement"]);
    finish.send_replace(Some(None));
    let result = work.await.unwrap().unwrap();
    assert!(serde_json::to_value(result).unwrap()[&path].is_null());
}
