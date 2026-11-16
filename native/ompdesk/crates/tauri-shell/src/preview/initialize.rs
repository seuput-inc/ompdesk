use serde_json::json;
use shell_preview::{AttachedPage, PageInitializer};
use std::pin::Pin;

pub(super) const WORLD: &str = "ompdesk-native-input";
pub(super) const BINDING: &str = "__ompdeskNativeState";
pub(super) struct Initializer;
impl PageInitializer for Initializer {
    fn initialize(
        &self,
        page: AttachedPage,
    ) -> Pin<Box<dyn Future<Output = shell_preview::Result<()>> + Send>> {
        Box::pin(async move {
            crate::sessions::preview::Initializer
                .initialize(page.clone())
                .await?;
            let info = page
                .command("Target.getTargetInfo", json!({"targetId":page.target_id}))
                .await?;
            if !matches!(
                info.pointer("/targetInfo/type")
                    .and_then(serde_json::Value::as_str),
                Some("page" | "iframe")
            ) {
                return Ok(());
            }
            page.command("Accessibility.enable", json!({})).await?;
            page.command(
                "Runtime.addBinding",
                json!({"name":BINDING,"executionContextName":WORLD}),
            )
            .await?;
            page.command(
                "Page.addScriptToEvaluateOnNewDocument",
                json!({"worldName":WORLD,"source":OBSERVE}),
            )
            .await?;
            Ok(())
        })
    }
}

/// The title a document announced through the binding as `{kind:'title',title}`, sent once per actual
/// `document.title` change and again when the page returns from the back/forward cache. Any other payload is `None`.
/// The caller still owes the authorization: the payload names the page's title only when its execution context
/// belongs to the current root frame.
pub(super) fn observed_title(payload: &str) -> Option<String> {
    #[derive(serde::Deserialize)]
    #[serde(tag = "kind", rename_all = "lowercase")]
    enum Signal {
        Title { title: String },
    }
    let Signal::Title { title } = serde_json::from_str::<Signal>(payload).ok()?;
    Some(title)
}

const OBSERVE: &str = r#"(()=>{
    if(Object.hasOwn(globalThis,'__ompdeskNativeComposition'))return;
    const internal=new WeakSet();
    const state={marked:null,target:null,measure:fn=>{
        const node=document.createElement('div');
        internal.add(node);
        try{return fn(node)}finally{try{changes(observer.takeRecords())}finally{internal.delete(node)}}
    }};
    Object.defineProperty(globalThis,'__ompdeskNativeComposition',{value:state});
    const notify=payload=>globalThis.__ompdeskNativeState(payload);
    let reported='';
    const title=force=>{
        const current=document.title;
        if(force||current!==reported){reported=current;notify(JSON.stringify({kind:'title',title:current}));}
    };
    const start=()=>{
        const element=document.activeElement;
        if(element&&typeof element.selectionStart==='number')return element.selectionStart;
        const selection=document.getSelection();
        if(!element?.isContentEditable||!selection?.rangeCount||!element.contains(selection.anchorNode))return null;
        const range=document.createRange();range.selectNodeContents(element);range.setEnd(selection.anchorNode,selection.anchorOffset);
        return range.toString().length;
    };
    document.addEventListener('compositionstart',event=>{if(event.isTrusted){state.target=event.target;const offset=start();state.marked=offset===null?null:{start:offset,length:0};notify('text');}},true);
    document.addEventListener('compositionupdate',event=>{if(event.isTrusted){if(state.marked)state.marked.length=event.data.length;notify('text');}},true);
    document.addEventListener('compositionend',event=>{if(event.isTrusted){state.marked=null;state.target=null;notify('text');}},true);
    document.addEventListener('focusout',()=>{state.marked=null;state.target=null;},true);
    for(const name of ['input','select','selectionchange','focusin','focusout'])document.addEventListener(name,()=>notify('text'),true);
    document.addEventListener('scroll',()=>notify('layout'),true);
    globalThis.addEventListener('pageshow',event=>{if(event.persisted)title(true);},true);
    const changes=records=>{
        title();
        if(records.some(record=>record.type!=='childList'||(!record.addedNodes.length&&!record.removedNodes.length)||
            [...record.addedNodes,...record.removedNodes].some(node=>!internal.has(node))))notify('layout');
    };
    const observer=new MutationObserver(changes);
    observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});
})()"#;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::preview::events;
    use crate::preview::{input, target::Target};
    use crate::preview_surface::SurfaceKey;
    use serde_json::Value;
    use shell_preview::{Browser, LaunchConfig, Page, Viewport};
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn evaluate(page: &Page, context: i64, expression: &str) -> serde_json::Value {
        let result = page
            .command(
                "Runtime.evaluate",
                json!({"contextId":context,"expression":expression,"awaitPromise":true,"returnByValue":true}),
            )
            .await
            .unwrap();
        assert!(result.get("exceptionDetails").is_none(), "{result}");
        result["result"]["value"].clone()
    }

    /// What the observed page announced on the wire, read the way the Preview owner reads it.
    struct Announcements {
        events: shell_preview::EventReceiver,
        session: String,
        /// Isolated-world contexts announced since the session's last `executionContextsCleared`, with their frame.
        worlds: HashMap<i64, String>,
        /// The frame of the last root `Page.frameNavigated` that decoded as a back/forward cache restore.
        restored: Option<String>,
        log: Vec<String>,
    }

    impl Announcements {
        fn new(browser: &Browser, page: &Page) -> Self {
            Self {
                events: browser.subscribe(),
                session: page.session_id.clone(),
                worlds: HashMap::new(),
                restored: None,
                log: Vec::new(),
            }
        }

        /// Consumes one event of the page's session. A title announced through the binding is returned with the
        /// frame its execution context belongs to: that context-to-frame map is the authority the Preview owner
        /// checks before it accepts a title.
        async fn observe(&mut self) -> Option<(String, String)> {
            let event = self.events.recv().await.expect("actual browser event");
            if event.session_id.as_deref() != Some(self.session.as_str()) {
                return None;
            }
            let params = &event.params;
            match event.method.as_str() {
                "Runtime.executionContextsCleared" => {
                    self.worlds.clear();
                    self.log.push(event.method.clone());
                }
                "Runtime.executionContextCreated"
                    if params.pointer("/context/name").and_then(Value::as_str) == Some(WORLD) =>
                {
                    if let (Some(id), Some(frame)) = (
                        params.pointer("/context/id").and_then(Value::as_i64),
                        params
                            .pointer("/context/auxData/frameId")
                            .and_then(Value::as_str),
                    ) {
                        self.worlds.insert(id, frame.to_owned());
                        self.log.push(format!("{} {id} {frame}", event.method));
                    }
                }
                "Runtime.executionContextDestroyed" => {
                    if let Some(id) = params["executionContextId"].as_i64() {
                        self.worlds.remove(&id);
                        self.log.push(format!("{} {id}", event.method));
                    }
                }
                "Page.frameStartedLoading" | "Page.frameStoppedLoading" => {
                    self.log
                        .push(format!("{} {}", event.method, params["frameId"]));
                }
                "Page.frameNavigated" => {
                    self.log.push(format!(
                        "{} {} {}",
                        event.method, params["frame"]["id"], params["type"]
                    ));
                    if let Some(events::Update::Navigation {
                        frame_id,
                        restored: true,
                        ..
                    }) = events::decode(&event)
                    {
                        self.restored = Some(frame_id);
                    }
                }
                "Runtime.bindingCalled" if params["name"] == BINDING => {
                    let payload = params["payload"].as_str().unwrap_or_default();
                    let id = params["executionContextId"]
                        .as_i64()
                        .expect("binding call names its execution context");
                    self.log.push(format!("{} {id} {payload}", event.method));
                    if let Some(title) = observed_title(payload) {
                        let Some(frame) = self.worlds.get(&id).cloned() else {
                            panic!(
                                "title {title:?} came from unannounced context {id}; saw {:#?}",
                                self.log
                            );
                        };
                        return Some((title, frame));
                    }
                }
                _ => {}
            }
            None
        }

        async fn title(&mut self) -> (String, String) {
            let waited = tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    if let Some(announced) = self.observe().await {
                        return announced;
                    }
                }
            })
            .await;
            waited.unwrap_or_else(|_| {
                panic!("no title reached the actual binding; saw {:#?}", self.log)
            })
        }

        /// The title announced after a back/forward cache restore, with the frame of the restoring navigation.
        async fn restored_title(&mut self) -> ((String, String), String) {
            let waited = tokio::time::timeout(Duration::from_secs(10), async {
                let mut title = None;
                loop {
                    if let Some(announced) = self.observe().await {
                        title = Some(announced);
                    }
                    if let (Some(title), Some(frame)) = (&title, &self.restored) {
                        return (title.clone(), frame.clone());
                    }
                }
            })
            .await;
            waited.unwrap_or_else(|_| {
                panic!(
                    "the page was not restored with its title; saw {:#?}",
                    self.log
                )
            })
        }
    }

    const TITLE_DOCUMENT: &str = "<!doctype html><title>Initial</title><body>title fixture</body>";
    const OTHER_DOCUMENT: &str = "<!doctype html><title>Other</title><body>other site</body>";

    async fn serve_title_documents(listener: tokio::net::TcpListener) {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            tokio::spawn(async move {
                let mut request = Vec::new();
                let mut chunk = [0u8; 1024];
                while !request.windows(4).any(|end| end == b"\r\n\r\n") {
                    match stream.read(&mut chunk).await {
                        Ok(0) | Err(_) => return,
                        Ok(read) => request.extend_from_slice(&chunk[..read]),
                    }
                }
                let document = if request.starts_with(b"GET /other ") {
                    OTHER_DOCUMENT
                } else {
                    TITLE_DOCUMENT
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{document}",
                    document.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.shutdown().await;
            });
        }
    }

    async fn root_frame(page: &Page) -> String {
        let tree = page.command("Page.getFrameTree", json!({})).await.unwrap();
        tree.pointer("/frameTree/frame/id")
            .and_then(Value::as_str)
            .unwrap()
            .to_owned()
    }

    /// Installs the observer the way `Initializer` does and loads real documents, so titles travel the real binding:
    /// the initial title, a later dynamic title, no repeat of an unchanged title, and a back/forward cache restore.
    /// A restore creates no new document, so the observer does not rerun; the restored document announces its own
    /// title on `pageshow` from a world the restore itself announced.
    async fn titles_reach_the_actual_binding(browser: &Browser, page: &Page) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(serve_title_documents(listener));
        page.command(
            "Runtime.addBinding",
            json!({"name":BINDING,"executionContextName":WORLD}),
        )
        .await
        .unwrap();
        page.command(
            "Page.addScriptToEvaluateOnNewDocument",
            json!({"worldName":WORLD,"source":OBSERVE}),
        )
        .await
        .unwrap();
        let mut announced = Announcements::new(browser, page);
        page.navigate(&format!("http://127.0.0.1:{port}/"))
            .await
            .unwrap();
        let root = root_frame(page).await;
        let from_root = |title: &str| (title.to_owned(), root.clone());

        assert_eq!(announced.title().await, from_root("Initial"));
        page.evaluate("document.title='Later'", false)
            .await
            .unwrap();
        assert_eq!(announced.title().await, from_root("Later"));
        page.evaluate("document.title='Later'", false)
            .await
            .unwrap();
        page.evaluate("document.title='After'", false)
            .await
            .unwrap();
        assert_eq!(
            announced.title().await,
            from_root("After"),
            "an unchanged title was announced again"
        );

        // A different site, so the page above leaves in the back/forward cache instead of being discarded.
        page.navigate(&format!("http://localhost:{port}/other"))
            .await
            .unwrap();
        let other = root_frame(page).await;
        assert_eq!(announced.title().await, ("Other".to_owned(), other));
        let history = page
            .command("Page.getNavigationHistory", json!({}))
            .await
            .unwrap();
        let current = history["currentIndex"].as_u64().unwrap() as usize;
        let entry = history["entries"][current - 1]["id"].as_i64().unwrap();
        page.command("Page.navigateToHistoryEntry", json!({"entryId":entry}))
            .await
            .unwrap();
        let ((title, frame), restored) = announced.restored_title().await;
        assert_eq!(title, "After", "the restored document's own title");
        assert_eq!(
            frame, restored,
            "the title came from a world of the restored root frame"
        );
    }

    #[test]
    fn only_a_title_payload_names_a_title() {
        assert_eq!(
            observed_title(r#"{"kind":"title","title":"한글 \"quoted\" title"}"#).as_deref(),
            Some("한글 \"quoted\" title")
        );
        assert_eq!(
            observed_title(r#"{"kind":"title","title":""}"#).as_deref(),
            Some("")
        );
        for payload in [
            "text",
            "layout",
            "",
            "{}",
            r#"{"kind":"layout"}"#,
            r#"{"kind":"title"}"#,
            r#"{"kind":"title","title":7}"#,
            r#"["title","x"]"#,
        ] {
            assert_eq!(observed_title(payload), None, "{payload:?}");
        }
    }

    #[tokio::test]
    #[ignore = "requires OMPDESK_PREVIEW_TEST_BROWSER and OMPDESK_PREVIEW_TEST_SCRATCH"]
    async fn caret_measurement_does_not_refresh_itself_or_hide_user_mutations() {
        let executable = PathBuf::from(
            std::env::var_os("OMPDESK_PREVIEW_TEST_BROWSER").expect("trusted browser required"),
        );
        let scratch = PathBuf::from(
            std::env::var_os("OMPDESK_PREVIEW_TEST_SCRATCH").expect("scratch path required"),
        );
        assert!(executable.is_absolute() && scratch.is_absolute() && scratch.is_dir());
        let browser = Browser::launch(LaunchConfig {
            executable,
            profile_root: scratch.join(format!("measurement-{}", std::process::id())),
            command_timeout: Duration::from_secs(10),
        })
        .await
        .unwrap();
        let partition = browser.create_partition().await.unwrap();
        let page = browser
            .create_page(
                &partition,
                Viewport {
                    width: 640,
                    height: 480,
                    device_scale_factor: 1.0,
                },
            )
            .await
            .unwrap();
        let context = page.isolated_world(WORLD).await.unwrap();
        evaluate(&page, context, "globalThis.layouts=0;globalThis.__ompdeskNativeState=kind=>{if(kind==='layout')layouts++}").await;
        evaluate(&page, context, OBSERVE).await;
        evaluate(&page, context, "(()=>{const e=document.createElement('input');e.value='hello';document.body.appendChild(e);e.focus()})()").await;
        evaluate(&page, context, "layouts=0").await;
        let target = Target::new(&browser, &page.session_id);
        let key = SurfaceKey {
            view: 1,
            wc: 1,
            generation: 1,
        };
        for _ in 0..2 {
            let state = input::text_state(&target, key, 1.0, None).await.unwrap();
            assert!(state.caret.is_some());
            assert_eq!(evaluate(&page, context, "layouts").await, json!(0));
        }
        let mixed = evaluate(
            &page,
            context,
            r#"(async()=>{
            let internal;
            __ompdeskNativeComposition.measure(node=>{
                internal=node;
                const fragment=document.createDocumentFragment();
                fragment.append(node,document.createElement('p'));
                document.body.append(fragment);
                node.remove();
            });
            await Promise.resolve();
            const mixed=layouts;
            layouts=0;
            document.body.append(internal);
            await Promise.resolve();
            return [mixed,layouts];
        })()"#,
        )
        .await;
        assert_eq!(mixed, json!([1, 1]));
        #[cfg(target_os = "macos")]
        {
            use crate::preview_surface::{Input, MouseButton, MouseKind};
            use shell_core::hotkey::Mods;

            evaluate(&page, context, "globalThis.pointerEvents=[];for(const name of ['mouseover','mouseout','mousemove'])document.addEventListener(name,e=>pointerEvents.push([e.type,e.clientX,e.clientY,e.buttons]),true)").await;
            for (kind, x) in [(MouseKind::Enter, 20.0), (MouseKind::Leave, -1.0)] {
                input::apply(
                    &target,
                    Input::Mouse {
                        kind,
                        x,
                        y: 20.0,
                        button: MouseButton::None,
                        buttons: 0,
                        click_count: 0,
                        modifiers: Mods {
                            alt: false,
                            ctrl: false,
                            meta: false,
                            shift: false,
                        },
                    },
                    1.0,
                )
                .await
                .unwrap();
            }
            let events = evaluate(&page, context, "pointerEvents").await;
            let events = events.as_array().unwrap();
            assert!(
                events
                    .iter()
                    .any(|e| e[0] == "mouseover" && e[1] == 20 && e[2] == 20 && e[3] == 0),
                "{events:?}"
            );
            assert!(
                events
                    .iter()
                    .any(|e| e[0] == "mouseout" && e[1] == -1 && e[2] == 20 && e[3] == 0),
                "{events:?}"
            );
        }
        evaluate(
            &page,
            context,
            r#"(()=>{
            const frame=document.createElement('iframe');frame.id='native-write-frame';
            frame.srcdoc='<input id="child" value="child value">';
            document.body.replaceChildren(frame);
        })()"#,
        )
        .await;
        let ready = page.command("Runtime.evaluate",json!({
            "contextId":context,"awaitPromise":true,"returnByValue":true,
            "expression":"new Promise(resolve=>{const f=document.getElementById('native-write-frame');if(f.contentDocument?.getElementById('child'))resolve(true);else f.addEventListener('load',()=>resolve(true),{once:true})})"
        })).await.unwrap();
        assert_eq!(ready["result"]["value"], json!(true));
        let tree = page.command("Page.getFrameTree", json!({})).await.unwrap();
        let frame = tree
            .pointer("/frameTree/childFrames/0/frame/id")
            .and_then(serde_json::Value::as_str)
            .unwrap()
            .to_owned();
        let child_world = page
            .command(
                "Page.createIsolatedWorld",
                json!({"frameId":frame,"worldName":WORLD}),
            )
            .await
            .unwrap();
        let child_world = child_world["executionContextId"].as_i64().unwrap();
        evaluate(
            &page,
            child_world,
            "document.getElementById('child').focus()",
        )
        .await;
        let object = page
            .command(
                "Runtime.evaluate",
                json!({"contextId":child_world,"expression":"document.activeElement"}),
            )
            .await
            .unwrap();
        let object = object
            .pointer("/result/objectId")
            .and_then(serde_json::Value::as_str)
            .unwrap();
        let described = page
            .command("DOM.describeNode", json!({"objectId":object}))
            .await
            .unwrap();
        page.command("Runtime.releaseObject", json!({"objectId":object}))
            .await
            .unwrap();
        let focused = crate::preview::frame_scope::FocusedTarget {
            session: page.session_id.clone(),
            frame,
            backend: described
                .pointer("/node/backendNodeId")
                .and_then(serde_json::Value::as_i64)
                .unwrap(),
        };
        let child = Target::fixture_focused(&browser, &focused);
        input::apply(
            &child,
            crate::preview_surface::Input::CommitText {
                text: "새 값".into(),
                replacement: Some(crate::preview_surface::TextRange {
                    start: 0,
                    length: 11,
                }),
            },
            1.0,
        )
        .await
        .unwrap();
        assert_eq!(
            evaluate(&page, child_world, "document.activeElement.value").await,
            json!("새 값")
        );
        evaluate(&page, child_world, "document.activeElement.blur()").await;
        let error = input::apply(
            &child,
            crate::preview_surface::Input::CommitText {
                text: "must not reach another field".into(),
                replacement: Some(crate::preview_surface::TextRange {
                    start: 0,
                    length: 1,
                }),
            },
            1.0,
        )
        .await
        .unwrap_err();
        assert!(matches!(error.code.as_str(), "focus-changed" | "gone"));
        evaluate(
            &page,
            context,
            r#"(()=>{
            document.body.replaceChildren();
            const a=document.createElement('button'),b=document.createElement('button');
            a.textContent='original AX target';b.textContent='redirected AX target';
            globalThis.redirectedActivations=0;
            a.addEventListener('focus',()=>b.focus());
            b.addEventListener('click',()=>redirectedActivations++);
            document.body.append(a,b);
        })()"#,
        )
        .await;
        page.command(
            "Emulation.setFocusEmulationEnabled",
            json!({"enabled":true}),
        )
        .await
        .unwrap();
        let snapshot = crate::preview::accessibility::snapshot(&target, key, 1.0)
            .await
            .unwrap();
        let original = snapshot
            .nodes
            .iter()
            .find(|node| node.name.as_deref() == Some("original AX target"))
            .unwrap();
        let original = crate::preview_surface::AxTarget {
            node_id: original.node_id.clone(),
            frame_id: original.frame_id.clone(),
            backend_dom_node_id: original.backend_dom_node_id.unwrap(),
        };
        let error = crate::preview::accessibility::action(
            &target,
            &snapshot,
            original,
            crate::preview_surface::AxAction::Default,
        )
        .await
        .unwrap_err();
        assert!(matches!(error.code.as_str(), "stale" | "unsupported"));
        assert_eq!(
            evaluate(&page, context, "redirectedActivations").await,
            json!(0)
        );
        titles_reach_the_actual_binding(&browser, &page).await;
        browser.shutdown().await.unwrap();
    }
}
