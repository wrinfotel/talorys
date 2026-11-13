# Telegram bot

Talorys can run your own Telegram bot: you chat with your agent from any
Telegram app, and reminders and automation results arrive in the same chat.
The bot is optional. With no bot configured nothing changes — no extra
requests, no new UI, no redeploy.

## Creating a bot

1. In Telegram, talk to [@BotFather](https://t.me/BotFather) and send
   `/newbot`.
2. Pick a display name and a username (it must end in `bot`, for example
   `my_talorys_bot`). BotFather replies with an **access token** like
   `123456789:AA…`.
3. Keep the token private. Anyone who has it controls the bot.

## Connecting the bot

1. Open **Settings → Integrations** and find **Telegram bot**.
2. Paste the token from BotFather.
3. Check the **Webhook base URL**. It defaults to the address you are browsing
   and must be the public URL of your Talorys deployment (for example
   `https://my-talorys.pages.dev`). A `localhost` address is not reachable
   from Telegram's servers, so use your deployed address.
4. Choose **Connect**. Talorys validates the token with Telegram, registers a
   webhook and shows a pairing code.

## Pairing your chat

The bot is single-owner: it answers only in one chat — yours.

1. In Telegram, open your bot (use the **Open in Telegram** link in Settings)
   and send `/start` followed by the pairing code shown in Settings, for
   example:

   ```
   /start AB2CD3EF
   ```

2. The code is valid for 15 minutes; press **New code** to get a fresh one if
   it expired. The first valid code links that chat, and the code is spent —
   it can't be reused.

Messages from any other chat are silently ignored, and a failed `/start`
attempt only gets a hint that the bot is private.

## Chatting

Once linked, send plain messages and the agent answers with the same tools,
memories and limits as the chat in the web UI:

- **One turn at a time.** While a reply is being generated, the next message
  gets a polite "still answering" response. Cancel a running turn from the
  web chat (it is the same conversation) and the Telegram reply stops too.
- `/new` — start a fresh conversation. The old one remains in Talorys under
  Conversations.
- `/resume` — list the recent conversations; `/resume 2` switches the chat
  back to the second of them, and the next plain message continues it.
- `/context` — how full the current conversation's context window is: the
  messages kept verbatim, their estimated tokens against the budget, and the
  running summary that covers older messages.
- `/compact` — fold everything but the most recent messages into the running
  summary right away (one AI call), so long conversations keep answering with
  full context. Compaction otherwise happens automatically on the next reply
  when the history no longer fits.
- `/status` — the model the assistant is running on, and whether web search
  and notifications are on.
- `/help` — a short summary of what the bot can do.

Replies arrive formatted: the agent answers in Markdown and the bot converts
it to Telegram's own markup, so bold, italic, code blocks, links and
paragraphs look right. A message Telegram refuses to parse still arrives, just
as plain text.

### The "/" command menu

Connecting the bot also registers its commands with Telegram, so the menu
button next to the message field lists them: in English by default, and in
Russian when the Telegram app's language is Russian. When the command set
changes in an update, a bot that is already connected refreshes its menu on
its next message in the paired chat; disconnecting and connecting again
registers it too.

## Notifications

While **Deliver notifications here** is on (the default), every reminder and
automation result that reaches your notification center is also sent to the
linked chat — alongside Web Push, not instead of it. Notifications arrive
formatted like chat replies — the title in bold over the Markdown body, with
a very long body clipped. Turn the toggle off to keep the bot chat-only.

## Security

- The webhook endpoint is public but protected: Telegram signs every update
  with a secret token generated at connect time, and updates without a
  matching secret are rejected before they reach any handler.
- The bot token and the webhook secret are stored encrypted at rest (AES-256-GCM,
  keyed by the deployment's `MCP_CREDENTIAL_KEY` secret) and are never shown
  again or sent to the AI model.
- The bot's non-secret state (bot username, webhook base URL, the linked chat
  id, the notification toggle and a pending pairing code) is stored unencrypted
  in the agent's database; none of it is sensitive.
- Disconnecting removes the webhook on Telegram's side and deletes every
  stored key, as if the bot had never been set up.
