//! The native webview identifies an app window, but not the frame that invoked a command.
//! Only the top frame gets its window's key. Never return that key from an IPC handshake.
#[derive(Clone, Copy)]
pub(crate) struct Document<'a> {
    pub label: &'a str,
    pub generation: u64,
    pub url: &'a str,
    pub key: Option<&'a str>,
}

pub(crate) fn permits(
    owner: Option<Document<'_>>,
    caller: Document<'_>,
    dev_origin: Option<&str>,
) -> bool {
    let Some(owner) = owner else {
        return false;
    };
    let document = |url: &str| {
        let path = url.split(['?', '#']).next().unwrap_or(url);
        [
            Some("app://ompdesk"),
            cfg!(windows).then_some("http://app.localhost"),
            dev_origin,
        ]
        .into_iter()
        .flatten()
        .any(|origin| matches!(path.strip_prefix(origin), Some("" | "/" | "/index.html")))
    };
    owner.label == caller.label
        && owner.generation == caller.generation
        && owner.key.is_some()
        && owner.key == caller.key
        && document(owner.url)
        && document(caller.url)
        && owner.url.split('#').next() == caller.url.split('#').next()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_the_owning_top_document_can_control_its_window() {
        let page = Document {
            label: "window-one",
            generation: 2,
            url: "app://ompdesk/index.html?slot=1",
            key: Some("private-one"),
        };
        let allows = |caller| permits(Some(page), caller, None);
        assert!(allows(Document {
            url: "app://ompdesk/index.html?slot=1#tab",
            ..page
        }));
        assert!(!allows(Document { key: None, ..page })); // Subframe: same webview URL, no preload key.
        assert!(!allows(Document {
            key: Some("private-two"),
            ..page
        }));
        assert!(!allows(Document {
            label: "window-two",
            ..page
        }));
        assert!(!allows(Document {
            generation: 1,
            ..page
        }));
        assert!(!allows(Document {
            url: "app://ompdesk/index.html?slot=2",
            ..page
        }));
        assert!(!permits(None, page, None)); // Preview, closing or removed window.
        for url in [
            "app://ompdesk/__profile/migrate",
            "app://ompdesk/other.html",
            "app://ompdesk.example/index.html",
            "about:blank",
            "https://example.org/",
        ] {
            let other = Document { url, ..page };
            assert!(!allows(other));
            assert!(!permits(Some(other), other, None));
        }
        let dev = Document {
            url: "http://localhost:5173/?slot=1",
            ..page
        };
        assert!(!permits(Some(dev), dev, None));
        assert!(permits(Some(dev), dev, Some("http://localhost:5173")));
    }
}
