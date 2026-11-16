//! Private HTTP resource transport; canonical session and Node handlers remain the only resource authority.

mod http;
mod mapping;
mod server;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Weak};

use tokio::sync::{Mutex, Semaphore};
use url::{Position, Url};

use crate::sessions::{self, protocol::GatewayConsumer};
use mapping::{AppMedia, PreviewOrigins, Route, SourceOrigin, reserved_hostname, standard_scheme};
use server::Origin;

const MAX_ORIGINS: usize = 1024;
const MAX_PARTITIONS: usize = 1024;
const MAX_CONNECTIONS: usize = 64;
const MAX_MAPPED_URL: usize = mapping::MAX_SOURCE_URL * 3 + 512;

struct Live {
    app_media: Option<Arc<Origin>>,
    preview: HashMap<String, Arc<Origin>>,
    retiring: Vec<Arc<Origin>>,
    consumer: Option<GatewayConsumer>,
}

enum State {
    Live(Live),
    Stopping(Vec<Arc<Origin>>),
    Stopped,
}

#[derive(Clone)]
pub struct PreviewTransport {
    pub proxy_bypass_rule: String,
    origin: Weak<server::Configuration>,
}

impl PreviewTransport {
    pub fn is_live(&self) -> bool {
        self.origin.upgrade().is_some_and(|origin| origin.alive())
    }
}

pub struct Gateway {
    state: Mutex<State>,
    slots: Arc<Semaphore>,
    origin_slots: Arc<Semaphore>,
    shutdown: Mutex<()>,
    app_media_port: AtomicU16,
}

impl Default for Gateway {
    fn default() -> Self {
        Self::new()
    }
}

impl Gateway {
    /// Construction alone does not advertise a streamed custom-scheme consumer.
    pub fn new() -> Self {
        Self {
            state: Mutex::new(State::Live(Live {
                app_media: None,
                preview: HashMap::new(),
                retiring: Vec::new(),
                consumer: None,
            })),
            slots: Arc::new(Semaphore::new(MAX_CONNECTIONS)),
            origin_slots: Arc::new(Semaphore::new(MAX_ORIGINS)),
            shutdown: Mutex::new(()),
            app_media_port: AtomicU16::new(0),
        }
    }

    /// Bind before the first app navigation; A inserts only this exact origin into img/media CSP.
    pub async fn reserve_app_media(&self, partition: &str) -> Result<String, String> {
        let partition = sessions::canonical(partition);
        if partition != sessions::canonical("app") {
            return Err("The fixed app media origin requires the canonical app session".into());
        }
        let mut state = self.state.lock().await;
        let live = running(&mut state)?;
        if let Some(origin) = &live.app_media {
            ensure_alive(origin)?;
            if origin.config.route.partition() != partition {
                return Err("Wrong app media partition".into());
            }
            return Ok(origin.base.clone());
        }
        let route = AppMedia::new(partition)?;
        let origin = Origin::bind(Route::AppMedia(route), self.slots.clone()).await?;
        let base = origin.base.clone();
        self.app_media_port.store(origin.port, Ordering::Release);
        live.app_media = Some(origin);
        Ok(base)
    }

    /// C reserves this endpoint before creating the canonical BrowserContext or metadata page.
    pub async fn reserve_preview_partition(
        &self,
        partition: &str,
    ) -> Result<PreviewTransport, String> {
        let partition = sessions::canonical(partition);
        let mut state = self.state.lock().await;
        let live = running(&mut state)?;
        if let Some(origin) = live.preview.get(partition) {
            ensure_alive(origin)?;
            return preview_transport(origin);
        }
        if live.preview.len() + live.retiring.len() >= MAX_PARTITIONS {
            return Err("Too many live Preview resource partitions".into());
        }
        let routes = PreviewOrigins::new(partition, self.origin_slots.clone())?;
        let origin = Origin::bind(Route::Preview(routes), self.slots.clone()).await?;
        let transport = preview_transport(&origin)?;
        live.preview.insert(partition.to_owned(), origin);
        Ok(transport)
    }

    /// A supplies the actual canonical token only after its URL mapper and Windows 302 route are installed.
    pub async fn activate(&self, consumer: GatewayConsumer) -> Result<(), String> {
        let mut state = self.state.lock().await;
        let live = running(&mut state)?;
        let origin = live
            .app_media
            .as_ref()
            .ok_or("Reserve the app media listener before gateway activation")?;
        ensure_alive(origin)?;
        if live.consumer.is_some() {
            return Err("Resource gateway is already active".into());
        }
        live.consumer = Some(consumer);
        Ok(())
    }

    pub async fn map_url(&self, partition: &str, original: &str) -> Result<Option<String>, String> {
        if original.len() > MAX_MAPPED_URL {
            return Err("Preview resource URL is too large".into());
        }
        let url = Url::parse(original).map_err(|_| "Invalid Preview resource URL")?;
        if standard_scheme(url.scheme()) {
            if self.is_gateway_origin(original).await {
                let source = self
                    .original_url(partition, original)
                    .await?
                    .ok_or("Unknown resource gateway origin")?;
                let scheme = source
                    .split_once(':')
                    .ok_or("Invalid original resource URL")?
                    .0;
                if !sessions::handles_scheme(partition, scheme) {
                    return Err("Custom resource scheme is not registered in this session".into());
                }
                let mut state = self.state.lock().await;
                let live = active(&mut state)?;
                let origin = live
                    .app_media
                    .iter()
                    .chain(live.preview.values())
                    .find(|origin| same_origin(&url, origin))
                    .ok_or("Unknown resource gateway origin")?;
                origin.config.require_protected_transport()?;
                return Ok(Some(original.to_owned()));
            }
            return Ok(None);
        }
        let source = SourceOrigin::parse(partition, &url)?;
        if !sessions::handles_scheme(&source.partition, &source.scheme) {
            return Err("Custom resource scheme is not registered in this session".into());
        }
        let mut state = self.state.lock().await;
        let live = active(&mut state)?;
        let origin = live
            .preview
            .get(&source.partition)
            .ok_or("Reserve Preview transport before creating its BrowserContext")?;
        ensure_alive(origin)?;
        origin.config.require_protected_transport()?;
        match &origin.config.route {
            Route::Preview(routes) => {
                let authority = routes.map_authority(source, origin.port)?;
                Ok(Some(format!(
                    "http://{authority}{}",
                    &url[Position::BeforePath..]
                )))
            }
            Route::AppMedia(_) => Err("Preview transport has the wrong route".into()),
        }
    }

    pub async fn app_media_url(&self, partition: &str, original: &str) -> Result<String, String> {
        let mut state = self.state.lock().await;
        let live = active(&mut state)?;
        let origin = live
            .app_media
            .as_ref()
            .ok_or("App media listener is unavailable")?;
        ensure_alive(origin)?;
        if sessions::canonical(partition) != origin.config.route.partition()
            || !sessions::handles_scheme(partition, "omp-media")
        {
            return Err("App media scheme is not registered in this session".into());
        }
        match &origin.config.route {
            Route::AppMedia(media) => media.map(&origin.base, original),
            Route::Preview(_) => Err("App media listener has the wrong route".into()),
        }
    }

    /// Reverse before navigation approval, state, errors and window-open metadata leave the native host.
    /// An unrecognized reserved endpoint is an error, never an external HTTP fallback.
    pub async fn original_url(
        &self,
        partition: &str,
        mapped: &str,
    ) -> Result<Option<String>, String> {
        if mapped.len() > MAX_MAPPED_URL {
            return Err("Resource gateway URL is too large".into());
        }
        let url = Url::parse(mapped).map_err(|_| "Invalid resource gateway URL")?;
        let mut state = self.state.lock().await;
        let live = running(&mut state)?;
        if let Some(origin) = live
            .app_media
            .iter()
            .chain(live.preview.values())
            .find(|origin| same_origin(&url, origin))
        {
            if live.consumer.is_none()
                || sessions::canonical(partition) != origin.config.route.partition()
            {
                return Err("Resource gateway belongs to another or inactive session".into());
            }
            ensure_alive(origin)?;
            let target = &url[Position::BeforePath..Position::AfterQuery];
            let mut original = origin
                .config
                .route
                .source_url(&url[Position::BeforeHost..Position::BeforePath], target)?;
            if let Some(fragment) = url.fragment() {
                if let Some(old) = original.find('#') {
                    original.truncate(old);
                }
                original.push('#');
                original.push_str(fragment);
            }
            return Ok(Some(original));
        }
        if internal_endpoint(&url, live) {
            return Err("Unknown or retired resource gateway origin".into());
        }
        Ok(None)
    }

    pub async fn is_gateway_origin(&self, value: &str) -> bool {
        if value.len() > MAX_MAPPED_URL {
            return true;
        }
        let Ok(url) = Url::parse(value) else {
            return false;
        };
        if url.host_str() == Some("127.0.0.1")
            && url
                .port()
                .is_some_and(|port| port == self.app_media_port.load(Ordering::Acquire))
        {
            return true;
        }
        let state = self.state.lock().await;
        match &*state {
            State::Live(live) => internal_endpoint(&url, live),
            State::Stopping(origins) => {
                url.host_str().is_some_and(reserved_hostname)
                    || origins.iter().any(|origin| same_origin(&url, origin))
            }
            State::Stopped => url.host_str().is_some_and(reserved_hostname),
        }
    }

    /// Preview contexts release their own listeners. The fixed shared app media origin lasts until shutdown.
    pub async fn close_partition(&self, partition: &str) -> Result<(), String> {
        let partition = sessions::canonical(partition);
        let origins = {
            let mut state = self.state.lock().await;
            let live = running(&mut state)?;
            if let Some(origin) = live.preview.remove(partition) {
                live.retiring.push(origin);
            }
            let origins: Vec<_> = live.retiring.iter()
                .filter(|origin| origin.config.route.partition() == partition)
                .cloned()
                .collect();
            for origin in &origins {
                origin.cancel();
            }
            origins
        };
        let result = join_all(&origins).await;
        if let State::Live(live) = &mut *self.state.lock().await {
            live.retiring
                .retain(|candidate| !origins.iter().any(|origin| Arc::ptr_eq(candidate, origin)));
        }
        result
    }

    pub async fn shutdown(&self) -> Result<(), String> {
        let _shutdown = self.shutdown.lock().await;
        let origins = {
            let mut state = self.state.lock().await;
            match std::mem::replace(&mut *state, State::Stopped) {
                State::Stopped => return Ok(()),
                State::Stopping(origins) => {
                    *state = State::Stopping(origins.clone());
                    origins
                }
                State::Live(live) => {
                    let origins: Vec<_> = live
                        .app_media
                        .into_iter()
                        .chain(live.preview.into_values())
                        .chain(live.retiring)
                        .collect();
                    for origin in &origins {
                        origin.cancel();
                    }
                    drop(live.consumer);
                    *state = State::Stopping(origins.clone());
                    origins
                }
            }
        };
        let result = join_all(&origins).await;
        *self.state.lock().await = State::Stopped;
        result
    }
}

fn running(state: &mut State) -> Result<&mut Live, String> {
    match state {
        State::Live(live) => Ok(live),
        State::Stopping(_) | State::Stopped => Err("Resource gateway is shut down".into()),
    }
}

fn active(state: &mut State) -> Result<&mut Live, String> {
    let live = running(state)?;
    if live.consumer.is_none() {
        return Err("Resource gateway routes are not installed".into());
    }
    Ok(live)
}

fn ensure_alive(origin: &Origin) -> Result<(), String> {
    if origin.alive() {
        Ok(())
    } else {
        Err("Resource gateway listener ended".into())
    }
}

fn preview_transport(origin: &Arc<Origin>) -> Result<PreviewTransport, String> {
    let rule = origin
        .config
        .proxy_bypass_rule
        .as_ref()
        .ok_or("Preview transport has the wrong route")?;
    Ok(PreviewTransport {
        proxy_bypass_rule: rule.clone(),
        origin: Arc::downgrade(&origin.config),
    })
}

fn same_origin(url: &Url, origin: &Origin) -> bool {
    url.scheme() == "http"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port() == Some(origin.port)
        && url
            .host_str()
            .is_some_and(|host| origin.config.route.contains_hostname(host))
}

fn internal_endpoint(url: &Url, live: &Live) -> bool {
    url.host_str().is_some_and(reserved_hostname)
        || (url.host_str() == Some("127.0.0.1")
            && url.port().is_some_and(|port| {
                live.app_media
                    .iter()
                    .chain(live.preview.values())
                    .any(|origin| origin.port == port)
            }))
}

async fn join_all(origins: &[Arc<Origin>]) -> Result<(), String> {
    let mut error = None;
    for origin in origins {
        if let Err(failure) = origin.join().await {
            error.get_or_insert(failure);
        }
    }
    error.map_or(Ok(()), Err)
}
