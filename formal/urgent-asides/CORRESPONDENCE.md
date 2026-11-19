# Correspondence

| Model action | Code |
|---|---|
| `Arm(m)` | `interruptFor` (agent-control.ts), from `agent_control.mail` before `sendMessage` and from `agent_control.aside` in `onPromptAdmitted` |
| `Enqueue(m)` | stock `IrcBridge.queueAside` (via `pi.sendMessage` deliverAs aside, or `AgentSession.prompt` streamingBehavior aside) |
| `Peek` | the `peek` `watchAsides` puts in `Agent.hasIrcInterrupts`, polled by stock `executeToolCalls` every 250 ms |
| `Drain` | stock's aside provider at a step boundary (`setAsideMessageProvider`, `IrcBridge.drainPending`) |
| `HandOver(m)` | stock's `message_end` for the injected message; the bridge's `message_end` hook deletes its key |
| `TurnEnd` | the main agent's `agent_end`; the bridge's hook clears every mark |
| `ChildMessageEnd(m)` / `ChildTurnEnd` | a subagent's `message_end` / `agent_end`: index.ts installs the area hooks again on each subagent's `pi`, and the hooks return for `ctx.agent.kind !== "main"` |
| `BatchStart` / `BatchEnd` / `TurnStart` | stock agent loop (environment) |

## Assumptions

- **A1** A message stays pending from its arm until its `message_end`: a peek while the boundary is still emitting
  `message_end`s (none runs then: tool batches start after the model request) would answer for a message the model
  has not got yet, which P1 allows. The model lets a batch start only after them (`BatchStart` needs `handing = {}`).
- **A2** A message from another session is armed in `onPromptAdmitted`, synchronously after `queueAside`; the model lets
  any arm precede its enqueue, which covers both orders.
- **A3** The key of a message (`mail:<id>`, `aside:<text>`) is the key its `message_end` yields. Two asides with the same
  text share one mark: the first handover takes it down and the second is read as a plain aside (not modelled).
- **A4** An aside armed but dropped by stock (session switched before it was queued) loses its mark at `agent_end`.
