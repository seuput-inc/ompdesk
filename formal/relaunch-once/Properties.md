# Properties (frozen)

- **P1 `AtMostOnce`**: a command's effect happens at most once, whatever stops or kills the omp. Source: the owner's goal, 20 Nov 2026 ("a relaunch never cuts or repeats an agent's work"; seen: the same empty commit made twice when a turn resumed).
- **P2 `ShortCommandNotCut`**: a stop never cuts a command that ends within the stop's wait. Source: the same goal (B1: "a running command is not cut by a relaunch").

Sanity: `NeverEffect` must be violated (an effect is reachable).
