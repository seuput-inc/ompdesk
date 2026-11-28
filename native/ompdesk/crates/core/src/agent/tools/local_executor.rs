//! Workspace-rooted [`ToolExecutor`] implementing 4 core built-in tools for Direct LLM API turns:
//! - `read_file` — bounded line-range and byte-capped file reader
//! - `write_file` — atomic temp-file-and-persist writer inside the workspace
//! - `list_dir` — deterministic, bounded directory listing
//! - `run_command` — bounded stdout/stderr shell execution with timeout and `kill_on_drop`
//!
//! Every file and working-directory path is lexically normalized and canonicalized against the
//! workspace root to block `..` traversal and symlink escapes unless explicitly permitted by
//! [`LocalToolPolicy::allow_outside_workspace`].

use std::fs::{self, File};
use std::io::{BufRead, BufReader, Write as _};
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde_json::{Value, json};
use tempfile::NamedTempFile;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

use crate::agent::adapter::BoxFuture;
use crate::agent::backends::direct_api::{
    ToolExecutionResult, ToolExecutor, ToolInvocation, ToolSchema,
};
use crate::agent::types::AgentError;

pub const DEFAULT_MAX_READ_BYTES: usize = 256 * 1024;
pub const DEFAULT_MAX_WRITE_BYTES: usize = 2 * 1024 * 1024;
pub const DEFAULT_MAX_LIST_ENTRIES: usize = 500;
pub const DEFAULT_MAX_COMMAND_OUTPUT_BYTES: usize = 128 * 1024;
pub const DEFAULT_COMMAND_TIMEOUT_SECS: u64 = 30;

/// Resource limits and confinement policy for [`LocalToolExecutor`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalToolPolicy {
    pub allow_outside_workspace: bool,
    pub max_read_bytes: usize,
    pub max_write_bytes: usize,
    pub max_list_entries: usize,
    pub max_command_output_bytes: usize,
    pub command_timeout: Duration,
    pub allow_run_command: bool,
}

impl Default for LocalToolPolicy {
    fn default() -> Self {
        Self {
            allow_outside_workspace: false,
            max_read_bytes: DEFAULT_MAX_READ_BYTES,
            max_write_bytes: DEFAULT_MAX_WRITE_BYTES,
            max_list_entries: DEFAULT_MAX_LIST_ENTRIES,
            max_command_output_bytes: DEFAULT_MAX_COMMAND_OUTPUT_BYTES,
            command_timeout: Duration::from_secs(DEFAULT_COMMAND_TIMEOUT_SECS),
            allow_run_command: true,
        }
    }
}

/// JSON Schema definitions for the 4 built-in Direct API tools (`read_file`, `write_file`,
/// `list_dir`, `run_command`), ready for Anthropic / OpenAI Responses / OpenRouter payloads.
pub fn builtin_tool_schemas(include_run_command: bool) -> Vec<ToolSchema> {
    let mut schemas = vec![
        ToolSchema {
            name: "read_file".to_owned(),
            description:
                "Read UTF-8 text from a file within the workspace, optionally bounded by 1-based start_line/end_line and max_bytes."
                    .to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Workspace-relative or confined path to read" },
                    "start_line": { "type": "integer", "minimum": 1, "description": "Optional 1-based inclusive start line" },
                    "end_line": { "type": "integer", "minimum": 1, "description": "Optional 1-based inclusive end line" },
                    "max_bytes": { "type": "integer", "minimum": 1, "description": "Optional output byte cap" }
                },
                "required": ["path"],
                "additionalProperties": false
            }),
        },
        ToolSchema {
            name: "write_file".to_owned(),
            description:
                "Atomically write UTF-8 text content to a file inside the workspace, creating parent directories by default."
                    .to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Workspace-relative or confined path to write" },
                    "content": { "type": "string", "description": "Full UTF-8 file contents to write" },
                    "create_dirs": { "type": "boolean", "description": "Create missing parent directories (default true)" }
                },
                "required": ["path", "content"],
                "additionalProperties": false
            }),
        },
        ToolSchema {
            name: "list_dir".to_owned(),
            description:
                "List directory entries within the workspace in sorted order (directories carry a trailing '/')."
                    .to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Directory path relative to workspace root (defaults to '.')" },
                    "max_entries": { "type": "integer", "minimum": 1, "description": "Maximum number of entries to return" }
                },
                "additionalProperties": false
            }),
        },
    ];

    if include_run_command {
        schemas.push(ToolSchema {
            name: "run_command".to_owned(),
            description:
                "Execute a shell command inside the workspace with bounded stdout/stderr capture and timeout."
                    .to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "Shell command line to run" },
                    "cwd": { "type": "string", "description": "Optional working directory inside the workspace" },
                    "timeout_ms": { "type": "integer", "minimum": 1, "description": "Optional timeout in milliseconds" }
                },
                "required": ["command"],
                "additionalProperties": false
            }),
        });
    }

    schemas
}

/// Resolves `requested` relative to `workspace_root`, canonicalizing the deepest existing ancestor
/// to prevent both `..` traversal and symlink escapes outside `workspace_root`.
pub fn resolve_confined_path(
    workspace_root: &Path,
    requested: &Path,
    allow_outside: bool,
) -> Result<PathBuf, AgentError> {
    let canonical_root =
        fs::canonicalize(workspace_root).map_err(|error| AgentError::InvalidSpec {
            message: format!(
                "workspace root `{}` is not accessible: {error}",
                workspace_root.display()
            ),
        })?;

    let raw = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        canonical_root.join(requested)
    };
    let normalized = lexically_normalize(&raw);

    let resolved = if normalized.exists() {
        fs::canonicalize(&normalized)?
    } else {
        canonicalize_with_missing_tail(&normalized)?
    };

    if !allow_outside && !resolved.starts_with(&canonical_root) {
        return Err(AgentError::InvalidSpec {
            message: format!(
                "path `{}` escapes workspace root `{}`",
                requested.display(),
                canonical_root.display()
            ),
        });
    }

    Ok(resolved)
}

fn lexically_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                let can_pop = matches!(out.components().next_back(), Some(Component::Normal(_)));
                if can_pop {
                    out.pop();
                }
            }
            Component::Prefix(prefix) => out.push(prefix.as_os_str()),
            Component::RootDir => out.push(component.as_os_str()),
            Component::Normal(part) => out.push(part),
        }
    }
    out
}

fn canonicalize_with_missing_tail(normalized: &Path) -> Result<PathBuf, AgentError> {
    let mut ancestor = normalized.to_path_buf();
    let mut tail = Vec::new();
    while !ancestor.exists() {
        let Some(name) = ancestor.file_name().map(std::ffi::OsStr::to_os_string) else {
            return Err(AgentError::InvalidSpec {
                message: format!("path `{}` has no existing ancestor", normalized.display()),
            });
        };
        tail.push(name);
        if !ancestor.pop() {
            return Err(AgentError::InvalidSpec {
                message: format!("path `{}` has no existing ancestor", normalized.display()),
            });
        }
    }
    let mut resolved = fs::canonicalize(&ancestor)?;
    for part in tail.into_iter().rev() {
        resolved.push(part);
    }
    Ok(resolved)
}

/// Workspace-rooted [`ToolExecutor`] for Direct LLM API sessions.
#[derive(Debug, Clone, Default)]
pub struct LocalToolExecutor {
    workspace_root: Option<PathBuf>,
    policy: LocalToolPolicy,
}

impl LocalToolExecutor {
    /// Creates an executor that confines each invocation to its `invocation.cwd`.
    pub fn new() -> Self {
        Self::default()
    }

    /// Pins every tool invocation to an explicit workspace root directory.
    pub fn with_root(workspace_root: impl Into<PathBuf>) -> Self {
        Self {
            workspace_root: Some(workspace_root.into()),
            policy: LocalToolPolicy::default(),
        }
    }

    pub fn with_policy(mut self, policy: LocalToolPolicy) -> Self {
        self.policy = policy;
        self
    }

    pub fn policy(&self) -> &LocalToolPolicy {
        &self.policy
    }

    fn effective_root<'a>(&'a self, invocation: &'a ToolInvocation) -> &'a Path {
        self.workspace_root
            .as_deref()
            .unwrap_or(invocation.cwd.as_path())
    }
}

impl ToolExecutor for LocalToolExecutor {
    fn list_tools(&self) -> Vec<ToolSchema> {
        builtin_tool_schemas(self.policy.allow_run_command)
    }

    fn execute(
        &self,
        invocation: ToolInvocation,
    ) -> BoxFuture<'_, Result<ToolExecutionResult, AgentError>> {
        let root = self.effective_root(&invocation).to_path_buf();
        let policy = self.policy.clone();
        Box::pin(async move {
            match invocation.name.as_str() {
                "read_file" => Ok(exec_read_file(&root, &invocation.arguments, &policy)),
                "write_file" => Ok(exec_write_file(&root, &invocation.arguments, &policy)),
                "list_dir" => Ok(exec_list_dir(&root, &invocation.arguments, &policy)),
                "run_command" => Ok(exec_run_command(&root, &invocation.arguments, &policy).await),
                other => Ok(tool_err(format!("unknown built-in tool `{other}`"))),
            }
        })
    }
}

fn tool_ok(output: String) -> ToolExecutionResult {
    ToolExecutionResult {
        output,
        is_error: false,
    }
}

fn tool_err(message: String) -> ToolExecutionResult {
    ToolExecutionResult {
        output: message,
        is_error: true,
    }
}

fn arg_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.as_object()
        .and_then(|map| map.get(key))
        .and_then(Value::as_str)
}

fn arg_usize(args: &Value, key: &str) -> Option<usize> {
    args.as_object()
        .and_then(|map| map.get(key))
        .and_then(Value::as_u64)
        .and_then(|n| usize::try_from(n).ok())
}

fn arg_u64(args: &Value, key: &str) -> Option<u64> {
    args.as_object()
        .and_then(|map| map.get(key))
        .and_then(Value::as_u64)
}

fn arg_bool(args: &Value, key: &str) -> Option<bool> {
    args.as_object()
        .and_then(|map| map.get(key))
        .and_then(Value::as_bool)
}

fn exec_read_file(root: &Path, args: &Value, policy: &LocalToolPolicy) -> ToolExecutionResult {
    let Some(req_path) = arg_str(args, "path").filter(|p| !p.is_empty()) else {
        return tool_err("read_file requires non-empty `path`".to_owned());
    };
    let resolved =
        match resolve_confined_path(root, Path::new(req_path), policy.allow_outside_workspace) {
            Ok(path) => path,
            Err(error) => return tool_err(error.to_string()),
        };
    let file = match File::open(&resolved) {
        Ok(file) => file,
        Err(error) => return tool_err(format!("failed to open `{req_path}`: {error}")),
    };

    let start_line = arg_usize(args, "start_line").unwrap_or(1).max(1);
    let end_line = arg_usize(args, "end_line");
    if let Some(end) = end_line
        && end < start_line
    {
        return tool_err(format!(
            "end_line ({end}) must be >= start_line ({start_line})"
        ));
    }
    let max_bytes = arg_usize(args, "max_bytes")
        .unwrap_or(policy.max_read_bytes)
        .min(policy.max_read_bytes)
        .max(1);

    let mut reader = BufReader::new(file);
    let mut out = String::new();
    let mut line_buf = String::new();
    let mut line_no = 0usize;
    let mut truncated = false;

    loop {
        line_buf.clear();
        match reader.read_line(&mut line_buf) {
            Ok(0) => break,
            Ok(_) => {}
            Err(error) => return tool_err(format!("failed reading `{req_path}`: {error}")),
        }
        line_no += 1;
        if line_no < start_line {
            continue;
        }
        if let Some(end) = end_line
            && line_no > end
        {
            break;
        }
        let remaining = max_bytes.saturating_sub(out.len());
        if remaining == 0 {
            truncated = true;
            break;
        }
        if line_buf.len() <= remaining {
            out.push_str(&line_buf);
        } else {
            let cut = floor_char_boundary(&line_buf, remaining);
            out.push_str(&line_buf[..cut]);
            truncated = true;
            break;
        }
    }

    if truncated {
        out.push_str(&format!("\n[truncated at {max_bytes} bytes]"));
    }
    tool_ok(out)
}

fn floor_char_boundary(text: &str, mut index: usize) -> usize {
    index = index.min(text.len());
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn exec_write_file(root: &Path, args: &Value, policy: &LocalToolPolicy) -> ToolExecutionResult {
    let Some(req_path) = arg_str(args, "path").filter(|p| !p.is_empty()) else {
        return tool_err("write_file requires non-empty `path`".to_owned());
    };
    let Some(content) = arg_str(args, "content") else {
        return tool_err("write_file requires string `content`".to_owned());
    };
    if content.len() > policy.max_write_bytes {
        return tool_err(format!(
            "content size ({} bytes) exceeds limit ({} bytes)",
            content.len(),
            policy.max_write_bytes
        ));
    }

    let resolved =
        match resolve_confined_path(root, Path::new(req_path), policy.allow_outside_workspace) {
            Ok(path) => path,
            Err(error) => return tool_err(error.to_string()),
        };
    let Some(parent) = resolved.parent() else {
        return tool_err(format!("path `{req_path}` has no parent directory"));
    };

    let create_dirs = arg_bool(args, "create_dirs").unwrap_or(true);
    if !parent.exists() {
        if !create_dirs {
            return tool_err(format!(
                "parent directory for `{req_path}` does not exist and create_dirs is false"
            ));
        }
        if let Err(error) = fs::create_dir_all(parent) {
            return tool_err(format!("failed creating parent directories: {error}"));
        }
    }

    // Re-check canonicalized parent after directory creation to rule out symlink races.
    if !policy.allow_outside_workspace {
        let Ok(canonical_root) = fs::canonicalize(root) else {
            return tool_err("workspace root is not accessible".to_owned());
        };
        match fs::canonicalize(parent) {
            Ok(canonical_parent) if canonical_parent.starts_with(&canonical_root) => {}
            _ => {
                return tool_err(format!(
                    "resolved parent for `{req_path}` escapes workspace root"
                ));
            }
        }
    }

    let mut tmp = match NamedTempFile::new_in(parent) {
        Ok(tmp) => tmp,
        Err(error) => return tool_err(format!("failed creating temp file: {error}")),
    };
    if let Err(error) = tmp.write_all(content.as_bytes()).and_then(|()| tmp.flush()) {
        return tool_err(format!("failed writing temp file: {error}"));
    }
    if let Err(error) = tmp.persist(&resolved) {
        return tool_err(format!(
            "failed persisting `{req_path}` atomically: {}",
            error.error
        ));
    }

    tool_ok(format!("wrote {} bytes to {req_path}", content.len()))
}

fn exec_list_dir(root: &Path, args: &Value, policy: &LocalToolPolicy) -> ToolExecutionResult {
    let req_path = arg_str(args, "path")
        .filter(|p| !p.is_empty())
        .unwrap_or(".");
    let resolved =
        match resolve_confined_path(root, Path::new(req_path), policy.allow_outside_workspace) {
            Ok(path) => path,
            Err(error) => return tool_err(error.to_string()),
        };
    let read_dir = match fs::read_dir(&resolved) {
        Ok(iter) => iter,
        Err(error) => return tool_err(format!("failed listing `{req_path}`: {error}")),
    };

    let limit = arg_usize(args, "max_entries")
        .unwrap_or(policy.max_list_entries)
        .min(policy.max_list_entries)
        .max(1);

    let mut entries = Vec::new();
    for item in read_dir {
        let Ok(entry) = item else {
            continue;
        };
        let mut label = entry.file_name().to_string_lossy().into_owned();
        if entry.file_type().is_ok_and(|ty| ty.is_dir()) {
            label.push('/');
        }
        entries.push(label);
    }
    entries.sort();

    let total = entries.len();
    let truncated = total > limit;
    entries.truncate(limit);
    let mut output = entries.join("\n");
    if truncated {
        if !output.is_empty() {
            output.push('\n');
        }
        output.push_str(&format!("[truncated: showing {limit} of {total} entries]"));
    }
    tool_ok(output)
}

async fn exec_run_command(
    root: &Path,
    args: &Value,
    policy: &LocalToolPolicy,
) -> ToolExecutionResult {
    if !policy.allow_run_command {
        return tool_err("run_command is disabled by LocalToolPolicy".to_owned());
    }
    let Some(command) = arg_str(args, "command").filter(|c| !c.trim().is_empty()) else {
        return tool_err("run_command requires non-empty `command`".to_owned());
    };
    let req_cwd = arg_str(args, "cwd")
        .filter(|p| !p.is_empty())
        .unwrap_or(".");
    let effective_cwd =
        match resolve_confined_path(root, Path::new(req_cwd), policy.allow_outside_workspace) {
            Ok(path) => path,
            Err(error) => return tool_err(error.to_string()),
        };
    let timeout = arg_u64(args, "timeout_ms")
        .map(Duration::from_millis)
        .unwrap_or(policy.command_timeout)
        .min(policy.command_timeout)
        .max(Duration::from_millis(1));

    #[cfg(windows)]
    let mut cmd = {
        let comspec =
            std::env::var_os("ComSpec").unwrap_or_else(|| std::ffi::OsString::from("cmd.exe"));
        let mut c = Command::new(comspec);
        c.args(["/d", "/s", "/c", command]);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new("sh");
        c.args(["-c", command]);
        c
    };

    cmd.current_dir(&effective_cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(error) => return tool_err(format!("failed to spawn command: {error}")),
    };

    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill().await;
        return tool_err("command stdout pipe unavailable".to_owned());
    };
    let Some(stderr) = child.stderr.take() else {
        let _ = child.kill().await;
        return tool_err("command stderr pipe unavailable".to_owned());
    };

    let cap = policy.max_command_output_bytes;
    let wait_all = async {
        let (out_res, err_res, status_res) = tokio::join!(
            read_bounded(stdout, cap),
            read_bounded(stderr, cap),
            child.wait()
        );
        (out_res, err_res, status_res)
    };

    let (out_res, err_res, status_res) = match tokio::time::timeout(timeout, wait_all).await {
        Ok(done) => done,
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return tool_err(format!(
                "command timed out after {} ms",
                timeout.as_millis()
            ));
        }
    };

    let status = match status_res {
        Ok(status) => status,
        Err(error) => return tool_err(format!("failed waiting for command: {error}")),
    };
    let (stdout_bytes, stdout_trunc) = out_res.unwrap_or_default();
    let (stderr_bytes, stderr_trunc) = err_res.unwrap_or_default();

    let mut report = format!("exit_code: {}\n", status.code().unwrap_or(-1));
    let stdout_text = String::from_utf8_lossy(&stdout_bytes);
    let stderr_text = String::from_utf8_lossy(&stderr_bytes);
    if !stdout_text.is_empty() {
        report.push_str("stdout:\n");
        report.push_str(&stdout_text);
        if !stdout_text.ends_with('\n') {
            report.push('\n');
        }
        if stdout_trunc {
            report.push_str(&format!("[stdout truncated at {cap} bytes]\n"));
        }
    }
    if !stderr_text.is_empty() {
        report.push_str("stderr:\n");
        report.push_str(&stderr_text);
        if !stderr_text.ends_with('\n') {
            report.push('\n');
        }
        if stderr_trunc {
            report.push_str(&format!("[stderr truncated at {cap} bytes]\n"));
        }
    }

    ToolExecutionResult {
        output: report,
        is_error: !status.success(),
    }
}

async fn read_bounded<R: AsyncRead + Unpin>(
    mut reader: R,
    limit: usize,
) -> std::io::Result<(Vec<u8>, bool)> {
    let mut out = Vec::new();
    let mut truncated = false;
    let mut buf = [0u8; 4096];
    loop {
        let n = reader.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        let remaining = limit.saturating_sub(out.len());
        if remaining > 0 {
            let take = n.min(remaining);
            out.extend_from_slice(&buf[..take]);
            if take < n {
                truncated = true;
            }
        } else {
            truncated = true;
        }
    }
    Ok((out, truncated))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn invoke(cwd: &Path, name: &str, arguments: Value) -> ToolInvocation {
        ToolInvocation {
            call_id: "call-1".to_owned(),
            name: name.to_owned(),
            arguments,
            cwd: cwd.to_path_buf(),
        }
    }

    #[test]
    fn rejects_parent_traversal_and_absolute_escapes_outside_workspace() {
        let ws = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("secret.txt");
        fs::write(&secret, "top-secret").unwrap();

        let err = resolve_confined_path(ws.path(), Path::new("../outside.txt"), false).unwrap_err();
        assert_eq!(err.code(), "invalid_spec");

        let abs_err = resolve_confined_path(ws.path(), &secret, false).unwrap_err();
        assert_eq!(abs_err.code(), "invalid_spec");

        // Explicit opt-in permits reading outside paths.
        let allowed = resolve_confined_path(ws.path(), &secret, true).unwrap();
        assert_eq!(allowed, fs::canonicalize(&secret).unwrap());
    }

    #[tokio::test]
    async fn executes_write_read_list_and_bounds_outputs() {
        let ws = tempfile::tempdir().unwrap();
        let executor = LocalToolExecutor::with_root(ws.path()).with_policy(LocalToolPolicy {
            max_read_bytes: 20,
            max_list_entries: 2,
            ..LocalToolPolicy::default()
        });

        assert_eq!(executor.list_tools().len(), 4);

        let write_res = executor
            .execute(invoke(
                ws.path(),
                "write_file",
                json!({
                    "path": "nested/notes.txt",
                    "content": "line1\nline2\nline3\nline4\nline5\n",
                }),
            ))
            .await
            .unwrap();
        assert!(!write_res.is_error, "{}", write_res.output);

        let range_res = executor
            .execute(invoke(
                ws.path(),
                "read_file",
                json!({ "path": "nested/notes.txt", "start_line": 2, "end_line": 3 }),
            ))
            .await
            .unwrap();
        assert!(!range_res.is_error);
        assert_eq!(range_res.output, "line2\nline3\n");

        let capped_res = executor
            .execute(invoke(
                ws.path(),
                "read_file",
                json!({ "path": "nested/notes.txt" }),
            ))
            .await
            .unwrap();
        assert!(!capped_res.is_error);
        assert!(capped_res.output.contains("[truncated at 20 bytes]"));

        // Traversal attempt via tool returns structured is_error=true result.
        let blocked = executor
            .execute(invoke(
                ws.path(),
                "read_file",
                json!({ "path": "../../etc/hosts" }),
            ))
            .await
            .unwrap();
        assert!(blocked.is_error);
        assert!(blocked.output.contains("escapes workspace root"));

        fs::write(ws.path().join("a.txt"), "a").unwrap();
        fs::write(ws.path().join("b.txt"), "b").unwrap();
        fs::write(ws.path().join("c.txt"), "c").unwrap();
        let list_res = executor
            .execute(invoke(ws.path(), "list_dir", json!({})))
            .await
            .unwrap();
        assert!(!list_res.is_error);
        assert!(list_res.output.contains("a.txt"));
        assert!(
            list_res
                .output
                .contains("[truncated: showing 2 of 4 entries]")
        );
    }

    #[tokio::test]
    async fn executes_bounded_run_command_and_honors_disable_policy() {
        let ws = tempfile::tempdir().unwrap();
        let executor = LocalToolExecutor::with_root(ws.path());
        let res = executor
            .execute(invoke(
                ws.path(),
                "run_command",
                json!({ "command": "echo hello-momo" }),
            ))
            .await
            .unwrap();
        assert!(!res.is_error, "{}", res.output);
        assert!(res.output.contains("hello-momo"));

        let disabled = LocalToolExecutor::with_root(ws.path()).with_policy(LocalToolPolicy {
            allow_run_command: false,
            ..LocalToolPolicy::default()
        });
        assert_eq!(disabled.list_tools().len(), 3);
        let denied = disabled
            .execute(invoke(
                ws.path(),
                "run_command",
                json!({ "command": "echo hi" }),
            ))
            .await
            .unwrap();
        assert!(denied.is_error);
    }
}
