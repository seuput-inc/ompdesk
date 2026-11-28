# OMPdesk → Momo (`momo`) Rebranding & Repository Migration Blueprint

- **Baseline commit**: `24cba6ff6bd2bdf1b1a99e77d388b58c543b1282` (`origin/dev`, tag `v0.154.0`, 7,182 git-tracked files)
- **Target product**: **Momo** (`momo`, lowercase identifiers; bundle ID `com.seuput.momo`)
- **Target repository**: `https://github.com/seuput-inc/momo` (public, Apache-2.0)
- **Data policy**: **Fresh start** — Momo owns clean OS-standard data/cache paths (`~/Library/Application Support/momo`, `%APPDATA%\momo`, `%LOCALAPPDATA%\momo`, `~/.cache/momo`, `~/.momo-signing`, `.momo/`) with **zero legacy `seucode` or `ompdesk` data migration** and **zero Electron-to-Tauri migration scaffolding**.
- **Agent runtime policy**: Unchanged — Momo remains an unofficial desktop app for **stock `omp`** ([`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi)), which stays installed on the user's machine and keeps `~/.omp/`.

---

## 0. Executive Summary & Quantitative Scope

Audit of all **7,182** git-tracked files at `24cba6ff6`:

| Metric | Count | Scope |
|---|---:|---|
| Case-insensitive `ompdesk` occurrences | **15,931** | **1,900** files |
| — `ompdesk` (lowercase) | 10,191 | 1,329 files |
| — `OMPdesk` (display case) | 4,633 | 1,021 files |
| — `OMPDESK` (uppercase / env vars) | 1,040 | 207 files |
| — `Ompdesk` (title case / Rust types / headers) | 65 | 28 files |
| Git-tracked file paths containing `ompdesk` | **1,134** | 941 under `native/ompdesk/` + 193 outside |
| Distinct `OMPDESK_*` env vars / constants | **142** | 207 files (all rename to `MOMO_*`) |
| Distinct `OMP_GUI_*` env vars | **384** | **Keep 383**; rename only `OMP_GUI_OMPDESK_ROLES` |
| `seuput-inc/ompdesk` repository references | **68** | 46 files (+ 3 `ompdesk-formal-tools` kept) |
| Legacy `SeuPut0705` references | **141** | 29 files (incl. `launcher.rs` `REPO`; keep author `@SeuPut0705`) |
| Legacy `seucode` references | **18** | 5 files (delete migration module & test) |
| `com.seuput.ompdesk*` bundle / AUMID identifiers | **60** | 31 files |
| `momobot` MIT attribution references | **21** | 8 files (**KEEP** verbatim) |

### Distribution of Case-Insensitive `ompdesk` Hits by Top-Level Area

| Top-Level Area | Occurrences | Files | Primary Drivers |
|---|---:|---:|---|
| `native/` | 6,224 | 446 | `core` (5,254 / 299 — incl. golden `captured.json` & `matrix.json`), `shell` (252 / 35), `tauri-shell` (246 / 44), `cli` (201 / 12), `checks` (162 / 15), `native/memory` (76 / 33), `shell-preview` (22 / 4), `native/ompdesk/Cargo.*` (7 / 1), `sysproxy` (4 / 3) |
| `src/` | 3,421 | 732 | Locales (`en.ts`, `ko.ts`, `i18n-text.ts`), `main/` services/tests, `shared/`, `renderer/` |
| `e2e/` | 1,396 | 154 | Fixtures, tool names (`ompdesk_*`), theme labels, shell-launch harness |
| `scripts/` | 1,200 | 126 | Packaging, signing, `shell-move/*`, `lock-slots.ts`, license generators, `omp-boundary/` |
| `.omp/` | 1,096 | 30 | Area rules (`.omp/rules/*.md`) and repo verification skills (`.omp/skills/*`) |
| `resources/` | 975 | 293 | `gui-bridge` (464 / 111), `omp-builtin/pstack` (177 / 77), `omp-builtin/skills` (158 / 10), `omp-builtin/formal` (145 / 78), `brand` (11 / 11), `installer.nsh`, `ecc` (4 / 2), `interfaces` (1) |
| `<root>` | 590 | 16 | `CHANGELOG.md` (347), `AGENTS.md` (70), `THIRD_PARTY_NOTICES.txt` (67), `README*.md` (41), `electron-builder*.yml` (26), `SECURITY.md` (8), `.gitignore` (8), `CONTRIBUTING.md` (5), `NOTICE` (4), `AUTOPILOT.md` (3), `.ai-memory.toml` (3), `package.json` (3), `electron.vite.config.ts` (3), `vitest.setup.ts` (2) |
| `.github/` | 346 | 22 | `release.yml` (122), `shell-batch-checks.yml` (78), composite actions (85), `mac-checks.yml` (16), `omp-latest.yml` (16), `ci.yml` (13), `formal.yml` (5), `ISSUE_TEMPLATE` (3), `setup-assets-health.yml` (2), `release-keep.json` (1), `e2e-shards.yml` (1) |
| `docs/` | 341 | 24 | User guides (`en` + `ko`), `docs/design/*`, `docs/rust-inventory/*.tsv`, `docs/rust-*.md` |
| `formal/` | 318 | 50 | Formal specs & correspondence tags referencing `native/ompdesk/...` and `ompdesk_*` |
| `LICENSES/` | 22 | 5 | `ompdesk-{native,preview,shell,tauri}-dependencies.txt` (21) + `ai-memory-dependencies.txt` (1) |
| `.githooks/` | 1 | 1 | Pre-push gate comment/path |
| `.ompdesk/` | 1 | 1 | `.ompdesk/worktree-setup` (rename directory to `.momo/`) |

### Key Architectural Decisions Captured in This Blueprint

1. **OS-standard data paths + optional `~/.momo` clarity**: OMPdesk stores desktop `userData` in OS-standard folders (`~/Library/Application Support/ompdesk` on macOS, `%APPDATA%\ompdesk` on Windows) and caches in `~/.cache/ompdesk` (POSIX) / `%LOCALAPPDATA%\ompdesk` (Windows). Momo follows the exact same OS-standard layout under `momo` (and `~/.momo-signing` for local macOS signing material; `.momo/` inside git repos for worktree/check hooks). Do **not** conflate `~/.momo` with `~/.omp` — stock `omp` owns `~/.omp` and continues to store sessions/auth/extensions there.
2. **Delete legacy migration code rather than porting it**: Remove `legacy_user_data.rs` (`seucode` → `ompdesk`), `src/main/legacy-user-data.test.ts`, the v0.132/v0.133 WebKit store adoption (`webkit-store-mac.sh`), and the Electron `v0.127`/`v0.128`/`v0.131` move harness (`last-electron.json`, legacy Electron jobs in `shell-batch-checks.yml`). Momo launches directly on Tauri 2 at `v0.1.0`.
3. **Deep-link scheme `momo://` (dropping `omp://`)**: Switching the OS-registered URL scheme from `omp://` to `momo://` eliminates macOS LaunchServices / Windows protocol collisions if OMPdesk and Momo are temporarily co-installed. Upstream `omp://*.md` documentation references inside stock `omp` are untouched.
4. **Fresh self-signed macOS code-signing certificate (`Momo Code Signing`)**: Generate a dedicated certificate rather than reusing `OMPdesk Code Signing` (`ecbd9595cf886bc3546e7456706a4b41c02a4ee6`), update `scripts/mac-signing.json`, and configure `MAC_SIGNING_P12_BASE64` + `MAC_SIGNING_PASSWORD` on `seuput-inc/momo`.
5. **Version reset to `v0.1.0` & fresh `CHANGELOG.md`**: Start `seuput-inc/momo` cleanly at `0.1.0` with a clean `main` & `dev` initial commit and a one-release bootstrap bypass for prior-release updater gates (`release-update-mac` and `win-update-real`), which re-activate automatically from `v0.2.0`.

---

## 1. Complete Identifier Inventory

### 1.1 App Identity, Bundle IDs, AUMID, Installers & Schemes

| Category | Current Value | Target Value | Occurrences / Files | Primary Files to Update |
|---|---|---|---:|---|
| Display name / `productName` | `OMPdesk` | `Momo` | 4,633 / 1,021 | `package.json`, `electron-builder.yml`, `electron-builder.win.yml`, `native/momo/crates/tauri-shell/tauri.conf.json`, `scripts/mac-bundle-info.cjs`, `src/main/index.ts`, `src/renderer/{index.html,web.html,public/manifest.webmanifest}`, `tauri-shell/src/native_labels.json` |
| Package & `app.setName` | `ompdesk` | `momo` | 10,191 / 1,329 | `package.json` (`"name": "momo"`), `src/main/index.ts` (`app.setName("momo")`), `scripts/mac-bundle-info.cjs`, `scripts/dev.ts` (`momo-dev`) |
| macOS / Tauri Bundle ID | `com.seuput.ompdesk` | `com.seuput.momo` | 53 / 27 | `electron-builder.yml`, `electron-builder.win.yml`, `tauri-shell/tauri.conf.json`, `tauri-shell/Info.plist` (embedded `__TEXT,__info_plist`), `tauri-shell/src/{folder_prompts.rs,sessions/webkit_store.rs,update_stage/tests.rs}`, `shell/src/launcher.rs`, `scripts/{mac-bundle-info.cjs,mac-sign.cjs,package-mac.ts,mac-launch-check.sh}`, `src/main/{index.ts,packaging-config.test.ts}`, `.github/workflows/release.yml`, `.github/actions/mac-update-candidate/action.yml` |
| Derived Bundle ID suffixes | `com.seuput.ompdesk.{1.2,native-smoke,e2e-stand-in,XXXXXX}` | `com.seuput.momo.*` | 7 / 5 | `shell/src/startup.rs` (`1.2`), `scripts/tauri-native-smoke.ts`, `e2e/fixture/stand-in-bundle.ts`, `scripts/run-temp.ts`, `src/main/packaging-config.test.ts` |
| Windows AppUserModelID | `com.seuput.ompdesk` | `com.seuput.momo` | 32 / 12 | `src/main/index.ts:295` (`app.setAppUserModelId("com.seuput.momo")`), `shell/src/{appops.rs,main.rs,notification.rs,sys/system.rs,sys/toast.rs}`, `src/main/shell-host/electron/{app.ts,create.test.ts}` |
| macOS App Bundle | `OMPdesk.app` | `Momo.app` | 157 / 36 | `electron-builder.yml`, `scripts/{package-mac.ts,mac-bundle-info.cjs,mac-launch-check.sh,reinstall-mac.sh,lock-slots.ts}`, `src/main/{updater.ts,packaging-config.test.ts}`, `shell/src/{launcher.rs,startup.rs,childproc.rs}`, `tauri-shell/src/{folder_prompts.rs,update_stage/tests.rs}`, `.github/workflows/{release.yml,mac-checks.yml}`, `AUTOPILOT.md` |
| Windows Executable | `OMPdesk.exe` | `Momo.exe` | 84 / 29 | `electron-builder.win.yml`, `resources/installer.nsh`, `scripts/windows-installer-check.ps1`, `core/src/procs/{mod.rs,console-attribution.json,pressure_record/captured.json}`, `src/main/{index.ts,packaging-config.test.ts,shell-host/electron/create.test.ts}`, `e2e/fixture/shell-launch.ts`, `.github/workflows/{ci.yml,release.yml}` |
| Versioned Builder Artifacts | `ompdesk-${version}-${arch}.dmg` / `ompdesk-${version}-setup.exe` | `momo-${version}-${arch}.dmg` / `momo-${version}-setup.exe` | 4 / 3 | `electron-builder.yml`, `electron-builder.win.yml`, `scripts/package-mac.ts` |
| Release Assets (version-free) | `ompdesk-mac-arm64.dmg` | `momo-mac-arm64.dmg` | 55 / 28 | `.github/workflows/release.yml`, `core/src/update_feed/{metadata.rs,mod.rs}`, `shell/src/launcher.rs`, `src/main/{update-release.ts,updater.ts,packaging-config.test.ts}`, `README.md`, `README.ko.md`, `scripts/readme-media/check-readme.ts` |
| Release Assets (Windows) | `ompdesk-windows-setup.exe` | `momo-windows-setup.exe` | 65 / 29 | `.github/workflows/{release.yml,ci.yml}`, `core/src/update_feed/{metadata.rs,net_tests.rs}`, `shell/src/launcher.rs`, `src/main/{update-release.ts,updater.ts,packaging-config.test.ts}`, `README.md`, `README.ko.md`, `scripts/readme-media/check-readme.ts` |
| NSIS Installer Setup Log & Hooks | `$TEMP\ompdesk-setup.log`, `$APPDATA\ompdesk`, `shortcutName: OMPdesk` | `$TEMP\momo-setup.log`, `$APPDATA\momo`, `shortcutName: Momo` | 18 / 8 | `resources/installer.nsh`, `electron-builder.win.yml`, `scripts/windows-installer-check.ps1`, `scripts/shell-move/*` |
| Update Release Metadata Marker | `<!-- ompdesk-update {...} -->` | `<!-- momo-update {...} -->` | 92 / 32 | `.github/workflows/release.yml`, `core/src/update_feed/{metadata.rs,mod.rs,net.rs}`, `shell/src/launcher.rs`, `tauri-shell/src/update_stage/mod.rs`, `src/main/{update-release.ts,updater.ts}` |
| Update Error Codes | `ERR_OMPDESK_*` | `ERR_MOMO_*` | 12 / 4 | `src/main/update-release.ts`, `core/src/update_feed/mod.rs`, `src/main/update-*.test.ts` |
| OS Deep-Link Scheme | `omp://` (OS-registered only) | `momo://` | ~82 / ~20 *(of 117 total; keep 35 `omp://*.md` doc links!)* | `scripts/mac-bundle-info.cjs` (`CFBundleURLSchemes: ["momo"]`), `electron-builder.win.yml` (`protocols: [{name: "Momo", schemes: ["momo"]}]`), `scripts/after-pack.cjs`, `.github/workflows/{release.yml,mac-checks.yml}`, `shell/src/startup.rs:15`, `tauri-shell/src/entry.rs` |
| Internal App Origin | `app://ompdesk/` | `app://momo/` | 93 / 24 | `shell/src/{facts.rs,ipc.rs,scheme.rs,transition.rs,migrate/local_storage.rs}`, `tauri-shell/src/{main.rs,assets.rs,registry.rs,profile.rs,page_push.rs,app_window.rs}`, `src/main/shell-host/*`, `src/preload/shell.ts`, `e2e/fixture/shell-launch.ts`, `scripts/shell-drag-check.ts` |
| Media Streaming Scheme | `omp-media:` | `momo-media:` *(must move in lockstep with CSP)* | 110 / 34 | `tauri-shell/tauri.conf.json` (CSP), `src/renderer/index.html` (CSP), `tauri-shell/src/{assets.rs,preview/media.rs,preview_protocol/*}`, `core/src/web/blobs.rs`, `shell/src/{netmap.rs,protocol.rs,range.rs}`, `src/main/{media-stream.ts,index.ts,ipc.ts,web/*}`, `src/renderer/components/{panels/viewers/*,tools/media/*}`, `src/shared/ipc-types.ts` |
| Internal HTTP Header / Drag MIME | `X-Ompdesk-Import`, `application/x-ompdesk-file` | `X-Momo-Import`, `application/x-momo-file` | 4 / 3 | `shell/src/scheme.rs`, `src/preload/shell.ts`, `src/renderer/lib/file-drag.ts` |
| Mobile Web Cookie | `__Host-ompdesk` / `ompdesk` | `__Host-momo` / `momo` | 403 / 6 *(394 in `web/matrix.json`)* | `core/src/web/{auth.rs,matrix.json,server.rs}`, `src/main/web/cookie.ts` (and tests) |
| WebSocket Subprotocol | `ompdesk.v1` | `momo.v1` | 30 / 10 | `core/src/web/*`, `src/shared/web-protocol.ts`, `src/renderer/web/*`, `e2e/web-*.e2e.ts` |
| PWA IndexedDB & SW Caches | `ompdesk-device`, `omp-shell-*`, `omp-assets-*` | `momo-device`, `momo-shell-*`, `momo-assets-*` | 21 / 5 | `src/renderer/web/device-key.ts` (`DB_NAME`), `src/renderer/web/sw-core.ts` (`CACHE_PREFIX`, `RUNTIME_PREFIX`), `sw-core.test.ts`, `sw-update.test.ts` |
| Diagnostic Bundle Filename | `ompdesk-diagnostics.txt` | `momo-diagnostics.txt` | 14 / 10 | `core/src/diagnostics/*`, `src/main/diagnostics*.ts`, tests & docs |

> **Important `omp://` Disambiguation**: Of the 117 `omp://` matches in the repo, **35** are stock `omp` internal doc links (`omp://rpc.md`, `omp://sdk.md`, `omp://extensions.md`, `omp://settings.md`, `omp://session.md`). Never blind-replace `omp://` → `momo://`; replace only the OS protocol registration and deep-link handler sites.

---

### 1.2 Rust Workspaces, Crates, Binaries & Sidecar Lookups

The repository has **4 separate Cargo workspaces / `Cargo.lock` roots** under `native/ompdesk/` (941 tracked paths) plus 1 standalone policy test crate, and 1 vendored `ai-memory` workspace under `native/memory/`.

#### Rust Workspace & Crate Inventory (`native/ompdesk/` → `native/momo/`)

| Cargo Root (`Cargo.toml` + `Cargo.lock`) | Current Crate Name | Target Crate Name | Lib / Binary Targets | Direct Refs (Files) |
|---|---|---|---|---:|
| `native/momo/Cargo.toml` (workspace) | `ompdesk-cli` | `momo-cli` | bin `momo` *(was `ompdesk`)* | 10 (7) |
| ↳ member `crates/core` | `ompdesk-core` | `momo-core` | lib `momo_core`, bin `momo-core` | 312 (139) + 18 `ompdesk_core` (2) |
| ↳ member `crates/checks` | `ompdesk-checks` | `momo-checks` | lib `momo_checks` | 10 (7) + 13 `ompdesk_checks` (10) |
| ↳ member `crates/sysproxy` | `ompdesk-sysproxy` | `momo-sysproxy` | lib `momo_sysproxy` | 10 (7) + 8 `ompdesk_sysproxy` (7) |
| `native/momo/crates/shell/Cargo.toml` | `ompdesk-shell` | `momo-shell` | lib `shell_core` *(shared by `tauri-shell`)*, bins `momo-shell`, `momo-launcher` | 184 (64) + 25 `ompdesk-launcher` (11) |
| `native/momo/crates/shell-preview/Cargo.toml` | `ompdesk-shell-preview` | `momo-shell-preview` | lib `momo_shell_preview` | 10 (8) + 5 `ompdesk_shell_preview` (1) |
| `native/momo/crates/tauri-shell/Cargo.toml` | `ompdesk-tauri-shell` | `momo-tauri-shell` | bins `momo-tauri-shell`, `momo-launcher` | 15 (9) + 62 `ompdesk-tauri` (23) |
| `native/momo/crates/tauri-shell/tests/policy/Cargo.toml` | `shell-policy-fixture` | `shell-policy-fixture` *(keep; update path deps if any)* | test fixture | 0 |

> **Path-depth invariance note**: `tauri-shell/src/main.rs` uses `#[path = "../../core/src/owner.rs"]` and `#[path = "../../shell/src/{host,log,node}.rs"]`, and `tauri-shell/src/boot_paint.rs` uses `include_str!("../../../../../src/shared/boot-shell-geometry.json")`. Renaming `native/ompdesk/` → `native/momo/` preserves the exact directory depth, so relative `#[path]` and `include_str!` macros stay valid without depth changes.

#### Staged Binary Directories, Manifests & Sidecar Lookups

| Current Path / Manifest | Target Path / Manifest | Occurrences / Files | Primary Producers & Consumers |
|---|---|---:|---|
| `resources/ompdesk-bin/` (`ompdesk.build.json`) | `resources/momo-bin/` (`momo.build.json`) | 76 / 28 | `.gitignore`, `scripts/{build-native.ts,after-pack.cjs,package-mac.ts,mac-bundle-info.cjs,gen-crate-notices.ts,lock-slots.ts}`, `electron-builder.win.yml`, `src/main/native-bin.ts`, `core/src/control/cli_install.rs`, `src/main/packaging-config.test.ts`, `.github/actions/install/action.yml`, `.github/workflows/{ci.yml,mac-checks.yml,release.yml}` |
| `resources/ompdesk-tauri/` (`ompdesk-tauri.build.json`) | `resources/momo-tauri/` (`momo-tauri.build.json`) | 62 / 23 | `.gitignore`, `scripts/{build-tauri.ts,after-pack.cjs,package-mac.ts,gen-crate-notices.ts}`, `electron-builder.win.yml` (`electronDist`), `e2e/fixture/shell-launch.ts`, `src/main/packaging-config.test.ts`, `.github/actions/tauri-shell/action.yml`, `.github/workflows/{release.yml,mac-checks.yml,e2e-shards.yml}` |
| `resources/ompdesk-shell/` (`ompdesk-shell.build.json`) | `resources/momo-shell/` (`momo-shell.build.json`) | 184 / 64 | `.gitignore`, `scripts/{build-shell.ts,after-pack.cjs,package-mac.ts,gen-crate-notices.ts,mac-bundle-info.cjs}`, `e2e/fixture/shell-launch.ts`, `.github/actions/shell/action.yml` |
| `native/memory/ompdesk.json` | `native/memory/momo.json` | 40 / 12 | `scripts/{build-memory.ts,after-pack.cjs,gen-crate-notices.ts,generate-third-party-notices.ts,windows-installer-check.ps1}`, `src/shared/ai-memory.ts`, `src/main/{ai-memory/service.test.ts,packaging-config.test.ts}`, `.github/workflows/release.yml`, `native/memory/UPSTREAM.md` |
| `LICENSES/ompdesk-{native,preview,shell,tauri}-dependencies.txt` | `LICENSES/momo-{native,preview,shell,tauri}-dependencies.txt` | 21 / 4 | `scripts/gen-crate-notices.ts`, `scripts/generate-third-party-notices.ts`, `THIRD_PARTY_NOTICES.txt` |
| CLI launcher (`cli_install.rs`) | `momo` / `momo.cmd`, `MARKER = "momo CLI launcher, written by Momo"`, `WSLENV=MOMO_HEAVY_HELD` | 15 / 4 | `native/momo/crates/core/src/control/cli_install.rs` *(must update pinned SHA-256 hashes in unit tests!)*, `src/main/control-socket/cli-install.test.ts` |

#### Vendored `native/memory/` Touchpoints (76 Occurrences Across 33 Files)

Keep the `ai-memory` crate/binary names intact, but update the **3 functional touchpoints** in lockstep with Momo:
1. `native/memory/crates/ai-memory-hooks/src/{payload.rs,router.rs}` — parses `<ompdesk-agent-message>` XML tags; MUST switch to `<momo-agent-message>` simultaneously with `gui-bridge` and `core`.
2. `native/memory/crates/ai-memory-store/src/v85_backup.rs` — reads `OMPDESK_BACKUP_PATH`; switch to `MOMO_BACKUP_PATH`.
3. `native/memory/crates/ai-memory-cli/src/commands/doctor.rs` — prints `"OMPdesk's ai-memory build"`; change to `"Momo's ai-memory build"`.
4. `native/memory/ompdesk.json` → `native/memory/momo.json` (plus test identities in `admin_write_page.rs`, `identity_resolution.rs`).

#### Rust Golden Parity Fixtures (`captured.json` & `matrix.json`)

High-volume golden test fixtures under `native/momo/crates/core/src/` contain thousands of `ompdesk` references that must be updated in lockstep with code changes (or regenerated by their capture harnesses):
- `agentctl/journal/captured.json` (2,040), `agentctl/app/captured/list.json` (444), `web/matrix.json` (435 — 394 cookie refs), `tools/setup/plans-captured.json` (228), `agentctl/service/captured.json` (175), `agentctl/rules/captured.json` (148), `upkeep/rules_file-captured.json` (77), `gh/auth-captured.json` (37 `SeuPut0705/ompdesk`), `procs/pressure_record/captured.json` (2 `OMPdesk.exe`), `procs/console-attribution.json` (1 `OMPdesk.exe`).

---

### 1.3 Data Paths, Caches, Sockets, Keychain, Project Hooks, Env Vars & Agent Tools

#### Filesystem Paths, Keychain, Sockets & Pipes

| Surface | Current | Target (Fresh — No Migration) | Occurrences / Files | Primary Files |
|---|---|---|---:|---|
| macOS `userData` | `~/Library/Application Support/ompdesk` | `~/Library/Application Support/momo` | 13 / 12 | `src/main/index.ts`, `shell/src/startup.rs`, `scripts/mac-launch-check.sh`, `scripts/vitest-real-home-guard.test.ts`, `docs/troubleshooting*.md` |
| Windows `userData` | `%APPDATA%\ompdesk` | `%APPDATA%\momo` | 2 / 2 | `shell/src/startup.rs`, `resources/installer.nsh` |
| Dev profile `userData` | `ompdesk-dev` | `momo-dev` | 7 / 6 | `scripts/dev.ts`, `core/src/git/worktree.rs`, `AGENTS.md`, `CONTRIBUTING.md`, `README.md` |
| Windows install root | `%LOCALAPPDATA%\Programs\ompdesk` | `%LOCALAPPDATA%\Programs\momo` | 6 / 4 | `electron-builder.win.yml`, `scripts/windows-installer-check.ps1`, `resources/installer.nsh` |
| Windows managed tools | `%LOCALAPPDATA%\ompdesk\tools` | `%LOCALAPPDATA%\momo\tools` | 6 / 4 | `src/main/setup/paths.ts`, `core/src/setup/*` |
| Windows updater cache | `%LOCALAPPDATA%\ompdesk-updater\pending` | `%LOCALAPPDATA%\momo-updater\pending` | 21 / 11 | `src/main/updater.ts:387`, `src/main/updater-install.test.ts`, `scripts/shell-move/*` |
| POSIX caches (heavy, scratch, formal, gh-budget) | `~/.cache/ompdesk/{heavy,scratch,formal,gh-budget}` | `~/.cache/momo/{heavy,scratch,formal,gh-budget}` | 25 / 22 | `checks/src/heavy.rs`, `core/src/{disk/scratch.rs,gh/mod.rs}`, `src/main/session-scratch.ts`, `resources/gui-bridge/gh-guard.ts`, `resources/omp-builtin/formal/skills/momo-formal-verify/scripts/lib/cache.ts`, `.github/workflows/formal.yml` |
| Local macOS signing dir | `~/.ompdesk-signing/ompdesk-signing.p12` *(note: runtime code never writes to `~/.ompdesk` — desktop `userData` is OS-standard `Application Support/momo` and `%APPDATA%\momo`; `~/.momo` remains cleanly reserved and distinct from stock `omp`'s `~/.omp`)* | `~/.momo-signing/momo-signing.p12` | 4 / 2 | `scripts/mac-sign.cjs:12,25`, `.omp/rules/e2e-ci-windows.md` |
| Repo-local project hooks dir | `.ompdesk/` (`worktree-setup{,.cmd}`, `worktree-{pre,post}-merge`, `worktree-archive`, `sparse`, `checks.json`, `worktree.json`) | `.momo/` | 237 / 69+ | `.ompdesk/worktree-setup{,.cmd}` → `.momo/worktree-setup{,.cmd}`, `core/src/{git/worktree.rs,checks/*}`, `src/main/worktree*.ts`, `src/renderer/locales/{en,ko}.ts` (`newTask.sparseHint`) |
| macOS Keychain item | Service `"ompdesk Safe Storage"` / Account `"ompdesk Key"` | Service `"momo Safe Storage"` / Account `"momo Key"` | 31 / 12 | `shell/src/sys_mac/keychain.rs`, `shell/src/migrate/safe_storage.rs`, `src/main/{index.ts,update-auth.ts}` |
| Single-instance socket/pipe | `\\.\pipe\ompdesk-shell-<hash>` / `ompdesk-<hash>-{shell,host-<pid>}.sock` | `\\.\pipe\momo-shell-<hash>` / `momo-<hash>-{shell,host-<pid>}.sock` | 9 / 8 | `shell/src/{startup.rs,conn.rs,sys/pipe.rs}` |
| Core hub/clients pipe/socket | `\\.\pipe\ompdesk-{hub,clients}-<rand>` / `tmpdir/ompdesk-{hub,clients}-*` / worker `ompdesk-core-owner` | `\\.\pipe\momo-{hub,clients}-<rand>` / `tmpdir/momo-{hub,clients}-*` / `momo-core-owner` | 20 / 5 | `src/main/core/process.ts`, `core/src/{run.rs,owner.rs,clients.rs,hub/mod.rs}` |
| Control socket/pipe | `\\.\pipe\ompdesk-<rand>` / `tmpdir/ompdesk-<uid>-<tag>/control.sock` | `\\.\pipe\momo-<rand>` / `tmpdir/momo-<uid>-<tag>/control.sock` | 8 / 5 | `src/main/control-socket/endpoint.ts`, `core/src/control/listen.rs` |
| HTTP User-Agents | `ompdesk-updater`, `ompdesk-setup` | `momo-updater`, `momo-setup` | 6 / 4 | `core/src/update_feed/net.rs`, `core/src/setup/net.rs` |
| VAPID Push Subject | `https://github.com/seuput-inc/ompdesk` | `https://github.com/seuput-inc/momo` | 2 / 2 | `core/src/web/push.rs:45`, `src/main/web/vapid-store.test.ts` |
| Legacy migration modules | `legacy_user_data.rs` (`seucode` → `ompdesk`), `src/main/legacy-user-data.test.ts` | **DELETE** (zero legacy migration) | 18 / 5 | Delete `tauri-shell/src/legacy_user_data.rs` + its call in `tauri-shell/src/main.rs` + `src/main/legacy-user-data.test.ts` |

#### Environment Variables: All 142 `OMPDESK_*` → `MOMO_*` (1,040 Occurrences / 207 Files)

Every `OMPDESK_*` variable and constant renames directly to `MOMO_*`:

- **Build / lock / heavy-pool orchestration (17)**: `OMPDESK_LOCK_OWNER` (113), `OMPDESK_HEAVY_HELD` (36), `OMPDESK_HEAVY_DIR` (18), `OMPDESK_HEAVY_SLOTS` (18), `OMPDESK_BUILD_LOCK_HELD` (11), `OMPDESK_FORCE_BUILD` (10), `OMPDESK_LOCK_SLOTS` (9), `OMPDESK_NO_LOCAL_CARGO` (9), `OMPDESK_LOCK_ROOT` (7), `OMPDESK_LOCK_RAM_GB` (7), `OMPDESK_HEAVY_MIN_FREE_GB` (6), `OMPDESK_LOCK_POLL_MS` (4), `OMPDESK_HEAVY_DANGER_GB` (3), `OMPDESK_HEAVY_LABEL` (2), `OMPDESK_LOCK_LOG` (2), `OMPDESK_LOCK_REPORT_MS` (2), `OMPDESK_LOCK_MAX_HOLD_MS` (2), `OMPDESK_LOCK_HEARTBEAT_MS` (2)
- **Runtime / core / shell / control IPC (30)**: `OMPDESK_CONTROL_OFF` (16), `OMPDESK_APP_DIR` (16), `OMPDESK_SHELL_SOCKET` (13), `OMPDESK_CONTROL_DIR` (11), `OMPDESK_CALLER` (10), `OMPDESK_APP_ENTRY` (10), `OMPDESK_CLIENTS` (9), `OMPDESK_SOCKET` (8), `OMPDESK_NODE` (8), `OMPDESK_HUB` (7), `OMPDESK_HUB_TOKEN` (6), `OMPDESK_SHELL_TOKEN` (6), `OMPDESK_LEFT_BEHIND` (6), `OMPDESK_ISOLATED` (6), `OMPDESK_SHELL_ENGINE` (5), `OMPDESK_CLIENTS_TOKEN` (5), `OMPDESK_STDIO_OWNER` (5), `OMPDESK_TAURI_IPC_FETCH` (4), `OMPDESK_SHELL_TRACE` (4), `OMPDESK_ICON` (4), `OMPDESK_SHELL_EXE` (3), `OMPDESK_CORE_DEBUG` (3), `OMPDESK_RELAUNCHED_BY` (2), `OMPDESK_ASKPASS_SOCKET` (1), `OMPDESK_ASKPASS_TOKEN` (1), `OMPDESK_SHELL_RELAUNCH_AFTER_PID` (1), `OMPDESK_PREVIEW_BROWSER` (1), `OMPDESK_RUN_TEMP` (1), `OMPDESK_BASE_TEMP` (1), `OMPDESK_ENV` (2)
- **Packaging / signing / updater / launcher (11)**: `OMPDESK_SWAP_START_WAIT_S` (7), `OMPDESK_LAUNCHER_RELEASE_URL` (7), `OMPDESK_MAC_SIGNING_REQUIRED` (6), `OMPDESK_LAUNCHER_START_WAIT_S` (6), `OMPDESK_MAC_SIGNING_P12_BASE64` (4), `OMPDESK_MAC_SIGNING_PASSWORD` (3), `OMPDESK_LAST_ELECTRON_TAG` (3 — *delete with Electron move*), `OMPDESK_UPDATE_LOCK_CHECK_ROOT` (1), `OMPDESK_INSTALL_CHECK_ROOT` (1), `OMPDESK_INSTALL_CHECK_PROGRAM_FILES` (1), `OMPDESK_SETUP_SPEC` (8)
- **Worktrees / hooks / checks / GitHub budget / memory (13)**: `OMPDESK_WORKTREE_FOLDER` (9), `OMPDESK_GH_BUDGET_DIR` (8), `OMPDESK_WORKTREE_PATH` (7), `OMPDESK_CHECK_RUN` (7), `OMPDESK_CHECK_RESULTS` (7), `OMPDESK_CHECKS_DIR` (7), `OMPDESK_HOOK` (5), `OMPDESK_ROOT_PATH` (4), `OMPDESK_HOOK_SCRIPT` (2), `OMPDESK_SCRIPT` (2), `OMPDESK_BACKUP_PATH` (2 — *also in `native/memory`!*), `OMPDESK_EDITOR_DRAFT` (2), `OMPDESK_CI_SIBLINGS` (2)
- **Formal verification toolchain (7)**: `OMPDESK_FORMAL_CACHE` (43), `OMPDESK_FORMAL_OFFLINE` (33), `OMPDESK_FORMAL_JOBS` (10), `OMPDESK_FORMAL_NO_SYSTEM_JAVA` (9), `OMPDESK_FORMAL_TOOLCHAIN` (9), `OMPDESK_FORMAL_SYSTEM_LEAN` (6), `OMPDESK_FORMAL_JAVA` (5)
- **Model roles constants & env (6)**: `OMPDESK_ROLES` (15), `OMPDESK_ROLES_ENV` (9), `OMPDESK_ROLES_FILE` (5), `OMPDESK_ROLE_IDS` (4), `OMPDESK_ROLES_PROBE` (4), `OMPDESK_ROLES_PROBE_FAILED` (1) — plus **`OMP_GUI_OMPDESK_ROLES`** (11 / 7 files) → **`OMP_GUI_MOMO_ROLES`** (the sole `OMP_GUI_*` env var containing `OMPDESK`; rename its contract file `resources/gui-bridge/ompdesk-role-contracts.ts` → `momo-role-contracts.ts`, `ompdesk-roles.ts` → `momo-roles.ts`, and `ompdesk-roles.json` → `momo-roles.json`).
- **Tests / fakes / screenshot harnesses (58)**: `OMPDESK_SETTINGS_SHOTS` (37), `OMPDESK_SETTINGS_SECTIONS` (29), `OMPDESK_TAURI_TEST_BINARY` (20), `OMPDESK_FAKE_INSTALLER_DIR` (14), `OMPDESK_FAKE_OMP` (12), `OMPDESK_SETTINGS_SIZES` (11), `OMPDESK_TAURI_TEST_OUTPUT` (10), `OMPDESK_PREVIEW_TEST_SCRATCH` (8), `OMPDESK_TAURI_TEST_NODE` (7), `OMPDESK_PREVIEW_TEST_BROWSER` (7), `OMPDESK_LINK_EVENTS_CAPTURE` (6), `OMPDESK_RESET_FAKE` (6), `OMPDESK_MODE_SHOTS` (5), `OMPDESK_THEME_SHOTS` (5), `OMPDESK_TEST_EDIT_MENU` (4), `OMPDESK_TEST_PAGES_SHADOW` (4), `OMPDESK_PROFILE_TEST_ROOT` (3), `OMPDESK_EVENTS_COST_ROUNDS` (3), `OMPDESK_THEMES` (3), `OMPDESK_FAKE_FEED` (3), `OMPDESK_FAKE_NEW_VERSION` (3), `OMPDESK_GATEWAY_TEST_{BUN,BROWSER,SCRATCH}` (9), `OMPDESK_CREDIT_FAKE` (3), `OMPDESK_TEST_SHELL_POLICY` (2), `OMPDESK_MCP_PROBE` (2), `OMPDESK_SHOTS_DIR` (2), `OMPDESK_FAKE_{CLAUDE_VERSION,PROVIDERS,MCP_PACKAGE,GH_TARGET,GH_SOURCE,FAIL_OUTPUT,VERSION_FILE,LOG}` (16), `OMPDESK_THEME_PREFIX` (2), `OMPDESK_TEST_{QUEUE_CLASS,QUEUE_WEIGHT,EOF_CHILD,GO,SAVED,QUEUE_WORKER_DIR,TAG_,OWN_ENV}` (13), `OMPDESK_STAND_IN_WORKER` (2), `OMPDESK_CREDIT_SCENARIO` (2), `OMPDESK_RESET_{CASES,PICKS,LOST,STORED}` (8), `OMPDESK_WEB_{P256,MATRIX}` (3), `OMPDESK_SETTINGS` / `OMPDESK_SETTINGS_SHO` (2), `OMPDESK_TOOLS_TEST_{INSTALLER,PID}` (2).

#### Agent Control Tools, XML Wrappers, Dotted Session Keys, MCP IDs & Builtin Skills

| Family | Current Identifiers | Target Identifiers | Occurrences / Files | Notes |
|---|---|---|---:|---|
| Agent control tools (20 tools) | `ompdesk_session_open` (824), `ompdesk_report` (221), `ompdesk_sessions` (209), `ompdesk_session_send` (130), `ompdesk_autopilot` (126), `ompdesk_app` (125), `ompdesk_schedule` (108), `ompdesk_session_stop` (108), `ompdesk_session_result` (104), `ompdesk_bot` (103), `ompdesk_session_answer` (92), `ompdesk_session_read` (81), `ompdesk_merge` (69), `ompdesk_app_list` (68), `ompdesk_compare` (67), `ompdesk_item` (55), `ompdesk_notify` (29), `ompdesk_tab_focus` (25), `ompdesk_room` (23), `ompdesk_checks` (13) | `momo_*` (same suffixes) | ~2,600 / 160+ | Registered in `core/src/agentctl/`, `resources/gui-bridge/`, `resources/omp-builtin/skills/momo/`, `src/main/agent-control/`, `e2e/` |
| XML message wrappers | `<ompdesk-mail>`, `<ompdesk-agent-message>`, `<ompdesk-worker>`, `<ompdesk-bot>`, `<ompdesk-bot-note>` | `<momo-mail>`, `<momo-agent-message>`, `<momo-worker>`, `<momo-bot>`, `<momo-bot-note>` | 1,110 / 90+ | **Lockstep requirement**: update `native/memory/crates/ai-memory-hooks/src/{payload.rs,router.rs}` alongside `gui-bridge`, `core`, `src/main`, `src/renderer` |
| Dotted session journal / metadata keys | `ompdesk.mail`, `ompdesk.auto-title`, `ompdesk.checkout-claims`, `ompdesk.worker`, `ompdesk.bot`, `ompdesk.prompt-origin`, `ompdesk.agent-answer`, `ompdesk.autopilot*`, `ompdesk.label`, `ompdesk.gui-bridge`, `ompdesk.todo-drift`, `ompdesk.baseRef` | `momo.*` | 320 / 60+ | Fresh Momo installs start with fresh sessions; rename cleanly in `gui-bridge`, `core`, `src/main`, `src/renderer` |
| MCP server & bridge IDs | `ompdesk-memory`, `ompdesk-memory-recall`, `ompdesk-memory-curate`, `ompdesk-native-input`, `ompdesk-roles.ts`, `ompdesk-role-contracts.ts` | `momo-memory`, `momo-memory-recall`, `momo-memory-curate`, `momo-native-input`, `momo-roles.ts`, `momo-role-contracts.ts` | 87 / 40+ | Update `docs/rust-inventory/host-imports.tsv` line 25 for `momo-role-contracts.ts` |
| Authored builtin skills *(inside kept `resources/omp-builtin/`)* | `skills/ompdesk/` (10 files), `skills/ompdesk-mobile-emulator/` (1 file), `formal/skills/ompdesk-formal-verify/` (171 files) | `skills/momo/`, `skills/momo-mobile-emulator/`, `formal/skills/momo-formal-verify/` | 182 paths / 303 text refs | Keep outer `resources/omp-builtin/` folder name (stock `omp` convention); update skill names, `SKILL.md` frontmatter, `.github/workflows/formal.yml`, `src/main/formal/*.test.ts`, `scripts/omp-boundary/touchpoints.ts` |

---

### 1.4 GitHub Actions Workflows, Scripts, Auto-Updater & Signing Secrets

#### Complete `.github/` Inventory (31 Files, 346 `ompdesk` Occurrences Across 22 Files)

| File | Hits | Action Required for `seuput-inc/momo` |
|---|---:|---|
| `.github/workflows/release.yml` | 122 | Rename app/binary/asset/artifact/comment strings (`Momo.app`, `Momo.exe`, `momo-mac-arm64.dmg`, `momo-windows-setup.exe`, `<!-- momo-update ... -->`, `com.seuput.momo`, `momo-bin`, `momo-tauri`, `native/momo`, `native/memory/momo.json`, `momo://`). Keep secret names `MAC_SIGNING_P12_BASE64` / `MAC_SIGNING_PASSWORD`. **Bootstrap fix**: make `release-update-mac` & `win-update-real` conditional on a prior stable Momo release existing (skip on `v0.1.0`, enforce from `v0.2.0`+) and drop Electron `v0.131.0` baseline. |
| `.github/workflows/shell-batch-checks.yml` | 78 | **Prune or delete**: Branch-only Electron/CEF move workflow (`omp/agent/rust-batch-shell`, hardcoded `v0.127.0`/`v0.128.0`/`v0.131.0`/`v0.132.0`/`v0.134.1`). If keeping `release-verify` / `phone-webkit-mac` / `tauri-*` diagnostic dispatches, strip all Electron move jobs and rename remaining refs to `momo`. |
| `.github/actions/tauri-shell/action.yml` | 20 | Rename `native/ompdesk` → `native/momo`, `resources/ompdesk-tauri` → `resources/momo-tauri`, crate/binary names (`momo-tauri-shell`, `momo-shell-preview`, `momo-sysproxy`), cache keys. |
| `.github/actions/install/action.yml` | 18 | Rename `resources/ompdesk-bin` → `resources/momo-bin`, `native/ompdesk` → `native/momo`, `ompdesk.build.json` → `momo.build.json`, cache keys. |
| `.github/workflows/mac-checks.yml` | 16 | Rename paths/app/artifacts to `momo`. **Bootstrap fix**: **remove** the `webkit-store-mac.sh` step (lines 52–53 download OMPdesk `v0.132.0` from `$GITHUB_REPOSITORY` to test pre-CFBundleIdentifier adoption, which never exists in Momo). |
| `.github/workflows/omp-latest.yml` | 16 | Rename `OMPdesk` → `Momo` in issue title/body & regex (`/^omp (\d+\.\d+\.\d+) fails against Momo (\d+\.\d+\.\d+)$/`), branch/env refs. Verify Actions can push orphan `omp-compat` and `omp/bump/*` branches. |
| `.github/workflows/ci.yml` | 13 | Rename `resources/momo-bin`, `momo-windows-setup.exe`, `Momo.exe`, `native/momo` paths & artifact names. Static job enforces `rust-runtime-scope.ts --check-inventory` and `bun run licenses:check`. |
| `.github/actions/native-toolchain/action.yml` | 11 | Rename `native/ompdesk` → `native/momo` and cache keys. |
| `.github/actions/shell/action.yml` | 10 | Rename `native/ompdesk/crates/shell` → `native/momo/crates/shell`, `resources/momo-shell`. |
| `.github/actions/native-check/action.yml` | 8 | Rename `native/ompdesk` → `native/momo` cargo workspace paths. |
| `.github/actions/shell-toolchain/action.yml` | 8 | Rename `native/ompdesk/crates/shell` → `native/momo/crates/shell` cache keys. |
| `.github/actions/mac-update-candidate/action.yml` | 5 | Rename `Momo.app`, `com.seuput.momo`, `momo-mac-arm64.dmg`. Guard for empty release history on `v0.1.0`. |
| `.github/workflows/formal.yml` | 5 | Update cache path `~/.cache/momo/formal`, skill path `resources/omp-builtin/formal/skills/momo-formal-verify/`, `MOMO_FORMAL_*` env vars. **KEEP** `seuput-inc/ompdesk-formal-tools` in `toolchain.json` unless mirrored. |
| `.github/actions/win-update-real/action.yml` | 4 | Rename `momo-windows-setup.exe`, `Momo.exe`; replace Electron `last-electron.json` baseline with latest published Momo Tauri release (skip on `v0.1.0`). |
| `.github/actions/native-parity/action.yml` | 2 | Rename `native/ompdesk` → `native/momo`. |
| `.github/actions/shell-check/action.yml` | 2 | Rename `native/ompdesk/crates/shell` → `native/momo/crates/shell`. |
| `.github/workflows/setup-assets-health.yml` | 2 | Rename `native/ompdesk` → `native/momo` / binary names. |
| `.github/ISSUE_TEMPLATE/bug_report.yml` | 2 | Display copy `OMPdesk` → `Momo`. |
| `.github/ISSUE_TEMPLATE/config.yml` | 1 | Update Security Advisory link `seuput-inc/ompdesk` → `seuput-inc/momo`. |
| `.github/actions/install-omp/action.yml` | 1 | Rename `native/ompdesk` / comment ref. |
| `.github/release-keep.json` | 1 | Reset OMPdesk historical pins (`v0.127.0`..`v0.134.1`) to `{"latest": 3, "keep": {}}` (and update `scripts/release-keep.test.ts`). |
| `.github/workflows/e2e-shards.yml` | 1 | Rename `resources/momo-tauri` artifact/path. |
| `.github/workflows/skills-bump.yml` | 0 | **Critical ruleset check**: currently runs `git push origin HEAD:main` daily (`41 5 * * *`) via `GITHUB_TOKEN`. Under a protected `main` ruleset, retarget this push to **`dev`** (aligning with `AGENTS.md`: `dev` integrates routine work, `main` is release-only) or configure a GitHub App bypass. |
| Remaining 8 `.github/` files (`e2e-nightly.yml`, `flake-probe.yml`, `mac-main.yml`, `omp-vitest.yml`, `queue-gate.yml`, `shell-mac-inputs/action.yml`, `feature_request.yml`, `pull_request_template.md`) | 0 | Review triggers/branch filters (`main` / `dev`) only; no `ompdesk` strings. |

#### Repository URL & Auto-Updater Feed Inventory (`seuput-inc/ompdesk` → `seuput-inc/momo`)

- **Total**: **68** occurrences of `seuput-inc/ompdesk` across **46** files (subtract 3 kept `seuput-inc/ompdesk-formal-tools` refs = **65** to update), PLUS **1 stale pre-org-transfer bug** in `native/ompdesk/crates/shell/src/launcher.rs:14` (`pub const REPO: &str = "SeuPut0705/ompdesk";`) and 19 `SeuPut0705/ompdesk` refs in `scripts/shell-move/*` + tests.
- **Canonical runtime sources that MUST all point to `seuput-inc/momo`**:
  1. `src/shared/product-repo.ts` (`PRODUCT_REPO = "seuput-inc/momo"`) — single TS source of truth for updater, feedback dialog, docs links.
  2. `native/momo/crates/core/src/tools/omp/compat.rs:20` (`DEFAULT_REPO` — `omp-compat` branch fetch URL).
  3. `native/momo/crates/core/src/web/push.rs:45` (VAPID `sub` URL).
  4. `native/momo/crates/tauri-shell/src/app_menu.rs:23` (Help / repository URL).
  5. `native/momo/crates/shell/src/launcher.rs:14` (`pub const REPO: &str = "seuput-inc/momo";` — fixes stale `SeuPut0705/ompdesk`!).
  6. `package.json`, `electron-builder.yml`, `electron-builder.win.yml`, `README.md`, `README.ko.md`, `SECURITY.md`, `AGENTS.md`, `.github/ISSUE_TEMPLATE/config.yml`, `.ai-memory.toml` (`project = "momo"`), `resources/gui-bridge/modes/{a2ui-catalog.json,a2ui-contracts.ts}`, `scripts/dev-release.mjs`.

#### Key Release & Build Scripts (`scripts/`: 1,200 Occurrences Across 126 of 224 Files)

Highest-impact scripts to update carefully (do not miss hidden hardcoded paths):
- **Packaging & signing**: `scripts/package-mac.ts` (20), `scripts/mac-bundle-info.cjs` (18), `scripts/mac-sign.cjs` (17), `scripts/mac-signing.json` (new cert CN & SHA-1), `scripts/after-pack.cjs` (23), `scripts/mac-launch-check.sh` (18), `scripts/windows-installer-check.ps1` (56), `scripts/reinstall-mac.sh` (5), `scripts/release-prune.sh`, `scripts/dev-release.mjs`.
- **Native builders & locks**: `scripts/build-native.ts` (16), `scripts/build-tauri.ts` (16), `scripts/build-shell.ts` (19), `scripts/build-memory.ts` (4), `scripts/lock-slots.ts` (54), `scripts/build-lock.ts` (12), `scripts/dev.ts` (2), `scripts/tauri-native-smoke.ts` (24).
- **Licensing, branding & guards**: `scripts/generate-third-party-notices.ts` (48), `scripts/gen-crate-notices.ts` (39), `scripts/brand-svgs.ts` (16), `scripts/gen-icons.ts`, `scripts/boot-shell.ts`, `scripts/pwa-plugin.ts`, `scripts/omp-boundary/touchpoints.ts` (58), `scripts/omp-bump/{compat.ts,dictionaries.ts,latest-run.test.ts}`, `scripts/sync-pstack.ts` (30), `scripts/rust-runtime-scope.ts`, `scripts/check-main-bundle.ts`, `scripts/readme-media/check-readme.ts`.
- **Legacy Electron move harness (`scripts/shell-move/*`, ~300+ hits)**: Delete obsolete Electron `v0.127`–`v0.132` scripts (`last-electron.json`, `webkit-store-mac.sh`, `keychain-ci.sh`, `assisted-installer.yml`, Electron portions of `move-mac.sh` and `run-move.ts`); keep and rebrand only the Tauri-to-Tauri update gate helpers (`feed.ts`, `mac-update-gate.sh`, `win-update-gate.ps1`, `release-assets.sh`, `constants.ts`).

#### Required Signing & Repository Secrets (NAMES ONLY — NEVER VALUES)

| Secret Name | Used In | Platform / Purpose | Action on `seuput-inc/momo` |
|---|---|---|---|
| `MAC_SIGNING_P12_BASE64` | `.github/workflows/release.yml:340` | Base64-encoded PKCS#12 self-signed macOS code-signing identity (`CN=Momo Code Signing`) | **REQUIRED** — Generate fresh cert, base64-encode `.p12`, add as Actions secret |
| `MAC_SIGNING_PASSWORD` | `.github/workflows/release.yml:341` | Password protecting the `.p12` above | **REQUIRED** — Add matching password as Actions secret |
| *(macOS Notarization)* | *None* | Not used (`codesign --timestamp=none`; `SECURITY.md` & `README` document first-launch right-click → Open) | None required |
| *(Windows Authenticode)* | *None* | Currently unsigned (`verifyUpdateCodeSignature: false` in `electron-builder.win.yml`; no Windows signing secrets in `release.yml`) | None required unless Windows signing is introduced later |
| *(Repository Variables `vars.*`)* | *None* | Zero repository variables referenced in `.github/` | None required |

> **Pinned Certificate Lockstep**: `scripts/mac-signing.json` stores `commonName` and `certificateSha1`. It is read not only by `scripts/mac-sign.cjs` and `release.yml`, but also by `src/main/ai-memory/staging.ts` (`AI_MEMORY_REQUIREMENT` checks the signed `ai-memory` helper) and `scripts/package-mac.ts` (`checkShellIdentity`). Update `scripts/mac-signing.json` in the exact commit that switches to `Momo Code Signing`.

---

### 1.5 UI Copy, Locales, Documentation, Brand Assets & `BotFace`

#### User-Visible Locales, Native Menus, Web Chrome & Docs

| File | Total Hits | Breakdown (`OMPdesk` / `ompdesk`) | Notes |
|---|---:|---|---|
| `src/renderer/locales/en.ts` | 197 | 188 / 9 | 9 lowercase hits: `.ompdesk/sparse`, `ompdeskRoles` key, `ompdesk` CLI command copy (5), `themePicker.set.ompdesk.*` keys (2) |
| `src/renderer/locales/ko.ts` | 176 | 167 / 9 | Same 9 lowercase slots + 167 display strings. **Korean particle audit verified**: 100% vowel-ending particles (`가` 130, `를` 56, `는` 29, `의` 14, `에서` 10, `에` 9, `와` 8, `로` 6, `만` 2, `에서는` 2, `처럼`/`인가요`/`예요`/`면` 1 each; **0 consonant-ending**). `Momo` (모모) also ends in a vowel (`ㅗ`), so zero Korean particle rewrites are needed! |
| `src/main/i18n-text.ts` | 66 | 65 / 1 | Main-process dialogs, notifications, error messages (EN + KO) |
| `src/renderer/locales/memory/{overview,shell}.ts` | 16 | 16 / 0 | 8 each |
| `src/renderer/locales/bot-autonomy.ts` | 4 | 4 / 0 | Bot autonomy copy |
| `src/renderer/components/settings/schema-ko.ts` | 1 | 1 / 0 | Settings search/schema label |
| `native/momo/crates/tauri-shell/src/native_labels.json` | 14 | 14 / 0 | macOS/Windows native menu bar & tray labels (EN + KO) |
| `src/renderer/public/manifest.webmanifest` | 5 | 5 / 0 | PWA `name`, `short_name`, `description` |
| `src/renderer/{index.html,web.html,public/pre-paint.js}` | 5 | 5 / 0 | `<title>`, meta tags, pre-paint shell title |
| Theme set & labels (`src/shared/theme-names.ts`, `src/renderer/lib/theme*.ts`, `src/renderer/styles/theme-{light,dark}.css`, `e2e/*.e2e.ts`) | 40 | across 21 files | `THEME_SETS[0].id`: `"ompdesk"` → `"momo"`; labels `"OMPdesk Light"` / `"OMPdesk Dark"` → `"Momo Light"` / `"Momo Dark"` (CSS theme IDs `"light"` / `"dark"` stay unchanged!) |
| Root docs: `README.md` (22), `README.ko.md` (19), `AGENTS.md` (70), `SECURITY.md` (8), `CONTRIBUTING.md` (5), `NOTICE` (4), `AUTOPILOT.md` (3) | 131 | 7 files | Update `NOTICE` §6 trademark clause to `"Momo"` (preserve Apache-2.0 copyright `2026 SeuPut` & MIT historical note if desired, or clean Apache-2.0 notice for Momo) |
| `CHANGELOG.md` | 347 | 219 / 128 | **Reset fresh** for Momo `v0.1.0` (do not carry 347 historical OMPdesk release notes into the new repo) |
| `docs/*.md` & `docs/design/*.md` | 315 | 20 files | `troubleshooting{,.ko}.md`, `updates{,.ko}.md`, `remote-devices{,.ko}.md`, `mobile-web{,.ko}.md`, `autopilot{,.ko}.md`, `windows-dev.md`, `open-work.md`, `rust-*.md`, `design/*.md` |
| `docs/rust-inventory/*.tsv` | 26 | 4 files | `host-imports.tsv` (6), `remote.tsv` (14), `root.tsv` (4), `services.tsv` (2) — enforced by `scripts/rust-runtime-scope.ts --check-inventory` in `ci.yml`! |
| `THIRD_PARTY_NOTICES.txt` & `LICENSES/*` | 89 | 6 files | Regenerated by `scripts/gen-crate-notices.ts` + `bun run gen:licenses` after updating script prose (`OMPdesk` → `Momo`). Preserves every third-party attribution verbatim. |

#### Brand Mark, Wordmark, Icons, Media & `BotFace`

| Asset / Source | Path | What Must Change |
|---|---|---|
| Wordmark SVG geometry | `scripts/brand-svgs.ts:66-76` (`WORDMARK_LETTERS`) | Hand-drawn SVG paths currently spell `o m p d e s k`. **Redesign `WORDMARK_LETTERS` to spell `m o m o`** (drives `wordmark-light.svg`, `wordmark-dark.svg`, `social-preview.{svg,png}`, `dmg-background.{svg,tiff}`). |
| Icon mark geometry | `src/shared/brand-mark.ts`, `src/renderer/components/common/BrandMark.tsx`, `src/shared/boot-shell-geometry.json`, `tauri-shell/src/boot_paint.rs` | Currently renders the π-foot mark. **Decision gate**: either (a) keep π geometry initially and only update alt-text/comments + wordmark, or (b) replace with a new Momo mark in `brand-mark.ts` + `boot-shell-geometry.json` + `boot_paint.rs` + `src/shared/brand-mark.test.ts` (which asserts π geometry). |
| Generated icons, tray, DMG, PWA, HTML boot shell | `resources/icon.{icns,ico,png}`, `resources/icon-source*.svg`, `resources/dmg-background.tiff`, `resources/brand/*`, `src/renderer/public/{apple-touch-icon.png,icons/*.png}`, `src/renderer/{index.html,web.html}` | **Never hand-edit**. Run **`bun run gen:icons`** on **macOS** (requires `iconutil` and `tiffutil`) after updating `brand-svgs.ts` / `brand-mark.ts`. Verified by `brand-mark.test.ts` and `packaging-config.test.ts`. |
| `BotFace` animated mascot | `src/renderer/components/common/BotFace.tsx`, `src/renderer/lib/bot-face{,-rig,-acting,-motion}.ts`, `e2e/bot-face-upgrade.e2e.ts` | Adapted from **`momobot`** (MIT, `Copyright (c) 2026 CopilotKit`). **Keep code, component names, and all `momobot` MIT attributions intact** (`LICENSES/MIT-momobot.txt`, file headers, `THIRD_PARTY_NOTICES.txt`). |
| README & PWA screenshots | `docs/media/*.webp` (13 files), `src/renderer/public/screenshots/{narrow,wide}.png`, `docs/design/*.png` (10 files) | Re-capture after branding settles (`bun run readme:media`, validated by `bun run readme:check`). Note: upload regenerated `resources/brand/social-preview.png` manually in GitHub Settings → Social preview. |

---

### 1.6 Deliberate KEEP List (DO NOT Blindly Rename)

| Pattern / Path | Count | Why It MUST Stay Unchanged |
|---|---:|---|
| Stock `omp` CLI, binary, packages & user dir (`omp`, `omp update`, `@oh-my-pi/*`, `~/.omp/`, `MIN_OMP_VERSION`, `src/shared/omp-tested.json`, `scripts/omp-boundary/`, `scripts/omp-bump/`, `.omp/rules/`, `.omp/skills/`, `omp-compat` branch) | repo-wide | Momo wraps upstream **stock `omp`** (`can1357/oh-my-pi`) without forking or vendoring it. Sessions, auth, extensions, and rules live under `~/.omp/` and `.omp/`. |
| `omp://rpc.md`, `omp://sdk.md`, `omp://extensions.md`, `omp://settings.md`, `omp://session.md` | 35 | Upstream stock `omp` internal doc URI scheme (distinct from the OS deep-link protocol). |
| `resources/omp-builtin/` folder name | 327 / 78 | Stock `omp` extension-root packaging convention (`pstack/`, `ecc/`, `ponytail/`, `interfaces/`, `matt/`). Rename only Momo's own authored skills *inside* it (`skills/momo`, `skills/momo-mobile-emulator`, `formal/skills/momo-formal-verify`). |
| `momobot` MIT attribution (`LICENSES/MIT-momobot.txt`, `Copyright (c) 2026 CopilotKit`, headers in `BotFace.tsx` & `bot-face*.ts`, `THIRD_PARTY_NOTICES.txt`, `scripts/generate-third-party-notices.ts`) | 21 / 8 | Legal MIT license requirement; coincidental name similarity with Momo makes it critical never to strip or alter these notices. |
| Other third-party attributions & vendored engines (`ai-memory` crates/binary/config under `native/memory/`, `Mixdog`, `lobe-icons`, `A2UI` / `@a2ui/web_core`, `agent-desktop`, `Orca` palette credit, `pstack`, `ECC`, `Ponytail`, `proof-skills`, `Solarized`/`Gruvbox`/`Primer`) | 15,330+ | Upstream copyright, Apache-2.0 / MIT attribution, and vendored binary contracts. |
| External companion repo `seuput-inc/ompdesk-formal-tools` | 3 (`toolchain.json`, `toolchain.test.ts`, `.omp/rules/builtin-packs.md`) | Hosts the pinned `tla2tools.jar` release artifact. Blindly replacing `seuput-inc/ompdesk` breaks `toolchain.json` download URLs unless that separate repo is also mirrored/renamed first. |
| Author credit `@SeuPut0705` / `Copyright 2026 SeuPut` | 5 (`package.json`, `README.md`, `README.ko.md`, `scripts/readme-media/check-readme.ts`, `LICENSE`/`NOTICE`) | Personal GitHub handle and copyright holder (distinct from the old repo URL `SeuPut0705/ompdesk`, which *must* change to `seuput-inc/momo`). |
| 383 of 384 internal `OMP_GUI_*` environment variables & `window.omp` / `src/shared/omp-api.ts` | 383 vars | Internal IPC/bridge/test plumbing tightly coupled to `SESSION_OWNED_ENV` (`omp-launch.ts`) and 154 e2e specs. Only rename `OMP_GUI_OMPDESK_ROLES` → `OMP_GUI_MOMO_ROLES` in Phase 1; defer any optional `OMP_GUI_*` cleanup to a separate post-cutover PR. |
| CSS classes `.omp-*`, CSS variables `--omp-*` / `--sc-*`, `localStorage` keys `omp.*` | repo-wide | Internal styling/DOM selectors with zero user-visible branding (`ompdesk.*` keys & `ompdesk-device` IDB *do* rename). |
| `e2e/fixtures/work-verdict-corpus.json` (historical transcript corpus) | 1 file | Real anonymized past transcripts used by `work-verdict-replay.test.tsx`; edit only if assertions depend on renamed tool/XML tags, otherwise leave historical corpus intact. |

---

## 2. Ordered, Zero-Breakage Execution Sequence (Step 1 → Final Cutover)

Execute in this exact order on a clean worktree (preferably on a machine with both Rust and macOS tooling for `gen:icons`, plus CI for Windows validation). Commit at each major milestone so bisecting any regression is trivial.

### Step 1 — Pre-Flight & Dead-Weight Removal (Zero Legacy Migration)

1. Branch off clean `dev` (or prepare the clean staging branch for `seuput-inc/momo`).
2. **Delete legacy migration & Electron-era dead code** (eliminates ~400 unnecessary rename sites and prevents broken CI downloads on a brand-new repo):
   - Delete `native/ompdesk/crates/tauri-shell/src/legacy_user_data.rs`, remove `mod legacy_user_data;` and its startup call in `tauri-shell/src/main.rs`, delete `src/main/legacy-user-data.test.ts`.
   - Delete `scripts/shell-move/webkit-store-mac.sh` and its step in `.github/workflows/mac-checks.yml:52-53`, plus legacy v0.132/v0.133 WebKit store adoption in `tauri-shell/src/sessions/webkit_store.rs` if no longer needed.
   - Delete `scripts/shell-move/{last-electron.json,assisted-installer.yml,keychain-ci.sh}` and `src/main/update-release.fixtures/v0.131.0/` (plus any tests tied exclusively to v0.131.0 Electron upgrades).
   - Prune or remove `.github/workflows/shell-batch-checks.yml` (branch-only Electron migration workflow).
   - Remove the pre-v0.26 all-users uninstaller shim from `resources/installer.nsh` (keep clean single-user NSIS hooks).
3. **Reset release metadata**:
   - Set `"version": "0.1.0"` in `package.json`.
   - Reset `.github/release-keep.json` to `{"latest": 3, "keep": {}}` and update `scripts/release-keep.test.ts`.
   - Update `.ai-memory.toml` to `project = "momo"` and point comment/identity to `github.com/seuput-inc/momo`.
4. **Gate 1**: `bun run check:types` passes (verifies removals left no dangling imports).

### Step 2 — Rust Workspace, Crate, Binary & Staged Directory Rename

1. Move directory with git: `git mv native/ompdesk native/momo` (941 tracked files) and `git mv native/memory/ompdesk.json native/memory/momo.json`.
2. Update all 4 Cargo workspace manifests & crate `Cargo.toml` files:
   - `native/momo/Cargo.toml`, `crates/{cli,core,checks,sysproxy}/Cargo.toml` → `momo-cli` (bin `momo`), `momo-core` (`momo_core`), `momo-checks` (`momo_checks`), `momo-sysproxy` (`momo_sysproxy`).
   - `native/momo/crates/shell/Cargo.toml` → `momo-shell` (lib `shell_core`, bins `momo-shell`, `momo-launcher`).
   - `native/momo/crates/shell-preview/Cargo.toml` → `momo-shell-preview`.
   - `native/momo/crates/tauri-shell/Cargo.toml` → `momo-tauri-shell` (bins `momo-tauri-shell`, `momo-launcher`, dep `shell_core = { package = "momo-shell", ... }`, `momo-shell-preview`).
3. Update Rust `use` statements (`ompdesk_core::` → `momo_core::`, `ompdesk_checks::` → `momo_checks::`, `ompdesk_sysproxy::` → `momo_sysproxy::`, `ompdesk_shell_preview::` → `momo_shell_preview::`).
4. Update staged binary dirs & build scripts: `resources/ompdesk-{bin,tauri,shell}` → `resources/momo-{bin,tauri,shell}`, `ompdesk*.build.json` → `momo*.build.json`, `.gitignore`, `scripts/build-{native,tauri,shell,memory}.ts`, `scripts/after-pack.cjs`, `scripts/package-mac.ts`, `src/main/native-bin.ts`, `src/shared/ai-memory.ts`, `e2e/fixture/shell-launch.ts`.
5. Regenerate all 4 `Cargo.lock` files (`cargo update --workspace --offline` or `cargo metadata --manifest-path ...` in each of the 4 roots).
6. **Gate 2**: Run `cargo check --all-targets` across all 4 Cargo workspaces (`native/momo`, `crates/shell`, `crates/shell-preview`, `crates/tauri-shell`).

### Step 3 — App Identity, Paths, Keychain, Sockets, Schemes & Env Vars

1. Update identity & packaging configs: `package.json`, `electron-builder.yml`, `electron-builder.win.yml`, `tauri-shell/{tauri.conf.json,Info.plist}`, `scripts/mac-bundle-info.cjs`, `src/main/index.ts`, `src/shared/product-repo.ts`, `shell/src/launcher.rs` (`REPO = "seuput-inc/momo"`), `core/src/tools/omp/compat.rs`, `core/src/web/push.rs`, `tauri-shell/src/{app_menu.rs,folder_prompts.rs}`.
2. Rename OS data/cache/signing/project-hook paths:
   - `Application Support/ompdesk` → `Application Support/momo`, `%APPDATA%\ompdesk` → `%APPDATA%\momo`, `ompdesk-dev` → `momo-dev`, `%LOCALAPPDATA%\ompdesk` → `%LOCALAPPDATA%\momo`, `%LOCALAPPDATA%\ompdesk-updater` → `%LOCALAPPDATA%\momo-updater`, `~/.cache/ompdesk` → `~/.cache/momo`, `~/.ompdesk-signing` → `~/.momo-signing`.
   - `git mv .ompdesk .momo` and update all `.ompdesk/` hook references across `core/`, `src/main/`, `scripts/`, `locales/`, `docs/`.
3. Rename keychain (`momo Safe Storage` / `momo Key`), sockets/pipes (`momo-shell-*`, `momo-hub-*`, `momo-clients-*`, `momo-core-owner`, `momo-<uid>-*`), HTTP headers/MIME (`X-Momo-Import`, `application/x-momo-file`), update marker (`<!-- momo-update ... -->`), error codes (`ERR_MOMO_*`), User-Agents (`momo-updater`, `momo-setup`), cookie (`__Host-momo` / `momo`), WS subprotocol (`momo.v1`), IDB (`momo-device`), SW caches (`momo-shell-*`, `momo-assets-*`), and diagnostic filename (`momo-diagnostics.txt`).
4. Switch URL schemes cleanly:
   - OS deep-link protocol: `omp://` → `momo://` (ONLY at OS registration & deep-link parser sites — verify all 35 `omp://*.md` doc links remain untouched!).
   - Internal origin: `app://ompdesk/` → `app://momo/`.
   - Media scheme: `omp-media:` → `momo-media:` in lockstep across `tauri.conf.json` CSP, `src/renderer/index.html` CSP, Rust handlers, and TS renderer/main.
5. Rename all **142 `OMPDESK_*` → `MOMO_*`** env vars/consts (including `OMPDESK_BACKUP_PATH` in `native/memory/crates/ai-memory-store/src/v85_backup.rs` and `OMPDESK_HEAVY_HELD` in `cli_install.rs`) and rename **`OMP_GUI_OMPDESK_ROLES` → `OMP_GUI_MOMO_ROLES`**.
6. Update `core/src/control/cli_install.rs` (`momo` / `momo.cmd`, marker string, and recompute pinned launcher SHA-256 test expectations).

### Step 4 — Agent Tools, XML Tags, Dotted Keys, MCP/Bridge IDs & Builtin Skills

1. Rename files with `git mv`:
   - `resources/gui-bridge/ompdesk-role-contracts.ts` → `momo-role-contracts.ts`
   - `resources/gui-bridge/ompdesk-roles.ts` → `momo-roles.ts`
   - `src/main/bridge-ompdesk-roles-stock.test.ts` → `src/main/bridge-momo-roles-stock.test.ts`
   - `src/main/ompdesk-check.test.ts` → `src/main/momo-check.test.ts`
   - `resources/omp-builtin/skills/ompdesk` → `resources/omp-builtin/skills/momo`
   - `resources/omp-builtin/skills/ompdesk-mobile-emulator` → `resources/omp-builtin/skills/momo-mobile-emulator`
   - `resources/omp-builtin/formal/skills/ompdesk-formal-verify` → `resources/omp-builtin/formal/skills/momo-formal-verify`
2. Rename all 20 `ompdesk_*` agent control tools → `momo_*` across `core/src/agentctl/`, `resources/gui-bridge/`, `resources/omp-builtin/skills/momo/`, `src/main/agent-control/`, `e2e/`, `formal/`.
3. Rename XML wrappers (`<ompdesk-mail>`, `<ompdesk-agent-message>`, `<ompdesk-worker>`, `<ompdesk-bot>`, `<ompdesk-bot-note>` → `<momo-*>`) **in lockstep with** `native/memory/crates/ai-memory-hooks/src/{payload.rs,router.rs}` and `native/memory/crates/ai-memory-cli/src/commands/doctor.rs`.
4. Rename dotted journal/metadata keys (`ompdesk.*` → `momo.*`), MCP hub IDs (`ompdesk-memory*` → `momo-memory*`), and `ompdesk-native-input` → `momo-native-input`.
5. Update `scripts/omp-boundary/touchpoints.ts` for every renamed bridge/test/skill file path.
6. Verify `resources/omp-builtin/formal/skills/momo-formal-verify/assets/toolchain.json` STILL points to `seuput-inc/ompdesk-formal-tools` (unless that external repo was also cloned).

### Step 5 — Golden Fixtures & Formal Spec Sync

1. Update all Rust golden fixtures under `native/momo/crates/core/src/` (`agentctl/**/captured.json`, `web/matrix.json`, `tools/setup/plans-captured.json`, `upkeep/rules_file-captured.json`, `gh/auth-captured.json`, `procs/console-attribution.json`, `procs/pressure_record/captured.json`) and re-run their parity tests to confirm zero drift.
2. Update `formal/` TLA+/Lean source path annotations & correspondence tags (`native/ompdesk/` → `native/momo/`, `ompdesk_*` → `momo_*`).
3. Update `docs/rust-inventory/{host-imports,remote,root,services}.tsv` to reflect renamed paths (`momo-role-contracts.ts`, `native/momo/`, etc.).

### Step 6 — Brand Wordmark, Icon Generation & Web Manifest (macOS Required)

1. Update `scripts/brand-svgs.ts` (`WORDMARK_LETTERS` to spell `m o m o`; titles/comments `OMPdesk` → `Momo`).
2. *(Optional design decision)* If replacing the π icon mark itself, update `src/shared/brand-mark.ts`, `src/shared/boot-shell-geometry.json`, `native/momo/crates/tauri-shell/src/boot_paint.rs`, and `src/shared/brand-mark.test.ts`.
3. Update `src/renderer/public/manifest.webmanifest` (`name: "Momo"`, `short_name: "Momo"`), `src/renderer/index.html`, `src/renderer/web.html`, and `src/renderer/public/pre-paint.js`.
4. Run **`bun run gen:icons`** on **macOS** to regenerate every derived icon, tray PNG, `icon.icns`, `icon.ico`, `app-icon.png`, `dmg-background.tiff`, `social-preview.png`, PWA icons, and `#root` first-paint HTML shell.
5. Verify `bunx vitest run src/shared/brand-mark.test.ts src/renderer/components/common/BrandMark.test.tsx`.

### Step 7 — UI Copy, Themes, Locales, Documentation & Legal Notices

1. Update themes: `src/shared/theme-names.ts` (`id: "momo"`), `src/renderer/lib/theme*.ts`, `src/renderer/styles/theme-{light,dark}.css`, and locale keys `themePicker.set.momo.*` + `"Momo Light"` / `"Momo Dark"` (plus matching test strings in `e2e/*.e2e.ts`).
2. Update all locale files: `src/renderer/locales/{en,ko}.ts`, `src/renderer/locales/memory/{overview,shell}.ts`, `src/renderer/locales/bot-autonomy.ts`, `src/renderer/components/settings/schema-ko.ts`, `src/main/i18n-text.ts`, `native/momo/crates/tauri-shell/src/native_labels.json`. Keep EN/KO keys 100% identical (verified by `locales.test.ts`).
3. Update root and user docs: `README.md`, `README.ko.md`, `CONTRIBUTING.md`, `SECURITY.md`, `AUTOPILOT.md`, `AGENTS.md`, `.omp/rules/*.md`, `.omp/skills/*`, `docs/*.md`, `docs/design/*.md`.
4. Replace `CHANGELOG.md` with a clean Momo `v0.1.0` initial release section (bilingual EN + KO per `AGENTS.md` release conventions).
5. Update `NOTICE` §6 trademark sentence to `"Momo"` (preserve `Copyright 2026 SeuPut` and Apache-2.0 text). Keep `LICENSES/MIT-momobot.txt` and all `momobot` credits untouched.

### Step 8 — Signing Certificate, Workflows & License Regeneration

1. Generate the new self-signed macOS code-signing certificate (`CN=Momo Code Signing`) per Section 3.3, store `.p12` + password in `~/.momo-signing/` (`0700`/`0600`), and record its SHA-1 in `scripts/mac-signing.json`.
2. Update all `.github/workflows/*` and `.github/actions/*` per Section 1.4:
   - Retarget `.github/workflows/skills-bump.yml` push from `main` → `dev` (or add a GitHub App ruleset bypass).
   - Gate `release-update-mac` & `win-update-real` in `release.yml` so `v0.1.0` succeeds with zero prior releases while `v0.2.0`+ runs full self-update verification.
3. Update `scripts/gen-crate-notices.ts` and `scripts/generate-third-party-notices.ts` (`OMPdesk` → `Momo`, `LICENSES/momo-*-dependencies.txt`, `native/momo/...`, `native/memory/momo.json`), remove the 4 old `LICENSES/ompdesk-*-dependencies.txt` files with `git rm`, and regenerate:
   ```sh
   bun scripts/gen-crate-notices.ts
   bun run gen:licenses
   ```
   Confirm `THIRD_PARTY_NOTICES.txt` still contains the full `momobot` (CopilotKit) MIT notice and all other vendored notices.

### Step 9 — Verification Gates (Local + CI Dry-Run)

Run these gates sequentially and fix all failures before proceeding to Step 10:

| Gate | Command(s) | What It Catches |
|---|---|---|
| **9a. Rust workspaces (all 4)** | `for m in native/momo/Cargo.toml native/momo/crates/shell/Cargo.toml native/momo/crates/shell-preview/Cargo.toml native/momo/crates/tauri-shell/Cargo.toml; do cargo fmt --manifest-path "$m" -- --check && cargo clippy --manifest-path "$m" --all-targets -- -D warnings && cargo test --manifest-path "$m"; done` | Broken crate/binary renames, stale `captured.json` / `matrix.json`, `cli_install.rs` SHA-256 mismatch, `launcher.rs` / `update_feed` regressions |
| **9b. Vendored `ai-memory` hooks** | `cargo test --manifest-path native/memory/Cargo.toml -p ai-memory-hooks -p ai-memory-store -p ai-memory-cli` | `<momo-agent-message>` tag parser & `MOMO_BACKUP_PATH` drift |
| **9c. Static, types, lints, licenses, inventory** | `bun run check:types && bunx biome check src e2e resources scripts && node scripts/lint-surfaces.mjs && bun scripts/lint-fix-tests.mjs && bun run licenses:check && bun scripts/rust-runtime-scope.ts --check-inventory` | TS errors, surface violations, stale `THIRD_PARTY_NOTICES.txt` / `Cargo.lock` hashes, `docs/rust-inventory/*.tsv` drift |
| **9d. Unit & contract suites** | `bunx vitest run` *(incl. `packaging-config.test.ts`, `brand-mark.test.ts`, `locales.test.ts`, `touchpoints.test.ts`, `supply-chain.test.ts`, `agents-md.test.ts`)* | Packaging asset drift, missing EN/KO locale keys, unregistered omp touchpoints, `AGENTS.md` size cap (<64 KB) |
| **9e. Production build & phone bundle budget** | `bun run build && bun scripts/check-main-bundle.ts` | Vite/main/renderer build breaks; phone first-screen JS budget (`WEB_FIRST_SCREEN_JS_BYTES = 2_260_334`; expected to shrink slightly because `Momo` is 3 bytes shorter than `OMPdesk`) |
| **9f. Residual reference leak audit** | See Step 10 command below | Any forgotten `ompdesk`, `seucode`, `SeuPut0705/ompdesk`, or `com.seuput.ompdesk` reference |
| **9g. Cross-OS CI dry-run** | Push staging branch to `seuput-inc/momo`, run `gh workflow run ci.yml -f batch=true -f mac=true -f installer_check=true` AND `gh workflow run release.yml -f dry_run=true` | Real macOS signing (`codesign --verify --deep --strict`), DMG packaging, Windows NSIS build & `windows-installer-check.ps1`, WebView2/WKWebView smoke |

### Step 10 — Residual Reference Zero-Leak Audit

Run before pushing the initial commit to `seuput-inc/momo`:

```sh
# 1. Every remaining case-insensitive "ompdesk" match should ONLY be in the deliberate KEEP list
#    (seuput-inc/ompdesk-formal-tools, historical e2e/fixtures/work-verdict-corpus.json, or this blueprint doc)
git grep -in 'ompdesk' -- ':!docs/rebrand-momo-blueprint.md'

# 2. Zero remaining legacy "seucode" or old repo URLs
git grep -in 'seucode'
git grep -in 'SeuPut0705/ompdesk'
git grep -in 'com\.seuput\.ompdesk'

# 3. Verify deliberate KEEP anchors were NOT damaged
git grep -n 'momobot' LICENSES/MIT-momobot.txt THIRD_PARTY_NOTICES.txt src/renderer/components/common/BotFace.tsx
git grep -n 'ompdesk-formal-tools' resources/omp-builtin/formal/
git grep -n 'omp://rpc\.md'
```

### Step 11 — Re-Record README Media & Final Polish

1. Run `bun run readme:media` on macOS with the branded Momo build to refresh `docs/media/*.webp` and `src/renderer/public/screenshots/{narrow,wide}.png`.
2. Run `bun run readme:check` to validate every README download URL (`seuput-inc/momo/releases/latest/download/momo-{mac-arm64.dmg,windows-setup.exe}`), author line (`@SeuPut0705`), and WebP asset.

### Step 12 — Final Cutover, `v0.1.0` Release & Post-Release Gate Activation

1. Push the clean initial commit to `main` and `dev` on `seuput-inc/momo` (Section 3.4).
2. Run `release.yml` dry-run on `main`, then tag & publish `v0.1.0` (`momo-mac-arm64.dmg` + `momo-windows-setup.exe` with `<!-- momo-update ... -->` metadata).
3. Verify `omp-latest.yml` bootstraps the `omp-compat` orphan branch on its first run.
4. After `v0.1.0` is live, verify that `release-update-mac` and `win-update-real` automatically activate against `v0.1.0` during the `v0.2.0` release dry-run.
5. Complete machine cutover on MacBook, Windows Desktop, and Mac mini (Section 4).

---

## 3. GitHub Repository Setup Checklist (`seuput-inc/momo`)

### 3.1 Repository Creation & Settings

- [ ] Create public repository **`seuput-inc/momo`** under organization `seuput-inc` (no auto-generated README/license — push clean initial commit from local).
- [ ] Set description (e.g., *"Momo — desktop app for the omp coding agent"*) and topics.
- [ ] Confirm License displays **Apache-2.0** (detected from root `LICENSE` + `NOTICE`).
- [ ] Enable **Private vulnerability reporting** (GitHub Security Advisories — required by `SECURITY.md` and `.github/ISSUE_TEMPLATE/config.yml`).
- [ ] Upload regenerated `resources/brand/social-preview.png` (1280×640) in **Settings → General → Social preview** (GitHub has no API for this).
- [ ] **Settings → Actions → General**:
  - Allow all actions and reusable workflows (or org policy).
  - Workflow permissions: **Read and write permissions** (or explicit `permissions:` blocks already declared in workflows) and allow GitHub Actions to create and approve pull requests if `omp-latest.yml` / `skills-bump.yml` open PRs.

### 3.2 Branch Strategy & Ruleset for `main` (and `dev`)

Align with `AGENTS.md` (`dev` integrates everyday work; `main` holds release-ready code):

- [ ] Set default branch to **`main`** (and create **`dev`** at the same initial commit).
- [ ] Create a **Repository Ruleset** targeting `main`:
  - [x] Restrict deletions
  - [x] Block force pushes
  - [x] Require status checks to pass before merging (`ci.yml` `static` + unit/native checks)
  - [x] Require linear history (optional, matches rebase/squash workflow in `CONTRIBUTING.md`)
  - [ ] **Reconcile automated bot pushes**:
    - **`skills-bump.yml`**: Retarget its daily push from `HEAD:main` to **`HEAD:dev`** so `main` stays strictly protected without loosening ruleset bypasses.
    - **`omp-latest.yml`**: Creates/updates the orphan **`omp-compat`** branch and **`omp/bump/*`** PR branches (neither matches `main` ruleset; confirm no catch-all branch ruleset blocks `omp-compat` or `omp/bump/*`).
    - **`release.yml`**: Triggered by `v*` tag push (creates GitHub Release and uploads `momo-mac-arm64.dmg` / `momo-windows-setup.exe`); does not push commits to `main`. Add a tag protection ruleset for `v*` blocking tag deletion/force-update by non-admins.
- [ ] Optional light ruleset on `dev`: block force-pushes and deletions while allowing `github-actions[bot]` pushes from `skills-bump.yml`.

### 3.3 Secrets to Configure on `seuput-inc/momo` (Names Only — NEVER Commit Values)

Generate a fresh self-signed macOS code-signing identity (`CN=Momo Code Signing`, 10-year validity, Code Signing Extended Key Usage) locally on macOS (e.g., via Keychain Access Certificate Assistant or `openssl req -x509 ...` + `openssl pkcs12 -export` into `~/.momo-signing/momo-signing.p12`, `chmod 700 ~/.momo-signing && chmod 600 ~/.momo-signing/*`), capture its uppercase/lowercase 40-char SHA-1 fingerprint into `scripts/mac-signing.json`, and configure **only these 2 Actions secrets** under **Settings → Secrets and variables → Actions**:

| Secret Name | Source | Required? |
|---|---|---|
| `MAC_SIGNING_P12_BASE64` | `base64 -i ~/.momo-signing/momo-signing.p12 \| tr -d '\n'` | **Yes** (blocks macOS `release.yml`) |
| `MAC_SIGNING_PASSWORD` | Contents of `~/.momo-signing/password` | **Yes** (blocks macOS `release.yml`) |

*(No Windows signing secrets, no Apple notarization secrets, and no repository variables are needed.)*

### 3.4 Clean Initial Commit Strategy for `main` & `dev`

Because `seuput-inc/momo` starts fresh with zero OMPdesk baggage (and `CHANGELOG.md` reset to `v0.1.0`), create a single clean orphan initial commit once Step 1–Step 11 pass all verification gates:

```sh
# From the fully verified rebranded working tree:
git checkout --orphan momo-initial
git add -A
# Verify no untracked build artifacts, secrets, or .p12 files are staged:
git status --short
git commit -m "feat: initial Momo v0.1.0 release"   # No AI-attribution trailers!
git branch -M main
git checkout -b dev
git remote add momo git@github.com:seuput-inc/momo.git
git push -u momo main dev
```

*(Alternative: if preserving commit blame from OMPdesk is later desired instead of a fresh history, push the rebranded commit directly onto `dev` and fast-forward `main` — both `main` and `dev` still start cleanly at `v0.1.0`.)*

---

## 4. Local Machine Cutover & Folder Migration Checklist

All three machines start fresh with Momo's own data paths while **preserving `~/.omp/`** (stock `omp` sessions, auth tokens, and extensions continue working immediately inside Momo).

### 4.1 MacBook (`/Users/seuput/Desktop/GitHub/momo`)

- [ ] **Git checkout**:
  - Clone `git@github.com:seuput-inc/momo.git` into `/Users/seuput/Desktop/GitHub/momo` (or rename existing `/Users/seuput/Desktop/GitHub/ompdesk` → `/Users/seuput/Desktop/GitHub/momo` after repointing `origin` to `git@github.com:seuput-inc/momo.git` and pruning old `ompdesk` remotes/tags).
  - Run `git config core.hooksPath .githooks` (or let `.momo/worktree-setup` set it) and `bun install`.
- [ ] **Local signing material**:
  - Place `momo-signing.p12` and `password` in `~/.momo-signing/` (`chmod 700 ~/.momo-signing && chmod 600 ~/.momo-signing/*`).
  - Verify `scripts/mac-signing.json` `certificateSha1` matches `openssl pkcs12 -in ~/.momo-signing/momo-signing.p12 -nokeys -clcerts | openssl x509 -noout -fingerprint -sha1`.
- [ ] **Installed app & fresh data paths**:
  - Install `/Applications/Momo.app` from `momo-mac-arm64.dmg` (first launch: right-click → Open for self-signed Gatekeeper prompt).
  - Confirm fresh profile creation at `~/Library/Application Support/momo/` (dev: `momo-dev`), caches at `~/.cache/momo/`, keychain entry `momo Safe Storage`, and CLI launcher at `~/.bun/bin/momo`.
  - Confirm `~/.omp/` is untouched and stock `omp` sessions appear normally.
- [ ] **Side-by-side / retirement**:
  - Because bundle ID (`com.seuput.momo`), URL scheme (`momo://`), keychain (`momo Safe Storage`), sockets (`momo-*`), and `userData` (`Application Support/momo`) are fully disjoint, `/Applications/OMPdesk.app` and `/Applications/Momo.app` can coexist cleanly during transition; remove `/Applications/OMPdesk.app`, `~/.bun/bin/ompdesk`, and `~/Library/Application Support/ompdesk` once cutover is verified.
- [ ] **Orca & tooling**:
  - Add `/Users/seuput/Desktop/GitHub/momo` as the repo in Orca; remove stale OMPdesk worktrees once finished.
  - Verify `ai-memory` picks up project `momo` from `.ai-memory.toml`.

### 4.2 Windows Desktop (`C:\Users\admin\Desktop\github\momo`)

- [ ] **Git checkout** (run from Git Bash per `docs/windows-dev.md`):
  - Clone `git@github.com:seuput-inc/momo.git` into `C:\Users\admin\Desktop\github\momo` (or rename old checkout + repoint `origin`).
  - Run `git config core.hooksPath .githooks`, `bun install`, and verify `.momo\worktree-setup.cmd` works.
- [ ] **Installed app & fresh data paths**:
  - Run `momo-windows-setup.exe` (accept SmartScreen prompt on first unsigned v0.1.0 install).
  - Confirm clean installation at `%LOCALAPPDATA%\Programs\momo\Momo.exe` and Start Menu / Desktop shortcuts named **Momo** with AUMID `com.seuput.momo`.
  - Confirm fresh `userData` at `%APPDATA%\momo\`, managed tools/caches at `%LOCALAPPDATA%\momo\`, updater pending folder at `%LOCALAPPDATA%\momo-updater\pending\`, and CLI launcher at `%USERPROFILE%\.bun\bin\momo.cmd`.
  - Confirm `%USERPROFILE%\.omp\` is untouched.
- [ ] **Verification**:
  - Confirm WebView2 starts without console flashes, toasts display **Momo**, and `momo://` protocol registration works cleanly.
  - Uninstall legacy OMPdesk via Add/Remove Programs after verifying Momo stability; optionally clean `%APPDATA%\ompdesk` and `%LOCALAPPDATA%\ompdesk-updater`.

### 4.3 Mac mini (Always-On Host / Remote & Mobile Web Node)

- [ ] **Git checkout**:
  - Clone/rename local checkout to `.../momo` pointing to `git@github.com:seuput-inc/momo.git`, run `git config core.hooksPath .githooks` and `bun install`.
  - Copy `~/.momo-signing/` if building signed packages locally on the Mac mini.
- [ ] **Installed app & fresh data paths**:
  - Install `/Applications/Momo.app` from `momo-mac-arm64.dmg`; confirm fresh `~/Library/Application Support/momo/`, `~/.cache/momo/`, and `~/.bun/bin/momo`.
  - Keep `~/.omp/` intact.
- [ ] **Remote devices, Mobile Web PWA & Tailscale Serve**:
  - **Re-pair required (expected with fresh data)**: Because Momo generates a fresh device identity, new VAPID keys (`https://github.com/seuput-inc/momo`), new cookie (`__Host-momo`), new WS subprotocol (`momo.v1`), and new IndexedDB (`momo-device`), re-pair phones (re-add PWA to home screen so it picks up the new `manifest.webmanifest` name & icon) and re-pair computer-to-computer remote links between MacBook, Windows Desktop, and Mac mini.
  - If OMPdesk was previously running on `127.0.0.1:47831` behind `tailscale serve`, quit OMPdesk before enabling Momo's mobile web server so port `47831` does not conflict.
- [ ] **Background services & schedules**:
  - Recreate any desired Momo scheduled runs and verify `ai-memory` background service (`launchd` / user service) and cross-machine memory sync recognize the `momo` project identity.

---

## 5. Top Migration Risks & Mitigations

| # | Risk | Root Cause Found in Audit | Mitigation Built Into This Blueprint |
|---:|---|---|---|
| 1 | **First release (`v0.1.0`) deadlocks in CI** | `release.yml` (`release-update-mac`, `win-update-real`) and `mac-checks.yml` (`webkit-store-mac.sh`) download prior releases (`v0.131.0`/`v0.132.0`) from `$GITHUB_REPOSITORY` and fail if none exist. | Step 1 deletes `webkit-store-mac.sh` & Electron baselines; Step 8 gates `release-update-mac` & `win-update-real` on a prior stable Momo release existing (skip on `v0.1.0`, active from `v0.2.0`+). |
| 2 | **Broken formal verification downloads** | `resources/omp-builtin/formal/skills/.../assets/toolchain.json` points to separate companion repo `seuput-inc/ompdesk-formal-tools`. A global `seuput-inc/ompdesk` replace breaks TLC/Java downloads. | Explicitly listed in **Section 1.6 KEEP List** and checked in Step 4.6 & Step 10. |
| 3 | **Stale `SeuPut0705/ompdesk` breaks launcher auto-updates** | `native/ompdesk/crates/shell/src/launcher.rs:14` still hardcodes `SeuPut0705/ompdesk` (missed during the prior org transfer). | Explicitly called out in Section 1.4 & Step 3.1 to update directly to `seuput-inc/momo`. |
| 4 | **`skills-bump.yml` fails against protected `main`** | `.github/workflows/skills-bump.yml` pushes directly to `HEAD:main` using `GITHUB_TOKEN`, which GitHub branch rulesets block. | Section 3.2 & Step 8.2 retarget `skills-bump.yml` to `HEAD:dev` (matching `AGENTS.md`). |
| 5 | **Silent `ai-memory` hook break on agent messages** | Vendored `native/memory/crates/ai-memory-hooks/src/{payload.rs,router.rs}` parses `<ompdesk-agent-message>`, and `v85_backup.rs` reads `OMPDESK_BACKUP_PATH`. | Step 3.5 & Step 4.3 update both in lockstep with `gui-bridge`/`core`, verified by Gate 9b. |
| 6 | **Accidental damage to `momobot` MIT notices or stock `omp://*.md` links** | Coincidental `momo` / `momobot` overlap and mixed use of `omp://` (OS deep-link vs 35 stock `omp://*.md` doc links). | Guarded by Section 1.6 KEEP list and explicit verification greps in Step 10. |
| 7 | **CI `static` job fails on inventory or notice hashes** | `ci.yml` fails if `docs/rust-inventory/*.tsv` misses any renamed path or if `THIRD_PARTY_NOTICES.txt` / `LICENSES/momo-*-dependencies.txt` `Cargo.lock` SHA-256 hashes are stale. | Step 5.3 + Step 8.3 regenerate notices & update TSVs; Gate 9c enforces both checks locally. |
| 8 | **macOS Keychain & `ai-memory` helper signature mismatch** | `src/main/ai-memory/staging.ts` (`AI_MEMORY_REQUIREMENT`) and `scripts/package-mac.ts` enforce the exact cert SHA-1 pinned in `scripts/mac-signing.json`. | Step 8.1 + Section 3.3 rotate `scripts/mac-signing.json` and the 2 GitHub secrets (`MAC_SIGNING_P12_BASE64`, `MAC_SIGNING_PASSWORD`) atomically. |
| 9 | **Mobile Web port `47831` & PWA cache collision on Mac mini** | Old OMPdesk instance holding `127.0.0.1:47831` or stale SW caches under the same Tailscale Serve URL. | Rename SW caches (`momo-shell-*`, `momo-assets-*`) + cookie (`__Host-momo`) + stop OMPdesk before enabling Momo Mobile Web on Mac mini (Section 4.3). |
| 10 | **Golden Rust fixtures (`captured.json` / `matrix.json`) cause massive test failures** | 3,500+ `ompdesk` hits live inside Rust golden JSON fixtures (`agentctl/journal/captured.json` 2,040; `web/matrix.json` 435; etc.) and `cli_install.rs` SHA-256 assertions. | Dedicated Step 5 + Gate 9a verify every crate's `cargo test` before TypeScript/CI runs. |
