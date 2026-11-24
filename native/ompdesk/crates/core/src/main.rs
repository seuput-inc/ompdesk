//! The `ompdesk-core` binary: serves the core's methods over stdio until its stdin closes, then exits 0. Only frames go
//! to stdout; diagnostics go to stderr as plain lines. The processes it starts end with it: on Windows through the job
//! object it joins first; on POSIX its owner kills its process group once it is gone. Its stdio is its owner's
//! (`owner.rs`) when `OMPDESK_STDIO_OWNER` is set; main then speaks over its own connection (`clients.rs`). Run by ssh
//! as its askpass helper instead (`ssh/askpass.rs`), it asks the core that started that ssh and prints the answer. Run
//! with `--supervise` (`supervise.rs`), it holds one command for main and ends its tree when main's pipe closes; with
//! `--own`, it is the owner of the cores its parent asks for over its stdio (`owner.rs`, where no shell is).

use std::process::ExitCode;

fn main() -> ExitCode {
    // Main starts this binary beside every supervised command; it joins no job of its own, because a command's
    // descendant may be meant to outlive it.
    if std::env::args_os()
        .nth(1)
        .is_some_and(|arg| arg == "--supervise")
    {
        std::process::exit(ompdesk_core::supervise::run());
    }
    // The owner joins no job: the cores it starts must not die with it, but end with their stdin's end.
    if std::env::args_os().nth(1).is_some_and(|arg| arg == "--own") {
        std::process::exit(ompdesk_core::owner::serve_stdio());
    }
    // An ssh the core started runs this binary as its `SSH_ASKPASS` helper.
    if let Some(code) = ompdesk_core::ssh::askpass_helper() {
        return ExitCode::from(code);
    }
    #[cfg(windows)]
    ompdesk_core::ensure_console();
    #[cfg(windows)]
    if let Err(error) = ompdesk_core::end_children_with_this_process() {
        eprintln!("ompdesk-core: no job object, so a git it starts may outlive it: {error}");
    }
    let mut args = std::env::args_os().skip(1);
    let mcp_hub = args.next().is_some_and(|arg| arg == "--mcp-hub");
    if mcp_hub && args.next().is_some() {
        eprintln!("--mcp-hub takes no arguments");
        return ExitCode::FAILURE;
    }
    let mut builder = if mcp_hub {
        tokio::runtime::Builder::new_current_thread()
    } else {
        tokio::runtime::Builder::new_multi_thread()
    };
    let runtime = match builder.enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("ompdesk-core: cannot start its runtime: {error}");
            return ExitCode::FAILURE;
        }
    };
    if mcp_hub {
        return match runtime.block_on(ompdesk_core::mcp_hub::run()) {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("mcp-hub: {error}");
                if error.kind() == std::io::ErrorKind::InvalidInput {
                    ExitCode::from(2)
                } else {
                    ExitCode::FAILURE
                }
            }
        };
    }
    // The owner's stdio carries none of main's work: the process-wide sinks report on main's own connection.
    let stdio_is_main = std::env::var_os("OMPDESK_STDIO_OWNER").is_none();
    let served = runtime.block_on(async {
        // Main's synchronous calls (the pool, turn resume) come over their own connection.
        ompdesk_core::hub::listen_from_env();
        // More clients of the methods stdio serves, when the core's owner names where (`clients.rs`).
        ompdesk_core::clients::listen_from_env();
        let served = ompdesk_core::serve_as(
            tokio::io::stdin(),
            tokio::io::stdout(),
            ompdesk_core::registry(),
            stdio_is_main,
        )
        .await;
        ompdesk_core::clients::wind_down().await;
        served
    });
    // A preference or a device's counts main changed before it closed stdin are on disk before the process ends
    // (main kills it after 5 s).
    ompdesk_core::prefs::flush(std::time::Duration::from_secs(4));
    ompdesk_core::remote::store::flush();
    match served {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("ompdesk-core: {error}");
            ExitCode::FAILURE
        }
    }
}
