use std::fs::File;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BrowserRecord {
    version: String,
    platform: String,
    arch: String,
    binary: PathBuf,
    sha256: String,
}

pub fn preview_binary(resources: &Path, packaged: bool) -> Result<PathBuf, String> {
    resolve(
        resources,
        packaged,
        std::env::var_os("OMPDESK_PREVIEW_BROWSER").as_deref(),
    )
}

fn platform() -> &'static str {
    if cfg!(windows) { "win32" } else { "darwin" }
}

fn arch() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    }
}

fn resolve(
    resources: &Path,
    packaged: bool,
    development: Option<&std::ffi::OsStr>,
) -> Result<PathBuf, String> {
    if let Some(development) = development {
        if packaged {
            return Err("A packaged Preview cannot use a development browser override".into());
        }
        let path = Path::new(development);
        if !path.is_absolute() {
            return Err("The development Preview browser must be an absolute path".into());
        }
        let path = path.canonicalize().map_err(|error| error.to_string())?;
        if !path.is_file() {
            return Err("The development Preview browser is not a regular file".into());
        }
        return Ok(path);
    }
    let resources = resources
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let root = resources.join("preview-browser");
    let root = if packaged {
        root
    } else {
        root.join(format!("{}-{}", platform(), arch()))
    };
    let root = root
        .canonicalize()
        .map_err(|error| format!("Preview runtime is unavailable: {error}"))?;
    if !root.starts_with(&resources) {
        return Err("Preview runtime leaves the application's resources".into());
    }
    let record: BrowserRecord = serde_json::from_reader(
        File::open(root.join("runtime.json"))
            .map_err(|error| format!("Preview runtime record is unavailable: {error}"))?,
    )
    .map_err(|error| format!("Invalid Preview runtime record: {error}"))?;
    let mut version = record.version.split('.');
    let valid_version = (0..4).all(|_| {
        version
            .next()
            .is_some_and(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
    }) && version.next().is_none();
    if record.platform != platform()
        || record.arch != arch()
        || !valid_version
        || record.sha256.len() != 64
        || !record
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || record.binary.as_os_str().is_empty()
        || !record
            .binary
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err(
            "Preview runtime record does not match this platform or a relative executable".into(),
        );
    }
    let binary = root
        .join(record.binary)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !binary.starts_with(&root) || !binary.is_file() {
        return Err("Preview executable leaves the recorded runtime".into());
    }
    let mut file = File::open(&binary).map_err(|error| error.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let count = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    let digest = hash.finalize();
    let expected = record.sha256.as_bytes();
    const HEX: &[u8; 16] = b"0123456789abcdef";
    if !digest.iter().enumerate().all(|(index, byte)| {
        expected[index * 2] == HEX[usize::from(byte >> 4)]
            && expected[index * 2 + 1] == HEX[usize::from(byte & 0x0f)]
    }) {
        return Err("Preview executable differs from its recorded bytes".into());
    }
    Ok(binary)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let mut nonce = [0_u8; 16];
            getrandom::fill(&mut nonce).unwrap();
            let root = std::env::temp_dir()
                .join(format!("preview-runtime-{:x}", u128::from_le_bytes(nonce)));
            std::fs::create_dir(&root).unwrap();
            std::fs::create_dir(root.join("preview-browser")).unwrap();
            std::fs::write(
                root.join("preview-browser/browser"),
                b"runtime fixture bytes",
            )
            .unwrap();
            Self(root)
        }
        fn record(&self, binary: &str) {
            std::fs::write(self.0.join("preview-browser/runtime.json"), serde_json::to_vec(&serde_json::json!({
                "version": "157.0.8103.78", "platform": platform(), "arch": arch(), "binary": binary,
                "sha256": "3eb313bc1853a76f0a13a5cbe07717b9e603f59228fd4e79bf2ca62ee8b0792d"
            })).unwrap()).unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn packaged_selection_refuses_stale_bytes_and_escape() {
        let fixture = Fixture::new();
        fixture.record("browser");
        assert_eq!(
            resolve(&fixture.0, true, None).unwrap(),
            fixture
                .0
                .join("preview-browser/browser")
                .canonicalize()
                .unwrap()
        );
        std::fs::write(
            fixture.0.join("preview-browser/browser"),
            b"changed runtime",
        )
        .unwrap();
        assert!(
            resolve(&fixture.0, true, None)
                .unwrap_err()
                .contains("recorded bytes")
        );
        fixture.record("../outside");
        assert!(
            resolve(&fixture.0, true, None)
                .unwrap_err()
                .contains("relative executable")
        );
    }

    #[test]
    fn development_override_never_replaces_packaged_browser() {
        let fixture = Fixture::new();
        let binary = fixture.0.join("preview-browser/browser");
        assert!(
            resolve(&fixture.0, true, Some(binary.as_os_str()))
                .unwrap_err()
                .contains("development browser override")
        );
        assert_eq!(
            resolve(&fixture.0, false, Some(binary.as_os_str())).unwrap(),
            binary.canonicalize().unwrap()
        );
        assert!(
            resolve(&fixture.0, false, Some(std::ffi::OsStr::new("browser")))
                .unwrap_err()
                .contains("absolute path")
        );
    }
}
