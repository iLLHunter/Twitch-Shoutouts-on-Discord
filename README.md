# Twitch shoutouts for Discord

The Cloudflare Worker runs once per minute. It reloads a public text file, asks Twitch which listed accounts are live, and sends one Discord embed per eligible broadcast. It can announce an already-live account on its first check, including when you add that account to the file. D1 remembers broadcast IDs across polls and redeploys.

After a confirmed shoutout for a listed account, the account enters a cooldown. If a new broadcast starts during that cooldown, the Worker skips the entire broadcast even if it stays live after the cooldown ends. A broadcast that starts at or after the cooldown ends can get a new shoutout that same day. The cooldown follows the Twitch account ID, including when its login changes.

`MYCHANNEL` uses its own template and destination and can be announced once for every broadcast, including if the login is also in the list. When silent mode is enabled, only your channel can be announced while it is live. Listed broadcasts that the Worker detects starting during your stream are skipped for the entire broadcast.

## Set up a Discord server

Use one Worker, one D1 database, and a webhook for each Discord announcement channel. Install Node.js 22.12 or later and run `npm ci` from this folder.

1. Publish a UTF-8 `.txt` file at a public URL that serves the raw file. Put one Twitch account login per line. Blank lines are ignored and duplicate logins are matched case-insensitively. The Worker checks the same URL every minute, so edits to the file take effect without redeploying.

   ```text
   example_streamer
   another_streamer
   ```

2. Register a confidential app in the [Twitch Developer Console](https://dev.twitch.tv/console/apps). Copy its client ID and create a client secret. For the required OAuth redirect URL, you can enter `http://localhost` because this Worker uses app credentials and has no user sign-in. [Twitch app registration](https://dev.twitch.tv/docs/authentication/register-app/)
3. Create an incoming Discord webhook in the text channel where announcements should go. Copy the webhook URL. [Discord webhook setup](https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks)
4. Sign in to Cloudflare and create a D1 database.

   ```sh
   npx wrangler login
   npx wrangler d1 create discord-twitch-shoutouts
   ```

   Copy the returned `database_id` into the D1 binding in `wrangler.jsonc`, replacing the all-zero ID. If you chose a different database name, update `database_name` and the migration command to match. Use a distinct Worker `name` if you already have an installation in the same account. Once the binding has your database ID, apply the migration.

   ```sh
   npx wrangler d1 migrations apply discord-twitch-shoutouts --remote
   ```

5. Set the following text variables under `vars` in `wrangler.jsonc`. They are also available under the Worker's Cloudflare **Settings → Variables and Secrets** after deployment. For dashboard-only management, remove those keys from `vars` before later Wrangler deploys. The configuration keeps dashboard-set variables.

   | Variable | Value |
   | --- | --- |
   | `STREAMERS_URL` | Public URL for the raw `.txt` file |
   | `TWITCH_CLIENT_ID` | Client ID from Twitch |
   | `EMBED_MESSAGE` | Embed description template such as `Hey check out {name}! They are live at {url}` |
   | `SHOUTOUT_COOLDOWN_HOURS` | Whole hours between a confirmed shoutout and the earliest eligible start of the account's next broadcast. Accepts 1–24 and defaults to 4. |
   | `DISCORD_GUILD_ID` | Optional server ID used to verify the webhook destination |
   | `DISCORD_CHANNEL_ID` | Optional channel ID used to verify the webhook destination |
   | `MYCHANNEL` | Optional Twitch login for your own live announcements. The Worker checks this account even if it is absent from the `.txt` file. |
   | `MYEMBED_MESSAGE` | Embed template for your own announcements. Supports `{name}` and `{url}`. |
   | `DISCORD_MYCHANNEL_ID` | Discord channel ID as text for your own announcements, required when `MYCHANNEL` is set. |
   | `DISCORD_MENTION_ROLE_ID` | Optional Discord role ID as text to ping for listed streamers. |
   | `DISCORD_MYMENTION_ROLE_ID` | Optional Discord role ID as text to ping for `MYCHANNEL`. |
   | `SILENT_DURING_MYCHANNEL_STREAMS` | Set to `true` to silence the `.txt` list's shoutouts while `MYCHANNEL` is live. Defaults to `false`. |

   `{name}` expands to the account name as written in the file. `{url}` expands to its `https://twitch.tv/name` link. A 1,000-character message fits. Discord allows up to 4,096 characters in the description after substitution, and Cloudflare allows up to 5 KB per variable. [Discord embed limits](https://docs.discord.com/developers/resources/message#embed-limits) · [Cloudflare Worker limits](https://developers.cloudflare.com/workers/platform/limits/)

6. Create a private `secrets.json` with the secrets below. The file is Git-ignored. Upload the values as encrypted Worker secrets during deployment. You can rotate a secret later under **Settings → Variables and Secrets** or with `wrangler secret put`.

   ```json
   {
     "TWITCH_CLIENT_SECRET": "your Twitch client secret",
     "DISCORD_WEBHOOK_URL": "the URL copied from the Discord webhook"
   }
   ```

   If your own announcements go to a different Discord channel, create an incoming webhook in that channel and add its URL as `DISCORD_MYCHANNEL_WEBHOOK_URL`. If both kinds go to the same channel, the existing `DISCORD_WEBHOOK_URL` can send both. The Worker checks the webhook's channel against `DISCORD_MYCHANNEL_ID` before posting your announcement.

   ```sh
   npm run deploy -- --secrets-file secrets.json
   ```

Cloudflare can take up to 15 minutes to propagate a new Cron Trigger. Check **Observability** in the Worker dashboard for scheduled runs, confirmed sends, and API errors. [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

For an existing installation, apply the D1 migrations before deploying the updated Worker. Existing broadcast IDs and cooldown records carry over. If you are upgrading from the original schema, cooldown tracking starts with the first confirmed shoutout after the upgrade because the original records contain only broadcast IDs.

Minute polling can miss broadcasts that start and end between checks. If Discord accepts a post but the Worker loses the response or cannot record the success in D1, a later check can retry that post.

## Set up Discord role mentions

1. Enable **Developer Mode** under Discord **User Settings → Advanced**. In **Server Settings → Roles**, right-click the role and choose **Copy Role ID**. [Discord Developer Mode](https://support.discord.com/hc/en-us/articles/206346498-Where-can-I-find-my-User-Server-Message-ID)
2. Open that role in **Server Settings → Roles** and enable **Allow anyone to @mention this role**. This lets the incoming webhook ping the role and also lets server members who can post mention it. Use a role intended for stream notifications. [Discord role mention permissions](https://support.discord.com/hc/en-us/articles/360039176412-Role-Mention-Permissions-Suppression)
3. Set `DISCORD_MENTION_ROLE_ID` for the list and `DISCORD_MYMENTION_ROLE_ID` for your channel. You can also put `<@&ROLE_ID>` in either embed template. For example, `<@&123456789012345678> {name} is live at {url}`. The Worker puts those role pings above the embed and mentions each role once per message. Each member's notification settings determine how Discord alerts them. [Discord allowed mentions](https://docs.discord.com/developers/resources/message#allowed-mentions-object)

## Local verification

Run `npm test` to exercise the scheduled handler with local D1 and simulated Twitch and Discord responses. It requires no service credentials. Run `npx wrangler deploy --dry-run` to validate the bundle without deploying.
