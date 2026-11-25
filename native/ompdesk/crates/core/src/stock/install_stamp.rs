use std::path::{Path, PathBuf};

pub(super) fn files(root: &Path) -> Vec<PathBuf> {
    let mut files = vec![root.join("package.json")];
    let Some(scope) = root.parent().filter(|dir| dir.ends_with("@oh-my-pi")) else {
        return files;
    };
    files.push(scope.to_owned());
    if let Ok(entries) = scope.read_dir() {
        for entry in entries.flatten() {
            let package = entry.path();
            let manifest = package.join("package.json");
            files.extend([package, manifest]);
        }
    }
    if let Some(install) = scope
        .parent()
        .filter(|dir| dir.ends_with("node_modules"))
        .and_then(Path::parent)
    {
        files.extend(["package.json", "bun.lock", "bun.lockb"].map(|name| install.join(name)));
    }
    files
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stamp_paths_depend_on_the_install_layout() {
        let missing = std::env::current_exe().unwrap();
        for (package, expected) in [
            ("other/omp", vec!["other/omp/package.json"]),
            (
                "absent/@oh-my-pi/omp",
                vec!["absent/@oh-my-pi/omp/package.json", "absent/@oh-my-pi"],
            ),
            (
                "node_modules/@oh-my-pi/omp",
                vec![
                    "node_modules/@oh-my-pi/omp/package.json",
                    "node_modules/@oh-my-pi",
                    "package.json",
                    "bun.lock",
                    "bun.lockb",
                ],
            ),
        ] {
            assert_eq!(
                files(&missing.join(package)),
                expected.iter().map(|p| missing.join(p)).collect::<Vec<_>>()
            );
        }
    }
}
