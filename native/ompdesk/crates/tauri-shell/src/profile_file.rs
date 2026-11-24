use std::io;
use std::path::Path;
use std::time::Duration;
use tempfile::NamedTempFile;

/// A scanner or another reader may briefly deny replacement on Windows.
pub(crate) fn persist(mut temp: NamedTempFile, destination: &Path) -> io::Result<()> {
    let mut waits = [10, 20, 40, 80, 160, 320].into_iter();
    loop {
        match temp.persist(destination) {
            Ok(_) => return Ok(()),
            Err(error) => {
                let blocked =
                    cfg!(windows) && matches!(error.error.raw_os_error(), Some(5 | 32 | 33 | 170));
                let Some(ms) = waits.next().filter(|_| blocked) else {
                    return Err(error.error);
                };
                temp = error.file;
                std::thread::sleep(Duration::from_millis(ms));
            }
        }
    }
}
