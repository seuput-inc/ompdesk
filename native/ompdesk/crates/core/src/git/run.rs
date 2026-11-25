//! Running one git: the shared runner (`crate::run`) with git's own failure, `GitCommandError`'s message. Every git
//! here also keeps from waiting on a person (an ssh git gets `BatchMode=yes` unless the person's own ssh command says
//! otherwise) and steps over another git that holds a lock for a moment (a lock retried for the steps that can run
//! twice, a fetch's remote-ref race retried twice).

use std::time::Duration;

use crate::fs::order::js_trim;
use crate::run::{Exec, Opts, Output, Runner};
use crate::server::{Fault, Scope};

/// The gits of one request: main's runner, held to the request's scope.
pub struct Git(Exec);

/// `GitCommandError`: git's stderr, else `git <command> exited with code <n>`. Its code is no app code: main's
/// callers read the message, a mutation reports it as `git_failed`.
pub fn failure(args: &[&str], output: &Output) -> Fault {
    let stderr = js_trim(&output.stderr);
    let message = if stderr.is_empty() {
        format!(
            "git {} exited with code {}",
            args.first().unwrap_or(&""),
            output.code
        )
    } else {
        stderr.to_owned()
    };
    Fault::new("git_exit", message)
}

impl Git {
    pub fn new(runner: Runner, scope: Scope) -> Git {
        Git(Exec::new(runner, scope, "git"))
    }

    /// A variable of the environment main handed over.
    pub fn env(&self, name: &str) -> Option<&str> {
        self.0.env(name)
    }

    /// `gitRaw`: answers whatever git's exit code; fails only when git could not run, ran past its timeout or the
    /// request was cancelled.
    pub async fn raw(&self, cwd: &str, args: &[&str]) -> Result<Output, Fault> {
        self.go(cwd, args, Opts::default()).await
    }

    /// `gitRaw` with its own output cap.
    pub async fn capped(
        &self,
        cwd: &str,
        args: &[&str],
        max_bytes: usize,
    ) -> Result<Output, Fault> {
        let opts = Opts {
            max_bytes: Some(max_bytes),
            ..Opts::default()
        };
        self.go(cwd, args, opts).await
    }

    /// `git`: stdout as text; git's own failure is a fault with its stderr (`GitCommandError`'s message).
    pub async fn text(&self, cwd: &str, args: &[&str]) -> Result<String, Fault> {
        self.text_with(cwd, args, Opts::default()).await
    }

    /// `git` with its own settings.
    pub async fn text_with(
        &self,
        cwd: &str,
        args: &[&str],
        opts: Opts<'_>,
    ) -> Result<String, Fault> {
        let output = self.go(cwd, args, opts).await?;
        if output.code != 0 {
            return Err(failure(args, &output));
        }
        Ok(output.text())
    }

    pub async fn run(&self, cwd: &str, args: &[&str], opts: Opts<'_>) -> Result<Output, Fault> {
        self.go(cwd, args, opts).await
    }

    /// One git as its caller asked, with the ssh policy of a git that may connect and the retries of a failure that
    /// another git caused; the answer is the last attempt's.
    async fn go(&self, cwd: &str, args: &[&str], opts: Opts<'_>) -> Result<Output, Fault> {
        let command = subcommand(args);
        let ssh = if OVER_NETWORK.contains(&command)
            && !opts.env.iter().any(|(name, _)| *name == "GIT_SSH_COMMAND")
        {
            self.ssh_command(cwd).await?
        } else {
            None
        };
        let mut env = opts.env.to_vec();
        if let Some(ssh) = &ssh {
            env.push(("GIT_SSH_COMMAND", ssh.as_str()));
        }
        let opts = Opts {
            timeout_ms: opts.timeout_ms,
            max_bytes: opts.max_bytes,
            env: &env,
            input: opts.input,
        };
        let lock_retries: &[u64] = if RETRIED_ON_LOCK.contains(&command) {
            &LOCK_RETRY_MS
        } else {
            &[]
        };
        let (mut locked, mut raced) = (0, 0);
        loop {
            let output = self.0.run(cwd, args, opts).await?;
            if output.code == 0 {
                return Ok(output);
            }
            let wait = match lock_retries.get(locked) {
                Some(&ms) if is_lock_contention(&output.stderr) => {
                    locked += 1;
                    ms
                }
                _ if command == "fetch" && raced < 2 && is_remote_ref_race(&output.stderr) => {
                    raced += 1;
                    // Orca's 50-100 ms, then 150-200 ms: two fetches that raced should not race again in step.
                    let jitter = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map_or(0, |now| u64::from(now.subsec_nanos() % 50));
                    50 + (raced - 1) * 100 + jitter
                }
                _ => return Ok(output),
            };
            tokio::time::sleep(Duration::from_millis(wait)).await;
        }
    }

    /// The `GIT_SSH_COMMAND` that makes an ssh git fail instead of asking for a passphrase, a password or a new host
    /// key with nobody to answer (Orca `shared/git/commands/git-ssh-policy-env.ts:131-162`). The person's own ssh
    /// stays theirs: an exported `GIT_SSH` or a non-OpenSSH variant is left alone, and an exported `GIT_SSH_COMMAND`
    /// or `core.sshCommand` that is a plain `ssh` gets the option after its program word, a wrapper or anything a
    /// shell would expand is left as it is. None: run git as it is.
    async fn ssh_command(&self, cwd: &str) -> Result<Option<String>, Fault> {
        if self.env("GIT_SSH").is_some_and(|value| !value.is_empty()) {
            return Ok(None);
        }
        let (configured, variant) = match self
            .env("GIT_SSH_COMMAND")
            .filter(|value| !value.is_empty())
        {
            Some(own) => (own.to_owned(), None),
            None => {
                let output = self.0.run(cwd, &SSH_CONFIG_READ, Opts::default()).await?;
                // 1: neither is set; anything else but 0 is a config git could not read, so nothing is assumed.
                match output.code {
                    0 => ssh_config(&output.text()),
                    1 => (String::new(), None),
                    _ => return Ok(None),
                }
            }
        };
        let variant = self.env("GIT_SSH_VARIANT").map(str::to_owned).or(variant);
        if variant
            .is_some_and(|variant| !matches!(variant.to_ascii_lowercase().as_str(), "ssh" | "auto"))
        {
            return Ok(None);
        }
        if configured.is_empty() {
            return Ok(Some("ssh -o BatchMode=yes".to_owned()));
        }
        Ok(batch_mode(&configured))
    }
}

/// The subcommands that may open an ssh connection.
const OVER_NETWORK: [&str; 6] = ["fetch", "pull", "push", "ls-remote", "clone", "submodule"];

/// `core.sshCommand` and `ssh.variant` as git resolves them in a folder (Orca `GIT_SSH_CONFIG_ARGS`).
const SSH_CONFIG_READ: [&str; 4] = [
    "config",
    "--null",
    "--get-regexp",
    "^(core\\.sshcommand|ssh\\.variant)$",
];

/// The command and the variant of `git config --null --get-regexp` (`key\nvalue\0` entries).
fn ssh_config(stdout: &str) -> (String, Option<String>) {
    let (mut command, mut variant) = (String::new(), None);
    for entry in stdout.split('\0') {
        let Some((key, value)) = entry.split_once('\n') else {
            continue;
        };
        match key {
            "core.sshcommand" => value.clone_into(&mut command),
            "ssh.variant" => variant = Some(value.to_owned()),
            _ => {}
        }
    }
    (command, variant)
}

/// A plain OpenSSH command with `-o BatchMode=yes` after its program word (OpenSSH keeps an option's first value, so
/// it wins over a later one); None for a wrapper, a command that sets BatchMode itself, or one with quoting or shell
/// syntax that rewriting could change.
fn batch_mode(command: &str) -> Option<String> {
    if command.to_ascii_lowercase().contains("batchmode")
        || command
            .chars()
            .any(|ch| "$#*?[]{}\r\n;&|<>()`'\"\\~".contains(ch))
    {
        return None;
    }
    let start = command.len() - command.trim_start_matches([' ', '\t']).len();
    let end = command[start..]
        .find([' ', '\t'])
        .map_or(command.len(), |at| start + at);
    let program = command[start..end].rsplit('/').next().unwrap_or("");
    if !matches!(program.to_ascii_lowercase().as_str(), "ssh" | "ssh.exe") {
        return None;
    }
    Some(format!(
        "{} -o BatchMode=yes{}",
        &command[..end],
        &command[end..]
    ))
}

/// The subcommand of a git's own arguments: the first word past the options, `-c <name=value>` and `-C <dir>`.
fn subcommand<'a>(args: &[&'a str]) -> &'a str {
    let mut words = args.iter();
    while let Some(&word) = words.next() {
        match word {
            "-c" | "-C" => {
                words.next();
            }
            _ if word.starts_with('-') => {}
            _ => return word,
        }
    }
    ""
}

/// Steps a second run cannot change for the worse: reads, staging, the index and config writes, a fetch. Another git
/// that holds `index.lock` or a ref lock makes them fail before they change anything.
const RETRIED_ON_LOCK: [&str; 8] = [
    "status",
    "diff",
    "add",
    "restore",
    "rm",
    "update-index",
    "config",
    "fetch",
];
/// Orca `GIT_LOCK_CONTENTION_RETRY_DELAYS_MS` (`shared/git/commands/git-lock-contention.ts:9`).
const LOCK_RETRY_MS: [u64; 3] = [50, 150, 400];

/// Another git holds a lock (Orca `git-lock-contention.ts:4-7`); a ref's compare-and-swap mismatch is not one.
fn is_lock_contention(stderr: &str) -> bool {
    stderr.lines().any(|line| {
        (line.contains("Unable to create '") && line.contains(".lock': File exists"))
            || (line.contains("could not lock config file ") && line.contains(": File exists"))
    })
}

/// A fetch that failed only because another git moved a remote-tracking ref under it (Orca
/// `shared/git/fetch/git-fetch-ref-race.ts:12-46`): every error line is that race, no other error or rejected ref.
fn is_remote_ref_race(stderr: &str) -> bool {
    let mut raced = false;
    for line in stderr.lines().map(str::trim) {
        let message = line
            .strip_prefix("error: ")
            .or_else(|| line.strip_prefix("fatal: "));
        if message.is_some_and(is_ref_race_message) {
            raced = true;
        } else if line.contains("error:")
            || line.contains("fatal:")
            || line.starts_with("Errors during submodule fetch:")
            || (line.starts_with("remote:") && (line.contains("error") || line.contains("fatal")))
            || (line.starts_with('!') && line.contains('[') && line.contains("rejected"))
            || line.contains("[forced update failed]")
        {
            return false;
        }
    }
    raced
}

/// `fetching ref refs/remotes/… failed: incorrect old value provided`, or `cannot lock ref 'refs/remotes/…': is at
/// <oid> but expected <oid>`.
fn is_ref_race_message(message: &str) -> bool {
    if let Some(rest) = message.strip_prefix("fetching ref refs/remotes/") {
        return rest.ends_with(" failed: incorrect old value provided")
            && !rest.split(' ').next().unwrap_or("").is_empty();
    }
    let Some(rest) = message.strip_prefix("cannot lock ref 'refs/remotes/") else {
        return false;
    };
    let Some((name, rest)) = rest.split_once("': is at ") else {
        return false;
    };
    let Some((at, expected)) = rest.split_once(" but expected ") else {
        return false;
    };
    let oid = |text: &str| {
        matches!(text.len(), 40 | 64) && text.bytes().all(|byte| byte.is_ascii_hexdigit())
    };
    !name.is_empty() && !name.contains(char::is_whitespace) && oid(at) && oid(expected)
}

#[cfg(test)]
pub(crate) mod tests {
    use std::collections::BTreeMap;

    use super::*;

    /// The runner main hands over, for a git on this machine's PATH.
    pub fn runner() -> Runner {
        let mut env: BTreeMap<String, String> = std::env::vars()
            .filter(|(name, _)| !name.starts_with("GIT_"))
            .collect();
        env.insert("GIT_OPTIONAL_LOCKS".into(), "0".into());
        env.insert("LC_ALL".into(), "C".into());
        Runner {
            bin: "git".into(),
            args: ["-c", "core.quotepath=false", "-c", "color.ui=false"]
                .map(String::from)
                .to_vec(),
            env,
            timeout_ms: 60_000,
            max_bytes: 8 * 1024 * 1024,
        }
    }

    /// That runner outside any request.
    pub fn git() -> Git {
        Git::new(runner(), Scope::detached())
    }

    #[tokio::test]
    async fn fails_with_git_s_own_words() {
        let dir = std::env::temp_dir();
        let fault = git()
            .text(dir.to_str().unwrap(), &["--ompdesk-invalid-option"])
            .await
            .err()
            .unwrap();
        assert!(fault.message.contains("unknown option:"));
        assert_eq!(fault.code, "git_exit");
        let empty = Output {
            code: 3,
            stdout: Vec::new(),
            stderr: " \n".into(),
            truncated: false,
        };
        assert_eq!(
            failure(&["push", "x"], &empty).message,
            "git push exited with code 3"
        );
    }

    #[tokio::test]
    async fn starts_no_git_once_its_request_was_cancelled() {
        let scope = Scope::detached();
        scope.cancel();
        let fault = Git::new(runner(), scope)
            .raw("/no/such/folder/here", &["status"])
            .await
            .err()
            .unwrap();
        assert_eq!(fault, Fault::cancelled());
    }

    /// A git that may connect over ssh fails instead of asking; the person's own ssh command still runs, with the
    /// option only where it is a plain `ssh`, and an exported `GIT_SSH_COMMAND` still wins over `core.sshCommand`.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_ssh_git_never_waits_on_a_person_and_keeps_the_person_s_own_ssh() {
        use std::os::unix::fs::PermissionsExt;

        let repo = crate::git::scm::tests::repo("ssh-policy");
        let bin = repo.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let config = repo.join("empty-gitconfig");
        std::fs::write(&config, "").unwrap();
        for name in ["ssh", "my-ssh-wrapper"] {
            let fake = bin.join(name);
            std::fs::write(
                &fake,
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$0.args\"\nexit 1\n",
            )
            .unwrap();
            std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let bin_text = bin.to_str().unwrap().to_owned();
        let ssh = format!("{bin_text}/ssh");
        let wrapper = format!("{bin_text}/my-ssh-wrapper");
        // Which fake ran, and with what: the args file of the one that ran.
        let connect = async |exported: Option<&str>, configured: Option<&str>| {
            let cwd = repo.to_str().unwrap();
            match configured {
                Some(command) => {
                    crate::git::scm::tests::sh(&repo, &["config", "core.sshCommand", command])
                }
                None => {
                    let _ = std::process::Command::new("git")
                        .args(["config", "--unset", "core.sshCommand"])
                        .current_dir(&repo)
                        .output();
                    String::new()
                }
            };
            for name in ["ssh", "my-ssh-wrapper"] {
                let _ = std::fs::remove_file(bin.join(format!("{name}.args")));
            }
            let mut runner = runner();
            let path = format!(
                "{bin_text}:{}",
                runner.env.get("PATH").cloned().unwrap_or_default()
            );
            runner.env.insert("PATH".into(), path);
            runner
                .env
                .insert("GIT_CONFIG_GLOBAL".into(), config.to_str().unwrap().into());
            runner.env.insert("GIT_CONFIG_NOSYSTEM".into(), "1".into());
            if let Some(command) = exported {
                runner.env.insert("GIT_SSH_COMMAND".into(), command.into());
            }
            let output = Git::new(runner, Scope::detached())
                .raw(cwd, &["ls-remote", "ssh://example.invalid/repo.git"])
                .await
                .unwrap();
            assert_ne!(output.code, 0);
            ["ssh", "my-ssh-wrapper"]
                .into_iter()
                .find_map(|name| {
                    let args = std::fs::read_to_string(bin.join(format!("{name}.args"))).ok()?;
                    Some((name, args.lines().map(str::to_owned).collect::<Vec<_>>()))
                })
                .expect("no ssh ran")
        };
        let batch = |args: &[String]| {
            args.windows(2)
                .any(|pair| pair[0] == "-o" && pair[1] == "BatchMode=yes")
        };

        let (ran, args) = connect(None, None).await;
        assert_eq!(ran, "ssh");
        assert!(batch(&args), "{args:?}");

        let (ran, args) = connect(None, Some(&format!("{ssh} -i id_work"))).await;
        assert_eq!(ran, "ssh");
        assert!(
            batch(&args) && args.contains(&"id_work".to_owned()),
            "{args:?}"
        );

        let (ran, args) = connect(None, Some(&wrapper)).await;
        assert_eq!(ran, "my-ssh-wrapper");
        assert!(!batch(&args), "{args:?}");

        let (ran, args) = connect(Some(&format!("{wrapper} --vault")), Some(&ssh)).await;
        assert_eq!(ran, "my-ssh-wrapper");
        assert!(
            !batch(&args) && args.contains(&"--vault".to_owned()),
            "{args:?}"
        );

        let (ran, args) = connect(Some(&ssh), None).await;
        assert_eq!(ran, "ssh");
        assert!(batch(&args), "{args:?}");

        let _ = std::fs::remove_dir_all(&repo);
    }

    /// Staging waits out an `index.lock` another git holds for a moment; a commit, which a second run could change,
    /// fails on it as before.
    #[tokio::test]
    async fn a_lock_another_git_holds_for_a_moment_is_waited_out_by_a_step_that_can_run_twice() {
        let repo = crate::git::scm::tests::repo("lock-retry");
        let cwd = repo.to_str().unwrap().to_owned();
        let lock = repo.join(".git").join("index.lock");
        std::fs::write(repo.join("new.txt"), "new\n").unwrap();
        std::fs::write(&lock, "").unwrap();
        let held = lock.clone();
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(120));
            std::fs::remove_file(held).unwrap();
        });
        git().text(&cwd, &["add", "-A"]).await.unwrap();
        release.join().unwrap();

        std::fs::write(&lock, "").unwrap();
        let commit = git().raw(&cwd, &["commit", "-qm", "x"]).await.unwrap();
        assert_ne!(commit.code, 0);
        assert!(is_lock_contention(&commit.stderr), "{}", commit.stderr);
        std::fs::remove_file(&lock).unwrap();
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn tells_a_held_lock_and_a_remote_ref_race_from_any_other_failure() {
        assert!(is_lock_contention(
            "fatal: Unable to create '/r/.git/index.lock': File exists.\n\nAnother git process seems to be running"
        ));
        assert!(is_lock_contention(
            "error: could not lock config file .git/config: File exists"
        ));
        let oid = "a".repeat(40);
        let other = "b".repeat(40);
        let race = format!(
            "error: cannot lock ref 'refs/remotes/origin/main': is at {oid} but expected {other}"
        );
        assert!(!is_lock_contention(&race));
        assert!(is_remote_ref_race(&format!(
            "{race}\n ! {oid}..{other}  main -> origin/main  (unable to update local ref)"
        )));
        assert!(is_remote_ref_race(
            "error: fetching ref refs/remotes/origin/main failed: incorrect old value provided"
        ));
        assert!(!is_remote_ref_race(&format!(
            "{race}\nfatal: the remote end hung up unexpectedly"
        )));
        assert!(!is_remote_ref_race(&format!(
            "{race}\n ! [rejected]  main -> origin/main  (would clobber)"
        )));
        assert!(!is_remote_ref_race(&format!(
            "error: cannot lock ref 'refs/heads/main': is at {oid} but expected {other}"
        )));
        assert!(!is_remote_ref_race(
            "fatal: could not read from remote repository"
        ));

        assert_eq!(batch_mode("ssh"), Some("ssh -o BatchMode=yes".into()));
        assert_eq!(
            batch_mode("/usr/bin/ssh -i ~/.ssh/id"),
            None,
            "a shell expands the tilde"
        );
        assert_eq!(
            batch_mode("C:/Windows/System32/OpenSSH/ssh.exe -p 22"),
            Some("C:/Windows/System32/OpenSSH/ssh.exe -o BatchMode=yes -p 22".into())
        );
        assert_eq!(batch_mode("ssh -o BatchMode=no"), None);
        assert_eq!(batch_mode("op-ssh-sign"), None);
        assert_eq!(batch_mode("ssh -J jump\"host\""), None);
        assert_eq!(
            subcommand(&["-c", "a=b", "-C", "dir", "--no-pager", "fetch", "--prune"]),
            "fetch"
        );
    }
}
