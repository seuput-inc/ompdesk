use super::initialize;
use serde_json::Value;
use shell_preview::Event;
use std::collections::HashMap;
use std::sync::Arc;

struct ExecutionContext {
    id: i64,
    unique: Arc<str>,
}

#[derive(Default)]
pub(super) struct MainWorld(Option<ExecutionContext>);

impl MainWorld {
    pub(super) fn observe(&mut self, event: &Event, root: Option<&str>) {
        match event.method.as_str() {
            "Runtime.executionContextCreated"
                if root.is_some()
                    && event
                        .params
                        .pointer("/context/auxData/isDefault")
                        .and_then(Value::as_bool)
                        == Some(true)
                    && event
                        .params
                        .pointer("/context/auxData/frameId")
                        .and_then(Value::as_str)
                        == root =>
            {
                self.0 = match (
                    event.params.pointer("/context/id").and_then(Value::as_i64),
                    event
                        .params
                        .pointer("/context/uniqueId")
                        .and_then(Value::as_str),
                ) {
                    (Some(id), Some(unique)) => Some(ExecutionContext {
                        id,
                        unique: Arc::from(unique),
                    }),
                    _ => None,
                };
            }
            "Runtime.executionContextDestroyed"
                if self.0.as_ref().is_some_and(|context| {
                    Some(context.unique.as_ref())
                        == event.params["executionContextUniqueId"].as_str()
                }) =>
            {
                self.0 = None;
            }
            "Runtime.executionContextsCleared" => self.0 = None,
            _ => {}
        }
    }
    pub(super) fn id(&self) -> Option<i64> {
        self.0.as_ref().map(|context| context.id)
    }
    pub(super) fn capture(&self) -> Option<Arc<str>> {
        self.0.as_ref().map(|context| Arc::clone(&context.unique))
    }
    pub(super) fn owns(&self, unique: &str) -> bool {
        self.0
            .as_ref()
            .is_some_and(|context| context.unique.as_ref() == unique)
    }
}

#[derive(Default)]
pub(super) struct BindingContexts {
    sessions: HashMap<String, HashMap<i64, String>>,
}

pub(super) enum Notification {
    Text,
    Layout,
    Title(String),
}

impl BindingContexts {
    pub(super) fn observe(&mut self, event: &Event) {
        let Some(session) = event.session_id.as_deref() else {
            return;
        };
        match event.method.as_str() {
            "Runtime.executionContextCreated"
                if event
                    .params
                    .pointer("/context/name")
                    .and_then(Value::as_str)
                    == Some(initialize::WORLD) =>
            {
                if let (Some(id), Some(frame)) = (
                    event.params.pointer("/context/id").and_then(Value::as_i64),
                    event
                        .params
                        .pointer("/context/auxData/frameId")
                        .and_then(Value::as_str),
                ) {
                    self.sessions
                        .entry(session.to_owned())
                        .or_default()
                        .insert(id, frame.to_owned());
                }
            }
            "Runtime.executionContextDestroyed" => {
                if let Some(id) = event.params["executionContextId"].as_i64()
                    && let Some(contexts) = self.sessions.get_mut(session)
                {
                    contexts.remove(&id);
                }
            }
            "Runtime.executionContextsCleared" => self.detached(session),
            _ => {}
        }
    }

    pub(super) fn detached(&mut self, session: &str) {
        self.sessions.remove(session);
    }

    pub(super) fn notification(
        &self,
        event: &Event,
        primary: &str,
        root: Option<&str>,
    ) -> Option<Notification> {
        if event.method != "Runtime.bindingCalled"
            || event.params["name"].as_str() != Some(initialize::BINDING)
        {
            return None;
        }
        let session = event.session_id.as_deref()?;
        let context = event.params["executionContextId"].as_i64()?;
        let frame = self.sessions.get(session)?.get(&context)?;
        match event.params["payload"].as_str()? {
            "text" => Some(Notification::Text),
            "layout" => Some(Notification::Layout),
            payload if session == primary && root == Some(frame.as_str()) => {
                initialize::observed_title(payload).map(Notification::Title)
            }
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;

    fn event(session: &str, method: &str, params: Value) -> Event {
        Event {
            method: method.into(),
            params: Arc::new(params),
            session_id: Some(session.into()),
        }
    }
    fn world(session: &str, id: i64, frame: &str) -> Event {
        event(
            session,
            "Runtime.executionContextCreated",
            json!({
                "context":{"id":id,"name":initialize::WORLD,"auxData":{"frameId":frame}}
            }),
        )
    }
    fn title(session: &str, id: i64) -> Event {
        event(
            session,
            "Runtime.bindingCalled",
            json!({
                "name":initialize::BINDING,"executionContextId":id,
                "payload":r#"{"kind":"title","title":"w=459"}"#
            }),
        )
    }
    fn text(session: &str, id: i64) -> Event {
        event(
            session,
            "Runtime.bindingCalled",
            json!({
                "name":initialize::BINDING,"executionContextId":id,"payload":"text"
            }),
        )
    }
    fn accepted(contexts: &BindingContexts, event: &Event) -> Option<String> {
        match contexts.notification(event, "primary", Some("root")) {
            Some(Notification::Title(title)) => Some(title),
            _ => None,
        }
    }
    fn refreshes(contexts: &BindingContexts, event: &Event) -> bool {
        matches!(
            contexts.notification(event, "primary", Some("root")),
            Some(Notification::Text)
        )
    }

    #[test]
    fn live_root_title_survives_frame_navigation_but_not_runtime_context_death() {
        let mut contexts = BindingContexts::default();
        contexts.observe(&world("primary", 7, "root"));
        contexts.observe(&event(
            "primary",
            "Page.frameStartedLoading",
            json!({"frameId":"root"}),
        ));
        contexts.observe(&event(
            "primary",
            "Page.frameNavigated",
            json!({"frame":{"id":"root"}}),
        ));
        assert_eq!(
            accepted(&contexts, &title("primary", 7)).as_deref(),
            Some("w=459")
        );
        contexts.observe(&event(
            "primary",
            "Runtime.executionContextDestroyed",
            json!({"executionContextId":7}),
        ));
        assert_eq!(accepted(&contexts, &title("primary", 7)), None);
        contexts.observe(&world("primary", 8, "root"));
        contexts.observe(&event(
            "primary",
            "Runtime.executionContextsCleared",
            json!({}),
        ));
        assert_eq!(accepted(&contexts, &title("primary", 8)), None);
    }

    #[test]
    fn only_the_live_named_primary_root_world_can_publish_a_title() {
        let mut contexts = BindingContexts::default();
        contexts.observe(&world("primary", 1, "root"));
        contexts.observe(&world("primary", 2, "child"));
        contexts.observe(&world("iframe-session", 1, "root"));
        contexts.observe(&event(
            "primary",
            "Runtime.executionContextCreated",
            json!({
                "context":{"id":3,"name":"other-world","auxData":{"frameId":"root"}}
            }),
        ));
        assert_eq!(
            accepted(&contexts, &title("primary", 1)).as_deref(),
            Some("w=459")
        );
        for rejected in [
            title("primary", 2),
            title("iframe-session", 1),
            title("primary", 3),
            title("primary", 4),
        ] {
            assert_eq!(accepted(&contexts, &rejected), None);
        }
        contexts.detached("primary");
        assert_eq!(accepted(&contexts, &title("primary", 1)), None);
    }

    #[test]
    fn only_live_named_input_worlds_can_request_refresh() {
        let mut contexts = BindingContexts::default();
        contexts.observe(&world("primary", 1, "root"));
        contexts.observe(&world("primary", 2, "child"));
        contexts.observe(&world("iframe-session", 1, "root"));
        contexts.observe(&event(
            "primary",
            "Runtime.executionContextCreated",
            json!({
                "context":{"id":3,"name":"other-world","auxData":{"frameId":"root"}}
            }),
        ));
        for permitted in [
            text("primary", 1),
            text("primary", 2),
            text("iframe-session", 1),
        ] {
            assert!(refreshes(&contexts, &permitted));
        }
        for rejected in [
            text("primary", 3),
            text("primary", 4),
            text("other-session", 1),
        ] {
            assert!(!refreshes(&contexts, &rejected));
        }
        contexts.detached("primary");
        assert!(!refreshes(&contexts, &text("primary", 1)));
    }

    fn main_world(id: i64, unique: &str, frame: &str) -> Event {
        event(
            "primary",
            "Runtime.executionContextCreated",
            json!({
                "context":{"id":id,"uniqueId":unique,"auxData":{"frameId":frame,"isDefault":true}}
            }),
        )
    }

    #[test]
    fn main_world_work_survives_child_frames_and_blocked_navigation_not_context_replacement() {
        let mut world = MainWorld::default();
        world.observe(&main_world(1, "original", "root"), Some("root"));
        let captured = world.capture().unwrap();
        world.observe(
            &event(
                "primary",
                "Page.frameStartedLoading",
                json!({"frameId":"root"}),
            ),
            Some("root"),
        );
        world.observe(&main_world(2, "child", "child"), Some("root"));
        world.observe(
            &event("primary", "Page.frameDetached", json!({"frameId":"child"})),
            Some("root"),
        );
        assert!(world.owns(&captured));
        assert_eq!(world.id(), Some(1));
        world.observe(&main_world(1, "replacement", "root"), Some("root"));
        assert!(!world.owns(&captured));
        world.observe(
            &event(
                "primary",
                "Runtime.executionContextDestroyed",
                json!({
                    "executionContextId":1,"executionContextUniqueId":"original"
                }),
            ),
            Some("root"),
        );
        assert!(world.owns("replacement"));
        world.observe(
            &event(
                "primary",
                "Runtime.executionContextDestroyed",
                json!({
                    "executionContextId":1,"executionContextUniqueId":"replacement"
                }),
            ),
            Some("root"),
        );
        assert_eq!(world.capture(), None);
        world.observe(&main_world(3, "new", "root"), Some("root"));
        world.observe(
            &event("primary", "Runtime.executionContextsCleared", json!({})),
            Some("root"),
        );
        assert_eq!(world.capture(), None);
    }
}
