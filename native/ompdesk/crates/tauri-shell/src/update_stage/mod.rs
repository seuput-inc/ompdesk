use serde::Serialize;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Path, PathBuf};

mod system;
#[cfg(test)]
mod tests;

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub(crate) enum StageReply {
    Staged { staged: PathBuf },
    Failed { error: Failure },
}

#[derive(Debug, Serialize)]
pub(crate) struct Failure {
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    errno: Option<i32>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    errors: Vec<Failure>,
}

impl Failure {
    fn new(reason: &'static str, message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            reason: Some(reason),
            errno: None,
            errors: Vec::new(),
        }
    }

    fn aggregate(message: &str, errors: Vec<Self>) -> Self {
        Self {
            message: message.into(),
            reason: None,
            errno: None,
            errors,
        }
    }
}

fn io_error(op: &str, path: &Path, error: std::io::Error) -> Failure {
    let errno = error.raw_os_error().map(|n| -n);
    Failure {
        message: if errno.is_some() {
            format!("{op} '{}'", path.display())
        } else {
            format!("{op} '{}': {error}", path.display())
        },
        errno,
        reason: None,
        errors: Vec::new(),
    }
}

type Run<'a> = dyn Fn(&str, &[&OsStr]) -> Option<String> + 'a;
const HDIUTIL: &str = "/usr/bin/hdiutil";
const COMPATIBILITY: &str = include_str!("../../../../../../src/shared/app-compatibility.json");

#[derive(serde::Deserialize)]
struct Compatibility<'a> {
    #[serde(rename = "minimumMacOS")]
    minimum_macos: &'a str,
}

fn os_version(s: &str) -> Option<[u64; 3]> {
    let mut parts = [0; 3];
    for (i, part) in s.split('.').enumerate() {
        if part.is_empty()
            || (part.len() > 1 && part.starts_with('0'))
            || !part.bytes().all(|b| b.is_ascii_digit())
        {
            return None;
        }
        let n = part.parse().ok()?;
        if n > 9_007_199_254_740_991 {
            return None;
        }
        *parts.get_mut(i)? = n;
    }
    Some(parts)
}

fn plist(run: &Run<'_>, app: &Path, key: &str) -> Option<String> {
    run(
        "/usr/bin/plutil",
        &[
            "-extract".as_ref(),
            key.as_ref(),
            "raw".as_ref(),
            "-o".as_ref(),
            "-".as_ref(),
            app.join("Contents/Info.plist").as_os_str(),
        ],
    )
}

struct Image<'a> {
    dmg: &'a Path,
    stage: PathBuf,
    version: &'a str,
    own: &'a Path,
}

impl Image<'_> {
    fn remove_stage(&self) -> Result<(), Failure> {
        crate::update_files::remove_staging_directory(
            self.stage.parent().expect("version under updates"),
            self.version,
        )
        .map_err(|e| io_error("rm", &self.stage, e))
    }

    fn copy(&self, mount: &Path, macos: [u64; 3], run: &Run<'_>) -> Result<PathBuf, Failure> {
        let mut bundle: Option<OsString> = None;
        let scan_error = |e| io_error("scandir", mount, e);
        for entry in fs::read_dir(mount).map_err(scan_error)? {
            let entry = entry.map_err(scan_error)?;
            let name = entry.file_name();
            // The Applications alias on a DMG is not a bundle. Match Node's sorted readdir.
            if name.as_encoded_bytes().ends_with(b".app")
                && entry.file_type().map_err(scan_error)?.is_dir()
                && bundle.as_ref().is_none_or(|old| name < *old)
            {
                bundle = Some(name);
            }
        }
        let name = bundle.ok_or_else(|| {
            Failure::new(
                "missing",
                format!("{} contains no .app bundle", self.dmg.display()),
            )
        })?;
        let mounted = mount.join(&name);
        let minimum = plist(run, &mounted, "LSMinimumSystemVersion");
        if minimum
            .as_deref()
            .and_then(os_version)
            .is_none_or(|v| v > macos)
        {
            return Err(Failure::new(
                "compatibility",
                "The mounted bundle requires an unsupported macOS version",
            ));
        }
        self.remove_stage()?;
        fs::create_dir(&self.stage).map_err(|e| io_error("mkdir", &self.stage, e))?;
        let staged = self.stage.join(&name);
        run("/usr/bin/ditto", &[mounted.as_os_str(), staged.as_os_str()]).ok_or_else(|| {
            Failure::new(
                "copy",
                format!(
                    "ditto could not copy {} out of the DMG",
                    name.to_string_lossy()
                ),
            )
        })?;
        Ok(staged)
    }

    fn verify(&self, staged: &Path, run: &Run<'_>) -> Result<(), Failure> {
        let signed = run(
            "/usr/bin/codesign",
            &[
                "--verify".as_ref(),
                "--deep".as_ref(),
                "--strict".as_ref(),
                staged.as_os_str(),
            ],
        )
        .is_some();
        let id = plist(run, staged, "CFBundleIdentifier");
        if signed
            && id.as_deref().is_some_and(|s| !s.is_empty())
            && id == plist(run, self.own, "CFBundleIdentifier")
            && plist(run, staged, "CFBundleShortVersionString").as_deref() == Some(self.version)
        {
            return Ok(());
        }
        self.remove_stage()?;
        Err(Failure::new(
            "verify",
            format!(
                "The bundle in {} is not an intact OMPdesk {}",
                self.dmg.display(),
                self.version
            ),
        ))
    }
}

fn stage_with(
    user_data: &Path,
    temp_root: &Path,
    dmg: &Path,
    version: &str,
    own: &Path,
    run: &Run<'_>,
) -> Result<PathBuf, Failure> {
    let system = run("/usr/bin/sw_vers", &["-productVersion".as_ref()])
        .as_deref()
        .and_then(os_version);
    let floor = serde_json::from_str::<Compatibility<'_>>(COMPATIBILITY)
        .ok()
        .and_then(|c| os_version(c.minimum_macos));
    let macos = system
        .filter(|s| floor.is_some_and(|v| *s >= v))
        .ok_or_else(|| {
            Failure::new(
                "compatibility",
                "The running macOS version is unsupported or unavailable",
            )
        })?;

    let updates = user_data.join("updates");
    let stage = updates.join(version);
    // Feed versions start with a digit. Do not let a request name swap.log, the image, or any ancestor.
    if !version.as_bytes().first().is_some_and(u8::is_ascii_digit)
        || !version
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'+' | b'-'))
        || !user_data.is_absolute()
        || !temp_root.is_absolute()
        || !own.is_absolute()
        || dmg.parent() != Some(updates.as_path())
        || dmg.extension() != Some("dmg".as_ref())
        || dmg.file_name().is_some_and(|name| {
            name.as_encoded_bytes()
                .eq_ignore_ascii_case(version.as_bytes())
        })
        || temp_root.starts_with(&updates)
        || own.starts_with(&stage)
        || !fs::symlink_metadata(&updates).is_ok_and(|m| m.is_dir())
        || !fs::symlink_metadata(dmg).is_ok_and(|m| m.is_file())
    {
        return Err(Failure::new("mount", "Invalid update staging path"));
    }
    let image = Image {
        dmg,
        stage,
        version,
        own,
    };
    fs::create_dir_all(temp_root).map_err(|e| io_error("mkdir", temp_root, e))?;
    let updates = fs::canonicalize(&updates).map_err(|e| io_error("realpath", &updates, e))?;
    let temp = fs::canonicalize(temp_root).map_err(|e| io_error("realpath", temp_root, e))?;
    if temp.starts_with(&updates)
        || fs::canonicalize(own).is_ok_and(|p| p.starts_with(updates.join(version)))
    {
        return Err(Failure::new("mount", "Invalid update staging path"));
    }
    // TempDir's destructor recursively removes its contents. Never give it an attached volume.
    let mount = tempfile::Builder::new()
        .prefix("ompdesk-update-")
        .tempdir_in(temp_root)
        .map_err(|e| io_error("mkdtemp", temp_root, e))?
        .keep();
    let attached = run(
        HDIUTIL,
        &[
            "attach".as_ref(),
            "-nobrowse".as_ref(),
            "-readonly".as_ref(),
            "-noautoopen".as_ref(),
            "-mountpoint".as_ref(),
            mount.as_os_str(),
            dmg.as_os_str(),
        ],
    )
    .is_some();
    let copied = if attached {
        let copied = image.copy(&mount, macos, run);
        if run(HDIUTIL, &["detach".as_ref(), mount.as_os_str()]).is_none()
            && run(
                HDIUTIL,
                &["detach".as_ref(), "-force".as_ref(), mount.as_os_str()],
            )
            .is_none()
        {
            let errors = copied
                .err()
                .into_iter()
                .chain(["detach", "detach -force"].map(|verb| {
                    Failure::new(
                        "mount",
                        format!("hdiutil {verb} {} failed", mount.display()),
                    )
                }))
                .collect();
            return Err(Failure::aggregate(
                "Could not detach the update disk image",
                errors,
            ));
        }
        copied
    } else {
        Err(Failure::new(
            "mount",
            format!("hdiutil could not attach {}", dmg.display()),
        ))
    };
    if let Err(e) = fs::remove_dir(&mount) {
        let cleanup = io_error("rmdir", &mount, e);
        return Err(match copied {
            Err(error) => Failure::aggregate(
                "Update staging and mount cleanup failed",
                vec![error, cleanup],
            ),
            Ok(_) => cleanup,
        });
    }
    let staged = copied?;
    image.verify(&staged, run)?;
    Ok(staged)
}

pub(crate) fn stage(
    user_data: &Path,
    temp_root: &Path,
    dmg: &Path,
    version: &str,
    own_bundle: &Path,
) -> StageReply {
    match stage_with(user_data, temp_root, dmg, version, own_bundle, &system::run) {
        Ok(staged) => StageReply::Staged { staged },
        Err(error) => StageReply::Failed { error },
    }
}
