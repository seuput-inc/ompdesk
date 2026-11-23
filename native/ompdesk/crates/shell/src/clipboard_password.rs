//! A password timer holds the clipboard revision, never the password.

pub struct PasswordCopy(pub i64);

impl PasswordCopy {
    pub fn schedule(self, after: impl FnOnce(i64, Self)) {
        after(60_000, self);
    }

    pub fn expire(self, current: i64, clear_owned: impl FnOnce()) {
        if self.0 == current {
            clear_owned();
        }
    }
}
