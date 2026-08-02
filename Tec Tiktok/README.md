# New Tech Agency — TikTok ↔ Discord Bot

Discord bot that lets users link their TikTok account and post videos or pull
profile info, using TikTok's OAuth 2.0 + PKCE flow, the Display API, and the
Content Posting API.

## What's included

```
src/
  index.js            Discord bot + slash command handlers
  registerCommands.js Registers the slash commands with Discord
  oauthServer.js       Express server handling TikTok's OAuth redirect
  tiktokAuth.js         OAuth 2.0 + PKCE: auth URL, code exchange, refresh
  tiktokApi.js          Display API + Content Posting API wrapper (auto-refreshes tokens)
  tokenStore.js         AES-256-GCM encrypted, file-based per-user token storage
.env.example           Template for required environment variables
```

## 1. Prerequisites

- Node.js 18.17+
- A Discord application + bot token ([Discord Developer Portal](https://discord.com/developers/applications))
- A TikTok Developer app with `user.info.basic` and `video.publish` scopes
  approved (see the setup guide you provided — Phases 1–4). Add
  `PUBLIC_BASE_URL/callback` as an approved Redirect URI in the TikTok app config.

## 2. Install

```bash
cd newtech-tiktok-bot
npm install
cp .env.example .env
```

Fill in `.env`:

| Variable | Where to get it |
|---|---|
| `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID` | Discord Developer Portal → your app |
| `DISCORD_GUILD_ID` | (optional) your server's ID, for instant command registration while testing |
| `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | TikTok Developer Portal → your app |
| `TIKTOK_REDIRECT_URI` | Must exactly match a Redirect URI registered in the TikTok app |
| `TOKEN_ENCRYPTION_KEY` | Generate with `openssl rand -hex 32` |

**Never commit `.env` or `data/tokens.enc.json`** — both are already in `.gitignore`.
Per the security notes in the setup guide: Client Key/Secret and user tokens
must never be pasted into Discord messages, emails, or chat — this bot never
does that; they only ever move between env vars, TikTok's API, and the
encrypted local store.

## 3. Register slash commands

```bash
npm run register-commands
```

## 4. Run

```bash
npm start
```

This starts both the Discord bot and the local Express server that handles
TikTok's OAuth callback (`/callback`, default port 3000). For production,
put this behind HTTPS (e.g. a reverse proxy) since TikTok requires an HTTPS
redirect URI for production apps.

## 5. Commands

- `/tiktok-connect` — DMs an ephemeral, user-specific TikTok auth link
- `/tiktok-profile` — shows the connected TikTok display name, avatar, follower count
- `/tiktok-post video_url:<url> title:<caption> visibility:<...>` — publishes a video TikTok pulls from a URL you own (`PULL_FROM_URL`); returns a `publish_id`
- `/tiktok-status publish_id:<id>` — polls publish status (publishing is async)
- `/tiktok-disconnect` — deletes the user's stored tokens

## 6. Notes on going to production

- **Sandbox first**: while your TikTok app is in Sandbox mode, all posts are
  forced private regardless of the `visibility` option — this is TikTok's
  behavior, not a bug here.
- **URL ownership**: `PULL_FROM_URL` requires verifying ownership of the
  domain hosting your videos in the TikTok developer portal before App Review
  will approve it.
- **Rate limits**: TikTok caps posting requests per user (e.g. a handful per
  minute) — the bot doesn't currently queue/retry on 429s; add that if you
  expect bursty usage.
- **Scaling beyond one process**: swap `tokenStore.js`'s file-based storage
  and `tiktokAuth.js`'s in-memory PKCE cache for a shared store (Redis,
  Postgres) if you run more than one bot instance.
- **Secrets manager**: the guide recommends AWS Secrets Manager / HashiCorp
  Vault for `TIKTOK_CLIENT_KEY`/`TIKTOK_CLIENT_SECRET` in production instead
  of a plain `.env` file — this scaffold reads them from `process.env`
  either way, so wiring in a secrets manager just means populating those
  env vars at boot instead of from a file.
