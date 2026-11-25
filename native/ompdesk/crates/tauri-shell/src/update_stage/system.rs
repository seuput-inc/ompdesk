use std::ffi::OsStr;
use std::io::{self, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

// The former execFile runner limited each pipe to 16 MiB, including tools whose output is ignored.
fn drain(stream: impl Read, mut dest: impl Write, child: &Mutex<Child>) -> bool {
    const MAX: u64 = 16 * 1024 * 1024;
    if io::copy(&mut stream.take(MAX + 1), &mut dest).is_ok_and(|n| n <= MAX) {
        return true;
    }
    let _ = child.lock().expect("update tool").kill();
    false
}

pub(super) fn run(tool: &str, args: &[&OsStr]) -> Option<String> {
    let mut child = Command::new(tool)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let child = Mutex::new(child);
    let mut text = Vec::new();
    let ok = std::thread::scope(|s| {
        let errors = s.spawn(|| drain(stderr, io::sink(), &child));
        let output = if matches!(tool, "/usr/bin/sw_vers" | "/usr/bin/plutil") {
            drain(stdout, &mut text, &child)
        } else {
            drain(stdout, io::sink(), &child)
        };
        errors.join().expect("update tool stderr reader") && output
    });
    if !child
        .into_inner()
        .expect("update tool")
        .wait()
        .ok()?
        .success()
        || !ok
    {
        return None;
    }
    let mut text = String::from_utf8(text)
        .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());
    let whitespace = |c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}';
    text.truncate(text.trim_end_matches(whitespace).len());
    let start = text.len() - text.trim_start_matches(whitespace).len();
    text.drain(..start);
    Some(text)
}
