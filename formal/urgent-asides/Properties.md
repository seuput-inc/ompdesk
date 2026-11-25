# Properties (frozen)

- **P1 `QuietNeverInterrupts`**: the peek says yes only while an urgent message of ours is armed and not yet handed to
  the model. Source: Main's d2 ("progress/note stay non-interrupting"), the advisory of 19 Nov 2026 (stale mark).
- **P2 `UrgentInterrupts`**: during a tool batch, while an urgent message of ours waits in stock's aside queue, the
  peek says yes, unless its mark went with an earlier main turn's end (A4). Source: the owner, 11/14/18 Nov 2026
  ("타임아웃 명령어 걸어두고 있으면 내 메세지가 대기열에 들어간다고"). Model change, 19 Nov 2026: the first form read
  `queue ∩ marks`, so a mark taken down too early (a subagent's `agent_end`) made it hold vacuously; this form
  names the messages, and only a main turn's end may drop a mark.

Sanity: `NeverAnswers` must fail (`MC_sanity.cfg`).
