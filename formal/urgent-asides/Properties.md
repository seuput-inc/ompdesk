# Properties (frozen)

- **P1 `QuietNeverInterrupts`**: the peek says yes only while an urgent message of ours is armed and not yet handed to
  the model. Source: Main's d2 ("progress/note stay non-interrupting"), the advisory of 19 Nov 2026 (stale mark).
- **P2 `UrgentInterrupts`**: during a tool batch, while an armed urgent message waits in stock's aside queue, the peek
  says yes. Source: the owner, 11/14/18 Nov 2026 ("타임아웃 명령어 걸어두고 있으면 내 메세지가 대기열에 들어간다고").

Sanity: `NeverAnswers` must fail (`MC_sanity.cfg`).
