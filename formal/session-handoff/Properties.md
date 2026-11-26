# Frozen properties: session-handoff

Frozen at: the commit that adds this model (26 Nov 2026). Any change to a definition below, to the fault bound or to the fairness of `Spec` is a **model change**: say so in the report, with the old and the new text and the evidence. Never make one to turn a failing check green.

The definitions are the lines between the `\* FROZEN PROPERTIES` and `\* END FROZEN PROPERTIES` banners of `tla/SessionHandoff.tla`.

`ARunnable == aFile /\ aState \in {"none", "reclaimed", "lost"}`: A's file exists and no tombstone blocks it (`deleted.rs` `has`, asked by pool acquire, layout restore and turn resume). `BRunnable == bTarget /\ ~bTomb`: the journal is at B's target and B has no tombstone for it.

## AtMostOneRunnable

- Kind: invariant
- Statement: `AtMostOneRunnable == ~(ARunnable /\ BRunnable)`
- Meaning: at no time can both computers run the session.
- Source: the reviewer's request; `.omp/rules/remote-devices.md` › "Handing a session to a paired computer" ("Invariant: at most one computer can run the session during an outage").
- Level: protocol
- Config: `MC.cfg`, `MC_large.cfg`, `MC_live.cfg`, `MC_back.cfg`, `MC_timeout.cfg`; must fail in `MC_bug_abort_unrecorded.cfg` and `MC_bug_volatile_pending.cfg`
- Result: not run

## NoCommitAfterAbort

- Kind: invariant
- Statement: `NoCommitAfterAbort == toldAborted => ~bTarget`
- Meaning: once B has answered `aborted` for the id, no commit of it lands. `toldAborted` is set when B produces that answer, even if the link then loses it.
- Source: `native/ompdesk/crates/core/src/remote/handoff.rs` module doc ("a commit that was still on its way can never land after the sender took the session back") and `abort` ("no part or commit of this id may land after that").
- Level: protocol
- Config: `MC.cfg`, `MC_large.cfg`, `MC_live.cfg`, `MC_back.cfg`, `MC_timeout.cfg`; must fail in `MC_bug_no_fence.cfg`
- Result: not run

## ExactlyOneRunnable

- Kind: liveness
- Statement: `ExactlyOneRunnable == <>[](ARunnable # BRunnable)`
- Meaning: once faults stop (at most `MaxFaults`), with the link fair (weak fairness on link-up, the reconcile, every handler and A's answers), exactly one computer can run the session, for good.
- Source: `.omp/rules/remote-devices.md` › "Handing a session to a paired computer" ("exactly one after it"); the reviewer's request.
- Level: protocol
- Config: `MC_live.cfg`, `MC_back.cfg` (F1 fixed), `MC_timeout.cfg` (F2 fixed); must fail in `MC_bug_back_noclear.cfg` and `MC_bug_timeout_noretry.cfg` (the code before each fix)
- Result: not run

Sanity (must be violated): `NeverMoved`, `NeverReclaimed`.
