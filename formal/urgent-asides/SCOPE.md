# Scope: urgent asides cut a running shell, quiet ones never do

Model: `tla/UrgentAsides.tla` (TLC). Properties: `Properties.md`. Code map and assumptions: `CORRESPONDENCE.md`.

## The promise and the harm

Another session's message (`ompdesk_session_send`, the bridge's `agent_control.aside`) and a report that asks for a turn
(question, blocked, done, review) make a running `bash` or `eval` background itself, so the receiver reads them at its
next step; a progress report or a note never does (the owner, 15 and 18 Nov 2026; Main's d2). If the first breaks, a
message waits up to 60 s behind a shell. If the second breaks, a status line cuts a shell the agent wanted to finish in
the foreground.

Why tests miss it: the stale case needs one order, the urgent report handed over at a step boundary and a quiet one
queued before the next tool batch's first peek. `bridge-agent-mail.test.ts` pins that order once; the model checks
every order of arms, queueing, peeks, boundaries and turn ends.

## In scope

`resources/gui-bridge/agent-control.ts`: `watchAsides` (the peek), `interruptFor`, the `message_end` and `agent_end`
hooks of `install`, and the arm points in `agent_control.mail` and `agent_control.aside`. Stock's side as environment:
the aside queue, a step boundary that drains it whole, `message_end` per handed message, tool batches, turns.

## Out of scope

Stock's own IRC interrupts (the wrapped peek answers stock's yes first, unchanged); what the cooperative signal does to
a tool (stock); main's choice of aside versus prompt (`agentctl/service/messages.rs`).

## Bounds

Up to three urgent and two quiet messages, any number of batches and turns (the state space is finite through the
message sets). Checked on the runner (`formal.yml -f only=urgent-asides`).
