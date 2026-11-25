-- A synced conclusion receives the same prepared MATCH expression as a native
-- observation, including V100's {title title_parts} and {body body_parts}.
-- Keep the source rows, store identity and peer cursors unchanged.
ALTER TABLE synced_conclusions ADD COLUMN title_parts TEXT
    GENERATED ALWAYS AS (replace(replace(title, '-', ' '), '_', ' ')) VIRTUAL;
ALTER TABLE synced_conclusions ADD COLUMN body_parts TEXT
    GENERATED ALWAYS AS (replace(replace(body, '-', ' '), '_', ' ')) VIRTUAL;

DROP TRIGGER synced_conclusions_fts_ai;
DROP TRIGGER synced_conclusions_fts_ad;
DROP TABLE synced_conclusions_fts;

CREATE VIRTUAL TABLE synced_conclusions_fts USING fts5(
    title, body, title_parts, body_parts,
    content='synced_conclusions', content_rowid='id',
    tokenize="unicode61 remove_diacritics 2 tokenchars '_-'"
);

CREATE TRIGGER synced_conclusions_fts_ai AFTER INSERT ON synced_conclusions BEGIN
    INSERT INTO synced_conclusions_fts(rowid, title, body, title_parts, body_parts)
        VALUES (new.id, new.title, new.body, new.title_parts, new.body_parts);
END;
CREATE TRIGGER synced_conclusions_fts_ad AFTER DELETE ON synced_conclusions BEGIN
    INSERT INTO synced_conclusions_fts(synced_conclusions_fts, rowid, title, body, title_parts, body_parts)
        VALUES ('delete', old.id, old.title, old.body, old.title_parts, old.body_parts);
END;

INSERT INTO synced_conclusions_fts(synced_conclusions_fts) VALUES('rebuild');
