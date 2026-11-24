//! The `ompdesk-core` binary: serves the core's methods over stdio until main closes its stdin, then exits 0. Only
//! frames go to stdout; diagnostics go to stderr as plain lines. The processes it starts end with it: on Windows through
//! the job object it joins first; on POSIX main kills its process group once it is gone. Run by ssh as its askpass
//! helper instead (`ssh/askpass.rs`), it asks the core that started that ssh and prints the answer. Run with
//! `--supervise` (`supervise.rs`), it holds one command for main and ends its tree when main's pipe closes.

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
    let served = runtime.block_on(async {
        // Main's synchronous calls (the pool, turn resume) come over their own connection.
        ompdesk_core::hub::listen_from_env();
        ompdesk_core::serve(
            tokio::io::stdin(),
            tokio::io::stdout(),
            ompdesk_core::registry(),
        )
        .await
    });
    // A preference main changed before it closed stdin is on disk before the process ends (main kills it after 5 s).
    ompdesk_core::prefs::flush(std::time::Duration::from_secs(4));
    match served {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("ompdesk-core: {error}");
            ExitCode::FAILURE
        }
    }
}
