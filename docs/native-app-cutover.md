# Native application cutover inventory

Status: 14 Nov 2026. Integration branch `omp/agent/shell-native-common` preserves main `a973d93df` (v0.130.0), S and the preserved SX implementations. This is **not a Node-free application**. The original Electron-dependent subset in `rust-remaining-units.md` §4 is not the complete application boundary.

## Remaining production entry

`crates/shell/src/main.rs` locates `out/main/index.js` and `node::spawn` starts it; `src/main/index.ts` composes the app and `src/main/ipc.ts` registers its command handlers. `src/main/core/process.ts` still owns the core process. `Ctx::core` still relays through Node. Core `ipc::OWNED` is empty. These are executable dependencies, not intentional TypeScript and not completed native plumbing.

Run `bun scripts/shell-port/runtime-inventory.ts` from the checkout to emit the per-file static runtime graph. It scans imports without loading app modules, follows the shell build's Electron alias, and excludes type-only imports. Unresolved imports fail the command. Computed imports, filesystem-loaded resources and embedded worker programs require separate review; physical source lines are not an implementation-size or completion metric.

## Domain residuals and observable completion

Paths below are relative to `src/main` (TS) and `native/ompdesk/crates/core/src` (Rust). Every row still requires native application composition. Existing engines must be reused, not copied.

| Domain | Existing Rust implementation | Remaining TS policy/effects | Native completion observation |
|---|---|---|---|
| Web | `web::{Edge,router::Host,uploads,push,store}` | `web/web-host.ts` lifecycle/VAPID invalidation; `server.ts::answerAsk`; `ws-router.ts` quota, shaping, binary/media/upload landing; pairing approval and push notification privacy/deduplication | Without Node: phone pairing, invoke/send, upload/media, reconnect/resync and immediate revoke; pushes still precede replies; foreground/Stop/privacy notification rules remain. |
| Remote | `remote::devices` gate/dial/retry; link crypto and event codecs | `remote/devices.ts` application receive dispatch; `host-services.ts` tab/session/terminal/preview operations; `remote-sidecar.ts` offline replay/read-delta recovery; peer quota reserve/refund | Two Rust-only desktops share one omp per session; disconnect/restart preserves run/asks/transcript, answer and quota apply once, deleted sessions never revive, phone and both desktops receive changes. Execution host is not inferred from view host. |
| Sidecar/pool | `sidecar::Lane`; `pool::{api,windows,listen,persist}` ownership/claim/process state machines | `sidecar.ts` resolve/settings/launch/gate/session-wait effects; `sidecar-pool.ts` application ask executor, tool dispatch, settings, event/binary batching and flush | Native local/web/remote tab start/restart/sleep/close, previous process exit before replacement, viewer close only detaches, reconnect starts whole, transcript reply follows earlier events. Existing receipt/generation/claim owners remain authoritative. |
| Setup | `setup` verified downloads/archive resolution; `supervise` process tree | `setup/service.ts` required/optional ordering, Bun floor, installer selection, compiled-launcher recovery, retry/backoff ledger; plans/env; Windows isolated handle-list launch | Fresh machine reaches required installs → usable omp → first tab → optional installs; retry/cancel/restart records remain correct, Bun upgrade preserves a working launcher, isolated memory setup retains no app pipe handles. |
| Memory | `aimemory::service::{queue,pass}`, upkeep/care/client/root/healing | `ai-memory/service.ts` agent directory, terminal preference, Bun/first-tab/env/isolated-run callbacks; valid disabledExtensions YAML; `core-asks.ts` omp launch selection | Native packaged stage/setup/ready and repair; terminal capture is not duplicated; old-generation callbacks cannot settle new requests; actual journal upkeep/backfill and protected purge/reconnect work. |
| Schedules/routines | `schedules::Engine` and journal; routines source primitives | `schedules.ts` draft coercion, quota reserve/refund, authenticated wake and launch environment; `routines/triggers.ts` live source/quiet-window/mark lifecycle | Native local/paired create/run-now/timed/webhook/events, quota failure refund, no late fire after pause/edit/delete, no duplicate restart run, journal closes and launch uses the same memory/MCP environment. |
| Autopilot | coordinator, cycle, audit, ship and land-check engines | `autopilot-approver.ts` permission policy; release detection; quota reset facts; `autopilot.ts` actual bridge/tab/worktree/dispatch/land-shell effects | Start creates real tab/worktree and arms the bridge; four existing frames drive audits/ship; human-only approval exceptions survive; quota/restart resumes once; Stop drains children/queue and starts no new work. |
| Machine services | model research execution, existing stock/core services | `machine-services.ts` host/pref/remote-update ordering; benchmark argument/process/timeout policy; model prompt/plan validation; canonical runtime/Bun/omp/login environment selection | Desktop/phone/paired calls affect only the selected authenticated host's settings/jobs/quota; real progress/failure/cancel reaches the original caller; no benchmark depends on bundled Node. |

## Base-owned shared integration

- `PROTOCOL.md` §15.4.1 is the frozen native boundary. `ompdesk-app-contract` owns the non-deserializable caller and the page request/reply contract. Domain `Host`/`Deps` values inject typed `Arc<domain Service>` APIs; internal calls do not become another JSON RPC layer.
- Base alone constructs the service graph, admits/dispatches page IPC, binds existing external hub surfaces, routes native effects, and owns process/callback generation and shutdown ordering. Domain owners provide leaf implementation and registration requirements, not concurrent edits to shared files.
- Core remains a supervised child. App callbacks cannot queue behind the command awaiting them. Callback completion, snapshots and pushes preserve the existing ordering/generation contracts.
- Runtime log writer, full-disk retained saves, CEF first-page notification, Boot owner revocation, native quit/update ordering, authenticated dialogs/notifications and the CEF UI heartbeat are part of this integration, not optional polish.
- Windows isolated supervisor handle inheritance is still a common platform effect, not proven by the existing `isolated` flag alone.

### Native source intake, 14 Nov 2026

The source units below are present in `omp/agent/shell-native-common`. A domain's native constructor and tests are not evidence that the production application invokes it.

| Source unit | Integrated implementation | Remaining composition gate |
|---|---|---|
| Machine/models | Canonical runtime, shell, detection, REA cache and typed application; closed runners fence child admission after runtime resolution. | Authenticated target resolution must reject a revoked owner before the domain is polled again. `close_owner` signals cancellation; it is not a joined global teardown. |
| Pool/sidecar | Existing Lane and hub engine through native handles; same-tick activity/snapshot and intrinsic outcome identity. | Real native Host, owner reservations, release receipts, required original view tokens, platform effects and strong per-tab/generation/outcome Arc retention. |
| Schedules/routines | Native source actors reuse OS watches, Git/GitHub reads, pool subscriptions and read-only TLS IMAP/MIME. | The actual authenticated pool activity channel and native account/credential capability; no Node source callback. |
| Memory | One Rust policy compiled into tracked WASM, embedded terminal extension and native supervised capture Host. | Production upkeep/care clients and the CEF entry remain unbound. The isolated-run refusal was removed only after Main accepted Setup's bounded Windows runner/handle-list proof; integrated Windows strict and artifact gates remain open. |
| Autopilot | Native typed service, existing coordinator, canonical Machine shell and stock approval guard. | Actual Pool/Machine/worktree/resume/permission ports and application frame delivery. |
| Caller admission/preferences/logging | Native generation/owner/request registry, retained shared preferences and UTF-16-compatible runtime log writer. | Authenticated transport admission, real IPC registration and replacement of the existing Node writer, never two simultaneous writers. |

`application::Services` constructs the shared Machine, Setup runner, stock lanes, Memory Host, OS-backed credential bridge, session index, shared tombstones and first-tab barrier directly. It is not yet wired into the shell's production startup. The Node entry in the section above remains reachable. Setup close is joined before readiness and Memory are released; caller admission is revoked before shutdown.

Current local evidence uses explicit Rust/compiler/toolchain-subcommand 1.95. Common source tests `20261114-082526-2df4` passed 174 cases; actual supervised setup adapters `20261114-082635-1cff` passed 20. The direct shell/core transport `20261114-090214-c65e` passed six executable tests (two child fixtures are ignored as standalone tests), including binary/bidirectional calls, owner death, EOF, cancellation and thread-spawn failure cleanup. Session index/feed tests `20261114-090718-e5d0` passed 21 cases, including a 2,112-command corpus captured from the actual TypeScript pace classifiers. These checks do not execute CEF, paired desktops or the final application artifact.

The additional launch-policy modules are present: `mcp_hub`, `session_ownership`, `worktree_lifecycle`, `session_ops` and `local_dispatch`. Main's exact MCP/ownership source cohort `9a3182f94` passed its Linux/Windows standard run; that is not production application activation. Registration, adapters, authenticated create/command admission and joined cleanup remain separate gates. `application::session_authority::SessionAuthority` is the single native deletion store/count/admission owner; SessionOps owns mutation ordering. The existing TypeScript singleton remains the only production authority until the complete caller cutover. No parallel writer or count is enabled.

Independent hosted source-unit runs retain their observed failures. The Memory run's missing limit-wait log followed an observed hub timeout and core termination; its underlying transport stall is unconfirmed. No deadline or assertion has been relaxed. Canonical Electron-baseline notices are regenerated from that baseline's frozen dependencies; a CEF candidate or changed Cargo lock requires its own generated notices, not a copied expected string.

The bounded native authority source `75307aa0d` passed five cases for counted guards, atomic holder admission, persisted ordering/modes and memory retention after save failure. The adjacent quota defect was reproduced in `20261114-103223-b713`: EDQUOT became UNKNOWN and recovery did not save retained bytes. Source `01e405f03` fixes the canonical errno mapping and kept retry; `20261114-103806-b5e2` passed 15 save/error/authority cases with actual Rust 1.95, including recovery without another mutation. It depends on the earlier `610a60b0c` retry extraction. This is not application or platform-artifact proof.

Checkpoint `5a95ec411` is a historical captured-service prerequisite, not the final graph. Later `59889e6bf` and `07fc0c2e2` preserve immutable source/incarnation/run targets and admit their effects under the same Callers mutex as revocation. The 25-case run `20261114-181908-f319`, the post-observer Stop recheck `20261114-182739-837c` and the concrete HostedTargets consumer `20261114-182955-b62e` passed. `c0a6912cf` additionally refuses ordinary effects after shutdown while retaining already-captured cleanup authority (`20261114-183743-9dff`, seven cases). These do not instantiate RootPoolHost or prove the final source factory's external-tab-id reopening behavior.

Local compiler outputs are session scratch. The 20 GiB disk floor and official heavy slots remain enforced. Main authorized recovery of confirmed retired shell targets; active targets, source and evidence were preserved. Hosted source cohorts are not full native application candidates.

### Launch composition evidence

`native-app-data.ts` generates agent templates, the browser catalog and mounted tool definitions from their existing TypeScript exports. The native loader shares the immutable tool arrays; neither an empty array nor a copied schema substitutes for those inputs. Machine's proxy overlay contains only proxy variables, so merging it cannot restore a parent session's plumbing after launch sanitization.

The original Lane launch ask includes `sessionPath` even when its file is unwritten and `open` is `new`. Application passes that same value to process ownership. `LaunchIngress` is the production Sink adapter: it dispatches original asks through Application, retains pending effects independently of the caller, and joins them on close. Root still must construct that adapter in its production source factory.

| Actual Rust 1.95 run | Observed scope | Result |
|---|---|---|
| `20261114-190249-6baf` | Machine/proxy, launch assembly and real Lane unwritten-path/restart consumers | 22 passed |
| `20261114-191751-dc4b` | Persisted preferences, browser catalog/cache and session-free policy consumers | 9 passed |
| `20261114-192309-d24d` | Concrete ownership adapter over the existing encrypted Host effect fixture and real runtime log files | 2 passed |
| `20261114-195439-5fbc` | Existing launch assembly, real native child/exit, memory output and first-tab consumers | 20 passed |
| `20261114-201556-897a` | Concrete LaunchHost, original unwritten/restart paths, process tags/scratch modes, generated tools, parent-environment stripping and retired-owner refusal | 3 passed |
| `20261114-203740-ed2c` | The same positive real-child/restart consumer through production LaunchIngress; original two direct-Application negative consumers retained | 3 passed |

Both three-case checks used actual Rust 1.95, fresh results and unchanged inputs. The latter test observes status without answering launch asks itself; the production Sink performs those answers. These observations do not establish production Owner/permission ingress, Root service composition, enabled REA/Memory execution, CEF/platform artifacts, Node removal or a formal stamp.

### Original view identity evidence

The pool's existing epoch, entry sequence and attachment generation produce the stream `viewId`. Required full-stream envelopes, FullChannel receivers and the original Node carrier preserve that value; absent identities fail closed. A replacement core re-announces `wireFull` for the retained owner/viewer attachments rather than deriving their identity from whichever window is current.

| Actual run | Observed scope | Result |
|---|---|---|
| `20261114-205329-6ad4` | Native Pool/Frames/FullChannel, rejoin, new-epoch reseed and existing captured-run/exit/claim consumers, Rust 1.95 | 42 passed |
| `20261114-205411-f9b7` | Shared page API preserves original tokens and refuses missing/empty identities | 6 passed |
| `20261114-211123-cb2f` | Actual SidecarPool client and rebuilt warm core: original viewer survives core loss, departed viewer stays absent, new-token events reach the same attachments without a second sidecar | 2 passed, 166 filtered out |
| `20261114-211212-ef6c` | TypeScript compiler after the client reseed projection | Passed |

The filtered Vitest runner incorrectly reported its 166 skipped cases as passed in its summary; only the two executed consumers count above. This unit does not integrate Relay's entire close/retirement policy, phone coalescing or renderer absence guards, and does not prove the production RootHost or final application.

### Local and remote source lifetime

`LocalSources` constructs the actual LaunchHost/Application/LaunchIngress over the original execution Owner without starting its child. Runs `20261114-213912-3aad` exercised the original three launch consumers and three factory consumers (six passed). The production Root entry still must call this factory.

The remote Source wraps the existing device-owned RemoteTab rather than creating a second actor. Its bound command and side-channel protocol carries the original omp token and encrypted connection into required Host effects. Run `20261114-220023-1df5` passed 28 remote actor, adapter and hosted-service consumers with Rust 1.95. This is not an authenticated production RootHost observation.

The public Source is the single cleanup owner. Its opaque device release capability removes only the same original actor from the canonical device map; an old release cannot remove or close a replacement. A remote retirement receipt joins this computer's actor, event pump and close acknowledgement, never the execution host's omp exit. A local retirement joins the captured run exit, Lane lifetime and retained Ingress work while keeping its Application alive.

Run `20261114-221812-4920` retained a real failure after eight passing consumers: after the original child exit, Lane lifetime and terminal `sidecar.disposed` event, the local mirror still reported `processAlive: true`. The shared mirror correction consumes that terminal event, which the Lane emits only after all original exits have joined. Its follow-up proof remains distinct from the earlier eight observations.

Run `20261114-222949-0de5` passed the corrected seven Source lifetime consumers and two authenticated peer consumers (nine fresh results, unchanged inputs, Rust 1.95). The final-Arc cleanup gate is bounded to those original actors and receipts. It does not instantiate a production RootHost.

### Observed question provenance

The native observation path issues no authority from a JSON ask. Its execution-host gate checks the original authenticated peer, execution Owner, source Arc, entry incarnation, saved path, current run, blocking card, settings and canonical deletion authority. The observer retains the original device-map actor and connection, then repeats its card/family/recipient checks before lending `VerifiedCard` to a synchronous source-journal keep. The borrowed proof has no deserializer or external constructor. The original Execution-only admission remains unchanged.

Run `20261114-224938-6d73` reproduced a stale pooled question being issued under a replacement omp token. `Held` now retains its emitting Source generation, supplied only through typed source ingress; legacy JSON feed cannot manufacture it. Remote events capture generation before queued delivery. Run `20261114-230139-0c12` passed the two peer consumers and original remote-adapter replacement consumer. Receiver-proof/source-journal composition and production Root ingress remain separate, unfinished gates.

The approved 36-leaf Inbox intake preserves the existing source/receiver journals, request tuple and Execution wire shape. Its first combined compile (`20261114-230606-1902`) failed at the Base integration's misplaced method boundaries, an obsolete Execution field projection and the missing canonical non-destructive upload-read prerequisite. These are integration failures, not a reclassification of Main's independently passing Inbox source cohort. No receiving, provider-context or full-application success follows from source intake alone.

### Captured RPC integration, 15 Nov 2026

The original command admission binds the caller, execution Owner, Source Arc, entry/view identity, session path, cwd, generation and Scope. Local Session helpers recheck that admission at each actual enqueue. Private plan approval uses the existing local `modes.plan_approval` bridge, not stock fallback. The RPC waiter has a typed timeout distinct from ordinary local failure; retained work and cleanup can outlive its waiter.

| Actual Rust 1.95 run | Observed scope | Result |
|---|---|---|
| `20261115-012553-f7a0` | Slot policy, original child and eagerly admitted stop/kill before receipt polling | Slot 11 passed; a separate Autopilot case failed in the same run |
| `20261115-013918-b88d` | Captured local-first Autopilot, command admission and RPC waiter consumers | 15 passed |
| `20261115-014324-2fda` | Registered Requests reply/effect lifetime separation and original shutdown barriers | 7 passed |
| `20261115-021844-e159` | First registered outer-policy compile | Two compile errors; no runtime cases. Owner corrections remain separate inputs |
| `20261115-023252-16e6` | Original Source startup wait, cancellation, 60-second boundary and remote offline skip | Three passed; slow-child consumer failed reading its not-yet-created log |
| `20261115-031146-0b2f` | The same four startup consumers after the opt-in real child-entry barrier | Four fresh cases passed; unchanged inputs |
| `20261115-031751-24eb` | First completion/move/login cohort compile | Integration brace/path and owner borrow errors; no runtime cases |
| `20261115-032016-7382` | Registered RPC/Pool/remote consumers | 38 passed, 13 failed; fixture hub failure unresolved in this run |
| `20261115-032403-605a` | Nocapture diagnosis of the same cohort | 41 passed, 9 failed; first hub panic was the existing TestHost's unimplemented internal command consumer |
| `20261115-032620-34e0` | The cohort with TestHost forwarding through its existing generation-bound command implementation | 51 fresh cases passed; unchanged inputs |
| `20261115-033539-bcc3` | Final command capture waits on the original Source and checks its ready run without starting an asleep child | Three fresh cases passed; unchanged inputs |

The startup test now waits for the existing child fixture's opt-in post-start-log frame before inspecting that log; no ready frame, sleep or file polling substitutes for child entry. The corrected four-case run passed with input digest `b785dc535384c645652c5cde04124524c014be28c6925c9d999ab736fde327df` and no changes during execution. An earlier preflight below the 20 GiB floor started no check; the two Main-approved retired Cargo-output batches preserved source, refs, evidence and the sole warm target. The previous failed run remains separate evidence.

Completion/move/login consumers now compile and pass in the 51-case run, with input digest `922f4cbfc2aaafca135016a72df38c07d382fce96134c41bb0d66269b1a0a64b`. They exercise original-source startup capture, immutable old admissions after file/cwd completion, actual multi-window aggregates, move tokens and provider cleanup after caller retirement. The diagnostic fixture fix delegates to the existing NativeLane command implementation; it is not a production Root adapter. Sixteen unused/private-bound warnings remain, including the unconstructed full Policy. Production Root constructors/ingress remain unfinished. No Node spawn, bundle or shim has been removed.

The final page-command capture now consumes `settled_start` itself. Caller, execution, entry and view checks precede the final offline/readiness check and generation capture. An asleep Source receives `sidecar_not_ready` without starting a child; a page revoked while its original Source starts receives no grant. The three-case follow-up used digest `7dc37310688bcaa78b7354be4ae6c38d3092ba38c3230b6e9252eff611094698`. The production page request entry still must invoke this capture.

## Intentionally TypeScript

Renderer UI and its shared page contracts; the stock omp bridge/extensions and SDK-facing stock workers; build/test/capture tooling. A stock worker may load installed omp session storage. Application decisions performed around that SDK read are not automatically exempt from native migration. Runtime-loaded probes and embedded worker scripts require explicit inventory before deleting Node.

## Proof ledger

- Static source inventory has no unresolved imports on the integrated SX tree. This establishes reachability only.
- The five original slices and continuation commits are integration inputs. Their prior unit/compiler results do not prove the combined native runtime or CEF/macOS/Windows behavior.
- Narrow common crate, shell compiler and TypeScript checks are run locally through the official pool. No full build, macOS runner dispatch or user app restart is part of this worktree's current proof.
- Final artifact must launch without the Node main child and exercise desktop, paired-computer and phone behavior. Only then remove `out/main/index.js`, bundled Node, shim production methods and their build/packaging paths together.
- Affected formal coverage includes turn-resume, session-listing, tab-session, session-processes, web-close-reports and repo-lock-core where its covered process/lock paths change. Current inherited stamps are not proof of this integration; Main coordinates runner verification and mutations before landing.
