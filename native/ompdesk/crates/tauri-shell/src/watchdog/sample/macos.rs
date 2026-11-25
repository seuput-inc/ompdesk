#![allow(unsafe_code)]
#![allow(
    deprecated,
    reason = "libc exposes the Mach APIs without a separate mach2 dependency"
)]

use std::mem::MaybeUninit;
use std::ptr;

use super::Sample;

// libc declares the host calls, but not the function that releases their host send right.
unsafe extern "C" {
    fn mach_port_deallocate(
        task: libc::mach_port_t,
        name: libc::mach_port_t,
    ) -> libc::kern_return_t;
}

fn process_cpu(pid: u32) -> Option<(u64, u64)> {
    let pid = i32::try_from(pid).ok().filter(|&pid| pid > 0)?;
    let mut info = MaybeUninit::<libc::rusage_info_v0>::uninit();
    // SAFETY: RUSAGE_INFO_V0 writes a rusage_info_v0 to this aligned buffer for the given pid.
    if unsafe { libc::proc_pid_rusage(pid, libc::RUSAGE_INFO_V0, info.as_mut_ptr().cast()) } != 0 {
        return None;
    }
    // SAFETY: proc_pid_rusage succeeded and initialized all the v0 fields.
    let info = unsafe { info.assume_init() };
    let mut base = libc::mach_timebase_info { numer: 0, denom: 0 };
    // SAFETY: base is writable and its type matches the Mach ABI.
    if unsafe { libc::mach_timebase_info(&mut base) } != libc::KERN_SUCCESS || base.denom == 0 {
        return None;
    }
    // rusage's user and system times are Mach absolute ticks, not nanoseconds on Apple silicon.
    let ticks = u128::from(info.ri_user_time) + u128::from(info.ri_system_time);
    let ns = u64::try_from(ticks * u128::from(base.numer) / u128::from(base.denom)).ok()?;
    Some((info.ri_proc_start_abstime, ns))
}

fn cpu_ticks(host: libc::host_t) -> Option<(u32, u64, u64)> {
    let mut cpus = 0;
    let mut words = 0;
    let mut info = ptr::null_mut();
    // SAFETY: host is a live send right; the kernel writes the array address and both counts.
    if unsafe {
        libc::host_processor_info(
            host,
            libc::PROCESSOR_CPU_LOAD_INFO,
            &mut cpus,
            &mut info,
            &mut words,
        )
    } != libc::KERN_SUCCESS
        || info.is_null()
    {
        return None;
    }
    let bytes = words as usize * size_of::<libc::integer_t>();
    let size_matches = bytes == cpus as usize * size_of::<libc::processor_cpu_load_info>();
    let result = if cpus != 0 && size_matches {
        // SAFETY: the Mach allocation holds exactly cpus load records, and lives through the loop.
        let loads = unsafe {
            std::slice::from_raw_parts(info.cast::<libc::processor_cpu_load_info>(), cpus as usize)
        };
        let mut busy = 0;
        let mut idle = 0;
        for load in loads {
            let t = &load.cpu_ticks;
            busy += u64::from(t[libc::CPU_STATE_USER as usize])
                + u64::from(t[libc::CPU_STATE_SYSTEM as usize])
                + u64::from(t[libc::CPU_STATE_NICE as usize]);
            idle += u64::from(t[libc::CPU_STATE_IDLE as usize]);
        }
        Some((cpus, busy, idle))
    } else {
        None
    };
    // SAFETY: the kernel allocated info in this task. vm_deallocate takes bytes, not integer words.
    unsafe { libc::vm_deallocate(libc::mach_task_self(), info as libc::vm_address_t, bytes) };
    result
}

fn free_bytes(host: libc::host_t) -> Option<u64> {
    let mut vm = MaybeUninit::<libc::vm_statistics>::zeroed();
    let mut words = (size_of::<libc::vm_statistics>() / size_of::<libc::integer_t>()) as u32;
    // SAFETY: the HOST_VM_INFO output buffer holds words integers and the count is writable.
    if unsafe {
        libc::host_statistics(host, libc::HOST_VM_INFO, vm.as_mut_ptr().cast(), &mut words)
    } != libc::KERN_SUCCESS
        || words == 0
    {
        return None;
    }
    // SAFETY: the all-integer vm was zeroed, its first field was filled, and sysconf takes no pointer.
    let (free, page_size) = unsafe {
        (
            vm.assume_init().free_count,
            libc::sysconf(libc::_SC_PAGESIZE),
        )
    };
    // libuv's uv_get_free_memory counts only free pages, not inactive or purgeable memory.
    Some(u64::from(free) * u64::try_from(page_size).ok()?)
}

pub(super) fn read(pid: u32) -> Option<Sample> {
    let (process_start, process_ns) = process_cpu(pid)?;
    // SAFETY: mach_host_self takes no arguments and returns a send right for this task.
    let host = unsafe { libc::mach_host_self() };
    if host == 0 {
        return None;
    }
    let cpu = cpu_ticks(host);
    let free = free_bytes(host);
    // SAFETY: release exactly the right returned above, whether either host query succeeded or not.
    unsafe { mach_port_deallocate(libc::mach_task_self(), host) };
    let (cpus, busy_ticks, idle_ticks) = cpu?;
    let free_bytes = free?;
    let mut total_bytes = 0_u64;
    let mut size = size_of::<u64>();
    let mut load = 0.0;
    // SAFETY: hw.memsize is a uint64_t, the buffer size matches, and no new value is supplied.
    if unsafe {
        libc::sysctlbyname(
            c"hw.memsize".as_ptr(),
            (&raw mut total_bytes).cast(),
            &mut size,
            ptr::null_mut(),
            0,
        )
    } != 0
        || size != size_of::<u64>()
    {
        return None;
    }
    // SAFETY: asking for one average writes at most one double to load.
    if unsafe { libc::getloadavg(&mut load, 1) } != 1 {
        return None;
    }
    Some(Sample {
        cpus,
        busy_ticks,
        idle_ticks,
        process_start,
        process_ns,
        free_bytes,
        total_bytes,
        load1: Some(load),
    })
}
