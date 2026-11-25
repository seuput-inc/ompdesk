use super::*;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

#[tokio::test]
async fn enospc_at_v21_prunes_only_after_the_latest_history_lands() {
    let mut nonce = [0; 8];
    crate::sys::random(&mut nonce).unwrap();
    let dir = std::env::temp_dir().join(format!("omp-visual-retry-{}", crate::hex(&nonce)));
    let history = dir.join("history.json");
    let full = Arc::new(AtomicBool::new(false));
    let gate = Arc::clone(&full);
    let saves = Saves::manual(Box::new(move |file, bytes, mode, dir_mode| {
        if gate.load(Ordering::SeqCst) {
            return Err(Fault::new("io", "ENOSPC: history"));
        }
        write_atomic_if(file, bytes, mode, dir_mode, &|| true)
    }));
    let open = |n: u8| {
        let saves = Arc::clone(&saves);
        with_catalog(dir.clone(), move |catalog| {
            let p = Open {
                cwd: "project".into(),
                label: Some("한글".into()),
                visual: None,
                tab_ids: catalog
                    .records
                    .first()
                    .map(|r| vec![r.id.clone()])
                    .unwrap_or_default(),
                tab_limit: 8,
            };
            let page = Page {
                kind: Kind::Inline,
                target: String::new(),
                root: PathBuf::new(),
                entry: "index.html".into(),
                label: "Visual".into(),
                content: Some(vec![n]),
            };
            catalog.open(p, page, |file, bytes| saves.write(file, bytes, None, 0o777))
        })
    };
    for n in 1..=20 {
        open(n).await.unwrap();
    }
    let folder = with_catalog(dir.clone(), |c| Ok(c.dir.join(&c.records[0].id)))
        .await
        .unwrap();
    full.store(true, Ordering::SeqCst);
    assert!(matches!(open(21).await, Err(f) if f.message.starts_with("ENOSPC")));
    let v21 = with_catalog(dir.clone(), |c| Ok(serde_json::to_vec(&c.records).unwrap()))
        .await
        .unwrap();
    assert_eq!(fs::read(folder.join("v1.html")).unwrap(), [1]);
    assert!(matches!(open(22).await, Err(f) if f.message.starts_with("ENOSPC")));
    let v22 = with_catalog(dir.clone(), |c| Ok(serde_json::to_vec(&c.records).unwrap()))
        .await
        .unwrap();
    // The old completion cannot clean up behind a later open, even if its bytes are still on disk.
    fs::write(&history, &v21).unwrap();
    saved_after_retry(&history, &v21, &saves);
    assert!(folder.join("v1.html").exists());
    assert!(!saves.retry_once(&history));
    assert!(folder.join("v2.html").exists());
    fs::write(&history, &v22).unwrap();
    saved_after_retry(&history, &v22, &saves);
    assert!(folder.join("v1.html").exists());
    full.store(false, Ordering::SeqCst);
    assert!(saves.retry_once(&history));
    assert_eq!(fs::read(&history).unwrap(), v22);
    assert!(!folder.join("v1.html").exists());
    assert!(!folder.join("v2.html").exists());
    assert_eq!(fs::read(folder.join("v21.html")).unwrap(), [21]);
    assert_eq!(fs::read(folder.join("v22.html")).unwrap(), [22]);
    fs::remove_dir_all(dir).unwrap();
}
