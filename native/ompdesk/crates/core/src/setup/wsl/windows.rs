//! Windows-only reads. This module is part of `crate::sys`, the core's Win32 boundary.
use std::ffi::{OsString, c_void};
use std::io;
use std::mem::size_of_val;
use std::os::windows::ffi::OsStringExt;
use std::path::PathBuf;
use std::ptr::{null, null_mut};

use crate::setup::wsl::{Distribution, Inventory, guid, package_version};

const HKCU: isize = 0x8000_0001u32 as i32 as isize;
const HKLM: isize = 0x8000_0002u32 as i32 as isize;
const LXSS: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Lxss";
const MSI: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Lxss\MSI";
const FAMILY: &str = "MicrosoftCorporationII.WindowsSubsystemForLinux_8wekyb3d8bbwe";

#[link(name = "advapi32")]
unsafe extern "system" {
    fn RegOpenKeyExW(h: isize, name: *const u16, options: u32, access: u32, out: *mut isize)
    -> i32;
    fn RegCloseKey(h: isize) -> i32;
    fn RegEnumKeyExW(
        h: isize,
        index: u32,
        name: *mut u16,
        length: *mut u32,
        reserved: *mut u32,
        class: *mut u16,
        class_len: *mut u32,
        time: *mut c_void,
    ) -> i32;
    fn RegGetValueW(
        h: isize,
        subkey: *const u16,
        value: *const u16,
        flags: u32,
        kind: *mut u32,
        data: *mut c_void,
        size: *mut u32,
    ) -> i32;
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetSystemDirectoryW(buf: *mut u16, size: u32) -> u32;
    fn GetPackagesByPackageFamily(
        family: *const u16,
        count: *mut u32,
        names: *mut *mut u16,
        length: *mut u32,
        buffer: *mut u16,
    ) -> i32;
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain([0]).collect()
}

pub(crate) fn system_directory() -> io::Result<PathBuf> {
    let mut buf = [0; 260];
    // SAFETY: the buffer holds the supplied number of WCHARs.
    let n = unsafe { GetSystemDirectoryW(buf.as_mut_ptr(), buf.len() as u32) } as usize;
    if n == 0 || n >= buf.len() {
        return Err(io::Error::other("Cannot locate System32"));
    }
    Ok(OsString::from_wide(&buf[..n]).into())
}

struct Key(isize);

impl Drop for Key {
    fn drop(&mut self) {
        // SAFETY: only a successful RegOpenKeyExW constructs Key.
        unsafe { RegCloseKey(self.0) };
    }
}

impl Key {
    fn open(root: isize, path: &str) -> io::Result<Option<Self>> {
        let mut h = 0;
        // SAFETY: root is a predefined key, the path is terminated and h is writable. KEY_READ | KEY_WOW64_64KEY.
        match unsafe { RegOpenKeyExW(root, wide(path).as_ptr(), 0, 0x20119, &mut h) } {
            0 => Ok(Some(Self(h))),
            2 | 3 => Ok(None),
            code => Err(io::Error::from_raw_os_error(code)),
        }
    }

    fn text(&self, subkey: Option<&[u16]>, name: &[u16]) -> io::Result<Option<String>> {
        let mut bytes = [0u16; 512];
        let mut size = size_of_val(&bytes) as u32;
        // SAFETY: names are terminated, REG_SZ is required, and size is the byte capacity of the writable buffer.
        let code = unsafe {
            RegGetValueW(
                self.0,
                subkey.map_or(null(), <[u16]>::as_ptr),
                name.as_ptr(),
                2,
                null_mut(),
                bytes.as_mut_ptr().cast(),
                &mut size,
            )
        };
        match code {
            0 if size >= 2 && size.is_multiple_of(2) => {
                let units = &bytes[..size as usize / 2];
                let value = units
                    .strip_suffix(&[0])
                    .filter(|s| !s.contains(&0))
                    .ok_or_else(bad_registry)?;
                String::from_utf16(value)
                    .map(Some)
                    .map_err(|_| bad_registry())
            }
            0 => Err(bad_registry()),
            2 => Ok(None),
            code => Err(io::Error::from_raw_os_error(code)),
        }
    }
}

fn bad_registry() -> io::Error {
    io::Error::other("Invalid WSL registration")
}

fn distributions() -> io::Result<Vec<Distribution>> {
    let mut result = Vec::new();
    let Some(root) = Key::open(HKCU, LXSS)? else {
        return Ok(result);
    };
    let default = root.text(None, &wide("DefaultDistribution"))?;
    let name_field = wide("DistributionName");
    let version_field = wide("Version");
    for index in 0..4096 {
        let mut subkey = [0; 256]; // Windows limits registry key names to 255 UTF-16 units.
        let mut len = subkey.len() as u32;
        // SAFETY: root stays open, the name buffer holds len units and all unused outputs are null.
        match unsafe {
            RegEnumKeyExW(
                root.0,
                index,
                subkey.as_mut_ptr(),
                &mut len,
                null_mut(),
                null_mut(),
                null_mut(),
                null_mut(),
            )
        } {
            259 => return Ok(result), // ERROR_NO_MORE_ITEMS
            0 => {}
            code => return Err(io::Error::from_raw_os_error(code)),
        }
        let id = String::from_utf16(&subkey[..len as usize]).map_err(|_| bad_registry())?;
        if !guid(&id) {
            continue; // Lxss also contains non-distribution keys.
        }
        let name = root
            .text(Some(&subkey), &name_field)?
            .ok_or_else(bad_registry)?;
        let mut version = 0u32;
        let mut size = size_of_val(&version) as u32;
        // SAFETY: both names are terminated, REG_DWORD is required and the buffer holds one DWORD.
        let code = unsafe {
            RegGetValueW(
                root.0,
                subkey.as_ptr(),
                version_field.as_ptr(),
                16,
                null_mut(),
                (&raw mut version).cast(),
                &mut size,
            )
        };
        if code != 0 {
            return Err(io::Error::from_raw_os_error(code));
        }
        result.push(Distribution::registered(
            id,
            name,
            version,
            default.as_deref(),
        )?);
    }
    Err(bad_registry())
}

fn app_version() -> Option<String> {
    // Microsoft's MSI records its package version here; System32's wsl.exe is an OS launcher.
    if let Some(msi) = Key::open(HKLM, MSI).ok()? {
        return msi
            .text(None, &wide("Version"))
            .ok()?
            .filter(|s| package_version(s).is_some());
    }
    let mut names = [null_mut(); 32];
    let mut buf = [0; 4096];
    let mut count = names.len() as u32;
    let mut length = buf.len() as u32;
    // SAFETY: family is terminated and both output arrays have their stated capacities. No pointer escapes.
    if unsafe {
        GetPackagesByPackageFamily(
            wide(FAMILY).as_ptr(),
            &mut count,
            names.as_mut_ptr(),
            &mut length,
            buf.as_mut_ptr(),
        )
    } != 0
    {
        return None;
    }
    let mut found = None;
    for name in names.iter().take(count as usize) {
        let offset = name.addr().checked_sub(buf.as_ptr().addr())? / size_of::<u16>();
        let tail = buf.get(offset..)?;
        let text = String::from_utf16(&tail[..tail.iter().position(|v| *v == 0)?]).ok()?;
        let version = text
            .strip_prefix("MicrosoftCorporationII.WindowsSubsystemForLinux_")?
            .split('_')
            .next()?;
        package_version(version)?;
        if found.as_deref().is_some_and(|v| v != version) {
            return None; // Conflicting registered versions do not identify the launcher's version.
        }
        found.get_or_insert_with(|| version.to_owned());
    }
    found
}

pub(crate) fn inventory() -> io::Result<Inventory> {
    Ok(Inventory {
        distributions: distributions()?,
        app_version: app_version(),
    })
}
