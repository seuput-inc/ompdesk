use serde_json::{Value, json};
use shell_core::wire::WireError;
use shell_preview::Browser;

pub(super) struct Target<'a> {
    browser: &'a Browser,
    session: &'a str,
    key: Option<crate::preview_surface::SurfaceKey>,
    frame: Option<&'a str>,
}
impl<'a> Target<'a> {
    pub(super) fn new(browser: &'a Browser, session: &'a str) -> Self {
        Self {
            browser,
            session,
            key: None,
            frame: None,
        }
    }
    pub(super) fn guarded(
        browser: &'a Browser,
        session: &'a str,
        key: crate::preview_surface::SurfaceKey,
    ) -> Self {
        Self {
            browser,
            session,
            key: Some(key),
            frame: None,
        }
    }
    pub(super) fn frame(
        browser: &'a Browser,
        session: &'a str,
        frame: &'a str,
        key: crate::preview_surface::SurfaceKey,
    ) -> Self {
        Self {
            browser,
            session,
            key: Some(key),
            frame: Some(frame),
        }
    }
    pub(super) fn frame_id(&self) -> Option<&str> {
        self.frame
    }
    fn valid(&self) -> Result<(), WireError> {
        if let Some(key) = self.key {
            if super::surface::key(key.wc).ok() != Some(key) {
                return Err(WireError::new(
                    "gone",
                    "original native Preview document ended",
                ));
            }
        }
        Ok(())
    }
    pub(super) async fn command(&self, method: &str, params: Value) -> Result<Value, WireError> {
        self.valid()?;
        let result = self
            .browser
            .command(method, params, Some(self.session))
            .await
            .map_err(|error| WireError::new(error.code, error.message))?;
        self.valid()?;
        Ok(result)
    }
    pub(super) async fn isolated_world(&self, name: &str) -> Result<i64, WireError> {
        let tree;
        let frame = if let Some(frame) = self.frame {
            frame
        } else {
            tree = self.command("Page.getFrameTree", json!({})).await?;
            tree.pointer("/frameTree/frame/id")
                .and_then(Value::as_str)
                .ok_or_else(|| WireError::new("cdp", "actual Preview frame missing"))?
        };
        let world = self
            .command(
                "Page.createIsolatedWorld",
                json!({"frameId":frame,"worldName":name,"grantUniveralAccess":false}),
            )
            .await?;
        world["executionContextId"]
            .as_i64()
            .ok_or_else(|| WireError::new("cdp", "actual Preview isolated world missing"))
    }
}
