use std::io;

const PREFIX: &str = "ompdesk-wsl:";

pub(crate) fn valid_key(key: &str) -> bool {
    key.len() == 32
        && key
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn format_ref(key: &str) -> String {
    format!("{PREFIX}{key}")
}

/// None is an ordinary session file. A malformed reserved name is never a file or a fresh tab.
pub fn parse_ref(value: &str) -> Option<io::Result<&str>> {
    let (prefix, key) = value.split_at_checked(PREFIX.len())?;
    if !prefix.eq_ignore_ascii_case(PREFIX) {
        return None;
    }
    Some(if prefix == PREFIX && valid_key(key) {
        Ok(key)
    } else {
        Err(super::invalid("invalid WSL session reference"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_reserved_names_do_not_become_files() {
        let key = "0123456789abcdef0123456789abcdef";
        assert_eq!(parse_ref(&format_ref(key)).unwrap().unwrap(), key);
        for value in ["OMPDESK-WSL:bad", "ompdesk-wsl:", "ompdesk-wsl:../a.jsonl"] {
            assert!(parse_ref(value).unwrap().is_err());
        }
        for path in [r"C:\sessions\a.jsonl", "/p/ompdesk-wsl:x", "01234567890한"] {
            assert!(parse_ref(path).is_none());
        }
    }
}
