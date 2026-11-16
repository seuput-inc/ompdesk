use std::net::Ipv4Addr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Mutex, Semaphore, watch};
use tokio::task::{JoinHandle, JoinSet};

use super::http::{self, Rejection};
use super::mapping::Route;
use crate::sessions::{self, protocol};

pub(super) struct Configuration {
    authority: String,
    pub route: Route,
    pub proxy_bypass_rule: Option<String>,
    alive: AtomicBool,
}

impl Configuration {
    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    pub fn require_protected_transport(self: &Arc<Self>) -> Result<(), String> {
        let Some(expected) = self.proxy_bypass_rule.as_deref() else {
            return Ok(());
        };
        let actual = sessions::preview::protected_transport(self.route.partition())?;
        if !actual.is_live()
            || !Weak::ptr_eq(&actual.origin, &Arc::downgrade(self))
            || actual.proxy_bypass_rule != expected
        {
            return Err("Preview context is not protected by this actual private transport".into());
        }
        Ok(())
    }
}

enum Completion {
    Running(JoinHandle<Result<(), String>>),
    Finished(Result<(), String>),
}

pub(super) struct Origin {
    pub base: String,
    pub port: u16,
    pub config: Arc<Configuration>,
    stop: watch::Sender<bool>,
    task: Mutex<Completion>,
}

impl Origin {
    pub async fn bind(route: Route, slots: Arc<Semaphore>) -> Result<Arc<Self>, String> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|_| "Private resource listener could not bind")?;
        let port = listener
            .local_addr()
            .map_err(|_| "Private resource listener has no address")?
            .port();
        let hostname = match &route {
            Route::Preview(origins) => origins.namespace.as_str(),
            Route::AppMedia(_) => "127.0.0.1",
        };
        let authority = format!("{hostname}:{port}");
        let base = format!("http://{authority}");
        let (stop, cancelled) = watch::channel(false);
        let proxy_bypass_rule = match &route {
            Route::Preview(origins) => Some(origins.bypass_rule(port)),
            Route::AppMedia(_) => None,
        };
        let config = Arc::new(Configuration {
            authority,
            route,
            proxy_bypass_rule,
            alive: AtomicBool::new(true),
        });
        let task = tokio::spawn(serve(listener, config.clone(), slots, cancelled));
        Ok(Arc::new(Self {
            base,
            port,
            config,
            stop,
            task: Mutex::new(Completion::Running(task)),
        }))
    }

    pub fn alive(&self) -> bool {
        self.config.alive()
    }

    pub fn cancel(&self) {
        self.stop.send_replace(true);
    }

    pub async fn join(&self) -> Result<(), String> {
        self.cancel();
        let mut task = self.task.lock().await;
        if let Completion::Running(worker) = &mut *task {
            let result = worker.await
                .map_err(|_| "Private resource listener task failed".to_string())
                .and_then(|result| result);
            *task = Completion::Finished(result);
        }
        match &*task {
            Completion::Finished(result) => result.clone(),
            Completion::Running(_) => unreachable!(),
        }
    }

    #[cfg(test)]
    pub async fn hold_join(&self) -> impl Drop + Send + '_ {
        self.task.lock().await
    }
}

impl Drop for Origin {
    fn drop(&mut self) {
        self.cancel();
    }
}

struct Alive(Arc<Configuration>);
impl Drop for Alive {
    fn drop(&mut self) {
        self.0.alive.store(false, Ordering::Release);
    }
}

async fn cancelled(receiver: &mut watch::Receiver<bool>) {
    loop {
        if *receiver.borrow_and_update() {
            return;
        }
        if receiver.changed().await.is_err() {
            return;
        }
    }
}

async fn serve(
    listener: TcpListener,
    config: Arc<Configuration>,
    slots: Arc<Semaphore>,
    mut stop: watch::Receiver<bool>,
) -> Result<(), String> {
    let _alive = Alive(config.clone());
    let mut connections = JoinSet::new();
    let result = loop {
        tokio::select! {
            biased;
            _ = cancelled(&mut stop) => break Ok(()),
            _ = connections.join_next(), if !connections.is_empty() => {},
            accepted = listener.accept() => {
                let (stream, peer) = match accepted {
                    Ok(value) => value,
                    Err(_) => break Err("Private resource listener failed".to_string()),
                };
                if peer.ip() != Ipv4Addr::LOCALHOST { continue; }
                let Ok(permit) = slots.clone().try_acquire_owned() else { continue; };
                let config = config.clone();
                let stop = stop.clone();
                connections.spawn(async move {
                    let _permit = permit;
                    connection(stream, config, stop).await;
                });
            }
        }
    };
    drop(listener);
    connections.abort_all();
    while connections.join_next().await.is_some() {}
    result
}

async fn connection(
    stream: TcpStream,
    config: Arc<Configuration>,
    mut stop: watch::Receiver<bool>,
) {
    let route = &config.route;
    let authority = &config.authority;
    let (mut reader, mut writer) = stream.into_split();
    let request = tokio::select! {
        biased;
        _ = cancelled(&mut stop) => return,
        result = tokio::time::timeout(Duration::from_secs(30), http::read_request(&mut reader)) => {
            match result {
                Ok(Ok(request)) => request,
                Ok(Err(error)) => { let _ = http::reject(&mut writer, &error).await; return; }
                Err(_) => { let _ = http::reject(&mut writer, &Rejection { status:408, reason:"Request Timeout" }).await; return; }
            }
        }
    };
    if matches!(route, Route::AppMedia(_)) && !request.host.eq_ignore_ascii_case(authority) {
        let _ = http::reject(
            &mut writer,
            &Rejection {
                status: 404,
                reason: "Not Found",
            },
        )
        .await;
        return;
    }
    if matches!(route, Route::AppMedia(_)) && !matches!(request.method.as_str(), "GET" | "HEAD") {
        let _ = http::reject(
            &mut writer,
            &Rejection {
                status: 405,
                reason: "Method Not Allowed",
            },
        )
        .await;
        return;
    }
    if matches!(route, Route::AppMedia(_)) && !request.body.is_empty() {
        let _ = http::reject(
            &mut writer,
            &Rejection {
                status: 400,
                reason: "Bad Request",
            },
        )
        .await;
        return;
    }
    let source = match route.source_url(&request.host, &request.target) {
        Ok(source) => source,
        Err(_) => {
            let _ = http::reject(
                &mut writer,
                &Rejection {
                    status: 404,
                    reason: "Not Found",
                },
            )
            .await;
            return;
        }
    };
    let scheme = match url::Url::parse(&source) {
        Ok(url) => url.scheme().to_owned(),
        Err(_) => return,
    };
    if !sessions::handles_scheme(route.partition(), &scheme) {
        let _ = http::reject(
            &mut writer,
            &Rejection {
                status: 404,
                reason: "Not Found",
            },
        )
        .await;
        return;
    }
    if config.require_protected_transport().is_err() {
        let _ = http::reject(
            &mut writer,
            &Rejection {
                status: 404,
                reason: "Not Found",
            },
        )
        .await;
        return;
    }
    let head = request.method == "HEAD";
    let response = async {
        let response = match protocol::open(protocol::Request {
            partition: route.partition().to_owned(),
            scheme,
            url: source,
            method: request.method,
            headers: request.headers,
            body: request.body,
        })
        .await
        {
            Ok(response) => response,
            Err(_) => {
                return http::reject(
                    &mut writer,
                    &Rejection {
                        status: 502,
                        reason: "Bad Gateway",
                    },
                )
                .await;
            }
        };
        http::write_response(&mut writer, response, head).await
    };
    let mut unexpected = [0; 1];
    // Peer EOF or later input abandons this one-response connection, including a waiting Body.next().
    tokio::select! {
        biased;
        _ = cancelled(&mut stop) => {},
        _ = reader.read(&mut unexpected) => {},
        _ = response => {},
    }
}
