// UNVERIFIED on macOS: written against objc2 0.6 / objc2-foundation 0.3 and AppKit's headers; never compiled.
//! macOS counterpart of `sys::clipboard`: the general pasteboard as plain text (`public.utf8-plain-text`).
#![allow(unsafe_code)]

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use objc2_foundation::{NSArray, NSString};

use crate::clipboard_password::PasswordCopy;

const TEXT_TYPE: &str = "public.utf8-plain-text";

fn pasteboard() -> Retained<AnyObject> {
    // SAFETY: NSPasteboard's class method; the general pasteboard always exists.
    unsafe { msg_send![class!(NSPasteboard), generalPasteboard] }
}

/// The pasteboard's text, `""` when it holds none.
pub fn read_text() -> Result<String, String> {
    let board = pasteboard();
    // SAFETY: NSPasteboard messages with an NSString type; the answer is nil or an NSString.
    let text: Option<Retained<NSString>> =
        unsafe { msg_send![&*board, stringForType: &*NSString::from_str(TEXT_TYPE)] };
    Ok(text.map(|t| t.to_string()).unwrap_or_default())
}

/// Replaces the pasteboard's content with `text`.
pub fn write_text(text: &str) -> Result<(), String> {
    let board = pasteboard();
    // SAFETY: NSPasteboard messages with NSString arguments; `clearContents` must precede `setString:forType:`.
    let stored: bool = unsafe {
        let _: isize = msg_send![&*board, clearContents];
        msg_send![&*board, setString: &*NSString::from_str(text), forType: &*NSString::from_str(TEXT_TYPE)]
    };
    if stored {
        Ok(())
    } else {
        Err("the pasteboard refused the text".into())
    }
}

// Use the declaring receiver for the later ownership-checked write. Only the UI thread accesses it.
thread_local! {
    static PASSWORD_BOARD: Retained<AnyObject> = pasteboard();
}

pub fn write_password(text: &str) -> Result<PasswordCopy, String> {
    PASSWORD_BOARD.with(|board| {
        let kind = NSString::from_str(TEXT_TYPE);
        let types = NSArray::from_slice(&[&*kind]);
        // SAFETY: nil owner is valid when we supply all declared types immediately.
        let revision: isize = unsafe {
            msg_send![&**board, declareTypes: &*types, owner: std::ptr::null::<AnyObject>()]
        };
        let value = NSString::from_str(text);
        // SAFETY: the receiver declared this NSString type above.
        let stored: bool = unsafe { msg_send![&**board, setString: &*value, forType: &*kind] };
        if stored {
            Ok(PasswordCopy(revision as i64))
        } else {
            Err("the pasteboard refused the text".into())
        }
    })
}

pub fn expire(copy: PasswordCopy) {
    PASSWORD_BOARD.with(|board| {
        // SAFETY: changeCount reads the pasteboard's generation without requesting its contents.
        let revision: isize = unsafe { msg_send![&**board, changeCount] };
        copy.expire(revision as i64, || {
            let empty = NSString::from_str("");
            let kind = NSString::from_str(TEXT_TYPE);
            // SAFETY: setString:forType: refuses changed ownership. clearContents would take it back.
            let _: bool = unsafe { msg_send![&**board, setString: &*empty, forType: &*kind] };
        });
    });
}
