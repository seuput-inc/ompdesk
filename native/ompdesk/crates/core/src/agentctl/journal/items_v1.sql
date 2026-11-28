-- Both header fields commit with the imported rows. OITM, schema v1.
PRAGMA application_id = 0x4f49544d;
PRAGMA user_version = 1;
CREATE TABLE item (
    ordinal INTEGER PRIMARY KEY,
    id TEXT UNIQUE NOT NULL CHECK(length(trim(id)) > 0),
    bot TEXT NOT NULL CHECK(length(trim(bot)) > 0),
    number INTEGER NOT NULL CHECK(number BETWEEN 1 AND 4294967295),
    current_json TEXT NOT NULL CHECK(json_valid(current_json)
        AND json_extract(current_json, '$.id') IS id
        AND json_extract(current_json, '$.bot') IS bot
        AND json_extract(current_json, '$.number') IS number
        AND json_array_length(current_json, '$.events') IS 0),
    UNIQUE (bot, number)
) STRICT;

CREATE TABLE item_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item TEXT NOT NULL REFERENCES item(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK(position >= 0),
    event_json TEXT NOT NULL CHECK(json_valid(event_json)
        AND json_extract(event_json, '$.id') IS id AND id > 0),
    request TEXT GENERATED ALWAYS AS (json_extract(event_json, '$.request')) VIRTUAL
) STRICT;
CREATE UNIQUE INDEX item_history ON item_event(item, position);
CREATE INDEX item_legacy_request ON item_event(item, request) WHERE request IS NOT NULL;

-- The result covers the whole request, including skipped items and refusals.
CREATE TABLE item_request (
    id TEXT PRIMARY KEY NOT NULL,
    result_json TEXT NOT NULL CHECK(json_valid(result_json)
        AND json_type(result_json, '$.ids') IS 'array'
        AND json_type(result_json, '$.changed') IS 'array'
        AND json_type(result_json, '$.refused') IN ('null', 'text')
        AND json_type(result_json, '$.refused') IS NOT NULL)
) STRICT;

CREATE TABLE item_board (
    bot TEXT PRIMARY KEY NOT NULL CHECK(length(trim(bot)) > 0),
    last_issued INTEGER NOT NULL CHECK(last_issued BETWEEN 0 AND 4294967295)
) STRICT;

CREATE TABLE item_mail (
    id TEXT PRIMARY KEY NOT NULL,
    session TEXT NOT NULL,
    mail_json TEXT NOT NULL CHECK(json_valid(mail_json) AND json_extract(mail_json, '$.id') IS id)
) STRICT;
