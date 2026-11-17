const TWITCH_BATCH_SIZE = 100;
const MAX_LIST_BYTES = 128 * 1024;
const MAX_EMBED_LENGTH = 4096;

export function readConfig(env) {
  const listUrl = httpUrl(env.STREAMERS_URL, "STREAMERS_URL");
  const webhookUrl = httpUrl(env.DISCORD_WEBHOOK_URL, "DISCORD_WEBHOOK_URL");
  if (
    webhookUrl.origin !== "https://discord.com" ||
    !/^\/api\/(?:v\d+\/)?webhooks\/\d+\/[A-Za-z0-9_.-]+\/?$/.test(webhookUrl.pathname) ||
    webhookUrl.search || webhookUrl.hash
  ) {
    throw new Error("DISCORD_WEBHOOK_URL must be the URL copied from a Discord channel webhook");
  }
  const clientId = env.TWITCH_CLIENT_ID?.trim();
  const clientSecret = env.TWITCH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error("Set TWITCH_CLIENT_ID and the TWITCH_CLIENT_SECRET secret");
  }
  const guildId = env.DISCORD_GUILD_ID?.trim();
  const channelId = env.DISCORD_CHANNEL_ID?.trim();
  if ((guildId && !/^\d+$/.test(guildId)) || (channelId && !/^\d+$/.test(channelId))) {
    throw new Error("DISCORD_GUILD_ID and DISCORD_CHANNEL_ID must be Discord IDs stored as text");
  }
  const template = env.EMBED_MESSAGE ?? "Hey check out {name}! They are live at {url}";
  if (!template.trim() || template.trim().length > MAX_EMBED_LENGTH) {
    throw new Error("EMBED_MESSAGE must contain 1–4096 characters");
  }
  const cooldownHours = String(env.SHOUTOUT_COOLDOWN_HOURS ?? "4").trim();
  if (!/^(?:[1-9]|1[0-9]|2[0-4])$/.test(cooldownHours)) {
    throw new Error("SHOUTOUT_COOLDOWN_HOURS must be a whole number from 1 to 24");
  }
  const cooldownMs = Number(cooldownHours) * 60 * 60 * 1000;
  return { listUrl, webhookUrl, clientId, clientSecret, guildId, channelId, template, cooldownMs };
}

function httpUrl(value, setting) {
  if (!value || !URL.canParse(value)) {
    throw new Error(`${setting} must be an absolute HTTP or HTTPS URL`);
  }
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new Error(`${setting} must be a public HTTP or HTTPS URL without credentials`);
  }
  return url;
}

export async function readStreamers(request, initialUrl) {
  let url = initialUrl;
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await request(url, { cache: "no-store" }, "Streamer list");
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("Location");
      if (!location || redirects === 5 || !URL.canParse(location, url)) {
        throw new Error("Streamer list has an invalid or excessive redirect chain");
      }
      url = httpUrl(new URL(location, url).href, "Streamer list redirect");
      continue;
    }
    await requireSuccess(response, "Streamer list");
    const streamers = new Map();
    let invalid = 0;
    for (const line of (await readListText(response)).split(/\r\n|\n|\r/)) {
      const name = line.trim();
      if (!name) continue;
      if (!/^[A-Za-z0-9_]{1,25}$/.test(name)) {
        invalid++;
        continue;
      }
      const login = name.toLowerCase();
      if (!streamers.has(login)) streamers.set(login, name);
    }
    if (invalid) console.warn({ message: "Ignored invalid Twitch logins in the streamer list", invalid });
    return streamers;
  }
}

async function readListText(response) {
  if (Number(response.headers.get("Content-Length")) > MAX_LIST_BYTES) {
    await response.body?.cancel();
    throw new Error("Streamer list exceeds 128 KiB");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > MAX_LIST_BYTES) {
        await reader.cancel();
        throw new Error("Streamer list exceeds 128 KiB");
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

export async function getTwitchToken(request, { clientId, clientSecret }) {
  const response = await request("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
    }),
  }, "Twitch token");
  await requireSuccess(response, "Twitch token");
  const { access_token: token, expires_in: expiresIn } = await response.json();
  if (typeof token !== "string" || !token || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error("Twitch did not return a valid app access token");
  }
  return { token, expires: Date.now() + expiresIn * 1000 };
}

export async function getLiveStreams(request, clientId, token, streamers, renewToken) {
  const logins = [...streamers.keys()];
  const live = new Map();
  for (let offset = 0; offset < logins.length; offset += TWITCH_BATCH_SIZE) {
    const url = new URL("https://api.twitch.tv/helix/streams?first=100");
    for (const login of logins.slice(offset, offset + TWITCH_BATCH_SIZE)) {
      url.searchParams.append("user_login", login);
    }
    const fetchStreams = () => request(url, {
      headers: { "Client-Id": clientId, Authorization: `Bearer ${token}` },
    }, "Twitch streams");
    let response = await fetchStreams();
    if (response.status === 401 && renewToken) {
      await response.body?.cancel();
      token = await renewToken();
      renewToken = undefined;
      response = await fetchStreams();
    }
    await requireSuccess(response, "Twitch streams");
    const { data } = await response.json();
    if (!Array.isArray(data)) throw new Error("Twitch returned an invalid streams response");
    for (const stream of data) {
      if (stream.type !== "live" || typeof stream.id !== "string" || !stream.id) continue;
      const userId = stream.user_id;
      const startedAt = Date.parse(stream.started_at);
      if (typeof userId !== "string" || !userId || !Number.isFinite(startedAt)) continue;
      const name = streamers.get(stream.user_login?.toLowerCase());
      if (name) live.set(stream.id, { name, userId, startedAt });
    }
  }
  return live;
}

export async function verifyWebhook(request, config) {
  const response = await request(config.webhookUrl, {}, "Discord webhook lookup");
  const result = await discordStatus(response, "Discord webhook lookup");
  if (result !== null) return result;
  const target = await response.json();
  if (
    (config.guildId && target.guild_id !== config.guildId) ||
    (config.channelId && target.channel_id !== config.channelId)
  ) {
    throw new Error("Discord webhook does not match the configured server or channel ID");
  }
  return null;
}

export async function sendShoutout(request, config, name) {
  const streamUrl = `https://twitch.tv/${name}`;
  const description = config.template.replace(/\{(name|url)\}/g, (_, field) => (
    field === "name" ? name : streamUrl
  )).trim();
  if (description.length > MAX_EMBED_LENGTH) {
    throw new Error(`EMBED_MESSAGE exceeds 4096 characters after substituting placeholders for ${name}`);
  }
  const webhookUrl = new URL(config.webhookUrl);
  webhookUrl.searchParams.set("wait", "true");
  const response = await request(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [{ description }], allowed_mentions: { parse: [] } }),
  }, "Discord shoutout");
  const failure = await discordStatus(response, "Discord shoutout");
  if (failure !== null) return { sent: false, retryAt: failure };
  const resetAfter = response.headers.get("X-RateLimit-Remaining") === "0"
    ? Number(response.headers.get("X-RateLimit-Reset-After"))
    : 0;
  await response.body?.cancel().catch(() => {});
  const retryAt = Number.isFinite(resetAfter) && resetAfter > 0 ? Date.now() + Math.ceil(resetAfter * 1000) : 0;
  return { sent: true, retryAt };
}

async function discordStatus(response, service) {
  if (response.status === 429) {
    let seconds = Number(response.headers.get("Retry-After"));
    if (!Number.isFinite(seconds) || seconds <= 0) {
      const body = await response.json().catch(() => ({}));
      seconds = Number(body?.retry_after);
    } else {
      await response.body?.cancel();
    }
    console.warn({ message: "Discord webhook rate limited", service });
    return Date.now() + (Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : 60_000);
  }
  if (response.status === 404) {
    await response.body?.cancel();
    console.error({ message: "Discord webhook was not found. Replace DISCORD_WEBHOOK_URL to resume sending." });
    return -1;
  }
  await requireSuccess(response, service);
  return null;
}

async function requireSuccess(response, service) {
  if (response.ok) return;
  await response.body?.cancel();
  throw new Error(`${service} returned HTTP ${response.status}`);
}
