//! WebKit keeps an identified data store whole (Local Storage, IndexedDB, cookies in `Cookies/`, caches) under
//! `<Library>/WebKit/<bundle identifier, else the process name>/WebsiteDataStore/<uuid>` (WebsiteDataStoreCocoa.mm
//! `applicationOrProcessIdentifier`, `WebsiteDataStoreConfiguration(UUID)`). Shells up to 0.133.0 embedded no
//! CFBundleIdentifier, so their stores sit under the process name `ompdesk-shell`; a shell that names the bundle
//! identifier would open an empty store. `adopt` moves the old one to the new name before WebKit creates it.

use std::path::Path;

/// Moves `<library>/WebKit/<old>/WebsiteDataStore/<uuid>` to `<library>/WebKit/<new>/WebsiteDataStore/<uuid>` when the new
/// one does not exist yet: one rename on the same volume, so a failure leaves both as they were and nothing is deleted.
/// The uuid matches without regard to case (WebKit spells it its own way); the moved folder keeps its name.
/// `Ok(true)` when it moved, `Ok(false)` when there was nothing to move.
pub fn adopt(library: &Path, old: &str, new: &str, uuid: &str) -> Result<bool, String> {
    if old == new {
        return Ok(false);
    }
    let from_parent = library.join("WebKit").join(old).join("WebsiteDataStore");
    let Ok(entries) = std::fs::read_dir(&from_parent) else {
        return Ok(false);
    };
    let Some(name) = entries
        .filter_map(Result::ok)
        .map(|entry| entry.file_name())
        .find(|name| name.to_str().is_some_and(|n| n.eq_ignore_ascii_case(uuid)))
    else {
        return Ok(false);
    };
    let to_parent = library.join("WebKit").join(new).join("WebsiteDataStore");
    let to = to_parent.join(&name);
    if to.symlink_metadata().is_ok() {
        return Ok(false);
    }
    std::fs::create_dir_all(&to_parent)
        .and_then(|()| std::fs::rename(from_parent.join(&name), &to))
        .map(|()| true)
        .map_err(|error| format!("{}: {error}", to.display()))
}

/// `adopt` for this process, with WebKit's own names: the main bundle's identifier (none: WebKit uses the process name for
/// both, nothing moves), the process name, the user's Library folder.
#[cfg(target_os = "macos")]
pub fn adopt_for(identifier: [u8; 16]) {
    use objc2_foundation::{
        NSBundle, NSFileManager, NSProcessInfo, NSSearchPathDirectory, NSSearchPathDomainMask,
    };
    let Some(new) = NSBundle::mainBundle().bundleIdentifier() else {
        return;
    };
    let old = NSProcessInfo::processInfo().processName().to_string();
    let new = new.to_string();
    let Some(library) = NSFileManager::defaultManager()
        .URLForDirectory_inDomain_appropriateForURL_create_error(
            NSSearchPathDirectory::LibraryDirectory,
            NSSearchPathDomainMask::UserDomainMask,
            None,
            false,
        )
        .ok()
        .and_then(|url| url.to_file_path())
    else {
        crate::log::log(
            "webkit.store.move-failed",
            serde_json::json!({"error": "no Library folder"}),
        );
        return;
    };
    let uuid = uuid(identifier);
    match adopt(&library, &old, &new, &uuid) {
        Ok(true) => crate::log::log(
            "webkit.store.moved",
            serde_json::json!({"uuid": uuid, "from": old, "to": new}),
        ),
        Ok(false) => {}
        Err(error) => crate::log::log(
            "webkit.store.move-failed",
            serde_json::json!({"uuid": uuid, "from": old, "to": new, "error": error}),
        ),
    }
}

/// The identifier's 16 bytes in the 8-4-4-4-12 form NSUUID and WebKit print them.
fn uuid(identifier: [u8; 16]) -> String {
    let hex: String = identifier.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

#[cfg(test)]
mod tests {
    use super::{adopt, uuid};
    use std::fs;
    use std::path::{Path, PathBuf};

    const OLD: &str = "ompdesk-shell";
    const NEW: &str = "com.seuput.ompdesk";
    const A: &str = "0a1b2c3d-0000-1111-2222-333344445555";
    const B: &str = "9f8e7d6c-aaaa-bbbb-cccc-ddddeeeeffff";

    struct Home(PathBuf);

    impl Home {
        fn new() -> Self {
            let mut random = [0_u8; 16];
            getrandom::fill(&mut random).unwrap();
            let path = std::env::temp_dir().join(format!("webkit-store-{}", uuid(random)));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn store(&self, app: &str, uuid: &str) -> PathBuf {
            self.0
                .join("WebKit")
                .join(app)
                .join("WebsiteDataStore")
                .join(uuid)
        }
        fn put(&self, app: &str, uuid: &str, text: &str) {
            let dir = self.store(app, uuid).join("Origins");
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("localstorage.sqlite3"), text).unwrap();
        }
    }

    impl Drop for Home {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn read(store: &Path) -> Option<String> {
        fs::read_to_string(store.join("Origins").join("localstorage.sqlite3")).ok()
    }

    #[test]
    fn an_old_store_moves_to_the_new_name_once() {
        let home = Home::new();
        home.put(OLD, A, "kept");
        assert_eq!(adopt(&home.0, OLD, NEW, A), Ok(true));
        assert_eq!(read(&home.store(NEW, A)).as_deref(), Some("kept"));
        assert!(!home.store(OLD, A).exists());
        assert_eq!(adopt(&home.0, OLD, NEW, A), Ok(false));
        assert_eq!(read(&home.store(NEW, A)).as_deref(), Some("kept"));
    }

    #[test]
    fn an_existing_new_store_is_left_as_it_is_and_so_is_the_old() {
        let home = Home::new();
        home.put(OLD, A, "old");
        home.put(NEW, A, "new");
        assert_eq!(adopt(&home.0, OLD, NEW, A), Ok(false));
        assert_eq!(read(&home.store(OLD, A)).as_deref(), Some("old"));
        assert_eq!(read(&home.store(NEW, A)).as_deref(), Some("new"));
    }

    #[test]
    fn without_an_old_store_nothing_is_made() {
        let home = Home::new();
        assert_eq!(adopt(&home.0, OLD, NEW, A), Ok(false));
        home.put(OLD, B, "other");
        assert_eq!(adopt(&home.0, OLD, NEW, A), Ok(false));
        assert!(!home.0.join("WebKit").join(NEW).exists());
        assert_eq!(adopt(&home.0, NEW, NEW, B), Ok(false));
    }

    #[test]
    fn a_second_profile_moves_into_an_existing_new_parent() {
        let home = Home::new();
        home.put(NEW, A, "first profile");
        home.put(OLD, &B.to_uppercase(), "second profile");
        assert_eq!(adopt(&home.0, OLD, NEW, B), Ok(true));
        assert_eq!(
            read(&home.store(NEW, &B.to_uppercase())).as_deref(),
            Some("second profile")
        );
        assert_eq!(read(&home.store(NEW, A)).as_deref(), Some("first profile"));
    }

    #[test]
    fn the_uuid_is_the_identifiers_bytes_in_order() {
        let bytes: [u8; 16] = std::array::from_fn(|i| (i * 17) as u8);
        assert_eq!(uuid(bytes), "00112233-4455-6677-8899-aabbccddeeff");
    }
}
