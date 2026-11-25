#[path = "../shell/build/last_electron.rs"]
mod last_electron;

fn main() {
    last_electron::emit("../shell/last-electron.json");
    // tauri.conf.json's `version` is the app's package.json, which tauri-build writes into the Windows version resource
    // (ProductVersion): a version bump must re-run this script.
    println!("cargo:rerun-if-changed=../../../../package.json");
    // tauri-codegen embeds Info.plist (merged with CFBundleName and the versions) as the shell's __TEXT,__info_plist.
    // The shell runs as Contents/MacOS/ompdesk-shell, not the bundle's CFBundleExecutable, so Foundation takes the main
    // bundle's identity from that embedded copy: without its CFBundleIdentifier the identifier is nil and
    // UNUserNotificationCenter refuses every notification (0.133.0's `notification.failed`; package-mac.ts checks it).
    println!("cargo:rerun-if-changed=Info.plist");
    tauri_build::build();
}
