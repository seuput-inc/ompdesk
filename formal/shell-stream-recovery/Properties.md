# Frozen stream recovery properties

These properties come from the first-shell transport and recovery contract, before model execution. They are safety properties, not a promise that an offline host becomes available.

| Property | Consumer promise | Source |
|---|---|---|
| `NoPartialFrameLoss` | Once a frame has begun delivery, bounded queue eviction cannot remove its remaining bytes. | `ipc.rs` `Stream.push`/`Stream.fill`; `ipc_stream.rs` partial-frame regression. |
| `NoStaleReaderEffect` | An old CEF resource cannot drain the replacement reader's bytes or remove its parked wake. | `ipc.rs` `open_reader`, `pull`, `read_or_park`, `reader_gone`; `scheme.rs` captured reader. |
| `NoUnsignalledLoss` | The latest evicted event remains covered by an ordered reset, a pending loss token, or a successful authoritative read acknowledged for that token. | `ipc.rs` ordered reset; preload `resetStream`; `installShellResync`. |
| `CurrentReadBeforeAck` | A loss token is cleared only after a successful read begun for that exact current token. | preload `acknowledge`; `installShellResync` captured token and `resyncPage` outcomes. |

Do not weaken these definitions, constrain states, or add fairness to make an execution pass. Record a changed contract explicitly. An old reader, omitted reset, dropped partial frame, early ACK and obsolete-token ACK are required negative cases.
