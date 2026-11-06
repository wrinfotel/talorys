# Custom AI provider

By default Talorys chat runs on **Cloudflare Workers AI**, inside your own Cloudflare account, with no extra configuration. Talorys can also send its chat through **any OpenAI-compatible chat completions API** — OpenRouter, OpenAI, Groq, Together, a self-hosted Ollama, and others. This is entirely optional: without configuring it, nothing changes.

## What changes

- Chat replies, chat summaries and scheduled agent prompts are produced by the custom model you configure.
- The daily request budget and the token counters on Settings → AI keep working as before (usage is estimated when a provider does not report token counts).
- **Clef** (the memory-conflict decision model) and **semantic recall embeddings** stay on Workers AI. They use small, cheap Workers AI models regardless of your chat provider, so the Cloudflare pricing note still applies to them.
- Demo mode, notifications, tasks, notes, memories and reminders work exactly as before.

## Enabling it

1. Open **Settings → AI → Provider**.
2. Switch the provider to **Custom (OpenAI-compatible)**.
3. Fill in:
   - **Base URL** — any OpenAI-compatible API root, e.g. `https://openrouter.ai/api/v1`.
   - **Model** — the model id your provider exposes, e.g. `openai/gpt-4o-mini`.
   - **API key** — paste the key from your provider's dashboard. It is stored encrypted and never shown again; to replace it, paste a new one and save.
4. Press **Test** to verify the combination with a tiny one-off request (it is not counted against your usage or daily budget). The result — or the provider's error, classified into a readable message — is shown inline.
5. Press **Save**. Chat immediately runs on the custom provider. Press **Disconnect** to stop using it: Talorys returns to Workers AI and deletes the stored key.

The API key is write-only. The browser and the API never receive it back — the status endpoint only reports whether a readable key is stored (`has_api_key`).

## Examples

### OpenRouter

| Field | Value |
| --- | --- |
| Base URL | `https://openrouter.ai/api/v1` |
| Model | `openai/gpt-4o-mini` |
| API key | an OpenRouter key from <https://openrouter.ai/keys> |

### OpenAI

| Field | Value |
| --- | --- |
| Base URL | `https://api.openai.com/v1` |
| Model | `gpt-4o-mini` |
| API key | an OpenAI API key |

### Local Ollama

| Field | Value |
| --- | --- |
| Base URL | `http://localhost:11434/v1` |
| Model | e.g. `llama3.1:8b` |
| API key | any non-empty value (Ollama ignores it) |

**Note:** Talorys runs as a Cloudflare Worker, so the base URL must be reachable **from Cloudflare's network**, not only from your machine. A local `localhost` Ollama instance is unreachable from a deployed Worker; expose it through a public hostname (for example a Cloudflare Tunnel to your machine) and use that URL as the base URL.

## Error messages

Provider failures are classified into readable messages instead of raw HTTP dumps:

| Situation | What you see |
| --- | --- |
| Key rejected (401/403) | "The custom provider rejected the API key. Check it in Settings → AI." |
| Balance/quota exhausted (402 or quota text) | A message about the provider's balance or quota. |
| Rate limited (429) | A rate-limit message; try again shortly. |
| Model not available (404 or unknown-model text) | "The configured model is not available on the custom provider. Check it in Settings → AI." |
| Anything else | A general "could not respond" message; details are logged on the server. |

If the stored key cannot be decrypted (for example after restoring a backup or rotating the `MCP_CREDENTIAL_KEY` secret), chat fails with an explicit "re-save the API key" error — Talorys never silently falls back to Workers AI while a custom provider is configured.

## How the key is stored

The API key is encrypted with AES-256-GCM before it touches the database. The encryption key is derived (HKDF-SHA256, purpose `ai-provider`) from the `MCP_CREDENTIAL_KEY` Worker secret that the installer sets up. The ciphertext is stored as an internal record (`ai.credentials`) in the agent's private SQLite database inside your Durable Object — it is never exported with backups and never sent to the browser. The base URL and model id are stored as ordinary settings.
