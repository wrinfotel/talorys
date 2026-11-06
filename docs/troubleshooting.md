# Troubleshooting

Start with:

```bash
node packages/create-talorys/dist/cli.js doctor --dir "<install folder>"
```

## Installation

**The browser login does not open / times out.** Copy the URL Wrangler prints
into a browser. In SSH or containers, set `CLOUDFLARE_API_TOKEN` instead.

**"Multiple Cloudflare accounts are available."** Pass `--account-id <id>` in
non-interactive mode.

**"…lacks a required permission."** You need to be able to edit Workers and
Pages in the chosen account (see [deployment.md](deployment.md#permissions)).

**"The deployment did not pass its health checks yet."** New `pages.dev` sites
can take a few minutes to get DNS and certificates. Re-run the same command;
it resumes without duplicating anything.

**"…already exists and is not a Talorys installation."** Choose another
directory with `--dir`. The installer never overwrites unrelated folders.

**"SQLite-backed Durable Objects are not available."** Check the account's
Workers settings; SQLite Durable Objects are included on the Free plan.

## Using Talorys

**"Your Cloudflare account has used its Workers AI allocation for today."**
The daily free Neuron allocation is exhausted. Chat resumes after the reset;
tasks, notes, memories and reminders keep working. Exact usage is in the
Cloudflare dashboard (Workers AI).

**"Talorys reached its daily limit of N AI requests."** That's Talorys' own
guardrail; raise it in Settings → AI.

**"Too many failed attempts."** Wait 15 minutes, or reset the password with
the installer's `reset-password` command (`node packages/create-talorys/dist/cli.js reset-password --dir "<install folder>"`).

**Reminders fire at the wrong time.** Check Settings → General → Timezone.
Changing it re-schedules all automations.

**"The configured AI model is not available."** Set a supported Workers AI
model with tool calling in Settings → AI (default `@cf/zai-org/glm-4.7-flash`).

## Development

**`database is locked: SQLITE_BUSY`** — two local runtimes share a state
directory. Stop stray `wrangler` processes; the dev scripts use separate
directories for the Worker and Pages.

**Port already in use** — stop other dev servers on 5173, 8787 or 8788.

## MCP servers

See [Remote MCP servers → Troubleshooting](mcp.md#troubleshooting) for
connection, authentication and tool messages.
