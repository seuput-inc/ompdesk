use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::server::{Fault, Reply};

#[derive(Deserialize)]
pub(super) struct Input {
    file: PathBuf,
    windows: bool,
}

const COMMON: &[&str] = &[
    "app", "command", "sh", "jar", "bat", "cmd", "exe", "com", "lnk", "url", "py", "pyw", "pyz",
    "pl", "rb",
];
const MAC: &[&str] = &[
    "tool",
    "terminal",
    "workflow",
    "action",
    "saver",
    "pkg",
    "mpkg",
    "dmg",
    "scpt",
    "scptd",
    "applescript",
    "webloc",
    "inetloc",
    "fileloc",
    "zsh",
    "bash",
    "csh",
    "ksh",
    "fish",
    "prefpane",
    "appex",
    "xpc",
];
const WINDOWS: &[&str] = &[
    "ps1",
    "psm1",
    "ps1xml",
    "psc1",
    "vbs",
    "vbe",
    "js",
    "jse",
    "wsf",
    "wsh",
    "hta",
    "msi",
    "msp",
    "msc",
    "msix",
    "msixbundle",
    "appx",
    "appxbundle",
    "appref-ms",
    "application",
    "gadget",
    "reg",
    "scr",
    "pif",
    "cpl",
    "scf",
    "diagcab",
    "library-ms",
    "search-ms",
    "settingcontent-ms",
    "website",
    "appinstaller",
    "chm",
    "xll",
    "wsc",
    "sct",
    "theme",
    "themepack",
];

fn launcher_name(path: &Path, windows: bool) -> bool {
    let Some(name) = path.file_name() else {
        return false;
    };
    let bytes = name.as_encoded_bytes();
    // Win32 opens the name without terminal dots and spaces.
    let end = if windows {
        bytes
            .iter()
            .rposition(|b| !matches!(b, b'.' | b' '))
            .map_or(0, |i| i + 1)
    } else {
        bytes.len()
    };
    let Some(dot) = bytes[..end].iter().rposition(|&b| b == b'.') else {
        return false;
    };
    if dot == 0 {
        return false;
    }
    let extension = &bytes[dot + 1..end];
    let mut table = COMMON.iter().chain(if windows { WINDOWS } else { MAC });
    if extension.is_ascii() {
        return table.any(|s| extension.eq_ignore_ascii_case(s.as_bytes()));
    }
    std::str::from_utf8(extension).is_ok_and(|s| {
        let lower = s.to_lowercase();
        table.any(|&s| s == lower)
    })
}

pub(super) fn classify(input: Input) -> Result<Reply, Fault> {
    if launcher_name(&input.file, input.windows) {
        return Reply::json(&true);
    }
    let Ok(real) = input.file.canonicalize() else {
        return Reply::json(&false);
    };
    if launcher_name(&real, input.windows) {
        return Reply::json(&true);
    }
    #[cfg(unix)]
    if !input.windows {
        use std::os::unix::fs::PermissionsExt;
        return Reply::json(
            &real
                .metadata()
                .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0),
        );
    }
    Reply::json(&false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_match_the_host_before_the_filesystem_probe() {
        for (name, windows, posix) in [
            ("a.exe.", true, false),
            (".exe", false, false),
            ("a.app/", true, true),
            ("a.js", true, false),
            ("x.", false, false),
            ("name.py", true, true),
            ("file.theme", true, false),
            ("name.dmg", false, true),
            ("x.html", false, false),
        ] {
            assert_eq!(launcher_name(Path::new(name), true), windows, "{name}");
            assert_eq!(launcher_name(Path::new(name), false), posix, "{name}");
        }
    }
}
