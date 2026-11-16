//! Public system zlib ABI, as declared in the macOS SDK zlib.h.
#![allow(unsafe_code)]

use std::ffi::{c_char, c_int, c_uint, c_ulong, c_void};
use std::ptr;

#[repr(C)]
struct ZStream {
    next_in: *const u8,
    avail_in: c_uint,
    total_in: c_ulong,
    next_out: *mut u8,
    avail_out: c_uint,
    total_out: c_ulong,
    msg: *const c_char,
    state: *mut c_void,
    zalloc: Option<unsafe extern "C" fn(*mut c_void, c_uint, c_uint) -> *mut c_void>,
    zfree: Option<unsafe extern "C" fn(*mut c_void, *mut c_void)>,
    opaque: *mut c_void,
    data_type: c_int,
    adler: c_ulong,
    reserved: c_ulong,
}

#[link(name = "z")]
unsafe extern "C" {
    fn zlibVersion() -> *const c_char;
    fn inflateInit2_(
        stream: *mut ZStream,
        bits: c_int,
        version: *const c_char,
        size: c_int,
    ) -> c_int;
    fn inflate(stream: *mut ZStream, flush: c_int) -> c_int;
    fn inflateEnd(stream: *mut ZStream) -> c_int;
    fn inflateReset2(stream: *mut ZStream, bits: c_int) -> c_int;
}

struct Inflater {
    stream: Box<ZStream>,
    bits: c_int,
    ended: bool,
}
impl Inflater {
    fn new(bits: c_int) -> Result<Self, String> {
        // SAFETY: zlib documents a zero-initialized stream with null default allocator hooks.
        let mut stream: Box<ZStream> = Box::new(unsafe { std::mem::zeroed() });
        // SAFETY: stream is stable heap storage; version and ABI size come from public zlib.
        let result = unsafe {
            inflateInit2_(
                &mut *stream,
                bits,
                zlibVersion(),
                size_of::<ZStream>() as c_int,
            )
        };
        if result != 0 {
            return Err(format!("zlib initialization failed: {result}"));
        }
        Ok(Self {
            stream,
            bits,
            ended: false,
        })
    }
    fn push(&mut self, bytes: &[u8], emit: &mut impl FnMut(&[u8])) -> Result<(), String> {
        self.stream.next_in = bytes.as_ptr();
        self.stream.avail_in =
            c_uint::try_from(bytes.len()).map_err(|_| "compressed input exceeds zlib limit")?;
        let mut output = [0u8; 65536];
        loop {
            if self.ended {
                if self.stream.avail_in == 0 {
                    break;
                }
                if self.bits != 31 {
                    return Err("trailing data after deflate response".into());
                }
                // SAFETY: initialized stream; gzip permits concatenated members.
                if unsafe { inflateReset2(&mut *self.stream, self.bits) } != 0 {
                    return Err("zlib gzip reset failed".into());
                }
                self.ended = false;
            }
            self.stream.next_out = output.as_mut_ptr();
            self.stream.avail_out = output.len() as c_uint;
            let before = self.stream.avail_in;
            // SAFETY: input/output slices remain live through this synchronous call.
            let result = unsafe { inflate(&mut *self.stream, 0) };
            let produced = output.len() - self.stream.avail_out as usize;
            if produced != 0 {
                emit(&output[..produced]);
            }
            if result == 1 {
                self.ended = true;
                continue;
            }
            if result != 0 && result != -5 {
                return Err(format!("invalid compressed HTTP body: zlib {result}"));
            }
            if self.stream.avail_in == 0 && self.stream.avail_out != 0 {
                break;
            }
            if produced == 0 && before == self.stream.avail_in {
                return Err("compressed HTTP body made no progress".into());
            }
        }
        self.stream.next_in = ptr::null();
        self.stream.next_out = ptr::null_mut();
        Ok(())
    }
}
impl Drop for Inflater {
    fn drop(&mut self) {
        // SAFETY: this object owns one successful initialization, released once.
        unsafe {
            inflateEnd(&mut *self.stream);
        }
    }
}

pub(crate) struct Decoder {
    encoding: Option<bool>, // true: gzip; false: zlib or historical raw HTTP deflate.
    inflater: Option<Inflater>,
    prefix: [u8; 2],
    prefix_len: usize,
}
impl Decoder {
    pub(crate) fn new(headers: &[(String, String)], has_body: bool) -> Self {
        let mut encodings = headers
            .iter()
            .filter(|(name, _)| name.eq_ignore_ascii_case("content-encoding"))
            .flat_map(|(_, value)| value.split(','))
            .map(str::trim)
            .filter(|value| !value.eq_ignore_ascii_case("identity"));
        let first = encodings.next();
        let encoding = if !has_body || encodings.next().is_some() {
            None
        } else if first.is_some_and(|value| value.eq_ignore_ascii_case("gzip")) {
            Some(true)
        } else if first.is_some_and(|value| value.eq_ignore_ascii_case("deflate")) {
            Some(false)
        } else {
            None
        };
        Self {
            encoding,
            inflater: None,
            prefix: [0; 2],
            prefix_len: 0,
        }
    }
    pub(crate) fn push(
        &mut self,
        mut bytes: &[u8],
        mut emit: impl FnMut(&[u8]),
    ) -> Result<(), String> {
        let Some(gzip) = self.encoding else {
            emit(bytes);
            return Ok(());
        };
        if self.inflater.is_none() {
            let bits = if gzip {
                31
            } else {
                let count = (2 - self.prefix_len).min(bytes.len());
                self.prefix[self.prefix_len..self.prefix_len + count]
                    .copy_from_slice(&bytes[..count]);
                self.prefix_len += count;
                bytes = &bytes[count..];
                if self.prefix_len < 2 {
                    return Ok(());
                }
                let header = u16::from_be_bytes([self.prefix[0], self.prefix[1]]);
                if self.prefix[0] & 15 == 8 && header.is_multiple_of(31) {
                    15
                } else {
                    -15
                }
            };
            let mut inflater = Inflater::new(bits)?;
            if self.prefix_len != 0 {
                inflater.push(&self.prefix[..self.prefix_len], &mut emit)?;
                self.prefix_len = 0;
            }
            self.inflater = Some(inflater);
        }
        self.inflater.as_mut().unwrap().push(bytes, &mut emit)
    }
    pub(crate) fn finish(&self) -> Result<(), String> {
        if self.encoding.is_some() && !self.inflater.as_ref().is_some_and(|state| state.ended) {
            return Err("truncated compressed HTTP body".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
