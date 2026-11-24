//! `cli-tools/plans.test.ts` (the owners' commands, the newest version read out of each check), `detect.test.ts`
//! "findBrew" and the CLI updater's `runCheckProcess` cases, on the shared module.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use tempfile::TempDir;

use super::*;

/// A folder holding a `#!/bin/sh` file for each of `names` (executable on POSIX).
fn fake_bin(names: &[&str]) -> TempDir {
    let dir = tempfile::Builder::new()
        .prefix("omp-cli-plans-")
        .tempdir()
        .unwrap();
    for name in names {
        script(&dir.path().join(name));
    }
    dir
}

fn script(file: &Path) {
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, "#!/bin/sh\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}

fn s(path: impl AsRef<Path>) -> String {
    path.as_ref().to_string_lossy().into_owned()
}

fn tools(platform: &str, path_env: impl Into<String>) -> PlanTools {
    PlanTools {
        platform: platform.to_owned(),
        path_env: path_env.into(),
    }
}

fn args(command: &Option<CliCommand>) -> Vec<String> {
    command.as_ref().unwrap().spawn.args.clone()
}

fn npm_owner(prefix: &str) -> Value {
    json!({"method": "npm", "name": "@openai/codex", "prefix": prefix, "root": format!("{prefix}/lib/node_modules/@openai/codex")})
}

#[test]
fn asks_the_npm_that_owns_the_prefix_falling_back_to_the_first_npm_on_path() {
    // checkCommand: "asks the npm that owns the prefix, falling back to the first npm on PATH, aimed at the package"
    let prefix = fake_bin(&[]);
    script(&prefix.path().join("bin").join("npm"));
    let on_path = fake_bin(&["npm"]);
    let own = owner_check_command(
        &npm_owner(&s(prefix.path())),
        &tools("darwin", s(on_path.path())),
    );
    assert_eq!(
        own.unwrap().spawn,
        SpawnSpec {
            file: s(prefix.path().join("bin").join("npm")),
            args: vec!["view".into(), "@openai/codex".into(), "version".into()],
            shell: false,
            input_file: None,
        }
    );
    let bare = fake_bin(&[]);
    let fallback = owner_check_command(
        &npm_owner(&s(bare.path())),
        &tools("darwin", s(on_path.path())),
    );
    assert_eq!(fallback.unwrap().spawn.file, s(on_path.path().join("npm")));
    assert_eq!(
        owner_check_command(&npm_owner(&s(bare.path())), &tools("darwin", "")),
        None
    );
}

#[test]
fn runs_windows_npm_cmd_through_cmd_exe_quoted_and_never_the_bare_posix_npm() {
    // checkCommand: "runs Windows' npm.cmd through cmd.exe, quoted, and never the bare POSIX `npm` script beside it"
    let prefix = fake_bin(&["npm.cmd", "npm"]);
    let prefix_text = s(prefix.path());
    let owner = json!({"method": "npm", "name": "@openai/codex", "prefix": prefix_text, "root": s(prefix.path().join("node_modules"))});
    let win = tools("win32", "");
    let npm = s(prefix.path().join("npm.cmd"));
    assert_eq!(
        owner_check_command(&owner, &win).unwrap().spawn,
        SpawnSpec {
            file: format!("\"{npm}\""),
            args: vec![
                "\"view\"".into(),
                "\"@openai/codex\"".into(),
                "\"version\"".into()
            ],
            shell: true,
            input_file: None,
        }
    );
    assert_eq!(
        owner_update_command(&owner, Some("0.51.0"), &win)
            .unwrap()
            .spawn,
        SpawnSpec {
            file: format!("\"{npm}\""),
            args: vec![
                "\"install\"".into(),
                "\"-g\"".into(),
                "\"--prefix\"".into(),
                format!("\"{prefix_text}\""),
                "\"@openai/codex@0.51.0\"".into(),
            ],
            shell: true,
            input_file: None,
        }
    );
    let bare_only = fake_bin(&["npm"]);
    let elsewhere = fake_bin(&[]);
    assert_eq!(
        owner_check_command(
            &npm_owner(&s(elsewhere.path())),
            &tools("win32", s(bare_only.path()))
        ),
        None
    );
}

#[test]
fn asks_bun_for_a_bun_global_with_its_bun_install_in_a_package_dir() {
    // checkCommand: "asks Bun for a Bun global, with its BUN_INSTALL, in a package dir (bun pm view needs a package.json)"
    let root = fake_bin(&[]);
    script(&root.path().join("bin").join("bun"));
    let bun_root = s(root.path());
    let owner = json!({"method": "bun", "name": "@google/gemini-cli", "bunRoot": bun_root, "root": format!("{bun_root}/install/global/node_modules/@google/gemini-cli")});
    let check = owner_check_command(&owner, &tools("darwin", "")).unwrap();
    assert_eq!(check.spawn.file, s(root.path().join("bin").join("bun")));
    assert_eq!(
        check.spawn.args,
        ["pm", "view", "@google/gemini-cli", "version"]
    );
    assert_eq!(check.env.get("BUN_INSTALL"), Some(&bun_root));
    assert!(check.package_dir);
    let on_path = fake_bin(&["npm"]);
    let npm = owner_check_command(
        &npm_owner(&s(on_path.path())),
        &tools("darwin", s(on_path.path())),
    );
    assert!(!npm.unwrap().package_dir);
}

#[test]
fn asks_brew_for_the_formula_or_the_cask_and_winget_for_the_id() {
    // checkCommand: "asks brew for the formula or the cask, and winget for the id"
    let brew = json!({"method": "brew", "name": "gh", "brew": "/opt/homebrew/bin/brew"});
    let cask =
        json!({"method": "brew-cask", "name": "claude-code", "brew": "/opt/homebrew/bin/brew"});
    let mac = tools("darwin", "");
    assert_eq!(
        args(&owner_check_command(&brew, &mac)),
        ["outdated", "--json=v2", "gh"]
    );
    assert_eq!(
        args(&owner_check_command(&cask, &mac)),
        ["outdated", "--json=v2", "--cask", "claude-code"]
    );
    let bin = fake_bin(&["winget.exe"]);
    let winget = json!({"method": "winget", "id": "GitHub.cli"});
    assert_eq!(
        args(&owner_check_command(
            &winget,
            &tools("win32", s(bin.path()))
        )),
        [
            "list",
            "--id",
            "GitHub.cli",
            "-e",
            "--upgrade-available",
            "--accept-source-agreements",
            "--disable-interactivity"
        ]
    );
    assert_eq!(
        owner_check_command(&json!({"method": "managed", "item": "gh"}), &mac),
        None
    );
    assert_eq!(owner_check_command(&json!({"method": "self"}), &mac), None);
}

#[test]
fn reads_npms_plain_version_and_rejects_an_answer_without_one() {
    // parseLatest: "reads npm's plain version and rejects an answer without one"
    let selfish = json!({"method": "self"});
    assert_eq!(
        parse_latest(&selfish, "0.51.0\n", Some("0.50.1")),
        Ok("0.51.0".into())
    );
    let refused = parse_latest(&selfish, "npm ERR! 404 Not Found\n", Some("0.50.1")).unwrap_err();
    assert!(refused.contains("404"), "{refused}");
    assert_eq!(
        parse_latest(&selfish, "  \n", None),
        Err("no version in the registry's answer".into())
    );
}

#[test]
fn reads_homebrews_outdated_list_or_the_installed_version_when_nothing_is_outdated() {
    // parseLatest: "reads Homebrew's outdated list: the formula's current_version, or the installed one when nothing is outdated"
    let owner = json!({"method": "brew", "name": "gh", "brew": "brew"});
    let outdated = json!({"formulae": [{"name": "gh", "installed_versions": ["2.96.0"], "current_version": "2.99.1"}], "casks": []});
    assert_eq!(
        parse_latest(&owner, &outdated.to_string(), Some("2.96.0")),
        Ok("2.99.1".into())
    );
    let empty = json!({"formulae": [], "casks": []}).to_string();
    assert_eq!(
        parse_latest(&owner, &empty, Some("2.96.0")),
        Ok("2.96.0".into())
    );
    assert_eq!(
        parse_latest(&owner, &empty, None),
        Err("brew outdated said nothing about gh".into())
    );
    let cask = json!({"method": "brew-cask", "name": "claude-code", "brew": "brew"});
    let listed = json!({"formulae": [], "casks": [{"name": "claude-code", "installed_versions": ["2.0.1"], "current_version": "2.1.0"}]});
    assert_eq!(
        parse_latest(&cask, &listed.to_string(), Some("2.0.1")),
        Ok("2.1.0".into())
    );
}

#[test]
fn reads_wingets_table_the_last_version_on_the_packages_line() {
    // parseLatest: "reads winget's table: the last version on the package's line"
    let owner = json!({"method": "winget", "id": "GitHub.cli"});
    let table = "Name        Id          Version Available Source\n-------------------------------\nGitHub CLI  GitHub.cli  2.96.0  2.99.1    winget\n";
    assert_eq!(
        parse_latest(&owner, table, Some("2.96.0")),
        Ok("2.99.1".into())
    );
    assert_eq!(
        parse_latest(
            &owner,
            "No installed package found matching input criteria.\n",
            Some("2.96.0")
        ),
        Ok("2.96.0".into())
    );
}

#[test]
fn updates_an_npm_global_with_the_npm_of_its_prefix_pinned_to_the_version_found() {
    // updateCommand: "updates an npm global with the npm that owns its prefix, pinned to the version the check found"
    let prefix = fake_bin(&[]);
    script(&prefix.path().join("bin").join("npm"));
    let owner = npm_owner(&s(prefix.path()));
    let mac = tools("darwin", "");
    assert_eq!(
        args(&owner_update_command(&owner, Some("0.51.0"), &mac)),
        [
            "install",
            "-g",
            "--prefix",
            &s(prefix.path()),
            "@openai/codex@0.51.0"
        ]
    );
    assert_eq!(
        args(&owner_update_command(&owner, None, &mac))
            .last()
            .unwrap(),
        "@openai/codex@latest"
    );
}

#[test]
fn updates_a_bun_global_in_its_bun_install_and_brew_and_winget_by_their_ids() {
    // updateCommand: "updates a Bun global in its own BUN_INSTALL, and brew and winget by their package ids"
    let root = fake_bin(&[]);
    script(&root.path().join("bin").join("bun"));
    let bun_root = s(root.path());
    let bun = json!({"method": "bun", "name": "@google/gemini-cli", "bunRoot": bun_root, "root": format!("{bun_root}/x")});
    let mac = tools("darwin", "");
    let update = owner_update_command(&bun, Some("0.5.0"), &mac).unwrap();
    assert_eq!(update.spawn.file, s(root.path().join("bin").join("bun")));
    assert_eq!(
        update.spawn.args,
        ["install", "-g", "@google/gemini-cli@0.5.0"]
    );
    assert_eq!(update.env.get("BUN_INSTALL"), Some(&bun_root));
    let brew = json!({"method": "brew", "name": "gh", "brew": "/opt/homebrew/bin/brew"});
    let upgrade = owner_update_command(&brew, Some("2.99.1"), &mac).unwrap();
    assert_eq!(
        (upgrade.spawn.file.as_str(), upgrade.spawn.args.clone()),
        (
            "/opt/homebrew/bin/brew",
            vec!["upgrade".to_owned(), "gh".to_owned()]
        )
    );
    assert_eq!(
        upgrade
            .env
            .get("HOMEBREW_NO_AUTO_UPDATE")
            .map(String::as_str),
        Some("1")
    );
    let cask =
        json!({"method": "brew-cask", "name": "claude-code", "brew": "/opt/homebrew/bin/brew"});
    assert_eq!(
        args(&owner_update_command(&cask, None, &mac)),
        ["upgrade", "--cask", "claude-code"]
    );
    let bin = fake_bin(&["winget.exe"]);
    let winget = json!({"method": "winget", "id": "GitHub.cli"});
    assert_eq!(
        args(&owner_update_command(
            &winget,
            None,
            &tools("win32", s(bin.path()))
        )),
        [
            "upgrade",
            "--id",
            "GitHub.cli",
            "-e",
            "--accept-source-agreements",
            "--accept-package-agreements",
            "--disable-interactivity"
        ]
    );
    assert_eq!(
        owner_update_command(&winget, None, &tools("win32", "")),
        None
    );
}

#[test]
fn refuses_an_owner_whose_package_manager_is_nowhere() {
    // updateCommand: "refuses an owner whose package manager is nowhere (no guessing a command)"
    assert_eq!(
        owner_update_command(&npm_owner("/nowhere"), Some("1.0.0"), &tools("darwin", "")),
        None
    );
}

#[test]
fn finds_brew_on_path_never_on_windows() {
    // findBrew: "finds brew on PATH, never on Windows"
    let bin = fake_bin(&["brew"]);
    let path = s(bin.path());
    assert_eq!(
        find_brew_in(&path, "darwin", &[]),
        Some(s(bin.path().join("brew")))
    );
    assert_eq!(find_brew_in("", "darwin", &[]), None);
    assert_eq!(find_brew_in(&path, "win32", &[]), None);
    // Homebrew's prefixes count when PATH omits them; a test launch's empty list names none.
    assert_eq!(
        find_brew_in("", "darwin", std::slice::from_ref(&path)),
        Some(s(bin.path().join("brew")))
    );
    assert_eq!(
        brew_dirs_from(None),
        ["/opt/homebrew/bin", "/usr/local/bin"]
    );
    assert!(brew_dirs_from(Some(String::new())).is_empty());
}

#[test]
fn looks_a_tool_up_by_its_launcher_names_never_the_bare_name_on_windows() {
    // spawn.ts: launcherNames, findOnPath, spawnCommand/spawnArgs/needsShell
    assert_eq!(launcher_names("codex", "win32"), ["codex.exe", "codex.cmd"]);
    assert_eq!(launcher_names("codex", "darwin"), ["codex"]);
    assert_eq!(executable_name("bun", "win32"), "bun.exe");
    let bin = fake_bin(&["codex", "codex.cmd"]);
    let path = s(bin.path());
    assert_eq!(
        find_on_path(&launcher_names("codex", "win32"), &path, "win32", &[]),
        Some(s(bin.path().join("codex.cmd")))
    );
    std::fs::create_dir(bin.path().join("dir.exe")).unwrap();
    assert_eq!(find_on_path(&["dir.exe".into()], &path, "win32", &[]), None);
    assert!(needs_shell("C:\\x\\NPM.CMD", "win32"));
    assert!(!needs_shell("/x/npm.cmd", "darwin"));
    assert_eq!(
        spawn_spec("C:\\a b\\npm.cmd", &["say \"hi\"".into()], "win32"),
        SpawnSpec {
            file: "\"C:\\a b\\npm.cmd\"".into(),
            args: vec!["\"say \"\"hi\"\"\"".into()],
            shell: true,
            input_file: None,
        }
    );
}

#[test]
fn reads_versions_as_the_typescript_did() {
    // shared/version.ts isNewer, omp-runtime.ts parseOmpVersion
    assert_eq!(
        parse_omp_version("gh version 2.96.0 (2026-01-01)"),
        Some("2.96.0".into())
    );
    assert_eq!(parse_omp_version("v1.2x3.4.5.6"), Some("3.4.5".into()));
    assert_eq!(parse_omp_version("1.2"), None);
    assert_eq!(versions("a 1.2.3 b 4.5.6.7"), ["1.2.3", "4.5.6"]);
    assert!(is_newer("0.10.0", Some("0.9.0")));
    assert!(!is_newer("0.9.0", Some("0.10.0")));
    assert!(is_newer("1.0.0", None));
    assert!(!is_newer("1.0.0", Some(" 1.0.0 ")));
    assert!(
        is_newer("1.0rc1", Some("1.0rc0")),
        "unordered versions count as newer when they differ"
    );
    assert!(!is_newer("abc", Some("abc")));
}

// ---- runCheckProcess, on a real process ------------------------------------------------------------------------------

/// This test binary as a check: prints its cwd, its `package.json` and its `BUN_INSTALL`.
#[test]
#[ignore = "a stand-in the tests start"]
fn check_stand_in() {
    let pkg = std::fs::read_to_string("package.json").ok();
    println!(
        "{}",
        json!({"cwd": s(std::env::current_dir().unwrap()), "pkg": pkg, "root": std::env::var("BUN_INSTALL").ok()})
    );
}

async fn probe(package_dir: bool) -> Value {
    let check = CliCommand {
        package_dir,
        env: Env::from([("BUN_INSTALL".to_owned(), "/b".to_owned())]),
        ..command(
            &s(std::env::current_exe().unwrap()),
            &[
                "tools::spawn::tests::check_stand_in".into(),
                "--exact".into(),
                "--ignored".into(),
                "--nocapture".into(),
                "--test-threads=1".into(),
            ],
        )
    };
    let output = run_check(&check, &std::env::vars().collect())
        .await
        .unwrap();
    // libtest prints the stand-in's line after its own `test … ... ` on the same line.
    let line = output
        .lines()
        .find_map(|line| line.find('{').map(|at| &line[at..]))
        .unwrap();
    serde_json::from_str(line).unwrap()
}

#[tokio::test]
async fn runs_a_package_dir_check_in_a_private_temp_dir_holding_an_empty_package_json() {
    // runCheckProcess: "runs a package-dir check (bun pm view) in a private temp dir holding an empty package.json, removed after"
    let out = probe(true).await;
    assert_eq!(out["pkg"].as_str().map(str::trim), Some("{}"));
    assert_eq!(out["root"], "/b");
    let cwd = PathBuf::from(out["cwd"].as_str().unwrap());
    assert!(
        cwd.file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("ompdesk-cli-check-")
    );
    assert!(!cwd.exists(), "removed after");
}

#[tokio::test]
async fn leaves_any_other_check_in_the_cores_own_cwd() {
    // runCheckProcess: "leaves any other check in main's own cwd"
    let out = probe(false).await;
    assert_eq!(
        std::fs::canonicalize(out["cwd"].as_str().unwrap()).unwrap(),
        std::fs::canonicalize(std::env::current_dir().unwrap()).unwrap()
    );
}

#[tokio::test]
async fn a_check_that_cannot_start_or_fails_answers_its_own_reason() {
    let missing = command("/nowhere/ompdesk-no-such-tool", &[]);
    let reason = run_check(&missing, &Env::new()).await.unwrap_err();
    assert!(
        reason.starts_with("spawn /nowhere/ompdesk-no-such-tool"),
        "{reason}"
    );
}
