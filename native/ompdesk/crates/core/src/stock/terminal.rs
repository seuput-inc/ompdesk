use std::borrow::Cow;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

use super::lease::Leases;
use super::shells::{self, Shell};
use crate::server::Fault;

#[derive(Deserialize)]
#[serde(untagged)]
enum Owner<'a> {
    Local(#[serde(borrow)] Cow<'a, str>),
    Peer {
        #[serde(rename = "deviceId")]
        device: String,
        rtab: String,
    },
}

#[derive(Deserialize)]
struct Request<'a> {
    #[serde(borrow)]
    owner: Owner<'a>,
    #[serde(borrow)]
    cwd: Option<&'a RawValue>,
    #[serde(borrow)]
    operation: Option<&'a RawValue>,
    #[serde(borrow)]
    env: Option<&'a RawValue>,
    #[serde(borrow)]
    read: Option<&'a RawValue>,
    /// The tab's session file ("" for none), which keeps its terminals across a restart.
    #[serde(borrow)]
    session: Option<&'a RawValue>,
    viewer: Option<i64>,
    now: Option<i64>,
}

#[derive(Serialize)]
struct Params<'a> {
    owner: Cow<'a, str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cwd: Option<&'a RawValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    operation: Option<&'a RawValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    env: Option<&'a RawValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    shell: Option<Shell>,
    #[serde(skip_serializing_if = "Option::is_none")]
    read: Option<&'a RawValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session: Option<&'a RawValue>,
}

#[derive(Serialize)]
struct Line<'a> {
    id: u64,
    method: &'static str,
    params: Params<'a>,
}

fn invalid() -> Fault {
    Fault::new("stock_invalid", "Invalid terminal operation")
}

impl Request<'_> {
    fn line(self, id: u64, method: &'static str, shell: Option<Shell>) -> Result<Vec<u8>, Fault> {
        let owner = match self.owner {
            Owner::Local(owner) => owner,
            Owner::Peer { device, rtab } => Cow::Owned(format!("peer:{device}:{rtab}")),
        };
        // Leave room for the frame around a large raw write so the closing fields don't recopy it.
        let payload = [self.cwd, self.operation, self.env, self.read, self.session]
            .into_iter()
            .flatten()
            .map(|field| field.get().len())
            .sum::<usize>();
        let mut line = Vec::with_capacity(payload + owner.len() + 96);
        serde_json::to_writer(
            &mut line,
            &Line {
                id,
                method,
                params: Params {
                    owner,
                    cwd: self.cwd,
                    operation: self.operation,
                    env: self.env,
                    shell,
                    read: self.read,
                    session: self.session,
                },
            },
        )
        .map_err(|_| invalid())?;
        line.push(b'\n');
        Ok(line)
    }
}

/// `None` reserves the named create's place while its shell is resolved off the lane.
pub(super) fn viewer_frame(
    id: u64,
    bytes: &[u8],
    leases: &mut Leases,
) -> Result<Option<Vec<u8>>, Fault> {
    #[derive(Deserialize)]
    struct Operation<'a> {
        action: &'a str,
        #[serde(borrow)]
        id: Option<&'a RawValue>,
        #[serde(borrow)]
        shell: Option<&'a RawValue>,
    }
    static LIST: LazyLock<&RawValue> =
        LazyLock::new(|| serde_json::from_str(r#"{"action":"list","offsets":{}}"#).unwrap());
    let mut request: Request = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    let (Owner::Local(owner), Some(viewer), Some(now), Some(op)) = (
        &request.owner,
        request.viewer,
        request.now,
        request.operation,
    ) else {
        return Err(invalid());
    };
    let op: Operation = serde_json::from_str(op.get()).map_err(|_| invalid())?;
    match op.action {
        "create" if op.shell.is_some_and(|path| path.get() != r#""""#) => return Ok(None),
        "create" | "list" => {}
        action => {
            // Both IPC calls use JSON.stringify. Its string literal is a lossless key even for a lone UTF-16 unit.
            let key = op
                .id
                .filter(|id| id.get().starts_with('"'))
                .ok_or_else(invalid)?;
            if !leases.apply(owner, key.get(), viewer, action, now) {
                request.operation = Some(*LIST);
            }
        }
    }
    request.line(id, "terminal.request", None).map(Some)
}

pub(super) fn frame(
    id: u64,
    bytes: &[u8],
    dispose: bool,
    choose_shell: bool,
) -> Result<Vec<u8>, Fault> {
    let request: Request = serde_json::from_slice(bytes).map_err(|_| invalid())?;
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
    request.line(
        id,
        if dispose {
            "terminal.dispose"
        } else {
            "terminal.request"
        },
        shell,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn viewer_write_preserves_lone_units_in_the_worker_frame_and_the_lease_key() {
        let mut leases = Leases::default();
        let line = viewer_frame(
            9,
            br#"{"owner":"o","viewer":3,"now":100,"cwd":"folder","operation":{"action":"write","id":"\ud800","data":"\udfff"},"env":{}}"#,
            &mut leases,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            line,
            concat!(
                r#"{"id":9,"method":"terminal.request","params":{"owner":"o","cwd":"folder","operation":{"action":"write","id":"\ud800","data":"\udfff"},"env":{}}}"#,
                "\n"
            )
            .as_bytes()
        );
        assert_eq!(leases.seen("o", r#""\ud800""#, 3, 100), "you");
        assert_eq!(leases.seen("o", r#""\\ud800""#, 3, 100), "free");
    }

    #[test]
    fn a_viewer_request_carries_the_tab_s_session_file_to_the_worker() {
        let line = viewer_frame(
            2,
            br#"{"owner":"o","viewer":3,"now":100,"cwd":"c","operation":{"action":"list"},"env":{},"session":"/s/a.jsonl"}"#,
            &mut Leases::default(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            line,
            concat!(
                r#"{"id":2,"method":"terminal.request","params":{"owner":"o","cwd":"c","operation":{"action":"list"},"env":{},"session":"/s/a.jsonl"}}"#,
                "\n"
            )
            .as_bytes()
        );
    }
}
