# sinfultp ai

Discord AI bot powered by Groq.

## Commands
- `/ask` ask anything (`private` option for a hidden reply, optional image or text/code file)
- `/luau` generate Luau code and get it back as a .txt file (capped at 2 MB)
- `/fixcode` upload a .lua/.luau/.txt file and get a fixed or updated version back
- `/imagine` generate an image
- `/translate` translate text
- `/summarize` summarize the latest messages in the channel
- `/reset` clear the bot's memory of your chat
- `.help` / `?help` show the command menu
- Mention the bot or DM it to chat. It reads attached images and text/code files, including ones in a message you reply to

## Moderation (prefix `?`)
| Command | What it does | Needs |
| --- | --- | --- |
| `?ban @user [reason]` | Ban (works on IDs too) | Ban Members |
| `?unban id` | Unban | Ban Members |
| `?kick @user [reason]` | Kick | Kick Members |
| `?to @user [10m/2h/1d] [reason]` | Timeout (default 10m, max 28d). Aliases `?timeout`, `?mute` | Moderate Members |
| `?untimeout @user` | Remove timeout. Aliases `?uto`, `?unmute` | Moderate Members |
| `?lock` / `?unlock` | Lock or unlock the channel you run it in (blocks @everyone from sending) | Manage Channels |
| `.createrole <name> <all\|admin\|none>` | Create a role with an `all`, `admin`, or `none` permission preset | Manage Roles |
| `.giverole <user> <role name>` | Give a role to a member | Manage Roles |
| `.leaderboard` / `.invites` | Show the top inviters by invite uses | Manage Server usually required |
| `.slowmodeOn` / `.slowmodeOff` | Set an 8 second slowmode or turn it off | Manage Channels |
| `.purge <1-100>` | Delete recent messages in the current channel | Manage Messages |

Normal users need the matching Discord permission and must outrank the target's top role. The owner ID (below) bypasses those checks. The bot's own role still has to be above the target.

## AI server builder
- `?build <request>` or `/build`, or mention the bot with something like "make a gaming server with voice channels".
- The AI writes a plan, shows it, and nothing happens until the requester presses **Run it**.
- It can create/edit/delete categories and channels (needs Manage Channels), and for the owner ID only: create/edit/delete roles, give/remove roles, set channel permissions, private channels, ban/unban/kick/timeout.
- The owner check is done in code against the real user who presses the button, so no prompt wording can bypass it. The AI can also only act on user IDs that appear in the requester's own message.

## Modapp
- `/modapp` posts the staff application form URL from `MODAPP_URL`.
- The application form is served directly by the bot at `GET /modapp`. See `MODAPP_WEBHOOK_SETUP.md`.
- Submissions are sent to `MODAPP_CHANNEL_ID` with Accept/Decline buttons.

## Moderation logs
- Deleted messages are logged to `MOD_LOG_CHANNEL_ID` (default `1555984649761722438`).
- Role adds/removes are logged to the same channel.

## Safety
- The bot never pings @everyone, @here, @verified, or any role (mentions are disabled and also defused in text).
- The Groq API key and bot token are only read from environment variables and are scrubbed from every outgoing message and file.

## Railway variables
| Variable | Required | Notes |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | yes | Bot token |
| `GROQ_API_KEY` | yes | Groq API key |
| `GUILD_ID` | no | Instant slash command registration in one server |
| `GROQ_MODEL` | no | Default `openai/gpt-oss-120b` |
| `OWNER_ID` | no | Only this user can use AI role/permission/ban actions. Default `1088143400496279552` |
| `GROQ_VISION_MODEL` | no | Model used when an image is attached. Default `qwen/qwen3.8-27b` |
| `MODAPP_URL` | no | Public application form URL used by `/modapp`. Default `https://sinfultpai.up.railway.app/modapp` |
| `MODAPP_CHANNEL_ID` | no | Channel for submitted applications. Default `1555973537582284831` |
| `MODAPP_SECRET` | recommended | Shared secret required on application submissions |
| `MODAPP_PORT` | no | Webhook server port for form submissions. Default `8080` |
| `MODAPP_STAFF_ROLE_ID` | no | Role allowed to accept/decline applications, in addition to staff with Manage Server |
| `MOD_LOG_CHANNEL_ID` | no | Channel for message delete and role change logs. Default `1555984649761722438` |

Note: Groq does not provide text-to-image generation, so `/imagine` is not available with this backend.

## Discord Developer Portal
Bot tab: turn on **Message Content Intent** (needed for mention and DM chat, `?` commands and /summarize). Invite with scopes `bot` and `applications.commands`.
Give the bot these permissions: Manage Channels, Manage Roles, Ban Members, Kick Members, Moderate Members, View Channels, Send Messages, Embed Links, Attach Files, Read Message History. Drag the bot's role **above** the roles it should manage.

## Run locally
```
npm install
copy .env.example .env   (then fill it in)
npm start
```

## Push to GitHub
Run `push_to_github.bat`. It pushes to the `sinfultp-ai` branch of Solvex-auth so your auth on `main` is not touched. Change `BRANCH` at the top of the file to use a different branch.
