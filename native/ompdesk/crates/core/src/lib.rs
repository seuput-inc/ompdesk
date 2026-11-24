//! `ompdesk-core`: the Rust process OMPdesk's main process moves into piece by piece. Main spawns it with open
//! stdio and speaks JSON lines to it (`wire`); each subsystem registers its methods (`server`). It is a library over
//! any `AsyncRead`/`AsyncWrite`, so tests drive it in process; the binary serves stdio.

pub mod agentctl;
pub mod aimemory;
mod archive;
pub mod autopilot;
pub mod browsers;
pub mod care;
pub mod clients;
pub mod clock;
pub mod control;
mod diagnostic_bundle;
pub mod disk;
pub mod ext;
pub mod fs;
pub mod gh;
pub mod git;
mod http;
pub mod hub;
pub mod ipc;
mod json;
pub mod keepawake;
mod logs;
pub mod mcp_hub;
pub mod memory;
mod memsync;
pub mod models;
pub mod omp;
pub mod owner;
pub mod pool;
pub mod ports;
pub mod prefs;
pub mod procs;
mod proxy;
pub mod remote;
pub mod remotebytes;
pub mod repo_images;
mod restart;
pub mod resume;
pub mod routines;
mod run;
pub mod schedules;
pub mod server;
pub mod sessions;
pub mod setup;
pub mod sidecar;
pub mod ssh;
mod stats;
pub mod stock;
pub mod supervise;
mod sys;
pub mod tailscale;
// shortcut: the contract the units T2.2-T2.5 fill is unused until they land; drop this allow with the last of them.
#[allow(dead_code)]
mod tools;
mod turn_edits;
mod update_feed;
pub mod upkeep;
#[cfg(windows)]
mod user_app;
mod visuals;
pub mod web;
#[cfg(windows)]
mod windows_executable;
pub mod wire;

pub use server::{registry, serve, serve_as};

/// Lowercase hex of a digest, as node's `digest('hex')` writes it (RustCrypto's 0.11 digests have no `LowerHex`).
pub(crate) fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut out, byte| {
            let _ = write!(out, "{byte:02x}");
            out
        })
}

#[cfg(windows)]
pub use sys::{end_children_with_this_process, ensure_console};
