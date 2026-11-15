use std::panic::AssertUnwindSafe;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::task::Poll;

use futures_util::FutureExt;
use serde_json::Value;
use tokio::sync::mpsc;

use super::*;
use crate::application::launch_host::tests::concrete::World;
use crate::application::local_sources::LocalSources;
use crate::machine::Environment;
use crate::sidecar::LaneEvent;
use crate::sidecar::native::tests::Recorder;

struct Fixture {
    world: World,
    factory: LocalSources,
    source: Arc<Source>,
    events: mpsc::UnboundedReceiver<LaneEvent>,
}

impl Fixture {
    async fn new(name: &str, mode: &str) -> Self {
        let world = World::new(name).await;
        let factory = LocalSources::new(world.config.clone());
        let (events, received) = mpsc::unbounded_channel();
        let mut environment = Environment::from([("OMPDESK_FAKE_OMP".into(), mode.into())]);
        if mode == "silent" {
            environment.insert("OMPDESK_FAKE_START_EVENT".into(), "1".into());
        }
        let created = factory
            .create(
                &world.spawn,
                format!("command-start-{name}"),
                Arc::new(Recorder {
                    events,
                    flushes: AtomicUsize::new(0),
                }),
                None,
                environment,
            )
            .unwrap();
        Self {
            world,
            factory,
            source: Arc::new(Source::from_local(created)),
            events: received,
        }
    }

    async fn check<F, Work>(self, test: F)
    where
        F: FnOnce(Arc<Source>, PathBuf, mpsc::UnboundedReceiver<LaneEvent>) -> Work,
        Work: Future<Output = ()>,
    {
        let result = AssertUnwindSafe(test(
            Arc::clone(&self.source),
            self.world.child_log.clone(),
            self.events,
        ))
        .catch_unwind()
        .await;
        let retired = self.source.retire().wait().await;
        let factory = self.factory.close().await;
        self.world.begin_close();
        let world = self.world.finish_close().await;
        retired.unwrap();
        factory.unwrap();
        world.unwrap();
        if let Err(panic) = result {
            std::panic::resume_unwind(panic);
        }
    }
}

struct PausedClock;

impl PausedClock {
    fn new() -> Self {
        tokio::time::pause();
        Self
    }
}

impl Drop for PausedClock {
    fn drop(&mut self) {
        tokio::time::resume();
    }
}

#[tokio::test]
async fn an_asleep_source_is_not_started_and_an_already_cancelled_scope_is_preserved() {
    Fixture::new("settled-asleep", "normal")
        .await
        .check(|source, child_log, _events| async move {
            settled_start(Arc::clone(&source), Scope::detached())
                .await
                .unwrap();
            assert_eq!(source.facts()["status"], "asleep");
            assert_eq!(source.facts()["processAlive"], false);
            assert!(!child_log.exists());
            let scope = Scope::detached();
            scope.cancel();
            assert_eq!(
                settled_start(Arc::clone(&source), scope).await,
                Err(Fault::cancelled())
            );
            assert!(!child_log.exists());
        })
        .await;
}

#[tokio::test]
async fn the_original_real_source_settles_ready_without_replacing_its_run() {
    Fixture::new("settled-ready", "normal")
        .await
        .check(|source, _, _events| async move {
            let mut changes = source.local().unwrap().changes();
            source.start();
            while source.facts()["status"] == "asleep" {
                changes.changed().await.unwrap();
            }
            settled_start(Arc::clone(&source), Scope::detached())
                .await
                .unwrap();
            assert_eq!(source.facts()["status"], "ready");
            assert_eq!(source.facts()["processAlive"], true);
            let generation = source.generation();
            settled_start(Arc::clone(&source), Scope::detached())
                .await
                .unwrap();
            assert_eq!(source.generation(), generation);
            assert_eq!(source.facts()["processAlive"], true);
        })
        .await;
}

#[tokio::test]
async fn cancellation_and_the_original_deadline_leave_a_slow_child_starting_until_retired() {
    Fixture::new("settled-silent", "silent")
        .await
        .check(|source, child_log, mut events| async move {
            let mut changes = source.local().unwrap().changes();
            source.start();
            loop {
                let facts = source.facts();
                if facts["processAlive"] == true && facts["status"] == "starting" {
                    break;
                }
                assert_ne!(facts["status"], "error");
                changes.changed().await.unwrap();
            }
            loop {
                let event = events
                    .recv()
                    .await
                    .expect("original silent child entry event");
                if event.name == "sidecar.frame" {
                    let frame: Value = serde_json::from_slice(event.bin.as_ref().unwrap()).unwrap();
                    if frame["type"] == "test_start_barrier" {
                        break;
                    }
                }
            }
            assert!(
                std::fs::read_to_string(&child_log)
                    .unwrap()
                    .lines()
                    .any(|line| line.starts_with("start "))
            );
            let generation = source.generation();
            let scope = Scope::detached();
            let mut cancelled = settled_start(Arc::clone(&source), scope.clone());
            assert!(futures_util::poll!(cancelled.as_mut()).is_pending());
            scope.cancel();
            assert_eq!(cancelled.await, Err(Fault::cancelled()));
            assert_eq!(source.generation(), generation);
            assert_eq!(source.facts()["processAlive"], true);

            let clock = PausedClock::new();
            let mut waiting = settled_start(Arc::clone(&source), Scope::detached());
            assert!(futures_util::poll!(waiting.as_mut()).is_pending());
            tokio::time::advance(Duration::from_millis(59_999)).await;
            assert!(futures_util::poll!(waiting.as_mut()).is_pending());
            tokio::time::advance(Duration::from_millis(1)).await;
            waiting.await.unwrap();
            drop(clock);
            assert_eq!(source.generation(), generation);
            assert_eq!(source.facts()["status"], "starting");
            assert_eq!(source.facts()["processAlive"], true);
            assert!(
                !std::fs::read_to_string(&child_log)
                    .unwrap()
                    .contains("\"type\":\"abort\"")
            );

            let retired = source.retire();
            settled_start(Arc::clone(&source), Scope::detached())
                .await
                .unwrap();
            retired.wait().await.unwrap();
            assert_eq!(source.facts()["processAlive"], false);
        })
        .await;
}

#[tokio::test]
async fn an_offline_original_remote_source_skips_startup_wait_without_retiring_it() {
    use crate::application::source::tests::{Forward, options};
    use crate::remote::application_devices::tests::{linked, tab_present};
    use crate::remote::native_sidecar::Service as RemoteSidecar;
    use crate::remote::requests::tests::pair;
    use crate::remotebytes::native::tests::Dir;

    let folder = Dir::new();
    let (device, host, _keep) = pair().await;
    let mut incoming = host.take_requests().unwrap();
    let devices = linked(&folder, device.clone());
    let options = options();
    let rtab = options.rtab.clone();
    let (tab, events) = devices.create_tab("host", options).unwrap();
    let release = devices.capture_tab_release("host", &rtab, &tab).unwrap();
    let (output, mut delivered) = mpsc::unbounded_channel();
    let sink = Arc::new(Forward {
        output: Mutex::new(Some(output)),
        flushes: AtomicUsize::new(0),
    });
    let (native, held) = RemoteSidecar::from_tab(tab, events, sink);
    let source = Arc::new(Source::from_remote(native, held, release));
    let run = Arc::clone(&source);
    let outcome = AssertUnwindSafe(async {
        run.start();
        assert_eq!(incoming.recv().await.unwrap().method, "tab.open");
        device.disconnect_for_test();
        loop {
            let event = delivered
                .recv()
                .await
                .expect("original remote source still delivers link loss");
            if event.name == "status" && event.arg["reconnecting"] == true {
                break;
            }
        }
        let facts = run.facts();
        assert_eq!(facts["offline"], true);
        assert_eq!(facts["status"], "starting");
        let generation = run.generation();
        let mut waiting = settled_start(Arc::clone(&run), Scope::detached());
        assert_eq!(futures_util::poll!(waiting.as_mut()), Poll::Ready(Ok(())));
        assert_eq!(run.generation(), generation);
        assert!(run.settled().is_none());
    })
    .catch_unwind()
    .await;
    let retired = source.retire().wait().await;
    device.disconnect_for_test();
    host.disconnect_for_test();
    let absent = !tab_present(&devices, "host", &rtab);
    let closed = devices.dispose().await;
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
    assert_eq!(retired.unwrap_err().code, "remote_offline");
    assert!(absent);
    closed.unwrap();
}
