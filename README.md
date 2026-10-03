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
- `.help` show the command menu
- Mention the bot or DM it to chat. It reads attached images and text/code files, including ones in a message you reply to

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
| `GROQ_VISION_MODEL` | no | Model used when an image is attached. Default `qwen/qwen3.8-27b` |

Note: Groq does not provide text-to-image generation, so `/imagine` is not available with this backend.

## Discord Developer Portal
Bot tab: turn on **Message Content Intent** (needed for mention and DM chat and for /summarize). Invite with scopes `bot` and `applications.commands`.

## Run locally
```
npm install
copy .env.example .env   (then fill it in)
npm start
```

## Push to GitHub
Run `push_to_github.bat`. It pushes to the `sinfultp-ai` branch of Solvex-auth so your auth on `main` is not touched. Change `BRANCH` at the top of the file to use a different branch.
