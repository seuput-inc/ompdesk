//! Explicit project choices in this host's profile, separate from the generic desktop preferences IPC.
use std::path::Path;

use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::{Distribution, Scope, admissible, guid, inventory, no_input};
use crate::prefs;
use crate::server::{Fault, Registry, Reply};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Get {
    profile: String,
    cwd: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Set {
    profile: String,
    cwd: String,
    #[serde(deserialize_with = "Option::deserialize")]
    id: Option<String>,
}

struct Choice {
    file: String,
    key: String,
}

impl Choice {
    fn new(profile: &Path, cwd: &str) -> Result<Self, Fault> {
        if !profile.is_absolute()
            || !Path::new(cwd).is_absolute()
            || cwd.chars().any(char::is_control)
        {
            return Err(Fault::new(
                "invalid_params",
                "Expected the host profile and project folder",
            ));
        }
        // Main supplies canonicalCwd on both paths. Never case-fold a case-sensitive guest directory or parse a project name as a prefs key.
        let key = crate::hex(&Sha256::digest(cwd.as_bytes()));
        let file = profile
            .join("wsl-project-hosts.json")
            .into_os_string()
            .into_string()
            .map_err(|_| Fault::new("invalid_params", "Invalid profile folder"))?;
        Ok(Self { file, key })
    }

    fn selected(&self) -> Result<Option<String>, Fault> {
        match prefs::get(&self.file, &self.key)? {
            None => Ok(None),
            Some(Value::String(id)) if guid(&id) => Ok(Some(id)),
            _ => Err(Fault::new("wsl_project", "Invalid saved WSL project host")),
        }
    }

    fn save(&self, distro: Option<Distribution>) -> Result<(), Fault> {
        match distro {
            Some(d) => prefs::set(&self.file, &self.key, Value::String(d.id)),
            None => prefs::delete(&self.file, &self.key),
        }
    }
}

pub(crate) async fn target(
    profile: &Path,
    cwd: &str,
    scope: &Scope,
) -> Result<Option<Distribution>, Fault> {
    match Choice::new(profile, cwd)?.selected()? {
        None => Ok(None),
        Some(id) => admissible(&id, scope).await.map(Some),
    }
}

pub(super) fn register(registry: &mut Registry) {
    registry.add("setup.wslProjectGet", |call| {
        Box::pin(async move {
            no_input(&call)?;
            let Get { profile, cwd } = call.params()?;
            let selected = Choice::new(Path::new(&profile), &cwd)?.selected()?;
            let mut inv = inventory(&call.scope).await?;
            inv.distributions.retain(|d| d.version == 2);
            Reply::json(&json!({"selected": selected, "distributions": inv.distributions}))
        })
    });
    registry.add("setup.wslProjectSet", |call| {
        Box::pin(async move {
            no_input(&call)?;
            let Set { profile, cwd, id } = call.params()?;
            let choice = Choice::new(Path::new(&profile), &cwd)?;
            // Clearing never requires the removed or unregistered guest to answer.
            let distro = match id {
                Some(id) => Some(inventory(&call.scope).await?.registered_v2(&id)?),
                None => None,
            };
            choice.save(distro)?;
            Reply::json(&())
        })
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn selection_is_per_exact_folder_and_clearing_does_not_start_wsl() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("project.test[0]");
        let b = dir.path().join("project.test[1]");
        let a = a.to_str().unwrap();
        let b = b.to_str().unwrap();
        let choice = Choice::new(dir.path(), a).unwrap();
        let id = "{12345678-abcd-0000-0000-123456789abc}";
        choice
            .save(Some(
                Distribution::registered(id.into(), "fixture".into(), 2, None).unwrap(),
            ))
            .unwrap();
        assert_eq!(
            Choice::new(dir.path(), a)
                .unwrap()
                .selected()
                .unwrap()
                .as_deref(),
            Some(id)
        );
        assert!(
            target(dir.path(), b, &Scope::detached())
                .await
                .unwrap()
                .is_none()
        );
        choice.save(None).unwrap();
        assert!(
            target(dir.path(), a, &Scope::detached())
                .await
                .unwrap()
                .is_none()
        );
        crate::prefs::flush(std::time::Duration::from_secs(2));
    }
}
