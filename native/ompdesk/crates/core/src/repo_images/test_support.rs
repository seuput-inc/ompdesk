use std::path::PathBuf;

pub(super) struct Fixture {
    pub(super) dir: PathBuf,
}

impl Fixture {
    /// The folder spelled as the core spells real paths (no Windows `\\?\` prefix), so paths it answers compare equal.
    pub(super) fn new(name: &str) -> Self {
        let dir = crate::fs::disk::make_temp_dir(&format!("ompdesk-{name}-"))
            .unwrap()
            .canonicalize()
            .unwrap();
        Self {
            dir: PathBuf::from(crate::fs::disk::spelled(&dir)),
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
