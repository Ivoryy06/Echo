CREATE TABLE IF NOT EXISTS entries (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at   REAL    NOT NULL,
    body         TEXT    NOT NULL,
    emotion      TEXT,
    mirror_mode  TEXT    NOT NULL DEFAULT 'rewrite',
    mirror       TEXT,
    tags         TEXT    DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS summaries (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at   REAL    NOT NULL,
    entry_range  TEXT    NOT NULL,
    content      TEXT    NOT NULL
);
