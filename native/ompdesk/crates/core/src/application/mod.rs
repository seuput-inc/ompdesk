//! Native application composition. Only authenticated transports issue callers and domain ownership.

pub mod accounts;
pub mod callers;
pub(crate) mod command_start;
pub(crate) mod dispatch_policy;
pub mod frames;
pub(crate) mod local_sources;
pub mod memory_host;
pub(crate) mod observed_cards;
pub mod outcomes;
pub mod prefs;
pub mod proxy;
pub mod readiness;
pub mod requests;
pub mod runtime_log;
pub mod secrets;
pub mod services;
pub mod sessions;
pub mod setup_host;
pub(crate) mod source;
pub(crate) mod source_events;
pub mod stock_launcher;
