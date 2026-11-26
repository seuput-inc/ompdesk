//! A hook's output is data, never supervisor protocol. Both descriptors write to the same stream.

use std::collections::VecDeque;
use std::fs::{self, File};
use std::hash::{BuildHasher, RandomState};
use std::io::{self, BufWriter, Read, Write};
#[cfg(unix)]
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Deserialize;

use super::{Event, Held, NOT_STARTED, SPEC_ENV, spawn_held, wait};

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Kind {
    Setup,
    PreMerge,
    PostMerge,
    Archive,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Hook {
    kind: Kind,
    primary: PathBuf,
    worktree: PathBuf,
    from_primary: bool,
    log_dir: PathBuf,
    deadline_ms: u64,
}

struct Captured {
    held: Held,
    #[cfg(windows)]
    reader: io::PipeReader,
    #[cfg(unix)]
    reader: UnixStream,
    #[cfg(unix)]
    writer: UnixStream,
}

impl Hook {
    pub(super) fn run(self, events: mpsc::Sender<Event>, received: mpsc::Receiver<Event>) -> i32 {
        // Main starts the clock before spawning the supervisor. Use a monotonic clock after this handoff.
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default();
        let remaining = Duration::from_millis(self.deadline_ms).saturating_sub(now);
        let deadline = Instant::now() + remaining.min(Duration::from_millis(i32::MAX as u64));
        let name = match self.kind {
            Kind::Setup => "setup",
            Kind::PreMerge => "pre-merge",
            Kind::PostMerge => "post-merge",
            Kind::Archive => "archive",
        };
        let log = self.log_dir.join(format!("ompdesk-worktree-{name}.log"));
        let output = Output::new(&log);
        let (code, timed_out, output) = match self.start(name) {
            Ok(capture) => {
                let drain = thread::spawn(move || output.drain(capture.reader));
                let (code, timed_out) = wait(capture.held, events, received, Some(deadline));
                // A service that left the POSIX process group can still hold a writer. Drain queued bytes,
                // but do not let that descriptor hold the supervisor or the repository lock open.
                #[cfg(unix)]
                let _ = capture.writer.shutdown(std::net::Shutdown::Write);
                (
                    code,
                    timed_out,
                    drain.join().expect("hook output reader panicked"),
                )
            }
            Err(message) => {
                let mut output = output;
                output.push(&message);
                output.push("\n");
                (NOT_STARTED, false, output)
            }
        };
        // A JavaScript slice can start with an unpaired surrogate, so send UTF-16 units, not a Rust string.
        let tail = output.finish(&log);
        let mut answer = [0; 1 + 2 * TAIL_UNITS];
        answer[0] = u8::from(timed_out);
        let bytes = 1 + tail.len() * 2;
        for (pair, unit) in answer[1..bytes].as_chunks_mut::<2>().0.iter_mut().zip(tail) {
            *pair = unit.to_le_bytes();
        }
        let mut stdout = io::stdout().lock();
        let _ = stdout
            .write_all(&answer[..bytes])
            .and_then(|()| stdout.flush());
        code
    }

    fn start(&self, name: &str) -> Result<Captured, String> {
        let root = if self.from_primary {
            &self.primary
        } else {
            &self.worktree
        };
        let ext = if cfg!(windows) { ".cmd" } else { "" };
        let script = root.join(".ompdesk").join(format!("worktree-{name}{ext}"));
        #[cfg(unix)]
        let (mut command, program) = {
            let mut command = Command::new("/bin/sh");
            command.arg(script);
            (command, "/bin/sh")
        };
        #[cfg(windows)]
        let shell = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_owned());
        #[cfg(windows)]
        let (mut command, program) = {
            use std::os::windows::process::CommandExt;
            let mut command = Command::new(&shell);
            // Expand the path once as data, including literal % and ! in the checkout name.
            command.env("OMPDESK_HOOK_SCRIPT", script);
            command.raw_arg(r#"/d /v:off /s /c ""%OMPDESK_HOOK_SCRIPT%"""#);
            (command, shell.as_str())
        };
        #[cfg(unix)]
        let (reader, seal) = UnixStream::pair().map_err(|error| error.to_string())?;
        #[cfg(unix)]
        let writer =
            std::os::fd::OwnedFd::from(seal.try_clone().map_err(|error| error.to_string())?);
        #[cfg(windows)]
        let (reader, writer) = io::pipe().map_err(|error| error.to_string())?;
        command
            .env_remove(SPEC_ENV)
            .env("OMPDESK_ROOT_PATH", &self.primary)
            .env("OMPDESK_WORKTREE_PATH", &self.worktree)
            .env("OMPDESK_HOOK", name)
            .stdin(Stdio::null())
            .stderr(writer.try_clone().map_err(|error| error.to_string())?)
            .stdout(writer);
        let held = spawn_held(
            command,
            program,
            #[cfg(windows)]
            false,
        )?;
        Ok(Captured {
            held,
            reader,
            #[cfg(unix)]
            writer: seal,
        })
    }
}

const TAIL_UNITS: usize = 4096;

struct Output {
    staged: Option<(PathBuf, BufWriter<File>)>,
    tail: VecDeque<u16>,
}

impl Output {
    fn new(log: &Path) -> Self {
        // One hook per supervisor. Never open a repo-supplied log (or an existing stage) for writing.
        let suffix = RandomState::new().hash_one(std::process::id());
        let temp = log.with_extension(format!("{suffix:016x}.tmp"));
        let mut options = File::options();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let staged = options
            .open(&temp)
            .ok()
            .map(|file| (temp, BufWriter::new(file)));
        Self {
            staged,
            tail: VecDeque::with_capacity(TAIL_UNITS),
        }
    }

    fn push(&mut self, text: &str) {
        if let Some((_, file)) = &mut self.staged
            && file.write_all(text.as_bytes()).is_err()
            && let Some((path, file)) = self.staged.take()
        {
            drop(file);
            let _ = fs::remove_file(path);
        }
        for unit in text.encode_utf16() {
            if self.tail.len() == TAIL_UNITS {
                self.tail.pop_front();
            }
            self.tail.push_back(unit);
        }
    }

    fn drain(mut self, mut reader: impl Read) -> Self {
        let mut buffer = [0; 16 * 1024];
        let mut pending = 0;
        loop {
            let n = match reader.read(&mut buffer[pending..]) {
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Ok(n) => n,
                Err(_) => 0,
            };
            let used = pending + n;
            let mut consumed = 0;
            for chunk in buffer[..used].utf8_chunks() {
                self.push(chunk.valid());
                consumed += chunk.valid().len();
                let bad = chunk.invalid();
                if !bad.is_empty() {
                    if n != 0
                        && consumed + bad.len() == used
                        && std::str::from_utf8(bad).is_err_and(|error| error.error_len().is_none())
                    {
                        break;
                    }
                    self.push("\u{fffd}");
                    consumed += bad.len();
                }
            }
            if n == 0 {
                return self;
            }
            pending = used - consumed;
            buffer.copy_within(consumed..used, 0);
        }
    }

    fn finish(self, log: &Path) -> VecDeque<u16> {
        if let Some((path, mut file)) = self.staged {
            let flushed = file.flush();
            drop(file);
            if flushed.and_then(|()| fs::rename(&path, log)).is_err() {
                let _ = fs::remove_file(path);
            }
        }
        self.tail
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_split_decodes_as_one_buffer_including_an_incomplete_last_character() {
        let bytes = b"a\xf0\x9f\x98\x80\xfe\xe2\x82z\xf0\x9f";
        let expected: VecDeque<_> = String::from_utf8_lossy(bytes).encode_utf16().collect();
        for split in 0..=bytes.len() {
            let output = Output {
                staged: None,
                tail: VecDeque::new(),
            };
            let reader = (&bytes[..split]).chain(&bytes[split..]);
            assert_eq!(output.drain(reader).tail, expected, "split {split}");
        }
    }
}
