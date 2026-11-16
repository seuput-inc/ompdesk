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
    const state={marked:null,target:null};
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
    new MutationObserver(()=>notify('layout')).observe(document,{subtree:true,childList:true,attributes:true,characterData:true});
})()"#;
