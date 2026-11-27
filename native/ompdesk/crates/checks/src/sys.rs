//! The crate's only unsafe code: this computer's RAM, the stop signals a command holder passes on, a detached
//! runner's own session, and on Windows the desktop a check runs on.
#![allow(unsafe_code)]

use std::ffi::OsStr;
use std::process::Command;

/// Inherit an attached console (even with redirected stdio) so Ctrl-C still reaches the child.
pub(crate) fn child_command(program: impl AsRef<OsStr>) -> Command {
    let command = Command::new(program);
    #[cfg(windows)]
    let command = {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut command = command;
        // SAFETY: GetConsoleCP takes no arguments and only queries this process's console.
        if unsafe { GetConsoleCP() } == 0 {
            command.creation_flags(CREATE_NO_WINDOW);
        }
        command
    };
    command
}

/// This computer's physical memory in bytes, `None` when the system does not say.
#[cfg(unix)]
pub fn physical_memory() -> Option<u64> {
    // SAFETY: sysconf only reads its integer argument.
    let (pages, size) = unsafe {
        (
            libc::sysconf(libc::_SC_PHYS_PAGES),
            libc::sysconf(libc::_SC_PAGESIZE),
        )
    };
    (pages > 0 && size > 0).then(|| pages as u64 * size as u64)
}

#[cfg(windows)]
fn physical_and_available() -> Option<(u64, u64)> {
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
    // SAFETY: `status` is a `MEMORYSTATUSEX` laid out as C lays it out (size checked above) with `dwLength` set,
    // written only during the call.
    (unsafe { GlobalMemoryStatusEx(&raw mut status) } != 0)
        .then_some((status.total_phys, status.avail_phys))
}

#[cfg(windows)]
pub fn physical_memory() -> Option<u64> {
    physical_and_available().map(|(total, _)| total)
}

#[cfg(target_os = "macos")]
pub(crate) fn pressure() -> std::io::Result<crate::heavy::Pressure> {
    use crate::heavy::{Cpu, Pressure};
    use std::ffi::CStr;
    use std::io::Error;

    #[repr(C)]
    #[derive(Default)]
    struct Swap {
        total: u64,
        available: u64,
        used: u64,
        page_size: u32,
        encrypted: i32,
    }

    fn read<T>(name: &CStr, value: &mut T) -> std::io::Result<()> {
        let mut size = size_of::<T>();
        // SAFETY: the two callers pass the kernel's corresponding integer or xsw_usage layout.
        let rc = unsafe {
            libc::sysctlbyname(
                name.as_ptr(),
                (value as *mut T).cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        if rc != 0 || size != size_of::<T>() {
            return Err(Error::other(format!("{} unknown", name.to_string_lossy())));
        }
        Ok(())
    }
    let mut level = 0u32;
    read(c"kern.memorystatus_vm_pressure_level", &mut level)?;
    let mut swap = Swap::default();
    read(c"vm.swapusage", &mut swap)?;
    let mut load = 0.0;
    // SAFETY: the output points to one double and the requested count is one.
    if unsafe { libc::getloadavg(&mut load, 1) } != 1 {
        return Err(Error::other("CPU load unknown"));
    }
    let cpus = std::thread::available_parallelism()?.get();
    Ok(Pressure {
        cpu: Cpu::Saturated(load >= cpus as f64),
        critical: level == 4,
        warning: match level {
            1 => false,
            2 | 4 => true,
            _ => return Err(Error::other("memory pressure unknown")),
        },
        swap: swap.used,
    })
}

#[cfg(target_os = "linux")]
pub(crate) fn pressure() -> std::io::Result<crate::heavy::Pressure> {
    use crate::heavy::{Cpu, Pressure};
    use std::io::Error;
    let mem = std::fs::read_to_string("/proc/meminfo")?;
    let kb = |key: &str| -> std::io::Result<u64> {
        mem.lines()
            .find_map(|l| l.strip_prefix(key))
            .and_then(|s| s.split_whitespace().next()?.parse().ok())
            .ok_or_else(|| Error::other(format!("{key} unknown")))
    };
    let free = kb("MemAvailable:")?;
    let total = kb("MemTotal:")?;
    let swap = kb("SwapTotal:")?
        .checked_sub(kb("SwapFree:")?)
        .ok_or_else(|| Error::other("swap usage unknown"))?;
    let load: f64 = std::fs::read_to_string("/proc/loadavg")?
        .split_whitespace()
        .next()
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| Error::other("CPU load unknown"))?;
    Ok(Pressure {
        cpu: Cpu::Saturated(load >= std::thread::available_parallelism()?.get() as f64),
        critical: free < total / 20,
        warning: free < total / 10,
        swap,
    })
}

#[cfg(windows)]
pub(crate) fn pressure() -> std::io::Result<crate::heavy::Pressure> {
    use crate::heavy::{Cpu, Pressure};
    use std::ffi::c_void;
    use std::io::Error;
    #[repr(C)]
    struct PageFile {
        size: u32,
        reserved: u32,
        total: usize,
        used: usize,
        peak: usize,
    }
    #[repr(C)]
    #[derive(Default)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    impl FileTime {
        fn ticks(&self) -> u64 {
            (u64::from(self.high) << 32) | u64::from(self.low)
        }
    }
    #[link(name = "psapi")]
    unsafe extern "system" {
        fn EnumPageFilesW(
            callback: unsafe extern "system" fn(*mut c_void, *const PageFile, *const u16) -> i32,
            context: *mut c_void,
        ) -> i32;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetSystemTimes(idle: *mut FileTime, kernel: *mut FileTime, user: *mut FileTime) -> i32;
    }
    unsafe extern "system" fn count(ctx: *mut c_void, page: *const PageFile, _: *const u16) -> i32 {
        // SAFETY: EnumPageFilesW passes our live counter and the current ENUM_PAGE_FILE_INFORMATION.
        unsafe { *ctx.cast::<u64>() += (*page).used as u64 };
        1
    }
    let mut swap = 0u64;
    // SAFETY: enumeration is synchronous; both the counter and the callback live throughout it.
    if unsafe { EnumPageFilesW(count, (&raw mut swap).cast()) } == 0 {
        return Err(Error::other("page file use unknown"));
    }
    let (total, free) =
        physical_and_available().ok_or_else(|| Error::other("memory pressure unknown"))?;
    let (mut idle, mut kernel, mut user) = (
        FileTime::default(),
        FileTime::default(),
        FileTime::default(),
    );
    // SAFETY: each output points to a live FILETIME.
    if unsafe { GetSystemTimes(&mut idle, &mut kernel, &mut user) } == 0 {
        return Err(Error::other("CPU time unknown"));
    }
    Ok(Pressure {
        cpu: Cpu::Times {
            idle: idle.ticks(),
            total: kernel.ticks() + user.ticks(),
        },
        critical: free < total / 20,
        warning: free < total / 10,
        swap,
    })
}

/// Whether a process with this id runs (a zombie counts; a process of another user too).
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

#[cfg(windows)]
pub fn alive(pid: u32) -> bool {
    use std::ffi::c_void;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const STILL_ACTIVE: u32 = 259;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn GetExitCodeProcess(process: *mut c_void, code: *mut u32) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    // SAFETY: OpenProcess takes plain integers; the handle it returns is closed below and used only in between.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            // Access denied still means a process holds the id.
            return std::io::Error::last_os_error().raw_os_error() == Some(5);
        }
        let mut code = 0u32;
        let read = GetExitCodeProcess(handle, &raw mut code);
        CloseHandle(handle);
        read == 0 || code == STILL_ACTIVE
    }
}

/// SIGTERM, SIGHUP and SIGINT, held by a command holder for the command instead of ending the holder first (which
/// would give its slot back while the command still runs).
#[cfg(unix)]
pub struct HeldSignals(libc::sigset_t);

#[cfg(unix)]
impl HeldSignals {
    /// Blocks the three in the calling thread and every thread it starts afterwards, so call it before starting any.
    /// A child inherits the mask; `child_defaults` empties it again.
    pub fn block() -> std::io::Result<HeldSignals> {
        let mut set = std::mem::MaybeUninit::<libc::sigset_t>::uninit();
        // SAFETY: `sigemptyset` initializes the set before `sigaddset` reads it, and `pthread_sigmask` only reads it.
        let blocked = unsafe {
            libc::sigemptyset(set.as_mut_ptr());
            libc::sigaddset(set.as_mut_ptr(), libc::SIGTERM);
            libc::sigaddset(set.as_mut_ptr(), libc::SIGHUP);
            libc::sigaddset(set.as_mut_ptr(), libc::SIGINT);
            libc::pthread_sigmask(libc::SIG_BLOCK, set.as_ptr(), std::ptr::null_mut())
        };
        if blocked != 0 {
            return Err(std::io::Error::from_raw_os_error(blocked));
        }
        // SAFETY: `sigemptyset` initialized it above.
        Ok(HeldSignals(unsafe { set.assume_init() }))
    }

    /// Waits for one of the held signals; its number.
    pub fn wait(&self) -> i32 {
        let mut received = 0;
        // SAFETY: the set is initialized and only read; `received` is written during the call.
        while unsafe { libc::sigwait(&raw const self.0, &raw mut received) } != 0 {}
        received
    }
}

/// Sends `signal` to `pid`.
#[cfg(unix)]
pub fn signal(pid: u32, signal: i32) {
    if let Ok(pid) = libc::pid_t::try_from(pid) {
        // SAFETY: kill only reads its two integer arguments.
        unsafe {
            libc::kill(pid, signal);
        }
    }
}

#[cfg(unix)]
pub(crate) fn volume_id(path: &std::path::Path) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;
    Some(std::fs::metadata(path).ok()?.dev())
}

#[cfg(windows)]
pub(crate) fn volume_id(path: &std::path::Path) -> Option<u64> {
    use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
    #[repr(C)]
    struct FileIdInfo {
        volume: u64,
        file_id: [u8; 16],
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFileInformationByHandleEx(
            handle: *mut std::ffi::c_void,
            class: i32,
            info: *mut FileIdInfo,
            size: u32,
        ) -> i32;
    }
    let dir = std::fs::OpenOptions::new()
        .access_mode(0)
        .custom_flags(0x02000000) // FILE_FLAG_BACKUP_SEMANTICS opens a directory.
        .open(path)
        .ok()?;
    let mut info = FileIdInfo {
        volume: 0,
        file_id: [0; 16],
    };
    // SAFETY: the directory handle is live and class FileIdInfo (18) writes exactly FILE_ID_INFO.
    let ok = unsafe {
        GetFileInformationByHandleEx(
            dir.as_raw_handle(),
            18,
            &raw mut info,
            std::mem::size_of::<FileIdInfo>() as u32,
        )
    };
    (ok != 0).then_some(info.volume)
}

/// Free bytes (what this user may still write) and total bytes of the volume holding `path`.
#[cfg(unix)]
pub fn disk_space(path: &std::path::Path) -> Option<(u64, u64)> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: `c` is NUL-terminated and outlives the call; `stat` is written by the call before it is read.
    if unsafe { libc::statvfs(c.as_ptr(), stat.as_mut_ptr()) } != 0 {
        return None;
    }
    // SAFETY: statvfs returned 0, so it filled `stat`.
    let stat = unsafe { stat.assume_init() };
    // The field types differ by OS (macOS keeps block counts in u32), so the casts stay.
    #[allow(clippy::unnecessary_cast)]
    let (unit, avail, blocks) = (
        stat.f_frsize as u64,
        stat.f_bavail as u64,
        stat.f_blocks as u64,
    );
    Some((avail * unit, blocks * unit))
}

#[cfg(windows)]
pub fn disk_space(path: &std::path::Path) -> Option<(u64, u64)> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetDiskFreeSpaceExW(
            dir: *const u16,
            free: *mut u64,
            total: *mut u64,
            total_free: *mut u64,
        ) -> i32;
    }
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    let (mut free, mut total, mut total_free) = (0u64, 0u64, 0u64);
    // SAFETY: `wide` is NUL-terminated and outlives the call; the three outputs are written during the call.
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &raw mut free,
            &raw mut total,
            &raw mut total_free,
        )
    };
    (ok != 0).then_some((free, total))
}

/// Sends `signal` to the process group `pid` leads.
#[cfg(unix)]
pub fn signal_group(pid: u32, signal: i32) {
    if let Ok(pid) = libc::pid_t::try_from(pid)
        && pid > 1
    {
        // SAFETY: kill only reads its two integer arguments.
        unsafe {
            libc::kill(-pid, signal);
        }
    }
}

/// The child starts with an empty signal mask, as a shell's child does, and, with `new_session`, in a session and
/// process group of its own (`setsid`), so a group kill of whoever started it does not reach it.
#[cfg(unix)]
pub fn child_defaults(command: &mut std::process::Command, new_session: bool) {
    use std::os::unix::process::CommandExt;
    // SAFETY: the closure runs in the forked child before exec and calls only `setsid`, `sigemptyset` and
    // `pthread_sigmask`, which are async-signal-safe; the set is initialized by `sigemptyset` before it is read.
    unsafe {
        command.pre_exec(move || {
            if new_session && libc::setsid() == -1 {
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

/// The name of the desktop checks run on: windows they open (an installer's message box, a test's dialog) land
/// there, never on the person's desktop. Made once per window station; `None` when it cannot be made, and the check
/// then runs on the default desktop.
#[cfg(windows)]
pub fn check_desktop() -> Option<String> {
    use std::ffi::c_void;
    const NAME: &str = "ompdesk-checks";
    const GENERIC_ALL: u32 = 0x1000_0000;
    #[link(name = "user32")]
    unsafe extern "system" {
        fn CreateDesktopW(
            name: *const u16,
            device: *const u16,
            mode: *const c_void,
            flags: u32,
            access: u32,
            attributes: *const c_void,
        ) -> *mut c_void;
    }
    let wide: Vec<u16> = NAME.encode_utf16().chain([0]).collect();
    // SAFETY: `wide` is NUL-terminated and outlives the call; the other pointers are null as the API allows. The
    // handle is left open on purpose: the desktop lives while a handle to it or a process on it does, and this
    // process starts the check on it next.
    let handle = unsafe {
        CreateDesktopW(
            wide.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            GENERIC_ALL,
            std::ptr::null(),
        )
    };
    (!handle.is_null()).then(|| NAME.to_string())
}

/// One argument as the C runtime's command-line parser reads it back (backslashes doubled before a quote).
#[cfg(windows)]
fn quote_arg(arg: &str, out: &mut String) {
    if !arg.is_empty() && !arg.contains([' ', '\t', '\n', '\u{b}', '"']) {
        out.push_str(arg);
        return;
    }
    out.push('"');
    let mut backslashes = 0;
    for c in arg.chars() {
        if c == '\\' {
            backslashes += 1;
            continue;
        }
        if c == '"' {
            out.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
        } else {
            out.extend(std::iter::repeat_n('\\', backslashes));
        }
        backslashes = 0;
        out.push(c);
    }
    out.extend(std::iter::repeat_n('\\', backslashes * 2));
    out.push('"');
}

/// A process `spawn_detached` started, held by its handle so its exit code can still be read after it ended.
#[cfg(windows)]
pub struct Detached {
    handle: *mut std::ffi::c_void,
}

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetConsoleCP() -> u32;
    fn GetExitCodeProcess(process: *mut std::ffi::c_void, code: *mut u32) -> i32;
    fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
}

#[cfg(windows)]
impl Detached {
    /// Its exit code once it ended (an NTSTATUS such as 0xC0000142 when Windows could not initialize it); `None`
    /// while it runs.
    pub fn exit_code(&self) -> Option<u32> {
        const STILL_ACTIVE: u32 = 259;
        let mut code = 0u32;
        // SAFETY: the handle is this value's own, open until drop; `code` is written during the call.
        let read = unsafe { GetExitCodeProcess(self.handle, &raw mut code) };
        (read != 0 && code != STILL_ACTIVE).then_some(code)
    }
}

#[cfg(windows)]
impl Drop for Detached {
    fn drop(&mut self) {
        // SAFETY: the handle came from CreateProcessW and is closed once, here.
        unsafe {
            CloseHandle(self.handle);
        }
    }
}

/// Starts `program` with `args` outside the caller's console, process group and job (when the job lets it break
/// away), on `desktop` when given, with no handles inherited.
#[cfg(windows)]
pub fn spawn_detached(
    program: &std::path::Path,
    args: &[String],
    desktop: Option<&str>,
) -> std::io::Result<Detached> {
    use std::ffi::c_void;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    const ERROR_ACCESS_DENIED: i32 = 5;

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
        x_count_chars: u32,
        y_count_chars: u32,
        fill_attribute: u32,
        flags: u32,
        show_window: u16,
        cb_reserved2: u16,
        reserved2: *mut u8,
        std_input: *mut c_void,
        std_output: *mut c_void,
        std_error: *mut c_void,
    }
    #[repr(C)]
    struct ProcessInformation {
        process: *mut c_void,
        thread: *mut c_void,
        pid: u32,
        tid: u32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateProcessW(
            application: *const u16,
            command_line: *mut u16,
            process_attributes: *const c_void,
            thread_attributes: *const c_void,
            inherit_handles: i32,
            flags: u32,
            environment: *const c_void,
            current_directory: *const u16,
            startup: *const StartupInfo,
            info: *mut ProcessInformation,
        ) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }

    let mut line = String::new();
    quote_arg(&program.to_string_lossy(), &mut line);
    for arg in args {
        line.push(' ');
        quote_arg(arg, &mut line);
    }
    let app: Vec<u16> = program
        .as_os_str()
        .to_string_lossy()
        .encode_utf16()
        .chain([0])
        .collect();
    let mut desktop_wide: Option<Vec<u16>> = desktop.map(|d| d.encode_utf16().chain([0]).collect());
    let base = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
    let mut last = std::io::Error::other("not started");
    for flags in [base | CREATE_BREAKAWAY_FROM_JOB, base] {
        let mut command_line: Vec<u16> = line.encode_utf16().chain([0]).collect();
        let startup = StartupInfo {
            cb: size_of::<StartupInfo>() as u32,
            reserved: std::ptr::null_mut(),
            desktop: desktop_wide
                .as_mut()
                .map_or(std::ptr::null_mut(), |d| d.as_mut_ptr()),
            title: std::ptr::null_mut(),
            x: 0,
            y: 0,
            x_size: 0,
            y_size: 0,
            x_count_chars: 0,
            y_count_chars: 0,
            fill_attribute: 0,
            flags: 0,
            show_window: 0,
            cb_reserved2: 0,
            reserved2: std::ptr::null_mut(),
            std_input: std::ptr::null_mut(),
            std_output: std::ptr::null_mut(),
            std_error: std::ptr::null_mut(),
        };
        let mut info = ProcessInformation {
            process: std::ptr::null_mut(),
            thread: std::ptr::null_mut(),
            pid: 0,
            tid: 0,
        };
        // SAFETY: every string is NUL-terminated and outlives the call; `command_line` is a writable buffer as the
        // API requires; the structures are laid out as C lays them out and `info` is written only during the call.
        // Both returned handles are closed at once: the process lives on without them.
        let started = unsafe {
            CreateProcessW(
                app.as_ptr(),
                command_line.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                flags,
                std::ptr::null(),
                std::ptr::null(),
                &raw const startup,
                &raw mut info,
            )
        };
        if started != 0 {
            // SAFETY: the thread handle was just returned by CreateProcessW and is closed once; the process handle
            // goes to `Detached`, which closes it.
            unsafe {
                CloseHandle(info.thread);
            }
            return Ok(Detached {
                handle: info.process,
            });
        }
        last = std::io::Error::last_os_error();
        // A job that does not let its processes break away refuses the first try; start inside it then.
        if last.raw_os_error() != Some(ERROR_ACCESS_DENIED) {
            break;
        }
    }
    Err(last)
}
