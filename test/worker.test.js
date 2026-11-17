import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { getPlatformProxy } from "wrangler";
import { readConfig } from "../src/services.js";
import worker from "../src/worker.js";

const HOUR = 60 * 60 * 1000;
const migrationsDir = new URL("../migrations/", import.meta.url);
const migrations = await Promise.all((await readdir(migrationsDir)).filter((name) => name.endsWith(".sql"))
  .sort().map((name) => readFile(new URL(name, migrationsDir), "utf8")));

async function setup(t, settings = {}) {
  const { env, dispose } = await getPlatformProxy({ persist: false, remoteBindings: false });
  t.after(dispose);
  for (const migration of migrations) {
    await env.DB.batch(migration.split(";").map((sql) => sql.trim()).filter(Boolean)
      .map((sql) => env.DB.prepare(sql)));
  }
  const config = {
    ...env,
    STREAMERS_URL: "https://example.test/streamers.txt",
    TWITCH_CLIENT_ID: "client-id",
    TWITCH_CLIENT_SECRET: "client-secret",
    DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/test-token",
    ...settings,
  };
  const upstream = {
    list: "Example_One\r\n",
    listFailure: false,
    live: new Map([["example_one", "first-broadcast"]]),
    userIds: new Map(),
    startTimes: new Map(),
    tokenRequests: 0,
    invalidBearer: null,
    batches: [],
    shoutouts: [],
    destinations: [],
    webhook: async () => Response.json({ id: "message" }),
    route: { guild_id: "10", channel_id: "20" },
  };
  t.mock.method(globalThis, "fetch", async (resource, init) => {
    const url = new URL(resource);
    switch (url.hostname) {
      case "example.test":
        assert.equal(init.cache, "no-store");
        return upstream.listFailure ? new Response(null, { status: 503 }) : new Response(upstream.list);
      case "id.twitch.tv":
        assert.equal(init.body.get("grant_type"), "client_credentials");
        return Response.json({ access_token: `token-${++upstream.tokenRequests}`, expires_in: 3600 });
      case "api.twitch.tv": {
        if (init.headers.Authorization === upstream.invalidBearer) return new Response(null, { status: 401 });
        const logins = url.searchParams.getAll("user_login");
        upstream.batches.push(logins);
        return Response.json({ data: logins.filter((login) => upstream.live.has(login)).map((login) => ({
          id: upstream.live.get(login),
          user_login: login,
          user_id: upstream.userIds.get(login) ?? login,
          started_at: new Date(upstream.startTimes.get(login) ?? Date.now() - 1000).toISOString(),
          type: "live",
        })) });
      }
      case "discord.com":
        if (!init.method) {
          return Response.json(url.pathname.includes("/456/") ? { guild_id: "10", channel_id: "30" } : upstream.route);
        }
        assert.equal(url.searchParams.get("wait"), "true");
        upstream.shoutouts.push(JSON.parse(init.body));
        upstream.destinations.push(url.pathname);
        return upstream.webhook(url);
      default:
        assert.fail(`Unexpected test host ${url.hostname}`);
    }
  });
  return {
    upstream,
    config,
    poll: () => worker.scheduled({}, config),
    sent: async () => (await env.DB.prepare("SELECT stream_id FROM announced_streams ORDER BY stream_id").all())
      .results.map((row) => row.stream_id),
  };
}

test("announces existing and newly listed streams once, including after removal and re-addition", async (t) => {
  const { upstream, sent, poll } = await setup(t, { EMBED_MESSAGE: `${"x".repeat(1000)} {name}: {url}` });
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  await poll();
  await poll();
  assert.equal(upstream.shoutouts.length, 1);
  assert.deepEqual(upstream.shoutouts[0], {
    embeds: [{ description: `${"x".repeat(1000)} Example_One: https://twitch.tv/Example_One` }],
    allowed_mentions: { parse: [] },
  });
  upstream.live.set("example_two", "second-broadcast");
  upstream.list = "Example_Two\nexample_two\n\n";
  await poll();
  upstream.list += "Example_One\n";
  await poll();
  assert.deepEqual(await sent(), ["first-broadcast", "second-broadcast"]);
  assert.equal(upstream.shoutouts.length, 2);
  now += 4 * HOUR;
  upstream.startTimes.set("example_one", now);
  upstream.live.set("example_one", "new-broadcast");
  await poll();
  assert.deepEqual(await sent(), ["first-broadcast", "new-broadcast", "second-broadcast"]);
  assert.equal(upstream.tokenRequests, 2);
});

test("permanently skips a broadcast started during cooldown by the same Twitch account", async (t) => {
  const { upstream, config, sent, poll } = await setup(t);
  delete config.SHOUTOUT_COOLDOWN_HOURS;
  const firstShoutout = Date.now();
  let now = firstShoutout;
  t.mock.method(Date, "now", () => now);
  await poll();

  // Twitch reports the renamed account after cooldown, but the new broadcast started inside it.
  now += 5 * HOUR;
  upstream.list = "Renamed_One\n";
  upstream.live.set("renamed_one", "early-restart");
  upstream.userIds.set("renamed_one", "example_one");
  upstream.startTimes.set("renamed_one", firstShoutout + 2 * HOUR);
  await poll();
  assert.deepEqual(await sent(), ["first-broadcast"]);

  config.SHOUTOUT_COOLDOWN_HOURS = "1";
  await poll();
  assert.deepEqual(await sent(), ["first-broadcast"]);
  assert.equal(upstream.shoutouts.length, 1);

  upstream.live.set("renamed_one", "next-broadcast");
  upstream.startTimes.set("renamed_one", now);
  await poll();
  assert.deepEqual(await sent(), ["first-broadcast", "next-broadcast"]);
});

test("accepts the configured cooldown bounds and rejects out-of-range or fractional hours", async (t) => {
  const { config } = await setup(t);
  for (const hours of [1, 24]) {
    assert.equal(readConfig({ ...config, SHOUTOUT_COOLDOWN_HOURS: String(hours) }).cooldownMs, hours * HOUR);
  }
  for (const hours of ["", "0", "25", "1.5"]) {
    assert.throws(() => readConfig({ ...config, SHOUTOUT_COOLDOWN_HOURS: hours }), /whole number from 1 to 24/);
  }
});

test("checks more than 100 logins and refreshes a rejected cached Twitch token", async (t) => {
  const { upstream, sent, poll } = await setup(t);
  await poll();
  upstream.list = Array.from({ length: 101 }, (_, index) => `streamer_${index}`).join("\n");
  upstream.live.set("streamer_100", "last-batch");
  upstream.invalidBearer = "Bearer token-1";
  await poll();
  assert.equal(upstream.tokenRequests, 2);
  assert.deepEqual(upstream.batches.map((logins) => logins.length), [1, 100, 1]);
  assert.deepEqual(await sent(), ["first-broadcast", "last-batch"]);
});

test("serializes overlapping polls before posting to Discord", async (t) => {
  const { upstream, sent, poll } = await setup(t);
  const reachedDiscord = Promise.withResolvers();
  const finishPost = Promise.withResolvers();
  upstream.webhook = async () => {
    reachedDiscord.resolve();
    await finishPost.promise;
    return Response.json({ id: "message" });
  };
  const first = poll();
  await Promise.race([reachedDiscord.promise, first]);
  try {
    await poll();
    assert.equal(upstream.shoutouts.length, 1);
  } finally {
    finishPost.resolve();
    await first;
  }
  assert.deepEqual(await sent(), ["first-broadcast"]);
});

test("backs off after Discord rate limits and retries a still-live stream", async (t) => {
  const { upstream, config, sent, poll } = await setup(t);
  upstream.webhook = async () => Response.json({ retry_after: 65 }, { status: 429 });
  await poll();
  await poll();
  assert.deepEqual(await sent(), []);
  assert.equal(upstream.shoutouts.length, 1);
  await config.DB.prepare("UPDATE discord_webhook_backoff SET retry_at = 0").run();
  upstream.webhook = async () => Response.json({ id: "message" });
  await poll();
  assert.deepEqual(await sent(), ["first-broadcast"]);
  assert.equal(upstream.shoutouts.length, 2);
});

test("recovers from a failed list read and checks the configured Discord destination", async (t) => {
  const { upstream, config, sent, poll } = await setup(t, { DISCORD_GUILD_ID: "10", DISCORD_CHANNEL_ID: "30" });
  upstream.listFailure = true;
  await assert.rejects(poll(), /Streamer list returned HTTP 503/);
  assert.equal(upstream.tokenRequests, 0);
  upstream.listFailure = false;
  await assert.rejects(poll(), /Discord webhook does not match/);
  assert.equal(upstream.shoutouts.length, 0);
  config.DISCORD_CHANNEL_ID = "20";
  await poll();
  assert.deepEqual(await sent(), ["first-broadcast"]);
});

test("continues an announcement burst across polls within the subrequest budget", async (t) => {
  const { upstream, sent, poll } = await setup(t);
  const logins = Array.from({ length: 30 }, (_, index) => `streamer_${index}`);
  upstream.list = logins.join("\n");
  upstream.live = new Map(logins.map((login) => [login, login]));

  await poll();
  assert.ok(upstream.shoutouts.length > 0 && upstream.shoutouts.length < logins.length);
  await poll();
  assert.equal(upstream.shoutouts.length, logins.length);
  assert.deepEqual(await sent(), logins.sort());
});

const ownSettings = {
  MYCHANNEL: "My_Stream",
  MYEMBED_MESSAGE: "I am live at {url}!",
  DISCORD_MYCHANNEL_ID: "30",
  DISCORD_MYCHANNEL_WEBHOOK_URL: "https://discord.com/api/webhooks/456/own-test-token",
};

test("routes the configured account separately and sends it only once if also listed", async (t) => {
  const { upstream, sent, poll } = await setup(t, ownSettings);
  upstream.list += "my_stream\n";
  upstream.live.set("my_stream", "my-first-broadcast");
  await poll();
  await poll();
  assert.deepEqual(await sent(), ["first-broadcast", "my-first-broadcast"]);
  assert.deepEqual(upstream.destinations, ["/api/webhooks/456/own-test-token", "/api/webhooks/123/test-token"]);
  assert.equal(upstream.shoutouts[0].embeds[0].description, "I am live at https://twitch.tv/My_Stream!");

  upstream.live.set("my_stream", "my-second-broadcast");
  await poll();
  assert.deepEqual(await sent(), ["first-broadcast", "my-first-broadcast", "my-second-broadcast"]);
});

test("Discord throttling on one webhook does not block the other channel", async (t) => {
  const { upstream, sent, poll } = await setup(t, ownSettings);
  upstream.live.set("my_stream", "my-first-broadcast");
  upstream.webhook = async (url) => url.pathname.includes("/456/")
    ? Response.json({ retry_after: 65 }, { status: 429 })
    : Response.json({ id: "message" });
  await poll();
  await poll();
  assert.deepEqual(await sent(), ["first-broadcast"]);
  assert.equal(upstream.destinations.length, 2);
});

test("skips broadcasts started during silent mode even after the configured account ends its stream", async (t) => {
  const { upstream, sent, poll } = await setup(t, { ...ownSettings, SILENT_DURING_MYCHANNEL_STREAMS: "true" });
  const now = Date.now();
  upstream.live.set("my_stream", "my-first-broadcast");
  upstream.startTimes.set("my_stream", now - 60_000);
  upstream.startTimes.set("example_one", now - 10_000);
  await poll();
  await poll();
  upstream.live.delete("my_stream");
  await poll();
  assert.deepEqual(await sent(), ["my-first-broadcast"]);
  assert.deepEqual(upstream.destinations, ["/api/webhooks/456/own-test-token"]);
  upstream.live.set("example_one", "next-broadcast");
  await poll();
  assert.deepEqual(await sent(), ["my-first-broadcast", "next-broadcast"]);
});

test("moves template and configured roles above each embed with an explicit Discord allowlist", async (t) => {
  const { upstream, poll } = await setup(t, {
    ...ownSettings,
    MYEMBED_MESSAGE: "<@&111> {name} is live",
    DISCORD_MYMENTION_ROLE_ID: "111",
    EMBED_MESSAGE: "<@&222> {name} is live @everyone",
    DISCORD_MENTION_ROLE_ID: "333",
  });
  upstream.live.set("my_stream", "my-first-broadcast");
  await poll();
  assert.deepEqual(upstream.shoutouts, [
    { content: "<@&111>", allowed_mentions: { roles: ["111"] }, embeds: [{ description: "My_Stream is live" }] },
    {
      content: "<@&333> <@&222>",
      allowed_mentions: { roles: ["333", "222"] },
      embeds: [{ description: "Example_One is live @everyone" }],
    },
  ]);
});
