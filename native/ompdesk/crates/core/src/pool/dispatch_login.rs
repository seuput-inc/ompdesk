use std::sync::Arc;

use super::{CommandAdmission, CommandEffects, EffectFuture, Host, Service, Sidecar};
use crate::server::Fault;

/// Cleanup for one sign-in already marked on its original entry, not permission to issue another command.
pub(crate) struct SignIn<S: Sidecar<Error = Fault> + ?Sized + 'static> {
    admission: Arc<CommandAdmission<S>>,
    effects: CommandEffects<S>,
    provider: Option<String>,
}

impl<S: Sidecar<Error = Fault> + ?Sized + 'static> SignIn<S> {
    pub(crate) fn finish(mut self, error: Option<String>) -> EffectFuture<'static, Result<(), Fault>> {
        self.complete(error)
    }

    fn complete(&mut self, error: Option<String>) -> EffectFuture<'static, Result<(), Fault>> {
        let Some(provider) = self.provider.take() else { return Box::pin(async { Ok(()) }); };
        let admission = Arc::clone(&self.admission);
        let effects = self.effects.clone();
        let (reply, answer) = tokio::sync::oneshot::channel();
        crate::hub::post(move || {
            let result = effects.original_ctx().ok_or_else(super::stale).and_then(|ctx| {
                let selected = admission.selected();
                let handles = effects.handles.upgrade().ok_or_else(super::stale)?;
                let current = handles.lock().unwrap_or_else(|error| error.into_inner())
                    .get(&super::super::super::HandleKey::Tab(selected.tab.clone()))
                    .is_some_and(|handle| Arc::ptr_eq(&handle.sidecar, &selected.sidecar));
                // The owned provider count belongs to this entry, not its child run; a restart must not strand it.
                if !current
                    || !ctx.with(|pool| pool.entry(&selected.tab).is_some_and(|entry| entry.seq == admission.incarnation() && entry.device == selected.device)) {
                    return Err(super::stale());
                }
                ctx.note_sign_in(&selected.tab, false, Some((provider, error)));
                Ok(())
            });
            let _ = reply.send(result);
        });
        Box::pin(async move { answer.await.map_err(|_| Fault::new("pool_closed", "The original sign-in cleanup ended"))? })
    }
}

impl<S: Sidecar<Error = Fault> + ?Sized + 'static> Drop for SignIn<S> {
    fn drop(&mut self) {
        if self.provider.is_none() { return; }
        let cleanup = self.complete(None);
        tokio::spawn(async move {
            if let Err(error) = cleanup.await {
                eprintln!("ompdesk-core: original sign-in cleanup failed: {}", error.message);
            }
        });
    }
}

impl<H: Host> Service<H> {
    pub(crate) fn begin_sign_in_command(
        &self,
        admission: Arc<CommandAdmission<H::Sidecar>>,
        provider: Option<String>,
    ) -> EffectFuture<'static, Result<Option<SignIn<H::Sidecar>>, Fault>> {
        let effects = admission.effects().clone();
        let retained = effects.clone();
        effects.apply(admission, move |ctx, admission| {
            let tab = &admission.selected().tab;
            if ctx.sign_in_active(tab) {
                return Err(Fault::new("login_in_progress", "A provider sign-in is already in progress in this tab"));
            }
            let Some(provider) = provider.filter(|provider| !provider.is_empty()) else { return Ok(None); };
            ctx.note_sign_in(tab, true, Some((provider.clone(), None)));
            Ok(Some(SignIn { admission: Arc::clone(admission), effects: retained, provider: Some(provider) }))
        })
    }

    pub(crate) fn command_kind(
        &self,
        admission: Arc<CommandAdmission<H::Sidecar>>,
    ) -> EffectFuture<'static, Result<String, Fault>> {
        admission.effects().clone().apply(admission, |ctx, admission| {
            Ok(ctx.with(|pool| pool.entry(&admission.selected().tab).expect("original entry checked").kind.clone()))
        })
    }
}

impl<H: Host> Service<H> {
    pub(crate) fn session_kind_command(
        &self,
        admission: Arc<CommandAdmission<H::Sidecar>>,
        session_path: String,
        index: Arc<crate::application::sessions::SessionIndex>,
    ) -> EffectFuture<'static, Result<String, Fault>>
    where H: Host<Sidecar = crate::application::source::Source>,
    {
        let retained = Arc::clone(&admission);
        let work = admission.effects().clone().apply(admission, move |_, admission| {
            let selected = admission.selected();
            let query: EffectFuture<'static, Result<String, Fault>> =
                if let Some(remote) = selected.sidecar.remote() {
                    let query = remote.kind_for_generation(selected.generation, session_path);
                    Box::pin(async move {
                        query.await?.as_str().map(str::to_owned)
                            .ok_or_else(|| Fault::new("protocol", "Invalid remote session kind"))
                    })
                } else {
                    Box::pin(async move {
                        Ok(index.kind_for(std::path::Path::new(&session_path)).await.to_owned())
                    })
                };
            Ok(query)
        });
        Box::pin(async move {
            let kind = work.await?.await?;
            retained.effect(move |_| Ok(kind)).await
        })
    }

    pub(crate) fn command_origin(
        &self,
        admission: Arc<CommandAdmission<H::Sidecar>>,
    ) -> EffectFuture<'static, Result<Option<serde_json::Value>, Fault>>
    where H: Host<Sidecar = crate::application::source::Source>,
    {
        admission.effects().clone().apply(admission, |_, admission| {
            Ok(admission.selected().sidecar.original_origin())
        })
    }

    pub(crate) fn sync_image_generation_command(
        &self,
        admission: Arc<CommandAdmission<H::Sidecar>>,
    ) -> EffectFuture<'static, Result<(), Fault>>
    where H: Host<Sidecar = crate::application::source::Source>,
    {
        let app = Arc::clone(&self.app);
        admission.effects().clone().apply(admission, move |_, _| {
            let handles = app.handles.lock().unwrap_or_else(|error| error.into_inner());
            for (key, handle) in handles.iter() {
                if !matches!(key, super::super::super::HandleKey::Tab(_)) { continue; }
                let source = &handle.sidecar;
                let work = source.sync_image_generation_for_generation(source.generation());
                // As in TS syncImageGeneration, a disconnected tab catches up on its next bridge connection.
                tokio::spawn(async move { let _ = work.await; });
            }
            Ok(())
        })
    }
}

#[cfg(test)]
#[path = "dispatch_login_tests.rs"]
mod tests;
