#[path = "../shell/build/last_electron.rs"]
mod last_electron;

fn main() {
    last_electron::emit("../shell/last-electron.json");
    // tauri.conf.json's `version` is the app's package.json, which tauri-build writes into the Windows version resource
    // (ProductVersion): a version bump must re-run this script.
    println!("cargo:rerun-if-changed=../../../../package.json");
    tauri_build::build();
}
