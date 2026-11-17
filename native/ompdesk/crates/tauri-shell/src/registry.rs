use std::collections::{HashMap, VecDeque};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Identity {
    pub win: Option<u64>,
    pub wc: u64,
    pub generation: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    App,
    PreviewView { view: u64, parent: Option<u64> },
    PreviewOffscreen,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PageState {
    Live,
    Closing,
}

pub struct Page {
    pub state: PageState,
    pub kind: Kind,
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
    last_view: u64,
}

impl Registry {
    pub fn create(&mut self, win: u64, wc: u64) -> Result<String, &'static str> {
        self.create_window(win, wc, Kind::App)
    }
    pub fn create_offscreen(&mut self, win: u64, wc: u64) -> Result<String, &'static str> {
        self.create_window(win, wc, Kind::PreviewOffscreen)
    }
    fn create_window(&mut self, win: u64, wc: u64, kind: Kind) -> Result<String, &'static str> {
        if win == 0 || wc == 0 || win <= self.last_win || wc <= self.last_wc {
            return Err("Node window and webContents IDs must increase and never be reused");
        }
        self.last_win = win;
        self.last_wc = wc;
        let label = format!("node-window-{win}-page-{wc}");
        self.pages.insert(
            wc,
            Page {
                state: PageState::Live,
                kind,
                identity: Identity {
                    win: Some(win),
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

    pub fn create_view(&mut self, view: u64, wc: u64) -> Result<String, &'static str> {
        if view == 0 || wc == 0 || view <= self.last_view || wc <= self.last_wc {
            return Err("Node view and webContents IDs must increase and never be reused");
        }
        self.last_view = view;
        self.last_wc = wc;
        let label = format!("node-view-{view}-page-{wc}");
        self.pages.insert(
            wc,
            Page {
                state: PageState::Live,
                kind: Kind::PreviewView { view, parent: None },
                identity: Identity {
                    win: None,
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
    pub fn by_view(&self, view: u64) -> Option<&Page> {
        self.pages
            .values()
            .find(|page| matches!(page.kind, Kind::PreviewView { view: id, .. } if id == view))
    }
    pub fn is_preview(&self, wc: u64) -> bool {
        self.page(wc).is_some_and(|page| page.kind != Kind::App)
    }
    pub fn page(&self, wc: u64) -> Option<&Page> {
        self.pages.get(&wc)
    }
    pub fn page_mut(&mut self, wc: u64) -> Option<&mut Page> {
        self.pages.get_mut(&wc)
    }
    pub fn by_window(&self, win: u64) -> Option<&Page> {
        self.pages.values().find(|p| p.identity.win == Some(win))
    }
    pub fn by_label(&self, label: &str) -> Option<&Page> {
        self.pages
            .values()
            .find(|p| p.state == PageState::Live && p.kind == Kind::App && p.label == label)
    }
    pub fn current(&self, id: Identity) -> bool {
        self.page(id.wc)
            .is_some_and(|p| p.state == PageState::Live && p.identity == id)
    }
    pub fn navigate(&mut self, wc: u64, url: String) -> Option<Identity> {
        let identity = self.invalidate(wc)?;
        let page = self.pages.get_mut(&wc)?;
        page.url = url;
        page.loading = true;
        Some(identity)
    }
    pub fn invalidate(&mut self, wc: u64) -> Option<Identity> {
        let page = self
            .pages
            .get_mut(&wc)
            .filter(|page| page.state == PageState::Live)?;
        page.identity.generation = page.identity.generation.checked_add(1)?;
        page.ready = false;
        page.pushes.clear();
        Some(page.identity)
    }
    pub fn set_parent(&mut self, wc: u64, parent: Option<u64>) -> Result<(), &'static str> {
        if parent.is_some_and(|win| {
            !self
                .by_window(win)
                .is_some_and(|page| page.kind == Kind::App && page.state == PageState::Live)
        }) {
            return Err("native Preview parent must be a live app window");
        }
        let page = self
            .pages
            .get_mut(&wc)
            .filter(|page| page.state == PageState::Live)
            .ok_or("Preview view ended")?;
        let Kind::PreviewView { parent: owner, .. } = &mut page.kind else {
            return Err("page is not a native view");
        };
        *owner = parent;
        Ok(())
    }
    pub fn children(&self, win: u64) -> Vec<u64> {
        self.pages
            .values()
            .filter(
                |page| matches!(page.kind,Kind::PreviewView{parent:Some(parent),..}if parent==win),
            )
            .map(|page| page.identity.wc)
            .collect()
    }
    pub fn begin_close(&mut self, wc: u64) -> Option<Identity> {
        let page = self.pages.get_mut(&wc)?;
        page.state = PageState::Closing;
        Some(page.identity)
    }
    pub fn remove(&mut self, wc: u64) -> Option<Page> {
        self.pages.remove(&wc)
    }
}

/// The Vite dev server's origin `bun run dev` (scripts/dev.ts) loads the app page from; set only in a checkout's run.
static DEV_ORIGIN: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// `ELECTRON_RENDERER_URL` as the dev server's origin: `http` on a loopback host with an explicit port, nothing else.
pub fn dev_origin(renderer_url: &str) -> Option<url::Url> {
    let parsed = url::Url::parse(renderer_url).ok()?;
    let loopback = match parsed.host()? {
        url::Host::Domain(name) => name == "localhost",
        url::Host::Ipv4(ip) => ip.is_loopback(),
        url::Host::Ipv6(ip) => ip.is_loopback(),
    };
    if parsed.scheme() != "http"
        || !loopback
        || parsed.port().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return None;
    }
    url::Url::parse(&parsed.origin().ascii_serialization()).ok()
}

/// Trusts the dev server's pages as the app's own for the rest of this run.
pub fn allow_dev_origin(origin: &url::Url) {
    let _ = DEV_ORIGIN.set(origin.origin().ascii_serialization());
}

pub fn trusted_url(url: &str) -> bool {
    trusted_under(url, DEV_ORIGIN.get().map(String::as_str))
}

fn trusted_under(url: &str, dev_origin: Option<&str>) -> bool {
    // Parse the authority, not a prefix such as app://ompdesk.attacker/.
    let base = url.split(['?', '#']).next().unwrap_or(url);
    base == "app://ompdesk"
        || base.starts_with("app://ompdesk/")
        || (cfg!(windows)
            && (base == "http://app.localhost" || base.starts_with("http://app.localhost/")))
        || dev_origin.is_some_and(|origin| {
            base.strip_prefix(origin)
                .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
        })
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
    fn preview_and_app_share_non_reused_contents_ids_without_fake_window_owners() {
        let mut registry = Registry::default();
        registry.create(1, 1).unwrap();
        let label = registry.create_view(1, 2).unwrap();
        assert_eq!(registry.page(2).unwrap().identity.win, None);
        assert!(registry.by_label(&label).is_none());
        assert_eq!(registry.by_view(1).unwrap().identity.wc, 2);
        assert!(registry.create_offscreen(2, 2).is_err());
        registry.create_offscreen(2, 3).unwrap();
        assert_eq!(registry.by_window(2).unwrap().kind, Kind::PreviewOffscreen);
        let identity = registry
            .navigate(2, "https://example.invalid".into())
            .unwrap();
        registry.remove(2);
        assert!(!registry.current(identity));
        assert!(registry.create_view(1, 4).is_err());
        assert!(registry.create(3, 3).is_err());
        registry.create(3, 4).unwrap();
    }
    #[test]
    fn app_origin_lookalikes_are_denied() {
        assert!(trusted_url("app://ompdesk/index.html?x=1"));
        assert_eq!(
            trusted_url("http://app.localhost/index.html"),
            cfg!(windows)
        );
        for url in [
            "app://ompdesk.attacker/",
            "app://ompdesk@attacker/",
            "https://ompdesk/",
            "file:///index.html",
            "app://ompdesk:80/",
            "http://app.localhost.attacker/",
            "http://app.localhost@attacker/",
            "http://app.localhost:80/",
        ] {
            assert!(!trusted_url(url), "{url}");
        }
    }
    #[test]
    fn only_a_loopback_http_origin_with_a_port_is_a_dev_server() {
        assert_eq!(
            dev_origin("http://localhost:5173").unwrap().as_str(),
            "http://localhost:5173/"
        );
        assert_eq!(
            dev_origin("http://127.0.0.1:5174/index.html?x=1")
                .unwrap()
                .as_str(),
            "http://127.0.0.1:5174/"
        );
        assert!(dev_origin("http://[::1]:5173").is_some());
        for url in [
            "https://localhost:5173",
            "http://localhost",
            "http://example.com:5173",
            "http://localhost.attacker:5173",
            "http://user@localhost:5173",
            "app://ompdesk/",
            "not a url",
        ] {
            assert!(dev_origin(url).is_none(), "{url}");
        }
    }
    #[test]
    fn the_dev_origin_is_trusted_only_when_set_and_only_itself() {
        let origin = "http://localhost:5173";
        assert!(!trusted_under("http://localhost:5173/", None));
        assert!(trusted_under("http://localhost:5173/?slot=0", Some(origin)));
        assert!(trusted_under("http://localhost:5173", Some(origin)));
        assert!(trusted_under("app://ompdesk/index.html", Some(origin)));
        for url in [
            "http://localhost:51730/",
            "http://localhost:5173@attacker/",
            "http://localhost:5173.attacker/",
            "http://127.0.0.1:5173/",
            "https://localhost:5173/",
        ] {
            assert!(!trusted_under(url, Some(origin)), "{url}");
        }
    }
}
