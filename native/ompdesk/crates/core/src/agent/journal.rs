//! Lightweight, atomic JSONL session journal for [`crate::agent::DirectApiAdapter`].
//!
//! Persists conversation messages, tool calls/results, token usage, and metadata under
//! `<journal_dir>/<journal_id>.jsonl` so [`ResumeHandle`] (`direct:<journal_id>`) survives app
//! restarts and idle hibernation with crash-safe corrupt-tail recovery.

use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tempfile::NamedTempFile;

use super::backends::direct_api::ConversationMessage;
use super::types::{AgentError, BackendId, ResumeHandle, TokenUsage};

/// Schema version emitted on the header line of every Direct API session journal.
pub const JOURNAL_FORMAT_VERSION: u32 = 1;

/// Canonical prefix used in [`ResumeHandle::native_id`] for Direct API session journals.
pub const DIRECT_RESUME_PREFIX: &str = "direct:";

const MAX_JOURNAL_ID_LEN: usize = 128;

/// Formats a journal identifier as a canonical `direct:<journal_id>` resume handle ID.
pub fn format_direct_resume_id(journal_id: &str) -> String {
    let stripped = parse_direct_journal_id(journal_id);
    format!("{DIRECT_RESUME_PREFIX}{stripped}")
}

/// Extracts the bare journal identifier from either `direct:<journal_id>` or `<journal_id>`.
pub fn parse_direct_journal_id(native_id: &str) -> &str {
    native_id
        .strip_prefix(DIRECT_RESUME_PREFIX)
        .unwrap_or(native_id)
}

/// Maps an arbitrary session ID into a filesystem-safe journal identifier (`[A-Za-z0-9._-]`).
pub fn sanitize_journal_id(raw: &str) -> String {
    let trimmed = parse_direct_journal_id(raw).trim();
    let mut out = String::with_capacity(trimmed.len().min(MAX_JOURNAL_ID_LEN));
    for ch in trimmed.chars() {
        if out.len() >= MAX_JOURNAL_ID_LEN {
            break;
        }
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    if out.is_empty() || out == "." || out == ".." {
        "session".to_owned()
    } else {
        out
    }
}

/// Validates that `journal_id` is safe to use as a single filename stem (no path traversal).
pub fn validate_journal_id(journal_id: &str) -> Result<&str, AgentError> {
    let id = parse_direct_journal_id(journal_id);
    if id.is_empty() || id.len() > MAX_JOURNAL_ID_LEN || id == "." || id == ".." {
        return Err(AgentError::InvalidSpec {
            message: format!("invalid Direct API journal id: `{journal_id}`"),
        });
    }
    if !id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        return Err(AgentError::InvalidSpec {
            message: format!(
                "Direct API journal id contains unsupported characters: `{journal_id}`"
            ),
        });
    }
    Ok(id)
}

/// Header metadata written at the start of a session journal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalHeader {
    pub version: u32,
    pub journal_id: String,
    pub backend: BackendId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub metadata: BTreeMap<String, String>,
    pub created_at_ms: u64,
}

impl JournalHeader {
    pub fn new(journal_id: impl Into<String>, backend: BackendId) -> Self {
        Self {
            version: JOURNAL_FORMAT_VERSION,
            journal_id: journal_id.into(),
            backend,
            cwd: None,
            model: None,
            system_prompt: None,
            metadata: BTreeMap::new(),
            created_at_ms: now_unix_ms(),
        }
    }
}

/// One append-only JSONL record stored in a Direct API session journal.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum JournalEntry {
    Header(JournalHeader),
    Message {
        seq: u64,
        timestamp_ms: u64,
        message: ConversationMessage,
    },
    Usage {
        seq: u64,
        timestamp_ms: u64,
        usage: TokenUsage,
    },
    Metadata {
        seq: u64,
        timestamp_ms: u64,
        key: String,
        value: String,
    },
    Checkpoint {
        seq: u64,
        timestamp_ms: u64,
        message_count: usize,
        total_usage: TokenUsage,
    },
}

/// Reconstructed in-memory state after replaying a Direct API session journal from disk.
#[derive(Debug, Clone, PartialEq)]
pub struct JournalSnapshot {
    pub journal_id: String,
    pub backend: Option<BackendId>,
    pub cwd: Option<PathBuf>,
    pub model: Option<String>,
    pub system_prompt: Option<String>,
    pub messages: Vec<ConversationMessage>,
    pub usage_records: Vec<TokenUsage>,
    pub total_usage: TokenUsage,
    pub metadata: BTreeMap<String, String>,
    pub last_seq: u64,
    pub created_at_ms: Option<u64>,
    pub recovered_corrupt_tail: bool,
    pub discarded_lines: usize,
}

impl JournalSnapshot {
    pub fn empty(journal_id: impl Into<String>) -> Self {
        Self {
            journal_id: journal_id.into(),
            backend: None,
            cwd: None,
            model: None,
            system_prompt: None,
            messages: Vec::new(),
            usage_records: Vec::new(),
            total_usage: TokenUsage::default(),
            metadata: BTreeMap::new(),
            last_seq: 0,
            created_at_ms: None,
            recovered_corrupt_tail: false,
            discarded_lines: 0,
        }
    }

    /// Builds a [`ResumeHandle`] pointing at this journal and its current message cursor.
    pub fn to_resume_handle(&self, fallback_backend: BackendId) -> ResumeHandle {
        let backend = self.backend.unwrap_or(fallback_backend);
        let mut handle = ResumeHandle::new(backend, format_direct_resume_id(&self.journal_id));
        handle.cwd = self.cwd.clone();
        handle.checkpoint_cursor = Some(self.messages.len().to_string());
        handle.metadata = self.metadata.clone();
        handle
    }
}

/// Filesystem-backed store for Direct API JSONL session journals.
#[derive(Debug, Clone)]
pub struct JournalStore {
    root: PathBuf,
}

impl JournalStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Resolves `<root>/<journal_id>.jsonl` after validating `journal_id`.
    pub fn path_for(&self, journal_id: &str) -> Result<PathBuf, AgentError> {
        let clean = validate_journal_id(journal_id)?;
        Ok(self.root.join(format!("{clean}.jsonl")))
    }

    /// Returns `true` when a journal file for `journal_id` already exists on disk.
    pub fn exists(&self, journal_id: &str) -> Result<bool, AgentError> {
        Ok(self.path_for(journal_id)?.is_file())
    }

    /// Creates a new journal file atomically with `header` if no journal file exists yet.
    pub fn create_if_absent(&self, header: &JournalHeader) -> Result<PathBuf, AgentError> {
        let path = self.path_for(&header.journal_id)?;
        if path.is_file() {
            return Ok(path);
        }
        let mut line = serde_json::to_vec(&JournalEntry::Header(header.clone()))?;
        line.push(b'\n');
        write_bytes_atomic(&self.root, &path, &line)?;
        Ok(path)
    }

    /// Appends one serialized [`JournalEntry`] line durably to the journal file.
    pub fn append_entry(&self, journal_id: &str, entry: &JournalEntry) -> Result<(), AgentError> {
        let path = self.path_for(journal_id)?;
        fs::create_dir_all(&self.root)?;
        let mut line = serde_json::to_vec(entry)?;
        line.push(b'\n');
        let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
        file.write_all(&line)?;
        file.flush()?;
        file.sync_data()?;
        Ok(())
    }

    /// Replays a journal from disk, tolerating a truncated or corrupt trailing tail.
    ///
    /// Interior corruption (a corrupt line followed by subsequent valid JSONL records) is rejected
    /// with [`AgentError::Protocol`].
    pub fn load(&self, journal_id: &str) -> Result<JournalSnapshot, AgentError> {
        let clean_id = validate_journal_id(journal_id)?;
        let path = self.root.join(format!("{clean_id}.jsonl"));
        let raw = fs::read(&path)?;
        let (snapshot, _) = parse_journal_bytes(clean_id, &raw)?;
        Ok(snapshot)
    }

    /// Replays a journal from disk and atomically rewrites the file without corrupt trailing lines
    /// whenever tail recovery triggered.
    pub fn load_and_repair(&self, journal_id: &str) -> Result<JournalSnapshot, AgentError> {
        let clean_id = validate_journal_id(journal_id)?;
        let path = self.root.join(format!("{clean_id}.jsonl"));
        let raw = fs::read(&path)?;
        let (snapshot, clean_bytes) = parse_journal_bytes(clean_id, &raw)?;
        if snapshot.recovered_corrupt_tail {
            write_bytes_atomic(&self.root, &path, &clean_bytes)?;
        }
        Ok(snapshot)
    }

    /// Atomically rewrites an entire [`JournalSnapshot`] to disk via temp-file + rename.
    pub fn save_snapshot_atomic(&self, snapshot: &JournalSnapshot) -> Result<PathBuf, AgentError> {
        let path = self.path_for(&snapshot.journal_id)?;
        let mut buf = Vec::new();

        if let Some(backend) = snapshot.backend {
            let header = JournalHeader {
                version: JOURNAL_FORMAT_VERSION,
                journal_id: validate_journal_id(&snapshot.journal_id)?.to_owned(),
                backend,
                cwd: snapshot.cwd.clone(),
                model: snapshot.model.clone(),
                system_prompt: snapshot.system_prompt.clone(),
                metadata: snapshot.metadata.clone(),
                created_at_ms: snapshot.created_at_ms.unwrap_or_else(now_unix_ms),
            };
            encode_jsonl_line(&mut buf, &JournalEntry::Header(header))?;
        }

        let ts = now_unix_ms();
        let mut seq: u64 = 0;
        for message in &snapshot.messages {
            seq += 1;
            encode_jsonl_line(
                &mut buf,
                &JournalEntry::Message {
                    seq,
                    timestamp_ms: ts,
                    message: message.clone(),
                },
            )?;
        }
        for usage in &snapshot.usage_records {
            seq += 1;
            encode_jsonl_line(
                &mut buf,
                &JournalEntry::Usage {
                    seq,
                    timestamp_ms: ts,
                    usage: usage.clone(),
                },
            )?;
        }
        if snapshot.backend.is_none() {
            for (key, value) in &snapshot.metadata {
                seq += 1;
                encode_jsonl_line(
                    &mut buf,
                    &JournalEntry::Metadata {
                        seq,
                        timestamp_ms: ts,
                        key: key.clone(),
                        value: value.clone(),
                    },
                )?;
            }
        }
        seq += 1;
        encode_jsonl_line(
            &mut buf,
            &JournalEntry::Checkpoint {
                seq,
                timestamp_ms: ts,
                message_count: snapshot.messages.len(),
                total_usage: snapshot.total_usage.clone(),
            },
        )?;

        write_bytes_atomic(&self.root, &path, &buf)?;
        Ok(path)
    }

    /// Lists all journal IDs currently stored in `root` in deterministic sorted order.
    pub fn list_ids(&self) -> Result<Vec<String>, AgentError> {
        if !self.root.exists() {
            return Ok(Vec::new());
        }
        let mut ids = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_file()
                && path.extension().and_then(|ext| ext.to_str()) == Some("jsonl")
                && let Some(stem) = path.file_stem().and_then(|s| s.to_str())
                && validate_journal_id(stem).is_ok()
            {
                ids.push(stem.to_owned());
            }
        }
        ids.sort();
        Ok(ids)
    }

    /// Deletes a journal file from disk, returning `true` if a file was removed.
    pub fn delete(&self, journal_id: &str) -> Result<bool, AgentError> {
        let path = self.path_for(journal_id)?;
        match fs::remove_file(&path) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(AgentError::from(error)),
        }
    }
}

/// Accumulates `delta` into `total` safely (saturating integer counters, additive optional cost).
pub fn accumulate_usage(total: &mut TokenUsage, delta: &TokenUsage) {
    total.input_tokens = total.input_tokens.saturating_add(delta.input_tokens);
    total.output_tokens = total.output_tokens.saturating_add(delta.output_tokens);
    total.cache_read_tokens = total
        .cache_read_tokens
        .saturating_add(delta.cache_read_tokens);
    total.cache_write_tokens = total
        .cache_write_tokens
        .saturating_add(delta.cache_write_tokens);
    total.reasoning_tokens = total
        .reasoning_tokens
        .saturating_add(delta.reasoning_tokens);
    if let Some(cost) = delta.cost_usd {
        total.cost_usd = Some(total.cost_usd.unwrap_or(0.0) + cost);
    }
}

pub(crate) fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |dur| u64::try_from(dur.as_millis()).unwrap_or(u64::MAX))
}

fn encode_jsonl_line(buf: &mut Vec<u8>, entry: &JournalEntry) -> Result<(), AgentError> {
    serde_json::to_writer(&mut *buf, entry)?;
    buf.push(b'\n');
    Ok(())
}

fn write_bytes_atomic(dir: &Path, target: &Path, bytes: &[u8]) -> Result<(), AgentError> {
    fs::create_dir_all(dir)?;
    let mut tmp = NamedTempFile::new_in(dir)?;
    tmp.write_all(bytes)?;
    tmp.flush()?;
    tmp.as_file().sync_all()?;
    tmp.persist(target).map_err(|err| AgentError::Transport {
        message: format!("atomic journal persist failed: {}", err.error),
    })?;
    Ok(())
}

fn parse_journal_bytes(
    journal_id: &str,
    raw: &[u8],
) -> Result<(JournalSnapshot, Vec<u8>), AgentError> {
    let mut snapshot = JournalSnapshot::empty(journal_id);
    let mut clean_bytes = Vec::with_capacity(raw.len());
    let mut pending_bad: Vec<(usize, String)> = Vec::new();

    for (line_idx, raw_line) in raw.split(|&b| b == b'\n').enumerate() {
        let trimmed = trim_ascii_bytes(raw_line);
        if trimmed.is_empty() {
            continue;
        }
        let parsed = std::str::from_utf8(trimmed)
            .map_err(|err| format!("invalid UTF-8: {err}"))
            .and_then(|text| {
                serde_json::from_str::<JournalEntry>(text)
                    .map_err(|err| format!("invalid JSONL entry: {err}"))
            });

        match parsed {
            Ok(entry) => {
                if let Some((bad_line, reason)) = pending_bad.first() {
                    return Err(AgentError::Protocol {
                        message: format!(
                            "corrupt interior journal line {} in `{journal_id}`: {reason}",
                            bad_line + 1
                        ),
                    });
                }
                apply_entry(&mut snapshot, entry);
                clean_bytes.extend_from_slice(trimmed);
                clean_bytes.push(b'\n');
            }
            Err(reason) => {
                pending_bad.push((line_idx, reason));
            }
        }
    }

    if !pending_bad.is_empty() {
        snapshot.recovered_corrupt_tail = true;
        snapshot.discarded_lines = pending_bad.len();
    }

    Ok((snapshot, clean_bytes))
}

fn trim_ascii_bytes(bytes: &[u8]) -> &[u8] {
    let start = bytes
        .iter()
        .position(|b| !b.is_ascii_whitespace())
        .unwrap_or(bytes.len());
    let end = bytes
        .iter()
        .rposition(|b| !b.is_ascii_whitespace())
        .map_or(start, |idx| idx + 1);
    &bytes[start..end]
}

fn apply_entry(snapshot: &mut JournalSnapshot, entry: JournalEntry) {
    match entry {
        JournalEntry::Header(header) => {
            snapshot.backend = Some(header.backend);
            snapshot.cwd = header.cwd;
            snapshot.model = header.model;
            snapshot.system_prompt = header.system_prompt;
            snapshot.created_at_ms = Some(header.created_at_ms);
            for (k, v) in header.metadata {
                snapshot.metadata.insert(k, v);
            }
        }
        JournalEntry::Message { seq, message, .. } => {
            snapshot.last_seq = snapshot.last_seq.max(seq);
            snapshot.messages.push(message);
        }
        JournalEntry::Usage { seq, usage, .. } => {
            snapshot.last_seq = snapshot.last_seq.max(seq);
            accumulate_usage(&mut snapshot.total_usage, &usage);
            snapshot.usage_records.push(usage);
        }
        JournalEntry::Metadata {
            seq, key, value, ..
        } => {
            snapshot.last_seq = snapshot.last_seq.max(seq);
            snapshot.metadata.insert(key, value);
        }
        JournalEntry::Checkpoint { seq, .. } => {
            snapshot.last_seq = snapshot.last_seq.max(seq);
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::agent::backends::direct_api::RecordedToolCall;
    use crate::agent::types::DirectApiProvider;

    #[test]
    fn writes_and_reloads_messages_tool_calls_usage_and_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let store = JournalStore::new(dir.path());
        let backend = BackendId::DirectApi(DirectApiProvider::Anthropic);

        let mut header = JournalHeader::new("sess-42", backend);
        header.cwd = Some(PathBuf::from("/repo/demo"));
        header.model = Some("claude-sonnet-4-6".to_owned());
        header.system_prompt = Some("Be concise.".to_owned());
        header.metadata.insert("tab".to_owned(), "main".to_owned());

        let path = store.create_if_absent(&header).unwrap();
        assert!(path.is_file());
        assert!(store.exists("direct:sess-42").unwrap());

        store
            .append_entry(
                "sess-42",
                &JournalEntry::Message {
                    seq: 1,
                    timestamp_ms: 1000,
                    message: ConversationMessage::user("Read Cargo.toml"),
                },
            )
            .unwrap();
        store
            .append_entry(
                "sess-42",
                &JournalEntry::Message {
                    seq: 2,
                    timestamp_ms: 1001,
                    message: ConversationMessage::assistant_with_tools(
                        "Checking now.",
                        vec![RecordedToolCall {
                            call_id: "call_1".to_owned(),
                            name: "read_file".to_owned(),
                            arguments: json!({ "path": "Cargo.toml" }),
                        }],
                    ),
                },
            )
            .unwrap();
        store
            .append_entry(
                "sess-42",
                &JournalEntry::Message {
                    seq: 3,
                    timestamp_ms: 1002,
                    message: ConversationMessage::tool_result(
                        "call_1",
                        "read_file",
                        "[package]\nname = \"ompdesk-core\"",
                        false,
                    ),
                },
            )
            .unwrap();
        store
            .append_entry(
                "sess-42",
                &JournalEntry::Usage {
                    seq: 4,
                    timestamp_ms: 1003,
                    usage: TokenUsage {
                        input_tokens: 150,
                        output_tokens: 40,
                        cache_read_tokens: 20,
                        cache_write_tokens: 10,
                        reasoning_tokens: 5,
                        cost_usd: Some(0.003),
                    },
                },
            )
            .unwrap();
        store
            .append_entry(
                "sess-42",
                &JournalEntry::Metadata {
                    seq: 5,
                    timestamp_ms: 1004,
                    key: "title".to_owned(),
                    value: "Cargo audit".to_owned(),
                },
            )
            .unwrap();

        let snap = store.load("direct:sess-42").unwrap();
        assert_eq!(snap.backend, Some(backend));
        assert_eq!(snap.cwd, Some(PathBuf::from("/repo/demo")));
        assert_eq!(snap.model.as_deref(), Some("claude-sonnet-4-6"));
        assert_eq!(snap.messages.len(), 3);
        assert_eq!(snap.messages[1].tool_calls.len(), 1);
        assert_eq!(snap.messages[1].tool_calls[0].call_id, "call_1");
        assert_eq!(snap.messages[2].tool_call_id.as_deref(), Some("call_1"));
        assert_eq!(snap.total_usage.input_tokens, 150);
        assert_eq!(snap.total_usage.output_tokens, 40);
        assert_eq!(snap.total_usage.cost_usd, Some(0.003));
        assert_eq!(snap.metadata.get("tab").map(String::as_str), Some("main"));
        assert_eq!(
            snap.metadata.get("title").map(String::as_str),
            Some("Cargo audit")
        );
        assert!(!snap.recovered_corrupt_tail);
        assert_eq!(snap.last_seq, 5);

        let handle = snap.to_resume_handle(backend);
        assert_eq!(handle.native_id, "direct:sess-42");
        assert_eq!(handle.checkpoint_cursor.as_deref(), Some("3"));

        assert_eq!(store.list_ids().unwrap(), vec!["sess-42".to_owned()]);
        assert!(store.delete("sess-42").unwrap());
        assert!(!store.delete("sess-42").unwrap());
    }

    #[test]
    fn recovers_truncated_json_and_utf8_tail_and_rejects_interior_corruption() {
        let dir = tempfile::tempdir().unwrap();
        let store = JournalStore::new(dir.path());
        let backend = BackendId::DirectApi(DirectApiProvider::OpenAi);

        store
            .create_if_absent(&JournalHeader::new("crash-tail", backend))
            .unwrap();
        store
            .append_entry(
                "crash-tail",
                &JournalEntry::Message {
                    seq: 1,
                    timestamp_ms: 2000,
                    message: ConversationMessage::user("hello"),
                },
            )
            .unwrap();

        // Simulate power loss leaving a partial JSON line + invalid truncated UTF-8 bytes at EOF.
        let path = store.path_for("crash-tail").unwrap();
        {
            let mut f = OpenOptions::new().append(true).open(&path).unwrap();
            f.write_all(b"{\"type\":\"message\",\"seq\":2,\"message\":{\"role\":\"assistant\",\"content\":\"trun\xE2\x82")
                .unwrap();
            f.flush().unwrap();
        }

        let loaded = store.load("crash-tail").unwrap();
        assert!(loaded.recovered_corrupt_tail);
        assert_eq!(loaded.discarded_lines, 1);
        assert_eq!(loaded.messages.len(), 1);
        assert_eq!(loaded.messages[0].content, "hello");

        // load_and_repair rewrites cleanly so subsequent appends succeed without corruption.
        let repaired = store.load_and_repair("crash-tail").unwrap();
        assert!(repaired.recovered_corrupt_tail);
        store
            .append_entry(
                "crash-tail",
                &JournalEntry::Message {
                    seq: 2,
                    timestamp_ms: 2005,
                    message: ConversationMessage::assistant("recovered!"),
                },
            )
            .unwrap();
        let after = store.load("crash-tail").unwrap();
        assert!(!after.recovered_corrupt_tail);
        assert_eq!(after.messages.len(), 2);
        assert_eq!(after.messages[1].content, "recovered!");

        // Interior corruption (corrupt line followed by a valid entry) must error cleanly.
        let bad_path = store.path_for("interior-bad").unwrap();
        let valid_line = serde_json::to_string(&JournalEntry::Message {
            seq: 2,
            timestamp_ms: 3000,
            message: ConversationMessage::user("later"),
        })
        .unwrap();
        fs::write(&bad_path, format!("{{corrupt-line\n{valid_line}\n")).unwrap();
        let err = store.load("interior-bad").unwrap_err();
        assert_eq!(err.code(), "protocol");
    }

    #[test]
    fn rejects_path_traversal_journal_ids_and_atomic_snapshot_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let store = JournalStore::new(dir.path());
        for bad in ["", ".", "..", "../escape", "dir/file", "dir\\file", "a b"] {
            assert_eq!(
                store.path_for(bad).unwrap_err().code(),
                "invalid_spec",
                "expected `{bad}` to be rejected"
            );
        }
        assert_eq!(sanitize_journal_id("direct:tab/1:foo"), "tab_1_foo");

        let mut snap = JournalSnapshot::empty("snap-atomic");
        snap.backend = Some(BackendId::DirectApi(DirectApiProvider::OpenRouter));
        snap.messages.push(ConversationMessage::user("ping"));
        snap.messages.push(ConversationMessage::assistant("pong"));
        snap.total_usage.input_tokens = 10;
        snap.total_usage.output_tokens = 5;
        snap.usage_records.push(snap.total_usage.clone());
        store.save_snapshot_atomic(&snap).unwrap();

        let reloaded = store.load("snap-atomic").unwrap();
        assert_eq!(reloaded.messages, snap.messages);
        assert_eq!(reloaded.total_usage.input_tokens, 10);
        assert_eq!(reloaded.total_usage.output_tokens, 5);
    }
}
