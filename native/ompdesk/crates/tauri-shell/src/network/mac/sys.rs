//! CFHTTP read streams. CFHTTPStream remains callable but Apple deprecated it in macOS 10.11.
#![allow(unsafe_code)]

use super::super::Transfer;
use shell_core::netmap::{self, CacheMode, Challenge, LoginAnswer, Redirect};
use std::{
    ffi::{c_char, c_void},
    panic::{AssertUnwindSafe, catch_unwind},
    ptr,
    sync::{Arc, Mutex, mpsc},
};

type CF = *const c_void;
const NULL: CF = ptr::null();
const UTF8: u32 = 0x0800_0100;

#[repr(C)]
struct StreamContext {
    version: isize,
    info: *mut c_void,
    retain: CF,
    release: CF,
    description: CF,
}
#[repr(C)]
struct SourceContext {
    version: isize,
    info: *mut c_void,
    retain: CF,
    release: CF,
    description: CF,
    equal: CF,
    hash: CF,
    schedule: CF,
    cancel: CF,
    perform: Option<extern "C" fn(*mut c_void)>,
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    static kCFRunLoopDefaultMode: CF;
    static kCFTypeDictionaryKeyCallBacks: c_void;
    static kCFTypeDictionaryValueCallBacks: c_void;
    static kCFStreamPropertySOCKSProxy: CF;
    static kCFStreamPropertySOCKSProxyHost: CF;
    static kCFStreamPropertySOCKSProxyPort: CF;
    fn CFRetain(o: CF) -> CF;
    fn CFRelease(o: CF);
    fn CFEqual(a: CF, b: CF) -> u8;
    fn CFStringCreateWithBytes(
        a: CF,
        bytes: *const u8,
        len: isize,
        encoding: u32,
        external: u8,
    ) -> CF;
    fn CFStringGetLength(s: CF) -> isize;
    fn CFStringGetMaximumSizeForEncoding(n: isize, encoding: u32) -> isize;
    fn CFStringGetCString(s: CF, out: *mut c_char, size: isize, encoding: u32) -> u8;
    fn CFURLCreateWithString(a: CF, s: CF, base: CF) -> CF;
    fn CFURLCopyAbsoluteURL(url: CF) -> CF;
    fn CFURLGetString(url: CF) -> CF;
    fn CFURLCopyHostName(url: CF) -> CF;
    fn CFURLCopyScheme(url: CF) -> CF;
    fn CFURLGetPortNumber(url: CF) -> i32;
    fn CFDataCreate(a: CF, data: *const u8, len: isize) -> CF;
    fn CFDictionaryCreate(
        a: CF,
        keys: *const CF,
        values: *const CF,
        n: isize,
        kc: CF,
        vc: CF,
    ) -> CF;
    fn CFDictionaryGetValue(dict: CF, key: CF) -> CF;
    fn CFDictionaryGetCount(dict: CF) -> isize;
    fn CFDictionaryGetKeysAndValues(dict: CF, keys: *mut CF, values: *mut CF);
    fn CFArrayGetCount(array: CF) -> isize;
    fn CFArrayGetValueAtIndex(array: CF, index: isize) -> CF;
    fn CFNumberGetValue(number: CF, kind: isize, out: *mut c_void) -> u8;
    fn CFErrorCopyDescription(error: CF) -> CF;
    fn CFErrorGetDomain(error: CF) -> CF;
    fn CFErrorGetCode(error: CF) -> isize;
    fn CFRunLoopGetCurrent() -> CF;
    fn CFRunLoopRunInMode(mode: CF, seconds: f64, one: u8) -> i32;
    fn CFRunLoopAddSource(rl: CF, source: CF, mode: CF);
    fn CFRunLoopRemoveSource(rl: CF, source: CF, mode: CF);
    fn CFRunLoopSourceCreate(a: CF, order: isize, ctx: *mut SourceContext) -> CF;
    fn CFRunLoopSourceSignal(source: CF);
    fn CFRunLoopSourceInvalidate(source: CF);
    fn CFRunLoopWakeUp(rl: CF);
    fn CFReadStreamSetClient(
        stream: CF,
        events: usize,
        callback: Option<extern "C" fn(CF, usize, *mut c_void)>,
        context: *mut StreamContext,
    ) -> u8;
    fn CFReadStreamScheduleWithRunLoop(stream: CF, rl: CF, mode: CF);
    fn CFReadStreamUnscheduleFromRunLoop(stream: CF, rl: CF, mode: CF);
    fn CFReadStreamOpen(stream: CF) -> u8;
    fn CFReadStreamClose(stream: CF);
    fn CFReadStreamHasBytesAvailable(stream: CF) -> u8;
    fn CFReadStreamRead(stream: CF, buf: *mut u8, len: isize) -> isize;
    fn CFReadStreamCopyProperty(stream: CF, key: CF) -> CF;
    fn CFReadStreamSetProperty(stream: CF, key: CF, value: CF) -> u8;
    fn CFReadStreamCopyError(stream: CF) -> CF;
}
#[link(name = "CFNetwork", kind = "framework")]
unsafe extern "C" {
    static kCFErrorDomainCFNetwork: CF;
    static kCFHTTPVersion1_1: CF;
    static kCFStreamPropertyHTTPResponseHeader: CF;
    static kCFStreamPropertyHTTPProxy: CF;
    static kCFStreamPropertyHTTPProxyHost: CF;
    static kCFStreamPropertyHTTPProxyPort: CF;
    static kCFStreamPropertyHTTPSProxyHost: CF;
    static kCFStreamPropertyHTTPSProxyPort: CF;
    static kCFProxyTypeKey: CF;
    static kCFProxyTypeNone: CF;
    static kCFProxyTypeHTTP: CF;
    static kCFProxyTypeHTTPS: CF;
    static kCFProxyTypeSOCKS: CF;
    static kCFProxyTypeAutoConfigurationURL: CF;
    static kCFProxyTypeAutoConfigurationJavaScript: CF;
    static kCFProxyAutoConfigurationURLKey: CF;
    static kCFProxyAutoConfigurationJavaScriptKey: CF;
    static kCFProxyHostNameKey: CF;
    static kCFProxyPortNumberKey: CF;
    fn CFHTTPMessageCreateRequest(a: CF, method: CF, url: CF, version: CF) -> CF;
    fn CFHTTPMessageSetHeaderFieldValue(message: CF, name: CF, value: CF);
    fn CFHTTPMessageSetBody(message: CF, body: CF);
    fn CFHTTPMessageGetResponseStatusCode(message: CF) -> isize;
    fn CFHTTPMessageCopyAllHeaderFields(message: CF) -> CF;
    fn CFHTTPMessageAddAuthentication(
        request: CF,
        response: CF,
        user: CF,
        pass: CF,
        scheme: CF,
        proxy: u8,
    ) -> u8;
    fn CFHTTPAuthenticationCreateFromResponse(a: CF, response: CF) -> CF;
    fn CFHTTPAuthenticationCopyRealm(auth: CF) -> CF;
    fn CFHTTPAuthenticationCopyMethod(auth: CF) -> CF;
    fn CFReadStreamCreateForHTTPRequest(a: CF, request: CF) -> CF;
    fn CFNetworkCopySystemProxySettings() -> CF;
    fn CFNetworkCopyProxiesForURL(url: CF, settings: CF) -> CF;
    fn CFNetworkExecuteProxyAutoConfigurationURL(
        pac: CF,
        target: CF,
        cb: extern "C" fn(*mut c_void, CF, CF),
        ctx: *mut StreamContext,
    ) -> CF;
    fn CFNetworkExecuteProxyAutoConfigurationScript(
        pac: CF,
        target: CF,
        cb: extern "C" fn(*mut c_void, CF, CF),
        ctx: *mut StreamContext,
    ) -> CF;
}

struct Owned(CF);
impl Owned {
    fn new(value: CF, what: &str) -> Result<Self, String> {
        if value.is_null() {
            Err(format!("{what} failed"))
        } else {
            Ok(Self(value))
        }
    }
}
impl Drop for Owned {
    fn drop(&mut self) {
        // SAFETY: Owned contains one retained CF object.
        unsafe { CFRelease(self.0) }
    }
}
fn string(s: &str) -> Result<Owned, String> {
    if s.as_bytes().contains(&0) {
        return Err("NUL in HTTP string".into());
    }
    let len = isize::try_from(s.len()).map_err(|_| "HTTP string is too large")?;
    // SAFETY: s is valid UTF-8 for len bytes; the created CFString owns its copy.
    Owned::new(
        unsafe { CFStringCreateWithBytes(NULL, s.as_ptr(), len, UTF8, 0) },
        "CFStringCreateWithBytes",
    )
}
fn text(s: CF) -> Option<String> {
    if s.is_null() {
        return None;
    }
    // SAFETY: caller supplies a live CFString; buffer has room for its UTF-8 representation and terminator.
    unsafe {
        let n = CFStringGetMaximumSizeForEncoding(CFStringGetLength(s), UTF8).checked_add(1)?;
        let mut buf = vec![0u8; usize::try_from(n).ok()?];
        if CFStringGetCString(s, buf.as_mut_ptr().cast(), n, UTF8) == 0 {
            return None;
        }
        let end = buf.iter().position(|b| *b == 0)?;
        buf.truncate(end);
        String::from_utf8(buf).ok()
    }
}
fn url(value: &str, base: CF) -> Result<Owned, String> {
    let s = string(value)?;
    // SAFETY: s and optional base are live CF objects.
    let relative = Owned::new(
        unsafe { CFURLCreateWithString(NULL, s.0, base) },
        "CFURLCreateWithString",
    )?;
    // SAFETY: relative is a live URL.
    Owned::new(
        unsafe { CFURLCopyAbsoluteURL(relative.0) },
        "CFURLCopyAbsoluteURL",
    )
}
fn url_text(u: CF) -> Result<String, String> {
    // SAFETY: u is a live URL and the returned string is borrowed from it.
    text(unsafe { CFURLGetString(u) }).ok_or_else(|| "Invalid URL".into())
}
fn origin(u: CF) -> Result<(String, String, i32), String> {
    // SAFETY: u is a live URL and both Copy results are owned here.
    unsafe {
        let scheme = Owned::new(CFURLCopyScheme(u), "URL scheme")?;
        let host = Owned::new(CFURLCopyHostName(u), "URL host")?;
        let scheme = text(scheme.0)
            .ok_or("Invalid URL scheme")?
            .to_ascii_lowercase();
        if !matches!(scheme.as_str(), "http" | "https") {
            return Err(netmap::error_text(-302));
        }
        let host = text(host.0).ok_or("Invalid URL host")?.to_ascii_lowercase();
        let port = CFURLGetPortNumber(u);
        let port = if port < 0 {
            match scheme.as_str() {
                "http" => 80,
                "https" => 443,
                _ => return Err("Unsupported redirect URL scheme".into()),
            }
        } else {
            port
        };
        Ok((scheme, host, port))
    }
}
fn description(error: CF) -> String {
    if error.is_null() {
        return "CFNetwork request failed".into();
    }
    // SAFETY: error is a live CFError and its description is retained.
    unsafe {
        Owned::new(CFErrorCopyDescription(error), "CFErrorCopyDescription")
            .ok()
            .and_then(|s| text(s.0))
            .unwrap_or_else(|| "CFNetwork request failed".into())
    }
}
fn stream_error(stream: CF) -> String {
    // SAFETY: stream is live; CopyError returns an owned error or null.
    unsafe {
        Owned::new(CFReadStreamCopyError(stream), "CFReadStreamCopyError")
            .map_or_else(|_| "CFNetwork stream failed".into(), |e| description(e.0))
    }
}
fn proxy_connection_failed(stream: CF) -> bool {
    // SAFETY: stream is live and CopyError gives an owned CFError. Only explicit proxy-connect failures may retry.
    unsafe {
        let Ok(error) = Owned::new(CFReadStreamCopyError(stream), "CFReadStreamCopyError") else {
            return false;
        };
        CFEqual(CFErrorGetDomain(error.0), kCFErrorDomainCFNetwork) != 0
            && matches!(CFErrorGetCode(error.0), 306 | 310)
    }
}

// The mutex makes signaling and destruction mutually exclusive. Only the worker owns stream handles.
#[derive(Default)]
struct Wake(Mutex<Option<(usize, usize)>>);
impl Wake {
    fn signal(&self) {
        let guard = self.0.lock().unwrap();
        if let Some((source, run_loop)) = *guard {
            // SAFETY: the worker keeps both CF objects alive until it clears this slot under the same mutex.
            unsafe {
                CFRunLoopSourceSignal(source as CF);
                CFRunLoopWakeUp(run_loop as CF);
            }
        }
    }
}
extern "C" fn wake_callback(_: *mut c_void) {}
struct Loop {
    run_loop: CF,
    source: Owned,
    wake: Arc<Wake>,
}
impl Loop {
    fn new(transfer: &Arc<Transfer>) -> Result<Self, String> {
        let wake = Arc::new(Wake::default());
        let mut ctx = SourceContext {
            version: 0,
            info: ptr::null_mut(),
            retain: NULL,
            release: NULL,
            description: NULL,
            equal: NULL,
            hash: NULL,
            schedule: NULL,
            cancel: NULL,
            perform: Some(wake_callback),
        };
        // SAFETY: context has a no-op callback and no borrowed state. Source and run loop live on the worker.
        unsafe {
            let run_loop = CFRunLoopGetCurrent();
            let source = Owned::new(
                CFRunLoopSourceCreate(NULL, 0, &mut ctx),
                "CFRunLoopSourceCreate",
            )?;
            CFRunLoopAddSource(run_loop, source.0, kCFRunLoopDefaultMode);
            *wake.0.lock().unwrap() = Some((source.0 as usize, run_loop as usize));
            let cancel = wake.clone();
            transfer.set_cancel(move || cancel.signal());
            Ok(Self {
                run_loop,
                source,
                wake,
            })
        }
    }
    fn step(&self) {
        // SAFETY: the worker runs its own loop; source keeps the mode alive.
        unsafe {
            CFRunLoopRunInMode(kCFRunLoopDefaultMode, 1.0e9, 1);
        }
    }
}
impl Drop for Loop {
    fn drop(&mut self) {
        *self.wake.0.lock().unwrap() = None;
        // SAFETY: only this worker schedules and invalidates its source, after excluding all signalers.
        unsafe {
            CFRunLoopRemoveSource(self.run_loop, self.source.0, kCFRunLoopDefaultMode);
            CFRunLoopSourceInvalidate(self.source.0);
        }
    }
}

#[derive(Clone)]
enum Proxy {
    Direct,
    Http { host: String, port: i32 },
    Socks { host: String, port: i32 },
}
struct Pac {
    result: Option<Result<Owned, String>>,
}
extern "C" fn pac_done(info: *mut c_void, list: CF, error: CF) {
    // SAFETY: info points to the worker's Pac until the source is invalidated; callback runs on that worker.
    unsafe {
        let state = &mut *info.cast::<Pac>();
        state.result = Some(if !error.is_null() {
            Err(description(error))
        } else if list.is_null() {
            Err("PAC returned no proxy list".into())
        } else {
            Ok(Owned(CFRetain(list)))
        });
    }
}
fn proxy_list(
    array: CF,
    target: CF,
    loop_: &Loop,
    transfer: &Transfer,
    out: &mut Vec<Proxy>,
    pac_allowed: bool,
) -> Result<(), String> {
    // SAFETY: all array entries and dictionary values are borrowed while their owning arrays remain alive.
    unsafe {
        for i in 0..CFArrayGetCount(array) {
            let item = CFArrayGetValueAtIndex(array, i);
            let kind = CFDictionaryGetValue(item, kCFProxyTypeKey);
            if kind.is_null() {
                return Err("Proxy entry has no type".into());
            }
            if CFEqual(kind, kCFProxyTypeNone) != 0 {
                out.push(Proxy::Direct);
                continue;
            }
            let pac_url = CFEqual(kind, kCFProxyTypeAutoConfigurationURL) != 0;
            let pac_script = CFEqual(kind, kCFProxyTypeAutoConfigurationJavaScript) != 0;
            if pac_url || pac_script {
                if !pac_allowed {
                    return Err("Nested PAC result".into());
                }
                let key = if pac_url {
                    kCFProxyAutoConfigurationURLKey
                } else {
                    kCFProxyAutoConfigurationJavaScriptKey
                };
                let script = CFDictionaryGetValue(item, key);
                if script.is_null() {
                    return Err("PAC entry has no script".into());
                }
                let mut state = Pac { result: None };
                let mut context = StreamContext {
                    version: 0,
                    info: (&mut state as *mut Pac).cast(),
                    retain: NULL,
                    release: NULL,
                    description: NULL,
                };
                let source = if pac_url {
                    CFNetworkExecuteProxyAutoConfigurationURL(
                        script,
                        target,
                        pac_done,
                        &mut context,
                    )
                } else {
                    CFNetworkExecuteProxyAutoConfigurationScript(
                        script,
                        target,
                        pac_done,
                        &mut context,
                    )
                };
                let source = Owned::new(source, "PAC evaluation")?;
                CFRunLoopAddSource(loop_.run_loop, source.0, kCFRunLoopDefaultMode);
                while state.result.is_none() && !transfer.is_cancelled() {
                    loop_.step();
                }
                CFRunLoopRemoveSource(loop_.run_loop, source.0, kCFRunLoopDefaultMode);
                CFRunLoopSourceInvalidate(source.0);
                if transfer.is_cancelled() {
                    return Err(netmap::error_text(-3));
                }
                let list = state.result.ok_or("PAC did not complete")??;
                proxy_list(list.0, target, loop_, transfer, out, false)?;
                continue;
            }
            let http = CFEqual(kind, kCFProxyTypeHTTP) != 0;
            let https = CFEqual(kind, kCFProxyTypeHTTPS) != 0;
            let socks = CFEqual(kind, kCFProxyTypeSOCKS) != 0;
            if !http && !https && !socks {
                return Err("Unsupported system proxy type".into());
            }
            let host =
                text(CFDictionaryGetValue(item, kCFProxyHostNameKey)).ok_or("Proxy has no host")?;
            let port_obj = CFDictionaryGetValue(item, kCFProxyPortNumberKey);
            let mut port = 0i32;
            if port_obj.is_null()
                || CFNumberGetValue(port_obj, 3, (&mut port as *mut i32).cast()) == 0
                || !(1..=65535).contains(&port)
            {
                return Err("Proxy has invalid port".into());
            }
            out.push(if socks {
                Proxy::Socks { host, port }
            } else {
                Proxy::Http { host, port }
            });
        }
    }
    Ok(())
}
fn proxies(target: CF, loop_: &Loop, transfer: &Transfer) -> Result<Vec<Proxy>, String> {
    // SAFETY: target is a live URL. A null system settings result is ambiguous between no settings and failure.
    unsafe {
        let settings = Owned::new(CFNetworkCopySystemProxySettings(), "System proxy settings")?;
        let list = Owned::new(
            CFNetworkCopyProxiesForURL(target, settings.0),
            "System proxy resolution",
        )?;
        let mut result = Vec::new();
        proxy_list(list.0, target, loop_, transfer, &mut result, true)?;
        if result.is_empty() {
            return Err("System proxy resolution returned no routes".into());
        }
        Ok(result)
    }
}
fn set_proxy(stream: CF, proxy: &Proxy, target: CF) -> Result<(), String> {
    let (host, port, key, host_key, port_key) = match proxy {
        Proxy::Direct => return Ok(()),
        // SAFETY: these are immutable framework constants. HTTPS targets use the tunnel proxy keys.
        Proxy::Http { host, port, .. } => unsafe {
            let tls = origin(target)?.0 == "https";
            (
                host,
                port,
                kCFStreamPropertyHTTPProxy,
                if tls {
                    kCFStreamPropertyHTTPSProxyHost
                } else {
                    kCFStreamPropertyHTTPProxyHost
                },
                if tls {
                    kCFStreamPropertyHTTPSProxyPort
                } else {
                    kCFStreamPropertyHTTPProxyPort
                },
            )
        },
        // SAFETY: these are immutable framework constants.
        Proxy::Socks { host, port } => unsafe {
            (
                host,
                port,
                kCFStreamPropertySOCKSProxy,
                kCFStreamPropertySOCKSProxyHost,
                kCFStreamPropertySOCKSProxyPort,
            )
        },
    };
    let host = string(host)?;
    // SAFETY: CFNumber and dictionary retain their inputs and are scoped to this call.
    unsafe {
        unsafe extern "C" {
            fn CFNumberCreate(a: CF, kind: isize, value: *const c_void) -> CF;
        }
        let number = Owned::new(
            CFNumberCreate(NULL, 3, (port as *const i32).cast()),
            "CFNumberCreate",
        )?;
        let keys = [host_key, port_key];
        let values = [host.0, number.0];
        let dict = Owned::new(
            CFDictionaryCreate(
                NULL,
                keys.as_ptr(),
                values.as_ptr(),
                2,
                (&kCFTypeDictionaryKeyCallBacks as *const c_void).cast(),
                (&kCFTypeDictionaryValueCallBacks as *const c_void).cast(),
            ),
            "Proxy dictionary",
        )?;
        if CFReadStreamSetProperty(stream, key, dict.0) == 0 {
            return Err("CFNetwork rejected proxy settings".into());
        }
    }
    Ok(())
}

#[derive(Default)]
struct Events {
    flags: usize,
}
extern "C" fn stream_event(_: CF, event: usize, info: *mut c_void) {
    // SAFETY: the worker keeps Events alive until the stream client is unscheduled and removed.
    unsafe {
        (*info.cast::<Events>()).flags |= event;
    }
}
struct Stream {
    raw: Owned,
    run_loop: CF,
}
impl Drop for Stream {
    fn drop(&mut self) {
        // SAFETY: only the worker uses this stream; remove the callback before its context leaves scope.
        unsafe {
            CFReadStreamClose(self.raw.0);
            CFReadStreamUnscheduleFromRunLoop(self.raw.0, self.run_loop, kCFRunLoopDefaultMode);
            CFReadStreamSetClient(self.raw.0, 0, None, ptr::null_mut());
        }
    }
}
fn headers(response: CF) -> Result<Vec<(String, String)>, String> {
    // SAFETY: response is a live HTTP response and the copied dictionary owns its entries.
    unsafe {
        let fields = Owned::new(
            CFHTTPMessageCopyAllHeaderFields(response),
            "Response headers",
        )?;
        let count =
            usize::try_from(CFDictionaryGetCount(fields.0)).map_err(|_| "Invalid header count")?;
        let mut keys = vec![NULL; count];
        let mut values = vec![NULL; count];
        CFDictionaryGetKeysAndValues(fields.0, keys.as_mut_ptr(), values.as_mut_ptr());
        keys.into_iter()
            .zip(values)
            .map(|(k, v)| {
                Ok((
                    text(k).ok_or("Invalid response header name")?,
                    text(v).ok_or("Invalid response header value")?,
                ))
            })
            .collect()
    }
}
fn request(
    url: CF,
    method: &str,
    fields: &[(String, String)],
    body: Option<&[u8]>,
    auth: &[Option<(Owned, String, String)>; 2],
) -> Result<Owned, String> {
    let method = string(method)?;
    // SAFETY: request inputs are live CF objects, and the created message owns its contents.
    unsafe {
        let message = Owned::new(
            CFHTTPMessageCreateRequest(NULL, method.0, url, kCFHTTPVersion1_1),
            "CFHTTPMessageCreateRequest",
        )?;
        for (i, (name, value)) in fields.iter().enumerate() {
            if fields[..i]
                .iter()
                .any(|(previous, _)| previous.eq_ignore_ascii_case(name))
            {
                continue;
            }
            let mut joined = std::borrow::Cow::Borrowed(value.as_str());
            for (_, extra) in fields[i + 1..]
                .iter()
                .filter(|(other, _)| other.eq_ignore_ascii_case(name))
            {
                let combined = joined.to_mut();
                combined.push_str(", ");
                combined.push_str(extra);
            }
            let name = string(name)?;
            let value = string(&joined)?;
            CFHTTPMessageSetHeaderFieldValue(message.0, name.0, value.0);
        }
        if let Some(body) = body {
            let length_name = string("Content-Length")?;
            let length = string(&body.len().to_string())?;
            CFHTTPMessageSetHeaderFieldValue(message.0, length_name.0, length.0);
            let data = Owned::new(
                CFDataCreate(
                    NULL,
                    body.as_ptr(),
                    isize::try_from(body.len()).map_err(|_| "Request body too large")?,
                ),
                "CFDataCreate",
            )?;
            CFHTTPMessageSetBody(message.0, data.0);
        }
        for (index, credential) in auth.iter().enumerate() {
            if let Some((response, user, pass)) = credential {
                let user = string(user)?;
                let pass = string(pass)?;
                if CFHTTPMessageAddAuthentication(
                    message.0,
                    response.0,
                    user.0,
                    pass.0,
                    NULL,
                    u8::from(index == 1),
                ) == 0
                {
                    return Err("CFNetwork could not apply HTTP authentication".into());
                }
            }
        }
        Ok(message)
    }
}
fn login(
    transfer: &Arc<Transfer>,
    loop_: &Loop,
    response: CF,
    proxy: &Proxy,
    target: CF,
    is_proxy: bool,
) -> Result<LoginAnswer, String> {
    // SAFETY: response and target are live on the worker and copied objects are owned.
    unsafe {
        // A missing or unsupported challenge leaves the actual 401/407 response intact.
        let Ok(auth) = Owned::new(
            CFHTTPAuthenticationCreateFromResponse(NULL, response),
            "HTTP authentication",
        ) else {
            return Ok(LoginAnswer::Cancel);
        };
        let Ok(scheme) = Owned::new(
            CFHTTPAuthenticationCopyMethod(auth.0),
            "Authentication method",
        ) else {
            return Ok(LoginAnswer::Cancel);
        };
        let realm = Owned::new(
            CFHTTPAuthenticationCopyRealm(auth.0),
            "Authentication realm",
        )
        .ok()
        .and_then(|s| text(s.0))
        .unwrap_or_default();
        let (host, port) = if is_proxy {
            match proxy {
                Proxy::Http { host, port, .. } | Proxy::Socks { host, port } => {
                    (host.clone(), *port)
                }
                Proxy::Direct => return Ok(LoginAnswer::Cancel),
            }
        } else {
            let (_, host, port) = origin(target)?;
            (host, port)
        };
        let challenge = Challenge {
            is_proxy,
            scheme: text(scheme.0)
                .ok_or("Invalid authentication method")?
                .to_ascii_lowercase(),
            host,
            port,
            realm,
        };
        let (send, receive) = mpsc::channel();
        let wake = loop_.wake.clone();
        transfer.login(challenge, move |answer| {
            let _ = send.send(answer);
            wake.signal();
        });
        loop {
            match receive.try_recv() {
                Ok(answer) => return Ok(answer),
                Err(mpsc::TryRecvError::Disconnected) => return Err("Login callback closed".into()),
                Err(mpsc::TryRecvError::Empty) => {}
            }
            if transfer.is_cancelled() {
                return Err(netmap::error_text(-3));
            }
            loop_.step();
        }
    }
}

pub(super) fn start(transfer: Arc<Transfer>, body: Option<Vec<u8>>) -> Result<(), String> {
    std::thread::Builder::new()
        .name("network-cfstream".into())
        .spawn(move || {
            let result = catch_unwind(AssertUnwindSafe(|| run(&transfer, body)));
            match result {
                Ok(Ok(())) => transfer.finish(None),
                Ok(Err(error)) => transfer.finish(Some(error)),
                Err(_) => transfer.finish(Some("CFNetwork worker panicked".into())),
            }
        })
        .map_err(|e| format!("Unable to start CFNetwork worker: {e}"))?;
    Ok(())
}
fn run(transfer: &Arc<Transfer>, mut body: Option<Vec<u8>>) -> Result<(), String> {
    if transfer.params.cache == CacheMode::OnlyIfCached {
        return Err("CFHTTPStream has no HTTP cache".into());
    }
    let loop_ = Loop::new(transfer)?;
    let mut target = url(&transfer.params.url, NULL)?;
    let mut method = transfer.params.method.clone();
    let mut base = transfer.params.headers.clone();
    let mut redirects = 0;
    let mut auth: [Option<(Owned, String, String)>; 2] = [None, None];
    let mut retry_proxy: Option<Proxy> = None;
    'hop: loop {
        if transfer.is_cancelled() {
            return Err(netmap::error_text(-3));
        }
        let target_text = url_text(target.0)?;
        let routes = match retry_proxy.take() {
            Some(route) => vec![route],
            None => {
                auth[1] = None;
                proxies(target.0, &loop_, transfer)?
            }
        };
        let mut last_error = None;
        for proxy in routes {
            let fields = transfer.request_headers(&target_text, &base)?;
            let message = request(target.0, &method, &fields, body.as_deref(), &auth)?;
            // SAFETY: message is live, and the stream copies the request.
            let raw = Owned::new(
                unsafe { CFReadStreamCreateForHTTPRequest(NULL, message.0) },
                "CFReadStreamCreateForHTTPRequest",
            )?;
            set_proxy(raw.0, &proxy, target.0)?;
            let mut events = Events::default();
            let mut context = StreamContext {
                version: 0,
                info: (&mut events as *mut Events).cast(),
                retain: NULL,
                release: NULL,
                description: NULL,
            };
            // SAFETY: context remains live through Stream drop and callbacks run on this worker's run loop.
            unsafe {
                if CFReadStreamSetClient(raw.0, 1 | 2 | 8 | 16, Some(stream_event), &mut context)
                    == 0
                {
                    return Err("CFReadStreamSetClient failed".into());
                }
                CFReadStreamScheduleWithRunLoop(raw.0, loop_.run_loop, kCFRunLoopDefaultMode);
            }
            let stream = Stream {
                raw,
                run_loop: loop_.run_loop,
            };
            // SAFETY: stream is live and scheduled on the worker.
            if unsafe { CFReadStreamOpen(stream.raw.0) } == 0 {
                let error = stream_error(stream.raw.0);
                if matches!(proxy, Proxy::Direct) || !proxy_connection_failed(stream.raw.0) {
                    return Err(error);
                }
                last_error = Some(error);
                continue;
            }
            let mut sent_head = false;
            let mut decoder = None;
            loop {
                if transfer.is_cancelled() {
                    return Err(netmap::error_text(-3));
                }
                if events.flags == 0 {
                    loop_.step();
                    continue;
                }
                let flags = std::mem::take(&mut events.flags);
                if flags & (2 | 16) != 0 && !sent_head {
                    // SAFETY: stream owns the response property; CopyProperty returns a retained message.
                    let response = Owned::new(
                        unsafe {
                            CFReadStreamCopyProperty(
                                stream.raw.0,
                                kCFStreamPropertyHTTPResponseHeader,
                            )
                        },
                        "HTTP response header",
                    )?;
                    // SAFETY: response is a live CFHTTPMessage.
                    let status = unsafe { CFHTTPMessageGetResponseStatusCode(response.0) } as i32;
                    let fields = headers(response.0)?;
                    transfer.response_cookies(&target_text, &fields)?;
                    if status == 401 || status == 407 {
                        let answer = login(
                            transfer,
                            &loop_,
                            response.0,
                            &proxy,
                            target.0,
                            status == 407,
                        )?;
                        if let LoginAnswer::Credentials { username, password } = answer {
                            auth[usize::from(status == 407)] = Some((response, username, password));
                            retry_proxy = Some(proxy.clone());
                            continue 'hop;
                        }
                    }
                    let location = fields
                        .iter()
                        .find(|(name, _)| name.eq_ignore_ascii_case("location"))
                        .map(|(_, value)| value.as_str());
                    if netmap::is_redirect(status, location.is_some())
                        && transfer.params.redirect == Redirect::Follow
                    {
                        redirects += 1;
                        if redirects > 20 {
                            return Err(netmap::error_text(-310));
                        }
                        let next = url(location.ok_or("Missing redirect location")?, target.0)?;
                        if origin(target.0)? != origin(next.0)? {
                            base.retain(|(name, _)| {
                                !name.eq_ignore_ascii_case("authorization")
                                    && !name.eq_ignore_ascii_case("proxy-authorization")
                                    && !name.eq_ignore_ascii_case("cookie")
                            });
                            auth[0] = None;
                        }
                        if status == 303 && !method.eq_ignore_ascii_case("HEAD")
                            || matches!(status, 301 | 302) && method.eq_ignore_ascii_case("POST")
                        {
                            method = "GET".into();
                            body = None;
                            base.retain(|(name, _)| {
                                !name.eq_ignore_ascii_case("content-type")
                                    && !name.eq_ignore_ascii_case("content-encoding")
                                    && !name.eq_ignore_ascii_case("content-language")
                                    && !name.eq_ignore_ascii_case("content-location")
                            });
                        }
                        target = next;
                        continue 'hop;
                    }
                    if !transfer.head(status, &target_text, &fields) {
                        return Ok(());
                    }
                    sent_head = true;
                    decoder = Some(super::inflate::sys::Decoder::new(
                        &fields,
                        !method.eq_ignore_ascii_case("HEAD")
                            && !matches!(status, 101 | 204 | 205 | 304),
                    ));
                }
                if flags & (2 | 16) != 0 && !method.eq_ignore_ascii_case("HEAD") {
                    let mut bytes = [0u8; 65536];
                    // SAFETY: only the worker touches the live stream. Check availability before every read.
                    while unsafe { CFReadStreamHasBytesAvailable(stream.raw.0) } != 0 {
                        // SAFETY: availability was just checked on the same worker.
                        let count = unsafe {
                            CFReadStreamRead(stream.raw.0, bytes.as_mut_ptr(), bytes.len() as isize)
                        };
                        if count < 0 {
                            return Err(stream_error(stream.raw.0));
                        }
                        if count == 0 {
                            break;
                        }
                        decoder
                            .as_mut()
                            .ok_or("HTTP body arrived without a response head")?
                            .push(&bytes[..count as usize], |bytes| transfer.chunk(bytes))?;
                    }
                }
                if flags & 8 != 0 {
                    let error = stream_error(stream.raw.0);
                    if sent_head
                        || matches!(proxy, Proxy::Direct)
                        || !proxy_connection_failed(stream.raw.0)
                    {
                        return Err(error);
                    }
                    last_error = Some(error);
                    break;
                }
                if flags & 16 != 0 {
                    if let Some(decoder) = decoder {
                        decoder.finish()?;
                    }
                    return Ok(());
                }
            }
        }
        return Err(last_error.unwrap_or_else(|| "No system proxy route succeeded".into()));
    }
}
