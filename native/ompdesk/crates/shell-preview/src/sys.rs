#![allow(unsafe_code)]

#[cfg(unix)]
pub(crate) struct Child {
    process: tokio::process::Child,
    _stdin: Option<tokio::process::ChildStdin>,
    group: bool,
}

#[cfg(unix)]
impl Child {
    pub(crate) fn id(&self) -> Option<u32> {
        self.process.id()
    }

    pub(crate) async fn wait(&mut self) -> std::io::Result<std::process::ExitStatus> {
        self.process.wait().await
    }
    pub(crate) async fn finish(&mut self) -> std::io::Result<()> {
        Ok(())
    }

    pub(crate) fn start_kill(&mut self) -> std::io::Result<()> {
        if self.group
            && let Some(pid) = self
                .process
                .id()
                .and_then(|id| libc::pid_t::try_from(id).ok())
                .filter(|id| *id > 1)
        {
            // SAFETY: this unreaped child started its own session, so its PID still identifies its process group.
            if unsafe { libc::kill(-pid, libc::SIGKILL) } == 0 {
                return Ok(());
            }
        }
        self.process.start_kill()
    }
}

#[cfg(all(unix, test))]
pub(crate) fn test_child(mut process: tokio::process::Child) -> Child {
    let stdin = process.stdin.take();
    Child {
        process,
        _stdin: stdin,
        group: false,
    }
}

#[cfg(unix)]
pub(crate) fn spawn(
    executable: &std::path::Path,
    profile: &std::path::Path,
) -> std::io::Result<(
    Child,
    tokio::net::unix::OwnedReadHalf,
    tokio::net::unix::OwnedWriteHalf,
)> {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;

    // Darwin FIFO kqueue notifications follow completion of a blocking write, which can deadlock a large CDP reply.
    let (parent, child) = std::os::unix::net::UnixStream::pair()?;
    parent.set_nonblocking(true)?;
    // SAFETY: child is open; moving its duplicate above 4 avoids collisions with the fd3/fd4 remapping.
    let copy = unsafe { libc::fcntl(child.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 5) };
    if copy < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: fcntl returned a new descriptor owned by this scope.
    let child_fd = unsafe { OwnedFd::from_raw_fd(copy) };
    let fd = child_fd.as_raw_fd();
    let stream = tokio::net::UnixStream::from_std(parent)?;
    let mut command = tokio::process::Command::new(executable);
    command.args(super::transport::arguments(profile));
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    // SAFETY: after fork the closure calls only async-signal-safe setsid and dup2.
    unsafe {
        command.as_std_mut().pre_exec(move || {
            if libc::setsid() < 0 || libc::dup2(fd, 3) < 0 || libc::dup2(fd, 4) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut process = command.spawn()?;
    let stdin = process.stdin.take();
    let (read, write) = stream.into_split();
    Ok((
        Child {
            process,
            _stdin: stdin,
            group: true,
        },
        read,
        write,
    ))
}

#[cfg(windows)]
mod windows {
    use std::ffi::{OsStr, OsString, c_void};
    use std::io;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::os::windows::process::ExitStatusExt;
    use std::path::Path;
    use std::process::ExitStatus;
    use std::sync::Arc;
    use tokio::sync::watch;

    type Handle = *mut c_void;

    #[repr(C)]
    struct SecurityAttributes {
        length: u32,
        descriptor: *mut c_void,
        inherit: i32,
    }
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
    #[repr(C)]
    struct BasicLimits {
        process_time: i64,
        job_time: i64,
        flags: u32,
        min_working_set: usize,
        max_working_set: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }
    #[repr(C)]
    struct IoCounters {
        read_ops: u64,
        write_ops: u64,
        other_ops: u64,
        read_bytes: u64,
        write_bytes: u64,
        other_bytes: u64,
    }
    #[repr(C)]
    struct ExtendedLimits {
        basic: BasicLimits,
        io: IoCounters,
        process_memory: usize,
        job_memory: usize,
        peak_process_memory: usize,
        peak_job_memory: usize,
    }

    #[repr(C)]
    struct JobAccounting {
        total_user_time: i64,
        total_kernel_time: i64,
        period_user_time: i64,
        period_kernel_time: i64,
        page_faults: u32,
        total_processes: u32,
        active_processes: u32,
        terminated_processes: u32,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreatePipe(
            read: *mut Handle,
            write: *mut Handle,
            attrs: *mut SecurityAttributes,
            size: u32,
        ) -> i32;
        fn SetHandleInformation(handle: Handle, mask: u32, flags: u32) -> i32;
        fn CreateFileW(
            name: *const u16,
            access: u32,
            share: u32,
            attrs: *mut SecurityAttributes,
            creation: u32,
            flags: u32,
            template: Handle,
        ) -> Handle;
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
        fn CreateJobObjectW(attrs: *mut c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(job: Handle, class: u32, info: *const c_void, size: u32) -> i32;
        fn QueryInformationJobObject(
            job: Handle,
            class: u32,
            info: *mut c_void,
            size: u32,
            returned: *mut u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn TerminateJobObject(job: Handle, code: u32) -> i32;
        fn TerminateProcess(process: Handle, code: u32) -> i32;
        fn ResumeThread(thread: Handle) -> u32;
        fn WaitForSingleObject(handle: Handle, millis: u32) -> u32;
        fn GetExitCodeProcess(process: Handle, code: *mut u32) -> i32;
    }

    fn last_error() -> io::Error {
        io::Error::last_os_error()
    }

    fn pipe() -> io::Result<(OwnedHandle, OwnedHandle)> {
        let mut attrs = SecurityAttributes {
            length: std::mem::size_of::<SecurityAttributes>() as u32,
            descriptor: std::ptr::null_mut(),
            inherit: 1,
        };
        let (mut read, mut write) = (std::ptr::null_mut(), std::ptr::null_mut());
        // SAFETY: both output pointers and the security attributes are valid for this call.
        if unsafe { CreatePipe(&mut read, &mut write, &mut attrs, 0) } == 0 {
            return Err(last_error());
        }
        // SAFETY: CreatePipe returned two distinct handles owned by this function.
        Ok(unsafe {
            (
                OwnedHandle::from_raw_handle(read),
                OwnedHandle::from_raw_handle(write),
            )
        })
    }

    fn noninheritable(handle: &OwnedHandle) -> io::Result<()> {
        // SAFETY: handle is open and the mask clears only its inherit flag.
        if unsafe { SetHandleInformation(handle.as_raw_handle(), 1, 0) } == 0 {
            Err(last_error())
        } else {
            Ok(())
        }
    }

    fn quote(arg: &OsStr, command: &mut Vec<u16>) {
        command.push(b'\"' as u16);
        let mut slashes = 0;
        for c in arg.encode_wide() {
            if c == b'\\' as u16 {
                slashes += 1;
            } else {
                let count = if c == b'\"' as u16 {
                    slashes * 2 + 1
                } else {
                    slashes
                };
                command.extend(std::iter::repeat_n(b'\\' as u16, count));
                command.push(c);
                slashes = 0;
            }
        }
        command.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2));
        command.push(b'\"' as u16);
    }

    struct Attributes(Vec<usize>);
    impl Drop for Attributes {
        fn drop(&mut self) {
            // SAFETY: the list was initialized successfully and has not been deleted.
            unsafe { DeleteProcThreadAttributeList(self.0.as_mut_ptr().cast()) };
        }
    }

    pub(crate) struct Child {
        pid: u32,
        job: OwnedHandle,
        _stdin: OwnedHandle,
        status: watch::Receiver<Option<std::result::Result<u32, i32>>>,
    }

    impl Child {
        pub(crate) fn id(&self) -> Option<u32> {
            Some(self.pid)
        }

        pub(crate) async fn wait(&mut self) -> io::Result<ExitStatus> {
            loop {
                if let Some(status) = *self.status.borrow_and_update() {
                    return status
                        .map(ExitStatus::from_raw)
                        .map_err(io::Error::from_raw_os_error);
                }
                self.status
                    .changed()
                    .await
                    .map_err(|_| io::Error::other("Chromium wait task stopped"))?;
            }
        }

        pub(crate) async fn finish(&mut self) -> io::Result<()> {
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
            let mut terminated = false;
            loop {
                // SAFETY: zero is valid for this output-only Windows accounting structure.
                let mut accounting: JobAccounting = unsafe { std::mem::zeroed() };
                // SAFETY: the job is open and accounting has the layout and size required for class 1.
                if unsafe {
                    QueryInformationJobObject(
                        self.job.as_raw_handle(),
                        1,
                        (&raw mut accounting).cast(),
                        std::mem::size_of::<JobAccounting>() as u32,
                        std::ptr::null_mut(),
                    )
                } == 0
                {
                    return Err(last_error());
                }
                if accounting.active_processes == 0 {
                    return Ok(());
                }
                if !terminated {
                    self.start_kill()?;
                    terminated = true;
                }
                if tokio::time::Instant::now() >= deadline {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "Chromium job did not exit",
                    ));
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        }

        pub(crate) fn start_kill(&mut self) -> io::Result<()> {
            // SAFETY: the job handle remains open for the lifetime of self.
            if unsafe { TerminateJobObject(self.job.as_raw_handle(), 1) } == 0 {
                Err(last_error())
            } else {
                Ok(())
            }
        }
    }

    pub(crate) fn spawn(
        executable: &Path,
        profile: &Path,
    ) -> io::Result<(Child, tokio::fs::File, tokio::fs::File)> {
        let (child_read, parent_write) = pipe()?;
        let (parent_read, child_write) = pipe()?;
        let (child_stdin, parent_stdin) = pipe()?;
        noninheritable(&parent_write)?;
        noninheritable(&parent_read)?;
        noninheritable(&parent_stdin)?;
        let mut attrs = SecurityAttributes {
            length: std::mem::size_of::<SecurityAttributes>() as u32,
            descriptor: std::ptr::null_mut(),
            inherit: 1,
        };
        let nul: Vec<u16> = OsStr::new("NUL").encode_wide().chain(Some(0)).collect();
        // SAFETY: the NUL path is terminated and attrs is initialized.
        let null = unsafe {
            CreateFileW(
                nul.as_ptr(),
                0x4000_0000,
                3,
                &mut attrs,
                3,
                0,
                std::ptr::null_mut(),
            )
        };
        if null as isize == -1 {
            return Err(last_error());
        }
        // SAFETY: CreateFileW returned a new owned handle.
        let null = unsafe { OwnedHandle::from_raw_handle(null) };

        let mut list_size = 0;
        // SAFETY: the null probe asks Windows for the required allocation size.
        unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut list_size) };
        let mut storage = vec![0usize; list_size.div_ceil(std::mem::size_of::<usize>())];
        // SAFETY: storage is aligned and large enough for the size returned by Windows.
        if unsafe {
            InitializeProcThreadAttributeList(storage.as_mut_ptr().cast(), 1, 0, &mut list_size)
        } == 0
        {
            return Err(last_error());
        }
        let mut list = Attributes(storage);
        let mut handles = [
            child_read.as_raw_handle(),
            child_write.as_raw_handle(),
            child_stdin.as_raw_handle(),
            null.as_raw_handle(),
        ];
        // SAFETY: the attribute list is initialized and handles stays alive through CreateProcessW.
        if unsafe {
            UpdateProcThreadAttribute(
                list.0.as_mut_ptr().cast(),
                0,
                0x20002,
                handles.as_mut_ptr().cast(),
                std::mem::size_of_val(&handles),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(last_error());
        }

        // SAFETY: null arguments request an unnamed job with default security.
        let job = unsafe { CreateJobObjectW(std::ptr::null_mut(), std::ptr::null()) };
        if job.is_null() {
            return Err(last_error());
        }
        // SAFETY: CreateJobObjectW returned a new owned handle.
        let job = unsafe { OwnedHandle::from_raw_handle(job) };
        // SAFETY: zero is a valid starting value for the Windows limit structure.
        let mut limits: ExtendedLimits = unsafe { std::mem::zeroed() };
        limits.basic.flags = 0x2000;
        // SAFETY: job is open and limits has the exact layout and size required for class 9.
        if unsafe {
            SetInformationJobObject(
                job.as_raw_handle(),
                9,
                (&raw const limits).cast(),
                std::mem::size_of::<ExtendedLimits>() as u32,
            )
        } == 0
        {
            return Err(last_error());
        }

        let application: Vec<u16> = executable
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        let mut command = Vec::new();
        quote(executable.as_os_str(), &mut command);
        let mut args = crate::transport::arguments(profile);
        args.insert(
            args.len() - 1,
            OsString::from(format!(
                "--remote-debugging-io-pipes={},{}",
                child_read.as_raw_handle() as usize,
                child_write.as_raw_handle() as usize
            )),
        );
        for arg in args {
            command.push(b' ' as u16);
            quote(&arg, &mut command);
        }
        command.push(0);
        // SAFETY: all-zero is a valid initialization for these Windows structures.
        let mut startup: StartupInfoEx = unsafe { std::mem::zeroed() };
        startup.startup.cb = std::mem::size_of::<StartupInfoEx>() as u32;
        startup.startup.flags = 0x100;
        startup.startup.stdin = child_stdin.as_raw_handle();
        startup.startup.stdout = null.as_raw_handle();
        startup.startup.stderr = null.as_raw_handle();
        startup.attributes = list.0.as_mut_ptr().cast();
        // SAFETY: zero is valid for the process information output structure.
        let mut info: ProcessInformation = unsafe { std::mem::zeroed() };
        // SAFETY: all pointers are valid through the call, strings are NUL terminated, and the inherited handle list is explicit.
        if unsafe {
            CreateProcessW(
                application.as_ptr(),
                command.as_mut_ptr(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                1,
                0x0800_0000 | 0x0008_0000 | 0x4,
                std::ptr::null_mut(),
                std::ptr::null(),
                &mut startup.startup,
                &mut info,
            )
        } == 0
        {
            return Err(last_error());
        }
        // SAFETY: successful CreateProcessW returns two new owned handles.
        let process = Arc::new(unsafe { OwnedHandle::from_raw_handle(info.process) });
        // SAFETY: the thread handle is distinct and owned by this function.
        let thread = unsafe { OwnedHandle::from_raw_handle(info.thread) };
        // SAFETY: both handles refer to the newly created suspended process and its job.
        if unsafe { AssignProcessToJobObject(job.as_raw_handle(), process.as_raw_handle()) } == 0 {
            let error = last_error();
            // SAFETY: the suspended process has an open handle; wait joins that exact process.
            unsafe {
                TerminateProcess(process.as_raw_handle(), 1);
                WaitForSingleObject(process.as_raw_handle(), u32::MAX);
            }
            return Err(error);
        }
        // SAFETY: this is the primary thread returned by CreateProcessW.
        if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX {
            let error = last_error();
            // SAFETY: the process belongs to this job and its handle remains open.
            unsafe {
                TerminateJobObject(job.as_raw_handle(), 1);
                WaitForSingleObject(process.as_raw_handle(), u32::MAX);
            }
            return Err(error);
        }
        let (status_tx, status) = watch::channel(None);
        tokio::task::spawn_blocking(move || {
            // SAFETY: the process handle is kept open by the Arc for the duration of the wait.
            let result = if unsafe { WaitForSingleObject(process.as_raw_handle(), u32::MAX) } == 0 {
                let mut code = 0;
                // SAFETY: the handle is open and code is valid for the returned exit status.
                if unsafe { GetExitCodeProcess(process.as_raw_handle(), &mut code) } != 0 {
                    Ok(code)
                } else {
                    Err(last_error().raw_os_error().unwrap_or(1))
                }
            } else {
                Err(last_error().raw_os_error().unwrap_or(1))
            };
            status_tx.send_replace(Some(result));
        });
        let read = tokio::fs::File::from_std(std::fs::File::from(parent_read));
        let write = tokio::fs::File::from_std(std::fs::File::from(parent_write));
        Ok((
            Child {
                pid: info.process_id,
                job,
                _stdin: parent_stdin,
                status,
            },
            read,
            write,
        ))
    }
}

#[cfg(windows)]
pub(crate) use windows::{Child, spawn};
