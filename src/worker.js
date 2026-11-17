import {
  getLiveStreams,
  getTwitchToken,
  readConfig,
  readStreamers,
  sendShoutout,
  verifyWebhook,
} from "./services.js";

export default {
  async scheduled(_controller, env) {
    const config = readConfig(env);
    const db = env.DB;
    const owner = crypto.randomUUID();
    const started = Date.now();
    const deadline = started + 50_000;
    const signal = AbortSignal.timeout(deadline - started);
    const state = await db.prepare(`
      UPDATE poll_state
      SET lease_owner = ?, lease_until = ?
      WHERE id = 1 AND lease_until <= ?
      RETURNING twitch_client_id, twitch_token, twitch_token_expires, discord_target, discord_retry_at
    `).bind(owner, started + 120_000, started).first();
    if (!state) return;

    let { discord_target: discordTarget, discord_retry_at: discordRetryAt } = state;
    // Reserve space under the Free plan's 50 subrequest limit for poll state and cooldown checks.
    let operationsLeft = 44;
    const request = async (url, options, service) => {
      if (operationsLeft === 0) throw new Error("Polling exceeded its Free plan subrequest budget");
      operationsLeft--;
      try {
        return await fetch(url, { ...options, redirect: "manual", signal });
      } catch {
        throw new Error(`${service} request failed or timed out`);
      }
    };

    try {
      const streamers = await readStreamers(request, config.listUrl);
      if (!streamers.size) return;

      const renewToken = async () => {
        const { token, expires } = await getTwitchToken(request, config);
        await db.prepare(`
          UPDATE poll_state SET twitch_client_id = ?, twitch_token = ?, twitch_token_expires = ?
          WHERE id = 1 AND lease_owner = ?
        `).bind(config.clientId, token, expires, owner).run();
        return token;
      };
      const cachedToken = state.twitch_client_id === config.clientId &&
        state.twitch_token_expires > Date.now() + 60_000 && state.twitch_token;
      const live = await getLiveStreams(
        request, config.clientId, cachedToken || await renewToken(), streamers,
        cachedToken ? renewToken : undefined,
      );
      if (!live.size) return;

      const broadcasts = Array.from(live, ([streamId, { userId }]) => [streamId, userId]);
      const { results: history } = await db.prepare(`
        WITH broadcasts AS (
          SELECT json_extract(value, '$[0]') AS stream_id, json_extract(value, '$[1]') AS user_id
          FROM json_each(?)
        )
        SELECT broadcasts.stream_id, previous.last_shoutout_at,
          (announced.stream_id IS NOT NULL OR skipped.stream_id IS NOT NULL) AS handled
        FROM broadcasts
        LEFT JOIN announced_streams AS announced ON announced.stream_id = broadcasts.stream_id
        LEFT JOIN skipped_streams AS skipped ON skipped.stream_id = broadcasts.stream_id
        LEFT JOIN streamer_shoutouts AS previous ON previous.user_id = broadcasts.user_id
      `).bind(JSON.stringify(broadcasts)).all();
      const skipped = [];
      for (const { stream_id: streamId, last_shoutout_at: lastShoutoutAt, handled } of history) {
        if (handled) {
          live.delete(streamId);
        } else if (lastShoutoutAt !== null && live.get(streamId).startedAt < lastShoutoutAt + config.cooldownMs) {
          skipped.push(streamId);
          live.delete(streamId);
        }
      }
      if (skipped.length) {
        await db.prepare("INSERT INTO skipped_streams (stream_id) SELECT value FROM json_each(?)")
          .bind(JSON.stringify(skipped)).run();
      }
      if (!live.size) return;

      // Track Discord backoff for this exact webhook without persisting its URL or token.
      const path = config.webhookUrl.pathname.replace(/^\/api\/(?:v\d+\/)?|\/$/g, "");
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(path));
      const target = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      if (target !== discordTarget) {
        discordTarget = target;
        discordRetryAt = 0;
      }
      if (discordRetryAt === -1 || discordRetryAt > Date.now()) return;

      const verifyTarget = config.guildId || config.channelId;
      if (operationsLeft < (verifyTarget ? 3 : 2)) {
        throw new Error("Streamer list used too many requests to send a shoutout within the Free plan budget");
      }
      if (verifyTarget) {
        const retryAt = await verifyWebhook(request, config);
        if (retryAt !== null) {
          discordRetryAt = retryAt;
          return;
        }
      }

      const sentUsers = new Set();
      for (const [streamId, { name, userId }] of live) {
        if (sentUsers.has(userId)) continue;
        if (operationsLeft < 2 || signal.aborted) break;
        const delay = discordRetryAt - Date.now();
        if (delay > 0) {
          if (discordRetryAt >= deadline) break;
          await new Promise((resolve) => setTimeout(resolve, delay));
          if (signal.aborted) break;
        }
        const { sent, retryAt } = await sendShoutout(request, config, name);
        discordRetryAt = retryAt;
        if (!sent) break;

        operationsLeft--;
        await db.batch([
          db.prepare("INSERT INTO announced_streams (stream_id) VALUES (?)").bind(streamId),
          db.prepare(`
            INSERT INTO streamer_shoutouts (user_id, last_shoutout_at) VALUES (?, ?)
            ON CONFLICT (user_id) DO UPDATE SET last_shoutout_at = excluded.last_shoutout_at
          `).bind(userId, Date.now()),
        ]);
        sentUsers.add(userId);
        console.log({ message: "Sent Twitch shoutout", streamer: name, streamId });
      }
    } finally {
      await db.prepare(`
        UPDATE poll_state
        SET lease_owner = NULL, lease_until = 0, discord_target = ?, discord_retry_at = ?
        WHERE id = 1 AND lease_owner = ?
      `).bind(discordTarget, discordRetryAt, owner).run();
    }
  },
};
