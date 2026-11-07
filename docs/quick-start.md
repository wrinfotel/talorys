# Talorys: setup from scratch, step by step

This guide is for people who don't write code for a living. It takes you from an
empty machine to a personal AI assistant that lives in your own cloud, answers
in your browser and in Telegram, searches the web, and remembers what matters.

You don't need to buy or rent a server. Everything runs on Cloudflare's free tier.

---

## What you'll end up with

- **A private assistant** at your own address like `https://your-name.pages.dev` — sign in with your password and chat.
- It **remembers** facts about you, manages **tasks, notes and projects**, and runs **reminders** and **routines** on a schedule.
- Talk to it **in the browser** or **in Telegram** — wherever you happen to be.
- By default it runs on Cloudflare's free model, but you can connect **your own model** (OpenRouter, OpenAI, and more) — it gets noticeably smarter.
- It can **read web pages** and **search the web** (optionally through Tavily, which makes search better).

---

## Step 0. Get ready (10 minutes)

1. **A browser**.
2. **A Cloudflare account** (free). If you don't have one: go to
   [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up), click **Sign up**,
   enter your e-mail and a password. No credit card required.
3. **Install Node.js**:
   - go to [nodejs.org](https://nodejs.org),
   - download the version marked **LTS** (recommended),
   - install it like any normal program: next, next, done.
   - Talorys needs Node **22 or newer** — the check below will tell you if something is off.
4. **Install Git** (the program that downloads code):
   - go to [git-scm.com/downloads](https://git-scm.com/downloads),
   - download for your system and install (all the default choices are fine).

Check that everything worked: press **Win+R**, type `cmd`, press Enter. In the black
window type `node -v` and Enter — you should see a version (like `v22.14.0`). Then
type `git --version` — another version. If both commands print versions, you're ready. If `node -v` errors or shows a version below 22, reinstall Node.js (the LTS from nodejs.org) and reopen the window.

---

## Step 1. Download and install Talorys (10–15 minutes)

1. Open that same black window (**Win+R** → `cmd` → Enter).
2. Go to the folder where you want to keep the program, for example:
   ```
   cd C:\projects
   ```
   (create it first if needed: `mkdir C:\projects`, then `cd C:\projects` again)
3. Download Talorys:
   ```
   git clone https://github.com/wrinfotel/talorys.git
   cd talorys
   ```
4. Download the internal components (takes a couple of minutes):
   ```
   npm install
   ```
5. Build the program:
   ```
   npm run build
   ```
6. Start the installer:
   ```
   node packages\create-talorys\dist\cli.js install
   ```
   (on macOS and Linux use forward slashes: `packages/create-talorys/dist/cli.js`)
7. The installer asks a few questions and signs you in to Cloudflare:
   - **Login to Cloudflare** — a browser window opens; sign in to your Cloudflare
     account and click **Allow**. This is a one-time authorization.
   - **Agent name** — what your assistant is called (just press Enter to keep "Talorys").
   - **Enable semantic recall** — "smart search through memories". Fine to enable on the
     free tier; if unsure, press Enter (no). You can change it later in Settings.
   - **Owner password** — choose **the owner password**. This is the only password for
     signing in to your assistant. Write it down somewhere safe! It can't be recovered —
     only reset with `node packages\create-talorys\dist\cli.js reset-password`.
8. The installer creates everything inside your Cloudflare account and shows your
   **URL** — your personal address like `https://talorys-xxxxx-web.pages.dev`.
   Open it, enter the owner password — you're in!

> ⚠️ The whole installation lives in **your** Cloudflare account. No data goes to the developers.

---

## Step 2. Make it smarter: your own model (5 minutes)

By default the assistant runs on Cloudflare's free model (GLM). It's a fine start,
but you can connect any model through **OpenRouter** — a service that gives you
access to hundreds of models (free and paid) with a single key.

1. Sign up at [openrouter.ai](https://openrouter.ai) (a Google account works).
2. Go to **Keys**: [openrouter.ai/keys](https://openrouter.ai/keys) → **Create Key** →
   name it (e.g. `talorys`) → **Create**.
3. Copy the key it shows (starts with `sk-or-…`). It is shown only once!
   - Free models cost nothing. For paid ones, top up your balance under **Credits**.
4. In your Talorys: **Settings → AI → Provider**:
   - choose **Custom (OpenAI-compatible)**;
   - **Base URL**: `https://openrouter.ai/api/v1`
   - **Model**: a model name, e.g. `openai/gpt-4o-mini` or `anthropic/claude-3.5-haiku`
     (the full list is at [openrouter.ai/models](https://openrouter.ai/models));
   - **API key**: paste your key;
   - press **Test** — if you see a green confirmation, press **Save**.
5. Done — the assistant now thinks with your model. **Disconnect** switches back to
   Cloudflare's free model at any time.

> 🔒 The key is stored encrypted inside your assistant and is never shown again or sent
> anywhere except the provider itself when the model is called.

---

## Step 3. Connect the Telegram bot (10 minutes)

1. In Telegram, find the official bot **@BotFather** and send it `/newbot`.
2. It asks for a name — anything you like (e.g. `My personal assistant`).
3. Then a **username** — it must end with `bot`, e.g. `my_personal_agent_bot`.
4. BotFather sends you a **token** — a string like `1234567890:AAf4h2m8_…`. Copy all of
   it. This is your bot's login and password in one — don't show it to anyone.
5. In your Talorys: **Settings → Integrations → Telegram**:
   - paste the token into **Token**;
   - **Webhook base URL** is already filled with your Talorys address — leave it;
   - press **Connect**.
6. A **pairing code** appears (8 characters, valid for 15 minutes). Open your new bot in
   Telegram and send it:
   ```
   /start CODE
   ```
   (with your code, e.g. `/start AB12CD34`).
7. The bot confirms the pairing. Now message it like a regular chat — it answers with
   the same agent as the browser: same memory, tasks and tools.
8. Useful bot commands: `/new` — start a fresh conversation, `/status` — which model and
   options are active, `/help` — help text. They also appear in the bot's menu — tap the
   menu button (≡) next to the message field in the chat.

**Notifications in Telegram:** in the same card, turn on **Deliver notifications here** —
reminders and routine results will arrive in your chat.

> 🔒 The bot pairs with exactly one chat — yours. Messages from strangers are silently
> ignored. The token is stored encrypted.

---

## Step 4 (optional). Better web search with Tavily

The assistant can already read pages (`web_fetch`) and search the web (`web_search` —
a built-in option that needs no account). For smarter search:

1. Sign up at [app.tavily.com](https://app.tavily.com) (free tier: 1,000 searches a month).
2. Copy your API key (starts with `tvly-…`).
3. In your Talorys: **Settings → Integrations → Web search** → paste the key → **Save**.
4. The badge changes to **Tavily**. If Tavily is ever unavailable or the key stops
   working, the assistant quietly falls back to the built-in search — nothing breaks.

---

## Step 5. Check that everything works

Message the assistant (browser or Telegram):

- "remember that my favorite programming language is Python" → later ask "what's my favorite language?";
- "add a task: water the plants tomorrow at 9 am" → at that time a reminder arrives (in Telegram too, if you enabled notifications);
- "search the web for what's new in Claude" → it searches and summarizes;
- "read https://example.com and tell me what the page is about".

---

## Updating Talorys when a new version comes out

Open the black window, go to your Talorys folder and run:

```
git pull
npm install
npm run build
node packages\create-talorys\dist\cli.js update --dir "C:\path\to\install\folder"
```

Replace `C:\path\to\install\folder` with the folder the installer created during the
first install — it contains the `talorys.json` file (the installer printed the path at
the end). All your data, settings and keys survive updates.

> 💡 After an update, wait a minute or two: part of the system restarts with a short
> delay, so new settings may not appear instantly.

---

## Frequent questions

**I forgot the owner password.** In the black window, inside the Talorys folder:
`node packages\create-talorys\dist\cli.js reset-password --dir "<install folder>"` —
you can set a new one (your data survives; active sign-ins are logged out).

**The assistant says it can't use the internet.** Check that a model is selected in
Settings → AI (Cloudflare by default — it works out of the box) and that search is set
up under Integrations. The assistant can't: log in to sites, send e-mail or run
programs — that's by design.

**The Telegram bot is silent.** Make sure you're messaging your own bot, the chat is
paired (the `/start CODE` step), and that a minute or two has passed since the last update.

**The assistant stops answering in the evening and mentions a daily budget.** That's
the daily compute allowance of Cloudflare's free model (10,000 "neurons" a day,
reset at 00:00 UTC). You can see the spend under **Settings → AI**. Either wait for
the next day or connect your own model (Step 2) — e.g. a free or cheap one via
OpenRouter.

**What does it cost?** Cloudflare's free tier covers personal use. OpenRouter and Tavily
have free quotas; paid models only if you top up your own balance.

**Could someone get my keys?** All keys (model, Telegram, Tavily) are stored encrypted
inside your assistant and are never shown in the interface again. If a key ever leaks,
revoke it at the service (OpenRouter / BotFather / Tavily) and paste a new one in the
same settings.

---

## Read more

- [docs/custom-ai-provider.md](custom-ai-provider.md) — more about your own models.
- [docs/telegram-bot.md](telegram-bot.md) — more about the bot.
- [docs/deployment.md](deployment.md) — deployment details.
- [docs/troubleshooting.md](troubleshooting.md) — when something breaks.

> 🇷🇺 Та же инструкция на русском: [docs/quick-start-ru.md](quick-start-ru.md).
