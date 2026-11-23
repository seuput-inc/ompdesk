use serde_json::Value;
use std::collections::VecDeque;

#[path = "../../../shell/src/clipboard_password.rs"]
mod clipboard_password;
use clipboard_password::PasswordCopy;

#[derive(Default)]
pub struct Clipboard {
    text: String,
    revision: i64,
    now: i64,
    timers: VecDeque<(i64, PasswordCopy)>,
}

impl Clipboard {
    pub fn call(&mut self, method: &str, params: &Value) -> Value {
        match method {
            "clipboard.writePassword" | "clipboard.replace" => {
                self.text = params["text"].as_str().unwrap().to_owned();
                self.revision += 1;
                if method == "clipboard.writePassword" {
                    PasswordCopy(self.revision)
                        .schedule(|ms, copy| self.timers.push_back((self.now + ms, copy)));
                }
            }
            "clipboard.advance" => {
                self.now += params["ms"].as_i64().unwrap();
                while let Some((_, copy)) = self.timers.pop_front_if(|(at, _)| *at <= self.now) {
                    copy.expire(self.revision, || self.text.clear());
                }
            }
            "clipboard.read" => return Value::String(self.text.clone()),
            _ => panic!("unknown clipboard fixture method"),
        }
        Value::Null
    }
}
