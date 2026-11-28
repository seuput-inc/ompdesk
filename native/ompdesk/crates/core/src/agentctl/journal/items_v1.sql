-- Items-only database. The importer creates this schema and marks the import complete in its own transaction.
CREATE TABLE item (
    id TEXT PRIMARY KEY NOT NULL,
    bot TEXT NOT NULL,
    number INTEGER NOT NULL,
    current_json TEXT NOT NULL,
    UNIQUE (bot, number)
) STRICT;

CREATE TABLE item_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item TEXT NOT NULL REFERENCES item(id) ON DELETE CASCADE,
    event_json TEXT NOT NULL
) STRICT;
CREATE INDEX item_history ON item_event(item, id);

-- The result covers the whole request, including skipped items and refusals.
CREATE TABLE item_request (
    id TEXT PRIMARY KEY NOT NULL,
    result_json TEXT NOT NULL
) STRICT;

CREATE TABLE item_mail (
    id TEXT PRIMARY KEY NOT NULL,
    session TEXT NOT NULL,
    mail_json TEXT NOT NULL
) STRICT;
