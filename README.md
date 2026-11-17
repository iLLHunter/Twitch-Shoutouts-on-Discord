# Twitch shoutouts for Discord

The Cloudflare Worker runs once per minute. It reloads a public text file, asks Twitch which listed accounts are live, and sends one Discord embed per eligible broadcast. It can announce an already-live account on its first check, including when you add that account to the file. D1 remembers broadcast IDs across polls and redeploys.

After a confirmed shoutout, the account enters a cooldown. If a new broadcast starts during that cooldown, the Worker skips the entire broadcast even if it stays live after the cooldown ends. A broadcast that starts at or after the cooldown ends can get a new shoutout that same day. The cooldown follows the Twitch account ID, including when its login changes.

## Set up a Discord server

Use one Worker, one D1 database, and one Discord channel webhook per installation. Install Node.js 22.12 or later and run `npm ci` from this folder.

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

   `{name}` expands to the account name as written in the file. `{url}` expands to its `https://twitch.tv/name` link. A 1,000-character message fits. Discord allows up to 4,096 characters in the description after substitution, and Cloudflare allows up to 5 KB per variable. [Discord embed limits](https://docs.discord.com/developers/resources/message#embed-limits) · [Cloudflare Worker limits](https://developers.cloudflare.com/workers/platform/limits/)

6. Create a private `secrets.json` with the two secrets below. The file is Git-ignored. Upload the values as encrypted Worker secrets during deployment. You can rotate either secret later under **Settings → Variables and Secrets** or with `wrangler secret put`.

   ```json
   {
     "TWITCH_CLIENT_SECRET": "your Twitch client secret",
     "DISCORD_WEBHOOK_URL": "the URL copied from the Discord webhook"
   }
   ```

   ```sh
   npm run deploy -- --secrets-file secrets.json
   ```

Cloudflare can take up to 15 minutes to propagate a new Cron Trigger. Check **Observability** in the Worker dashboard for scheduled runs, confirmed sends, and API errors. [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

For an existing installation, apply the D1 migrations before deploying the updated Worker. Existing broadcast IDs still prevent duplicate posts. The cooldown starts with the first confirmed shoutout recorded by the updated Worker because earlier records contain only broadcast IDs.

Minute polling can miss broadcasts that start and end between checks. If Discord accepts a post but the Worker loses the response or cannot record the success in D1, a later check can retry that post.

## Local verification

Run `npm test` to exercise the scheduled handler with local D1 and simulated Twitch and Discord responses. It requires no service credentials. Run `npx wrangler deploy --dry-run` to validate the bundle without deploying.
