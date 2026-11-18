use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::aimemory::application::{Config as MemoryConfig, Memory};
use crate::machine::Config as MachineConfig;
use crate::remote::delivery::DeliveryLedger;
use crate::server::{Events, Fault};
use crate::setup::runner::Runner;
use crate::setup::service::{Config as SetupConfig, SetupService, StateSink};
use crate::stock::native::{Config as StockConfig, Service as Stock};

use super::accounts::Accounts;
use super::callers::Callers;
use super::memory_host::MemoryHost;
use super::outcomes::Outcomes;
use super::prefs::Prefs;
use super::proxy::ShellProxy;
use super::readiness::FirstTab;
use super::requests::Requests;
use super::routine_sources::{SessionFeed, Sources};
use super::secrets::ShellSecrets;
use super::session_access::SessionAccess;
use super::session_authority::SessionAuthority;
use super::sessions::SessionIndex;
use super::setup_host::{Hooks as SetupHooks, SetupHost};
use super::stock_launcher::StockLauncher;
use super::tools::HostTools;

/// Trusted boot facts. The shell supplies paths and its PAC provider; no page can construct this graph.
pub struct Config {
    pub generation: u64,
    pub machine: MachineConfig,
    pub memory: MemoryConfig,
    pub setup: SetupConfig,
    pub bridge_dir: PathBuf,
    pub remember_saved_secrets: bool,
    pub initial_cwd: PathBuf,
}

/// The concrete shared services, not another RPC client. The native page/pool graph uses these exact instances.
pub struct Services {
    pub callers: Arc<Callers>,
    pub requests: Requests,
    pub prefs: Arc<Prefs>,
    pub machine: Arc<crate::machine::Service>,
    pub omp_cli: Arc<super::omp_cli::Service>,
    pub runner: Runner,
    pub first_tab: Arc<FirstTab>,
    pub stock: Arc<Stock>,
    pub setup: Arc<SetupService>,
    pub memory: Arc<Memory>,
    pub accounts: Arc<Accounts>,
    pub session_feed: Arc<SessionFeed>,
    pub routine_sources: Arc<Sources>,
    pub deliveries: DeliveryLedger,
    pub tombstones: Arc<SessionAuthority>,
    pub sessions: Arc<SessionIndex>,
    pub host_tools: HostTools,
    pub project_metadata: Arc<crate::repo_images::Service>,
    pub session_access: SessionAccess,
    pub outcomes: Mutex<Outcomes>,
}

impl Services {
    pub fn open(
        config: Config,
        events: Events,
        setup_hooks: Arc<dyn SetupHooks>,
        on_setup_state: StateSink,
    ) -> Result<Self, Fault> {
        let host_tools = HostTools::bundled()?;
        let prefs = Prefs::open(&config.machine.user_data)?;
        let accounts = Accounts::open(
            &config.machine.user_data,
            Arc::new(ShellSecrets::new(events.clone())),
            config.remember_saved_secrets,
        );
        let runner = Runner::new(
            config.setup.supervisor.clone(),
            config.setup.scratch.clone(),
        );
        let machine = crate::machine::Service::new(
            config.machine,
            Arc::new(ShellProxy::new(Arc::clone(&prefs), events.clone())),
        );
        let first_tab = Arc::new(FirstTab::default());
        let stock = Arc::new(Stock::new(
            StockConfig {
                host: format!("native-{}", config.generation),
                events: events.clone(),
            },
            Arc::new(StockLauncher::new(Arc::clone(&machine), config.bridge_dir)),
        ));
        let user_data = &machine.config().user_data;
        let tombstones = Arc::new(SessionAuthority::open(Some(
            user_data.join("deleted-sessions.json"),
        )));
        let sessions = SessionIndex::new(
            Arc::clone(&stock),
            machine.config().agent_dir.join("sessions"),
            config.initial_cwd,
            Arc::clone(&tombstones),
            user_data.join("session-kinds.json"),
        );
        let setup = SetupService::new(
            config.setup,
            Arc::new(SetupHost::new(
                Arc::clone(&machine),
                Arc::clone(&stock),
                Arc::clone(&first_tab),
                setup_hooks,
            )),
            on_setup_state,
        );
        let memory = Arc::new(Memory::open(
            config.memory,
            Arc::new(MemoryHost::new(
                Arc::clone(&machine),
                Arc::clone(&prefs),
                runner.clone(),
                Arc::clone(&first_tab),
            )),
            events,
        ));
        let callers = Arc::new(Callers::new(config.generation));
        let omp_cli = super::omp_cli::Service::new(Arc::clone(&machine), runner.clone());
        let session_feed = SessionFeed::new();
        let routine_sources = Arc::new(Sources::new(
            Arc::clone(&machine),
            Arc::clone(&accounts),
            Arc::clone(&session_feed),
        ));
        Ok(Self {
            requests: Requests::new(Arc::clone(&callers)),
            session_access: SessionAccess::new(Arc::clone(&callers), Arc::clone(&sessions)),
            callers,
            prefs,
            machine,
            omp_cli,
            runner,
            first_tab,
            stock,
            setup,
            memory,
            accounts,
            session_feed,
            routine_sources,
            deliveries: DeliveryLedger::default(),
            tombstones,
            sessions,
            host_tools,
            project_metadata: crate::repo_images::shared(),
            outcomes: Mutex::new(Outcomes::default()),
        })
    }

    /// Called when the first local omp reports ready, not at window paint or process launch.
    pub fn tab_ready(&self) {
        self.first_tab.ready();
    }

    pub async fn start_memory(&self) {
        self.memory.start().await;
    }

    pub fn start_sessions(&self) {
        self.sessions.start();
    }

    /// Revoke admission first; join Setup before releasing readiness, then drain the other owned services.
    pub async fn close(&self) -> Result<(), Fault> {
        let admission = self.requests.stop_admission().await;
        self.session_feed.close();
        let setup = self.setup.close().await;
        self.sessions.stop();
        self.first_tab.close();
        self.memory.close().await;
        let stock = self.stock.close().await;
        self.outcomes
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
        let requests = self.requests.join().await;
        admission?;
        requests?;
        setup.map_err(|error| Fault::new("setup_close", error))?;
        stock
    }
}
