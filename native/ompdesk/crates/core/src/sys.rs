//! The only unsafe code: asking a child process to end with SIGTERM, a file's clone (macOS, Linux) and (Windows) the
//! job object that ends its children with it and the one that ends an ssh or a supervised command with its whole
//! tree, physical memory and process reads, a junction, reading and ending other processes (their environment and
//! command line, `WM_CLOSE`, SIGKILL), `ReadDirectoryChangesW`, the system random generator, and (POSIX) a supervised
//! command's session and process group and the stop signals its supervisor waits for, and (Windows) a loopback
//! dial that fails at once when refused.
#![allow(unsafe_code)]

/// Set the child's priority before publishing its PID. A denied adjustment does not prevent a launch.
pub(crate) fn spawn_low_priority(
    command: &mut tokio::process::Command,
) -> std::io::Result<(tokio::process::Child, Option<std::io::Error>)> {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x4000;
        // A .cmd shim may start Bun immediately; set the class on creation.
        match command
            .creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS)
            .spawn()
        {
            Ok(child) => Ok((child, None)),
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => Ok((
                command.creation_flags(CREATE_NO_WINDOW).spawn()?,
                Some(error),
            )),
            Err(error) => Err(error),
        }
    }
    #[cfg(unix)]
    {
        let child = command.spawn()?;
        let error = child.id().and_then(|pid| {
            // SAFETY: the child has not been reaped, so its PID cannot name another process.
            (unsafe { libc::setpriority(libc::PRIO_PROCESS, pid, 10) } != 0)
                .then(std::io::Error::last_os_error)
        });
        Ok((child, error))
    }
}

/// Fills `bytes` from the system's random generator (the control socket's token), as node's `randomBytes` does.
#[cfg(unix)]
pub fn random(bytes: &mut [u8]) -> std::io::Result<()> {
    use std::io::Read;
    std::fs::File::open("/dev/urandom")?.read_exact(bytes)
}

/// Fills `bytes` from the system's random generator (the control socket's token), as node's `randomBytes` does.
#[cfg(windows)]
pub fn random(bytes: &mut [u8]) -> std::io::Result<()> {
    // No import library names this DLL, so the linker is told the DLL itself (what std does for its own hash keys).
    #[link(name = "bcryptprimitives", kind = "raw-dylib")]
    unsafe extern "system" {
        fn ProcessPrng(data: *mut u8, length: usize) -> i32;
    }
    // SAFETY: `bytes` is valid for writes of its whole length, which is all the call writes.
    if unsafe { ProcessPrng(bytes.as_mut_ptr(), bytes.len()) } == 0 {
        return Err(std::io::Error::other(
            "the system's random generator failed",
        ));
    }
    Ok(())
}

/// The normalized DOS path of this open handle, in the same namespace as `std::fs::canonicalize`.
#[cfg(windows)]
pub(crate) fn final_file_path(file: &std::fs::File) -> std::io::Result<std::path::PathBuf> {
    use std::ffi::{OsString, c_void};
    use std::os::windows::{ffi::OsStringExt, io::AsRawHandle};

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFinalPathNameByHandleW(
            handle: *mut c_void,
            path: *mut u16,
            len: u32,
            flags: u32,
        ) -> u32;
    }
    let mut short = [0_u16; 260];
    let mut long = Vec::new();
    let mut buffer = short.as_mut_slice();
    loop {
        // SAFETY: `file` owns the handle and `buffer` is writable for the supplied number of UTF-16 units.
        let n = unsafe {
            GetFinalPathNameByHandleW(
                file.as_raw_handle(),
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                0,
            )
        } as usize;
        if n == 0 {
            return Err(std::io::Error::last_os_error());
        }
        if n < buffer.len() {
            return Ok(OsString::from_wide(&buffer[..n]).into());
        }
        // The required length includes the terminator; success returns the length without it.
        long.resize(n, 0);
        buffer = long.as_mut_slice();
    }
}

// Main supplies resolved paths; pass long drive and UNC paths in the same namespace as Node.
#[cfg(windows)]
fn wide_path(path: &str) -> std::io::Result<Vec<u16>> {
    if path.contains('\0') {
        return Err(std::io::Error::from_raw_os_error(123));
    }
    let (prefix, tail) = if path.starts_with(r"\\?\") || path.starts_with(r"\\.\") {
        ("", path)
    } else if let Some(unc) = path.strip_prefix(r"\\") {
        (r"\\?\UNC\", unc)
    } else {
        (r"\\?\", path)
    };
    Ok(prefix
        .encode_utf16()
        .chain(tail.encode_utf16())
        .chain([0])
        .collect())
}

/// `fs.copyFile` on Windows uses CopyFileW, including its alternate data streams and exclusive-create behavior.
#[cfg(windows)]
pub(crate) fn copy_file(source: &str, target: &str, exclusive: bool) -> std::io::Result<()> {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CopyFileW(source: *const u16, target: *const u16, fail_if_exists: i32) -> i32;
    }
    let from = wide_path(source)?;
    let to = wide_path(target)?;
    // SAFETY: both buffers are NUL-terminated and remain alive for the synchronous call.
    if unsafe { CopyFileW(from.as_ptr(), to.as_ptr(), i32::from(exclusive)) } != 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    // libuv accepts a sharing violation only if both names identify the same file.
    if crate::fs::error::uv_code(&error) == "EBUSY"
        && same_file::is_same_file(source, target).unwrap_or(false)
    {
        return Ok(());
    }
    Err(error)
}

/// The setup repair must not replace a destination created between its probe and the rename.
pub(crate) fn move_launcher_exclusive(
    from: &std::path::Path,
    to: &std::path::Path,
) -> std::io::Result<()> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let ok = {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        let from = CString::new(from.as_os_str().as_bytes())?;
        let to = CString::new(to.as_os_str().as_bytes())?;
        #[cfg(target_os = "macos")]
        let (rename, flag) = (libc::renameatx_np, libc::RENAME_EXCL);
        #[cfg(target_os = "linux")]
        let (rename, flag) = (libc::renameat2, libc::RENAME_NOREPLACE);
        // SAFETY: both NUL-terminated path buffers live through the synchronous call.
        unsafe {
            rename(
                libc::AT_FDCWD,
                from.as_ptr(),
                libc::AT_FDCWD,
                to.as_ptr(),
                flag,
            ) == 0
        }
    };
    #[cfg(windows)]
    let ok = {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
        }
        let wide = |path: &std::path::Path| {
            wide_path(
                path.to_str()
                    .ok_or_else(|| std::io::Error::from_raw_os_error(123))?,
            )
        };
        let from = wide(from)?;
        let to = wide(to)?;
        // SAFETY: both buffers are NUL-terminated and valid for the call. Zero flags forbids replacement.
        unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) != 0 }
    };
    if ok {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// Windows answers a refused connect by sending its SYN again (about 2 s on loopback). libuv turns those retries off
/// for a loopback peer, so node's dial to a closed local port failed at once; a remote link's dial does the same
/// (`remote/dial.rs`). Best effort: a Windows before 10.0.16299 refuses the option and keeps the retries.
#[cfg(windows)]
pub fn no_syn_retries(socket: std::os::windows::io::RawSocket) {
    #[repr(C)]
    struct InitialRto {
        rtt: u16,
        max_syn_retransmissions: u8,
    }
    // _WSAIOW(IOC_VENDOR, 17) and TCP_INITIAL_RTO_NO_SYN_RETRANSMISSIONS, as libuv's `uv__tcp_try_connect` sets them.
    const SIO_TCP_INITIAL_RTO: u32 = 0x9800_0011;
    const NO_SYN_RETRANSMISSIONS: u8 = 0xFE;
    #[link(name = "ws2_32")]
    unsafe extern "system" {
        fn WSAIoctl(
            socket: usize,
            code: u32,
            input: *const std::ffi::c_void,
            input_length: u32,
            output: *mut std::ffi::c_void,
            output_length: u32,
            returned: *mut u32,
            overlapped: *mut std::ffi::c_void,
            routine: *mut std::ffi::c_void,
        ) -> i32;
    }
    let parameters = InitialRto {
        rtt: u16::from(NO_SYN_RETRANSMISSIONS),
        max_syn_retransmissions: NO_SYN_RETRANSMISSIONS,
    };
    let mut returned = 0u32;
    // SAFETY: `socket` is an open socket the caller owns; the input is a valid struct of the size passed; no output,
    // no overlapped call; `returned` is valid for the write.
    unsafe {
        WSAIoctl(
            socket as usize,
            SIO_TCP_INITIAL_RTO,
            (&raw const parameters).cast(),
            std::mem::size_of::<InitialRto>() as u32,
            std::ptr::null_mut(),
            0,
            &raw mut returned,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        );
    }
}

/// Sends SIGTERM to `pid`, a child this process has not reaped yet (so the id still names it).
#[cfg(unix)]
pub fn terminate(pid: u32) {
    signal(pid, false);
}

/// Sends SIGTERM, or with `force` SIGKILL, to `pid`; whether a process was there to receive it. Never pid 0 or one
/// past `pid_t`, which `kill` reads as a whole process group.
#[cfg(unix)]
pub fn signal(pid: u32, force: bool) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
    // SAFETY: kill only reads its two integer arguments; `pid` is one process's id, never a group's.
    unsafe { libc::kill(pid, signal) == 0 }
}

/// Sends SIGTERM, or with `force` SIGKILL, to every process of the group `group` leads (a child started as the leader
/// of a group of its own); whether one was there to receive it. Never group 0 or 1, which `kill` reads as this
/// process's own group and as every process.
#[cfg(unix)]
pub fn signal_group(group: u32, force: bool) -> bool {
    let Ok(group) = libc::pid_t::try_from(group) else {
        return false;
    };
    if group <= 1 {
        return false;
    }
    let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
    // SAFETY: kill only reads its two integer arguments; `-group` names one process group, never every process.
    unsafe { libc::kill(-group, signal) == 0 }
}

/// Whether `pid` names a process, as `kill(pid, 0)` tells: one this user may not signal counts, and so does a zombie
/// its parent has not reaped. Never pid 0 or one past `pid_t`, which `kill` reads as a whole process group.
#[cfg(unix)]
pub fn alive(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    // SAFETY: kill only reads its two integer arguments, and signal 0 sends nothing.
    let found = unsafe { libc::kill(pid, 0) == 0 };
    found || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// SIGTERM and SIGINT, held for `wait` instead of ending this process.
#[cfg(unix)]
pub struct StopSignals(libc::sigset_t);

#[cfg(unix)]
impl StopSignals {
    /// Blocks SIGTERM and SIGINT in the calling thread and every thread it starts afterwards, so call it before
    /// starting any. A child inherits the mask; `new_session` empties it again, so the signals still end the command.
    pub fn block() -> std::io::Result<StopSignals> {
        let mut set = std::mem::MaybeUninit::<libc::sigset_t>::uninit();
        // SAFETY: `sigemptyset` initializes the set before `sigaddset` reads it, and `pthread_sigmask` only reads it;
        // the old mask is not asked for (null).
        let blocked = unsafe {
            libc::sigemptyset(set.as_mut_ptr());
            libc::sigaddset(set.as_mut_ptr(), libc::SIGTERM);
            libc::sigaddset(set.as_mut_ptr(), libc::SIGINT);
            libc::pthread_sigmask(libc::SIG_BLOCK, set.as_ptr(), std::ptr::null_mut())
        };
        if blocked != 0 {
            return Err(std::io::Error::from_raw_os_error(blocked));
        }
        // SAFETY: `sigemptyset` initialized it above.
        Ok(StopSignals(unsafe { set.assume_init() }))
    }

    /// Waits until SIGTERM or SIGINT arrives.
    pub fn wait(&self) {
        let mut received = 0;
        // SAFETY: the set is initialized and only read; `received` is written during the call.
        while unsafe { libc::sigwait(&raw const self.0, &raw mut received) } != 0 {}
    }
}

/// Starts `command`'s process as the leader of a process group of its own (`setpgid` through `posix_spawn`'s
/// `POSIX_SPAWN_SETPGROUP`), so `signal_group` with its pid reaches it and everything it starts that stays in its group.
/// The core is many threads: a `pre_exec` closure (or `setsid`, which std on macOS cannot hand `posix_spawn`) makes std
/// fork, and a fork while another thread holds libsystem's state killed the child before its exec ("os_once_t is
/// corrupt … crashed on child side of fork pre-exec", the Mac mini, 18 Nov 2026), so a tab's omp never came back. The
/// core has no controlling terminal and blocks no signal, so the group is all `new_session` gave these children.
#[cfg(unix)]
pub fn own_group(command: &mut std::process::Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

/// Starts `command`'s process in a session and process group of its own (`setsid`), as node's `detached: true` does,
/// so `signal_group` with its pid reaches it and everything it starts that stays in its group. Its signal mask is
/// emptied, as libuv's spawn empties it: the supervisor blocks SIGTERM and SIGINT (`StopSignals`), and std passes a
/// thread's mask on to the child (`SigBlk` read 0x4002 before this). The closure makes std fork: only for the
/// supervisor, whose mask must go; the core's children take `own_group`.
#[cfg(unix)]
pub fn new_session(command: &mut std::process::Command) {
    use std::os::unix::process::CommandExt;
    // SAFETY: the closure runs in the forked child before exec and calls only `setsid`, `sigemptyset` and
    // `pthread_sigmask`, which are async-signal-safe; the set is initialized by `sigemptyset` before it is read.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            let mut empty = std::mem::MaybeUninit::<libc::sigset_t>::uninit();
            libc::sigemptyset(empty.as_mut_ptr());
            let set =
                libc::pthread_sigmask(libc::SIG_SETMASK, empty.as_ptr(), std::ptr::null_mut());
            if set != 0 {
                return Err(std::io::Error::from_raw_os_error(set));
            }
            Ok(())
        });
    }
}

/// `KERN_ARGMAX`: the most bytes a process's arguments and environment take, the size `procargs` needs.
#[cfg(target_os = "macos")]
pub fn argmax() -> Option<usize> {
    let mut name = [libc::CTL_KERN, libc::KERN_ARGMAX];
    let mut value: libc::c_int = 0;
    let mut size = size_of::<libc::c_int>();
    // SAFETY: `name` is two live ints, as the call is told; `value` is a live int and `size` its size, so the call
    // writes at most that; nothing is set (null, 0).
    let read = unsafe {
        libc::sysctl(
            name.as_mut_ptr(),
            2,
            (&raw mut value).cast(),
            &raw mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if read != 0 {
        return None;
    }
    usize::try_from(value).ok()
}

/// `KERN_PROCARGS2` of `pid` into `buffer` (`argmax` bytes): its argument count, executable path, arguments and
/// environment as they were at its exec. None for a process this user may not read, a zombie and one that is gone.
#[cfg(target_os = "macos")]
pub fn procargs(pid: u32, buffer: &mut [u8]) -> Option<&[u8]> {
    let mut name = [
        libc::CTL_KERN,
        libc::KERN_PROCARGS2,
        libc::c_int::try_from(pid).ok()?,
    ];
    let mut size = buffer.len();
    // SAFETY: `name` is three live ints, as the call is told; `buffer` is valid for writes of `size` bytes, which is
    // the most the call writes, and it sets `size` to what it wrote; nothing is set (null, 0).
    let read = unsafe {
        libc::sysctl(
            name.as_mut_ptr(),
            3,
            buffer.as_mut_ptr().cast(),
            &raw mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    (read == 0).then(|| &buffer[..size.min(buffer.len())])
}

/// `phys_footprint` of `pid` (`proc_pid_rusage`, `RUSAGE_INFO_V4`): what Activity Monitor's Memory column and
/// `footprint` show, its compressed and swapped pages included. None for a process this user may not read (another
/// user's, as launchd) and one that is gone.
#[cfg(target_os = "macos")]
pub fn footprint(pid: u32) -> Option<u64> {
    let pid = libc::c_int::try_from(pid).ok()?;
    let mut info = std::mem::MaybeUninit::<libc::rusage_info_v4>::zeroed();
    // SAFETY: `info` is a live `rusage_info_v4`, the struct `RUSAGE_INFO_V4` tells the call to write, and it writes
    // no more than that.
    let read =
        unsafe { libc::proc_pid_rusage(pid, libc::RUSAGE_INFO_V4, info.as_mut_ptr().cast()) };
    if read != 0 {
        return None;
    }
    // SAFETY: all of `rusage_info_v4` is integers, zeroed was already a valid value, and a zero status filled it.
    Some(unsafe { info.assume_init() }.ri_phys_footprint)
}

/// Whether `pid`'s standard output or error path is closed, so a write to it fails, and what is known of the other end
/// (`Peer`): none while both can be written. A pipe whose other end closed (`PIPE_EOF`) has its peer closed. A stream
/// socket that can send no more (`SS_CANTSENDMORE`; a `socketpair`, which libuv and Bun give a child for `pipe`) is
/// closed two ways in XNU's `uipc_usrreq.c`: the peer's close disconnects both ends (`unp_disconnect`: clears
/// `SS_ISCONNECTED`), while this end's own `shutdown(SHUT_WR)` (`uipc_shutdown`: `socantsendmore`) leaves it connected
/// to a peer that may still be reading. So a Unix socket's peer is closed when disconnected and open when connected;
/// any other family's is unknown. With both descriptors closed, the less certain peer counts.
#[cfg(target_os = "macos")]
pub fn output_closed(pid: u32) -> Option<crate::procs::Peer> {
    let pid = libc::c_int::try_from(pid).ok()?;
    [1, 2]
        .into_iter()
        .filter_map(|fd| descriptor_closed(pid, fd))
        .min()
}

#[cfg(target_os = "macos")]
fn descriptor_closed(pid: libc::c_int, fd: libc::c_int) -> Option<crate::procs::Peer> {
    use crate::procs::Peer;
    // `<sys/proc_info.h>`: `struct socket_fdinfo` and `struct pipe_fdinfo` each start with a `proc_fileinfo` (24
    // bytes) and then a `vinfo_stat` (136). `socket_info` goes on with `soi_so`, `soi_pcb`, `soi_type` (+152),
    // `soi_protocol`, `soi_family` (+160), `soi_options`, `soi_linger`, `soi_state` (+168, a short); `pipe_info` with
    // `pipe_handle`, `pipe_peerhandle`, `pipe_status` (+152).
    const PROC_PIDFDSOCKETINFO: libc::c_int = 3;
    const PROC_PIDFDPIPEINFO: libc::c_int = 6;
    const SOCKET_TYPE: usize = 24 + 152;
    const SOCKET_FAMILY: usize = 24 + 160;
    const SOCKET_STATE: usize = 24 + 168;
    const PIPE_STATUS: usize = 24 + 152;
    /// `<sys/socketvar.h>`.
    const SS_ISCONNECTED: i16 = 0x0002;
    const SS_CANTSENDMORE: i16 = 0x0010;
    /// `<sys/pipe.h>`: the other end closed.
    const PIPE_EOF: i32 = 0x0080;
    // Larger than either structure; the call writes the one asked for and answers its size.
    let mut buffer = [0u8; 2048];
    let size = libc::c_int::try_from(buffer.len()).unwrap_or(libc::c_int::MAX);
    let info = |flavor, buffer: &mut [u8; 2048]| {
        // SAFETY: `buffer` is valid for writes of `size` bytes, the most the call writes.
        let read =
            unsafe { libc::proc_pidfdinfo(pid, fd, flavor, buffer.as_mut_ptr().cast(), size) };
        usize::try_from(read).unwrap_or(0)
    };
    let int = |buffer: &[u8], at: usize| {
        i32::from_ne_bytes([buffer[at], buffer[at + 1], buffer[at + 2], buffer[at + 3]])
    };
    if info(PROC_PIDFDSOCKETINFO, &mut buffer) > SOCKET_STATE + 2 {
        let state = i16::from_ne_bytes([buffer[SOCKET_STATE], buffer[SOCKET_STATE + 1]]);
        if int(&buffer, SOCKET_TYPE) != libc::SOCK_STREAM || state & SS_CANTSENDMORE == 0 {
            return None;
        }
        return Some(if int(&buffer, SOCKET_FAMILY) != libc::AF_UNIX {
            Peer::Unknown
        } else if state & SS_ISCONNECTED == 0 {
            Peer::Closed
        } else {
            Peer::Open
        });
    }
    (info(PROC_PIDFDPIPEINFO, &mut buffer) > PIPE_STATUS + 4
        && int(&buffer, PIPE_STATUS) & PIPE_EOF != 0)
        .then_some(Peer::Closed)
}

/// Linux runs OMPdesk's tests and CI only, and does not tell a closed pipe's writer from another: never closed.
#[cfg(all(unix, not(target_os = "macos")))]
pub fn output_closed(_pid: u32) -> Option<crate::procs::Peer> {
    None
}

/// `proc_pidinfo` of one flavor, whole or none: a process this user may not read, or one that is gone, has none.
#[cfg(target_os = "macos")]
fn pid_info<T>(pid: u32, flavor: libc::c_int) -> Option<T> {
    let pid = libc::c_int::try_from(pid).ok()?;
    let size = libc::c_int::try_from(size_of::<T>()).ok()?;
    let mut info = std::mem::MaybeUninit::<T>::zeroed();
    // SAFETY: `info` is valid for writes of `size` bytes, the most the call writes; `T` is one of libc's
    // `proc_*info` structures, plain integers and arrays for which all zeroes or what the kernel wrote is a value.
    let read = unsafe { libc::proc_pidinfo(pid, flavor, 0, info.as_mut_ptr().cast(), size) };
    // SAFETY: as above; the call wrote the whole structure.
    (read == size).then(|| unsafe { info.assume_init() })
}

/// The CPU time `pid` has used, in ns (`PROC_PIDTASKINFO`, whose times are Mach time units: ns on Intel, 125/3 ns on
/// Apple silicon).
#[cfg(target_os = "macos")]
#[allow(deprecated)] // libc points to the mach2 crate for `mach_timebase_info`; one call does not earn the crate.
pub fn cpu_ns(pid: u32) -> Option<u64> {
    let info: libc::proc_taskinfo = pid_info(pid, libc::PROC_PIDTASKINFO)?;
    let ticks = info.pti_total_user.checked_add(info.pti_total_system)?;
    let mut base = libc::mach_timebase_info { numer: 0, denom: 0 };
    // SAFETY: `base` is a live `mach_timebase_info`, which the call fills.
    if unsafe { libc::mach_timebase_info(&raw mut base) } != 0 || base.denom == 0 {
        return None;
    }
    u64::try_from(u128::from(ticks) * u128::from(base.numer) / u128::from(base.denom)).ok()
}

/// When `pid` started, in ms since the Unix epoch, to the microsecond the kernel keeps (`PROC_PIDTBSDINFO`): the
/// same number however often it is read, unlike `ps`'s elapsed seconds.
#[cfg(target_os = "macos")]
pub fn started_ms(pid: u32) -> Option<u64> {
    let info: libc::proc_bsdinfo = pid_info(pid, libc::PROC_PIDTBSDINFO)?;
    info.pbi_start_tvsec
        .checked_mul(1000)?
        .checked_add(info.pbi_start_tvusec / 1000)
}

/// `pid`'s working folder (`PROC_PIDVNODEPATHINFO`).
#[cfg(target_os = "macos")]
pub fn cwd(pid: u32) -> Option<String> {
    let info: libc::proc_vnodepathinfo = pid_info(pid, libc::PROC_PIDVNODEPATHINFO)?;
    let bytes: Vec<u8> = info
        .pvi_cdir
        .vip_path
        .iter()
        .flatten()
        .map(|&unit| unit as u8)
        .take_while(|&byte| byte != 0)
        .collect();
    (!bytes.is_empty()).then(|| String::from_utf8_lossy(&bytes).into_owned())
}

/// The TCP ports each of `pids` listens on, as `lsof` reads them (macOS has no other public way to a socket's port
/// by process than walking every descriptor's `socket_fdinfo` union).
#[cfg(target_os = "macos")]
pub fn listening_ports(pids: &[u32]) -> std::collections::HashMap<u32, Vec<u16>> {
    let listed: Vec<String> = pids.iter().map(u32::to_string).collect();
    let output = std::process::Command::new("/usr/sbin/lsof")
        .args(["-nP", "-w", "-a", "-iTCP", "-sTCP:LISTEN", "-Fn", "-p"])
        .arg(listed.join(","))
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output();
    output.map_or_else(
        |_| std::collections::HashMap::new(),
        |output| parse_lsof_ports(&String::from_utf8_lossy(&output.stdout)),
    )
}

/// `lsof -Fn`: a `p<pid>` line starts each process, an `n<address>:<port>` line names each socket (`*:3000`,
/// `127.0.0.1:3000`, `[::1]:3000`). Each port once per process.
#[cfg(any(target_os = "macos", test))]
pub(crate) fn parse_lsof_ports(text: &str) -> std::collections::HashMap<u32, Vec<u16>> {
    let mut ports: std::collections::HashMap<u32, Vec<u16>> = std::collections::HashMap::new();
    let mut pid = None;
    for line in text.lines() {
        if let Some(value) = line.strip_prefix('p') {
            pid = value.parse().ok();
        } else if let (Some(pid), Some(name)) = (pid, line.strip_prefix('n')) {
            let port = name
                .rsplit_once(':')
                .and_then(|(_, port)| port.parse().ok());
            if let Some(port) = port {
                let found = ports.entry(pid).or_default();
                if !found.contains(&port) {
                    found.push(port);
                }
            }
        }
    }
    ports
}

/// Linux runs OMPdesk's tests and CI only: no CPU measure.
#[cfg(all(unix, not(target_os = "macos")))]
pub fn cpu_ns(_pid: u32) -> Option<u64> {
    None
}

/// Linux runs OMPdesk's tests and CI only: `ps`'s start, to the second, stays.
#[cfg(all(unix, not(target_os = "macos")))]
pub fn started_ms(_pid: u32) -> Option<u64> {
    None
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn cwd(pid: u32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/cwd"))
        .ok()
        .map(|path| path.to_string_lossy().into_owned())
}

/// Linux runs OMPdesk's tests and CI only, and never has a process whose output lost its reader.
#[cfg(all(unix, not(target_os = "macos")))]
pub fn listening_ports(_pids: &[u32]) -> std::collections::HashMap<u32, Vec<u16>> {
    std::collections::HashMap::new()
}

/// Whether this process may execute `path`, as node's `accessSync(path, X_OK)` answers: `access(2)`, which follows
/// links and asks with the real user.
#[cfg(unix)]
pub fn may_execute(path: &std::path::Path) -> bool {
    may_access(path, libc::X_OK)
}

#[cfg(unix)]
pub fn may_write(path: &std::path::Path) -> bool {
    may_access(path, libc::W_OK)
}

#[cfg(unix)]
fn may_access(path: &std::path::Path, mode: libc::c_int) -> bool {
    use std::os::unix::ffi::OsStrExt;

    let Ok(path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: `path` is a NUL-terminated string that lives through the call, which only reads it.
    unsafe { libc::access(path.as_ptr(), mode) == 0 }
}

/// Puts this process in a new job object that kills every process in it once its last handle closes, which is when
/// this process ends, however it ends: the gits it starts join the job and cannot outlive it. The handle is never
/// closed. Jobs nest (Windows 8 and later), so a job main put this process in does not prevent it.
#[cfg(windows)]
pub fn end_children_with_this_process() -> std::io::Result<()> {
    let job = job::kill_on_close(true)?;
    // SAFETY: `job` is the live handle above; `GetCurrentProcess` returns a pseudo-handle that needs no closing.
    if unsafe { job::AssignProcessToJobObject(job, job::GetCurrentProcess()) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

/// Gives a process with no console one that is never shown. Main starts the core detached on Windows (libuv's job
/// object would otherwise kill it with main, and the omps with it, before they closed their sessions), and a detached
/// process has no console: every console program it starts without `CREATE_NO_WINDOW` (a git) would then open a window
/// of its own. A console made here takes the hidden state main started this process in, and the standard handles main
/// passed stay as they are.
#[cfg(windows)]
pub fn ensure_console() {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetConsoleWindow() -> *mut std::ffi::c_void;
        fn AllocConsole() -> i32;
    }
    // SAFETY: both calls take no arguments and only read or create this process's own console.
    unsafe {
        if GetConsoleWindow().is_null() {
            AllocConsole();
        }
    }
}

/// Makes this process's own stdin, stdout and stderr (main's pipes) not inheritable, so a process that leaves the job
/// (a browser `browsers.openExtensions` started) never holds them and main sees this process's pipes close when it
/// ends. Safe for every other start: a child given `Stdio::inherit` gets a duplicate std makes inheritable for that
/// one spawn, and a piped or null one never used these handles.
#[cfg(windows)]
pub fn stdio_not_inherited() {
    const STD_INPUT_HANDLE: u32 = -10_i32 as u32;
    const STD_OUTPUT_HANDLE: u32 = -11_i32 as u32;
    const STD_ERROR_HANDLE: u32 = -12_i32 as u32;
    const HANDLE_FLAG_INHERIT: u32 = 0x1;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetStdHandle(which: u32) -> *mut std::ffi::c_void;
        fn SetHandleInformation(handle: *mut std::ffi::c_void, mask: u32, flags: u32) -> i32;
    }
    for which in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
        // SAFETY: `GetStdHandle` takes one of the three constants and returns this process's handle, null or
        // INVALID_HANDLE_VALUE; `SetHandleInformation` only changes the inherit flag of a live handle and fails
        // harmlessly on the other two, and its failure leaves the handle as it was.
        unsafe {
            let handle = GetStdHandle(which);
            if !handle.is_null() && handle as isize != -1 {
                SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
            }
        }
    }
}

/// Starts this binary again with `args` and hands the new process this one's stdin, stdout and stderr and no other
/// handle (`PROC_THREAD_ATTRIBUTE_HANDLE_LIST`); the caller then exits. libuv starts a process with every inheritable
/// handle of its parent, and on Windows a spawn's pipe ends are inheritable until its CreateProcess returned, with no
/// lock between threads: main's worker that spawns `--own` beside a spawn on main's own thread handed `--own` that
/// other child's pipe ends, and `--own` lives as long as main, so that child's output never ended and main's
/// `execFileSync` of it never returned (win-platform, 26 Nov 2026). This first process holds what it was handed only
/// until it exits.
#[cfg(windows)]
pub fn relaunch_with_only_stdio(args: &[&str]) -> std::io::Result<()> {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    type Handle = *mut c_void;
    const STD_INPUT_HANDLE: u32 = -10_i32 as u32;
    const STD_OUTPUT_HANDLE: u32 = -11_i32 as u32;
    const STD_ERROR_HANDLE: u32 = -12_i32 as u32;
    const HANDLE_FLAG_INHERIT: u32 = 0x1;
    const STARTF_USESTDHANDLES: u32 = 0x100;
    const EXTENDED_STARTUPINFO_PRESENT: u32 = 0x0008_0000;
    const PROC_THREAD_ATTRIBUTE_HANDLE_LIST: usize = 0x2_0002;
    #[repr(C)]
    struct StartupInfo {
        cb: u32,
        reserved: *mut u16,
        desktop: *mut u16,
        title: *mut u16,
        x: u32,
        y: u32,
        x_size: u32,
        y_size: u32,
        x_chars: u32,
        y_chars: u32,
        fill: u32,
        flags: u32,
        show: u16,
        reserved_size: u16,
        reserved_data: *mut u8,
        stdin: Handle,
        stdout: Handle,
        stderr: Handle,
    }
    #[repr(C)]
    struct StartupInfoEx {
        startup: StartupInfo,
        attributes: *mut c_void,
    }
    #[repr(C)]
    struct ProcessInformation {
        process: Handle,
        thread: Handle,
        process_id: u32,
        thread_id: u32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetStdHandle(which: u32) -> Handle;
        fn SetHandleInformation(handle: Handle, mask: u32, flags: u32) -> i32;
        fn InitializeProcThreadAttributeList(
            list: *mut c_void,
            count: u32,
            flags: u32,
            size: *mut usize,
        ) -> i32;
        fn UpdateProcThreadAttribute(
            list: *mut c_void,
            flags: u32,
            attribute: usize,
            value: *mut c_void,
            size: usize,
            previous: *mut c_void,
            returned: *mut usize,
        ) -> i32;
        fn DeleteProcThreadAttributeList(list: *mut c_void);
        fn CreateProcessW(
            application: *const u16,
            command: *mut u16,
            process_attrs: *mut c_void,
            thread_attrs: *mut c_void,
            inherit: i32,
            flags: u32,
            environment: *mut c_void,
            directory: *const u16,
            startup: *mut StartupInfo,
            process: *mut ProcessInformation,
        ) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }
    let stdio = [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE].map(|which| {
        // SAFETY: one of the three constants; returns this process's handle, null or INVALID_HANDLE_VALUE.
        let handle = unsafe { GetStdHandle(which) };
        if handle.is_null() || handle as isize == -1 {
            std::ptr::null_mut()
        } else {
            handle
        }
    });
    // The list names each handle once (a repeat fails the update) and only live ones, each inheritable.
    let mut handles: Vec<Handle> = Vec::new();
    for handle in stdio.into_iter().filter(|handle| !handle.is_null()) {
        if handles.contains(&handle) {
            continue;
        }
        // SAFETY: `handle` is a live standard handle of this process; only its inherit flag changes.
        if unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        handles.push(handle);
    }
    if handles.is_empty() {
        return Err(std::io::Error::other("no standard handle to hand on"));
    }
    let exe = std::env::current_exe()?;
    let application: Vec<u16> = exe.as_os_str().encode_wide().chain([0]).collect();
    // Its own path quoted (a path holds no quote), then arguments that need no quoting.
    let mut command: Vec<u16> = "\"".encode_utf16().collect();
    command.extend(exe.as_os_str().encode_wide());
    command.push(u16::from(b'"'));
    for arg in args {
        command.push(u16::from(b' '));
        command.extend(arg.encode_utf16());
    }
    command.push(0);
    let mut size = 0;
    // SAFETY: the null probe only writes the size the list needs.
    unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut size) };
    let mut storage = vec![0usize; size.div_ceil(std::mem::size_of::<usize>())];
    let list: *mut c_void = storage.as_mut_ptr().cast();
    // SAFETY: `storage` is aligned and as large as Windows asked for.
    if unsafe { InitializeProcThreadAttributeList(list, 1, 0, &mut size) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: the list was initialized above and `handles` outlives CreateProcessW below.
    let updated = unsafe {
        UpdateProcThreadAttribute(
            list,
            0,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
            handles.as_mut_ptr().cast(),
            std::mem::size_of_val(handles.as_slice()),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    let mut info = ProcessInformation {
        process: std::ptr::null_mut(),
        thread: std::ptr::null_mut(),
        process_id: 0,
        thread_id: 0,
    };
    let created = updated != 0 && {
        let mut startup = StartupInfoEx {
            startup: StartupInfo {
                cb: std::mem::size_of::<StartupInfoEx>() as u32,
                reserved: std::ptr::null_mut(),
                desktop: std::ptr::null_mut(),
                title: std::ptr::null_mut(),
                x: 0,
                y: 0,
                x_size: 0,
                y_size: 0,
                x_chars: 0,
                y_chars: 0,
                fill: 0,
                flags: STARTF_USESTDHANDLES,
                show: 0,
                reserved_size: 0,
                reserved_data: std::ptr::null_mut(),
                stdin: stdio[0],
                stdout: stdio[1],
                stderr: stdio[2],
            },
            attributes: list,
        };
        // SAFETY: every pointer is live for the call: the NUL-terminated application and command, the startup info
        // with its initialized attribute list; null environment and directory keep this process's own.
        unsafe {
            CreateProcessW(
                application.as_ptr(),
                command.as_mut_ptr(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                1,
                EXTENDED_STARTUPINFO_PRESENT,
                std::ptr::null_mut(),
                std::ptr::null(),
                &mut startup.startup,
                &mut info,
            ) != 0
        }
    };
    let error = std::io::Error::last_os_error();
    // SAFETY: the list was initialized above and nothing uses it after this.
    unsafe { DeleteProcThreadAttributeList(list) };
    if !created {
        return Err(error);
    }
    // SAFETY: a successful CreateProcessW returned these two handles, owned here and used no further.
    unsafe {
        CloseHandle(info.thread);
        CloseHandle(info.process);
    }
    Ok(())
}

/// Whether any instance of the named pipe `name` is still open, connected or not. `WaitNamedPipeW` connects nothing:
/// it fails `ERROR_FILE_NOT_FOUND` at once when no instance exists, and only waits (1 ms here) while all are busy.
#[cfg(windows)]
pub fn pipe_has_instance(name: &str) -> bool {
    const ERROR_FILE_NOT_FOUND: i32 = 2;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn WaitNamedPipeW(name: *const u16, timeout_ms: u32) -> i32;
    }
    let wide: Vec<u16> = name.encode_utf16().chain([0]).collect();
    // SAFETY: `wide` is a NUL-terminated UTF-16 string that outlives the call, which only reads it.
    if unsafe { WaitNamedPipeW(wide.as_ptr(), 1) } != 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() != Some(ERROR_FILE_NOT_FOUND)
}

#[cfg(windows)]
pub use job::ProcessTree;

/// Job objects: the one this process lives in, and one for each process whose whole tree is ended together.
#[cfg(windows)]
mod job {
    use std::ffi::c_void;
    use std::io;

    pub type Handle = *mut c_void;

    /// `JOBOBJECT_BASIC_LIMIT_INFORMATION`.
    #[repr(C)]
    #[derive(Default)]
    struct BasicLimits {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    /// `IO_COUNTERS`.
    #[repr(C)]
    #[derive(Default)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    /// `JOBOBJECT_EXTENDED_LIMIT_INFORMATION`.
    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimits {
        basic: BasicLimits,
        io: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    #[cfg(target_pointer_width = "64")]
    const _: () = assert!(size_of::<ExtendedLimits>() == 144);

    /// `JOBOBJECT_BASIC_ACCOUNTING_INFORMATION`.
    #[repr(C)]
    #[derive(Default)]
    struct Accounting {
        total_user_time: i64,
        total_kernel_time: i64,
        this_period_total_user_time: i64,
        this_period_total_kernel_time: i64,
        total_page_fault_count: u32,
        total_processes: u32,
        active_processes: u32,
        total_terminated_processes: u32,
    }

    const _: () = assert!(size_of::<Accounting>() == 48);

    /// `JobObjectBasicAccountingInformation`.
    const BASIC_ACCOUNTING_INFORMATION: i32 = 1;
    /// `JobObjectExtendedLimitInformation`.
    const EXTENDED_LIMIT_INFORMATION: i32 = 9;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
    /// A process started with `CREATE_BREAKAWAY_FROM_JOB` leaves the job. Only the core's own job allows it, and only a
    /// browser opened at its extensions page asks (`browsers/mod.rs` `open`); a `ProcessTree` never allows it, so
    /// nothing escapes a tree a stop must end.
    const JOB_OBJECT_LIMIT_BREAKAWAY_OK: u32 = 0x0800;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateJobObjectW(attributes: *mut c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(
            job: Handle,
            class: i32,
            info: *const c_void,
            length: u32,
        ) -> i32;
        fn QueryInformationJobObject(
            job: Handle,
            class: i32,
            info: *mut c_void,
            length: u32,
            returned: *mut u32,
        ) -> i32;
        pub fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        pub fn GetCurrentProcess() -> Handle;
        fn TerminateJobObject(job: Handle, exit_code: u32) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }

    /// A new, empty job object that kills every process in it once its last handle closes; `breakaway` lets a process
    /// started with `CREATE_BREAKAWAY_FROM_JOB` leave it.
    pub fn kill_on_close(breakaway: bool) -> io::Result<Handle> {
        let job = new_job()?;
        let mut limits = ExtendedLimits::default();
        limits.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            | if breakaway {
                JOB_OBJECT_LIMIT_BREAKAWAY_OK
            } else {
                0
            };
        let length = u32::try_from(size_of::<ExtendedLimits>()).unwrap_or(u32::MAX);
        // SAFETY: `job` is the live handle above; `limits` is a `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` laid out as C
        // lays it out (`repr(C)`, size checked above), read only for the call, and `length` is its size.
        let set = unsafe {
            SetInformationJobObject(
                job,
                EXTENDED_LIMIT_INFORMATION,
                std::ptr::from_ref(&limits).cast(),
                length,
            )
        };
        if set == 0 {
            let error = io::Error::last_os_error();
            // SAFETY: `job` is the live handle above, closed once.
            unsafe { CloseHandle(job) };
            return Err(error);
        }
        Ok(job)
    }

    /// A new, empty job object with no limits.
    fn new_job() -> io::Result<Handle> {
        // SAFETY: both pointers may be null (default security, no name); the call returns a new handle or null.
        let job = unsafe { CreateJobObjectW(std::ptr::null_mut(), std::ptr::null()) };
        if job.is_null() {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }

    /// One process and everything it starts from now on (an ssh with its ProxyJump hops and its askpass helper, an
    /// installer with what it runs), in a job of their own inside this process's: `end` ends them all at once. A process
    /// leaves a tree only by ending.
    pub struct ProcessTree(Handle);

    // SAFETY: a job handle names a kernel object; the calls made on it here are safe from any thread.
    unsafe impl Send for ProcessTree {}
    // SAFETY: as above; no call here needs exclusive access.
    unsafe impl Sync for ProcessTree {}

    impl ProcessTree {
        /// `process` is a live process handle (a child that was just started). Dropping the tree ends what is left of it.
        pub fn of(process: std::os::windows::io::RawHandle) -> io::Result<ProcessTree> {
            ProcessTree::holding(kill_on_close(false)?, process)
        }

        /// As `of`, but dropping the tree (this process ending) leaves what still runs: a setup command's service
        /// host is meant to outlive it, and only `end` ends the tree.
        pub fn outliving(process: std::os::windows::io::RawHandle) -> io::Result<ProcessTree> {
            ProcessTree::holding(new_job()?, process)
        }

        fn holding(
            job: Handle,
            process: std::os::windows::io::RawHandle,
        ) -> io::Result<ProcessTree> {
            let tree = ProcessTree(job);
            // SAFETY: the job is the live handle `tree` owns; `process` is a live handle by the callers' contract.
            if unsafe { AssignProcessToJobObject(tree.0, process) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(tree)
        }

        /// Ends every process of the tree (`TerminateProcess` for each, as node's `kill()` is on Windows).
        pub fn end(&self) {
            // SAFETY: the job is the live handle `self` owns; a failure (nothing left to end) is ignored.
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }

        /// Whether a process of the tree still runs; false when the system cannot say.
        pub fn alive(&self) -> bool {
            let mut accounting = Accounting::default();
            let length = u32::try_from(size_of::<Accounting>()).unwrap_or(u32::MAX);
            // SAFETY: the job is the live handle `self` owns; `accounting` is a
            // `JOBOBJECT_BASIC_ACCOUNTING_INFORMATION` (`repr(C)`, size checked above) written only during the call,
            // `length` is its size, and the returned-length pointer may be null.
            let read = unsafe {
                QueryInformationJobObject(
                    self.0,
                    BASIC_ACCOUNTING_INFORMATION,
                    std::ptr::from_mut(&mut accounting).cast(),
                    length,
                    std::ptr::null_mut(),
                )
            };
            read != 0 && accounting.active_processes > 0
        }
    }

    impl Drop for ProcessTree {
        fn drop(&mut self) {
            // SAFETY: the job is the live handle `self` owns, closed once; closing a kill-on-close job ends what is
            // left of the tree.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

/// Makes the new file `to` a clone of the file `from` (`clonefile`, APFS): it shares the file's blocks, so it takes no
/// disk until either side changes. Fails where the volume cannot (another volume, a file system without clones) or
/// `to` exists, and then leaves no file.
#[cfg(target_os = "macos")]
pub fn clone_file(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let from = CString::new(from.as_os_str().as_bytes())?;
    let to = CString::new(to.as_os_str().as_bytes())?;
    // SAFETY: both pointers are NUL-terminated strings that outlive the call, which only reads them.
    if unsafe { libc::clonefile(from.as_ptr(), to.as_ptr(), 0) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

/// Makes the new file `to` a clone of the file `from` (`FICLONE`: Btrfs, XFS with reflinks), with its mode: it shares
/// the file's blocks, so it takes no disk until either side changes. Fails where the volume cannot or `to` exists,
/// and then leaves no file.
#[cfg(target_os = "linux")]
pub fn clone_file(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    use std::fs::{File, OpenOptions};
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::OpenOptionsExt;

    let source = File::open(from)?;
    let permissions = source.metadata()?.permissions();
    let made = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(to)?;
    // SAFETY: both descriptors are files this function holds open through the call; `FICLONE` takes the source's
    // descriptor as its one argument.
    let cloned = unsafe { libc::ioctl(made.as_raw_fd(), libc::FICLONE, source.as_raw_fd()) } == 0;
    let finished = if cloned {
        made.set_permissions(permissions)
    } else {
        Err(std::io::Error::last_os_error())
    };
    if finished.is_err() {
        drop(made);
        let _ = std::fs::remove_file(to);
    }
    finished
}

/// Makes `link` a junction to the folder `target` (an absolute path), as node's `fs.symlink(target, link,
/// "junction")` does: a folder link that needs no privilege. libuv's spelling of the target: `\\?\` dropped, `/` as
/// `\`, runs of separators as one; that is the print name, and the substitute name is `\??\` before it.
#[cfg(windows)]
pub fn junction(target: &std::path::Path, link: &std::path::Path) -> std::io::Result<()> {
    use std::ffi::c_void;
    use std::io::{Error, ErrorKind};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;

    const BACKSLASH: u16 = b'\\' as u16;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FSCTL_SET_REPARSE_POINT: u32 = 0x0009_00A4;
    const IO_REPARSE_TAG_MOUNT_POINT: u32 = 0xA000_0003;
    /// `MAXIMUM_REPARSE_DATA_BUFFER_SIZE`.
    const MAX_REPARSE_BYTES: usize = 16 * 1024;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn DeviceIoControl(
            device: *mut c_void,
            code: u32,
            input: *mut c_void,
            input_bytes: u32,
            output: *mut c_void,
            output_bytes: u32,
            returned: *mut u32,
            overlapped: *mut c_void,
        ) -> i32;
    }

    let units: Vec<u16> = target.as_os_str().encode_wide().collect();
    let verbatim: Vec<u16> = r"\\?\".encode_utf16().collect();
    let units = units.strip_prefix(verbatim.as_slice()).unwrap_or(&units);
    let is_separator = |unit: u16| unit == BACKSLASH || unit == u16::from(b'/');
    let absolute = matches!(units, [letter, colon, separator, ..]
        if u8::try_from(*letter).is_ok_and(|letter| letter.is_ascii_alphabetic())
            && *colon == u16::from(b':')
            && is_separator(*separator));
    if !absolute {
        return Err(Error::new(
            ErrorKind::InvalidInput,
            "a junction's target is an absolute path",
        ));
    }
    let mut name: Vec<u16> = Vec::with_capacity(units.len());
    for &unit in units {
        if !is_separator(unit) {
            name.push(unit);
        } else if name.last() != Some(&BACKSLASH) {
            name.push(BACKSLASH);
        }
    }
    let print = &name[..];
    let substitute: Vec<u16> = r"\??\".encode_utf16().chain(name.iter().copied()).collect();
    // `REPARSE_DATA_BUFFER` for a mount point, as UTF-16 units (Windows runs little-endian only): the tag, the data's
    // length and a reserved unit; then the data: each name's offset and length in bytes, and both names with their NUL.
    let data_bytes = 8 + (substitute.len() + 1 + print.len() + 1) * 2;
    if 8 + data_bytes > MAX_REPARSE_BYTES {
        return Err(Error::new(
            ErrorKind::InvalidInput,
            "a junction's target is too long",
        ));
    }
    let length = |units: usize| (units * 2) as u16;
    let mut buffer: Vec<u16> = vec![
        IO_REPARSE_TAG_MOUNT_POINT as u16,
        (IO_REPARSE_TAG_MOUNT_POINT >> 16) as u16,
        data_bytes as u16,
        0,
        0,
        length(substitute.len()),
        length(substitute.len() + 1),
        length(print.len()),
    ];
    buffer.extend_from_slice(&substitute);
    buffer.push(0);
    buffer.extend_from_slice(print);
    buffer.push(0);

    std::fs::create_dir(link)?;
    let set = (|| {
        let folder = std::fs::OpenOptions::new()
            .write(true)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(link)?;
        let mut returned = 0u32;
        // SAFETY: `folder` is the open handle of the folder made above and outlives the call; `buffer` is a whole
        // `REPARSE_DATA_BUFFER` of `8 + data_bytes` bytes that the call only reads; no output buffer, and `returned`
        // is written only during the call.
        let done = unsafe {
            DeviceIoControl(
                folder.as_raw_handle(),
                FSCTL_SET_REPARSE_POINT,
                buffer.as_ptr().cast_mut().cast(),
                (8 + data_bytes) as u32,
                std::ptr::null_mut(),
                0,
                &raw mut returned,
                std::ptr::null_mut(),
            )
        };
        if done == 0 {
            Err(Error::last_os_error())
        } else {
            Ok(())
        }
    })();
    if set.is_err() {
        let _ = std::fs::remove_dir(link);
    }
    set
}

/// What `GlobalMemoryStatusEx` says of this computer, in bytes: physical memory and what of it is available, and the
/// commit limit (RAM plus page files) with what of it is still free to promise.
#[cfg(windows)]
pub struct PhysicalMemory {
    pub total: u64,
    pub available: u64,
    pub commit_limit: u64,
    pub commit_available: u64,
}

/// This computer's memory now (`GlobalMemoryStatusEx`, which Electron's `process.getSystemMemoryInfo()` read).
#[cfg(windows)]
pub fn physical_memory() -> std::io::Result<PhysicalMemory> {
    /// `MEMORYSTATUSEX`.
    #[repr(C)]
    #[derive(Default)]
    struct MemoryStatus {
        length: u32,
        memory_load: u32,
        total_phys: u64,
        avail_phys: u64,
        total_page_file: u64,
        avail_page_file: u64,
        total_virtual: u64,
        avail_virtual: u64,
        avail_extended_virtual: u64,
    }

    const _: () = assert!(size_of::<MemoryStatus>() == 64);

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GlobalMemoryStatusEx(status: *mut MemoryStatus) -> i32;
    }

    let mut status = MemoryStatus {
        length: 64,
        ..MemoryStatus::default()
    };
    // SAFETY: `status` is a `MEMORYSTATUSEX` laid out as C lays it out (`repr(C)`, size checked above) with its
    // `dwLength` set, written only during the call.
    if unsafe { GlobalMemoryStatusEx(&raw mut status) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(PhysicalMemory {
        total: status.total_phys,
        available: status.avail_phys,
        commit_limit: status.total_page_file,
        commit_available: status.avail_page_file,
    })
}

/// What Windows' performance counters say now: threads ready to run with no processor free, requests waiting on the
/// disks, and the share of time the disks were busy since the look before. A counter Windows does not have, or has
/// no value for yet, is absent.
#[cfg(windows)]
#[derive(Debug, Default, Clone, Copy)]
pub struct Queues {
    pub run_queue: Option<f64>,
    pub disk_queue: Option<f64>,
    pub disk_busy_pct: Option<f64>,
}

/// One look at the counters (PDH). The query is opened at the first look and kept for the life of the process: a
/// share of time is the difference between two looks.
#[cfg(windows)]
pub fn queues() -> Queues {
    /// `PDH_FMT_COUNTERVALUE`, its union read as the double `PDH_FMT_DOUBLE` asks for.
    #[repr(C)]
    struct Value {
        status: u32,
        value: f64,
    }

    const _: () = assert!(size_of::<Value>() == 16);
    const PDH_FMT_DOUBLE: u32 = 0x200;
    /// `PDH_CSTATUS_VALID_DATA` is 0 and `PDH_CSTATUS_NEW_DATA` 1; every other status is no value.
    const NEW_DATA: u32 = 1;
    /// The busy share is what `% Idle Time` leaves: `% Disk Time` is the queue's length times 100, not a share.
    const PATHS: [&str; 3] = [
        r"\System\Processor Queue Length",
        r"\PhysicalDisk(_Total)\Current Disk Queue Length",
        r"\PhysicalDisk(_Total)\% Idle Time",
    ];

    // PDH's handles are pointer-sized; kept as integers so the open query can live in a static.
    #[link(name = "pdh")]
    unsafe extern "system" {
        fn PdhOpenQueryW(source: *const u16, user_data: usize, query: *mut isize) -> u32;
        fn PdhAddEnglishCounterW(
            query: isize,
            path: *const u16,
            user_data: usize,
            counter: *mut isize,
        ) -> u32;
        fn PdhCollectQueryData(query: isize) -> u32;
        fn PdhGetFormattedCounterValue(
            counter: isize,
            format: u32,
            kind: *mut u32,
            value: *mut Value,
        ) -> u32;
    }

    /// The open query and its counters in `PATHS`' order, 0 for one Windows would not add.
    static QUERY: std::sync::Mutex<Option<(isize, [isize; 3])>> = std::sync::Mutex::new(None);

    let Ok(mut held) = QUERY.lock() else {
        return Queues::default();
    };
    let (query, counters) = match *held {
        Some(open) => open,
        None => {
            let mut query = 0;
            // SAFETY: a null source is the live counters; `query` is written only during the call.
            if unsafe { PdhOpenQueryW(std::ptr::null(), 0, &raw mut query) } != 0 {
                return Queues::default();
            }
            let counters = PATHS.map(|path| {
                let path: Vec<u16> = path.encode_utf16().chain([0]).collect();
                let mut counter = 0;
                // SAFETY: `query` is the open query; `path` is NUL-terminated UTF-16 that outlives the call, and
                // `counter` is written only during it.
                let added =
                    unsafe { PdhAddEnglishCounterW(query, path.as_ptr(), 0, &raw mut counter) };
                if added == 0 { counter } else { 0 }
            });
            // The first look of a share of time has none behind it, so one is taken here and the first reading
            // (a new core's, right after a lost one) covers these 100 ms.
            // SAFETY: `query` is the open query.
            unsafe { PdhCollectQueryData(query) };
            std::thread::sleep(std::time::Duration::from_millis(100));
            *held.insert((query, counters))
        }
    };
    // SAFETY: `query` is the open query, never closed.
    if unsafe { PdhCollectQueryData(query) } != 0 {
        return Queues::default();
    }
    let read = |counter: isize| {
        let mut value = Value {
            status: 0,
            value: 0.0,
        };
        // SAFETY: `counter` belongs to the open query; `value` is a `PDH_FMT_COUNTERVALUE` laid out as C lays it out
        // (`repr(C)`, size checked above), written only during the call; the counter's type is not asked for.
        let status = unsafe {
            PdhGetFormattedCounterValue(
                counter,
                PDH_FMT_DOUBLE,
                std::ptr::null_mut(),
                &raw mut value,
            )
        };
        (counter != 0 && status == 0 && value.status <= NEW_DATA && value.value.is_finite())
            .then_some(value.value)
    };
    Queues {
        run_queue: read(counters[0]),
        disk_queue: read(counters[1]),
        disk_busy_pct: read(counters[2]).map(|idle| (100.0 - idle).clamp(0.0, 100.0)),
    }
}

#[cfg(windows)]
pub use process_list::{
    ConsoleWindow, Process, ask_to_close, console_windows, listening_ports, outputs_closed,
    process_started_ms, processes, resume_process,
};

/// This computer's processes: a Toolhelp32 snapshot with each one's working set (`memory.processes`) and, for
/// `procs.*`, its start and a handle to read its environment and command line and to end it.
#[cfg(windows)]
mod process_list {
    use std::ffi::c_void;
    use std::io;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};

    // The offsets into another process's PEB and parameters below are the 64-bit layout (x64 and ARM64 share it). A
    // 64-bit reader also reads a WOW64 process this way: its native PEB holds valid 64-bit parameters.
    #[cfg(not(target_pointer_width = "64"))]
    compile_error!(
        "the process parameter offsets are the 64-bit layout; OMPdesk ships 64-bit only"
    );

    type Handle = *mut c_void;

    /// `PROCESSENTRY32W`.
    #[repr(C)]
    struct Entry {
        size: u32,
        usage: u32,
        process_id: u32,
        default_heap_id: usize,
        module_id: u32,
        threads: u32,
        parent_process_id: u32,
        priority_class_base: i32,
        flags: u32,
        exe_file: [u16; 260],
    }

    /// `PROCESS_MEMORY_COUNTERS`.
    #[repr(C)]
    #[derive(Default)]
    struct Counters {
        size: u32,
        page_fault_count: u32,
        peak_working_set_size: usize,
        working_set_size: usize,
        quota_peak_paged_pool_usage: usize,
        quota_paged_pool_usage: usize,
        quota_peak_non_paged_pool_usage: usize,
        quota_non_paged_pool_usage: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
    }

    /// `FILETIME`.
    #[repr(C)]
    #[derive(Default)]
    struct FileTime {
        low: u32,
        high: u32,
    }

    /// `PROCESS_BASIC_INFORMATION`.
    #[repr(C)]
    #[derive(Default)]
    struct BasicInformation {
        exit_status: i32,
        peb: usize,
        affinity_mask: usize,
        base_priority: i32,
        process_id: usize,
        parent_process_id: usize,
    }

    /// `THREADENTRY32`.
    #[repr(C)]
    #[derive(Default)]
    struct ThreadEntry {
        size: u32,
        usage: u32,
        thread_id: u32,
        owner_process_id: u32,
        base_priority: i32,
        delta_priority: i32,
        flags: u32,
    }

    const _: () = assert!(
        size_of::<Entry>() == 568
            && size_of::<Counters>() == 72
            && size_of::<FileTime>() == 8
            && size_of::<BasicInformation>() == 48
            && size_of::<ThreadEntry>() == 28
    );

    const TH32CS_SNAPPROCESS: u32 = 0x2;
    const TH32CS_SNAPTHREAD: u32 = 0x4;
    const THREAD_SUSPEND_RESUME: u32 = 0x0002;
    const PROCESS_TERMINATE: u32 = 0x0001;
    const PROCESS_VM_READ: u32 = 0x0010;
    const PROCESS_QUERY_INFORMATION: u32 = 0x0400;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const SYNCHRONIZE: u32 = 0x0010_0000;
    /// What `Process` is opened with: read its memory, end it, wait for it.
    const READ_AND_END: u32 =
        PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | PROCESS_TERMINATE | SYNCHRONIZE;
    const INVALID_HANDLE: Handle = std::ptr::without_provenance_mut(usize::MAX);
    const WAIT_OBJECT_0: u32 = 0;
    const WM_CLOSE: u32 = 0x0010;
    /// `ProcessBasicInformation`.
    const BASIC_INFORMATION: u32 = 0;
    /// `PEB.ProcessParameters`.
    const PEB_PARAMETERS: usize = 0x20;
    /// `RTL_USER_PROCESS_PARAMETERS`: `Length` (how much of the structure this Windows has), `CommandLine` (a
    /// `UNICODE_STRING`: its byte length, then its buffer at +8), `Environment`, `EnvironmentSize`, and the bytes up to
    /// the end of that last one.
    const PARAMETERS_LENGTH: usize = 0x04;
    const COMMAND_LINE: usize = 0x70;
    const ENVIRONMENT: usize = 0x80;
    const ENVIRONMENT_SIZE: usize = 0x3F0;
    const PARAMETERS_BYTES: usize = 0x3F8;
    /// The most of one environment block read; a real one is a few KiB, and Windows caps it at 32 767 characters a
    /// variable.
    const ENVIRONMENT_CAP: usize = 1 << 20;
    const PAGE: usize = 4096;
    /// 1970-01-01 in `FILETIME`'s milliseconds since 1601-01-01.
    const UNIX_EPOCH_MS: u64 = 11_644_473_600_000;
    const PROCESS_DUP_HANDLE: u32 = 0x0040;
    const DUPLICATE_SAME_ACCESS: u32 = 0x2;
    /// `RTL_USER_PROCESS_PARAMETERS.StandardOutput` and `StandardError`: the handle values as the process holds them.
    const STANDARD_OUTPUTS: [usize; 2] = [0x28, 0x30];
    /// `FilePipeLocalInformation`; its `FILE_PIPE_LOCAL_INFORMATION` is ten `u32`s, `NamedPipeState` the ninth, which
    /// is `FILE_PIPE_CLOSING_STATE` once the other end of the pipe closed (`FILE_PIPE_CONNECTED_STATE`, 3, before).
    const PIPE_LOCAL_INFORMATION: u32 = 24;
    const PIPE_STATE: usize = 8;
    const PIPE_CLOSING_STATE: u32 = 4;
    /// `RTL_USER_PROCESS_PARAMETERS.CurrentDirectory.DosPath`, a `UNICODE_STRING` like `CommandLine`.
    const CURRENT_DIRECTORY: usize = 0x38;
    /// `GetExtendedTcpTable`'s families and `TCP_TABLE_OWNER_PID_LISTENER`; a row of the IPv4 table is six `u32`s
    /// (state, local address, local port, remote address, remote port, process id), one of the IPv6 table 56 bytes
    /// with the local port at +20 and the process id at +52. A port is in network order in its `u32`'s low half.
    const AF_INET: u32 = 2;
    const AF_INET6: u32 = 23;
    const TCP_TABLE_OWNER_PID_LISTENER: u32 = 3;
    const ERROR_INSUFFICIENT_BUFFER: u32 = 122;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, process_id: u32) -> Handle;
        fn Process32FirstW(snapshot: Handle, entry: *mut Entry) -> i32;
        fn Process32NextW(snapshot: Handle, entry: *mut Entry) -> i32;
        fn OpenProcess(access: u32, inherit: i32, process_id: u32) -> Handle;
        fn K32GetProcessMemoryInfo(process: Handle, counters: *mut Counters, size: u32) -> i32;
        fn GetProcessTimes(
            process: Handle,
            creation: *mut FileTime,
            exit: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> i32;
        fn ReadProcessMemory(
            process: Handle,
            address: *const c_void,
            buffer: *mut c_void,
            size: usize,
            read: *mut usize,
        ) -> i32;
        fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
        fn TerminateProcess(process: Handle, exit_code: u32) -> i32;
        fn Thread32First(snapshot: Handle, entry: *mut ThreadEntry) -> i32;
        fn Thread32Next(snapshot: Handle, entry: *mut ThreadEntry) -> i32;
        fn OpenThread(access: u32, inherit: i32, thread_id: u32) -> Handle;
        fn ResumeThread(thread: Handle) -> u32;
        fn DuplicateHandle(
            source_process: Handle,
            source: Handle,
            target_process: Handle,
            target: *mut Handle,
            access: u32,
            inherit: i32,
            options: u32,
        ) -> i32;
        fn GetCurrentProcess() -> Handle;
    }

    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn NtQueryInformationProcess(
            process: Handle,
            class: u32,
            information: *mut c_void,
            length: u32,
            returned: *mut u32,
        ) -> i32;
        fn NtQueryInformationFile(
            file: Handle,
            status: *mut [u64; 2],
            information: *mut c_void,
            length: u32,
            class: u32,
        ) -> i32;
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        fn EnumWindows(visit: extern "system" fn(Handle, isize) -> i32, data: isize) -> i32;
        fn GetWindowThreadProcessId(window: Handle, process_id: *mut u32) -> u32;
        fn GetClassNameW(window: Handle, name: *mut u16, capacity: i32) -> i32;
        fn PostMessageW(window: Handle, message: u32, wparam: usize, lparam: isize) -> i32;
        fn IsWindowVisible(window: Handle) -> i32;
        fn GetWindowTextW(window: Handle, text: *mut u16, capacity: i32) -> i32;
    }

    /// One process of the list: `working_set` in bytes, 0 for the idle process and for one this user may not open;
    /// `cpu_ms` the processor time it has used so far, kernel and user, absent for those too; `image` its
    /// executable's file name (`conhost.exe`).
    pub struct ProcessEntry {
        pub pid: u32,
        pub parent: u32,
        pub working_set: u64,
        pub cpu_ms: Option<u64>,
        pub image: String,
        /// When it started, in ms since the Unix epoch; read only when `processes` was asked to open each one.
        pub started_ms: Option<u64>,
        /// The process opened to read and end it, when asked for and this user may.
        pub process: Option<Process>,
    }

    /// A process opened to read its memory and to end it (`PROCESS_QUERY_INFORMATION | PROCESS_VM_READ |
    /// PROCESS_TERMINATE | SYNCHRONIZE`). Windows gives no other process its id while this handle is open, so what is
    /// read and ended through it is that one process, never a later one with the same id.
    #[derive(Debug)]
    pub struct Process(OwnedHandle);

    fn open_handle(pid: u32, access: u32) -> Option<OwnedHandle> {
        // SAFETY: the call takes three integers and returns a new handle or null.
        let handle = unsafe { OpenProcess(access, 0, pid) };
        if handle.is_null() {
            return None;
        }
        // SAFETY: `handle` is the open handle OpenProcess just returned; nothing else owns it.
        Some(unsafe { OwnedHandle::from_raw_handle(handle) })
    }

    fn working_set(process: &OwnedHandle) -> Option<u64> {
        let size = u32::try_from(size_of::<Counters>()).unwrap_or(u32::MAX);
        let mut counters = Counters {
            size,
            ..Counters::default()
        };
        // SAFETY: `process` is an open handle; `counters` is a `PROCESS_MEMORY_COUNTERS` laid out as C lays it out
        // (`repr(C)`, size checked above), written only during the call, and `size` is its size.
        let read =
            unsafe { K32GetProcessMemoryInfo(process.as_raw_handle(), &raw mut counters, size) };
        (read != 0).then_some(counters.working_set_size as u64)
    }

    /// When the process started, in ms since the Unix epoch, and the processor time it has used, kernel and user, in ms.
    fn times(process: &OwnedHandle) -> Option<(Option<u64>, u64)> {
        let mut times: [FileTime; 4] = Default::default();
        let [creation, exit, kernel, user] = &mut times;
        // SAFETY: `process` is an open handle; the four are `FILETIME`s laid out as C lays them out (`repr(C)`, size
        // checked above), written only during the call.
        let read =
            unsafe { GetProcessTimes(process.as_raw_handle(), creation, exit, kernel, user) };
        if read == 0 {
            return None;
        }
        let ticks = |time: &FileTime| (u64::from(time.high) << 32) | u64::from(time.low);
        Some((
            (ticks(&times[0]) / 10_000).checked_sub(UNIX_EPOCH_MS),
            (ticks(&times[2]) + ticks(&times[3])) / 10_000,
        ))
    }

    fn started_ms(process: &OwnedHandle) -> Option<u64> {
        times(process)?.0
    }

    /// UTF-16 units out of little-endian bytes (Windows runs little-endian only).
    fn units(bytes: &[u8]) -> Vec<u16> {
        let (pairs, _) = bytes.as_chunks::<2>();
        pairs.iter().map(|&pair| u16::from_le_bytes(pair)).collect()
    }

    fn word(bytes: &[u8], at: usize) -> Option<usize> {
        Some(usize::from_le_bytes(
            bytes.get(at..at + 8)?.try_into().ok()?,
        ))
    }

    impl Process {
        /// Copies bytes from `address` in the process into `into`; how many it could. A read stops at the first page
        /// that is not readable.
        fn read(&self, address: usize, into: &mut [u8]) -> usize {
            let mut read = 0;
            // SAFETY: `into` is valid for writes of its whole length, which is the most the call writes; `read` is a
            // live usize. `address` is the other process's, which the call checks (it is never dereferenced here).
            unsafe {
                ReadProcessMemory(
                    self.0.as_raw_handle(),
                    std::ptr::without_provenance(address),
                    into.as_mut_ptr().cast(),
                    into.len(),
                    &raw mut read,
                );
            }
            read.min(into.len())
        }

        /// The process's `RTL_USER_PROCESS_PARAMETERS`, at least up to `Environment`.
        fn parameters(&self) -> Option<Vec<u8>> {
            let mut information = BasicInformation::default();
            let length = u32::try_from(size_of::<BasicInformation>()).unwrap_or(u32::MAX);
            // SAFETY: the handle is open with PROCESS_QUERY_INFORMATION; `information` is a
            // `PROCESS_BASIC_INFORMATION` laid out as C lays it out (`repr(C)`, size checked above), written only during
            // the call, and `length` is its size; the returned length may be null.
            let status = unsafe {
                NtQueryInformationProcess(
                    self.0.as_raw_handle(),
                    BASIC_INFORMATION,
                    (&raw mut information).cast(),
                    length,
                    std::ptr::null_mut(),
                )
            };
            if status < 0 || information.peb == 0 {
                return None;
            }
            let mut pointer = [0; 8];
            if self.read(information.peb.checked_add(PEB_PARAMETERS)?, &mut pointer) != 8 {
                return None;
            }
            let address = usize::from_le_bytes(pointer);
            if address == 0 {
                return None;
            }
            let mut parameters = vec![0; PARAMETERS_BYTES];
            let read = self.read(address, &mut parameters);
            parameters.truncate(read);
            (read >= ENVIRONMENT + 8).then_some(parameters)
        }

        /// Its command line as the process holds it now.
        pub fn command_line(&self) -> Option<Vec<u16>> {
            let parameters = self.parameters()?;
            let length = usize::from(u16::from_le_bytes([
                parameters[COMMAND_LINE],
                parameters[COMMAND_LINE + 1],
            ]));
            let address = word(&parameters, COMMAND_LINE + 8)?;
            if address == 0 {
                return None;
            }
            let mut bytes = vec![0; length];
            (self.read(address, &mut bytes) == length).then(|| units(&bytes))
        }

        /// Its environment block as the process holds it now (`NAME=value`, each ended by a NUL, the block by one more),
        /// up to `ENVIRONMENT_CAP` bytes and up to the first page that cannot be read.
        pub fn environment(&self) -> Option<Vec<u16>> {
            let parameters = self.parameters()?;
            let address = word(&parameters, ENVIRONMENT)?;
            if address == 0 {
                return None;
            }
            let declared = u32::from_le_bytes(
                parameters[PARAMETERS_LENGTH..PARAMETERS_LENGTH + 4]
                    .try_into()
                    .ok()?,
            );
            let size = if declared as usize >= PARAMETERS_BYTES {
                word(&parameters, ENVIRONMENT_SIZE).unwrap_or(0)
            } else {
                0
            };
            let limit = if size == 0 {
                ENVIRONMENT_CAP
            } else {
                size.min(ENVIRONMENT_CAP)
            };
            // A page at a time, so a page that cannot be read ends the block where it begins rather than failing it,
            // and a block of unknown size is read only up to its end (two NULs in a row).
            let mut bytes = Vec::new();
            while bytes.len() < limit {
                let Some(at) = address.checked_add(bytes.len()) else {
                    break;
                };
                let want = (PAGE - at % PAGE).min(limit - bytes.len());
                let start = bytes.len();
                bytes.resize(start + want, 0);
                let read = self.read(at, &mut bytes[start..]);
                bytes.truncate(start + read);
                if read < want || ends_block(&bytes, start) {
                    break;
                }
            }
            (!bytes.is_empty()).then(|| units(&bytes))
        }

        /// Its working folder as it holds it now.
        pub fn current_directory(&self) -> Option<String> {
            let parameters = self.parameters()?;
            let length = usize::from(u16::from_le_bytes([
                parameters[CURRENT_DIRECTORY],
                parameters[CURRENT_DIRECTORY + 1],
            ]));
            let address = word(&parameters, CURRENT_DIRECTORY + 8)?;
            if address == 0 || length == 0 {
                return None;
            }
            let mut bytes = vec![0; length];
            (self.read(address, &mut bytes) == length)
                .then(|| String::from_utf16_lossy(&units(&bytes)))
        }

        /// The CPU time it has used, kernel and user, in ns.
        pub fn cpu_ns(&self) -> Option<u64> {
            let mut times: [FileTime; 4] = Default::default();
            let [creation, exit, kernel, user] = &mut times;
            // SAFETY: the handle is open with PROCESS_QUERY_INFORMATION; the four are `FILETIME`s laid out as C lays
            // them out (`repr(C)`, size checked above), written only during the call.
            let read =
                unsafe { GetProcessTimes(self.0.as_raw_handle(), creation, exit, kernel, user) };
            if read == 0 {
                return None;
            }
            let ticks = |time: &FileTime| (u64::from(time.high) << 32) | u64::from(time.low);
            ticks(&times[2])
                .checked_add(ticks(&times[3]))?
                .checked_mul(100)
        }

        /// Its standard output and error, as handles of this process to the same pipes, files or consoles; those that
        /// are unset or cannot be copied are left out. `pid` is its id, which no other process can have while `self`
        /// is open.
        pub fn outputs(&self, pid: u32) -> Vec<OwnedHandle> {
            let Some(parameters) = self.parameters() else {
                return Vec::new();
            };
            let Some(source) = open_handle(pid, PROCESS_DUP_HANDLE) else {
                return Vec::new();
            };
            STANDARD_OUTPUTS
                .iter()
                .filter_map(|&at| {
                    let value = word(&parameters, at)?;
                    if value == 0 || value == usize::MAX {
                        return None;
                    }
                    let mut copy: Handle = std::ptr::null_mut();
                    // SAFETY: `source` is open with PROCESS_DUP_HANDLE; `value` is a handle value in that process,
                    // which the call checks there (an invalid one fails it); `copy` is a live pointer the call writes.
                    let copied = unsafe {
                        DuplicateHandle(
                            source.as_raw_handle(),
                            std::ptr::without_provenance_mut(value),
                            GetCurrentProcess(),
                            &raw mut copy,
                            0,
                            0,
                            DUPLICATE_SAME_ACCESS,
                        )
                    };
                    if copied == 0 || copy.is_null() {
                        return None;
                    }
                    // SAFETY: `copy` is the handle DuplicateHandle just made in this process; nothing else owns it.
                    Some(unsafe { OwnedHandle::from_raw_handle(copy) })
                })
                .collect()
        }

        /// Whether the process has exited.
        pub fn exited(&self) -> bool {
            // SAFETY: the handle is open with SYNCHRONIZE; a wait of 0 ms only looks.
            unsafe { WaitForSingleObject(self.0.as_raw_handle(), 0) == WAIT_OBJECT_0 }
        }

        /// Ends the process at once, as `taskkill /f` does; whether Windows took the call.
        pub fn terminate(&self) -> bool {
            // SAFETY: the handle is open with PROCESS_TERMINATE.
            unsafe { TerminateProcess(self.0.as_raw_handle(), 1) != 0 }
        }
    }

    /// Whether `handle` is a pipe whose other end closed: a write to it fails. The pipe file system enters the closing
    /// state only in the cleanup of an end's last handle (ReactOS's NPFS, `NpCommonCleanup` → `NpSetClosingPipeState`;
    /// `DisconnectNamedPipe` gives the disconnected state instead), and a pipe has no half-close, so this end's own
    /// doing cannot set it while the other end lives.
    fn pipe_closed(handle: &OwnedHandle) -> bool {
        let mut status = [0u64; 2];
        let mut information = [0u32; 10];
        let length = u32::try_from(size_of_val(&information)).unwrap_or(u32::MAX);
        // SAFETY: `handle` is open; `status` is an `IO_STATUS_BLOCK` (two pointer-sized words) and `information` a
        // `FILE_PIPE_LOCAL_INFORMATION` of `length` bytes, written only during the call. A handle that is no pipe fails
        // the call.
        let read = unsafe {
            NtQueryInformationFile(
                handle.as_raw_handle(),
                &raw mut status,
                information.as_mut_ptr().cast(),
                length,
                PIPE_LOCAL_INFORMATION,
            )
        };
        read >= 0 && information[PIPE_STATE] == PIPE_CLOSING_STATE
    }

    /// For each process's `outputs`, whether one of them is a pipe whose other end closed. The query waits behind a
    /// call another process has in flight on the same pipe (a write into a full one), so the checks run on a thread of
    /// their own: a process whose check has not answered within `wait` counts as heard, and the thread ends once the call
    /// it waits behind does.
    pub fn outputs_closed(outputs: Vec<Vec<OwnedHandle>>, wait: std::time::Duration) -> Vec<bool> {
        let mut closed = vec![false; outputs.len()];
        let (send, receive) = std::sync::mpsc::channel();
        let checks = std::thread::Builder::new()
            .name("procs-outputs".to_owned())
            .spawn(move || {
                for (index, handles) in outputs.into_iter().enumerate() {
                    if send.send((index, handles.iter().any(pipe_closed))).is_err() {
                        return;
                    }
                }
            });
        if checks.is_err() {
            return closed;
        }
        let deadline = std::time::Instant::now() + wait;
        while let Ok((index, dead)) =
            receive.recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
        {
            closed[index] = dead;
        }
        closed
    }

    /// The TCP ports each of `pids` listens on, IPv4 and IPv6 (`GetExtendedTcpTable`).
    pub fn listening_ports(pids: &[u32]) -> std::collections::HashMap<u32, Vec<u16>> {
        let mut ports: std::collections::HashMap<u32, Vec<u16>> = std::collections::HashMap::new();
        for (family, row_size, port_at, pid_at) in [(AF_INET, 24, 8, 20), (AF_INET6, 56, 20, 52)] {
            let table = tcp_listeners(family);
            let count = table.get(..4).map_or(0, |count| {
                u32::from_le_bytes([count[0], count[1], count[2], count[3]])
            });
            for index in 0..count as usize {
                let Some(row) = table.get(4 + index * row_size..4 + (index + 1) * row_size) else {
                    break;
                };
                let at = |offset: usize| {
                    u32::from_le_bytes([
                        row[offset],
                        row[offset + 1],
                        row[offset + 2],
                        row[offset + 3],
                    ])
                };
                let pid = at(pid_at);
                if !pids.contains(&pid) {
                    continue;
                }
                let port = u16::from_be(at(port_at) as u16);
                let found = ports.entry(pid).or_default();
                if !found.contains(&port) {
                    found.push(port);
                }
            }
        }
        ports
    }

    /// `GetExtendedTcpTable`'s listening sockets of `family` with their process ids; empty when it cannot be read.
    fn tcp_listeners(family: u32) -> Vec<u8> {
        #[link(name = "iphlpapi")]
        unsafe extern "system" {
            fn GetExtendedTcpTable(
                table: *mut c_void,
                size: *mut u32,
                order: i32,
                family: u32,
                class: u32,
                reserved: u32,
            ) -> u32;
        }
        let mut size = 0u32;
        // A socket may open between the size and the read: a few tries.
        for _ in 0..4 {
            // `u32`s, so the rows' integers are aligned as the call writes them.
            let mut table = vec![0u32; (size as usize).div_ceil(4)];
            // SAFETY: `table` is valid for writes of `size` bytes (none on the first call, which only asks the size);
            // `size` is a live u32 the call sets to what it needs or wrote.
            let status = unsafe {
                GetExtendedTcpTable(
                    table.as_mut_ptr().cast(),
                    &raw mut size,
                    0,
                    family,
                    TCP_TABLE_OWNER_PID_LISTENER,
                    0,
                )
            };
            if status == 0 {
                return table
                    .iter()
                    .flat_map(|unit| unit.to_le_bytes())
                    .take(size as usize)
                    .collect();
            }
            if status != ERROR_INSUFFICIENT_BUFFER {
                break;
            }
        }
        Vec::new()
    }

    /// When the running process `pid` started, in ms since the Unix epoch (`GetProcessTimes`, the value `Get-Process`
    /// shows as `StartTime`): the same number however often it is asked, so two readings of one process compare
    /// exactly. None when no process with that id runs; an error when one does and this user may not ask it.
    pub fn process_started_ms(pid: u32) -> io::Result<Option<u64>> {
        const ERROR_INVALID_PARAMETER: i32 = 87;
        let Some(process) = open_handle(pid, PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE)
        else {
            let error = io::Error::last_os_error();
            return if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER) {
                Ok(None)
            } else {
                Err(error)
            };
        };
        // SAFETY: the handle is open with SYNCHRONIZE; a wait of 0 ms only looks.
        if unsafe { WaitForSingleObject(process.as_raw_handle(), 0) } == WAIT_OBJECT_0 {
            return Ok(None);
        }
        started_ms(&process)
            .map(Some)
            .ok_or_else(io::Error::last_os_error)
    }

    /// Whether two zero UTF-16 units in a row (the block's end) are in `bytes` at or after byte `from`, or straddle it.
    fn ends_block(bytes: &[u8], from: usize) -> bool {
        let units = bytes.len() / 2;
        (((from / 2).max(1))..units).any(|unit| bytes[unit * 2 - 2..unit * 2 + 2] == [0; 4])
    }

    /// Every process of a Toolhelp32 snapshot with its working set (`K32GetProcessMemoryInfo`), as the stock helper's
    /// `process-memory.ts` read them through bun's FFI. With `open`, each process this user may read and end is also
    /// opened for that (`ProcessEntry::process`) and its start read.
    pub fn processes(open: bool) -> io::Result<Vec<ProcessEntry>> {
        let entry_size = u32::try_from(size_of::<Entry>()).unwrap_or(u32::MAX);
        // SAFETY: the call takes two integers and returns a new handle or `INVALID_HANDLE_VALUE`.
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snapshot == INVALID_HANDLE {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `snapshot` is the open handle CreateToolhelp32Snapshot just returned; nothing else owns it.
        let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot) };
        let mut entry = Entry {
            size: entry_size,
            usage: 0,
            process_id: 0,
            default_heap_id: 0,
            module_id: 0,
            threads: 0,
            parent_process_id: 0,
            priority_class_base: 0,
            flags: 0,
            exe_file: [0; 260],
        };
        let mut entries = Vec::new();
        // SAFETY: `snapshot` is the open handle above; `entry` is a `PROCESSENTRY32W` laid out as C lays it out
        // (`repr(C)`, size checked above) with its `dwSize` set, written only during the call.
        let mut more = unsafe { Process32FirstW(snapshot.as_raw_handle(), &raw mut entry) };
        while more != 0 {
            let pid = entry.process_id;
            let process = (open && pid != 0)
                .then(|| open_handle(pid, READ_AND_END))
                .flatten();
            let limited = (process.is_none() && pid != 0)
                .then(|| open_handle(pid, PROCESS_QUERY_LIMITED_INFORMATION))
                .flatten();
            let handle = process.as_ref().or(limited.as_ref());
            let name = &entry.exe_file;
            let end = name
                .iter()
                .position(|unit| *unit == 0)
                .unwrap_or(name.len());
            let times = handle.and_then(times);
            entries.push(ProcessEntry {
                pid,
                parent: entry.parent_process_id,
                working_set: handle.and_then(working_set).unwrap_or(0),
                cpu_ms: times.map(|(_, cpu)| cpu),
                image: String::from_utf16_lossy(&name[..end]),
                started_ms: if open {
                    times.and_then(|(started, _)| started)
                } else {
                    None
                },
                process: process.map(Process),
            });
            // SAFETY: as for `Process32FirstW` above.
            more = unsafe { Process32NextW(snapshot.as_raw_handle(), &raw mut entry) };
        }
        Ok(entries)
    }

    /// Resumes every thread of `pid`, a child started suspended (`CREATE_SUSPENDED`: its one thread), so it runs only
    /// once the caller put it in a job. std keeps the child's thread handle to itself, so the thread is found by its
    /// owner in a Toolhelp32 snapshot.
    pub fn resume_process(pid: u32) -> io::Result<()> {
        // SAFETY: the call takes two integers and returns a new handle or `INVALID_HANDLE_VALUE`.
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snapshot == INVALID_HANDLE {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `snapshot` is the open handle CreateToolhelp32Snapshot just returned; nothing else owns it.
        let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot) };
        let mut entry = ThreadEntry {
            size: u32::try_from(size_of::<ThreadEntry>()).unwrap_or(u32::MAX),
            ..ThreadEntry::default()
        };
        let mut resumed = false;
        // SAFETY: `snapshot` is the open handle above; `entry` is a `THREADENTRY32` laid out as C lays it out
        // (`repr(C)`, size checked above) with its `dwSize` set, written only during the call.
        let mut more = unsafe { Thread32First(snapshot.as_raw_handle(), &raw mut entry) };
        while more != 0 {
            if entry.owner_process_id == pid {
                // SAFETY: the call takes three integers and returns a new handle or null.
                let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.thread_id) };
                if thread.is_null() {
                    return Err(io::Error::last_os_error());
                }
                // SAFETY: `thread` is the open handle OpenThread just returned; nothing else owns it.
                let thread = unsafe { OwnedHandle::from_raw_handle(thread) };
                // SAFETY: the handle is open with THREAD_SUSPEND_RESUME.
                if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX {
                    return Err(io::Error::last_os_error());
                }
                resumed = true;
            }
            // SAFETY: as for `Thread32First` above.
            more = unsafe { Thread32Next(snapshot.as_raw_handle(), &raw mut entry) };
        }
        if resumed {
            Ok(())
        } else {
            Err(io::Error::new(
                io::ErrorKind::NotFound,
                "the process has no thread",
            ))
        }
    }

    /// Posts `WM_CLOSE` to every top-level window of these processes, as `taskkill` without `/f` asks a program to
    /// close; answers the processes that had one. A console's window is left alone: closing it ends every program
    /// attached to that console, not only these, and a console program cannot be asked.
    pub fn ask_to_close(pids: &[u32]) -> Vec<u32> {
        struct Asking<'a> {
            pids: &'a [u32],
            asked: Vec<u32>,
        }

        extern "system" fn visit(window: Handle, data: isize) -> i32 {
            // SAFETY: `data` is the address of the `Asking` that `ask_to_close` lends EnumWindows, which calls this on
            // the same thread, one window at a time, before it returns; nothing else touches it meanwhile.
            let asking =
                unsafe { &mut *std::ptr::with_exposed_provenance_mut::<Asking<'_>>(data as usize) };
            let mut pid = 0;
            // SAFETY: `window` is a handle EnumWindows passed (a window gone since only fails the call); `pid` is a live
            // u32.
            unsafe {
                GetWindowThreadProcessId(window, &raw mut pid);
            }
            // SAFETY: as above; WM_CLOSE carries no pointer.
            if asking.pids.contains(&pid)
                && !console(window)
                && unsafe { PostMessageW(window, WM_CLOSE, 0, 0) } != 0
                && !asking.asked.contains(&pid)
            {
                asking.asked.push(pid);
            }
            1
        }

        let mut asking = Asking {
            pids,
            asked: Vec::new(),
        };
        // SAFETY: `visit` has the callback's signature, and `data` is the address of `asking`, which lives and is used
        // by nothing else until EnumWindows returns.
        unsafe {
            EnumWindows(visit, (&raw mut asking).expose_provenance() as isize);
        }
        asking.asked
    }

    /// Whether `window` is a console's: conhost's, or a pseudoconsole's hidden one.
    fn console(window: Handle) -> bool {
        class_among(window, &["ConsoleWindowClass", "PseudoConsoleWindow"]).is_some()
    }

    /// Which of `names` is the window's class, if any.
    fn class_among(window: Handle, names: &[&'static str]) -> Option<&'static str> {
        let mut class = [0u16; 32];
        // SAFETY: `class` is valid for writes of the 32 units the call is told, which it does not exceed.
        let length = unsafe { GetClassNameW(window, class.as_mut_ptr(), 32) };
        let class = &class[..usize::try_from(length).unwrap_or(0).min(class.len())];
        names
            .iter()
            .copied()
            .find(|name| name.encode_utf16().eq(class.iter().copied()))
    }

    /// A console window a person sees.
    pub struct ConsoleWindow {
        pub window: usize,
        /// The process Windows names for the window: the program whose console a conhost window shows, and for a
        /// Windows Terminal window the terminal itself, whatever runs in it.
        pub pid: u32,
        pub class: &'static str,
        pub title: String,
    }

    /// The classes of a shown console: conhost's own window, and Windows Terminal's, which shows the console of a
    /// program started without one wherever it is the default terminal.
    const SHOWN_CONSOLES: [&str; 2] = ["ConsoleWindowClass", "CASCADIA_HOSTING_WINDOW_CLASS"];

    /// Every visible console window of this process's desktop (`procs.consoles`). A console that is never shown (the
    /// one a program started with `CREATE_NO_WINDOW` gets) is not among them.
    pub fn console_windows() -> Vec<ConsoleWindow> {
        extern "system" fn visit(window: Handle, data: isize) -> i32 {
            // SAFETY: `data` is the address of the `Vec` that `console_windows` lends EnumWindows, which calls this on
            // the same thread, one window at a time, before it returns; nothing else touches it meanwhile.
            let found = unsafe {
                &mut *std::ptr::with_exposed_provenance_mut::<Vec<ConsoleWindow>>(data as usize)
            };
            let Some(class) = class_among(window, &SHOWN_CONSOLES) else {
                return 1;
            };
            // SAFETY: `window` is a handle EnumWindows passed (a window gone since only fails the call).
            if unsafe { IsWindowVisible(window) } == 0 {
                return 1;
            }
            let mut pid = 0;
            let mut title = [0u16; 256];
            // SAFETY: as above; `pid` is a live u32, and `title` is valid for writes of the 256 units the call is told,
            // which it does not exceed. Another process's title is read from the window, never asked of that process.
            let length = unsafe {
                GetWindowThreadProcessId(window, &raw mut pid);
                GetWindowTextW(window, title.as_mut_ptr(), 256)
            };
            let title = &title[..usize::try_from(length).unwrap_or(0).min(title.len())];
            found.push(ConsoleWindow {
                window: window.addr(),
                pid,
                class,
                title: String::from_utf16_lossy(title),
            });
            1
        }

        let mut found: Vec<ConsoleWindow> = Vec::new();
        // SAFETY: `visit` has the callback's signature, and `data` is the address of `found`, which lives and is used
        // by nothing else until EnumWindows returns.
        unsafe {
            EnumWindows(visit, (&raw mut found).expose_provenance() as isize);
        }
        found
    }
}

#[cfg(windows)]
pub use dir_changes::{DirChange, DirChanges, StopDirChanges};

/// A folder tree's changes straight from `ReadDirectoryChangesW`, which is what node's `fs.watch(dir, {recursive})` is
/// on Windows: one handle for the whole tree, never one per folder.
#[cfg(windows)]
mod dir_changes {
    use std::ffi::c_void;
    use std::io;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::path::Path;
    use std::ptr::null_mut;
    use std::sync::Arc;

    type Handle = *mut c_void;

    /// `OVERLAPPED`.
    #[repr(C)]
    struct Overlapped {
        internal: usize,
        internal_high: usize,
        offset: u32,
        offset_high: u32,
        event: Handle,
    }

    #[cfg(target_pointer_width = "64")]
    const _: () = assert!(size_of::<Overlapped>() == 32);

    const INVALID_HANDLE: Handle = std::ptr::without_provenance_mut(usize::MAX);
    const FILE_LIST_DIRECTORY: u32 = 0x0001;
    /// Read, write and delete: the folder stays free to change, rename and remove while it is watched.
    const FILE_SHARE_ALL: u32 = 0x0001 | 0x0002 | 0x0004;
    const OPEN_EXISTING: u32 = 3;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_FLAG_OVERLAPPED: u32 = 0x4000_0000;
    /// File names, folder names, sizes, last writes and creations: every way a file or a folder appears, grows, moves
    /// or goes. Not last access, attributes or security, which change nothing a reader of the tree shows.
    const NOTIFY_FILTER: u32 = 0x0001 | 0x0002 | 0x0008 | 0x0010 | 0x0040;
    const ERROR_IO_PENDING: i32 = 997;
    const ERROR_NOTIFY_ENUM_DIR: i32 = 1022;
    const WAIT_OBJECT_0: u32 = 0;
    const INFINITE: u32 = u32::MAX;
    /// A `FILE_NOTIFY_INFORMATION` before its name: `NextEntryOffset`, `Action`, `FileNameLength`.
    const ENTRY_HEAD_BYTES: usize = 12;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateFileW(
            name: *const u16,
            access: u32,
            share: u32,
            security: *mut c_void,
            disposition: u32,
            flags: u32,
            template: Handle,
        ) -> Handle;
        fn CreateEventW(
            security: *mut c_void,
            manual_reset: i32,
            signalled: i32,
            name: *const u16,
        ) -> Handle;
        fn SetEvent(event: Handle) -> i32;
        fn ReadDirectoryChangesW(
            directory: Handle,
            buffer: *mut c_void,
            length: u32,
            subtree: i32,
            filter: u32,
            returned: *mut u32,
            overlapped: *mut Overlapped,
            completion: *mut c_void,
        ) -> i32;
        fn GetOverlappedResult(
            file: Handle,
            overlapped: *mut Overlapped,
            transferred: *mut u32,
            wait: i32,
        ) -> i32;
        fn WaitForMultipleObjects(
            count: u32,
            handles: *const Handle,
            wait_all: i32,
            milliseconds: u32,
        ) -> u32;
        fn CancelIoEx(file: Handle, overlapped: *mut Overlapped) -> i32;
    }

    /// What one `next` saw.
    pub enum DirChange {
        /// The entries that changed, relative to the folder, `\` between segments.
        Names(Vec<String>),
        /// More changed than the buffer holds: the system dropped all of it, so anything may have changed.
        Overflow,
        /// `StopDirChanges::stop` was called.
        Stopped,
    }

    /// The changes of one folder tree. The system keeps what changes between two reads, from the first read on, and
    /// `open` makes that read: nothing that changes after `open` returned is lost, it is named or it is an `Overflow`.
    pub struct DirChanges {
        directory: OwnedHandle,
        /// Signalled when the read in flight completes.
        done: OwnedHandle,
        stop: Arc<OwnedHandle>,
        /// Both on the heap, where they stay: the system writes into them while a read is in flight.
        overlapped: Box<Overlapped>,
        /// `u32`s, because the system wants the buffer aligned as a `DWORD`.
        buffer: Box<[u32]>,
        reading: bool,
    }

    // SAFETY: the only raw pointer in it, `overlapped.event`, is a handle value (the name of a kernel object, which any
    // thread may use), not memory; everything else is owned.
    unsafe impl Send for DirChanges {}

    /// Ends a `DirChanges` from another thread.
    pub struct StopDirChanges(Arc<OwnedHandle>);

    impl StopDirChanges {
        /// The `next` that waits, or the next one called, returns `Stopped`.
        pub fn stop(&self) {
            // SAFETY: the event's handle is open for as long as this value holds it.
            unsafe {
                SetEvent(self.0.as_raw_handle());
            }
        }
    }

    fn event() -> io::Result<OwnedHandle> {
        // SAFETY: no security attributes and no name (both may be null); manual reset, not signalled.
        let handle = unsafe { CreateEventW(null_mut(), 1, 0, std::ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `handle` is the open handle CreateEventW just returned; nothing else owns it.
        Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
    }

    impl DirChanges {
        /// Watches `directory` and everything under it with a buffer of `buffer_bytes`.
        pub fn open(
            directory: &Path,
            buffer_bytes: usize,
        ) -> io::Result<(DirChanges, StopDirChanges)> {
            let mut name: Vec<u16> = directory.as_os_str().encode_wide().collect();
            if name.contains(&0) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "a path with a NUL in it",
                ));
            }
            name.push(0);
            // SAFETY: `name` is a NUL-terminated UTF-16 string that lives through the call; the security attributes
            // and the template may be null.
            let handle = unsafe {
                CreateFileW(
                    name.as_ptr(),
                    FILE_LIST_DIRECTORY,
                    FILE_SHARE_ALL,
                    null_mut(),
                    OPEN_EXISTING,
                    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED,
                    null_mut(),
                )
            };
            if handle == INVALID_HANDLE {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: `handle` is the open handle CreateFileW just returned; nothing else owns it.
            let directory = unsafe { OwnedHandle::from_raw_handle(handle) };
            let done = event()?;
            let stop = Arc::new(event()?);
            let mut changes = DirChanges {
                directory,
                done,
                stop: Arc::clone(&stop),
                overlapped: Box::new(Overlapped {
                    internal: 0,
                    internal_high: 0,
                    offset: 0,
                    offset_high: 0,
                    event: null_mut(),
                }),
                buffer: vec![0; buffer_bytes.div_ceil(4).max(64)].into_boxed_slice(),
                reading: false,
            };
            changes.read()?;
            Ok((changes, StopDirChanges(stop)))
        }

        /// Starts the next read.
        fn read(&mut self) -> io::Result<()> {
            *self.overlapped = Overlapped {
                internal: 0,
                internal_high: 0,
                offset: 0,
                offset_high: 0,
                event: self.done.as_raw_handle(),
            };
            let length = u32::try_from(self.buffer.len() * 4).unwrap_or(u32::MAX);
            // SAFETY: `directory` is open for overlapped I/O; `buffer` (`length` bytes, DWORD-aligned) and `overlapped`
            // are heap allocations this value keeps until the read completed (`next`) or was cancelled and awaited
            // (`drop`); with an OVERLAPPED the byte count and the completion routine may be null.
            let queued = unsafe {
                ReadDirectoryChangesW(
                    self.directory.as_raw_handle(),
                    self.buffer.as_mut_ptr().cast(),
                    length,
                    1,
                    NOTIFY_FILTER,
                    null_mut(),
                    &raw mut *self.overlapped,
                    null_mut(),
                )
            };
            if queued == 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(ERROR_IO_PENDING) {
                    return Err(error);
                }
            }
            self.reading = true;
            Ok(())
        }

        /// Blocks until something under the folder changed or the watch was stopped. An error ends the watch: the
        /// folder is gone (access denied, as the system says it) or the system refused the read.
        pub fn next(&mut self) -> io::Result<DirChange> {
            // The stop first: of two signalled events the wait names the first, and a stopped watch is done even
            // while changes keep coming.
            let handles = [self.stop.as_raw_handle(), self.done.as_raw_handle()];
            // SAFETY: two live event handles this value keeps open, in an array that outlives the call.
            let woke = unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, INFINITE) };
            if woke == WAIT_OBJECT_0 {
                return Ok(DirChange::Stopped);
            }
            if woke != WAIT_OBJECT_0 + 1 {
                return Err(io::Error::last_os_error());
            }
            let mut bytes = 0;
            // SAFETY: `overlapped` is the one the read that just completed was started with; `bytes` is a live u32.
            let read = unsafe {
                GetOverlappedResult(
                    self.directory.as_raw_handle(),
                    &raw mut *self.overlapped,
                    &raw mut bytes,
                    0,
                )
            };
            self.reading = false;
            let change = if read == 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(ERROR_NOTIFY_ENUM_DIR) {
                    return Err(error);
                }
                DirChange::Overflow
            } else if bytes == 0 {
                DirChange::Overflow
            } else {
                DirChange::Names(names(&self.buffer, bytes as usize))
            };
            // The names are copied out: the next read writes over the buffer.
            self.read()?;
            Ok(change)
        }
    }

    impl Drop for DirChanges {
        fn drop(&mut self) {
            if !self.reading {
                return;
            }
            let mut bytes = 0;
            // SAFETY: the read in flight was started on `directory` with `overlapped`. It is cancelled and then waited
            // for (`wait` = 1), so the system writes into neither `buffer` nor `overlapped` once they are freed; a read
            // that had already completed makes the cancel fail and the wait return at once.
            unsafe {
                CancelIoEx(self.directory.as_raw_handle(), &raw mut *self.overlapped);
                GetOverlappedResult(
                    self.directory.as_raw_handle(),
                    &raw mut *self.overlapped,
                    &raw mut bytes,
                    1,
                );
            }
        }
    }

    /// The names in the `bytes` the system wrote: a chain of `FILE_NOTIFY_INFORMATION`, each at a DWORD boundary.
    fn names(buffer: &[u32], bytes: usize) -> Vec<String> {
        let bytes = bytes.min(buffer.len() * 4);
        // UTF-16 units out of the `u32`s: Windows runs little-endian only.
        let unit = |at: usize| (buffer[at / 4] >> ((at % 4) * 8)) as u16;
        let mut names = Vec::new();
        let mut entry = 0;
        while entry + ENTRY_HEAD_BYTES <= bytes {
            let next = buffer[entry / 4] as usize;
            let length = buffer[entry / 4 + 2] as usize;
            let start = entry + ENTRY_HEAD_BYTES;
            let end = (start + length).min(bytes);
            let name: Vec<u16> = (start..end).step_by(2).map(unit).collect();
            names.push(String::from_utf16_lossy(&name));
            if next == 0 {
                break;
            }
            entry += next;
        }
        names
    }
}

/// What `lstat` reports on Windows that std keeps unstable: the volume, the file's index on it and its hard links
/// (libuv's `st_dev`, `st_ino`, `st_nlink`), read from a handle the caller opened on the entry itself.
#[cfg(windows)]
pub fn file_identity(file: &std::fs::File) -> std::io::Result<(u32, u64, u32)> {
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;

    /// `BY_HANDLE_FILE_INFORMATION`: the three `FILETIME`s are two `u32` each.
    #[repr(C)]
    #[derive(Default)]
    struct Information {
        attributes: u32,
        times: [u32; 6],
        volume_serial: u32,
        size_high: u32,
        size_low: u32,
        links: u32,
        index_high: u32,
        index_low: u32,
    }

    const _: () = assert!(size_of::<Information>() == 52);

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFileInformationByHandle(file: *mut c_void, information: *mut Information) -> i32;
    }

    let mut information = Information::default();
    // SAFETY: the handle is the open file's and outlives the call; `information` is a `BY_HANDLE_FILE_INFORMATION`
    // laid out as C lays it out (`repr(C)`, size checked above) that the call only writes.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &raw mut information) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok((
        information.volume_serial,
        (u64::from(information.index_high) << 32) | u64::from(information.index_low),
        information.links,
    ))
}

/// libuv's `lstat` counts a Windows link by the UTF-8 bytes of its target text, not the reparse entry's `EndOfFile`.
#[cfg(windows)]
pub fn file_link_size(file: &std::fs::File) -> std::io::Result<u64> {
    use std::ffi::c_void;
    use std::io;
    use std::os::windows::io::AsRawHandle;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn DeviceIoControl(
            device: *mut c_void,
            code: u32,
            input: *mut c_void,
            input_bytes: u32,
            output: *mut c_void,
            output_bytes: u32,
            returned: *mut u32,
            overlapped: *mut c_void,
        ) -> i32;
    }

    const FSCTL_GET_REPARSE_POINT: u32 = 0x0009_00a8;
    const IO_REPARSE_TAG_SYMLINK: u32 = 0xa000_000c;
    const IO_REPARSE_TAG_MOUNT_POINT: u32 = 0xa000_0003;
    let mut buffer = [0u16; 8_192];
    let mut returned = 0;
    // SAFETY: `file` is a live handle opened on the reparse point itself. The aligned output buffer has the
    // advertised 16 KiB capacity, `returned` is writable, and neither pointer outlives this synchronous call.
    if unsafe {
        DeviceIoControl(
            file.as_raw_handle(),
            FSCTL_GET_REPARSE_POINT,
            std::ptr::null_mut(),
            0,
            buffer.as_mut_ptr().cast(),
            16_384,
            &raw mut returned,
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let invalid = || io::Error::new(io::ErrorKind::InvalidData, "invalid link reparse data");
    let units = usize::try_from(returned).map_err(|_| invalid())? / 2;
    let buffer = buffer.get(..units).ok_or_else(invalid)?;
    if buffer.len() < 8 {
        return Err(invalid());
    }
    let tag = u32::from(buffer[0]) | (u32::from(buffer[1]) << 16);
    let base = match tag {
        IO_REPARSE_TAG_SYMLINK => 10,
        IO_REPARSE_TAG_MOUNT_POINT => 8,
        _ => return Err(invalid()),
    };
    if buffer[4] % 2 != 0 || buffer[5] % 2 != 0 {
        return Err(invalid());
    }
    let start = base + usize::from(buffer[4]) / 2;
    let end = start + usize::from(buffer[5]) / 2;
    let target = buffer.get(start..end).ok_or_else(invalid)?;
    let nt = target.starts_with(&[92, 63, 63, 92]);
    let drive = nt
        && target.len() >= 6
        && ((65..=90).contains(&target[4]) || (97..=122).contains(&target[4]))
        && target[5] == 58
        && (target.len() == 6 || target[6] == 92);
    if tag == IO_REPARSE_TAG_MOUNT_POINT && !drive {
        return Err(invalid());
    }
    let unc = nt
        && target.len() >= 8
        && target[4] | 32 == 117
        && target[5] | 32 == 110
        && target[6] | 32 == 99
        && target[7] == 92;
    let (target, prefix) = if drive {
        (&target[4..], 0)
    } else if unc {
        (&target[8..], 2)
    } else {
        (target, 0)
    };
    Ok(prefix
        + char::decode_utf16(target.iter().copied())
            .map(|character| character.map_or(3, |character| character.len_utf8() as u64))
            .sum::<u64>())
}

/// The local calendar date (year, month from 1, day) at `secs` since the epoch, in the system's time zone as it is
/// set now; none when the system cannot say. A daily schedule's day (`schedules/rules.rs`).
#[cfg(unix)]
pub fn local_day(secs: i64) -> Option<(i64, u32, u32)> {
    // The libc crate names it for some systems only; POSIX has it everywhere.
    unsafe extern "C" {
        fn tzset();
    }
    let time = secs as libc::time_t;
    let mut tm = std::mem::MaybeUninit::<libc::tm>::uninit();
    // SAFETY: `tzset` reads the environment and the zone files; `localtime_r` reads `time` and writes all of `tm`,
    // which is read only when it said so (a non-null return).
    let tm = unsafe {
        tzset();
        if libc::localtime_r(&time, tm.as_mut_ptr()).is_null() {
            return None;
        }
        tm.assume_init()
    };
    Some((
        i64::from(tm.tm_year) + 1900,
        u32::try_from(tm.tm_mon + 1).ok()?,
        u32::try_from(tm.tm_mday).ok()?,
    ))
}

/// Seconds since the epoch of a local wall-clock minute, as `mktime` reads it with the clock change left for it to
/// find; none when the system cannot say.
#[cfg(unix)]
pub fn local_instant(year: i64, month: u32, day: u32, hour: u32, minute: u32) -> Option<i64> {
    // SAFETY: every field of `tm` is an integer or a pointer, for which all zeroes is a value.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    tm.tm_year = i32::try_from(year - 1900).ok()?;
    tm.tm_mon = i32::try_from(month).ok()? - 1;
    tm.tm_mday = i32::try_from(day).ok()?;
    tm.tm_hour = i32::try_from(hour).ok()?;
    tm.tm_min = i32::try_from(minute).ok()?;
    tm.tm_isdst = -1;
    // SAFETY: `mktime` reads `tm` and writes its normalized fields back.
    let secs = unsafe { libc::mktime(&mut tm) };
    // -1 is `mktime`'s failure; the second before the epoch is no minute a schedule names.
    (secs != -1).then_some(secs as i64)
}

/// The system's time zone through kernel32, never the C runtime's: that one reads the `TZ` variable in its own
/// spelling, so the zone name a Git Bash shell exports (`Asia/Seoul`) reads there as UTC.
#[cfg(windows)]
mod zone {
    /// Seconds between 1601-01-01, where a `FILETIME` starts, and the epoch.
    const EPOCH: i64 = 11_644_473_600;
    const TIME_ZONE_ID_INVALID: u32 = u32::MAX;

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct SystemTime {
        year: u16,
        month: u16,
        day_of_week: u16,
        day: u16,
        hour: u16,
        minute: u16,
        second: u16,
        milliseconds: u16,
    }

    #[repr(C)]
    struct FileTime {
        low: u32,
        high: u32,
    }

    #[repr(C)]
    struct DynamicTimeZoneInformation {
        bias: i32,
        standard_name: [u16; 32],
        standard_date: SystemTime,
        standard_bias: i32,
        daylight_name: [u16; 32],
        daylight_date: SystemTime,
        daylight_bias: i32,
        time_zone_key_name: [u16; 128],
        dynamic_daylight_time_disabled: u8,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetDynamicTimeZoneInformation(zone: *mut DynamicTimeZoneInformation) -> u32;
        fn SystemTimeToTzSpecificLocalTimeEx(
            zone: *const DynamicTimeZoneInformation,
            universal: *const SystemTime,
            local: *mut SystemTime,
        ) -> i32;
        fn TzSpecificLocalTimeToSystemTimeEx(
            zone: *const DynamicTimeZoneInformation,
            local: *const SystemTime,
            universal: *mut SystemTime,
        ) -> i32;
        fn FileTimeToSystemTime(time: *const FileTime, system: *mut SystemTime) -> i32;
        fn SystemTimeToFileTime(system: *const SystemTime, time: *mut FileTime) -> i32;
    }

    fn zone() -> Option<DynamicTimeZoneInformation> {
        let mut zone = std::mem::MaybeUninit::<DynamicTimeZoneInformation>::uninit();
        // SAFETY: the call writes the whole structure, which is read only when it did not fail.
        unsafe {
            (GetDynamicTimeZoneInformation(zone.as_mut_ptr()) != TIME_ZONE_ID_INVALID)
                .then(|| zone.assume_init())
        }
    }

    pub fn local_day(secs: i64) -> Option<(i64, u32, u32)> {
        let ticks = u64::try_from(secs.checked_add(EPOCH)?)
            .ok()?
            .checked_mul(10_000_000)?;
        let time = FileTime {
            low: ticks as u32,
            high: (ticks >> 32) as u32,
        };
        let zone = zone()?;
        let mut universal = SystemTime::default();
        let mut local = SystemTime::default();
        // SAFETY: each call reads the structures it is given by const pointer and writes the one given by mut
        // pointer; all of them live on this stack for the calls.
        let converted = unsafe {
            FileTimeToSystemTime(&time, &mut universal) != 0
                && SystemTimeToTzSpecificLocalTimeEx(&zone, &universal, &mut local) != 0
        };
        converted.then(|| (local.year.into(), local.month.into(), local.day.into()))
    }

    pub fn local_instant(year: i64, month: u32, day: u32, hour: u32, minute: u32) -> Option<i64> {
        let zone = zone()?;
        let minute_at = |hour: u32| {
            let local = SystemTime {
                year: u16::try_from(year).ok()?,
                month: u16::try_from(month).ok()?,
                day: u16::try_from(day).ok()?,
                hour: u16::try_from(hour).ok()?,
                minute: u16::try_from(minute).ok()?,
                ..SystemTime::default()
            };
            let mut universal = SystemTime::default();
            let mut time = FileTime { low: 0, high: 0 };
            // SAFETY: as in `local_day`.
            let converted = unsafe {
                TzSpecificLocalTimeToSystemTimeEx(&zone, &local, &mut universal) != 0
                    && SystemTimeToFileTime(&universal, &mut time) != 0
            };
            let ticks = (u64::from(time.high) << 32) | u64::from(time.low);
            converted.then(|| (ticks / 10_000_000) as i64 - EPOCH)
        };
        // A minute the clock skips as it changes is the one an hour later, as JavaScript reads it.
        minute_at(hour).or_else(|| minute_at(hour + 1))
    }
}

#[cfg(windows)]
pub use zone::{local_day, local_instant};
#[cfg(test)]
mod priority_tests {
    use std::process::Stdio;
    use tokio::process::{Child, Command};

    #[cfg(unix)]
    fn priority(child: Option<&Child>) -> i32 {
        let pid = child.map_or(0, |c| c.id().unwrap());
        // SAFETY: zero selects this process; the other PID is our unreaped child.
        unsafe { libc::getpriority(libc::PRIO_PROCESS, pid) }
    }

    #[cfg(windows)]
    fn priority(child: Option<&Child>) -> i32 {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetPriorityClass(process: super::job::Handle) -> u32;
        }
        // SAFETY: both the current-process pseudohandle and the borrowed child handle remain valid.
        let class = unsafe {
            let handle = child.map_or_else(
                || super::job::GetCurrentProcess(),
                |c| c.raw_handle().unwrap(),
            );
            GetPriorityClass(handle)
        };
        assert_ne!(class, 0);
        class as i32
    }

    #[tokio::test]
    async fn lowers_only_the_child_before_returning_it() {
        #[cfg(unix)]
        let (mut command, expected) = (Command::new("cat"), 10);
        #[cfg(windows)]
        let (mut command, expected) = (Command::new("cmd.exe"), 0x4000);
        #[cfg(windows)]
        command.args(["/d", "/q"]);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let parent = priority(None);
        let (mut child, warning) = super::spawn_low_priority(&mut command).unwrap();
        assert!(warning.is_none(), "{warning:?}");
        assert_eq!(priority(Some(&child)), expected);
        assert_eq!(priority(None), parent);
        drop(child.stdin.take());
        child.wait().await.unwrap();
    }
}
