use std::path::PathBuf;
use std::sync::Arc;

use crate::aimemory::application::{Config as MemoryConfig, Memory};
use crate::machine::{Config as MachineConfig, Proxy};
use crate::server::{Events, Fault};
use crate::setup::runner::Runner;
use crate::stock::native::{Config as StockConfig, Service as Stock};

use super::callers::Callers;
use super::memory_host::MemoryHost;
use super::prefs::Prefs;
use super::readiness::FirstTab;
use super::stock_launcher::StockLauncher;

/// Trusted boot facts. The shell supplies paths and its PAC provider; no page can construct this graph.
pub struct Config {
    pub generation: u64,
    pub machine: MachineConfig,
    pub memory: MemoryConfig,
    pub bridge_dir: PathBuf,
}

/// The concrete shared services, not another RPC client. The native page/pool graph uses these exact instances.
pub struct Services {
    pub callers: Callers,
    pub prefs: Arc<Prefs>,
    pub machine: Arc<crate::machine::Service>,
    pub runner: Runner,
    pub first_tab: Arc<FirstTab>,
    pub stock: Arc<Stock>,
    pub memory: Arc<Memory>,
}

impl Services {
    pub fn open(config: Config, proxy: Arc<dyn Proxy>, events: Events) -> Result<Self, Fault> {
        let prefs = Prefs::open(&config.machine.user_data)?;
        let runner = Runner::new(
            config.machine.core_bin.clone(),
            config.machine.user_data.join("setup-scratch"),
        );
        let machine = crate::machine::Service::new(config.machine, proxy);
        let first_tab = Arc::new(FirstTab::default());
        let stock = Arc::new(Stock::new(
            StockConfig {
                host: format!("native-{}", config.generation),
                events: events.clone(),
            },
            Arc::new(StockLauncher::new(Arc::clone(&machine), config.bridge_dir)),
        ));
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
        Ok(Self {
            callers: Callers::new(config.generation),
            prefs,
            machine,
            runner,
            first_tab,
            stock,
            memory,
        })
    }

    /// Called at the actual first native tab launch edge, not when a placeholder window is painted.
    pub fn tab_started(&self) {
        self.first_tab.opened();
    }

    pub async fn start_memory(&self) {
        self.memory.start().await;
    }

    /// Call after page/pool admission stops. Memory joins its running installer before stock workers are drained.
    pub async fn close(&self) {
        self.first_tab.close();
        self.callers.stop();
        self.memory.close().await;
        self.stock.close().await;
    }
}
