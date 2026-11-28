# WSL session host contract

This is the contract for moving a Windows tab's omp into a WSL 2 distribution. Accepting a paired WSL UNC folder and allowing checker-owned temporary output do not switch the execution host.

## What crosses the boundary

The Windows core owns host selection, the registered distribution ID, the project assignment and the session key. The guest receives opaque tab, spawn and conversation IDs, the assigned guest project and bridge paths, the minimum omp version, and stock RPC. The Windows process environment, account credentials, Windows copy path, and arbitrary paths or commands are not part of the launch request. A distribution name in a UNC path identifies a candidate; it is not proof of the registered distribution's identity or version.

Windows resolves the WSL 2 registration and opens the system `wsl.exe --distribution-id <guid>` over stdio. This avoids reopening a different installation that reuses the same display name. A guest supervisor starts stock omp from an installed package, not from the project. The supervisor uses a Linux filesystem for the tab's scratch and temporary directory. A second stdio connection reaches the bridge through the spawn's Unix socket in a `0700` directory. No Windows named pipe or TCP listener is exported. Receiving a bridge connection is distinct from starting the process and from having an account that can answer a prompt.

A `host_tool_call` is a request, not a grant. The receiving host binds the request to the tab, live spawn, and grants for that execution host. A guest cannot select a different tab, pass a Windows environment, or turn a guest path into an arbitrary host file. The same rule applies to unsolicited bridge events. A `0700` directory excludes other users, not other processes of the guest user. WSL drive mounts and Windows interop are not an isolation boundary for account credentials.

## The original stays inside the distribution

Windows creates the conversation key and records its parent, registered distribution and project. The guest gets the opaque key, never the path of the Windows copy. Guest stock keeps its original in a private directory on persistent Linux storage. Only the guest supervisor resolves the basename that stock reports. Neither that name nor a cwd or parent in a guest-written header selects a Windows path.

The Windows copy is read-only to viewers. Only the Windows host writes it. `sidecar/lane.rs` must return the host's key both to its observer of `get_state` and to the RPC caller. `src/main/tab-spawn.ts` must reopen by the host's record of the key, parent and project, not by the guest journal header. The host must never launch Windows stock on a viewer's copy. Existing Windows files, keys and parent relationships do not change.

### Windows-side identity

`ompdesk-wsl:<key>` is a session reference, not a file, URI to open, or command argument. The spelling after the reserved prefix must be exactly 32 lowercase hex digits. Unknown or malformed references fail closed; neither a missing registration nor a disconnected distro is a new conversation. An ordinary Windows session continues to use its original path. New tabs do not select WSL from their cwd.

Only a Windows-created registration supplies the visible reference, workspace and opening parent. `Registration.cwd` is the Windows spelling used by project filters (including a registered WSL UNC folder), not the `cwd` in the guest journal. `Registration.parent` names the host opening session, not a stock fork. For an admitted guest spawn the stock ID is private binding evidence; list rows and outward session identity use the host reference, so even identical stock IDs from different distros cannot collapse rows. The guest file reported by `get_state` must name a direct child of the assigned guest session directory. It is never opened on Windows. If no admitted guest transport exists, the host keeps the reference and refuses direct execution; it never passes the reference or a copy slot to Windows stock.

### What a viewer sees

A connected viewer receives live turn events. The saved transcript shows the last **verified** copy. It can lag behind the live view for a whole turn and for the time it takes to copy that turn's journal. An offline viewer sees the verified transcript and its checkpoint time, not a claim that it contains everything the guest wrote. Before the first checkpoint it sees the assigned tab with an unsynced transcript, not a new empty conversation.

### Publish one checkpoint

1. At a completed turn or orderly close, the host requests a checkpoint bound to the registered distribution, session key and admitted spawn. A request never names an arbitrary file. The guest captures a complete JSONL prefix from one open regular file, including stock's mutable title slot. Bytes after the final complete record wait for the next checkpoint.
2. For the first implementation, stream the snapshot in bounded chunks. The guest reports its byte length and SHA-256. Before accepting it, verify the captured bytes against a fresh read of the same prefix of the guest original. A replaced file, changed prefix, or different stock session ID invalidates the attempt. The host computes its own digest and checks the length, digest and assigned session identity before publication. Agreement verifies the copy against the reported original, not that a guest telling lies is trustworthy.
3. The host writes an immutable version in its own non-guest-writable store. After the version is durable, it atomically commits the journal entry that points the existing key to that version. A retry of the same digest changes nothing. A stale spawn cannot publish. A crash before the commit leaves the previous version visible. Guest bytes are transcript data, never Windows paths, host tool grants or host-side commands.

The guest reads a checkpoint three times: capture, send, then verify the prefix. Only one copy crosses the wire. Windows holds at most three journal bodies per key: the verified version, one pinned interrupted span, and the next candidate. Coalesce checkpoint requests; do not copy per token. An append-only shortcut misses in-place title changes. Offline inspection of content-addressed attachments requires a separately verified blob copy; never resolve a guest-supplied attachment path on Windows.

If the distribution stops mid-turn, leave the prior verified version in place and mark the turn interrupted. Bytes seen live after that checkpoint are not saved on Windows until verified. On reconnect, reconcile the old service, reopen the same guest original, and request another checkpoint. A missing or changed original is a visible recovery failure. Never replace it with the Windows copy, create another key, or start the same conversation on a second host.

### Checkpoint wire, version 1

Launch takes `sessionKey` (32 lowercase hex digits), not a `sessionDir`. The guest resolves it beneath its private, persistent `$HOME/.ompdesk-sessions/`. A fresh launch creates a new key directory exclusively. Resume opens an existing directory and a single regular, owned `.jsonl` file there. A missing original is not a fresh launch.

The Windows receiver selects the bound distribution, key, spawn and stock session ID **before** starting the checkpoint subprocess. Its stdout consists of one LF-terminated UTF-8 JSON header `{"v":1,"sessionKey":"…","spawnId":"…","stockId":"…","bytes":123,"source":"dev:ino"}`, exactly `bytes` of complete original JSONL records, and one LF-terminated JSON seal `{"sha256":"…"}` followed by successful process exit. `source` is two decimal Linux device/inode numbers separated by `:`; it is diagnostic identity, never a path. The header and seal are each limited to 4 KiB. The guest opens one private regular file without following links. It seals only after rereading that prefix from the still-named original, checking length, identity and SHA-256. An append after the cut waits for the next snapshot; a rewrite during transfer invalidates it.

Windows owns the directory and generates the key. It verifies the bound IDs, the stock session header (`type: "session"` and `id`, optionally preceded by one padded `type: "title"` record), the complete records, the byte count, digest, seal, EOF and guest exit. The last verified position is the byte offset, digest and source identity of that snapshot. An unchanged prefix with the same identity is an append; a changed prefix, shorter snapshot or changed identity is a replacement, never an appended suffix. Both require verification of the full snapshot, including title padding, and the same stock session ID.

Version 1 refuses snapshots larger than 512 MiB, a session header (including its optional title slot) beyond the first 64 KiB, stock IDs over 128 UTF-8 bytes, and individual JSONL records over 32 MiB including LF. Refusal never advances the verified position. On durable read, the host checks the pinned file's length and SHA-256 before returning it. A verified retransmission can repair a damaged host copy without changing the key or treating the damage as a guest-side replacement.

Registration precedes stock's allocation of a session ID. After starting the assigned spawn, the host binds the ID from that session's state; a later admission must observe the same ID. A checkpoint cannot bind itself. Before starting a tracked turn the host requires a verified baseline, even for a new key, and persists that position. If no journal exists yet there is no baseline, not a verified empty file. Only a host-observed completion entry matched to a unique new assistant record after the unchanged baseline can resolve the turn. A live event, title rewrite, unchanged snapshot or recovery of transfer bytes alone cannot.

A received but unsealed byte span stays in a separate host file with its baseline checkpoint; it is not a transcript. After disconnect, reopen the original for the same key and compare the pending span with the next verified snapshot. Remove the pending span only if its bytes match that snapshot's prefix. A divergent span remains available as interrupted evidence, not as a verified turn. Live RPC events are not journal bytes and cannot complete or authenticate a span. This interface is not exposed to guest RPC, and no ordinary Windows session is registered in this store.

The interruption marker precedes the turn, so it survives even when no journal bytes arrived. On receiver failure the host retains received bytes separately; a power loss can leave only those the filesystem persisted. Reconciliation pins one outstanding span per key, never overwrites it with a later failed attempt, and cannot start another tracked turn while evidence remains unresolved.

The copy protocol does not isolate Windows storage by itself. The tested Ubuntu distribution exposes Windows drives and Windows interop. The execution switch must not rely on secrecy of the host copy's path, a guest-side path check, or the guest user's cooperation to protect the host store and credentials. If host-enforced isolation is unavailable, keep direct Windows execution.

## Who proves the guest stopped

On Windows with Ubuntu WSL 2, ending the Win32 launcher left its transient user service active. Stopping that exact service through the guest manager left the second test service running. A Win32 exit status or dropped bridge therefore cannot release ownership of a guest session.

The supervisor must identify the exact launch, stop its process group through the guest service manager, and confirm the unit and its descendants no longer run. A failed query, an unavailable manager, or a stop racing a start that the guest has not yet accepted is not that confirmation. After a host restart, reconcile the recorded spawn before reusing its session. If ownership is uncertain, keep the existing assignment and report one reason instead of opening an empty or concurrent tab.

## Accounts and fallback

Until a host-side model relay is verified, only a guest with working guest authentication is eligible. A fresh guest, unsupported omp, or failed preflight leaves a new tab on direct Windows execution with a one-line reason. Do not copy Windows credentials to the guest or prompt for a second sign-in. A relay must authorize only the current spawn's model request on its assigned account and attribute usage to that account. Socket permissions alone do not establish which same-user process made the request.

## Evidence still required

A guest protocol probe does not prove the packaged app selects that host. The execution test requires a genuine agent turn that runs a synthetic project's checker on a Linux filesystem. The checker rejects DrvFS and creates and removes its own work directory. No customer repository is used. The installed-build flows for fresh and existing Windows users, including installation, administrator approval, restart, resume, and preservation of session identity, remain unverified until tested on a separate VM.
