# Properties

- `ReceiptAfterAcceptance`: a successful answer is not delivered before lifecycle acceptance. Source: `dispatch.rs:19-25`, `lifecycle.rs:69-91`.
- `RelaunchAfterJoin`: a relaunch attempt follows the Node join and an accepted exit with a previously requested relaunch. Source: `main.rs:335-358`, `node.rs:106-126`.
- `NoPrematureEOF`: accepted-stop does not itself cause Node's stdin EOF failure while the exit answer is pending. Source: `node.rs:106-126`, `electron/index.ts:26-39`.
- `FailureBeforeAcceptance`: unexpected Node or transport death before acceptance is classified as failure. Source: `lifecycle.rs:93-107`, `main.rs:335-341`.
- `TypeOK` bounds the abstract state and queue.

These are safety properties, not promises of eventual completion. A timeout, process death or transport failure can prevent receipt.
