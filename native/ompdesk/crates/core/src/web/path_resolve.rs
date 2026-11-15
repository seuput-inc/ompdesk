//! Node-compatible lexical resolution shared by workspace admission and private uploads.

use std::path::{Component, Path, PathBuf};

pub(super) fn resolve_from(root: &Path, target: &Path) -> PathBuf {
    #[cfg(windows)]
    let target = {
        let mut parts = target.components();
        if let Some(Component::Prefix(prefix)) = parts.next()
            && !target.has_root()
            && root.components().next() == Some(Component::Prefix(prefix))
        {
            return normalize(&root.join(parts.as_path()));
        }
        target
    };
    normalize(&root.join(target))
}
pub(crate) fn resolve(path: &Path) -> PathBuf {
    if path.is_absolute() {
        normalize(path)
    } else {
        resolve_from(&std::env::current_dir().unwrap_or_default(), path)
    }
}
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => out.push(component),
            Component::CurDir => {}
            Component::ParentDir => {
                if out
                    .components()
                    .next_back()
                    .is_some_and(|last| matches!(last, Component::Normal(_)))
                {
                    out.pop();
                }
            }
        }
    }
    out
}
