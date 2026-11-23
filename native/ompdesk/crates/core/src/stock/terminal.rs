use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

use super::shells::{self, Shell};
use crate::server::Fault;

#[derive(Deserialize)]
#[serde(untagged)]
enum Owner {
    Local(String),
    Peer {
        #[serde(rename = "deviceId")]
        device: String,
        rtab: String,
    },
}

#[derive(Deserialize)]
struct Request<'a> {
    owner: Owner,
    #[serde(borrow)]
    cwd: Option<&'a RawValue>,
    #[serde(borrow)]
    operation: Option<&'a RawValue>,
    #[serde(borrow)]
    env: Option<&'a RawValue>,
}

#[derive(Serialize)]
struct Params<'a> {
    owner: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    cwd: Option<&'a RawValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    operation: Option<&'a RawValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    env: Option<&'a RawValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    shell: Option<Shell>,
}

#[derive(Serialize)]
struct Line<'a> {
    id: u64,
    method: &'static str,
    params: Params<'a>,
}

pub(super) fn frame(
    id: u64,
    bytes: &[u8],
    dispose: bool,
    choose_shell: bool,
) -> Result<Vec<u8>, Fault> {
    let request: Request = serde_json::from_slice(bytes)
        .map_err(|_| Fault::new("stock_invalid", "Invalid terminal operation"))?;
    let owner = match request.owner {
        Owner::Local(owner) => owner,
        Owner::Peer { device, rtab } => format!("peer:{device}:{rtab}"),
    };
    #[derive(Deserialize)]
    struct Choice {
        shell: String,
    }
    let shell = if choose_shell {
        request
            .operation
            .and_then(|op| serde_json::from_str::<Choice>(op.get()).ok())
            .and_then(|choice| {
                shells::list()
                    .into_iter()
                    .find(|shell| shell.path == choice.shell)
            })
    } else {
        None
    };
    let mut line = serde_json::to_vec(&Line {
        id,
        method: if dispose {
            "terminal.dispose"
        } else {
            "terminal.request"
        },
        params: Params {
            owner,
            cwd: request.cwd,
            operation: request.operation,
            env: request.env,
            shell,
        },
    })
    .map_err(|_| Fault::new("stock_invalid", "Invalid terminal operation"))?;
    line.push(b'\n');
    Ok(line)
}
