//! The `memory short` record. The listing stays in this request; main supplies the live owners after the scan.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use super::{Row, begot, scan};
use crate::fs::order::NameOrder;
use crate::ports::Port;
use crate::server::{Call, Fault, Registry, Reply};

const TOP_PROCESSES: usize = 8;
const TOP_SESSIONS: usize = 6;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sample {
    port: u64,
    timeout_ms: u64,
}

#[derive(Deserialize)]
struct TagOwner {
    tag: String,
    cwd: String,
    device: Option<String>,
    pid: Option<u32>,
}

#[derive(Deserialize)]
struct Tab {
    pid: Option<u32>,
    label: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    owners: Vec<TagOwner>,
    tabs: Vec<Tab>,
    main_pid: u32,
    now: u64,
    locale: String,
}

pub(super) fn register(registry: &mut Registry) {
    registry.add("procs.pressureRecord", |call| Box::pin(sample(call)));
}

async fn sample(call: Call) -> Result<Reply, Fault> {
    let params: Sample = call.params()?;
    let rows = scan(
        "OMP_GUI_SESSION_TAG",
        params.timeout_ms,
        call.scope.clone(),
        HashSet::new(),
        false,
    )
    .await?;
    let port = Port::open(&call.events, params.port, ())?;
    let snapshot = tokio::select! {
        biased;
        () = call.scope.on_cancel() => Err(Fault::cancelled()),
        answer = port.ask::<Snapshot, _>("snapshot", &()) => answer.map_err(Fault::from),
    };
    port.close();
    Reply::json(&record(&rows, &snapshot?))
}

#[derive(Clone, Copy, Serialize)]
struct Session<'a> {
    session: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    folder: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    device: Option<&'a str>,
}

impl<'a> Session<'a> {
    fn titled(session: &'a str) -> Self {
        Self {
            session,
            folder: None,
            device: None,
        }
    }
}

#[derive(Clone, Copy)]
enum Owner<'a> {
    Session(Session<'a>),
    Closed,
    Ompdesk,
    Other,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Process<'a> {
    name: &'a str,
    pid: u32,
    mb: u128,
    #[serde(skip_serializing_if = "Option::is_none")]
    age_min: Option<u64>,
    owner: &'static str,
    #[serde(flatten)]
    session: Option<Session<'a>>,
}

#[derive(Serialize)]
struct SessionSum<'a> {
    #[serde(flatten)]
    session: Session<'a>,
    #[serde(rename = "mb", serialize_with = "write_mb")]
    bytes: u128,
    processes: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Record<'a> {
    top: Vec<Process<'a>>,
    sessions: Vec<SessionSum<'a>>,
    sessions_mb: u128,
    ompdesk_mb: u128,
    other_mb: u128,
}

fn mb(bytes: u128) -> u128 {
    (bytes + (1 << 19)) >> 20
}

fn write_mb<S: serde::Serializer>(bytes: &u128, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_u128(mb(*bytes))
}

fn record<'a>(rows: &'a [Row], snapshot: &'a Snapshot) -> Record<'a> {
    let by_pid: HashMap<_, _> = rows.iter().map(|r| (r.pid, r)).collect();
    let tabs: HashMap<_, _> = snapshot
        .tabs
        .iter()
        .filter_map(|tab| Some((tab.pid?, tab.label.as_str())))
        .collect();
    let tags: HashMap<_, _> = snapshot
        .owners
        .iter()
        .map(|tag| {
            let session = Session {
                session: tag
                    .pid
                    .and_then(|pid| tabs.get(&pid).copied())
                    .unwrap_or("(not running)"),
                folder: Some(&tag.cwd),
                device: tag.device.as_deref(),
            };
            (tag.tag.as_str(), session)
        })
        .collect();
    let mut seen = HashSet::new();
    let mut owner_of = |row: &Row| {
        if let Some(session) = row.tag.as_deref().and_then(|tag| tags.get(tag)) {
            return Owner::Session(*session);
        }
        seen.clear();
        let mut at = row;
        while seen.insert(at.pid) {
            if let Some(&title) = tabs.get(&at.pid) {
                return Owner::Session(Session::titled(title));
            }
            if at.pid == snapshot.main_pid {
                return Owner::Ompdesk;
            }
            let Some(parent) = by_pid.get(&at.ppid).filter(|p| begot(p, at)) else {
                break;
            };
            at = parent;
        }
        if row.tag.is_some() {
            Owner::Closed
        } else {
            Owner::Other
        }
    };

    let mut largest: Vec<(&Row, Owner)> = Vec::with_capacity(TOP_PROCESSES);
    let mut sessions: Vec<SessionSum> = Vec::new();
    let mut groups = HashMap::new();
    let mut key = String::new();
    let (mut sessions_bytes, mut ompdesk_bytes, mut other_bytes) = (0, 0, 0);
    for row in rows {
        let owner = owner_of(row);
        let position = largest.partition_point(|(r, _)| {
            r.bytes > row.bytes || (r.bytes == row.bytes && r.pid <= row.pid)
        });
        if position < TOP_PROCESSES {
            if largest.len() == TOP_PROCESSES {
                largest.pop();
            }
            largest.insert(position, (row, owner));
        }
        let bytes = u128::from(row.bytes);
        let session = match owner {
            Owner::Other => {
                other_bytes += bytes;
                continue;
            }
            Owner::Ompdesk => {
                ompdesk_bytes += bytes;
                continue;
            }
            Owner::Session(session) => session,
            Owner::Closed => Session::titled("(closed session)"),
        };
        sessions_bytes += bytes;
        // An absent folder/device and an empty one share the old key; the first row sets the output fields.
        key.clear();
        key.push_str(session.session);
        key.push('\0');
        key.push_str(session.folder.unwrap_or_default());
        key.push('\0');
        key.push_str(session.device.unwrap_or_default());
        let index = if let Some(&index) = groups.get(&key) {
            index
        } else {
            let index = sessions.len();
            sessions.push(SessionSum {
                session,
                bytes: 0,
                processes: 0,
            });
            groups.insert(std::mem::take(&mut key), index);
            index
        };
        sessions[index].bytes += bytes;
        sessions[index].processes += 1;
    }
    let order = NameOrder::text(&snapshot.locale);
    sessions.sort_by(|a, b| {
        b.bytes
            .cmp(&a.bytes)
            .then_with(|| order.compare(a.session.session, b.session.session))
    });
    sessions.truncate(TOP_SESSIONS);
    let top = largest
        .into_iter()
        .map(|(row, owner)| {
            let (owner, session) = match owner {
                Owner::Session(session) => ("session", Some(session)),
                Owner::Closed => ("closed session", None),
                Owner::Ompdesk => ("OMPdesk", None),
                Owner::Other => ("not OMPdesk's", None),
            };
            Process {
                name: &row.name,
                pid: row.pid,
                mb: mb(u128::from(row.bytes)),
                age_min: row.started_ms.map(|start| {
                    let age = snapshot.now.saturating_sub(start);
                    age / 60_000 + u64::from(age % 60_000 >= 30_000)
                }),
                owner,
                session,
            }
        })
        .collect();
    Record {
        top,
        sessions,
        sessions_mb: mb(sessions_bytes),
        ompdesk_mb: mb(ompdesk_bytes),
        other_mb: mb(other_bytes),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[derive(Deserialize)]
    struct Case {
        rows: Vec<Row>,
        expected: Value,
        #[serde(flatten)]
        snapshot: Snapshot,
    }

    #[test]
    fn matches_records_captured_from_typescript() {
        let cases: Vec<Case> = serde_json::from_str(include_str!("captured.json")).unwrap();
        for case in cases {
            let record = record(&case.rows, &case.snapshot);
            assert_eq!(serde_json::to_value(record).unwrap(), case.expected);
        }
    }

    #[test]
    fn names_eight_of_four_hundred_processes() {
        let rows: Vec<_> = (0..400)
            .map(|i| Row {
                pid: 1000 + i,
                ppid: 1,
                bytes: u64::from(i) << 20,
                name: "worker".into(),
                started_ms: Some(60_000 * u64::from(1000 + i)),
                ..Row::default()
            })
            .collect();
        let snapshot = Snapshot {
            owners: Vec::new(),
            tabs: Vec::new(),
            main_pid: 100,
            now: 60_000_000,
            locale: "en-US".into(),
        };
        let record = record(&rows, &snapshot);
        assert_eq!(record.top.len(), 8);
        assert_eq!((record.top[0].pid, record.top[0].mb), (1399, 399));
    }
}
