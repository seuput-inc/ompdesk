//! WinHTTP has no Chromium-style HTTP response cache. `only-if-cached` fails and
//! `force-cache` uses the network. Cookies belong to the shared session authority.

#![allow(unsafe_code)]

use std::ffi::c_void;
use std::ptr::{null, null_mut};
use std::sync::{Arc, mpsc};
use std::thread;

use shell_core::netmap::{self, CacheMode, Challenge, LoginAnswer, Redirect};
use url::Url;
use windows_sys::Win32::Foundation::GlobalFree;
use windows_sys::Win32::Networking::WinHttp::*;

use super::super::Transfer;

type Handle = *mut c_void;

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

fn failure(operation: &str) -> String {
    format!("WinHTTP {operation}: {}", std::io::Error::last_os_error())
}

fn async_failure(code: u32) -> String {
    if code == 0 {
        "WinHTTP callback channel closed".to_string()
    } else {
        format!(
            "WinHTTP request: {}",
            std::io::Error::from_raw_os_error(code as i32)
        )
    }
}

struct OwnedHandle(Handle);
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        // SAFETY: this wrapper exclusively owns the handle.
        unsafe { WinHttpCloseHandle(self.0) };
    }
}

enum Event {
    Cancel,
    Complete(u32, u32),
    Error(u32),
    Login(LoginAnswer),
    Closing,
}

// WinHTTP may invoke this concurrently. It never calls into the request owner.
unsafe extern "system" fn callback(
    _handle: Handle,
    context: usize,
    status: u32,
    information: *mut c_void,
    length: u32,
) {
    if context == 0 {
        return;
    }
    // SAFETY: the request retains this sender until HANDLE_CLOSING, the final callback.
    let sender = unsafe { (&*(context as *const mpsc::Sender<Event>)).clone() };
    let event = match status {
        WINHTTP_CALLBACK_STATUS_SENDREQUEST_COMPLETE
        | WINHTTP_CALLBACK_STATUS_HEADERS_AVAILABLE
        | WINHTTP_CALLBACK_STATUS_READ_COMPLETE => Event::Complete(status, length),
        WINHTTP_CALLBACK_STATUS_REQUEST_ERROR if !information.is_null() => {
            // SAFETY: WinHTTP supplies a WINHTTP_ASYNC_RESULT for REQUEST_ERROR.
            Event::Error(unsafe { (*(information as *const WINHTTP_ASYNC_RESULT)).dwError })
        }
        WINHTTP_CALLBACK_STATUS_HANDLE_CLOSING => Event::Closing,
        _ => return,
    };
    let _ = sender.send(event);
}

struct Request<'a> {
    handle: Handle,
    receiver: &'a mpsc::Receiver<Event>,
    context: Box<mpsc::Sender<Event>>,
    buffer: Box<[u8; 32768]>,
}

impl<'a> Request<'a> {
    fn new(
        handle: Handle,
        sender: &mpsc::Sender<Event>,
        receiver: &'a mpsc::Receiver<Event>,
    ) -> Result<Self, String> {
        let context = Box::new(sender.clone());
        let address = (&*context as *const mpsc::Sender<Event>) as usize;
        // SAFETY: handle is exclusively owned here and address is a pointer-sized context value.
        if unsafe {
            WinHttpSetOption(
                handle,
                WINHTTP_OPTION_CONTEXT_VALUE,
                (&address as *const usize).cast(),
                std::mem::size_of::<usize>() as u32,
            )
        } == 0
        {
            let error = failure("set callback context");
            // SAFETY: callback registration has not happened and this handle is still owned here.
            unsafe { WinHttpCloseHandle(handle) };
            return Err(error);
        }
        // SAFETY: callback has the required ABI and context remains live until HANDLE_CLOSING.
        let previous = unsafe {
            WinHttpSetStatusCallback(
                handle,
                Some(callback),
                WINHTTP_CALLBACK_FLAG_ALL_NOTIFICATIONS,
                0,
            )
        };
        if previous.is_some_and(|p| p as usize == usize::MAX) {
            let error = failure("set callback");
            // SAFETY: callback registration failed, so no callback can use the context.
            unsafe { WinHttpCloseHandle(handle) };
            return Err(error);
        }
        Ok(Self {
            handle,
            receiver,
            context,
            buffer: Box::new([0; 32768]),
        })
    }

    fn wait(&self, expected: u32, transfer: &Transfer) -> Result<Option<u32>, u32> {
        loop {
            if transfer.is_cancelled() {
                return Ok(None);
            }
            match self.receiver.recv().map_err(|_| 0u32)? {
                Event::Cancel => return Ok(None),
                Event::Complete(status, length) if status == expected => return Ok(Some(length)),
                Event::Error(code) => return Err(code),
                _ => {}
            }
        }
    }

    fn read(&mut self, transfer: &Transfer) -> Result<Option<usize>, String> {
        if transfer.is_cancelled() {
            return Ok(None);
        }
        // SAFETY: the request owns this buffer until HANDLE_CLOSING; the asynchronous byte count must be null.
        if unsafe {
            WinHttpReadData(
                self.handle,
                self.buffer.as_mut_ptr().cast(),
                self.buffer.len() as u32,
                null_mut(),
            )
        } == 0
        {
            return Err(failure("read response"));
        }
        Ok(self
            .wait(WINHTTP_CALLBACK_STATUS_READ_COMPLETE, transfer)
            .map_err(async_failure)?
            .map(|n| n as usize))
    }
}

impl Drop for Request<'_> {
    fn drop(&mut self) {
        // SAFETY: only this owner invokes or closes the request; no API call follows close.
        unsafe { WinHttpCloseHandle(self.handle) };
        while let Ok(event) = self.receiver.recv() {
            if matches!(event, Event::Closing) {
                break;
            }
        }
        // The callback context and pending read buffer remain alive through HANDLE_CLOSING.
        let _ = &self.context;
    }
}

fn option(handle: Handle, name: u32, value: u32) -> Result<(), String> {
    // SAFETY: value is a properly sized DWORD and handle is a live WinHTTP handle.
    if unsafe { WinHttpSetOption(handle, name, (&value as *const u32).cast(), 4) } == 0 {
        Err(failure("set option"))
    } else {
        Ok(())
    }
}

fn raw_headers(handle: Handle) -> Result<Vec<(String, String)>, String> {
    let mut size = 0;
    // SAFETY: querying the required buffer size permits a null buffer.
    unsafe {
        WinHttpQueryHeaders(
            handle,
            WINHTTP_QUERY_RAW_HEADERS_CRLF,
            null(),
            null_mut(),
            &mut size,
            null_mut(),
        )
    };
    if size == 0 {
        return Err(failure("query headers"));
    }
    let mut data = vec![0u16; (size as usize).div_ceil(2)];
    // SAFETY: data has at least size bytes and remains live through the call.
    if unsafe {
        WinHttpQueryHeaders(
            handle,
            WINHTTP_QUERY_RAW_HEADERS_CRLF,
            null(),
            data.as_mut_ptr().cast(),
            &mut size,
            null_mut(),
        )
    } == 0
    {
        return Err(failure("query headers"));
    }
    let text = String::from_utf16_lossy(&data[..(size as usize / 2).min(data.len())]);
    Ok(text
        .trim_end_matches('\0')
        .split("\r\n")
        .skip(1)
        .filter_map(|line| {
            let (name, value) = line.split_once(':')?;
            Some((name.to_string(), value.trim().to_string()))
        })
        .collect())
}

fn status(handle: Handle) -> Result<i32, String> {
    let mut value = 0u32;
    let mut size = 4;
    // SAFETY: value and size point to writable DWORDs.
    if unsafe {
        WinHttpQueryHeaders(
            handle,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            null(),
            (&mut value as *mut u32).cast(),
            &mut size,
            null_mut(),
        )
    } == 0
    {
        Err(failure("query status"))
    } else {
        Ok(value as i32)
    }
}

fn proxy_endpoint(handle: Handle) -> Result<(String, i32), String> {
    let mut info = WINHTTP_PROXY_INFO::default();
    let mut size = std::mem::size_of::<WINHTTP_PROXY_INFO>() as u32;
    // SAFETY: info is writable and its size is passed to WinHTTP.
    if unsafe {
        WinHttpQueryOption(
            handle,
            WINHTTP_OPTION_PROXY,
            (&mut info as *mut WINHTTP_PROXY_INFO).cast(),
            &mut size,
        )
    } == 0
    {
        return Err(failure("query proxy endpoint"));
    }
    let proxy = if info.lpszProxy.is_null() {
        None
    } else {
        let mut len = 0;
        // SAFETY: WinHTTP returns a null-terminated string allocated by GlobalAlloc.
        unsafe {
            while *info.lpszProxy.add(len) != 0 {
                len += 1;
            }
        }
        // SAFETY: len was measured up to the terminator of the returned allocation.
        Some(String::from_utf16_lossy(unsafe {
            std::slice::from_raw_parts(info.lpszProxy, len)
        }))
    };
    // SAFETY: WinHTTP requires returned proxy strings to be released with GlobalFree.
    unsafe {
        if !info.lpszProxy.is_null() {
            GlobalFree(info.lpszProxy.cast());
        }
        if !info.lpszProxyBypass.is_null() {
            GlobalFree(info.lpszProxyBypass.cast());
        }
    }
    let proxy =
        proxy.ok_or_else(|| "WinHTTP did not expose the selected proxy endpoint".to_string())?;
    if proxy.contains([';', ',', ' ', '=']) {
        return Err(
            "WinHTTP returned an ambiguous proxy list rather than the selected endpoint".into(),
        );
    }
    let value = if proxy.contains("://") {
        proxy
    } else {
        format!("http://{proxy}")
    };
    let parsed =
        Url::parse(&value).map_err(|_| "WinHTTP returned an invalid proxy endpoint".to_string())?;
    let host = parsed
        .host_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "WinHTTP returned a proxy without a host".to_string())?;
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| "WinHTTP returned a proxy without a port".to_string())?;
    Ok((host.to_string(), i32::from(port)))
}

fn challenge(
    headers: &[(String, String)],
    is_proxy: bool,
    supported: u32,
    first: u32,
    host: String,
    port: i32,
) -> Option<(Challenge, u32)> {
    let choices = [
        (WINHTTP_AUTH_SCHEME_NEGOTIATE, "negotiate"),
        (WINHTTP_AUTH_SCHEME_NTLM, "ntlm"),
        (WINHTTP_AUTH_SCHEME_DIGEST, "digest"),
        (WINHTTP_AUTH_SCHEME_BASIC, "basic"),
    ];
    let (scheme, name) = choices
        .iter()
        .copied()
        .find(|(code, _)| *code == first)
        .or_else(|| {
            choices
                .iter()
                .copied()
                .find(|(code, _)| supported & *code != 0)
        })?;
    let key = if is_proxy {
        "proxy-authenticate"
    } else {
        "www-authenticate"
    };
    let value = headers
        .iter()
        .filter(|(k, _)| k.eq_ignore_ascii_case(key))
        .map(|(_, v)| v.as_str())
        .find(|v| {
            v.split_whitespace()
                .next()
                .is_some_and(|s| s.eq_ignore_ascii_case(name))
        })
        .unwrap_or("");
    let lower = value.to_ascii_lowercase();
    let realm = lower
        .find("realm=")
        .map(|i| {
            let rest = value[i + 6..].trim_start();
            if let Some(quoted) = rest.strip_prefix('"') {
                quoted.split('"').next().unwrap_or("").to_string()
            } else {
                rest.split([',', ' ']).next().unwrap_or("").to_string()
            }
        })
        .unwrap_or_default();
    Some((
        Challenge {
            is_proxy,
            scheme: name.to_string(),
            host,
            port,
            realm,
        },
        scheme,
    ))
}

fn run(
    transfer: &Arc<Transfer>,
    body: Option<Vec<u8>>,
    sender: &mpsc::Sender<Event>,
    receiver: &mpsc::Receiver<Event>,
) -> Result<(), String> {
    let params = &transfer.params;
    if params.cache == CacheMode::OnlyIfCached {
        return Err("WinHTTP does not support only-if-cached".into());
    }
    let mut url = Url::parse(&params.url).map_err(|_| netmap::error_text(-300))?;
    let mut method = params.method.clone();
    let mut body = body;
    let mut headers = params.headers.clone();
    // SAFETY: null-terminated agent and null proxy pointers are valid for automatic proxy.
    let session = unsafe {
        WinHttpOpen(
            wide("OMPdesk").as_ptr(),
            WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
            null(),
            null(),
            WINHTTP_FLAG_ASYNC,
        )
    };
    if session.is_null() {
        return Err(failure("open session"));
    }
    let session = OwnedHandle(session);
    option(session.0, WINHTTP_OPTION_DISABLE_GLOBAL_POOLING, 1)?;
    let mut redirects = 0;
    loop {
        if transfer.is_cancelled() {
            return Ok(());
        }
        if !matches!(url.scheme(), "http" | "https") {
            return Err(netmap::error_text(-302));
        }
        let host = url.host_str().ok_or_else(|| netmap::error_text(-300))?;
        let port = url
            .port_or_known_default()
            .ok_or_else(|| netmap::error_text(-300))?;
        // SAFETY: session remains live until the worker exits and host is null terminated.
        let connection = unsafe { WinHttpConnect(session.0, wide(host).as_ptr(), port, 0) };
        if connection.is_null() {
            return Err(failure("connect"));
        }
        let connection = OwnedHandle(connection);
        let mut path = url.path().to_string();
        if let Some(query) = url.query() {
            path.push('?');
            path.push_str(query);
        }
        let flags = if url.scheme() == "https" {
            WINHTTP_FLAG_SECURE
        } else {
            0
        };
        // SAFETY: connection and both UTF-16 strings remain live for the call.
        let request = unsafe {
            WinHttpOpenRequest(
                connection.0,
                wide(&method).as_ptr(),
                wide(&path).as_ptr(),
                null(),
                null(),
                null(),
                flags,
            )
        };
        if request.is_null() {
            return Err(failure("open request"));
        }
        let mut owned_request = Request::new(request, sender, receiver)?;
        option(
            request,
            WINHTTP_OPTION_DISABLE_FEATURE,
            WINHTTP_DISABLE_COOKIES | WINHTTP_DISABLE_REDIRECTS | WINHTTP_DISABLE_AUTHENTICATION,
        )?;
        option(
            request,
            WINHTTP_OPTION_AUTOLOGON_POLICY,
            WINHTTP_AUTOLOGON_SECURITY_LEVEL_HIGH,
        )?;
        let bytes = body.as_deref().unwrap_or_default();
        let length =
            u32::try_from(bytes.len()).map_err(|_| "WinHTTP upload exceeds 4 GiB".to_string())?;
        let mut authenticated = false;
        let mut proxy_credentials: Option<(u32, String, String)> = None;
        let mut installed_headers = false;
        let mut previous_cookie: Option<String> = None;
        let (status, response_headers) = 'response: loop {
            if transfer.is_cancelled() {
                return Ok(());
            }
            if let Some((scheme, username, password)) = &proxy_credentials {
                // SAFETY: the request is live and both credential strings are null-terminated.
                if unsafe {
                    WinHttpSetCredentials(
                        request,
                        WINHTTP_AUTH_TARGET_PROXY,
                        *scheme,
                        wide(username).as_ptr(),
                        wide(password).as_ptr(),
                        null_mut(),
                    )
                } == 0
                {
                    return Err(failure("set proxy credentials"));
                }
            }
            let pairs = transfer.request_headers(url.as_str(), &headers)?;
            let cookie = pairs
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case("cookie"))
                .map(|(_, value)| value.clone());
            if !installed_headers {
                let mut request_headers = pairs
                    .iter()
                    .map(|(k, v)| format!("{k}: {v}\r\n"))
                    .collect::<String>();
                match params.cache {
                    CacheMode::NoStore => request_headers.push_str("Cache-Control: no-store\r\n"),
                    CacheMode::Reload => {
                        request_headers.push_str("Cache-Control: no-cache\r\nPragma: no-cache\r\n")
                    }
                    CacheMode::NoCache => request_headers.push_str("Cache-Control: max-age=0\r\n"),
                    _ => {}
                }
                if !request_headers.is_empty() {
                    // SAFETY: the request is live and the header string is null-terminated.
                    if unsafe {
                        WinHttpAddRequestHeaders(
                            request,
                            wide(&request_headers).as_ptr(),
                            u32::MAX,
                            WINHTTP_ADDREQ_FLAG_ADD,
                        )
                    } == 0
                    {
                        return Err(failure("add headers"));
                    }
                }
                installed_headers = true;
            } else if cookie != previous_cookie {
                let line = format!("Cookie: {}\r\n", cookie.as_deref().unwrap_or(""));
                // SAFETY: the request is live and the header string is null-terminated.
                if unsafe {
                    WinHttpAddRequestHeaders(
                        request,
                        wide(&line).as_ptr(),
                        u32::MAX,
                        WINHTTP_ADDREQ_FLAG_ADD | WINHTTP_ADDREQ_FLAG_REPLACE,
                    )
                } == 0
                {
                    return Err(failure("update cookie header"));
                }
            }
            previous_cookie = cookie;
            let context = (&*owned_request.context as *const mpsc::Sender<Event>) as usize;
            // SAFETY: the request is owned by this thread; upload data remains live through request close.
            if unsafe {
                WinHttpSendRequest(
                    request,
                    null(),
                    0,
                    if bytes.is_empty() {
                        null()
                    } else {
                        bytes.as_ptr().cast()
                    },
                    length,
                    length,
                    context,
                )
            } == 0
            {
                let error = std::io::Error::last_os_error();
                if authenticated
                    && error.raw_os_error() == Some(ERROR_WINHTTP_RESEND_REQUEST as i32)
                {
                    continue 'response;
                }
                return Err(format!("WinHTTP send request: {error}"));
            }
            match owned_request.wait(WINHTTP_CALLBACK_STATUS_SENDREQUEST_COMPLETE, transfer) {
                Ok(Some(_)) => {}
                Ok(None) => return Ok(()),
                Err(ERROR_WINHTTP_RESEND_REQUEST) if authenticated => continue 'response,
                Err(code) => return Err(async_failure(code)),
            }
            // SAFETY: send completion has arrived and this thread owns the live request.
            if unsafe { WinHttpReceiveResponse(request, null_mut()) } == 0 {
                let error = std::io::Error::last_os_error();
                if authenticated
                    && error.raw_os_error() == Some(ERROR_WINHTTP_RESEND_REQUEST as i32)
                {
                    continue 'response;
                }
                return Err(format!("WinHTTP receive response: {error}"));
            }
            match owned_request.wait(WINHTTP_CALLBACK_STATUS_HEADERS_AVAILABLE, transfer) {
                Ok(Some(_)) => {}
                Ok(None) => return Ok(()),
                Err(ERROR_WINHTTP_RESEND_REQUEST) if authenticated => continue 'response,
                Err(code) => return Err(async_failure(code)),
            }
            let code = status(request)?;
            let response_headers = raw_headers(request)?;
            transfer.response_cookies(url.as_str(), &response_headers)?;
            if !matches!(code, 401 | 407) {
                break (code, response_headers);
            }
            let mut supported = 0;
            let mut first = 0;
            let mut target = 0;
            // SAFETY: the output pointers reference writable DWORDs.
            if unsafe { WinHttpQueryAuthSchemes(request, &mut supported, &mut first, &mut target) }
                == 0
            {
                break (code, response_headers);
            }
            let (auth_host, auth_port) = if code == 407 {
                proxy_endpoint(request)?
            } else {
                (url.host_str().unwrap_or("").to_string(), i32::from(port))
            };
            let Some((challenge, scheme)) = challenge(
                &response_headers,
                code == 407,
                supported,
                first,
                auth_host,
                auth_port,
            ) else {
                break (code, response_headers);
            };
            let reply = sender.clone();
            transfer.login(challenge, move |answer| {
                let _ = reply.send(Event::Login(answer));
            });
            let (username, password) = loop {
                if transfer.is_cancelled() {
                    return Ok(());
                }
                match receiver
                    .recv()
                    .map_err(|_| "WinHTTP login channel closed".to_string())?
                {
                    Event::Login(LoginAnswer::Credentials { username, password }) => {
                        break (username, password);
                    }
                    Event::Login(LoginAnswer::Cancel) => break 'response (code, response_headers),
                    Event::Cancel => return Ok(()),
                    _ => {}
                }
            };
            loop {
                match owned_request.read(transfer)? {
                    None => return Ok(()),
                    Some(0) => break,
                    Some(_) => {}
                }
            }
            if transfer.is_cancelled() {
                return Ok(());
            }
            // SAFETY: credentials are null-terminated and live until WinHttpSetCredentials returns.
            if unsafe {
                WinHttpSetCredentials(
                    request,
                    target,
                    scheme,
                    wide(&username).as_ptr(),
                    wide(&password).as_ptr(),
                    null_mut(),
                )
            } == 0
            {
                return Err(failure("set credentials"));
            }
            if target == WINHTTP_AUTH_TARGET_PROXY {
                proxy_credentials = Some((scheme, username, password));
            }
            authenticated = true;
        };
        let location = response_headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("location"))
            .map(|(_, v)| v.as_str());
        if params.redirect == Redirect::Follow && netmap::is_redirect(status, location.is_some()) {
            if redirects >= 20 {
                return Err(netmap::error_text(-310));
            }
            let next = url
                .join(location.unwrap_or_default())
                .map_err(|_| netmap::error_text(-300))?;
            if url.origin() != next.origin() {
                headers.retain(|(name, _)| {
                    !name.eq_ignore_ascii_case("authorization")
                        && !name.eq_ignore_ascii_case("proxy-authorization")
                        && !name.eq_ignore_ascii_case("cookie")
                });
            }
            drop(owned_request);
            if (status == 303 && !method.eq_ignore_ascii_case("HEAD"))
                || (matches!(status, 301 | 302) && method.eq_ignore_ascii_case("POST"))
            {
                method = "GET".to_string();
                body = None;
                headers.retain(|(name, _)| {
                    !name.eq_ignore_ascii_case("content-type")
                        && !name.eq_ignore_ascii_case("content-encoding")
                        && !name.eq_ignore_ascii_case("content-language")
                        && !name.eq_ignore_ascii_case("content-location")
                });
            }
            url = next;
            redirects += 1;
            continue;
        }
        if !transfer.head(status, url.as_str(), &response_headers) {
            return Ok(());
        }
        loop {
            match owned_request.read(transfer)? {
                None => return Ok(()),
                Some(0) => break,
                Some(count) => transfer.chunk(&owned_request.buffer[..count]),
            }
        }
        return Ok(());
    }
}

pub(in super::super) fn start(
    transfer: Arc<Transfer>,
    body: Option<Vec<u8>>,
) -> Result<(), String> {
    let (sender, receiver) = mpsc::channel();
    let cancel = sender.clone();
    transfer.set_cancel(move || {
        let _ = cancel.send(Event::Cancel);
    });
    thread::Builder::new()
        .name("winhttp-fetch".into())
        .spawn(move || {
            let result = run(&transfer, body, &sender, &receiver);
            transfer.finish(result.err());
        })
        .map_err(|error| format!("start WinHTTP worker: {error}"))?;
    Ok(())
}
