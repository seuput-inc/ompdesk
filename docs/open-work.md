# Open work

One list of every known defect and requested change, rewritten at each release. Status: **shipped**, **release-ready** (green, in a candidate), **on branch** (written, not yet green on its own candidate), **in progress**, **not started**, **blocked**. Owner = the OMPdesk session working on it (saved id prefix), device in brackets.

Last rewritten: 2026-11-20 02:10 KST.

## T. The to-do panel lies

| id | item | status | owner | branch | proof |
|---|---|---|---|---|---|
| T1 | An agent's to-do list goes stale: the "now" row shows a step finished hours ago, done counts jump, playbook steps fill the list while the real work has no row. Find which of: copied playbook steps, steers that add no row, the "never a todo-only turn" rule deferring updates, compaction, reminder thresholds, a panel that shows a stale "now" without saying so. Fix on both sides (agent prompts and the panel) and measure before/after from session files. | not started | new [desktop] | | before/after: minutes of tool calls with no list change; share of new instructions that add a row |

## A. My message waits in the queue

| id | item | status | owner | branch | proof |
|---|---|---|---|---|---|
| A1 | A message sent during a long reply or command reaches the agent now (steer-now). | on branch | new [desktop] | omp/agent/next-0134-1 (steer-now `05a8eff84`) | |

## B. A relaunch cuts work

| id | item | status | owner | branch | proof |
|---|---|---|---|---|---|
| B1 | A relaunch does not cut a running command: it keeps running outside the session and reattaches, or resumes exactly where it stopped. | not started | new [desktop] | | |
| B2 | A command does not run twice after a relaunch (seen: an empty commit made twice). | not started | new [desktop] | | |
| B3 | A session opened during the restart countdown keeps its first message. | not started | new [desktop] | | |
| B4 | A session that paused waiting for the restart starts again by itself. | not started | new [desktop] | | |
| B5 | A session another computer opened keeps working when that computer goes off (away-opener). | on branch | new [desktop] | omp/agent/next-0134-1 (`e82d28e1f`) | |

## C. Sessions and tabs

| id | item | status | owner | branch | proof |
|---|---|---|---|---|---|
| C1 | A finished tab closes by tool; a close is never refused with a made-up reason (close-visible). | on branch | new [desktop] | omp/agent/next-0134-1 (`b24ab49ba`) | |
| C2 | One session's tab stays open on every device after its owner closed it. | not started | new [desktop] | | |
| C3 | Reading another session opens a tab in the reader's window and leaves it. | not started | new [desktop] | | |
| C4 | A scratch folder shows as a sidebar project. | not started | new [desktop] | | |
| C5 | A test tab an agent opens stays after the test. | not started | new [desktop] | | |
| C6 | An open to a never-started start tab never answers (fix `3d135b59e`); a call to a tab whose omp cleanup ended never answers. | on branch / not started | new [desktop] | omp/agent/close-web-rc-20261119 (`3d135b59e`) | |
| C7 | `ompdesk_sessions` with `mine: true` lists nothing. | not started | new [desktop] | | |
| C8 | A paired computer's sidebar differs from the host's real state. | not started | new [desktop] | | |
| C9 | A tab another tab holds open on a frozen window cannot be closed (live repro on the Mac mini). | in progress | 01a1f2ea [Mac mini] | omp/agent/page-watch-20261119 | |

## D. Silently stale or stopped

| id | item | status | owner | branch | proof |
|---|---|---|---|---|---|
| D1 | Follow a new omp by itself: verified list, one owner of omp updates, stock `update.auto` taken over and given back, a held version told and retold after 24 h, the list file guarded (`docs/design/follow-omp.md`). | not started | new [desktop] | | |
| D2 | Repair path for an omp installed with npm (installs the newest today). | not started | new [desktop] | | |
| D3 | Windows: the first update download after a release fails and the next check 5 min later works; a failed download reads "failed". | in progress | 01a1f42b [Mac mini] | omp/agent/win-update-session-20261119 | gate (a)(b real omp)(c) + mac (c) |
| D4 | Release gate: the previous release updates itself to the candidate (and the candidate to a next build). | in progress | 01a1f42b [Mac mini] | omp/agent/win-update-session-20261119 | |
| D5 | A frozen shell or page stops update lookups (Mac mini page frozen since 09:12 on 19 Nov). | in progress | 01a1f2ea [Mac mini] | omp/agent/page-watch-20261119 | |
| D6 | Why the app ended is never logged (shell, node, quit source). | in progress | 01a1f44d [Mac mini] | omp/agent/exit-reason-log-20261119 | ci green Linux+Windows; macOS pending |
| D7 | The bridge self-check result cannot be read afterwards. | release-ready | | omp/agent/rc-0134-2 | ci 44566470675 |
| D8 | A message a paired computer never answered reads "not sent". | shipped 0.134.1 | | | |

## E. A whole feature group turns off

| id | item | status | owner | branch | proof |
|---|---|---|---|---|---|
| E1 | When omp drops one internal, only the features that need it turn off (capability-granular). | on branch | new [desktop] | omp/agent/next-0134-1 (`a5650a75c`) | |

## F. Memory and unexplained ends

| id | item | status | owner | branch | proof |
|---|---|---|---|---|---|
| F1 | macOS "out of application memory" on a 16 GB Mac mini: OMPdesk 5.6 GB, one tab's omp 1.87 GB. | not started | new [desktop] | | |
| F2 | node main grows (2.33 GB after 26 h on 0.133.0). | not started | new [desktop] | | |
| F3 | Ends with no known cause (MacBook 23:28, Mac mini 23:33 force quit on 19 Nov). | blocked on D6 | | | |

## G. Tests and tools

| id | item | status | owner | branch | proof |
|---|---|---|---|---|---|
| G1 | The pre-push guard blocks a test branch that sits on released commits; block only commits reachable from probe/* alone. | not started | new [desktop] | | |
| G2 | agent-studio cleanup EBUSY on Windows: retry shipped in the test; the holding process is still unknown. | release-ready / not started | | omp/agent/rc-0134-2 | failed 0 of 80 under load (44544819346) |
| G3 | The Preview check ends "could not check" on a real Windows desktop: measure the rate, warm it if frequent. | not started | new [desktop] | | |
| G4 | No test drives the real app with real omp for `!`, `!!`, `$`, the Plan card, cancelling a compaction, dequeue. | not started | new [desktop] | | |
| G5 | turn-stages test counted the next-prompt suggestion request. | release-ready | | omp/agent/rc-0134-2 | failed 0 of 40 under load |

## H. Earlier list

| id | item | status | owner | branch | proof |
|---|---|---|---|---|---|
| H13 | Check control (the checks view). | not started | new [desktop] | | |
| H23 | The line and card shown during a compaction. | not started | new [desktop] | | |
| H24 | Themes: default plus four light/dark pairs (eleven themes exist today; first list what is left). | not started | new [desktop] | | |
| H26 | Credits are never used while their switch is off (no first-call or refresh exception); at the limit stop and tell. | not started | new [desktop] | | |
| H27 | A black terminal window appears (Windows). | blocked: no repro; add a probe | new [desktop] | | |
| H28 | Windows feels slow. | blocked: no repro; add a probe | new [desktop] | | |
| H30 | The phone page cannot load older messages. | not started | new [desktop] | | |
| H31 | An 18-hour wait, cause unknown. | blocked: no repro; add a probe | new [desktop] | | |
| H32 | release.yml: hold only the publish step (draft release, approval); workflow commits separate. | not started | | | |

## I. Boundaries

| id | item | status | owner | branch | proof |
|---|---|---|---|---|---|
| I1 | An agent can read another project's session content. Propose a per-project boundary: other projects' sessions show counts and state only. | not started | new [desktop] | | proposal |
