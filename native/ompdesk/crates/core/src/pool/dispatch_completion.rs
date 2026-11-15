use std::sync::Arc;

use serde_json::json;

use super::{CommandAdmission, EffectFuture, Host, Service};
use crate::application::source::Source;
use crate::server::{Events, Fault};

/// The policy selects a successful response tail; this module applies only canonical metadata effects.
pub(crate) enum Completion {
    SessionFile(String),
    NewSession,
    State { session_file: Option<String>, cwd: Option<String> },
    ModeChanged,
}

impl<H: Host> Service<H> {
    pub(crate) fn complete_command(
        &self,
        admission: Arc<CommandAdmission<Source>>,
        completion: Completion,
        shell: Events,
    ) -> EffectFuture<'static, Result<(), Fault>>
    where H: Host<Sidecar = Source>,
    {
        let effects = admission.effects().clone();
        let (reply, answer) = tokio::sync::oneshot::channel();
        crate::hub::post(move || crate::hub::spawn(async move {
          let result = async {
            let ctx = effects.original_ctx().ok_or_else(super::stale)?;
            let (tab, window, window_record, expected_file, file, unstarted, adopted) =
                admission.authority().admit_command(&admission, || {
            effects.check(&ctx, &admission)?;
            let selected = admission.selected();
            let (seq, window) = ctx.with(|pool| {
                let entry = pool.entry(&selected.tab).expect("original entry checked");
                (entry.seq, entry.win_id)
            });
            let mut file = None;
            let mut unstarted = None;
            let mut adopted = None;
            match completion {
                Completion::SessionFile(path) => file = ctx.session_file_start(seq, Some(&path)),
                Completion::NewSession => unstarted = ctx.note_unstarted_start(&selected.tab, true),
                Completion::State { session_file, cwd } => {
                    file = ctx.session_file_start(seq, session_file.as_deref().filter(|path| !path.is_empty()));
                    adopted = cwd.filter(|cwd| !cwd.is_empty());
                }
                Completion::ModeChanged => ctx.note_mode_changed_from(&selected.tab, admission.window().map(|window| window.id)),
            }
            let window_record = admission.window().filter(|_| selected.sidecar.is_local());
            let expected_file = ctx.with(|pool| pool.entry(&selected.tab).expect("original entry checked").session_file.clone());
            Ok((selected.tab.clone(), window, window_record, expected_file, file, unstarted, adopted))
        })?;
                let recheck = || admission.authority().admit_command(&admission, || {
                    effects.check_at_file(&ctx, &admission, expected_file.as_deref())
                });
                let file_changed = file.as_ref().is_some_and(|update| update.changed);
                let file_result = async {
                    if let Some(update) = file { ctx.session_file_finish(update).await?; }
                    if file_changed {
                        recheck()?; ctx.forward_status(&tab).await?; recheck()?;
                        if let Some(window) = window { ctx.notify_window_tabs_changed(window).await?; }
                    }
                    if let Some(window) = unstarted {
                        recheck()?; ctx.forward_status(&tab).await?; recheck()?;
                        if let Some(window) = window { ctx.notify_window_tabs_changed(window).await?; }
                    }
                    Ok::<_, Fault>(())
                };
                let file = file_result.await;
                let cwd_result = async {
                    if let Some(cwd) = adopted.filter(|_| file.is_ok()) {
                        let receipt = admission.authority().admit_command(&admission, || {
                            effects.check_at_file(&ctx, &admission, expected_file.as_deref())?;
                            let selected = admission.selected();
                            Ok(selected.sidecar.adopt_cwd_for_generation(selected.generation, cwd.clone()))
                        })?;
                        if receipt.await? {
                            // This private receipt accepts only the file mapping it just committed; the public admission stays immutable.
                            recheck()?;
                            ctx.forward_status(&tab).await?;
                            recheck()?;
                            if let Some(window) = window { ctx.notify_window_tabs_changed(window).await?; }
                            if let Some(window) = window_record {
                                admission.authority().admit_command(&admission, || {
                                    effects.check_at_file(&ctx, &admission, expected_file.as_deref())?;
                                    shell.send("chrome.cwd", &json!({"winId":window.id,"cwd":cwd}));
                                    Ok(())
                                })?;
                            }
                        }
                    }
                    Ok(())
                };
                let cwd = cwd_result.await;
                file.and(cwd)
            }.await;
            let _ = reply.send(result);
        }));
        Box::pin(async move { answer.await.map_err(|_| Fault::new("pool_closed", "The original response completion ended"))? })
    }
}
