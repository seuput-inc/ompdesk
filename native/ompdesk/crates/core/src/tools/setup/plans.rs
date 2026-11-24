//! Install plans (was `src/main/setup/plans.ts`): for each setup item, the one way this machine installs it and the
//! exact process that runs. Everything here is fixed by the core; the renderer can name an item, never a command.

use std::sync::LazyLock;

use base64::Engine;
use serde::Serialize;
use serde_json::Value;

use super::Presence;
use super::paths::{dirname, host_join, join, managed_agent_desktop_dir, managed_git_root};
use crate::fs::path::normalize_win32;
use crate::tools::runner::SpawnSpec;
use crate::tools::spawn::{InstallContext, PlanTools, npm_for, read_install, spawn_spec};

pub const OMP_PACKAGE: &str = "@oh-my-pi/pi-coding-agent";

/// The omp this OMPdesk release was verified against (`src/shared/omp-tested.json`, `TESTED_OMP_VERSION`).
pub static TESTED_OMP_VERSION: LazyLock<String> = LazyLock::new(|| {
    let tested: Value = serde_json::from_str(include_str!(
        "../../../../../../../src/shared/omp-tested.json"
    ))
    .expect("omp-tested.json is JSON");
    tested["version"]
        .as_str()
        .expect("omp-tested.json names a version")
        .to_owned()
});

/// The natives packages stock's own update installs beside the agent (`OMP_NATIVES`).
fn is_natives(name: &str) -> bool {
    name.strip_prefix("@oh-my-pi/pi-natives")
        .is_some_and(|rest| {
            rest.is_empty()
                || rest.strip_prefix('-').is_some_and(|leaf| {
                    !leaf.is_empty()
                        && leaf
                            .bytes()
                            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                })
        })
}

/// What a package install of omp `version` names under Bun root `root` (`ompInstallSpecs`): the omp package and every
/// natives package that root's global manifest pins, all at that one version.
pub fn omp_install_specs(root: &str, version: &str) -> Vec<String> {
    let manifest = std::fs::read_to_string(host_join(&[root, "install", "global", "package.json"]))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    let natives = manifest
        .as_ref()
        .and_then(|manifest| manifest.get("dependencies"))
        .and_then(Value::as_object)
        .map(|pinned| {
            pinned
                .keys()
                .filter(|name| is_natives(name))
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    std::iter::once(OMP_PACKAGE.to_owned())
        .chain(natives)
        .map(|name| format!("{name}@{version}"))
        .collect()
}

/// An npm global install of omp (`OmpNpmOwner`).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct OmpNpm {
    pub npm: String,
    pub prefix: String,
}

/// The npm install that owns the omp launcher `bin` (`ompNpmOwner`), or none for any other omp.
pub async fn omp_npm_owner(
    bin: &str,
    platform: &str,
    tools_dir: &str,
    path_env: &str,
) -> Option<OmpNpm> {
    if platform == "other" {
        return None;
    }
    let facts = read_install(
        bin,
        &InstallContext {
            platform: platform.to_owned(),
            tools_dir: tools_dir.to_owned(),
            brew: None,
        },
        serde_json::json!({"kind": "omp"}),
    )
    .await
    .ok()?;
    let owner = &facts["owner"];
    if owner["method"] != "npm" || owner["name"] != OMP_PACKAGE {
        return None;
    }
    let prefix = owner["prefix"].as_str()?;
    if platform == "win32" {
        let launcher = facts["launcher"].as_str().unwrap_or_default();
        let shim_dir = normalize_win32(&dirname(true, launcher)).to_lowercase();
        if shim_dir != normalize_win32(prefix).to_lowercase() {
            return None;
        }
    }
    let tools = PlanTools {
        platform: platform.to_owned(),
        path_env: path_env.to_owned(),
    };
    let npm = npm_for(prefix, &tools)?;
    Some(OmpNpm {
        npm,
        prefix: prefix.to_owned(),
    })
}

struct Pin {
    url: &'static str,
    sha256: &'static str,
}

/// Git for Windows' PortableGit, pinned with the SHA-256 its release notes publish (`PORTABLE_GIT`).
pub const PORTABLE_GIT_VERSION: &str = "2.56.0.2";
const PORTABLE_GIT_X64: Pin = Pin {
    url: "https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.2/PortableGit-2.56.0.2-64-bit.7z.exe",
    sha256: "075e158ef8e1f0ab80b347e245405d3eca735c2dc88fd8e032e137d0ca61f61b",
};
const PORTABLE_GIT_ARM64: Pin = Pin {
    url: "https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.2/PortableGit-2.56.0.2-arm64.7z.exe",
    sha256: "0f21e681bd33e006e0348dfa1a2be6769efd77e3bfdb247320314facde23a46c",
};

/// `WINGET_IDS`.
fn winget_id(item: &str) -> Option<&'static str> {
    Some(match item {
        "git" => "Git.Git",
        "gh" => "GitHub.cli",
        "node" => "OpenJS.NodeJS.LTS",
        "tailscale" => "Tailscale.Tailscale",
        _ => return None,
    })
}

/// A downloaded release for an `archive` or `agent-desktop-archive` install (`ArchiveRelease`).
#[derive(Clone, Debug)]
pub struct Release {
    pub item: String,
    pub version: String,
    pub file: String,
    pub url: String,
    pub sha256: String,
}

pub const TAILSCALE_MAC_APP: &str = "/Applications/Tailscale.app";
pub const TAILSCALE_WINDOWS_DIR: &str = "C:\\Program Files\\Tailscale";
const TAILSCALE_TEAM_ID: &str = "W5364U7YZB";
const TAILSCALE_MAC_BUNDLE_IDS: &str = "io.tailscale.ipn.macsys|io.tailscale.ipn.macos";
const TAILSCALE_SIGNER: &str = "Tailscale Inc.";

/// The index's name for this machine's MSI (`tailscaleMsiArch`).
pub fn tailscale_msi_arch(arch: &str) -> Option<&'static str> {
    match arch {
        "x64" => Some("amd64"),
        "arm64" => Some("arm64"),
        "ia32" => Some("x86"),
        _ => None,
    }
}

/// `PlanContext`.
#[derive(Clone, Debug)]
pub struct PlanContext {
    pub platform: String,
    pub arch: String,
    pub bun_install: String,
    pub tools_dir: String,
    pub bun: Option<String>,
    pub omp: Option<String>,
    pub omp_specs: Vec<String>,
    pub omp_npm: Option<OmpNpm>,
    pub omp_version: String,
    pub brew: Option<String>,
    pub winget: Option<String>,
    pub system_root: String,
}

impl PlanContext {
    fn win(&self) -> bool {
        self.platform == "win32"
    }
}

/// A file the core downloads and checks before the plan's process runs (`PlanDownload`).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PlanDownload {
    pub url: String,
    pub sha256: String,
    pub file: String,
}

/// `InstallPlan`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct InstallPlan {
    pub item: String,
    pub method: &'static str,
    pub spawn: SpawnSpec,
    pub command: String,
    pub location: String,
    pub prompt: Option<&'static str>,
    pub download: Option<PlanDownload>,
}

/// How `item` installs here, or none when nothing can install it automatically (`selectMethod`).
pub fn select_method(item: &str, presence: &Presence, ctx: &PlanContext) -> Option<&'static str> {
    if matches!(presence, Presence::Present { .. }) || ctx.platform == "other" {
        return None;
    }
    let mac = ctx.platform == "darwin";
    match item {
        "bun" => Some(
            if matches!(presence, Presence::Outdated { .. }) && ctx.bun.is_some() {
                "bun-upgrade"
            } else {
                "bun-script"
            },
        ),
        "omp" => Some(if ctx.omp_npm.is_some() {
            "npm-global"
        } else {
            "bun-global"
        }),
        "git" => Some(if mac { "xcode-select" } else { "portable-git" }),
        "gh" | "node" if mac => Some(if ctx.brew.is_some() {
            "brew"
        } else {
            "archive"
        }),
        "gh" | "node" => ctx.winget.as_ref().map(|_| "winget"),
        "agent-desktop" => {
            (ctx.arch == "arm64" || ctx.arch == "x64").then_some("agent-desktop-archive")
        }
        "tailscale" if mac => Some("tailscale-zip"),
        "tailscale" if ctx.winget.is_some() => Some("winget"),
        "tailscale" => tailscale_msi_arch(&ctx.arch).map(|_| "tailscale-msi"),
        _ => None,
    }
}

/// POSIX single-quoted shell word (`shQuote`).
pub fn sh_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// PowerShell single-quoted string (`psQuote`).
pub fn ps_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// `-EncodedCommand` (UTF-16LE base64): the script reaches Windows PowerShell without any command-line quoting
/// (`powershellScript`).
pub fn powershell_script(system_root: &str, script: &str) -> SpawnSpec {
    let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    SpawnSpec {
        file: join(
            true,
            &[
                system_root,
                "System32",
                "WindowsPowerShell",
                "v1.0",
                "powershell.exe",
            ],
        ),
        args: [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
        ]
        .into_iter()
        .map(str::to_owned)
        .chain([base64::engine::general_purpose::STANDARD.encode(utf16)])
        .collect(),
        shell: false,
        input_file: None,
    }
}

fn bash(script: &str) -> SpawnSpec {
    SpawnSpec {
        file: "/bin/bash".to_owned(),
        args: vec!["-c".to_owned(), script.to_owned()],
        shell: false,
        input_file: None,
    }
}

fn plain(file: &str, args: &[&str]) -> SpawnSpec {
    SpawnSpec {
        file: file.to_owned(),
        args: args.iter().map(|arg| (*arg).to_owned()).collect(),
        shell: false,
        input_file: None,
    }
}

/// First line of a script whose input the core downloaded (`downloadedLine`).
fn downloaded_line(download: &PlanDownload) -> String {
    format!(
        "# OMPdesk downloaded {} (SHA-256 {}) to {}",
        download.url, download.sha256, download.file
    )
}

fn lines(lines: &[String]) -> String {
    lines.join("\n")
}

/// `portableGitScript`.
pub fn portable_git_script(dest: &str, download: &PlanDownload) -> String {
    lines(&[
        downloaded_line(download),
        "$ErrorActionPreference = 'Stop'".into(),
        format!("$dest = {}", ps_quote(dest)),
        format!("$file = {}", ps_quote(&download.file)),
        "$part = $dest + '.partial'".into(),
        "$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant()".into(),
        format!(
            "if ($hash -ne {}) {{ throw ('SHA-256 mismatch: expected {}, got ' + $hash) }}",
            ps_quote(&download.sha256),
            download.sha256
        ),
        "Write-Output 'SHA-256 verified'".into(),
        "if (Test-Path -LiteralPath $part) { Remove-Item -Recurse -Force -LiteralPath $part }".into(),
        "$proc = Start-Process -FilePath $file -ArgumentList @('-y', ('-o\"' + $part + '\"')) -Wait -PassThru -WindowStyle Hidden".into(),
        "if ($proc.ExitCode -ne 0) { throw ('PortableGit extraction exited with ' + $proc.ExitCode) }".into(),
        "if (-not (Test-Path -LiteralPath (Join-Path $part 'bin\\bash.exe'))) { throw 'bash.exe is missing after extraction' }".into(),
        "if (Test-Path -LiteralPath $dest) { Remove-Item -Recurse -Force -LiteralPath $dest }".into(),
        "Move-Item -LiteralPath $part -Destination $dest".into(),
        format!(
            "Write-Output ('Git for Windows ' + {} + ' is in ' + $dest)",
            ps_quote(PORTABLE_GIT_VERSION)
        ),
    ])
}

/// `archiveScript`: check the SHA-256 of the release the core downloaded and unpack it into `<tools>/<item>`.
pub fn archive_script(
    release: &Release,
    win: bool,
    tools_dir: &str,
    download: &PlanDownload,
) -> String {
    let dest = join(win, &[tools_dir, &release.item]);
    let archive = sh_quote(&download.file);
    let unpack = if release.item == "node" {
        format!("tar -xzf {archive} -C \"$tmp/x\" --strip-components 1")
    } else {
        format!("ditto -x -k {archive} \"$tmp/zip\" && mv \"$tmp\"/zip/*/* \"$tmp/x/\"")
    };
    lines(&[
        downloaded_line(download),
        "set -euo pipefail".into(),
        format!(
            "echo {} | shasum -a 256 -c -",
            sh_quote(&format!("{}  {}", download.sha256, download.file))
        ),
        "tmp=\"$(mktemp -d)\"".into(),
        "trap 'rm -rf \"$tmp\"' EXIT".into(),
        "mkdir -p \"$tmp/x\" \"$tmp/zip\"".into(),
        unpack,
        format!("mkdir -p {}", sh_quote(tools_dir)),
        format!("rm -rf {}", sh_quote(&dest)),
        format!("mv \"$tmp/x\" {}", sh_quote(&dest)),
        format!(
            "echo {}",
            sh_quote(&format!(
                "{} {} is in {dest}",
                release.item, release.version
            ))
        ),
    ])
}

/// `agentDesktopArchiveScript` (bash, macOS).
pub fn agent_desktop_archive_script(
    release: &Release,
    win: bool,
    tools_dir: &str,
    download: &PlanDownload,
) -> String {
    let dest = managed_agent_desktop_dir(win, tools_dir);
    let archive = sh_quote(&download.file);
    lines(&[
        downloaded_line(download),
        "set -euo pipefail".into(),
        format!(
            "echo {} | shasum -a 256 -c -",
            sh_quote(&format!("{}  {}", download.sha256, download.file))
        ),
        format!("listing=\"$(tar -tzf {archive} | LC_ALL=C sort | paste -sd' ' -)\""),
        "[ \"$listing\" = 'agent-desktop agent-desktop-macos-helper' ] || { echo \"Unexpected archive contents: $listing\"; exit 1; }".into(),
        format!("mkdir -p {}", sh_quote(tools_dir)),
        format!(
            "tmp=\"$(mktemp -d {}XXXXXX)\"",
            sh_quote(&join(win, &[tools_dir, ".agent-desktop."]))
        ),
        "trap 'rm -rf \"$tmp\"' EXIT".into(),
        "mkdir \"$tmp/new\"".into(),
        format!("tar -xzf {archive} -C \"$tmp/new\""),
        "for name in agent-desktop agent-desktop-macos-helper; do".into(),
        "\tif [ ! -f \"$tmp/new/$name\" ] || [ -L \"$tmp/new/$name\" ]; then echo \"$name is not a regular file\"; exit 1; fi".into(),
        "\tchmod 755 \"$tmp/new/$name\"".into(),
        "done".into(),
        "chmod 755 \"$tmp/new\"".into(),
        format!("want={}", sh_quote(&format!("agent-desktop {}", release.version))),
        "[ \"$(\"$tmp/new/agent-desktop\" --version)\" = \"$want\" ] || { echo \"The downloaded agent-desktop does not print $want\"; exit 1; }".into(),
        format!("dest={}", sh_quote(&dest)),
        "if [ -e \"$dest\" ]; then mv \"$dest\" \"$tmp/old\"; fi".into(),
        "mv \"$tmp/new\" \"$dest\" || { [ ! -e \"$tmp/old\" ] || mv \"$tmp/old\" \"$dest\"; exit 1; }".into(),
        "if [ \"$(\"$dest/agent-desktop\" --version)\" != \"$want\" ]; then".into(),
        "\trm -rf \"$dest\"".into(),
        "\t[ ! -e \"$tmp/old\" ] || mv \"$tmp/old\" \"$dest\"".into(),
        "\techo \"agent-desktop in $dest does not print $want\"".into(),
        "\texit 1".into(),
        "fi".into(),
        "echo \"$want is in $dest\"".into(),
    ])
}

/// `agentDesktopWindowsScript` (PowerShell, `tar.exe` from System32).
pub fn agent_desktop_windows_script(
    release: &Release,
    tools_dir: &str,
    download: &PlanDownload,
) -> String {
    lines(&[
        downloaded_line(download),
        "$ErrorActionPreference = 'Stop'".into(),
        format!("$dest = {}", ps_quote(&managed_agent_desktop_dir(true, tools_dir))),
        "$exe = Join-Path $dest 'agent-desktop.exe'".into(),
        format!("$file = {}", ps_quote(&download.file)),
        "$part = $dest + '.partial'".into(),
        "$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant()".into(),
        format!(
            "if ($hash -ne {}) {{ throw ('SHA-256 mismatch: expected {}, got ' + $hash) }}",
            ps_quote(&download.sha256),
            download.sha256
        ),
        "Write-Output 'SHA-256 verified'".into(),
        "$tar = Join-Path $env:SystemRoot 'System32\\tar.exe'".into(),
        "$listing = (& $tar -tzf $file | Sort-Object) -join ' '".into(),
        "if ($LASTEXITCODE -ne 0) { throw ('tar.exe could not list the archive (exit ' + $LASTEXITCODE + ')') }".into(),
        "if ($listing -ne 'agent-desktop.exe') { throw ('Unexpected archive contents: ' + $listing) }".into(),
        "if (Test-Path -LiteralPath $part) { Remove-Item -Recurse -Force -LiteralPath $part }".into(),
        "New-Item -ItemType Directory -Force -Path $part | Out-Null".into(),
        "& $tar -xzf $file -C $part".into(),
        "if ($LASTEXITCODE -ne 0) { throw ('tar.exe could not extract the archive (exit ' + $LASTEXITCODE + ')') }".into(),
        "$new = Join-Path $part 'agent-desktop.exe'".into(),
        "if (-not (Test-Path -LiteralPath $new -PathType Leaf)) { throw 'agent-desktop.exe is missing after extraction' }".into(),
        "New-Item -ItemType Directory -Force -Path $dest | Out-Null".into(),
        "Get-ChildItem -Path ($exe + '.ompdesk-*') -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue".into(),
        "$aside = $null".into(),
        "if (Test-Path -LiteralPath $exe) {".into(),
        "\t$aside = $exe + '.ompdesk-' + [DateTime]::UtcNow.Ticks".into(),
        "\tMove-Item -LiteralPath $exe -Destination $aside".into(),
        "}".into(),
        "try { Move-Item -LiteralPath $new -Destination $exe } catch {".into(),
        "\tif ($aside -and -not (Test-Path -LiteralPath $exe)) { Move-Item -LiteralPath $aside -Destination $exe }".into(),
        "\tthrow".into(),
        "}".into(),
        format!("$want = {}", ps_quote(&format!("agent-desktop {}", release.version))),
        "$version = (& $exe --version | Out-String).Trim()".into(),
        "if ($LASTEXITCODE -ne 0 -or $version -ne $want) {".into(),
        "\tRemove-Item -LiteralPath $exe -Force -ErrorAction SilentlyContinue".into(),
        "\tif ($aside) { Move-Item -LiteralPath $aside -Destination $exe }".into(),
        "\tthrow ('The downloaded agent-desktop.exe does not print ' + $want)".into(),
        "}".into(),
        "if ($aside) { Remove-Item -LiteralPath $aside -Force -ErrorAction SilentlyContinue }".into(),
        "Remove-Item -Recurse -Force -LiteralPath $part -ErrorAction SilentlyContinue".into(),
        "Write-Output ($want + ' is in ' + $exe)".into(),
    ])
}

/// `tailscaleZipScript`: the zip checked again, its signature, bundle id and team, before it is copied.
pub fn tailscale_zip_script(release: &Release, download: &PlanDownload) -> String {
    lines(&[
        downloaded_line(download),
        "set -euo pipefail".into(),
        format!(
            "echo {} | shasum -a 256 -c -",
            sh_quote(&format!("{}  {}", download.sha256, download.file))
        ),
        "tmp=\"$(mktemp -d)\"".into(),
        "trap 'rm -rf \"$tmp\"' EXIT".into(),
        format!("ditto -x -k {} \"$tmp\"", sh_quote(&download.file)),
        "app=\"$tmp/Tailscale.app\"".into(),
        "test -d \"$app\" || { echo \"Tailscale.app is missing from the download\"; exit 1; }".into(),
        "codesign --verify --deep --strict \"$app\"".into(),
        "id=\"$(/usr/libexec/PlistBuddy -c \"Print :CFBundleIdentifier\" \"$app/Contents/Info.plist\")\"".into(),
        format!(
            "case \"$id\" in {TAILSCALE_MAC_BUNDLE_IDS}) ;; *) echo \"Unexpected bundle id $id\"; exit 1;; esac"
        ),
        "team=\"$(codesign -dv \"$app\" 2>&1 | sed -n 's/^TeamIdentifier=//p')\"".into(),
        format!(
            "[ \"$team\" = {TAILSCALE_TEAM_ID} ] || {{ echo \"Unexpected signing team $team\"; exit 1; }}"
        ),
        format!("rm -rf {}", sh_quote(TAILSCALE_MAC_APP)),
        format!("ditto \"$app\" {}", sh_quote(TAILSCALE_MAC_APP)),
        format!(
            "echo {}",
            sh_quote(&format!("Tailscale {} is in {TAILSCALE_MAC_APP}", release.version))
        ),
    ])
}

/// `tailscaleMsiScript`: the MSI's hash and a Valid Tailscale Inc. signature, then an elevated msiexec.
pub fn tailscale_msi_script(download: &PlanDownload) -> String {
    lines(&[
        downloaded_line(download),
        "$ErrorActionPreference = 'Stop'".into(),
        format!("$file = {}", ps_quote(&download.file)),
        "$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant()".into(),
        format!(
            "if ($hash -ne {}) {{ throw ('SHA-256 mismatch: expected {}, got ' + $hash) }}",
            ps_quote(&download.sha256),
            download.sha256
        ),
        "Write-Output 'SHA-256 verified'".into(),
        "$sig = Get-AuthenticodeSignature -LiteralPath $file".into(),
        "if ($sig.Status -ne 'Valid') { throw ('Signature is ' + $sig.Status) }".into(),
        format!(
            "if ($sig.SignerCertificate.Subject -notlike {}) {{ throw ('Signed by ' + $sig.SignerCertificate.Subject) }}",
            ps_quote(&format!("*CN={TAILSCALE_SIGNER}*"))
        ),
        "Write-Output 'Signature verified'".into(),
        "$proc = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', ('\"' + $file + '\"'), '/qn') -Verb RunAs -Wait -PassThru".into(),
        // 3010: installed, a restart is pending.
        "if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 3010) { throw ('msiexec exited with ' + $proc.ExitCode) }".into(),
        "Write-Output 'Tailscale is installed'".into(),
    ])
}

/// `bunInstallScript`: Bun's official Windows installer over any bun.exe, failing when no Bun answers.
pub fn bun_install_script(bun_install: &str) -> String {
    lines(&[
        "$ErrorActionPreference = 'Stop'".into(),
        format!("$exe = Join-Path {} 'bin\\bun.exe'", ps_quote(bun_install)),
        "Get-ChildItem -Path ($exe + '.ompdesk-*') -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue".into(),
        "$aside = $null".into(),
        "if (Test-Path -LiteralPath $exe) {".into(),
        "\t$aside = $exe + '.ompdesk-' + [DateTime]::UtcNow.Ticks".into(),
        "\ttry { Move-Item -LiteralPath $exe -Destination $aside } catch { $aside = $null; Write-Output ('Could not move the old bun.exe aside: ' + $_) }".into(),
        "}".into(),
        "$failure = $null".into(),
        "try { Invoke-RestMethod -Uri 'https://bun.sh/install.ps1' | Invoke-Expression } catch { $failure = $_ }".into(),
        "$version = $null".into(),
        "if (Test-Path -LiteralPath $exe) { $version = & $exe --version; if ($LASTEXITCODE -ne 0) { $version = $null } }".into(),
        "if (-not $version) {".into(),
        "\tif ($aside -and -not (Test-Path -LiteralPath $exe)) { Move-Item -LiteralPath $aside -Destination $exe }".into(),
        "\tif ($failure) { Write-Output $failure }".into(),
        "\tthrow 'Bun was not installed: bun.exe does not answer --version'".into(),
        "}".into(),
        "if ($aside) { Remove-Item -LiteralPath $aside -Force -ErrorAction SilentlyContinue }".into(),
        "Write-Output ('Bun ' + $version + ' is in ' + $exe)".into(),
    ])
}

fn plan(
    item: &str,
    method: &'static str,
    spawn: SpawnSpec,
    command: String,
    location: String,
    prompt: Option<&'static str>,
    download: Option<PlanDownload>,
) -> Option<InstallPlan> {
    Some(InstallPlan {
        item: item.to_owned(),
        method,
        spawn,
        command,
        location,
        prompt,
        download,
    })
}

/// The plan for `method` (`buildPlan`): `release` for the archives, `tailscale` for Tailscale's own packages. None
/// when it cannot run (omp without Bun, a method this context lacks the tool for).
pub fn build_plan(
    item: &str,
    method: &'static str,
    ctx: &PlanContext,
    release: Option<&Release>,
    tailscale: Option<&Release>,
) -> Option<InstallPlan> {
    let win = ctx.win();
    let target = if win { "win32" } else { "darwin" };
    let download_of = |release: &Release| PlanDownload {
        url: release.url.clone(),
        sha256: release.sha256.clone(),
        file: join(win, &[&ctx.tools_dir, ".downloads", &release.file]),
    };
    match method {
        "bun-script" if win => {
            let script = bun_install_script(&ctx.bun_install);
            plan(
                item,
                method,
                powershell_script(&ctx.system_root, &script),
                script,
                ctx.bun_install.clone(),
                None,
                None,
            )
        }
        "bun-script" => plan(
            item,
            method,
            plain(
                "/bin/bash",
                &[
                    "-c",
                    "set -o pipefail; curl -fsSL https://bun.sh/install | bash",
                ],
            ),
            "curl -fsSL https://bun.sh/install | bash".into(),
            ctx.bun_install.clone(),
            None,
            None,
        ),
        "bun-upgrade" => {
            let bun = ctx.bun.as_deref()?;
            plan(
                item,
                method,
                plain(bun, &["upgrade"]),
                format!("\"{bun}\" upgrade"),
                bun.to_owned(),
                None,
                None,
            )
        }
        "bun-global" => {
            let bun = ctx.bun.as_deref()?;
            let mut args = vec!["install".to_owned(), "-g".to_owned()];
            args.extend(ctx.omp_specs.iter().cloned());
            plan(
                item,
                method,
                SpawnSpec {
                    file: bun.to_owned(),
                    args,
                    shell: false,
                    input_file: None,
                },
                format!("\"{bun}\" install -g {}", ctx.omp_specs.join(" ")),
                join(
                    win,
                    &[
                        &ctx.bun_install,
                        "install",
                        "global",
                        "node_modules",
                        "@oh-my-pi",
                        "pi-coding-agent",
                    ],
                ),
                None,
                None,
            )
        }
        "npm-global" => {
            let OmpNpm { npm, prefix } = ctx.omp_npm.as_ref()?;
            let spec = format!("{OMP_PACKAGE}@{}", ctx.omp_version);
            let args = ["install", "-g", "--prefix", prefix, &spec].map(str::to_owned);
            let location = if win {
                join(
                    true,
                    &[prefix, "node_modules", "@oh-my-pi", "pi-coding-agent"],
                )
            } else {
                join(
                    false,
                    &[
                        prefix,
                        "lib",
                        "node_modules",
                        "@oh-my-pi",
                        "pi-coding-agent",
                    ],
                )
            };
            plan(
                item,
                method,
                spawn_spec(npm, &args, target),
                format!("\"{npm}\" install -g --prefix \"{prefix}\" {spec}"),
                location,
                None,
                None,
            )
        }
        "omp-update" => {
            let omp = ctx.omp.as_deref()?;
            plan(
                item,
                method,
                spawn_spec(omp, &["update".to_owned()], target),
                format!("\"{omp}\" update"),
                omp.to_owned(),
                None,
                None,
            )
        }
        "portable-git" => {
            let dest = managed_git_root(win, &ctx.tools_dir);
            let pin = if ctx.arch == "arm64" {
                PORTABLE_GIT_ARM64
            } else {
                PORTABLE_GIT_X64
            };
            let name = pin.url.rsplit('/').next().unwrap_or_default();
            let download = PlanDownload {
                url: pin.url.to_owned(),
                sha256: pin.sha256.to_owned(),
                file: join(win, &[&ctx.tools_dir, ".downloads", name]),
            };
            let script = portable_git_script(&dest, &download);
            plan(
                item,
                method,
                powershell_script(&ctx.system_root, &script),
                script,
                dest,
                None,
                Some(download),
            )
        }
        "xcode-select" => plan(
            item,
            method,
            plain("/usr/bin/xcode-select", &["--install"]),
            "xcode-select --install".into(),
            "/Library/Developer/CommandLineTools".into(),
            Some("dialog"),
            None,
        ),
        "brew" => {
            let brew = ctx.brew.as_deref()?;
            let formula = if item == "gh" { "gh" } else { "node" };
            plan(
                item,
                method,
                plain(brew, &["install", formula]),
                format!("\"{brew}\" install {formula}"),
                join(win, &[brew, "..", ".."]),
                None,
                None,
            )
        }
        "winget" => {
            let winget = ctx.winget.as_deref()?;
            let id = winget_id(item)?;
            let args: &[&str] = if item == "tailscale" {
                &[
                    "install",
                    "--id",
                    id,
                    "-e",
                    "--silent",
                    "--accept-package-agreements",
                    "--accept-source-agreements",
                ]
            } else {
                &[
                    "install",
                    "--id",
                    id,
                    "-e",
                    "--accept-source-agreements",
                    "--accept-package-agreements",
                ]
            };
            let location = match item {
                "node" => "C:\\Program Files\\nodejs",
                "tailscale" => TAILSCALE_WINDOWS_DIR,
                _ => "C:\\Program Files",
            };
            plan(
                item,
                method,
                plain(winget, args),
                format!("winget {}", args.join(" ")),
                location.to_owned(),
                Some("uac"),
                None,
            )
        }
        "archive" => {
            let release = release.filter(|r| r.item == item && r.item != "agent-desktop")?;
            let download = download_of(release);
            let script = archive_script(release, win, &ctx.tools_dir, &download);
            plan(
                item,
                method,
                bash(&script),
                script,
                join(win, &[&ctx.tools_dir, &release.item]),
                None,
                Some(download),
            )
        }
        "agent-desktop-archive" => {
            let release = release.filter(|r| {
                item == "agent-desktop" && r.item == "agent-desktop" && ctx.platform != "other"
            })?;
            let download = download_of(release);
            let dir = managed_agent_desktop_dir(win, &ctx.tools_dir);
            if win {
                let script = agent_desktop_windows_script(release, &ctx.tools_dir, &download);
                return plan(
                    item,
                    method,
                    powershell_script(&ctx.system_root, &script),
                    script,
                    dir,
                    None,
                    Some(download),
                );
            }
            let script = agent_desktop_archive_script(release, win, &ctx.tools_dir, &download);
            plan(
                item,
                method,
                bash(&script),
                script,
                dir,
                None,
                Some(download),
            )
        }
        "tailscale-zip" => {
            let release = tailscale.filter(|r| r.file.ends_with(".zip"))?;
            let download = download_of(release);
            let script = tailscale_zip_script(release, &download);
            plan(
                item,
                method,
                bash(&script),
                script,
                TAILSCALE_MAC_APP.into(),
                None,
                Some(download),
            )
        }
        "tailscale-msi" => {
            let release = tailscale.filter(|r| r.file.ends_with(".msi"))?;
            let download = download_of(release);
            let script = tailscale_msi_script(&download);
            plan(
                item,
                method,
                powershell_script(&ctx.system_root, &script),
                script,
                TAILSCALE_WINDOWS_DIR.into(),
                Some("uac"),
                Some(download),
            )
        }
        _ => None,
    }
}

/// What to run by hand and the official page (`manualSteps`); none for Bun and omp, which OMPdesk repairs itself.
pub fn manual_steps(item: &str, platform: &str) -> (Vec<String>, &'static str) {
    let win = platform == "win32";
    match item {
        "git" => (
            vec![if win {
                "winget install --id Git.Git -e".into()
            } else {
                "xcode-select --install".into()
            }],
            "https://git-scm.com/downloads",
        ),
        "gh" | "node" => (
            vec![if win {
                format!(
                    "winget install --id {} -e",
                    winget_id(item).unwrap_or_default()
                )
            } else {
                format!("brew install {item}")
            }],
            if item == "gh" {
                "https://cli.github.com/"
            } else {
                "https://nodejs.org/en/download"
            },
        ),
        "agent-desktop" => (
            Vec::new(),
            "https://github.com/vercel-labs/agent-desktop/releases",
        ),
        "tailscale" => (
            vec![if win {
                "winget install --id Tailscale.Tailscale -e".into()
            } else {
                "brew install --cask tailscale-app".into()
            }],
            "https://tailscale.com/download",
        ),
        _ => (Vec::new(), ""),
    }
}
