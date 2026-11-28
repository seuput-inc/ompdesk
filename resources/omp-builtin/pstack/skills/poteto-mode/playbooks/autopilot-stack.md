### Autopilot-stack

> OMPdesk: before step 1, update the plan. Use `todo` `init` only for a fresh plan. If any item is unfinished, `append` only new items, one call per phase. List each user-requested outcome once. Follow playbook steps internally; do not add them as todo items. Use the todo language from `<reply-language>` (word for word without one). Keep skill, tool and file names unchanged. Keep earlier work going unless the user explicitly cancels or replaces it.

Run the Autopilot-full playbook, but do not merge.

1. **In place of step 5, stop at verified.** Stop when each PR is verified and green at its current head, then hand the PRs to the operator. After the handoff, nobody pushes without the operator's go. Every loop tick prompt names this file, so each tick sees the no-merge rule.
2. **Stack a PR only when it builds on another PR.** This is the one exception to step 3. Base the PR on the other PR's branch in place of trunk, per `playbooks/opening-a-pr.md`. In place of step 2's rebase onto trunk, each PR rebases onto its parent PR's branch, and the stack root rebases onto trunk. A new head on the lower PR restacks the PRs above it, and a PR whose `git patch-id` the restack leaves unchanged keeps its verdict.

**Reply:** list each PR with its verdict, in place of what merged.
