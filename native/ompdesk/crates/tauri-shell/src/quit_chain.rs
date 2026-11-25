//! The order of an approved quit. Node asks (`app.quit`) and runs each step's prompts, listeners and effects
//! (`app.quitHook`); this decides which step runs next, sends each committing step once and drops answers that
//! are no longer current. No lock is held while a step is sent or answered.

use crate::{host, log};
use serde_json::{Value, json};
use shell_core::wire::WireError;
use std::sync::Mutex;

#[derive(Debug, PartialEq)]
pub enum Admission {
    Ask,
    Approved,
    /// Stock selected the installer's first launch; its receipt follows.
    InstallerPending,
    InstallerReceipt(Receipt),
}

/// The first launch attempt only.
#[derive(Debug, PartialEq)]
pub enum Receipt {
    Started {
        pid: u32,
    },
    Failed {
        message: String,
        code: Option<String>,
    },
}

pub fn parse(params: &Value) -> Result<Admission, &'static str> {
    Ok(match (params["intent"].as_str(), params.get("receipt")) {
        (Some("ask"), None) => Admission::Ask,
        (Some("approved"), None) => Admission::Approved,
        (Some("installerPending"), None) => Admission::InstallerPending,
        (Some("installerReceipt"), Some(receipt)) => {
            Admission::InstallerReceipt(match (receipt["kind"].as_str(), receipt.get("code")) {
                (Some("started"), None) => Receipt::Started {
                    pid: receipt["pid"]
                        .as_u64()
                        .and_then(|pid| u32::try_from(pid).ok())
                        .filter(|pid| *pid > 0)
                        .ok_or("invalid installer pid")?,
                },
                (Some("failed"), code) => Receipt::Failed {
                    message: receipt["message"]
                        .as_str()
                        .ok_or("invalid installer failure")?
                        .to_owned(),
                    code: code
                        .map(|code| code.as_str().ok_or("invalid installer failure code"))
                        .transpose()?
                        .map(str::to_owned),
                },
                _ => return Err("invalid installer receipt"),
            })
        }
        _ => return Err("invalid quit intent"),
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    Before,
    Confirm,
    Finalize,
    Teardown,
    Close,
    Will,
    Settle,
    Exit,
}

impl Step {
    fn name(self) -> &'static str {
        match self {
            Step::Before => "before",
            Step::Confirm => "confirm",
            Step::Finalize => "finalize",
            Step::Teardown => "teardown",
            Step::Close => "close",
            Step::Will => "will",
            Step::Settle => "settle",
            Step::Exit => "exit",
        }
    }
}

#[derive(Debug)]
pub struct Hook {
    step: Step,
    update: bool,
    code: Option<i32>,
    ticket: u64,
}

impl Hook {
    fn params(&self) -> Value {
        let mut params = json!({"step":self.step.name(),"update":self.update});
        if let Some(code) = self.code {
            params["code"] = json!(code);
        }
        params
    }
}

/// How far the quit has committed. A level is entered when its step is sent, so a retry never sends it again.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
enum Stage {
    #[default]
    Open,
    Approved,
    Finalized,
    TornDown {
        update: bool,
    },
    /// `app.exit` or Node's end: nothing runs again.
    Ended,
}

enum Reply {
    Go,
    Veto,
    Settled(i32),
}

/// `None`: an error or a shape the step does not answer with.
fn reply(step: Step, result: &Result<Value, WireError>) -> Option<Reply> {
    let value = result.as_ref().ok()?;
    match step {
        Step::Before | Step::Confirm | Step::Close | Step::Will => value
            .as_bool()
            .map(|go| if go { Reply::Go } else { Reply::Veto }),
        Step::Finalize | Step::Teardown | Step::Exit => value.is_null().then_some(Reply::Go),
        Step::Settle => match value.as_i64() {
            Some(code @ (0 | 1)) => Some(Reply::Settled(code as i32)),
            _ => None,
        },
    }
}

#[derive(Default)]
pub struct Chain {
    stage: Stage,
    installer_pending: bool,
    /// The one step whose answer is current.
    running: Option<(u64, Step)>,
    tickets: u64,
}

impl Chain {
    pub fn admit(&mut self, admission: Admission) -> Option<Hook> {
        if self.stage == Stage::Ended {
            log::log(
                "quit.ignored",
                json!({"admission":format!("{admission:?}")}),
            );
            return None;
        }
        match admission {
            Admission::Ask => self.start(),
            Admission::Approved => {
                if self.stage == Stage::Open {
                    self.stage = Stage::Approved;
                }
                match self.running {
                    // The open confirmation no longer decides; its answer arrives stale.
                    Some((_, Step::Confirm)) => Some(self.commit(Stage::Finalized, Step::Finalize)),
                    _ => self.start(),
                }
            }
            Admission::InstallerPending => {
                if self.installer_pending || matches!(self.stage, Stage::TornDown { .. }) {
                    log::log(
                        "quit.installerIgnored",
                        json!({"stage":format!("{:?}", self.stage)}),
                    );
                    return None;
                }
                self.installer_pending = true;
                // Uncommitted work stops here: its completion must not lead to an ordinary teardown.
                self.running = None;
                None
            }
            Admission::InstallerReceipt(receipt) => {
                let receipt = match receipt {
                    Receipt::Started { pid } => json!({"kind":"started","pid":pid}),
                    Receipt::Failed { message, code } => {
                        json!({"kind":"failed","message":message,"code":code})
                    }
                };
                log::log(
                    "quit.installerReceipt",
                    json!({"receipt":receipt,"admitted":self.installer_pending}),
                );
                if !self.installer_pending {
                    return None;
                }
                self.installer_pending = false;
                Some(self.commit(Stage::TornDown { update: true }, Step::Teardown))
            }
        }
    }

    pub fn answer(&mut self, ticket: u64, result: Result<Value, WireError>) -> Option<Hook> {
        let step = match self.running {
            Some((current, step)) if current == ticket => step,
            _ => return None,
        };
        self.running = None;
        let code = match reply(step, &result) {
            Some(Reply::Go) => None,
            Some(Reply::Settled(code)) => Some(code),
            Some(Reply::Veto) => {
                log::log("quit.vetoed", json!({"step":step.name()}));
                return None;
            }
            None => {
                log::log(
                    "quit.fault",
                    json!({"step":step.name(),"answer":format!("{result:?}")}),
                );
                return None;
            }
        };
        Some(match (step, self.stage) {
            (Step::Before, Stage::Open) => self.issue(Step::Confirm, None),
            (Step::Before, Stage::Approved) | (Step::Confirm, _) => {
                self.commit(Stage::Finalized, Step::Finalize)
            }
            (Step::Before, Stage::Finalized) | (Step::Finalize, _) => {
                self.commit(Stage::TornDown { update: false }, Step::Teardown)
            }
            (Step::Teardown, Stage::TornDown { update: true }) => self.issue(Step::Before, None),
            (Step::Before | Step::Teardown, _) => self.issue(Step::Close, None),
            (Step::Close, _) => self.issue(Step::Will, None),
            (Step::Will, _) => self.issue(Step::Settle, None),
            (Step::Settle, _) => self.issue(Step::Exit, code),
            (Step::Exit, _) => {
                self.stage = Stage::Ended;
                return None;
            }
        })
    }

    /// `app.exit` was asked for or Node is gone: outstanding answers and later requests are dropped.
    pub fn terminate(&mut self) {
        self.stage = Stage::Ended;
        self.running = None;
        self.installer_pending = false;
    }

    /// The quit is committed (Node's `quitApproved`): a Dock click no longer opens or restores a window, and closing the
    /// last window lets it close.
    pub fn approved(&self) -> bool {
        self.stage != Stage::Open
    }

    /// A request while a step runs joins it; one while an install is pending is that install's quit.
    fn start(&mut self) -> Option<Hook> {
        if self.running.is_some() || self.installer_pending {
            return None;
        }
        Some(self.issue(Step::Before, None))
    }

    fn commit(&mut self, stage: Stage, step: Step) -> Hook {
        self.stage = stage;
        self.issue(step, None)
    }

    fn issue(&mut self, step: Step, code: Option<i32>) -> Hook {
        self.tickets += 1;
        self.running = Some((self.tickets, step));
        Hook {
            step,
            update: self.stage == Stage::TornDown { update: true },
            code,
            ticket: self.tickets,
        }
    }
}

pub fn admit(chain: &'static Mutex<Chain>, admission: Admission) {
    let hook = chain.lock().expect("quit chain").admit(admission);
    send(chain, hook);
}

/// A quit a person asked for from the app menu, the tray or the last window's close (`asker`): Node logs who asked
/// (`logQuitAsked`) before the chain's first step reaches it on the same stream; then the chain asks as for ⌘Q.
pub fn ask(asker: &str) {
    host::event(
        "app.quitAsked",
        json!({"asker":asker,"ask":{},"approved":false}),
    );
    admit(&crate::runtime().quit, Admission::Ask);
}

fn send(chain: &'static Mutex<Chain>, hook: Option<Hook>) {
    let Some(hook) = hook else {
        return;
    };
    let ticket = hook.ticket;
    // Node's teardown destroyed its tray; the shell's goes at the same step.
    if hook.step == Step::Teardown {
        crate::tray::remove();
    }
    host::request("app.quitHook", hook.params(), None, move |result, _| {
        let next = chain.lock().expect("quit chain").answer(ticket, result);
        send(chain, next);
    });
}

#[cfg(test)]
mod tests {
    use super::Step::*;
    use super::*;

    fn yes(step: Step) -> Value {
        match step {
            Before | Confirm | Close | Will => json!(true),
            Settle => json!(0),
            Finalize | Teardown | Exit => Value::Null,
        }
    }

    /// Answers every step with `yes` and returns what was sent.
    fn drive(chain: &mut Chain, mut hook: Option<Hook>) -> Vec<(Step, bool)> {
        let mut sent = Vec::new();
        while let Some(current) = hook {
            sent.push((current.step, current.update));
            hook = chain.answer(current.ticket, Ok(yes(current.step)));
        }
        sent
    }

    fn until(chain: &mut Chain, admission: Admission, target: Step) -> Hook {
        let mut hook = chain.admit(admission).expect("a quit starts");
        while hook.step != target {
            let answer = yes(hook.step);
            hook = chain
                .answer(hook.ticket, Ok(answer))
                .expect("the quit goes on");
        }
        hook
    }

    fn steps(update: bool, list: &[Step]) -> Vec<(Step, bool)> {
        list.iter().map(|step| (*step, update)).collect()
    }

    const AFTER_TEARDOWN: [Step; 5] = [Before, Close, Will, Settle, Exit];

    #[test]
    fn an_asked_quit_runs_every_step_once_in_order() {
        let mut chain = Chain::default();
        let first = chain.admit(Admission::Ask);
        assert_eq!(
            drive(&mut chain, first),
            steps(
                false,
                &[
                    Before, Confirm, Finalize, Teardown, Close, Will, Settle, Exit
                ]
            )
        );
        assert!(
            chain.admit(Admission::Ask).is_none(),
            "an ended quit starts nothing"
        );
    }

    #[test]
    fn an_approved_quit_skips_the_confirmation() {
        let mut chain = Chain::default();
        let first = chain.admit(Admission::Approved);
        assert_eq!(
            drive(&mut chain, first),
            steps(
                false,
                &[Before, Finalize, Teardown, Close, Will, Settle, Exit]
            )
        );
    }

    #[test]
    fn the_settle_code_is_the_exit_code() {
        let mut chain = Chain::default();
        let settle = until(&mut chain, Admission::Approved, Settle);
        let exit = chain
            .answer(settle.ticket, Ok(json!(1)))
            .expect("exit follows");
        assert_eq!(
            exit.params(),
            json!({"step":"exit","update":false,"code":1})
        );
    }

    #[test]
    fn approval_during_the_confirmation_goes_on_and_drops_its_late_answer() {
        let mut chain = Chain::default();
        let confirm = until(&mut chain, Admission::Ask, Confirm);
        let finalize = chain.admit(Admission::Approved).expect("approval goes on");
        assert_eq!(finalize.step, Finalize);
        assert!(chain.answer(confirm.ticket, Ok(json!(false))).is_none());
        assert!(chain.answer(confirm.ticket, Ok(json!(true))).is_none());
        let next = chain.answer(finalize.ticket, Ok(Value::Null));
        assert_eq!(
            drive(&mut chain, next),
            steps(false, &[Teardown, Close, Will, Settle, Exit])
        );
    }

    #[test]
    fn requests_while_a_step_runs_join_it_and_an_answer_counts_once() {
        let mut chain = Chain::default();
        let before = chain.admit(Admission::Ask).expect("a quit starts");
        assert!(chain.admit(Admission::Ask).is_none());
        let confirm = chain
            .answer(before.ticket, Ok(json!(true)))
            .expect("confirm follows");
        assert!(chain.answer(before.ticket, Ok(json!(true))).is_none());
        assert_eq!(
            chain
                .answer(confirm.ticket, Ok(json!(true)))
                .map(|h| h.step),
            Some(Finalize)
        );
    }

    #[test]
    fn a_declined_confirmation_commits_nothing() {
        let mut chain = Chain::default();
        let confirm = until(&mut chain, Admission::Ask, Confirm);
        assert!(chain.answer(confirm.ticket, Ok(json!(false))).is_none());
        let first = chain.admit(Admission::Ask);
        assert_eq!(
            drive(&mut chain, first)[..2],
            steps(false, &[Before, Confirm])[..]
        );
    }

    #[test]
    fn a_window_veto_keeps_the_teardown_and_the_retry_resumes_at_close() {
        let mut chain = Chain::default();
        let close = until(&mut chain, Admission::Ask, Close);
        assert!(chain.answer(close.ticket, Ok(json!(false))).is_none());
        let retry = chain.admit(Admission::Ask);
        assert_eq!(drive(&mut chain, retry), steps(false, &AFTER_TEARDOWN));
    }

    #[test]
    fn a_pending_install_fences_a_running_finalize_and_its_receipt_runs_the_update_order() {
        let mut chain = Chain::default();
        let finalize = until(&mut chain, Admission::Ask, Finalize);
        assert!(chain.admit(Admission::InstallerPending).is_none());
        assert!(
            chain.answer(finalize.ticket, Ok(Value::Null)).is_none(),
            "no ordinary teardown"
        );
        assert!(chain.admit(Admission::Ask).is_none());
        assert!(chain.admit(Admission::Approved).is_none());
        let teardown = chain.admit(Admission::InstallerReceipt(Receipt::Started { pid: 42 }));
        assert_eq!(
            drive(&mut chain, teardown),
            steps(true, &[Teardown, Before, Close, Will, Settle, Exit])
        );
    }

    #[test]
    fn a_failed_first_launch_still_quits_without_confirmation() {
        let mut chain = Chain::default();
        let before = chain.admit(Admission::Ask).expect("a quit starts");
        assert!(chain.admit(Admission::InstallerPending).is_none());
        assert!(chain.answer(before.ticket, Ok(json!(true))).is_none());
        let failed = Receipt::Failed {
            message: "denied".into(),
            code: Some("EACCES".into()),
        };
        let teardown = chain.admit(Admission::InstallerReceipt(failed));
        assert_eq!(
            drive(&mut chain, teardown),
            steps(true, &[Teardown, Before, Close, Will, Settle, Exit])
        );
    }

    #[test]
    fn a_receipt_without_an_admitted_install_changes_nothing() {
        let mut chain = Chain::default();
        let before = chain.admit(Admission::Ask).expect("a quit starts");
        assert!(
            chain
                .admit(Admission::InstallerReceipt(Receipt::Started { pid: 7 }))
                .is_none()
        );
        let next = chain.answer(before.ticket, Ok(json!(true)));
        assert_eq!(next.map(|h| h.step), Some(Confirm));

        let mut chain = Chain::default();
        assert!(chain.admit(Admission::InstallerPending).is_none());
        let teardown = chain.admit(Admission::InstallerReceipt(Receipt::Started { pid: 7 }));
        assert_eq!(teardown.as_ref().map(|h| h.step), Some(Teardown));
        assert!(
            chain
                .admit(Admission::InstallerReceipt(Receipt::Started { pid: 7 }))
                .is_none()
        );
        assert!(chain.admit(Admission::InstallerPending).is_none());
    }

    #[test]
    fn an_install_after_an_ordinary_teardown_cannot_unwind_it() {
        let mut chain = Chain::default();
        let teardown = until(&mut chain, Admission::Approved, Teardown);
        assert!(chain.admit(Admission::InstallerPending).is_none());
        assert!(
            chain
                .admit(Admission::InstallerReceipt(Receipt::Started { pid: 9 }))
                .is_none()
        );
        let next = chain.answer(teardown.ticket, Ok(Value::Null));
        assert_eq!(
            drive(&mut chain, next),
            steps(false, &[Close, Will, Settle, Exit])
        );
    }

    #[test]
    fn an_update_quit_vetoed_after_teardown_retries_without_a_second_teardown() {
        let mut chain = Chain::default();
        chain.admit(Admission::InstallerPending);
        let teardown = chain
            .admit(Admission::InstallerReceipt(Receipt::Started { pid: 3 }))
            .expect("teardown");
        let before = chain
            .answer(teardown.ticket, Ok(Value::Null))
            .expect("before follows");
        assert_eq!((before.step, before.update), (Before, true));
        assert!(chain.answer(before.ticket, Ok(json!(false))).is_none());
        let retry = chain.admit(Admission::Ask);
        assert_eq!(drive(&mut chain, retry), steps(true, &AFTER_TEARDOWN));
    }

    #[test]
    fn errors_and_wrong_shapes_stop_the_quit() {
        let cases = [
            (Before, Ok(json!(1))),
            (Confirm, Ok(Value::Null)),
            (Finalize, Ok(json!(false))),
            (Teardown, Err(WireError::new("failed", "teardown threw"))),
            (Close, Ok(json!({}))),
            (Will, Ok(json!("true"))),
            (Settle, Ok(json!(2))),
            (Settle, Ok(json!(0.0))),
            (Settle, Ok(json!(true))),
            (Exit, Ok(json!(true))),
        ];
        for (step, answer) in cases {
            let mut chain = Chain::default();
            let hook = until(&mut chain, Admission::Ask, step);
            assert!(
                chain.answer(hook.ticket, answer).is_none(),
                "{step:?} stops"
            );
            assert!(
                chain.admit(Admission::Ask).is_some(),
                "{step:?} leaves a quit to retry"
            );
        }
    }

    #[test]
    fn the_end_drops_outstanding_answers_and_later_requests() {
        let mut chain = Chain::default();
        let before = chain.admit(Admission::Ask).expect("a quit starts");
        chain.terminate();
        assert!(chain.answer(before.ticket, Ok(json!(true))).is_none());
        assert!(chain.admit(Admission::Ask).is_none());
        assert!(chain.admit(Admission::Approved).is_none());
        assert!(chain.admit(Admission::InstallerPending).is_none());
        assert!(
            chain
                .admit(Admission::InstallerReceipt(Receipt::Started { pid: 1 }))
                .is_none()
        );
    }

    #[test]
    fn admissions_are_parsed_strictly() {
        assert_eq!(parse(&json!({"intent":"ask"})), Ok(Admission::Ask));
        assert_eq!(
            parse(&json!({"intent":"approved"})),
            Ok(Admission::Approved)
        );
        assert_eq!(
            parse(&json!({"intent":"installerPending"})),
            Ok(Admission::InstallerPending)
        );
        assert_eq!(
            parse(&json!({"intent":"installerReceipt","receipt":{"kind":"started","pid":12}})),
            Ok(Admission::InstallerReceipt(Receipt::Started { pid: 12 }))
        );
        assert_eq!(
            parse(
                &json!({"intent":"installerReceipt","receipt":{"kind":"failed","message":"no","code":"ENOENT"}})
            ),
            Ok(Admission::InstallerReceipt(Receipt::Failed {
                message: "no".into(),
                code: Some("ENOENT".into())
            }))
        );
        assert_eq!(
            parse(&json!({"intent":"installerReceipt","receipt":{"kind":"failed","message":"no"}})),
            Ok(Admission::InstallerReceipt(Receipt::Failed {
                message: "no".into(),
                code: None
            }))
        );
        for bad in [
            json!(null),
            json!("ask"),
            json!({}),
            json!({"intent":"quit"}),
            json!({"intent":"ask","receipt":{"kind":"started","pid":1}}),
            json!({"intent":"installerPending","receipt":null}),
            json!({"intent":"installerReceipt"}),
            json!({"intent":"installerReceipt","receipt":{"kind":"started"}}),
            json!({"intent":"installerReceipt","receipt":{"kind":"started","pid":0}}),
            json!({"intent":"installerReceipt","receipt":{"kind":"started","pid":-1}}),
            json!({"intent":"installerReceipt","receipt":{"kind":"started","pid":"1"}}),
            json!({"intent":"installerReceipt","receipt":{"kind":"started","pid":1,"code":"X"}}),
            json!({"intent":"installerReceipt","receipt":{"kind":"failed"}}),
            json!({"intent":"installerReceipt","receipt":{"kind":"failed","message":"no","code":1}}),
            json!({"intent":"installerReceipt","receipt":{"kind":"spawned","pid":1}}),
        ] {
            assert!(parse(&bad).is_err(), "{bad} is refused");
        }
    }
}
