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
      RETURNING twitch_client_id, twitch_token, twitch_token_expires
    `).bind(owner, started + 120_000, started).first();
    if (!state) return;

    const backoffChanges = new Map();
    // Reserve six calls for the lease, token, history, skipped streams, and webhook backoff.
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
      const myLogin = config.myChannel?.toLowerCase();
      const streamers = await readStreamers(request, config.listUrl).catch((error) => {
        if (!myLogin) throw error;
        console.error({ message: "Streamer list could not be loaded", error: error.message });
        return new Map();
      });
      if (myLogin) streamers.set(myLogin, config.myChannel);
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
      const ownLive = myLogin && [...live.values()].find(({ login }) => login === myLogin);
      const quiet = config.silent && Boolean(ownLive);

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
          continue;
        }
        const { login, startedAt } = live.get(streamId);
        if (login === myLogin) continue;
        const duringCooldown = lastShoutoutAt !== null && startedAt < lastShoutoutAt + config.cooldownMs;
        if (duringCooldown || (quiet && startedAt >= ownLive.startedAt)) {
          skipped.push(streamId);
          live.delete(streamId);
        }
      }
      if (skipped.length) {
        await db.prepare("INSERT INTO skipped_streams (stream_id) SELECT value FROM json_each(?)")
          .bind(JSON.stringify(skipped)).run();
      }
      if (!live.size) return;

      const ownBroadcasts = [];
      const listBroadcasts = [];
      for (const entry of live) {
        (entry[1].login === myLogin ? ownBroadcasts : listBroadcasts).push(entry);
      }
      const deliveries = [];
      if (ownBroadcasts.length) deliveries.push({ route: config.ownRoute, broadcasts: ownBroadcasts });
      if (listBroadcasts.length && !quiet) deliveries.push({ route: config.listRoute, broadcasts: listBroadcasts });
      if (!deliveries.length) return;
      const targets = await Promise.all(deliveries.map(({ route }) => webhookTarget(route.webhookUrl)));
      const { results: backoffs } = await db.prepare(`
        SELECT target, retry_at FROM discord_webhook_backoff WHERE target IN (?, ?)
      `).bind(targets[0], targets[1] ?? null).all();
      const retryTimes = new Map(backoffs.map(({ target, retry_at }) => [target, retry_at]));
      const sentUsers = new Set();
      let deliveryError;
      for (const [index, { route, broadcasts: pending }] of deliveries.entries()) {
        const target = targets[index];
        let retryAt = backoffChanges.get(target) ?? retryTimes.get(target) ?? 0;
        if (retryAt === -1 || retryAt > Date.now() || signal.aborted) continue;
        try {
          const verifyTarget = route.guildId || route.channelId;
          if (operationsLeft < (verifyTarget ? 3 : 2)) {
            throw new Error("Streamer list used too many requests to send a shoutout within the Free plan budget");
          }
          if (verifyTarget) {
            const failedUntil = await verifyWebhook(request, route);
            if (failedUntil !== null) {
              backoffChanges.set(target, failedUntil);
              continue;
            }
          }

          for (const [streamId, { name, userId }] of pending) {
            if (sentUsers.has(userId)) continue;
            if (operationsLeft < 2 || signal.aborted) break;
            const delay = retryAt - Date.now();
            if (delay > 0) {
              if (retryAt >= deadline) break;
              await new Promise((resolve) => setTimeout(resolve, delay));
              if (signal.aborted) break;
            }
            const result = await sendShoutout(request, route, name);
            retryAt = result.retryAt;
            if (retryAt !== (retryTimes.get(target) ?? 0) || backoffChanges.has(target)) {
              backoffChanges.set(target, retryAt);
            }
            if (!result.sent) break;

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
        } catch (error) {
          deliveryError ??= error;
        }
      }
      if (deliveryError) throw deliveryError;
    } finally {
      await db.batch([
        ...Array.from(backoffChanges, ([target, retryAt]) => db.prepare(`
          INSERT INTO discord_webhook_backoff (target, retry_at) VALUES (?, ?)
          ON CONFLICT (target) DO UPDATE SET retry_at = excluded.retry_at
        `).bind(target, retryAt)),
        db.prepare("UPDATE poll_state SET lease_owner = NULL, lease_until = 0 WHERE id = 1 AND lease_owner = ?")
          .bind(owner),
      ]);
    }
  },
};

async function webhookTarget(url) {
  // Persist only a fingerprint of the webhook URL, including its token so rotation clears backoff.
  const path = url.pathname.replace(/^\/api\/(?:v\d+\/)?|\/$/g, "");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(path));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
