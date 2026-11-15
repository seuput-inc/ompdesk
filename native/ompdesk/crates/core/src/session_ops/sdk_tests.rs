//! Isolated installed-omp storage consumer. Base supplies trusted tool paths; no scripted worker or live user journal.

use std::path::PathBuf;
use std::sync::Arc;


use super::*;
use crate::application::callers::Callers;
use crate::application::prefs::Prefs;
use crate::application::proxy::ShellProxy;
use crate::application::session_access::SessionAccess;
use crate::application::sessions::SessionIndex;
use crate::application::stock_launcher::StockLauncher;
use crate::machine::{Config as MachineConfig, Environment, Platform, Service as Machine};
use crate::pool::application::{Application, native as pool};
use crate::pool::application::native::tests::test_host;
use crate::remote::application_host::tests::service as hosted_service;
use crate::server::Events;
use crate::stock::native::{Config as StockConfig, Service as Stock};
use crate::worktree_lifecycle::RemovalClaims;

struct Folder(PathBuf);
impl Drop for Folder {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}

fn input(name: &str) -> PathBuf {
    let path = PathBuf::from(std::env::var_os(name).unwrap_or_else(|| panic!("Base must supply trusted {name}")));
    assert!(path.is_absolute());
    assert!(path.exists());
    path
}

#[tokio::test]
#[ignore = "Requires a trusted installed package-backed omp, Bun and gui-bridge fixture; run explicitly with --ignored"]
async fn installed_stock_delete_removes_artifacts_and_one_authority_refuses_reconnect_restore_and_late_writer() {
    let omp = input("OMPDESK_SESSION_OPS_TEST_OMP");
    let bun = input("OMPDESK_SESSION_OPS_TEST_BUN");
    let bridge = input("OMPDESK_SESSION_OPS_TEST_BRIDGE");
    let package = input("OMPDESK_SESSION_OPS_TEST_PACKAGE");
    let folder = Folder(crate::fs::disk::make_temp_dir("ompdesk-session-sdk-").unwrap());
    let home = folder.0.join("home");
    let data = folder.0.join("data");
    let agent = folder.0.join("agent");
    let root = folder.0.join("sessions");
    let cwd = folder.0.join("workspace");
    for path in [&home, &data, &agent, &root, &cwd] { std::fs::create_dir_all(path).unwrap(); }
    let path = root.join("isolated-workspace").join("2026-01-01T00-00-00-000Z_00000000-0000-4000-8000-000000000001.jsonl");
    let artifacts = path.with_extension("");
    let env = Environment::from([
        ("HOME".into(), home.to_string_lossy().into_owned()),
        ("USERPROFILE".into(), home.to_string_lossy().into_owned()),
        ("PI_CODING_AGENT_DIR".into(), agent.to_string_lossy().into_owned()),
        ("PI_CONFIG_DIR".into(), folder.0.join("config").to_string_lossy().into_owned()),
        ("TMPDIR".into(), folder.0.to_string_lossy().into_owned()),
        ("PATH".into(), format!("{}:/usr/bin:/bin", bun.parent().unwrap().display())),
        ("SHELL".into(), "/bin/sh".into()),
        ("OMP_GUI_OMP".into(), omp.to_string_lossy().into_owned()),
        ("OMPDESK_CONTROL_OFF".into(), "1".into()),
    ]);
    // Seed only this fixture through the installed storage's writer. The same installed SDK is later
    // called by the real StockLauncher -> stock-helper worker, not by a replacement delete script.
    let seed = r#"
const [root,file,cwd] = process.argv.slice(1);
const {FileSessionStorage}=await import(Bun.resolveSync('@oh-my-pi/pi-coding-agent/session/session-storage',root+'/package.json'));
const storage=new FileSessionStorage();
const rows=[{type:'session',version:3,id:'00000000-0000-4000-8000-000000000001',timestamp:'2026-01-01T00:00:00.000Z',cwd},
 {type:'message',id:'u1',parentId:null,timestamp:'2026-01-01T00:00:01.000Z',message:{role:'user',content:[{type:'text',text:'Isolated storage consumer'}],timestamp:1767225601000}}];
await storage.writeText(file,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
"#;
    let seeded = tokio::process::Command::new(&bun).args(["--eval", seed])
        .arg(&package).arg(&path).arg(&cwd).env_clear().envs(&env)
        .current_dir(&folder.0).kill_on_drop(true).output().await.unwrap();
    assert!(seeded.status.success(), "{}", String::from_utf8_lossy(&seeded.stderr));
    std::fs::create_dir_all(&artifacts).unwrap();
    std::fs::write(artifacts.join("fixture-artifact.txt"), "isolated artifact").unwrap();
    let saved = std::fs::read(&path).unwrap();
    let (events, _transport, _frames) = Events::capture();
    let prefs = Prefs::open(&data).unwrap();
    let machine = Machine::new(MachineConfig {
        platform: Platform::Other, home, user_data: data.clone(), tools_dir: folder.0.join("tools"),
        agent_desktop_bundle: None, core_bin: std::env::current_exe().unwrap(), agent_dir: agent,
        inherited_env: env.clone(),
    }, Arc::new(ShellProxy::new(prefs, events.clone())));
    let stock = Arc::new(Stock::new(StockConfig {
        host: folder.0.file_name().unwrap().to_string_lossy().into_owned(), events,
    }, Arc::new(StockLauncher::new(machine, bridge))));
    let authority_file = data.join("deleted-sessions.json");
    let authority = Arc::new(SessionAuthority::open(Some(authority_file.clone())));
    let index = SessionIndex::new(Arc::clone(&stock), root.clone(), cwd.clone(), Arc::clone(&authority), data.join("session-kinds.json"));
    let callers = Arc::new(Callers::new(73));
    let page = callers.admit_page(ompdesk_app_contract::NativeCaller::Desktop { win_id: 17, wc_id: 117 }).unwrap();
    let app = Arc::new(Application::new(test_host(Arc::clone(&callers))));
    let pool = pool::Service::new(pool::Config {
        id: 0x7364_6b64_656c_0001, layout_version: 1, max_former_tab_ids: 8,
        view_epoch: "session-ops-installed-sdk".into(),
        stop_session_wait_ms: 60_000, window_tabs_hook: false, now_ms: || 1,
        callers: Arc::clone(&callers), removal_claims: RemovalClaims::new(),
    }, app).await.unwrap();
    let (hosted, _, _) = hosted_service();
    let access = Arc::new(SessionAccess::new(callers, Arc::clone(&index)));
    let host = Arc::new(native::NativeHost::new(native::Config {
        access, pool: Arc::clone(&pool), hosted: Arc::clone(&hosted), index: Arc::clone(&index),
        rename_runner: crate::run::Runner { bin: "/bin/sh".into(), args: vec!["-c".into()], env,
            timeout_ms: 30_000, max_bytes: 1_048_576 }, rename_cwd: cwd,
    }));
    let coordinator = Coordinator::new(Config { host, authority: Arc::clone(&authority), now_ms: || 19.0 });
    let run_stock = Arc::clone(&stock);
    let run_index = Arc::clone(&index);
    let run_authority = Arc::clone(&authority);
    let run_path = path.clone();
    let outcome = tokio::spawn(async move {
        let before = run_index.list(false, None).await.unwrap();
        assert!(before.iter().any(|row| row.path() == run_path.to_str().unwrap()));
        let mut changes = run_index.subscribe();
        let result = coordinator.execute(&page.owner, Target { path: run_path.to_string_lossy().into_owned(), device: None }, Mutation::Delete, Scope::detached()).await.unwrap();
        assert_eq!(result, Output::Done);
        assert!(!run_path.exists());
        assert!(!artifacts.exists(), "installed FileSessionStorage must remove the original artifact folder");
        assert_eq!(run_authority.at(run_path.to_str().unwrap(), None), Some(19.0));
        assert!(changes.recv().await.is_ok(), "the actual index invalidation emits its mutation notice");
        assert!(run_index.list(false, None).await.unwrap().is_empty(), "deleting must not create a new session");
        assert!(matches!(run_authority.admit(&run_path, None, || ()), Err(AdmissionRefusal::Deleted)));
        // A stray late writer restores the exact saved id and content, but cannot restore admission or listing.
        std::fs::write(&run_path, saved).unwrap();
        run_index.invalidate_paths(std::slice::from_ref(&run_path));
        assert!(run_index.list(false, None).await.unwrap().is_empty());
        assert!(matches!(run_authority.admit(&run_path, None, || ()), Err(AdmissionRefusal::Deleted)));
        let restored = SessionAuthority::open(Some(authority_file));
        assert!(restored.has(&run_path, None));
        assert!(matches!(restored.admit(&run_path, None, || ()), Err(AdmissionRefusal::Deleted)));
        run_stock.close().await.unwrap();
    }).await;
    let closed = stock.close().await;
    index.stop();
    drop(pool);
    outcome.unwrap();
    closed.unwrap();
}
