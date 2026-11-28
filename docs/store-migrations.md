# Migrating a host store

A store owns its database, writer lock and recovery. Do not put unrelated stores in that database. The items database (`items.sqlite3`) needs transactions because one owner request can change several items and owe one notice per chat. It was not chosen for faster queries: the file-layout comparison used an in-memory index for paging, and its startup time was estimated.

1. Parse the original as a whole. A file not found on first use is different from an unreadable file, a short read, malformed data or conflicting identities. Stop on the latter; never skip a row to complete an import.
2. Apply schema versions in order. Import current state, full history and legacy request identities, and record the completed schema version in the same transaction. Expose neither rows nor a success result before commit. Keep the original untouched as recovery input.
3. After migration, open the committed database or report an error. A zero-filled, truncated, unsupported or corrupt database is not an empty store. Do not overwrite it or automatically restore the legacy file: it cannot contain post-migration writes. There is no in-place downgrade. For manual recovery, stop all writers and preserve the original, the database and any SQLite journal files together before restoring a known good backup.
4. Commit item changes, the request outcome and each chat's mail intent together. Deliver after commit. Keep the intent until the intended session confirms that the mail ID is in its flushed journal. Retrying a request reads its committed outcome; retrying delivery uses the same mail ID. These are separate acknowledgements.

The items host uses SQLite's `DELETE` rollback journal with `synchronous=EXTRA`. In addition to syncing the transaction, this asks SQLite to sync the parent directory after removing the journal. `fullfsync=ON` requests the stronger flush on macOS. These settings depend on the filesystem and hardware honoring flushes. A failed commit changes neither the v1 cache nor the outbox; the caller sees the failure. The host does not send mail on the assumption that a later write will succeed.

On open, the host checks the schema and version, file length against SQLite's page count, integrity and foreign keys. It does not treat zeros in unused page space as evidence of damage. A receiver running an older bridge cannot acknowledge item mail: the host keeps the original ID pending until a capable receiver flushes the intended chat.

For items, `items.sqlite3.committed` remains beside the database so that a missing database cannot be mistaken for first use. Back up that file too. A migration failure prevents the agent-control service from opening; it is not a successful startup with an empty Items tab.

The v1 API is a read projection: seven days of closed items and up to fifty events per visible item. It is not a retention rule. Data already deleted by an older host cannot be reconstructed during import.

Item readers opt in to protocol 2 with `itemsFeed`. A missing or obsolete cursor gets an open-item seed; a matching base gets changed summaries, removed IDs and affected bots' absolute counts. Do not put summaries into a v1 `items` array. `itemsPage` reads one bot's closed items in descending activity-time/number order, 50 at a time. `itemDetail` pages through events in append order using an event ID as the cursor. `itemReceipt` is scoped to the host, bot, item, request and optionally question. An `unknown` receipt is not proof that a write failed.

A previous paired host can serve only its retained history. Its projected replies carry `legacy: true`; only an explicit unknown-method response permits this fallback. Disconnects and malformed replies are errors, not an empty archive.
