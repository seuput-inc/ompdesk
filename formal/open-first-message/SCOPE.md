# Scope: an open's first message across a quit

## The promise

A session `ompdesk_session_open` made gets its setup (worker mark, model, plan mode) and its first message (or goal) exactly once, also when the app quits between the child's tab and that message, and its opener hears when it cannot.

## The harm

19 Nov 2026 (MacBook): a child opened during the update's 60 s restart countdown came back "not started", untitled, with no first message in its session file; turn-resume had no marker for it, and the opener had to send its brief again by hand.

## Why tests miss it

The quit can land before the message goes out, while it is on its way, or after the child's omp took it but before its loop journaled it, and the relaunch's sweep can race an open still sending. A unit test pins one of those orders (`sessions/tests.rs` "an open cut off by a quit"); the model checks all of them.

## Bounds

One open, up to 2 quits (3 in `fix-three-quits`); any interleaving of the open, the omp's journaling, quits, relaunches and the sweep.

## In the model

`set_up` keeping the entry before anything goes out and recording the omp it handed the prompt to (`sessions/open.rs`), the omp holding a queued prompt in memory until its loop journals it, a quit losing what it held, the relaunch's new omp, the sweep (`deliver_owed`: settle when journaled, skip the omp that holds it, else hand it over with its setup) run in the receiver's lane.

## Not in the model

- The setup commands one by one (each is idempotent: `agent_control_worker` journals once, `set_model` and `set_plan_mode` set a state): modelled as part of the hand-over.
- A goal (`set_goal`): settled once stock took it, since its entry carries no marker; a quit after stock took it and before it journaled is not covered (stock journals the goal state at once).
- Telling the opener: a refused setup step calls `trouble` once (`Owed::prompt`); not a safety property.
