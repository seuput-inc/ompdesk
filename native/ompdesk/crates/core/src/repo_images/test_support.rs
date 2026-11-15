use std::path::PathBuf;

pub(super) struct Fixture {
    pub(super) dir: PathBuf,
}

impl Fixture {
    pub(super) fn new(name: &str) -> Self {
        Self {
            dir: crate::fs::disk::make_temp_dir(&format!("ompdesk-{name}-"))
                .unwrap()
                .canonicalize()
                .unwrap(),
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
