use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use url::{Position, Url};

use crate::{hex, sessions};

type ResourceMac = Hmac<Sha256>;
pub(super) const MAX_SOURCE_URL: usize = 8192;

#[derive(Clone, Eq, Hash, PartialEq)]
pub(super) struct SourceOrigin {
    pub partition: String,
    pub scheme: String,
    prefix: String,
}

impl SourceOrigin {
    pub fn parse(partition: &str, url: &Url) -> Result<Self, String> {
        if url.cannot_be_a_base()
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.as_str().len() > MAX_SOURCE_URL
        {
            return Err("Preview resource URL requires a bounded, credential-free origin".into());
        }
        Ok(Self {
            partition: sessions::canonical(partition).to_owned(),
            scheme: url.scheme().to_owned(),
            prefix: url[..Position::BeforePath].to_owned(),
        })
    }

    pub fn source_url(&self, target: &str) -> Result<String, String> {
        if self.prefix.len() + target.len() > MAX_SOURCE_URL {
            return Err("Preview resource URL is too large".into());
        }
        let value = format!("{}{target}", self.prefix);
        let parsed = Url::parse(&value).map_err(|_| "Invalid Preview resource URL")?;
        if parsed.scheme() != self.scheme || parsed[..Position::BeforePath] != self.prefix {
            return Err("Preview resource left its captured origin".into());
        }
        Ok(value)
    }
}

pub(super) struct AppMedia {
    pub partition: String,
    key: [u8; 32],
}

impl AppMedia {
    pub fn new(partition: &str) -> Result<Self, String> {
        let partition = sessions::canonical(partition);
        if partition != sessions::canonical("app") {
            return Err("The fixed app media origin requires the canonical app session".into());
        }
        let mut key = [0; 32];
        getrandom::fill(&mut key).map_err(|_| "App media capability generation failed")?;
        Ok(Self {
            partition: partition.to_owned(),
            key,
        })
    }

    fn mac(&self, source: &str) -> Result<ResourceMac, String> {
        let mut mac = ResourceMac::new_from_slice(&self.key)
            .map_err(|_| "App media capability initialization failed")?;
        mac.update(b"OMPdesk app media gateway\0");
        mac.update(self.partition.as_bytes());
        mac.update(b"\0");
        mac.update(source.as_bytes());
        Ok(mac)
    }

    #[cfg(any(windows, test))]
    pub fn map(&self, origin: &str, source: &str) -> Result<String, String> {
        validate_media(source)?;
        let capability = hex(&self.mac(source)?.finalize().into_bytes());
        let mut mapped = Url::parse(&format!("{origin}/{capability}"))
            .map_err(|_| "App media origin is invalid")?;
        mapped.query_pairs_mut().append_pair("url", source);
        Ok(mapped.into())
    }

    pub fn source_url(&self, target: &str) -> Result<String, String> {
        let (path, query) = target
            .split_once('?')
            .ok_or("Missing app media capability")?;
        let signature = unhex(
            path.strip_prefix('/')
                .ok_or("Invalid app media capability")?,
        )?;
        let mut fields = url::form_urlencoded::parse(query.as_bytes());
        let (name, source) = fields.next().ok_or("Missing app media source")?;
        if name != "url" || fields.next().is_some() {
            return Err("Invalid app media source".into());
        }
        validate_media(&source)?;
        self.mac(&source)?
            .verify_slice(&signature)
            .map_err(|_| "Invalid app media capability")?;
        Ok(source.into_owned())
    }
}

struct MappedSource {
    source: SourceOrigin,
    _slot: OwnedSemaphorePermit,
}

pub(super) struct PreviewOrigins {
    pub partition: String,
    pub namespace: String,
    key: [u8; 32],
    sources: Mutex<HashMap<String, MappedSource>>,
    slots: Arc<Semaphore>,
}

impl PreviewOrigins {
    pub fn new(partition: &str, slots: Arc<Semaphore>) -> Result<Self, String> {
        let mut secret = [0; 64];
        getrandom::fill(&mut secret).map_err(|_| "Preview capability generation failed")?;
        let namespace = hex(&secret[..32]);
        let mut key = [0; 32];
        key.copy_from_slice(&secret[32..]);
        Ok(Self {
            partition: sessions::canonical(partition).to_owned(),
            namespace: format!("{}.{}.localhost", &namespace[..32], &namespace[32..]),
            key,
            sources: Mutex::new(HashMap::new()),
            slots,
        })
    }

    pub fn bypass_rule(&self, port: u16) -> String {
        format!("*.{}:{port}", self.namespace)
    }

    pub fn contains_hostname(&self, host: &str) -> bool {
        host == self.namespace
            || host
                .strip_suffix(&self.namespace)
                .is_some_and(|prefix| prefix.ends_with('.'))
    }

    pub fn map_authority(&self, source: SourceOrigin, port: u16) -> Result<String, String> {
        if source.partition != self.partition {
            return Err("Wrong Preview transport partition".into());
        }
        let mut mac = ResourceMac::new_from_slice(&self.key)
            .map_err(|_| "Preview capability initialization failed")?;
        mac.update(b"OMPdesk Preview origin\0");
        mac.update(self.partition.as_bytes());
        mac.update(b"\0");
        mac.update(source.prefix.as_bytes());
        let capability = hex(&mac.finalize().into_bytes());
        let authority = format!(
            "{}.{}.{}:{port}",
            &capability[..32],
            &capability[32..],
            self.namespace
        );
        let mut sources = self
            .sources
            .lock()
            .map_err(|_| "Preview origin mappings are unavailable")?;
        if let Some(existing) = sources.get(&authority) {
            if existing.source != source {
                return Err("Preview origin capability collision".into());
            }
        } else {
            let slot = self
                .slots
                .clone()
                .try_acquire_owned()
                .map_err(|_| "Too many live Preview resource origins")?;
            sources.insert(
                authority.clone(),
                MappedSource {
                    source,
                    _slot: slot,
                },
            );
        }
        Ok(authority)
    }

    pub fn source_url(&self, authority: &str, target: &str) -> Result<String, String> {
        let sources = self
            .sources
            .lock()
            .map_err(|_| "Preview origin mappings are unavailable")?;
        sources
            .get(authority)
            .ok_or("Unknown Preview origin capability")?
            .source
            .source_url(target)
    }
}

pub(super) enum Route {
    Preview(PreviewOrigins),
    AppMedia(AppMedia),
}

impl Route {
    pub fn partition(&self) -> &str {
        match self {
            Self::Preview(origins) => &origins.partition,
            Self::AppMedia(media) => &media.partition,
        }
    }

    pub fn source_url(&self, authority: &str, target: &str) -> Result<String, String> {
        match self {
            Self::Preview(origins) => origins.source_url(authority, target),
            Self::AppMedia(media) => media.source_url(target),
        }
    }

    pub fn contains_hostname(&self, hostname: &str) -> bool {
        match self {
            Self::Preview(origins) => origins.contains_hostname(hostname),
            Self::AppMedia(_) => hostname == "127.0.0.1",
        }
    }
}

pub(super) fn standard_scheme(scheme: &str) -> bool {
    matches!(
        scheme,
        "http" | "https" | "about" | "blob" | "data" | "file" | "ws" | "wss"
    )
}

pub(super) fn reserved_hostname(host: &str) -> bool {
    let mut labels = host.rsplit('.');
    let tld = labels.next();
    let second = labels.next().unwrap_or("");
    let first = labels.next().unwrap_or("");
    tld == Some("localhost")
        && first.len() == 32
        && second.len() == 32
        && first
            .bytes()
            .chain(second.bytes())
            .all(|b| b.is_ascii_hexdigit())
}

fn validate_media(source: &str) -> Result<(), String> {
    if source.len() > MAX_SOURCE_URL {
        return Err("App media URL is too large".into());
    }
    let url = Url::parse(source).map_err(|_| "Invalid app media URL")?;
    if url.scheme() != "omp-media"
        || url.host_str() != Some("stream")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path().len() <= 1
    {
        return Err("The app media gateway accepts only original media resource URLs".into());
    }
    Ok(())
}

fn unhex(value: &str) -> Result<[u8; 32], String> {
    if value.len() != 64 {
        return Err("Invalid app media capability".into());
    }
    let mut bytes = [0; 32];
    for (&[high, low], byte) in value.as_bytes().as_chunks::<2>().0.iter().zip(&mut bytes) {
        let digit = |b: u8| char::from(b).to_digit(16).map(|v| v as u8);
        *byte = digit(high)
            .zip(digit(low))
            .map(|(high, low)| (high << 4) | low)
            .ok_or("Invalid app media capability")?;
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_capability_cannot_be_retargeted_or_reused_after_gateway_restart() {
        let media = AppMedia::new("app").unwrap();
        let mapped = media
            .map("http://127.0.0.1:40000", "omp-media://stream/original")
            .unwrap();
        let url = Url::parse(&mapped).unwrap();
        let target = &url[Position::BeforePath..];
        assert_eq!(
            media.source_url(target).unwrap(),
            "omp-media://stream/original"
        );
        assert!(
            media
                .source_url(&target.replace("original", "another"))
                .is_err()
        );
        assert!(AppMedia::new("app").unwrap().source_url(target).is_err());
        assert!(
            media
                .map("http://127.0.0.1:40000", "file:///private/file")
                .is_err()
        );
    }

    #[test]
    fn original_visual_origin_and_root_relative_paths_survive_mapping() {
        let first = SourceOrigin::parse(
            "visual-a",
            &Url::parse("omp-visual://v1-0123456789abcdef/dir/page.html").unwrap(),
        )
        .unwrap();
        let second = SourceOrigin::parse(
            "visual-a",
            &Url::parse("omp-visual://v2-0123456789abcdef/dir/page.html").unwrap(),
        )
        .unwrap();
        assert!(first != second);
        assert_eq!(
            first.source_url("/assets/a.js?x=%2F").unwrap(),
            "omp-visual://v1-0123456789abcdef/assets/a.js?x=%2F"
        );
        let routes = PreviewOrigins::new("visual-a", Arc::new(Semaphore::new(2))).unwrap();
        let authority = routes.map_authority(first, 40000).unwrap();
        let hostname = authority.split_once(':').unwrap().0;
        assert!(reserved_hostname(hostname));
        assert!(hostname.split('.').all(|label| label.len() <= 63));
        let mapped = Url::parse(&format!("http://{hostname}:40000/dir/page.html")).unwrap();
        assert_eq!(
            mapped.join("/assets/a.js").unwrap().host_str(),
            mapped.host_str()
        );
        assert_eq!(mapped.join("a.css").unwrap().path(), "/dir/a.css");
    }
}
