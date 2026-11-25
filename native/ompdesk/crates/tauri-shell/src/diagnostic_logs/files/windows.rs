use std::{
    fs::{File, OpenOptions},
    io,
    mem::{size_of, size_of_val},
    os::windows::{
        fs::{MetadataExt, OpenOptionsExt},
        io::{AsRawHandle, FromRawHandle},
    },
    path::Path,
    ptr,
};
use windows_sys::{
    Wdk::{
        Foundation::OBJECT_ATTRIBUTES,
        Storage::FileSystem::{
            FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE, FILE_OPEN_REPARSE_POINT,
            FILE_SYNCHRONOUS_IO_NONALERT, NtOpenFile,
        },
    },
    Win32::{
        Foundation::{
            OBJ_CASE_INSENSITIVE, OBJ_DONT_REPARSE, RtlNtStatusToDosError, UNICODE_STRING,
        },
        Storage::FileSystem::{
            FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
            FILE_GENERIC_READ, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
            FILE_SHARE_WRITE, FILE_TRAVERSE, FILE_TYPE_DISK, GetFileType, SYNCHRONIZE,
        },
        System::IO::IO_STATUS_BLOCK,
    },
};

const DIRECTORY_ACCESS: u32 = FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE;

pub(super) fn open(profile: &Path, archive: bool) -> io::Result<File> {
    let profile = OpenOptions::new()
        .access_mode(DIRECTORY_ACCESS)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(profile)?;
    check_disk_entry(&profile, true)?;
    let logs = child(&profile, b"logs", DIRECTORY_ACCESS, FILE_DIRECTORY_FILE)?;
    check_disk_entry(&logs, true)?;
    let leaf = if archive {
        child(
            &logs,
            b"gui-runtime.jsonl.1",
            FILE_GENERIC_READ,
            FILE_NON_DIRECTORY_FILE,
        )
    } else {
        child(
            &logs,
            b"gui-runtime.jsonl",
            FILE_GENERIC_READ,
            FILE_NON_DIRECTORY_FILE,
        )
    }?;
    check_disk_entry(&leaf, false)?;
    Ok(leaf)
}

#[allow(unsafe_code)]
fn check_disk_entry(file: &File, directory: bool) -> io::Result<()> {
    // SAFETY: the borrowed file keeps the queried handle live.
    if unsafe { GetFileType(file.as_raw_handle()) } == FILE_TYPE_DISK {
        let metadata = file.metadata()?;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0
            && metadata.is_dir() == directory
        {
            return Ok(());
        }
    }
    Err(io::Error::new(
        io::ErrorKind::InvalidData,
        "unexpected log path entry",
    ))
}

#[allow(unsafe_code)]
fn child<const N: usize>(
    parent: &File,
    ascii: &[u8; N],
    access: u32,
    kind: u32,
) -> io::Result<File> {
    // Every call supplies one fixed ASCII component, never a path or an object-manager name.
    let mut wide = ascii.map(u16::from);
    let bytes = size_of_val(&wide) as u16;
    let name = UNICODE_STRING {
        Length: bytes,
        MaximumLength: bytes,
        Buffer: wide.as_mut_ptr(),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent.as_raw_handle(),
        ObjectName: &name,
        Attributes: OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE,
        ..Default::default()
    };
    let mut handle = ptr::null_mut();
    let mut result = IO_STATUS_BLOCK::default();
    // SAFETY: the directory handle, counted name, and both outputs live through the synchronous call.
    let status = unsafe {
        NtOpenFile(
            &mut handle,
            access,
            &attributes,
            &mut result,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            kind | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
        )
    };
    if status < 0 {
        // SAFETY: this is a pure NTSTATUS translation, without pointers.
        return Err(io::Error::from_raw_os_error(
            unsafe { RtlNtStatusToDosError(status) } as i32,
        ));
    }
    // SAFETY: a successful NtOpenFile transfers one newly opened handle to us.
    Ok(unsafe { File::from_raw_handle(handle) })
}
