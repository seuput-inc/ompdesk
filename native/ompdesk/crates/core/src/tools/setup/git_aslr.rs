//! The Git item's Mandatory ASLR override (was `src/main/setup/git-aslr.ts`): Windows' Mandatory ASLR kills every MSYS
//! fork with 0xC0000142, so Git for Windows' sh cannot start a child. The fix the person may choose is a per-image
//! override, Force randomization always off, for exactly the MSYS executables under `<git>\usr`, in one elevated step
//! that edits only bits 8–11 of each image's `MitigationOptions` (never `Set-ProcessMitigation`, which rewrites the
//! whole entry). Fix records each image it changed with its prior state in `<userData>/git-aslr.json`; Undo puts back
//! only those, and only while they still say off. Without a record there is nothing to undo exactly.

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
    roots.insert(root_key(root), json!(list));
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

const PS_HELPERS: [&str; 12] = [
    "$ifeo = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options'",
    "function Find-Entry([string]$image) {",
    "\t$key = Join-Path $ifeo ([System.IO.Path]::GetFileName($image))",
    "\tif (-not (Test-Path -LiteralPath $key)) { return $null }",
    "\tforeach ($sub in @(Get-ChildItem -LiteralPath $key)) { if ([string]$sub.GetValue('FilterFullPath') -ieq $image) { return $sub } }",
    "\treturn $null",
    "}",
    "function Get-Options($entry) { if (-not $entry) { return $null }; $o = $entry.GetValue('MitigationOptions'); if ($o -is [byte[]] -and $o.Length -ge 2) { return $o }; return $null }",
    "function Set-Relocate($entry, [byte[]]$options, [int]$value) {",
    "\t$options[1] = [byte](($options[1] -band 0xF0) -bor ($value -band 0x0F))",
    "\t[Microsoft.Win32.Registry]::SetValue($entry.Name, 'MitigationOptions', $options, [Microsoft.Win32.RegistryValueKind]::Binary)",
    "}",
];

/// The script run elevated (`gitAslrElevatedScript`).
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
            "\t$entry = Find-Entry $image".into(),
            "\t$options = Get-Options $entry".into(),
            "\t$prior = if ($options) { $options[1] -band 0x0F } else { 0 }".into(),
            "\tif ($prior -eq 2) { continue }".into(),
            "\tif (-not $entry) {".into(),
            "\t\t$parent = Join-Path $ifeo ([System.IO.Path]::GetFileName($image))".into(),
            "\t\tif (-not (Test-Path -LiteralPath $parent)) { $null = New-Item -Path $parent -Force }".into(),
            "\t\tSet-ItemProperty -LiteralPath $parent -Name UseFilter -Value 1 -Type DWord".into(),
            "\t\t$entry = New-Item -Path (Join-Path $parent ('{' + [guid]::NewGuid() + '}'))".into(),
            "\t\tSet-ItemProperty -LiteralPath $entry.PSPath -Name FilterFullPath -Value $image".into(),
            "\t}".into(),
            "\tif (-not $options) { $options = New-Object byte[] 24 }".into(),
            "\tSet-Relocate $entry $options 2".into(),
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
            "\t$entry = Find-Entry ([string]$e.path)".into(),
            "\t$options = Get-Options $entry".into(),
            "\tif ($options -and ($options[1] -band 0x0F) -eq 2) { Set-Relocate $entry $options ([int]$e.prior) }".into(),
            "\t$done += [string]$e.path".into(),
            format!("\t{write}"),
            "}".into(),
        ]
    };
    let mut all: Vec<String> = vec!["$ErrorActionPreference = 'Stop'".into()];
    all.extend(PS_HELPERS.iter().map(|line| (*line).to_owned()));
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

/// Whether `reg query <IFEO>\sh.exe /s` output holds an override for `<root>\usr\bin\sh.exe` with Force randomization
/// always off (`gitAslrOverridden`).
pub fn overridden(query: &str, root: &str) -> bool {
    let target = join(true, &[root, "usr", "bin", "sh.exe"]).to_lowercase();
    let normalized = query.replace("\r\n", "\n");
    for block in split_blocks(&normalized) {
        let field = |name: &str, kind: &str| {
            block.lines().find_map(|line| {
                let rest = line.trim_start().strip_prefix(name)?;
                let rest = rest.trim_start().strip_prefix(kind)?;
                Some(rest.trim().to_owned()).filter(|value| !value.is_empty())
            })
        };
        let path = field("FilterFullPath", "REG_SZ").map(|path| path.to_lowercase());
        let options = field("MitigationOptions", "REG_BINARY").map(|hex| {
            hex.chars()
                .take_while(char::is_ascii_hexdigit)
                .collect::<String>()
        });
        let (Some(path), Some(options)) = (path, options) else {
            continue;
        };
        if path != target || options.is_empty() {
            continue;
        }
        let digits = &options[2.min(options.len())..4.min(options.len())];
        let byte = u8::from_str_radix(digits, 16).unwrap_or(0);
        return byte & 0xf == 2;
    }
    false
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
