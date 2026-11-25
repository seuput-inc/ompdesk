---
name: shell-stream-recovery-verify
description: "Verify CEF stream loss recovery when changing shell ipc readers, scheme resource lifetimes, preload reset tokens or renderer resync acknowledgement."
---

# Shell stream recovery verification

## The promise and the harm

A partially delivered event keeps its remaining bytes, obsolete readers cannot affect their replacement, and a loss token clears only after a successful read for that token. Breaking these rules can corrupt the event stream or leave tabs and approvals stale while the page claims recovery.

## Coverage

The `shell-stream-recovery` record in `formal/manifest.json` is the canonical covered-file list and sync commit. Its model is `formal/shell-stream-recovery/tla/ShellStreamRecovery.tla`. The frozen properties are in `formal/shell-stream-recovery/Properties.md`.

The model follows `Stream.push` and `Stream.fill`, reader capture in the CEF scheme resource, preload `resetStream` and `acknowledge`, and the token captured by `installShellResync` before `resyncPage`. Every action's `@code` tag and the atomic-boundary table in `formal/shell-stream-recovery/CORRESPONDENCE.md` identify the implementation.

A null `syncCommit` means verification has not been accepted. A passing matrix alone does not replace the mutation verdict or source correspondence review.

## Bounds and assumptions

The positive matrix uses one window, two non-reused reader identities, queue capacities one and two, and at most three or four produced events. Capacity one with four events permits another overflow while an earlier reset is partly delivered. Production capacity remains 4096.

The mutex defines each native action. Preload parsing is synchronous. A successful authoritative read is an abstract outcome, not a proof that each store merged correctly. This is a safety model without fairness or a recovery deadline. Quiescence is allowed.

Individual stores, split selection, approvals, drafts, queue merging, permissions, offline-host freshness, Node shutdown and whole-app recovery remain outside this model. Their consumer regressions and actual shell checks are separate requirements.

## Run it

Run the matrix and mutations on the hosted runner through the repository's dispatch entry. Push the branch normally first.

```bash
bun scripts/ci-run.ts formal --ref "$(git branch --show-current)" -f only=shell-stream-recovery -f tier=deep
```

Watch that returned run once with `bun scripts/watch-run.ts RUN_ID`, substituting its actual ID. Local execution is limited to a spec parse check. The repository vendors the pinned checker at `resources/omp-builtin/formal/skills/ompdesk-formal-verify`; read `skill://ompdesk-formal-verify` for its result schema.

`PASS` covers only these bounds. `FAIL` includes violated invariants, missed or uncovered mutations, invalid anchors and unresolved `@code` tags. `DRIFT` means covered code differs from the sync commit and needs correspondence review. Exit 3 is unavailable, not a pass.

## Does the change touch this?

Recheck changes to queue eviction, partial frame or reset offsets, ordered reset placement, captured reader identity, waiter removal, reset-token generation or acknowledgement, and read success before ACK. Include new callers that mutate those fields.

## Judge a counterexample

Map each trace action to its tagged source step. If that order cannot occur in the implementation, correct the model and record the mismatch. Otherwise reproduce the order on unchanged production code with a deterministic consumer regression before calling it a product bug. Preserve failed runs. Keep frozen properties and bounds unless an explicitly recorded contract change requires otherwise.

## Update and stamp

Update the model and correspondence from actual mutex and await boundaries. Keep the matrix's existing positive and negative runs. Add a mutation for each new guard and require every configured invariant to be covered, including `TypeOK`.

After source review and a passing matrix plus mutations, dispatch the same command with `-f stamp=true`. The workflow refuses a failed check and writes the accepted source commit to the manifest on that branch. Integrate that exact manifest change. Never move `syncCommit` for a failed, unavailable or unexecuted candidate, and never treat a stamp as whole-app proof.
