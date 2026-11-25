//! The OS readers; the only place this crate crosses into the OS.
#![allow(unsafe_code)]

#[cfg(target_os = "macos")]
mod mac;
#[cfg(windows)]
mod windows;

#[cfg(target_os = "macos")]
pub use mac::resolve_proxy;
#[cfg(windows)]
pub use windows::resolve_proxy;
