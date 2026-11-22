//! One omp's HTTP transport. The session task owns its POST waiters and its current GET stream.
//! Replacing that stream also replaces the disconnect future the task is listening to.

use std::collections::HashMap;
use std::ffi::OsString;
use std::io;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use hyper::body::Bytes;
use hyper::header::HeaderValue;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot, watch};

use super::rea;

const HELD_MAX: usize = 1000;
type Frames = mpsc::UnboundedReceiver<Bytes>;
type Registry = Arc<Mutex<HashMap<HeaderValue, Client>>>;

pub(super) struct Sessions {
    live: Registry,
    store: Arc<rea::Store>,
    command: Arc<Vec<OsString>>,
    // Every session holds a receiver until its REA is gone, even if DELETE already unlisted it.
    stopping: watch::Sender<()>,
}

impl Sessions {
    pub(super) fn new(cache: Option<PathBuf>, command: Vec<OsString>) -> Self {
        Self {
            live: Default::default(),
            store: Arc::new(rea::Store::new(cache)),
            command: Arc::new(command),
            stopping: watch::channel(()).0,
        }
    }

    pub(super) fn open(&self, cwd: Option<PathBuf>) -> io::Result<(HeaderValue, Client)> {
        let mut bytes = [0; 16];
        crate::sys::random(&mut bytes)?;
        bytes[6] = bytes[6] & 0x0f | 0x40;
        bytes[8] = bytes[8] & 0x3f | 0x80;
        let n = u128::from_be_bytes(bytes);
        let id = HeaderValue::try_from(format!(
            "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
            n >> 96,
            (n >> 80) as u16,
            (n >> 64) as u16,
            (n >> 48) as u16,
            n & 0xffff_ffff_ffff
        ))
        .expect("a UUID is a header value");
        let (out, from_rea) = mpsc::unbounded_channel();
        let rea = rea::Session::new(self.store.clone(), self.command.clone(), cwd, out);
        let (tx, input) = mpsc::unbounded_channel();
        let client = Client(tx);
        self.live.lock().unwrap().insert(id.clone(), client.clone());
        tokio::spawn(serve(
            self.live.clone(),
            id.clone(),
            self.stopping.subscribe(),
            rea,
            input,
            from_rea,
        ));
        Ok((id, client))
    }

    pub(super) fn get(&self, id: &HeaderValue) -> Option<Client> {
        self.live.lock().unwrap().get(id).cloned()
    }

    pub(super) fn remove(&self, id: &HeaderValue) {
        if let Some(client) = self.live.lock().unwrap().remove(id) {
            let _ = client.0.send(Input::Close);
        }
    }

    pub(super) async fn stop(&self) {
        self.stopping.send_replace(());
        let _ = tokio::time::timeout(Duration::from_millis(2500), self.stopping.closed()).await;
    }
}

#[derive(Clone)]
pub(super) struct Client(mpsc::UnboundedSender<Input>);

enum Input {
    Post(Value, Option<(Value, oneshot::Sender<Value>)>),
    Forget(Value),
    Listen(oneshot::Sender<Frames>),
    Close,
}

impl Client {
    pub(super) async fn stream(&self) -> Option<Frames> {
        let (tx, rx) = oneshot::channel();
        self.0.send(Input::Listen(tx)).ok()?;
        rx.await.ok()
    }

    pub(super) async fn post(&self, message: Value) -> Result<Option<Value>, ()> {
        let Some(key) = message.get("id").filter(|_| message["method"].is_string()) else {
            self.0.send(Input::Post(message, None)).map_err(|_| ())?;
            return Ok(None);
        };
        let (tx, rx) = oneshot::channel();
        let mut waiting = Waiting {
            client: self,
            key: Some(key.clone()),
            rx,
        };
        let reply = (key.clone(), tx);
        self.0
            .send(Input::Post(message, Some(reply)))
            .map_err(|_| ())?;
        let answer = (&mut waiting.rx).await;
        waiting.key = None;
        answer.map(Some).map_err(|_| ())
    }
}

struct Waiting<'a> {
    client: &'a Client,
    key: Option<Value>,
    rx: oneshot::Receiver<Value>,
}

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        if let Some(key) = self.key.take() {
            self.rx.close();
            let _ = self.client.0.send(Input::Forget(key));
        }
    }
}

#[derive(Default)]
struct Delivery {
    replies: HashMap<Value, oneshot::Sender<Value>>,
    stream: Option<mpsc::UnboundedSender<Bytes>>,
    held: Vec<Bytes>,
}

impl Delivery {
    fn listen(&mut self, open: oneshot::Sender<Frames>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let _ = tx.send(Bytes::from_static(b": open\n\n"));
        for frame in self.held.drain(..) {
            let _ = tx.send(frame);
        }
        self.stream = Some(tx);
        let _ = open.send(rx);
    }

    fn reply(&mut self, message: Value) -> Option<Value> {
        if message.get("method").is_none()
            && let Some(tx) = message.get("id").and_then(|k| self.replies.remove(k))
        {
            tx.send(message).err()
        } else {
            Some(message)
        }
    }

    fn deliver(&mut self, message: Value) {
        let Some(message) = self.reply(message) else {
            return;
        };
        if self.stream.is_none() && self.held.len() == HELD_MAX {
            return;
        }
        let mut data = b"data: ".to_vec();
        serde_json::to_writer(&mut data, &message).expect("JSON value into a Vec");
        data.extend_from_slice(b"\n\n");
        let mut frame = Bytes::from(data);
        if let Some(stream) = &self.stream {
            match stream.send(frame) {
                Ok(()) => return,
                Err(error) => frame = error.0,
            }
        }
        if self.held.len() < HELD_MAX {
            self.held.push(frame);
        }
    }
}

async fn serve(
    live: Registry,
    id: HeaderValue,
    mut stop: watch::Receiver<()>,
    rea: rea::Session,
    mut input: mpsc::UnboundedReceiver<Input>,
    mut from_rea: mpsc::UnboundedReceiver<Value>,
) {
    let mut delivery = Delivery::default();
    loop {
        tokio::select! {
            _ = stop.changed() => break,
            message = from_rea.recv() => match message {
                Some(message) => delivery.deliver(message),
                None => break,
            },
            event = input.recv() => match event {
                Some(Input::Post(message, reply)) => {
                    if let Some((key, tx)) = reply {
                        delivery.replies.insert(key, tx);
                    }
                    rea.receive(message);
                }
                Some(Input::Forget(key)) => {
                    // An aborted POST must not remove a newer waiter using the same JSON-RPC id.
                    if delivery.replies.get(&key).is_some_and(oneshot::Sender::is_closed) {
                        delivery.replies.remove(&key);
                    }
                }
                Some(Input::Listen(open)) => delivery.listen(open),
                Some(Input::Close) | None => break,
            },
            _ = async { delivery.stream.as_ref().unwrap().closed().await }, if delivery.stream.is_some() => {
                delivery.stream = None;
                if rea.running() {
                    break;
                }
            }
        }
    }
    live.lock().unwrap().remove(&id);
    drop(input);
    delivery.stream = None;
    // A child can fail its final requests and exit in the same turn. Drain those answers before
    // dropping any remaining waiters (their HTTP handlers then return 404 rather than waiting).
    let answers = async {
        while let Some(message) = from_rea.recv().await {
            let _ = delivery.reply(message);
        }
    };
    tokio::join!(rea.close(), answers);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn listen(delivery: &mut Delivery) -> Frames {
        let (open, mut opened) = oneshot::channel();
        delivery.listen(open);
        let mut frames = opened.try_recv().unwrap();
        assert_eq!(frames.try_recv().unwrap(), ": open\n\n");
        frames
    }

    #[test]
    fn replacing_a_stream_replays_only_pre_stream_events() {
        let mut delivery = Delivery::default();
        delivery.deliver(json!({"method": "before"}));
        let mut first = listen(&mut delivery);
        assert_eq!(
            first.try_recv().unwrap(),
            "data: {\"method\":\"before\"}\n\n"
        );
        let mut second = listen(&mut delivery);
        assert!(matches!(
            first.try_recv(),
            Err(mpsc::error::TryRecvError::Disconnected)
        ));
        drop(first);
        delivery.deliver(json!({"method": "after"}));
        assert_eq!(
            second.try_recv().unwrap(),
            "data: {\"method\":\"after\"}\n\n"
        );
    }

    #[test]
    fn server_requests_do_not_consume_a_post_with_the_same_id() {
        let mut delivery = Delivery::default();
        let (tx, mut reply) = oneshot::channel();
        delivery.replies.insert(json!(4), tx);
        let mut stream = listen(&mut delivery);
        delivery.deliver(json!({"id": 4, "method": "roots/list"}));
        delivery.deliver(json!({"id": "4", "result": {}}));
        assert_eq!(
            stream.try_recv().unwrap(),
            "data: {\"id\":4,\"method\":\"roots/list\"}\n\n"
        );
        assert_eq!(
            stream.try_recv().unwrap(),
            "data: {\"id\":\"4\",\"result\":{}}\n\n"
        );
        let answer = json!({"id": 4, "error": {"code": -32603, "message": "REA child exited"}});
        delivery.deliver(answer.clone());
        assert_eq!(reply.try_recv().unwrap(), answer);
        assert!(matches!(
            stream.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));
    }
}
