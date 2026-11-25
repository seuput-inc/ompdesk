#![allow(unsafe_code)]

use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};

use windows_sys::Win32::Foundation::FILETIME;
use windows_sys::Win32::System::SystemInformation::{
    GetSystemInfo, GlobalMemoryStatusEx, MEMORYSTATUSEX, SYSTEM_INFO,
};
use windows_sys::Win32::System::Threading::{
    GetProcessTimes, GetSystemTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};

use super::Sample;

fn ticks(time: FILETIME) -> u64 {
    (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime)
}

pub(super) fn read(pid: u32) -> Option<Sample> {
    // SAFETY: no pointers, only query access, and a non-inheritable handle.
    let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if raw.is_null() {
        return None;
    }
    // SAFETY: OpenProcess returned one owned handle which OwnedHandle closes on every return.
    let process = unsafe { OwnedHandle::from_raw_handle(raw) };
    let [mut start, mut exit, mut kernel, mut user] = [FILETIME::default(); 4];
    // SAFETY: process stays open and each output is a distinct writable FILETIME.
    if unsafe {
        GetProcessTimes(
            process.as_raw_handle(),
            &mut start,
            &mut exit,
            &mut kernel,
            &mut user,
        )
    } == 0
    {
        return None;
    }
    let process_ns = ticks(kernel).checked_add(ticks(user))?.checked_mul(100)?;

    let mut idle = FILETIME::default();
    // SAFETY: the three distinct FILETIME outputs are valid for the duration of the call.
    if unsafe { GetSystemTimes(&mut idle, &mut kernel, &mut user) } == 0 {
        return None;
    }
    // Kernel time already includes idle and interrupts. Node's os.cpus() uses the same group
    // as GetSystemInfo, not the process's affinity or a count across other processor groups.
    let idle_ticks = ticks(idle);
    let busy_ticks = ticks(kernel)
        .checked_sub(idle_ticks)?
        .checked_add(ticks(user))?;
    let mut system = SYSTEM_INFO::default();
    let mut memory = MEMORYSTATUSEX {
        dwLength: size_of::<MEMORYSTATUSEX>() as u32,
        ..Default::default()
    };
    // SAFETY: both are writable SDK structs; dwLength describes the entire memory buffer.
    unsafe {
        GetSystemInfo(&mut system);
        if GlobalMemoryStatusEx(&mut memory) == 0 {
            return None;
        }
    }
    Some(Sample {
        cpus: system.dwNumberOfProcessors,
        busy_ticks,
        idle_ticks,
        process_start: ticks(start),
        process_ns,
        free_bytes: memory.ullAvailPhys,
        total_bytes: memory.ullTotalPhys,
        load1: None,
    })
}
