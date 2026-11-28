//! The Git item's Mandatory ASLR override (was `src/main/setup/git-aslr.ts`): Windows' Mandatory ASLR kills every MSYS
//! fork with 0xC0000142 (and causes silent exit 127 when a shell with ASLR off invokes an MSYS child that still
//! inherits system Mandatory ASLR on). The fix the person may choose is a per-image override, Force randomization
//! always off, for every MSYS executable under `<git>\usr`, in one elevated step that edits only bits 8–11 of each
//! image's `MitigationOptions` via the 64-bit native registry (never `Set-ProcessMitigation`, which rewrites the whole
//! entry) and verifies each persisted entry before recording it. Fix records each verified image with its prior state
//! in `<userData>/git-aslr.json`; detection audits actual OS IFEO mitigations against `<git>\usr\**\*.exe` rather than
//! trusting `git-aslr.json` or `sh.exe` alone. Undo puts back only recorded images while they still say off.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::paths::join;
use super::plans::{powershell_script, ps_quote};
use crate::fs::path::normalize_win32;
use crate::tools::runner::SpawnSpec;

/// In userData, beside setup's state file (`GIT_ASLR_RECORD`).
pub const RECORD: &str = "git-aslr.json";

/// One image Fix changed and its ForceRelocateImages state before (`notset`, `on`, `on-require-relocs`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Image {
    pub path: String,
    pub prior: String,
}

/// `git-aslr.json`: the images Fix changed, per Git root key (`GitAslrRecord`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Record {
    pub roots: Map<String, Value>,
}

/// What Windows' IFEO registry says about per-image `ForceRelocateImages=OFF` overrides.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct IfeoState {
    /// Lowercased normalized full paths (`FilterFullPath`) whose parent `<exe>` key has `UseFilter != 0` and whose
    /// filtered subkey has `ForceRelocateImages` set to `OFF` (nibble 2).
    pub filtered_off: HashSet<String>,
    /// Lowercased image basenames (`grep.exe`) whose parent `<exe>` key has `UseFilter` absent/0 and directly sets
    /// `ForceRelocateImages` to `OFF` (nibble 2).
    pub basename_off: HashSet<String>,
}

/// Live OS mitigation state read from HKLM (kernel system setting + per-image IFEO).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OsState {
    /// System-wide Mandatory ASLR (`ForceRelocateImages` ON or ON+RequireInfo) in kernel `MitigationOptions`.
    pub system_mandatory_aslr: bool,
    pub ifeo: IfeoState,
}

/// Audit of `<git>\usr\**\*.exe` against the OS mitigation state.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Audit {
    /// True when Windows holds a per-image `UseFilter` override for at least one MSYS executable of this Git.
    pub overridden: bool,
    /// MSYS executables under `<git>\usr` that lack an effective `ForceRelocateImages=OFF` override.
    pub missing: Vec<String>,
    /// True when system-wide Mandatory ASLR is ON and at least one MSYS executable lacks an effective override.
    pub incomplete: bool,
}

fn nibble_of(prior: &str) -> Option<u8> {
    match prior {
        "notset" => Some(0),
        "on" => Some(1),
        "on-require-relocs" => Some(3),
        _ => None,
    }
}

fn prior_of(nibble: i64) -> Option<&'static str> {
    match nibble {
        0 => Some("notset"),
        1 => Some("on"),
        3 => Some("on-require-relocs"),
        _ => None,
    }
}

fn root_key(root: &str) -> String {
    normalize_win32(root).trim_end_matches('\\').to_lowercase()
}

fn image_key(path: &str) -> String {
    normalize_win32(path).to_lowercase()
}

fn image_filename(path: &str) -> &str {
    path.rsplit(['\\', '/']).next().unwrap_or(path)
}

/// Bits 8–11 of `MitigationOptions` (byte 1 low nibble): `0` notset, `1` on, `2` off, `3` on-require-relocs.
pub fn force_relocate_nibble(options: &[u8]) -> Option<u8> {
    options.get(1).map(|byte| byte & 0x0f)
}

pub fn is_force_relocate_on(options: &[u8]) -> bool {
    matches!(force_relocate_nibble(options), Some(1 | 3))
}

pub fn is_force_relocate_off(options: &[u8]) -> bool {
    force_relocate_nibble(options) == Some(2)
}

fn force_relocate_nibble_hex(hex: &str) -> Option<u8> {
    if hex.len() < 4 {
        return None;
    }
    u8::from_str_radix(&hex[2..4], 16)
        .ok()
        .map(|byte| byte & 0x0f)
}

impl IfeoState {
    /// Whether `image` has an active path-filtered (`UseFilter != 0` + `FilterFullPath`) `ForceRelocateImages=OFF`.
    pub fn has_filtered_override(&self, image: &str) -> bool {
        self.filtered_off.contains(&image_key(image))
    }

    /// Whether Windows turns Mandatory ASLR off for `image` (either via its path-filtered entry or a basename-level
    /// IFEO override when `UseFilter` is off).
    pub fn protects_image(&self, image: &str) -> bool {
        self.has_filtered_override(image)
            || self
                .basename_off
                .contains(&image_filename(image).to_lowercase())
    }

    /// Images in `images` that do not have an effective `ForceRelocateImages=OFF` override.
    pub fn missing_overrides(&self, images: &[String]) -> Vec<String> {
        images
            .iter()
            .filter(|image| !self.protects_image(image))
            .cloned()
            .collect()
    }

    /// Whether at least one image in `images` has a path-filtered `ForceRelocateImages=OFF` override.
    pub fn any_filtered_override(&self, images: &[String]) -> bool {
        images.iter().any(|image| self.has_filtered_override(image))
    }
}

/// Audits `images` (all MSYS executables under `<root>\usr`) against the actual OS mitigation state.
pub fn audit(images: &[String], os: &OsState) -> Audit {
    let overridden = os.ifeo.any_filtered_override(images);
    let missing = os.ifeo.missing_overrides(images);
    let incomplete = os.system_mandatory_aslr && !missing.is_empty();
    Audit {
        overridden,
        missing,
        incomplete,
    }
}

/// Whether at least one image OMPdesk recorded for `root` still has an active path-filtered override in Windows IFEO.
pub fn any_recorded_override_active(record: &Record, root: &str, ifeo: &IfeoState) -> bool {
    recorded_images(record, root)
        .iter()
        .any(|image| ifeo.has_filtered_override(&image.path))
}

/// Keeps only Fix results whose path-filtered `ForceRelocateImages=OFF` override is verified present in `ifeo`.
pub fn filter_verified_fix(fixed: &[Image], ifeo: &IfeoState) -> Vec<Image> {
    fixed
        .iter()
        .filter(|image| ifeo.has_filtered_override(&image.path))
        .cloned()
        .collect()
}

/// Keeps only Undo results whose path-filtered `ForceRelocateImages=OFF` override is verified no longer active.
pub fn filter_verified_undo(restored: &[String], ifeo: &IfeoState) -> Vec<String> {
    restored
        .iter()
        .filter(|path| !ifeo.has_filtered_override(path))
        .cloned()
        .collect()
}

/// Enumerates every `.exe` regular file under `<root>\usr`, sorted case-insensitively.
pub fn usr_executables(root: &str) -> Vec<String> {
    let usr = Path::new(root).join("usr");
    let mut stack = vec![usr];
    let mut out = Vec::new();
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if kind.is_dir() {
                stack.push(path);
            } else if kind.is_file()
                && entry
                    .file_name()
                    .to_string_lossy()
                    .to_ascii_lowercase()
                    .ends_with(".exe")
            {
                out.push(path.to_string_lossy().into_owned());
            }
        }
    }
    out.sort_by_key(|path| path.to_lowercase());
    out
}

/// `JSON.parse` of a text Windows PowerShell may have written with a byte order mark.
fn parse_json(text: &str) -> Option<Value> {
    serde_json::from_str(text.trim_start_matches('\u{feff}').trim()).ok()
}

fn images(value: &Value) -> Option<Vec<Image>> {
    let images: Vec<Image> = serde_json::from_value(value.clone()).ok()?;
    images
        .iter()
        .all(|image| nibble_of(&image.prior).is_some())
        .then_some(images)
}

/// `parseGitAslrRecord`: a missing or damaged record reads as empty.
pub fn parse_record(text: &str) -> Record {
    let Some(parsed) = parse_json(text) else {
        return Record::default();
    };
    let Some(roots) = parsed["roots"]
        .as_object()
        .filter(|_| parsed["version"].as_f64() == Some(1.0))
    else {
        return Record::default();
    };
    let mut out = Map::new();
    for (root, value) in roots {
        let Some(list) = images(value) else {
            return Record::default();
        };
        if !list.is_empty() {
            out.insert(root_key(root), json!(list));
        }
    }
    Record { roots: out }
}

/// `recordedImages`.
pub fn recorded_images(record: &Record, root: &str) -> Vec<Image> {
    record
        .roots
        .get(&root_key(root))
        .and_then(images)
        .unwrap_or_default()
}

/// `withFixed`: adds what a Fix changed; an image already recorded keeps its first prior state.
pub fn with_fixed(record: &Record, root: &str, changed: &[Image]) -> Record {
    let mut list = recorded_images(record, root);
    for image in changed {
        if !list
            .iter()
            .any(|known| known.path.to_lowercase() == image.path.to_lowercase())
        {
            list.push(image.clone());
        }
    }
    let mut roots = record.roots.clone();
    if list.is_empty() {
        roots.remove(&root_key(root));
    } else {
        roots.insert(root_key(root), json!(list));
    }
    Record { roots }
}

/// `withRestored`: drops what an Undo restored; a root with nothing left goes.
pub fn with_restored(record: &Record, root: &str, restored: &[String]) -> Record {
    let done: Vec<String> = restored.iter().map(|path| path.to_lowercase()).collect();
    let left: Vec<Image> = recorded_images(record, root)
        .into_iter()
        .filter(|image| !done.contains(&image.path.to_lowercase()))
        .collect();
    let mut roots = record.roots.clone();
    if left.is_empty() {
        roots.remove(&root_key(root));
    } else {
        roots.insert(root_key(root), json!(left));
    }
    Record { roots }
}

pub fn read_record(file: &str) -> Record {
    parse_record(&std::fs::read_to_string(file).unwrap_or_default())
}

/// `writeGitAslrRecord`: tab-indented, owner-only; removed when it holds nothing.
pub fn write_record(file: &str, record: &Record) -> std::io::Result<()> {
    if record.roots.is_empty() {
        return match std::fs::remove_file(file) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        };
    }
    let text = super::tabbed(&json!({"version": 1, "roots": record.roots}));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    std::io::Write::write_all(&mut options.open(file)?, format!("{text}\n").as_bytes())
}

/// `[value].flat()`: Windows PowerShell writes a one-element array as the element.
fn flat(text: &str) -> Vec<Value> {
    match parse_json(text) {
        Some(Value::Array(rows)) => rows,
        Some(value) => vec![value],
        None => Vec::new(),
    }
}

/// The elevated step's Fix output (`[{path, prior}]`, prior as the nibble); one bad row drops them all.
pub fn parse_fix_output(text: &str) -> Vec<Image> {
    let rows = flat(text);
    let valid = rows
        .iter()
        .all(|row| row["path"].is_string() && row["prior"].is_number());
    if !valid {
        return Vec::new();
    }
    rows.iter()
        .filter_map(|row| {
            let nibble = row["prior"].as_f64()?;
            let prior = (nibble.fract() == 0.0)
                .then(|| prior_of(nibble as i64))
                .flatten()?;
            Some(Image {
                path: row["path"].as_str()?.to_owned(),
                prior: prior.to_owned(),
            })
        })
        .collect()
}

/// The elevated step's Undo output: the restored paths.
pub fn parse_undo_output(text: &str) -> Vec<String> {
    let rows = flat(text);
    if !rows.iter().all(Value::is_string) {
        return Vec::new();
    }
    rows.iter()
        .filter_map(|row| row.as_str().map(str::to_owned))
        .collect()
}

/// Undo's input file: the recorded images with their prior nibble (`undoInput`).
pub fn undo_input(images: &[Image]) -> String {
    let rows: Vec<Value> = images
        .iter()
        .map(|image| json!({"path": image.path, "prior": nibble_of(&image.prior)}))
        .collect();
    Value::Array(rows).to_string()
}

const PS_HELPERS: [&str; 24] = [
    "$ifeo = 'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options'",
    "$hklm = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)",
    "function Find-Entry([string]$image, [bool]$writable) {",
    "\t$parent = $hklm.OpenSubKey($ifeo + '\\' + [System.IO.Path]::GetFileName($image), $writable)",
    "\tif (-not $parent) { return $null }",
    "\ttry {",
    "\t\tforeach ($name in $parent.GetSubKeyNames()) {",
    "\t\t\t$sub = $parent.OpenSubKey($name, $writable)",
    "\t\t\tif (-not $sub) { continue }",
    "\t\t\tif ([string]$sub.GetValue('FilterFullPath') -ieq $image) { return $sub }",
    "\t\t\t$sub.Dispose()",
    "\t\t}",
    "\t} finally { $parent.Dispose() }",
    "\treturn $null",
    "}",
    "function Test-UseFilter([string]$image) {",
    "\t$parent = $hklm.OpenSubKey($ifeo + '\\' + [System.IO.Path]::GetFileName($image), $false)",
    "\tif (-not $parent) { return $false }",
    "\ttry { $v = $parent.GetValue('UseFilter'); return ($null -ne $v -and [int]$v -ne 0) } finally { $parent.Dispose() }",
    "}",
    "function Get-Options($entry) { if (-not $entry) { return $null }; $o = $entry.GetValue('MitigationOptions'); if ($o -is [byte[]] -and $o.Length -ge 2) { return $o }; return $null }",
    "function Set-Relocate($entry, [byte[]]$options, [int]$value) {",
    "\t$options[1] = [byte](($options[1] -band 0xF0) -bor ($value -band 0x0F))",
    "\t$entry.SetValue('MitigationOptions', $options, [Microsoft.Win32.RegistryValueKind]::Binary)",
];

/// The script run elevated (`gitAslrElevatedScript`). Uses native 64-bit .NET RegistryKey APIs (no PowerShell
/// wildcard `-Path` globbing on names like `[.exe`), always enforces `UseFilter = 1`, edits only bits 8–11 of
/// `MitigationOptions`, and re-reads the registry to verify every write before recording it in `$done`.
pub fn elevated_script(root: &str, action: &str, input: &str, output: &str) -> String {
    let write = format!(
        "ConvertTo-Json -InputObject @($done) -Compress | Set-Content -LiteralPath {} -Encoding UTF8",
        ps_quote(output)
    );
    let body: Vec<String> = if action == "fix" {
        vec![
            format!(
                "$images = @(Get-ChildItem -LiteralPath {} -Recurse -File -Filter *.exe | ForEach-Object {{ $_.FullName }})",
                ps_quote(&join(true, &[root, "usr"]))
            ),
            "foreach ($image in $images) {".into(),
            "\t$entry = Find-Entry $image $true".into(),
            "\t$options = Get-Options $entry".into(),
            "\t$filtered = Test-UseFilter $image".into(),
            "\t$prior = if ($options -and $filtered) { $options[1] -band 0x0F } else { 0 }".into(),
            "\tif ($prior -eq 2) { if ($entry) { $entry.Dispose() }; continue }".into(),
            "\t$parent = $hklm.CreateSubKey($ifeo + '\\' + [System.IO.Path]::GetFileName($image))".into(),
            "\ttry {".into(),
            "\t\t$parent.SetValue('UseFilter', 1, [Microsoft.Win32.RegistryValueKind]::DWord)".into(),
            "\t\tif (-not $entry) {".into(),
            "\t\t\t$entry = $parent.CreateSubKey('{' + [guid]::NewGuid() + '}')".into(),
            "\t\t\t$entry.SetValue('FilterFullPath', $image, [Microsoft.Win32.RegistryValueKind]::String)".into(),
            "\t\t}".into(),
            "\t\tif (-not $options) { $options = New-Object byte[] 24 }".into(),
            "\t\tSet-Relocate $entry $options 2".into(),
            "\t} finally {".into(),
            "\t\tif ($entry) { $entry.Dispose() }".into(),
            "\t\t$parent.Dispose()".into(),
            "\t}".into(),
            "\t$check = Find-Entry $image $false".into(),
            "\t$verified = Get-Options $check".into(),
            "\tif ($check) { $check.Dispose() }".into(),
            "\tif (-not (Test-UseFilter $image) -or -not $verified -or (($verified[1] -band 0x0F) -ne 2)) { throw ('Failed to verify ForceRelocateImages override for ' + $image) }".into(),
            "\t$done += [pscustomobject]@{ path = $image; prior = $prior }".into(),
            format!("\t{write}"),
            "}".into(),
        ]
    } else {
        vec![
            // Windows PowerShell's ConvertFrom-Json emits a JSON array as one object; foreach enumerates it.
            format!(
                "foreach ($e in (Get-Content -LiteralPath {} -Raw -Encoding UTF8 | ConvertFrom-Json)) {{",
                ps_quote(input)
            ),
            "\t$p = [string]$e.path".into(),
            "\t$entry = Find-Entry $p $true".into(),
            "\t$changed = $false".into(),
            "\ttry {".into(),
            "\t\t$options = Get-Options $entry".into(),
            "\t\tif ($options -and ($options[1] -band 0x0F) -eq 2) { Set-Relocate $entry $options ([int]$e.prior); $changed = $true }".into(),
            "\t} finally { if ($entry) { $entry.Dispose() } }".into(),
            "\tif ($changed) {".into(),
            "\t\t$check = Find-Entry $p $false".into(),
            "\t\t$verified = Get-Options $check".into(),
            "\t\tif ($check) { $check.Dispose() }".into(),
            "\t\tif (-not $verified -or (($verified[1] -band 0x0F) -ne ([int]$e.prior))) { throw ('Failed to verify ForceRelocateImages restore for ' + $p) }".into(),
            "\t}".into(),
            "\t$done += $p".into(),
            format!("\t{write}"),
            "}".into(),
        ]
    };
    let mut all: Vec<String> = vec!["$ErrorActionPreference = 'Stop'".into()];
    all.extend(PS_HELPERS.iter().map(|line| (*line).to_owned()));
    all.push("}".into());
    all.push("$done = @()".into());
    all.push(write);
    all.extend(body);
    all.join("\n")
}

/// Elevates `elevated_script` (`gitAslrSpawn`); the outer script fails when it failed, a refused UAC prompt too.
pub fn spawn(system_root: &str, root: &str, action: &str, input: &str, output: &str) -> SpawnSpec {
    let inner = powershell_script(system_root, &elevated_script(root, action, input, output));
    let encoded = inner.args.last().cloned().unwrap_or_default();
    let outer = [
        "$ErrorActionPreference = 'Stop'".to_owned(),
        format!(
            "$proc = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', '{encoded}') -Verb RunAs -Wait -PassThru -WindowStyle Hidden"
        ),
        "if ($proc.ExitCode -ne 0) { throw ('The elevated step exited with ' + $proc.ExitCode) }".to_owned(),
    ]
    .join("\n");
    powershell_script(system_root, &outer)
}

fn reg_field(block: &str, name: &str, kind: &str) -> Option<String> {
    block.lines().find_map(|line| {
        let rest = line.trim_start().strip_prefix(name)?;
        if !rest.starts_with(char::is_whitespace) {
            return None;
        }
        let rest = rest.trim_start().strip_prefix(kind)?;
        if !rest.starts_with(char::is_whitespace) {
            return None;
        }
        let value = rest.trim();
        (!value.is_empty()).then(|| value.to_owned())
    })
}

fn reg_hex(block: &str, name: &str) -> Option<String> {
    reg_field(block, name, "REG_BINARY").map(|hex| {
        hex.chars()
            .take_while(char::is_ascii_hexdigit)
            .collect::<String>()
    })
}

fn reg_dword(block: &str, name: &str) -> Option<u32> {
    let raw = reg_field(block, name, "REG_DWORD")?;
    let token = raw.split_whitespace().next()?;
    if let Some(hex) = token
        .strip_prefix("0x")
        .or_else(|| token.strip_prefix("0X"))
    {
        u32::from_str_radix(hex, 16).ok()
    } else {
        token.parse::<u32>().ok()
    }
}

/// Whether `reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\kernel" /v MitigationOptions` reports
/// system-wide Mandatory ASLR (`ForceRelocateImages` ON = nibble 1 or 3).
pub fn system_mandatory_aslr(query: &str) -> bool {
    let normalized = query.replace("\r\n", "\n");
    for block in split_blocks(&normalized) {
        if let Some(hex) = reg_hex(block, "MitigationOptions") {
            return matches!(force_relocate_nibble_hex(&hex), Some(1 | 3));
        }
    }
    false
}

/// Parses `reg query <IFEO>[\<exe>] /s` output into [`IfeoState`], enforcing `UseFilter != 0` on parent keys for
/// path-filtered subkeys and recognizing direct basename overrides when `UseFilter` is absent or zero.
pub fn parse_ifeo(query: &str) -> IfeoState {
    const LONG: &str = r"hkey_local_machine\software\microsoft\windows nt\currentversion\image file execution options\";
    const SHORT: &str =
        r"hklm\software\microsoft\windows nt\currentversion\image file execution options\";

    let normalized = query.replace("\r\n", "\n");
    // exe_lower -> (use_filter_enabled, parent_direct_off)
    let mut parents: HashMap<String, (bool, bool)> = HashMap::new();
    // (exe_lower, normalized_full_path_lower)
    let mut filtered_children: Vec<(String, String)> = Vec::new();

    for block in split_blocks(&normalized) {
        let Some(header) = block.lines().map(str::trim).find(|line| !line.is_empty()) else {
            continue;
        };
        let lower = header.to_lowercase();
        let tail = lower
            .strip_prefix(LONG)
            .or_else(|| lower.strip_prefix(SHORT))
            .map(|rest| rest.trim_end_matches('\\'));
        let Some(tail) = tail.filter(|rest| !rest.is_empty()) else {
            continue;
        };
        let mut segments = tail.split('\\');
        let Some(exe) = segments.next().filter(|seg| !seg.is_empty()) else {
            continue;
        };
        match (segments.next(), segments.next()) {
            (None, _) => {
                let use_filter = reg_dword(block, "UseFilter").is_some_and(|v| v != 0);
                let direct_off = reg_hex(block, "MitigationOptions")
                    .and_then(|hex| force_relocate_nibble_hex(&hex))
                    == Some(2);
                parents.insert(exe.to_owned(), (use_filter, direct_off));
            }
            (Some(_subkey), None) => {
                let path = reg_field(block, "FilterFullPath", "REG_SZ");
                let off = reg_hex(block, "MitigationOptions")
                    .and_then(|hex| force_relocate_nibble_hex(&hex))
                    == Some(2);
                if let (Some(path), true) = (path, off) {
                    filtered_children.push((exe.to_owned(), image_key(&path)));
                }
            }
            _ => {}
        }
    }

    let mut state = IfeoState::default();
    for (exe, path) in filtered_children {
        if parents.get(&exe).is_some_and(|(use_filter, _)| *use_filter) {
            state.filtered_off.insert(path);
        }
    }
    for (exe, (use_filter, direct_off)) in parents {
        if !use_filter && direct_off {
            state.basename_off.insert(exe);
        }
    }
    state
}

/// Whether `reg query <IFEO>\sh.exe /s` output holds an active path-filtered override for `<root>\usr\bin\sh.exe`
/// with Force randomization always off (`gitAslrOverridden`).
pub fn overridden(query: &str, root: &str) -> bool {
    parse_ifeo(query).has_filtered_override(&join(true, &[root, "usr", "bin", "sh.exe"]))
}

/// Reads the live Windows kernel Mandatory ASLR setting and IFEO overrides for the exact basenames in `images`
/// directly from HKLM's 64-bit view (no elevation, ~2 ms, never touches unrelated IFEO keys).
#[cfg(windows)]
pub fn read_os_state(images: &[String]) -> OsState {
    let system_mandatory_aslr = crate::sys::win_reg::read_kernel_mitigation_options()
        .is_some_and(|opts| is_force_relocate_on(&opts));

    let mut seen = HashSet::new();
    let mut names = Vec::new();
    for image in images {
        let name = image_filename(image);
        let lower = name.to_lowercase();
        if !lower.is_empty() && seen.insert(lower) {
            names.push(name);
        }
    }

    let mut ifeo = IfeoState::default();
    for (name, key) in crate::sys::win_reg::read_ifeo_keys(&names) {
        if key.use_filter {
            for (path, opts) in key.filtered {
                if is_force_relocate_off(&opts) {
                    ifeo.filtered_off.insert(image_key(&path));
                }
            }
        } else if key
            .direct_options
            .is_some_and(|opts| is_force_relocate_off(&opts))
        {
            ifeo.basename_off.insert(name.to_lowercase());
        }
    }

    OsState {
        system_mandatory_aslr,
        ifeo,
    }
}

#[cfg(not(windows))]
pub fn read_os_state(_images: &[String]) -> OsState {
    OsState::default()
}

/// `query.split(/\r?\n\s*\r?\n/)` over a text whose line ends are `\n`.
fn split_blocks(text: &str) -> Vec<&str> {
    let mut blocks = Vec::new();
    let mut start = 0;
    let bytes = text.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'\n' {
            let mut next = at + 1;
            while next < bytes.len()
                && bytes[next] != b'\n'
                && (bytes[next] as char).is_whitespace()
            {
                next += 1;
            }
            if next < bytes.len() && bytes[next] == b'\n' {
                blocks.push(&text[start..at]);
                start = next + 1;
                at = next + 1;
                continue;
            }
        }
        at += 1;
    }
    blocks.push(&text[start..]);
    blocks
}
