pub fn emit(file: &str) {
    println!("cargo:rerun-if-changed={file}");
    let tag = std::fs::read_to_string(file)
        .ok()
        .and_then(|text| {
            let after = text.split_once("\"tag\"")?.1;
            let value = after.split_once('"')?.1;
            Some(value.split_once('"')?.0.trim().to_string())
        })
        .unwrap_or_default();
    if tag.is_empty() && std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        panic!(
            "{file} has no \"tag\": the macOS launcher needs the last Electron release to restore"
        );
    }
    println!("cargo:rustc-env=OMPDESK_LAST_ELECTRON_TAG={tag}");
}
