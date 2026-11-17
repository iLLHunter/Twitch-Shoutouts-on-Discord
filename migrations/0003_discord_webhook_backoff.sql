CREATE TABLE discord_webhook_backoff (
    target TEXT PRIMARY KEY,
    retry_at INTEGER NOT NULL
) WITHOUT ROWID;

INSERT INTO discord_webhook_backoff (target, retry_at)
SELECT discord_target, discord_retry_at
FROM poll_state
WHERE discord_target IS NOT NULL AND discord_retry_at <> 0;
