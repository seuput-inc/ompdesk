use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::fs::error::{Codes, NodeError};
use crate::server::{Call, Fault, Reply};

#[derive(Deserialize)]
struct Params {
    path: PathBuf,
    byte: u64,
}

#[derive(Serialize)]
struct Tail {
    tail: Option<String>,
}

pub(super) async fn read_tail(call: Call) -> Result<Reply, Fault> {
    super::blocking(move || {
        let Params { path, byte } = call.params()?;
        let tail = token(&path, byte)
            .map_err(|err| NodeError::new(&err, "read", None).fault(Codes::None))?;
        Reply::json(&Tail { tail })
    })
    .await
}

fn token(path: &Path, byte: u64) -> io::Result<Option<String>> {
    if byte == 0 {
        return Ok(Some("0".into()));
    }
    let Ok(mut file) = File::open(path) else {
        return Ok(None);
    };
    let mut bytes = [0; 64];
    let len = byte.min(bytes.len() as u64) as usize;
    file.seek(SeekFrom::Start(byte - len as u64))?;
    if file.read(&mut bytes[..len])? != len {
        return Ok(None);
    }
    let digest = Sha256::digest(&bytes[..len]);
    let mut encoded = [0; 43];
    URL_SAFE_NO_PAD.encode_slice(digest, &mut encoded).unwrap();
    let prefix = std::str::from_utf8(&encoded[..22]).unwrap();
    Ok(Some(format!("{byte}:{prefix}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_kept_tail_tokens_at_the_window_edges() {
        let dir = super::super::tests::temp("journal-tail");
        let file = dir.join("journal");
        assert_eq!(token(&file, 0).unwrap().as_deref(), Some("0"));
        assert_eq!(token(&file, 7).unwrap(), None);
        std::fs::write(&file, (0u8..128).collect::<Vec<_>>()).unwrap();
        for (byte, expected) in [
            (1, Some("1:bjQLnP-zepicpUTmu3gKLH")),
            (63, Some("63:Ka8mhv1TN0o2sIRmlMw0IX")),
            (64, Some("64:_eq5rPNxA2K9JljNyaKej5")),
            (65, Some("65:IKfshGhPf-Ekyzcn0ElzSr")),
            (128, Some("128:mvru8AXihpV-6aGKJIGnXH")),
            (129, None),
        ] {
            assert_eq!(token(&file, byte).unwrap().as_deref(), expected);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
