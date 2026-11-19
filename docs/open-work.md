# Open work

One list of every known defect and requested change, rewritten at each release. Status: **shipped**, **release-ready** (green, in a candidate), **on branch** (written, not yet green on its own candidate), **in progress**, **not started**, **blocked**. Owner = the OMPdesk session working on it (saved id prefix), device in brackets.

Last rewritten: 2026-11-20 02:40 KST. Branch owner names are the session's worktree branch omp/agent/<name>-20261120.

## T. The to-do panel lies

| id | item | status | owner | branch | proof |
|---|---|---|---|---|---|
| T1 | The to-do panel tells the truth: it shows when the list last changed, a stale mark with its reason, and the instructions received since the list last changed (bridge records them whatever the agent does). Real omp 19: journal and panel agree after a steer, a compaction, a relaunch, in a playbook child; red before. | on branch (green), goes with next-line | next-line [desktop] | omp/agent/todo-truth-panel-2-20261120 `cf2b55c48` (on f33b86c67) | ci 44598135849, e2e 44598144567, parity ko 44598151968 / en 44598852252 |
| T1b | The agent itself keeps its list current: reminders showed no measured effect (the model sends 30 reads in one batch; longest unchanged stretch 31-32 → 32-34 calls). Before, Mac mini since 6 Nov, all models: 264.4 active h; stale spans 270/264.4 h; instructions that got a row 403/1127; reminders followed by a change within 3 calls: stock mid-run 137/764, stale 123/375. Recount after release with scripts/todo-truth-stats.ts. | open (measure after release) | | omp/agent/todo-truth-mini-20261120 `669de522e` (panel + todo-nudge) | |

## A. My message waits in the queue

| id | item | status | owner | branch | proof |
|---|---|---|---|---|---|
| A1 | A message sent during a long reply or command reaches the agent now (steer-now). | on branch | next-line [desktop] | omp/agent/next-0134-1 (steer-now `05a8eff84`) | |

## B. A relaunch cuts work

| id | item | status | owner | branch | proof |
|---|---|---|---|---|---|
| B1 | A relaunch does not cut a running command. Done: foreground commands finish on a stop (up to 20 s); background jobs (async:true, main agent) run under `ompdesk keep` and reattach with their id. Still cut: subagents' jobs, pty/named services, commands naming session URLs, stock's 60 s auto-backgrounded calls (never run twice). eval/ssh cut at an approval card end as 'not run again' instead of asking again. | green, into next-line | done | omp/agent/relaunch-keeps-work-20261120 `1f39a6e95` | 44622247982 |
| B2 | A command does not run twice after a relaunch (seen: an empty commit made twice). Cause: stock retry replays a cut batch whose results are all errors. Fixed: a call an earlier process started is answered, never run again (real omp, counter file: before 2 runs in 3 of 3, after 1 run in 6 of 6; formal relaunch-once green). | green, into next-line | relaunch-keeps-work [desktop] | omp/agent/relaunch-keeps-work-20261120 `1f39a6e95` | 44622247982 |
| B3 | A session opened during the restart countdown keeps its first message: the automatic restart holds until the opened session has taken its first message. | green, into next-line | relaunch-keeps-work [desktop] | omp/agent/relaunch-keeps-work-20261120 `1f39a6e95` | 44622247982 |
| B4 | A session that paused waiting for the restart starts again by itself. Fixed: agents are told a relaunch continues their turn (catalog, pstack adapter); an idle goal tab, an armed backoff retry and a deferred Autopilot tab are revived at relaunch. A turn an agent ends anyway is not woken. | green, into next-line | relaunch-keeps-work [desktop] | omp/agent/relaunch-keeps-work-20261120 `1f39a6e95` | 44622247982 |
| B5 | A session another computer opened keeps working when that computer goes off (away-opener). | on branch | next-line [desktop] | omp/agent/next-0134-1 (`e82d28e1f`) | |

## C. Sessions and tabs

| id | item | status | owner | branch | proof |
|---|---|---|---|---|---|
| C1 | A finished tab closes by tool; a close is never refused with a made-up reason (close-visible). | on branch | next-line [desktop] | omp/agent/next-0134-1 (`b24ab49ba`) | |
| C2 | One session's tab stays open on every device after its owner closed it. Case 20 Nov: the Mac mini closed its child "Persistent bridge health" (01a1f309) at ~01:40; the desktop's window kept its tab for that Mac mini session, idle. | on branch (green), goes with next-line | next-line [desktop] | omp/agent/tabs-tidy-20261120 `066a1a38a` | ci 44595185047, full e2e 44595192521, omp-latest 44595212063 |
| C3 | Reading another session opens a tab in the reader's window and leaves it. | on branch (green), goes with next-line | next-line [desktop] | omp/agent/tabs-tidy-20261120 `066a1a38a` | ci 44595185047, full e2e 44595192521, omp-latest 44595212063 |
| C4 | A scratch folder shows as a sidebar project. | on branch (green), goes with next-line | next-line [desktop] | omp/agent/tabs-tidy-20261120 `066a1a38a` | ci 44595185047, full e2e 44595192521, omp-latest 44595212063 |
| C5 | A test tab an agent opens stays after the test. Case 20 Nov: tabs-tidy (desktop) closed after its report, and its repro tab (untitled, scratch …/probeproj, saved id 01a1f4ca) stayed. | on branch (green), goes with next-line | next-line [desktop] | omp/agent/tabs-tidy-20261120 `066a1a38a` | ci 44595185047, full e2e 44595192521, omp-latest 44595212063 |
| C6 | An open to a never-started start tab never answers (fix `3d135b59e`); a call to a tab whose omp cleanup ended never answers. | start-tab fix on next-line; cleanup-ended call: not reproduced (only open/join/reopen wait unbounded on when_ready), needs a captured hang | next-line (3d135b59e), tabs-tidy (cleanup-ended calls) [desktop] | omp/agent/close-web-rc-20261119 (`3d135b59e`) | |
| C7 | `ompdesk_sessions` with `mine: true` lists nothing. | on branch (green), goes with next-line | next-line [desktop] | omp/agent/tabs-tidy-20261120 `066a1a38a` | ci 44595185047, full e2e 44595192521, omp-latest 44595212063 |
| C8 | A paired computer's sidebar differs from the host's real state. | on branch (green), goes with next-line | next-line [desktop] | omp/agent/tabs-tidy-20261120 `066a1a38a` | ci 44595185047, full e2e 44595192521, omp-latest 44595212063 |
| C9 | A tab another tab holds open on a frozen window cannot be closed (live repro on the Mac mini). | on branch (green), goes with next-line | next-line [desktop] | omp/agent/page-watch-20261119 `b8d7d9d5d` | ci+mac 44584807280, tauri-native 44582180703, e2e 44582021779; a real stuck WKWebView restart not run on a macOS runner |
| C10 | After a messageless session's omp was killed, its restarted omp got a new saved id (01a1f4bf → 01a1f4ca) and the empty session file was not resumed. Because of it the opener's 'closed it' referred to the old id and the tab under the new id stayed open. | not started | | | |
| C11 | Whether a person saw or touched a tab is known only inside the auto-close pass (AutoCloseFacts.looked / user_touched). Add: (1) per tab the last time it was shown and typed into (times only) in ompdesk_sessions, as a hint, never a right to close; (2) an agent's close (ompdesk_session_stop) re-judges looked/user_touched on the device that holds the tab at that moment and refuses with the reason if either holds; decide how 'looking now' and 'looked at since opened' block, beside today's typed-into rule; (3) empty = unknown, not 'not seen' (tabs opened before the record, a disconnected device, a device on an older version): the agent does not close and asks the person. Tests: a person opens the tab after the list was read, then close → refused; a disconnected device's tab shows unknown and close is refused; a tab older than the record is unknown. | not started | | | |

## D. Silently stale or stopped

| id | item | status | owner | branch | proof |
|---|---|---|---|---|---|
| D1 | Follow a new omp by itself: verified list, one owner of omp updates, stock `update.auto` taken over and given back, a held version told and retold after 24 h, the list file guarded (`docs/design/follow-omp.md`). | in progress | follow-omp [desktop] | | |
| D2 | Repair path for an omp installed with npm (installs the newest today). | in progress | follow-omp [desktop] | | |
| D3 | Windows: the first update download after a release fails and the next check 5 min later works; a failed download reads "failed". | release-ready |  | omp/agent/rc-0134-2 `e3eb65db5` | fix 7c3632ca2; gate 44567381628 (a)(b real omp)(c)+mac(c), ci 44567117321 on 23ef5665c |
| D4 | Release gate: the previous release updates itself to the candidate (and the candidate to a next build). | release-ready |  | omp/agent/rc-0134-2 `e3eb65db5` | same gate run; future gates keep (c) and previous-release→candidate |
| D5 | A frozen shell or page stops update lookups (Mac mini page frozen since 09:12 on 19 Nov). | on branch (green), goes with next-line | next-line [desktop] | omp/agent/page-watch-20261119 `b8d7d9d5d` | ci+mac 44584807280, tauri-native 44582180703, e2e 44582021779; a real stuck WKWebView restart not run on a macOS runner |
| D6 | Why the app ended is never logged (shell, node, quit source). Also: SIGINT/SIGTERM/SIGHUP now quit through the quit guard. | release-ready |  | omp/agent/rc-0134-2 `e3eb65db5` | ci 44552014530, mac 44564510088 on ed3b3001a |
| D7 | The bridge self-check result cannot be read afterwards. | release-ready |  | omp/agent/rc-0134-2 `e3eb65db5` | ci 44566470675 on 6e943272e |
| D8 | A message a paired computer never answered reads "not sent". | shipped 0.134.1 | | | |

## E. A whole feature group turns off

| id | item | status | owner | branch | proof |
|---|---|---|---|---|---|
| E1 | When omp drops one internal, only the features that need it turn off (capability-granular). | on branch | next-line [desktop] | omp/agent/next-0134-1 (`a5650a75c`) | |

## F. Memory and unexplained ends

| id | item | status | owner | branch | proof |
|---|---|---|---|---|---|
| F1 | macOS "out of application memory" on a 16 GB Mac mini: OMPdesk 5.6 GB, one tab's omp 1.87 GB. Measured: stock's SessionManager keeps the whole journal parsed (~3.5x file size; Main's 367 MB journal holds ~1.3 GB in a fresh stock omp); the bridge adds nothing measurable; OMPdesk's own share is ompdesk.checkout-claims snapshots (35 MB of the file, 134 MB parsed). The memory record read ps rss (136-486 MB for an omp at ~1.9 GB): fixed to phys_footprint. | in progress | memory-mini [Mac mini] | omp/agent/memory-mini-20261120 `bee085b21` | 44610878357 |
| F2 | node main grows (2.33 GB after 26 h on 0.133.0; peak 2.5 GB in 5h48m on 0.134.1). Cause reproduced: session-pace readPace read a whole journal into one string on every sessions list (367 MB file: peak 1.3 GB). Fixed to a streamed fold that reads only appended bytes (peak 145 MB, append 27 ms). | fixed on branch, ci running | memory-mini [Mac mini] | omp/agent/memory-mini-20261120 `8db945a34` | 44610878357 |
| F3 | Ends with no known cause (MacBook 23:28, Mac mini 23:33 force quit on 19 Nov). | blocked on D6 | | | |
| F4 | ompdesk.checkout-claims writes a full snapshot of every claimed file every 15 s while editing (up to 951 files, 116 KB per entry); Main's journal held 951 claims for about a day. Claims that never retired, or snapshots that should be deltas. | in progress | memory-mini [Mac mini] | | |
| F5 | A long-lived orchestrator session grows its omp with its journal (stock keeps every entry). Product lever: hand it to a fresh session past some journal size. Not started. | open | | | |

## G. Tests and tools

| id | item | status | owner | branch | proof |
|---|---|---|---|---|---|
| G1 | The pre-push guard blocks a test branch that sits on released commits; block only commits reachable from probe/* alone. | green, into next-line | test-tools [desktop] | | |
| G2 | Windows e2e: rmdir of the test project fails EBUSY for ~3.5 s after omp exits. Cause measured: omp 19's per-config daemon (spawned detached, no cwd, so it inherits the project folder) lives 3 s after its last client. The shipped retry (5.5 s) covers it; recorded in e2e-ci-windows rule. | closed (cause found) | test-tools [desktop] | omp/agent/test-tools-20261120 `4e0ac505f` | |
| G3 | The Preview check ends "could not check" on a real Windows desktop: measure the rate, warm it if frequent. | green on test-tools (ci 44612596843) | test-tools [desktop] | | |
| G4 | No test drives the real app with real omp for `!`, `!!`, `$`, the Plan card, cancelling a compaction, dequeue. | green on test-tools (ci 44612596843) | test-tools [desktop] | | |
| G6 | ci installer-check could never pass since the Tauri move (it waited for an Electron DevTools port, then looked for an Electron GPU process). Fixed: proves the first window by app-started.json + renderer-mounted; crashes this app's WebView2 GPU process twice and asserts the app survives with its window. A fresh release install starts (silent and double-click). | green, into next-line | test-tools [desktop] | omp/agent/installer-check-tauri-20261120 `88b97858d` | 44609251808 |
| G10 | 'The app survives a GPU process crash' had never been checked on the Tauri shell. Now checked by the installer check: it crashes this app's WebView2 GPU process and asserts the same main process, a fully repainted grown window and a logged GPU line (G6, G12). | closed | test-tools (closed) | omp/agent/installer-check-tauri-20261120 | 44622126661 |
| G11 | Two worktree sessions opened in one ompdesk_session_open call ran .ompdesk/worktree-setup at the same moment; one failed 'could not lock config file …/.git/config: File exists' (exit 255) after packages and Electron were in place, so its later steps (core.hooksPath) did not run until rerun by hand. Setups that write the shared checkout's config must not race (serialize them, or retry the lock). | open | | | |
| G12 | GPU fallback was dead on the Tauri shell, and a crashed renderer left WebView2's error page up. Fixed: tauri-shell reports WebView2 ProcessFailed (renderer -> render-process-gone, main reloads; GPU -> app.childProcessGone); the first GPU crash does not relaunch (WebView2 repaints, proven by a grown window); a second within the cooldown relaunches once into software. Not proven on a runner: the second-crash relaunch and an unresponsive (not crashed) renderer. | green, into next-line | test-tools (closed) | omp/agent/installer-check-tauri-20261120 | 44622126661, 44622183053 |
| G13 | Worktree removal on Windows while omp's daemon holds the folder as cwd: no defect. The core's git_remove records the empty leftover and disk care removes it later (real omp on the desktop; runner 5 of 5; omp-latest Windows daily). | closed (no defect) | test-tools [desktop] | | 44614315383 |
| G14 | One session emptied the account's shared GitHub REST quota (core 0/5000 until 06:46 KST, 20 Nov) by re-reading past run logs; every project on the account shares that quota (all PATs and gh's token count against one user). Device in the bridge's waste guards: finished-run logs fetched once and kept by id; read `gh api rate_limit` (core and graphql) at most once a minute per computer and refuse wide reads below 1500 left; a burst hint per session. Watches are not exempt: `gh run watch` polls every 3 s by default (~2,400 requests/hour each) and scripts/watch-run.ts every 15 s; the device raises intervals to at least 60 s and refuses new watches under the floor. A gh wrapper first on each session's PATH (covers piped and scripted calls), not only a bash hook. | in progress | gh-budget [Mac mini] | omp/agent/gh-budget-20261120 | |
| G15 | e2e specs that assert 'a tab opened' by tab count only (R5's shape): agent-control-across.e2e.ts:165,170,175,223; agent-mail.e2e.ts:96; daily-flows.e2e.ts:774,862,865; mobile-autopilot-rows.e2e.ts:276; no-loading.e2e.ts:161; sessions-schedules.e2e.ts:94,116; settings-device-switch.e2e.ts:133. Assert which session the opened tab holds. | open | | | |
| G7 | The pre-push check does not run the Rust/TS table comparisons, so a merge that reorders captured/meta.json reached ci red (44569228302). | green, into next-line | test-tools [desktop] | | |
| G8 | e2e agent-control-across 'shows, notifies and reports…' reads the board row right after the child's done report, but auto-close may close the child first (board shows '1 done'): a race in the test; passed on reruns, not counted as proof. | not started | | | 44579634026 |
| G9 | ci batch on todo-truth-panel-2 (44598135849): session-launch-parity.test.ts failed once on Windows and passed on rerun; not diagnosed, not counted as proof. | not started | | | |
| G5 | turn-stages test counted the next-prompt suggestion request. | release-ready |  | omp/agent/rc-0134-2 `e3eb65db5` | failed 0 of 40 under load |

## H. Earlier list

| id | item | status | owner | branch | proof |
|---|---|---|---|---|---|
| H13 | Check control (the checks view). | local half green (ci 44612708554), hub parts open | earlier-list [desktop] | | |
| H23 | The line and card shown during a compaction. | green (ci 44616085064, parity 44616997735), into next-line | earlier-list [desktop] | | |
| H24 | Themes: default plus four light/dark pairs (eleven themes exist today; first list what is left). | green (ci 44616085064, parity 44616997735), into next-line | earlier-list [desktop] | | |
| H26 | Credits are never used while their switch is off (no first-call or refresh exception); at the limit stop and tell. | in progress | earlier-list [desktop] | | |
| H27 | A black terminal window appears (Windows). | blocked: no repro; add a probe | earlier-list [desktop] | | |
| H28 | Windows feels slow. | blocked: no repro; add a probe | earlier-list [desktop] | | |
| H30 | The phone page cannot load older messages. | green (ci 44616085064, parity 44616997735), into next-line | earlier-list [desktop] | | |
| H31 | An 18-hour wait, cause unknown. | blocked: no repro; add a probe | earlier-list [desktop] | | |
| H32 | release.yml: hold only the publish step (draft release, approval); workflow commits separate. | not started | | | |

## R. Candidate 0.135.0 findings

| id | item | status | owner | branch | proof |
|---|---|---|---|---|---|
| R1 | A click on a session row's new second line selected nothing (the line painted over the row's click target). | release-ready | | omp/agent/rc-0134-2 `a59111ad4` (de0fc9205) | candidate 0/8 vs v0.134.1 8/8 vs fixed 8/8 passing (44580646695, 44580654743, 44581975250); notification-open fixed 8/8 (44581981616); row hit test 6/6 |
| R2 | mobile-autopilot-rows read the new branch line as a child named after its branch. | release-ready (test) | | `69228ec7e` | spec run 44580343480 |
| R3 | mobile-remote-session:459 'a host slow to start': the app window never loaded in 30 s once (WebView2 stuck at __profile/migrate). Unconfirmed: v0.134.1 0 of 10 failed, fixed candidate 0 of 10, candidate line 1 of 11. Migrate page leaves no log. | unconfirmed (recorded): 0 stops in 300 Windows launches | | | launch probe through migrate: candidate clean 0/50, Electron-era 0/50, update path 0/50 (never on migrate); v0.134.1 the same 0/50 ×3 (44589743856, 44589750606, 44589755913, 44589858476, 44589864938, 44589871995); the failing spec itself not yet run 50× with the recorder |
| R4 | The migrate page (/__profile/migrate) can stay unanswered: its request was sent and never answered (trace status -1), so the page never committed; lost between WebView2's WebResourceRequested and wry's response, not in our code; also on a branch without page-watch. Fixed in the shell (migrate_watch.rs): every step logged to tauri-shell.jsonl, a step with no next in 10 s reloads, 3 tries then the reason + Retry. N1 (no DevTools port at all) is a different symptom. | fix on branch, e2e before/after running | migrate-stall [desktop] | omp/agent/migrate-stall-20261120 `e29e2a9b0` | 44626606290, 44626597403 |
| R5 | e2e remote-autopilot-board:46 failed on Windows on a59111ad4 (44587803757 shard 2): a paired device's click on the board's opened-child row opened no tab in 10 s; passed on e3eb65db5. Shard 1 of the same run lost its runner (no log). | Reproduced race: clicking a board row that has no session file yet does nothing (forced on the candidate 1 of 4, click log sessionPath=none). Whether the first failure (44587803757) was this: unconfirmed (no click log in that build; hover only shows the pointer was there). Whether the candidate changed the frequency: unconfirmed (natural candidate 0/36, e3eb65db5 0/10). Code: openOpenedChild unchanged since 31 Oct (8330750692); candidate's agent-control diff touches only the app catalog/channels. v0.134.1 forced x10: 44622257822 (running). Ships in 0.135.0 as known: a just-opened child's row may not open on the first click (a second click opens it); fix b4c47932a in the next release with a click log and a 'tab holds the child's file' assertion. | rc-0135-board [Mac mini] | | |
| R6 | remote-autopilot-board.e2e.ts:120 failed once in 10 on v0.134.1 (44597445786): B's own board showed Cycle 8 with the child running 30 s while B's get_autopilot read cycle 4 for 90 s. Separate from R5; not investigated. | open | | | 44597445786 |
| R7 | e2e preview-stream 'phone preview streams paced JPEG frames' fails 'No first frame' on Windows: main 72d081111 5 of 20, next-line ccc602bed 1 of 20 (same message). Pre-existing on main; cause not looked at. | open | | | 44624097337, 44624104495 |
| N1 | next-line e2e (566af6e9f, shard 4): a11y-audit's first launch 'WebView2 opened no DevTools port within 60000 ms'; tauri-shell.jsonl has node.spawned and host.hello only, no window. page-watch (new on next-line) touches window creation, so not ruled out. | unconfirmed, watching the full e2e on f298d0185 | next-line [desktop] | omp/agent/next-line-20261120 | |

## I. Boundaries

| id | item | status | owner | branch | proof |
|---|---|---|---|---|---|
| I1 | An agent can read another project's session content. Propose a per-project boundary: other projects' sessions show counts and state only. | in progress on a branch, not in any release until the owner decides (access rule) | tabs-tidy [desktop] | omp/agent/project-boundary-20261120 `993f03a02` | ci on the tip running; e2e 44601406118 on the tip; owner's three choices pending |
