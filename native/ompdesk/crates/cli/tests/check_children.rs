use std::fs;
use std::path::Path;

#[test]
fn cli_and_checks_construct_commands_only_in_the_shared_helper() {
    let crates = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let helper = crates.join("checks/src/sys.rs");
    let mut dirs = vec![crates.join("cli/src"), crates.join("checks/src")];
    let mut constructors = 0;
    while let Some(dir) = dirs.pop() {
        for entry in fs::read_dir(dir).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            if entry.file_type().unwrap().is_dir() {
                dirs.push(path);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                let source = fs::read_to_string(&path).unwrap();
                for (at, _) in source.match_indices("Command::new") {
                    let in_helper = path == helper
                        && source[..at]
                            .lines()
                            .rev()
                            .take_while(|line| !line.starts_with('}'))
                            .any(|line| line.contains("fn child_command("));
                    assert!(in_helper, "use child_command in {}", path.display());
                    constructors += 1;
                }
            }
        }
    }
    assert_eq!(constructors, 1, "expected one constructor in child_command");
}

#[cfg(windows)]
#[test]
fn a_detached_check_child_reports_no_console_window_through_its_output_pipes() {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    let dir = std::env::temp_dir().join(format!("ompdesk-check-console-{}", std::process::id()));
    fs::create_dir(&dir).unwrap();
    let work = dir.join("work");
    fs::create_dir(&work).unwrap();
    fs::write(
        work.join("Probe.cs"),
        r#"using System;
using System.Runtime.InteropServices;
public static class Probe {
    [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
    public static void Report() {
        Console.WriteLine("console-window=" + GetConsoleWindow());
        Console.Error.WriteLine("probe stderr");
    }
}"#,
    )
    .unwrap();
    let system32 = Path::new(&std::env::var_os("SystemRoot").unwrap()).join("System32");
    let powershell = system32.join(r"WindowsPowerShell\v1.0\powershell.exe");
    let result = Command::new(env!("CARGO_BIN_EXE_ompdesk"))
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW for the test's foreground CLI.
        .args(["check", "--light", "--"])
        .arg(powershell)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$ErrorActionPreference = 'Stop'; Add-Type -Path ./Probe.cs; [Probe]::Report()",
        ])
        .current_dir(&work)
        // This PowerShell probe does not depend on the runner's Node or Bun installation.
        .env("PATH", system32)
        .env("OMPDESK_CHECKS_DIR", dir.join("store"))
        .env("OMPDESK_HEAVY_DIR", dir.join("heavy"))
        .env("TMP", &dir)
        .env("TEMP", &dir)
        .env_remove("OMPDESK_HEAVY_HELD")
        .env_remove("OMPDESK_CHECK_RUN")
        .output();
    fs::remove_dir_all(dir).unwrap();
    let out = result.unwrap();
    let log = String::from_utf8_lossy(&out.stdout);
    assert!(out.status.success(), "{out:?}");
    assert!(log.lines().any(|l| l == "console-window=0"), "{log}");
    assert!(log.lines().any(|l| l == "probe stderr"), "{log}");
}
