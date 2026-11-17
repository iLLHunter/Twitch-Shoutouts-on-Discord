CREATE TABLE poll_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    lease_owner TEXT,
    lease_until INTEGER NOT NULL DEFAULT 0,
    twitch_client_id TEXT,
    twitch_token TEXT,
    twitch_token_expires INTEGER,
    discord_target TEXT,
    discord_retry_at INTEGER NOT NULL DEFAULT 0
);

INSERT INTO poll_state (id) VALUES (1);

CREATE TABLE announced_streams (
    stream_id TEXT PRIMARY KEY
) WITHOUT ROWID;
