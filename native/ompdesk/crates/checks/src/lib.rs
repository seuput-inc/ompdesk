//! What keeps long checks from eating hours: the computer's heavy slots (`heavy`), checks that rerun only what their
//! changed inputs require and survive a restart (`check`), and the local commands of the `ompdesk` CLI (`cli`).

mod board;
pub mod check;
pub mod cli;
mod flaky;
pub mod heavy;
mod inputs;
pub mod keep;
mod runner;
mod store;
mod sys;
mod watch;

/// Free and total bytes of a volume; the core's low-disk notice reads it too (`disk/low_space.rs`).
pub use sys::disk_space;
pub use watch::Watch;
