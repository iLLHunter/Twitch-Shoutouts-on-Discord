CREATE TABLE streamer_shoutouts (
    user_id TEXT PRIMARY KEY,
    last_shoutout_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE skipped_streams (
    stream_id TEXT PRIMARY KEY
) WITHOUT ROWID;
