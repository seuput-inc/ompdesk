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
const OBSERVE: &str = r#"(()=>{
    if(Object.hasOwn(globalThis,'__ompdeskNativeComposition'))return;
    const internal=new WeakSet();
    const state={marked:null,target:null,measure:fn=>{
        const node=document.createElement('div');
        internal.add(node);
        try{return fn(node)}finally{try{changes(observer.takeRecords())}finally{internal.delete(node)}}
    }};
    Object.defineProperty(globalThis,'__ompdeskNativeComposition',{value:state});
    const notify=kind=>globalThis.__ompdeskNativeState(kind);
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
    const changes=records=>{
        if(records.some(record=>record.type!=='childList'||(!record.addedNodes.length&&!record.removedNodes.length)||
            [...record.addedNodes,...record.removedNodes].some(node=>!internal.has(node))))notify('layout');
    };
    const observer=new MutationObserver(changes);
    observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});
})()"#;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::preview::{input, target::Target};
    use crate::preview_surface::SurfaceKey;
    use shell_preview::{Browser, LaunchConfig, Page, Viewport};
    use std::path::PathBuf;
    use std::time::Duration;

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
        browser.shutdown().await.unwrap();
    }
}
