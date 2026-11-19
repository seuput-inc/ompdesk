# Open work

One list of every known defect and requested change, rewritten at each release. Status: **shipped**, **release-ready** (green, in a candidate), **on branch** (written, not yet green on its own candidate), **in progress**, **not started**, **blocked**. Owner = the OMPdesk session working on it (saved id prefix), device in brackets.

Last rewritten: 2026-11-20 02:40 KST. Branch owner names are the session's worktree branch omp/agent/<name>-20261120.

## T. The to-do panel lies

| id | item | status | owner | branch | proof |
|---|---|---|---|---|---|
| T1 | The to-do panel tells the truth: it shows when the list last changed, a stale mark with its reason, and the instructions received since the list last changed (bridge records them whatever the agent does). Real omp 19: journal and panel agree after a steer, a compaction, a relaunch, in a playbook child; red before. | on branch (green), goes with next-line | next-line [desktop] | omp/agent/todo-truth-panel-20261120 `f33b86c67` | ci 44593104762, parity 44593075817, e2e 44590314796 |
| T1b | The agent itself keeps its list current: reminders showed no measured effect (the model sends 30 reads in one batch; longest unchanged stretch 31-32 → 32-34 calls). Before, Mac mini since 6 Nov, all models: 264.4 active h; stale spans 270/264.4 h; instructions that got a row 403/1127; reminders followed by a change within 3 calls: stock mid-run 137/764, stale 123/375. Recount after release with scripts/todo-truth-stats.ts. | open (measure after release) | | omp/agent/todo-truth-mini-20261120 `669de522e` (panel + todo-nudge) | |

## A. My message waits in the queue

| id | item | status | owner | branch | proof |
|---|---|---|---|---|---|
| A1 | A message sent during a long reply or command reaches the agent now (steer-now). | on branch | next-line [desktop] | omp/agent/next-0134-1 (steer-now `05a8eff84`) | |

## B. A relaunch cuts work

| id | item | status | owner | branch | proof |
|---|---|---|---|---|---|
| B1 | A relaunch does not cut a running command: it keeps running outside the session and reattaches, or resumes exactly where it stopped. | in progress | relaunch-keeps-work [desktop] | | |
| B2 | A command does not run twice after a relaunch (seen: an empty commit made twice). | in progress | relaunch-keeps-work [desktop] | | |
| B3 | A session opened during the restart countdown keeps its first message. | in progress | relaunch-keeps-work [desktop] | | |
| B4 | A session that paused waiting for the restart starts again by itself. | in progress | relaunch-keeps-work [desktop] | | |
| B5 | A session another computer opened keeps working when that computer goes off (away-opener). | on branch | next-line [desktop] | omp/agent/next-0134-1 (`e82d28e1f`) | |

## C. Sessions and tabs

| id | item | status | owner | branch | proof |
|---|---|---|---|---|---|
| C1 | A finished tab closes by tool; a close is never refused with a made-up reason (close-visible). | on branch | next-line [desktop] | omp/agent/next-0134-1 (`b24ab49ba`) | |
| C2 | One session's tab stays open on every device after its owner closed it. Case 20 Nov: the Mac mini closed its child "Persistent bridge health" (01a1f309) at ~01:40; the desktop's window kept its tab for that Mac mini session, idle. | on branch | tabs-tidy [desktop] | omp/agent/tabs-tidy-20261120 `28ea4c5f4` | ci 44576978842, formal 44576986560, e2e 44579634026 + 44587674163; needs main merged (base predates 0.134.1) |
| C3 | Reading another session opens a tab in the reader's window and leaves it. | on branch | tabs-tidy [desktop] | omp/agent/tabs-tidy-20261120 `28ea4c5f4` | ci 44576978842, formal 44576986560, e2e 44579634026 + 44587674163; needs main merged (base predates 0.134.1) |
| C4 | A scratch folder shows as a sidebar project. | on branch | tabs-tidy [desktop] | omp/agent/tabs-tidy-20261120 `28ea4c5f4` | ci 44576978842, formal 44576986560, e2e 44579634026 + 44587674163; needs main merged (base predates 0.134.1) |
| C5 | A test tab an agent opens stays after the test. | on branch | tabs-tidy [desktop] | omp/agent/tabs-tidy-20261120 `28ea4c5f4` | ci 44576978842, formal 44576986560, e2e 44579634026 + 44587674163; needs main merged (base predates 0.134.1) |
| C6 | An open to a never-started start tab never answers (fix `3d135b59e`); a call to a tab whose omp cleanup ended never answers. | start-tab fix on next-line; cleanup-ended call: not reproduced (only open/join/reopen wait unbounded on when_ready), needs a captured hang | next-line (3d135b59e), tabs-tidy (cleanup-ended calls) [desktop] | omp/agent/close-web-rc-20261119 (`3d135b59e`) | |
| C7 | `ompdesk_sessions` with `mine: true` lists nothing. | on branch | tabs-tidy [desktop] | omp/agent/tabs-tidy-20261120 `28ea4c5f4` | ci 44576978842, formal 44576986560, e2e 44579634026 + 44587674163; needs main merged (base predates 0.134.1) |
| C8 | A paired computer's sidebar differs from the host's real state. | on branch | tabs-tidy [desktop] | omp/agent/tabs-tidy-20261120 `28ea4c5f4` | ci 44576978842, formal 44576986560, e2e 44579634026 + 44587674163; needs main merged (base predates 0.134.1) |
| C9 | A tab another tab holds open on a frozen window cannot be closed (live repro on the Mac mini). | on branch (green), goes with next-line | next-line [desktop] | omp/agent/page-watch-20261119 `b8d7d9d5d` | ci+mac 44584807280, tauri-native 44582180703, e2e 44582021779; a real stuck WKWebView restart not run on a macOS runner |
| C10 | After a messageless session's omp was killed, its restarted omp got a new saved id (01a1f4bf → 01a1f4ca) and the empty session file was not resumed. | not started | | | |

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
| F1 | macOS "out of application memory" on a 16 GB Mac mini: OMPdesk 5.6 GB, one tab's omp 1.87 GB. | in progress | memory [desktop] | | |
| F2 | node main grows (2.33 GB after 26 h on 0.133.0). | in progress | memory [desktop] | | |
| F3 | Ends with no known cause (MacBook 23:28, Mac mini 23:33 force quit on 19 Nov). | blocked on D6 | | | |

## G. Tests and tools

| id | item | status | owner | branch | proof |
|---|---|---|---|---|---|
| G1 | The pre-push guard blocks a test branch that sits on released commits; block only commits reachable from probe/* alone. | in progress | test-tools [desktop] | | |
| G2 | agent-studio cleanup EBUSY on Windows: retry shipped in the test; the holding process is still unknown. | release-ready (test retry) / root not started | test-tools [desktop] | omp/agent/rc-0134-2 `e3eb65db5` | failed 0 of 80 under load (44544819346) |
| G3 | The Preview check ends "could not check" on a real Windows desktop: measure the rate, warm it if frequent. | in progress | test-tools [desktop] | | |
| G4 | No test drives the real app with real omp for `!`, `!!`, `$`, the Plan card, cancelling a compaction, dequeue. | in progress | test-tools [desktop] | | |
| G6 | shell-batch-checks `installer-check` fails on main 72d081111 (run 44561065983); not on the release path, cause unknown. One Windows e2e SIGKILL-resume case failed once in 44554809040 (passed on rerun: not counted as proof). | in progress | test-tools [desktop] | | |
| G7 | The pre-push check does not run the Rust/TS table comparisons, so a merge that reorders captured/meta.json reached ci red (44569228302). | in progress | test-tools [desktop] | | |
| G8 | e2e agent-control-across 'shows, notifies and reports…' reads the board row right after the child's done report, but auto-close may close the child first (board shows '1 done'): a race in the test; passed on reruns, not counted as proof. | not started | | | 44579634026 |
| G5 | turn-stages test counted the next-prompt suggestion request. | release-ready |  | omp/agent/rc-0134-2 `e3eb65db5` | failed 0 of 40 under load |

## H. Earlier list

| id | item | status | owner | branch | proof |
|---|---|---|---|---|---|
| H13 | Check control (the checks view). | in progress | earlier-list [desktop] | | |
| H23 | The line and card shown during a compaction. | in progress | earlier-list [desktop] | | |
| H24 | Themes: default plus four light/dark pairs (eleven themes exist today; first list what is left). | in progress | earlier-list [desktop] | | |
| H26 | Credits are never used while their switch is off (no first-call or refresh exception); at the limit stop and tell. | in progress | earlier-list [desktop] | | |
| H27 | A black terminal window appears (Windows). | blocked: no repro; add a probe | earlier-list [desktop] | | |
| H28 | Windows feels slow. | blocked: no repro; add a probe | earlier-list [desktop] | | |
| H30 | The phone page cannot load older messages. | in progress | earlier-list [desktop] | | |
| H31 | An 18-hour wait, cause unknown. | blocked: no repro; add a probe | earlier-list [desktop] | | |
| H32 | release.yml: hold only the publish step (draft release, approval); workflow commits separate. | not started | | | |

## R. Candidate 0.135.0 findings

| id | item | status | owner | branch | proof |
|---|---|---|---|---|---|
| R1 | A click on a session row's new second line selected nothing (the line painted over the row's click target). | release-ready | | omp/agent/rc-0134-2 `a59111ad4` (de0fc9205) | candidate 0/8 vs v0.134.1 8/8 vs fixed 8/8 passing (44580646695, 44580654743, 44581975250); notification-open fixed 8/8 (44581981616); row hit test 6/6 |
| R2 | mobile-autopilot-rows read the new branch line as a child named after its branch. | release-ready (test) | | `69228ec7e` | spec run 44580343480 |
| R3 | mobile-remote-session:459 'a host slow to start': the app window never loaded in 30 s once (WebView2 stuck at __profile/migrate). Unconfirmed: v0.134.1 0 of 10 failed, fixed candidate 0 of 10, candidate line 1 of 11. Migrate page leaves no log. | unconfirmed | | | 44584888421, 44584897113, 44581968887 |
| R4 | The shell's profile-migration page (/__profile/migrate, only while tauri-local-storage-import.json is missing: a new profile's first launch, the first launch after the Electron→Tauri move) shows an error and Retry when it throws, but has no timeout, no automatic retry and no log line when profileRead/profileAck never answer: the window just stays. | next release: retry on a timeout and log why (a new install's first screen) | | | |

## I. Boundaries

| id | item | status | owner | branch | proof |
|---|---|---|---|---|---|
| I1 | An agent can read another project's session content. Propose a per-project boundary: other projects' sessions show counts and state only. | in progress on a branch, not in any release until the owner decides (access rule) | tabs-tidy [desktop] | omp/agent/project-boundary-20261120 | proposal |
