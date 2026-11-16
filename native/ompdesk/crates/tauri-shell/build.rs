#[path = "../shell/build/last_electron.rs"]
mod last_electron;

fn main() {
    last_electron::emit("../shell/last-electron.json");
    tauri_build::build();
}
