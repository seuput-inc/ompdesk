#[cfg(unix)]
#[path = "update_files/unix.rs"]
mod unix;
#[cfg(unix)]
pub(crate) use unix::{handle, remove_staging_directory};

#[cfg(not(unix))]
pub(crate) fn handle(
    _method: &str,
    _params: &serde_json::Value,
    _downloads: &std::path::Path,
    _updates: &std::path::Path,
) -> Result<serde_json::Value, String> {
    Err("DMG update files are not supported on this platform".into())
}

#[cfg(all(unix, test))]
#[path = "update_files/tests.rs"]
mod tests;
