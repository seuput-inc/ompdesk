use std::collections::{HashMap, VecDeque};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Identity {
    pub win: u64,
    pub wc: u64,
    pub generation: u64,
}

pub struct Page {
    pub identity: Identity,
    pub label: String,
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub zoom: f64,
    pub ready: bool,
    pub pushes: VecDeque<String>,
}

#[derive(Default)]
pub struct Registry {
    pages: HashMap<u64, Page>,
    last_win: u64,
    last_wc: u64,
}

impl Registry {
    pub fn create(&mut self, win: u64, wc: u64) -> Result<String, &'static str> {
        if win == 0 || wc == 0 || win <= self.last_win || wc <= self.last_wc {
            return Err("Node window and webContents IDs must increase and never be reused");
        }
        self.last_win = win;
        self.last_wc = wc;
        let label = format!("node-window-{win}-page-{wc}");
        self.pages.insert(
            wc,
            Page {
                identity: Identity {
                    win,
                    wc,
                    generation: 0,
                },
                label: label.clone(),
                url: "about:blank".into(),
                title: String::new(),
                loading: false,
                zoom: 1.0,
                ready: false,
                pushes: VecDeque::new(),
            },
        );
        Ok(label)
    }

    pub fn page(&self, wc: u64) -> Option<&Page> {
        self.pages.get(&wc)
    }
    pub fn page_mut(&mut self, wc: u64) -> Option<&mut Page> {
        self.pages.get_mut(&wc)
    }
    pub fn by_window(&self, win: u64) -> Option<&Page> {
        self.pages.values().find(|p| p.identity.win == win)
    }
    pub fn by_label(&self, label: &str) -> Option<&Page> {
        self.pages.values().find(|p| p.label == label)
    }
    pub fn current(&self, id: Identity) -> bool {
        self.page(id.wc).is_some_and(|p| p.identity == id)
    }
    pub fn navigate(&mut self, wc: u64, url: String) -> Option<Identity> {
        let page = self.pages.get_mut(&wc)?;
        page.identity.generation = page.identity.generation.checked_add(1)?;
        page.url = url;
        page.loading = true;
        page.ready = false;
        page.pushes.clear();
        Some(page.identity)
    }
    pub fn remove(&mut self, wc: u64) -> Option<Page> {
        self.pages.remove(&wc)
    }
}

pub fn trusted_url(url: &str) -> bool {
    // Parse the authority, not a prefix such as app://ompdesk.attacker/.
    let base = url.split(['?', '#']).next().unwrap_or(url);
    base == "app://ompdesk"
        || base.starts_with("app://ompdesk/")
        || (cfg!(windows)
            && (base == "http://app.ompdesk" || base.starts_with("http://app.ompdesk/")))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn closed_ids_and_failed_creates_cannot_be_reused() {
        let mut registry = Registry::default();
        registry.create(1, 1).unwrap();
        registry.remove(1);
        assert!(registry.create(1, 2).is_err());
        assert!(registry.create(2, 1).is_err());
        assert!(registry.create(2, 2).is_ok());
    }
    #[test]
    fn navigation_invalidates_original_callback_identity() {
        let mut registry = Registry::default();
        registry.create(1, 1).unwrap();
        let old = registry
            .navigate(1, "app://ompdesk/index.html".into())
            .unwrap();
        let new = registry
            .navigate(1, "app://ompdesk/index.html?next".into())
            .unwrap();
        assert!(!registry.current(old));
        assert!(registry.current(new));
        registry.remove(1);
        assert!(!registry.current(new));
    }
    #[test]
    fn app_origin_lookalikes_are_denied() {
        assert!(trusted_url("app://ompdesk/index.html?x=1"));
        for url in [
            "app://ompdesk.attacker/",
            "app://ompdesk@attacker/",
            "https://ompdesk/",
            "file:///index.html",
            "app://ompdesk:80/",
        ] {
            assert!(!trusted_url(url), "{url}");
        }
    }
}
