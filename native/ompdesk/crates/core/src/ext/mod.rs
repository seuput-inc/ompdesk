//! The extensions of this computer's omp, for the updater that keeps them current (was the rules of
//! `src/main/ext-update/`): what an MCP server's configured launch is (`ext.mcpClasses`), the row each marketplace,
//! plugin, skill and MCP server gets, with the method that keeps it current or the reason it is left alone
//! (`ext.seeds`), what the file a server's command resolves to says about itself (`ext.binaryFacts`), whether an
//! update must wait for a running server or CLI (`ext.defersWhileRunning`, `ext.cliWaitsForIdle`, `ext.updateRunning`), and the newest version in a
//! registry lookup's output (`ext.pipLatest`, `ext.registryLatest`).
//!
//! Main keeps the schedule, stock's inventory and upgrades, the spawn PATH lookup and package-manager commands.
//! CLI updates, MCP updates and setup all read installed package ownership through `ext.binaryFacts`.

mod binary;
mod install;
mod latest;
mod mcp;
mod running;
mod seeds;

use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::value::RawValue;

use crate::server::{Fault, Registry, Reply};

/// JavaScript's LineTerminator: what `.` does not match and `^` follows under the `m` flag.
fn is_line_end(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// The params as `T`. A mismatch says where it is and never what stood there: a server's arguments and URL, and
/// the command lines of the running processes, can carry a token.
fn params<T: DeserializeOwned>(params: &RawValue) -> Result<T, Fault> {
    serde_json::from_str(params.get()).map_err(|error| {
        Fault::new(
            "invalid_params",
            format!(
                "The parameters are not what the method takes ({:?} error at column {})",
                error.classify(),
                error.column()
            ),
        )
    })
}

#[derive(Deserialize)]
struct ClassesParams {
    servers: Vec<mcp::Server>,
}

#[derive(Deserialize)]
struct DefersParams {
    /// The owner's method, as the row names it.
    method: Option<String>,
    script: bool,
}

#[derive(Deserialize)]
struct OutputParams {
    output: String,
}

/// `ext.binaryFacts` in process (the tools hub's install reads), as the JSON the method answers.
pub(crate) fn binary_facts(params: serde_json::Value) -> Result<serde_json::Value, Fault> {
    let params: install::Params = serde_json::from_value(params)
        .map_err(|error| Fault::new("invalid_params", error.to_string()))?;
    serde_json::to_value(install::facts(&params))
        .map_err(|error| Fault::new("internal", error.to_string()))
}

pub fn register(registry: &mut Registry) {
    registry.add("ext.mcpClasses", |call| {
        Box::pin(async move {
            let params: ClassesParams = params(&call.params)?;
            let classes: Vec<_> = params.servers.iter().map(mcp::classify).collect();
            Reply::json(&classes)
        })
    });
    registry.add("ext.seeds", |call| {
        Box::pin(async move { Reply::json(&seeds::seeds(params(&call.params)?)) })
    });
    registry.add("ext.binaryFacts", |call| {
        Box::pin(async move {
            let params: install::Params = params(&call.params)?;
            let facts = tokio::task::spawn_blocking(move || install::facts(&params))
                .await
                .map_err(|_| Fault::new("internal", "The file read panicked"))?;
            Reply::json(&facts)
        })
    });
    registry.add("ext.defersWhileRunning", |call| {
        Box::pin(async move {
            let params: DefersParams = params(&call.params)?;
            Reply::json(&running::defers(params.method.as_deref(), params.script))
        })
    });
    registry.add("ext.cliWaitsForIdle", |call| {
        Box::pin(async move { Reply::json(&running::cli_defers(params(&call.params)?)) })
    });
    registry.add("ext.updateRunning", |call| {
        Box::pin(async move { Reply::json(&running::update_running(params(&call.params)?).await) })
    });
    registry.add("ext.pipLatest", |call| {
        Box::pin(async move {
            let params: OutputParams = params(&call.params)?;
            Reply::json(&latest::pip(&params.output)?)
        })
    });
    registry.add("ext.registryLatest", |call| {
        Box::pin(async move {
            let params: OutputParams = params(&call.params)?;
            Reply::json(&latest::registry(&params.output)?)
        })
    });
}

/// A table of `captured.json`: what the TypeScript answered for the same inputs before it was deleted.
#[cfg(test)]
fn captured(table: &str) -> Vec<serde_json::Value> {
    let rows: serde_json::Value = serde_json::from_str(include_str!("captured.json")).unwrap();
    rows[table].as_array().unwrap().clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refused_shape_tells_nothing_of_what_it_held() {
        // A server whose arguments came as one string: serde's own words would quote it.
        let text = r#"{"servers":[{"name":"s","type":"stdio","command":"npx","args":"--token=hunter2","url":null,"enabled":true}]}"#;
        let raw = RawValue::from_string(text.into()).unwrap();
        let fault = params::<ClassesParams>(&raw).err().unwrap();
        assert_eq!(fault.code, "invalid_params");
        assert!(!fault.message.contains("hunter2"), "{}", fault.message);
        assert!(fault.message.contains("column"), "{}", fault.message);
    }
}
