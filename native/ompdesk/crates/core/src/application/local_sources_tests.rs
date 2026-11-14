#![cfg(unix)]

use std::sync::atomic::AtomicUsize;

use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::*;
use crate::application::launch_host::tests::concrete::{World, event};
use crate::sidecar::LaneEvent;
use crate::sidecar::application::Command;

/// Observe the actual command at the existing native spawn boundary; never replace its OS adapter.
struct ObservedSpawn {
    inner: Arc<dyn SpawnAdapter>,
    commands: Arc<Mutex<Vec<Value>>>,
}

impl SpawnAdapter for ObservedSpawn {
    fn prepare(&self, command: Command) -> Result<native::Start, Fault> {
        lock(&self.commands).push(serde_json::to_value(&command).unwrap());
        self.inner.prepare(command)
    }
}

struct Rig {
    world: World,
    factory: Arc<LocalSources>,
    created: Option<Created>,
    sink: Arc<native::tests::Recorder>,
    events: mpsc::UnboundedReceiver<LaneEvent>,
    commands: Arc<Mutex<Vec<Value>>>,
}

impl Rig {
    async fn new(name: &str) -> Self {
        let world = World::new(name).await;
        let commands = Arc::new(Mutex::new(Vec::new()));
        let mut config = world.config.clone();
        config.spawn = Arc::new(ObservedSpawn { inner: Arc::clone(&config.spawn), commands: Arc::clone(&commands) });
        let factory = Arc::new(LocalSources::new(config));
        let (record, events) = mpsc::unbounded_channel();
        let sink = Arc::new(native::tests::Recorder { events: record, flushes: AtomicUsize::new(0) });
        Self { world, factory, created: None, sink, events, commands }
    }

    fn open(&mut self, lane_id: String, origin: Option<Value>, control: Environment) -> Result<(), Fault> {
        let created = self.factory.create(&self.world.spawn, lane_id, self.sink.clone(), origin, control)?;
        self.created = Some(created);
        Ok(())
    }

    async fn close(mut self) {
        self.world.begin_close();
        let factory = self.factory.close();
        let source = match self.created.take() {
            Some(created) => {
                let ingress = created.ingress.close();
                let exited = created.source.when_exited();
                created.source.dispose(Duration::ZERO);
                let exited = exited.await;
                let held = created.held.await;
                let ingress = ingress.await;
                exited.and(held).and(ingress)
            }
            None => Ok(()),
        };
        let factory = factory.await;
        let world = self.world.finish_close().await;
        source.unwrap();
        factory.unwrap();
        world.unwrap();
    }
}

async fn run<F>(name: &str, scenario: F)
where
    F: for<'a> FnOnce(&'a mut Rig) -> crate::sidecar::application::EffectFuture<'a, ()> + Send + 'static,
{
    let rig = Arc::new(tokio::sync::Mutex::new(Rig::new(name).await));
    let task_rig = Arc::clone(&rig);
    let outcome = tokio::spawn(async move { scenario(&mut *task_rig.lock().await).await }).await;
    Arc::try_unwrap(rig).ok().unwrap().into_inner().close().await;
    outcome.unwrap();
}

#[tokio::test]
async fn the_factory_keeps_the_external_execution_and_defers_its_bound_real_child_to_root() {
    run("local-source-created", |rig| Box::pin(async move {
        let origin = json!({"deviceId":"fixture-peer","name":"Fixture device","hostName":"Fixture host"});
        rig.world.spawn.kind = "chat".into();
        rig.world.spawn.device = Some("fixture-peer".into());
        rig.world.prefs.set("pstack", json!(true)).unwrap();
        rig.world.prefs.set("ecc", json!(true)).unwrap();
        let lane_id = format!("native-{}", rig.world.spawn.tab);
        rig.open(lane_id.clone(), Some(origin.clone()), Environment::from([("OMPDESK_CONTROL_OFF".into(), "1".into())])).unwrap();
        let source = Arc::clone(&rig.created.as_ref().unwrap().source);
        source.barrier().await.unwrap();
        assert_eq!(source.tab(), lane_id);
        assert_ne!(source.tab(), rig.world.spawn.tab);
        assert_eq!(source.facts()["cwd"], rig.world.spawn.cwd);
        assert_eq!(source.facts()["processAlive"], false);
        assert!(!rig.world.child_log.exists(), "create binds the real ingress but does not start omp");
        assert!(lock(&rig.commands).is_empty());
        assert_eq!(rig.world.callers.execution_owner(&rig.world.spawn.tab).unwrap(), rig.world.owner);
        // Root still owns the successful lifetime; factory close only joins failed creations.
        rig.factory.close().await.unwrap();
        source.start();
        native::tests::ready_with(&mut rig.events, |_| None).await;
        source.barrier().await.unwrap();
        assert_eq!(source.facts()["processAlive"], true);
        assert_eq!(rig.world.callers.execution_owner(&rig.world.spawn.tab).unwrap(), rig.world.owner);
        let command = lock(&rig.commands).last().unwrap().clone();
        assert_eq!(command["cwd"], rig.world.spawn.cwd);
        assert_eq!(serde_json::from_str::<Value>(command["env"]["OMP_GUI_PROMPT_ORIGIN"].as_str().unwrap()).unwrap(), origin);
        assert_eq!(command["env"]["OMPDESK_CONTROL_OFF"], "1");
        assert_eq!(command["env"]["OMP_GUI_PSTACK"], "0", "the original chat kind reaches canonical builtin assembly");
        assert_eq!(command["env"]["OMP_GUI_ECC"], "0");
        assert!(!command["args"].as_array().unwrap().iter().any(|arg| arg == "--session"));
        let tags = rig.world.tags();
        assert_eq!(tags["tags"][0]["sessionPath"], rig.world.unwritten.to_string_lossy().as_ref());
        assert_eq!(tags["tags"][0]["device"], "fixture-peer");
        assert_eq!(command["env"]["OMP_GUI_SESSION_TAG"], tags["tags"][0]["tag"]);
        let mounted = rig.world.stdin().into_iter().find(|frame| frame["type"] == "set_host_tools").unwrap();
        assert_eq!(mounted["tools"], Value::Array(rig.world.base_tools.iter().cloned().collect()));
    })).await;
}

#[tokio::test]
async fn a_rejected_host_returns_its_original_fault_and_retains_the_opened_lane_cleanup() {
    run("local-source-rejected", |rig| Box::pin(async move {
        rig.world.callers.retire_execution(&rig.world.owner);
        let expected = rig.world.callers.admit_tab_effect(&rig.world.owner, &rig.world.spawn.tab, || Ok(())).unwrap_err();
        let lane_id = format!("refused-{}", rig.world.spawn.tab);
        let error = rig.open(lane_id.clone(), None, Environment::new()).unwrap_err();
        assert_eq!((error.code, error.message), (expected.code, expected.message));
        let abandoned = rig.factory.close();
        drop(abandoned);
        rig.factory.close().await.unwrap();
        let disposed = event(&mut rig.events, "sidecar.disposed").await;
        assert_eq!(disposed.data["tab"], lane_id);
        assert!(rig.created.is_none());
        assert!(lock(&rig.commands).is_empty());
        assert!(!rig.world.child_log.exists());
        assert!(rig.world.ownership.held().is_empty());
        assert_eq!(rig.open(format!("after-close-{}", rig.world.spawn.tab), None, Environment::new()).unwrap_err().code, "local_sources_closed");
    })).await;
}

#[tokio::test]
async fn abandoning_a_rejected_factory_still_disposes_its_actual_lane() {
    run("local-source-dropped", |rig| Box::pin(async move {
        rig.world.callers.retire_execution(&rig.world.owner);
        let factory = LocalSources::new(rig.world.config.clone());
        let lane_id = format!("dropped-{}", rig.world.spawn.tab);
        let error = factory.create(&rig.world.spawn, lane_id.clone(), rig.sink.clone(), None, Environment::new()).err().unwrap();
        assert_eq!(error.code, "caller_closed");
        drop(factory);
        let disposed = event(&mut rig.events, "sidecar.disposed").await;
        assert_eq!(disposed.data["tab"], lane_id);
        assert!(!rig.world.child_log.exists());
        assert!(rig.world.ownership.held().is_empty());
    })).await;
}
