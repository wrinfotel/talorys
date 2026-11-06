import { beforeEach, describe, expect, it } from "vitest";
import type { TelegramStatus } from "@talorys/shared";
import { client, inAgent, loggedIn } from "./helpers";

const TOKEN = "123456:AAQ-example-token_abcdefghij123456";
const TELEGRAM_SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";

interface BotApiCall {
  url: string;
  body: Record<string, unknown>;
}

type BotApiReply = { ok: true; result?: unknown } | { ok: false; description: string };

/** A fetcher standing in for the Telegram Bot API: always HTTP 200, `ok` in the body. */
function botApi(respond: (call: BotApiCall) => BotApiReply) {
  const sent: BotApiCall[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: BotApiCall = { url: String(input), body: init?.body ? JSON.parse(String(init.body)) : {} };
    sent.push(call);
    return new Response(JSON.stringify(respond(call)), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetcher, sent };
}

const happy = () =>
  botApi((call) => {
    if (call.url.endsWith("/getMe")) return { ok: true, result: { id: 1, username: "talorys_bot" } };
    return { ok: true, result: true };
  });

/** Connects the container's Telegram service so a webhook secret exists to test against. */
async function connected(): Promise<void> {
  await inAgent(async (agent) => {
    agent.services.telegram.fetcher = happy().fetcher;
    await agent.services.telegram.connect(TOKEN, "https://me.pages.dev");
  });
}

beforeEach(async () => {
  await inAgent((agent) => agent.services.db.run(`DELETE FROM tal_settings WHERE key LIKE 'telegram.%'`));
});

describe("telegram webhook auth", () => {
  it("rejects the webhook without or with a wrong secret header", async () => {
    const c = client();
    const update = { message: { chat: { id: 100 }, text: "hello" } };
    const missing = await c.call("/api/telegram/webhook", { method: "POST", body: update });
    expect(missing.status).toBe(401);
    const wrong = await c.call("/api/telegram/webhook", { method: "POST", body: update, headers: { [TELEGRAM_SECRET_HEADER]: "guess" } });
    expect(wrong.status).toBe(401);
  });

  it("accepts the webhook with the stored secret and processes the update in the background", async () => {
    await connected();
    const code = await inAgent((agent) => agent.services.telegram.reissuePairing().code);
    const secret = await inAgent((agent) => agent.services.telegram.webhookSecret());
    const c = client();
    const res = await c.call("/api/telegram/webhook", {
      method: "POST",
      body: { update_id: 1, message: { chat: { id: 100 }, text: `/start ${code}` } },
      headers: { [TELEGRAM_SECRET_HEADER]: secret! },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // The turn runs after the response; the pairing lands shortly after.
    let chatId: number | null = null;
    for (let i = 0; i < 50 && chatId === null; i++) {
      await new Promise((r) => setTimeout(r, 100));
      chatId = await inAgent((agent) => agent.services.telegram.allowedChatId());
    }
    expect(chatId).toBe(100);
  });
});

describe("telegram owner routes", () => {
  it("requires a session for every owner route", async () => {
    const c = client();
    expect((await c.call("/api/telegram/status")).status).toBe(401);
    expect((await c.call("/api/telegram/config", { method: "PUT", body: { token: TOKEN, webhook_base_url: "https://me.pages.dev" } })).status).toBe(401);
    expect((await c.call("/api/telegram/pair", { method: "POST", body: {} })).status).toBe(401);
    expect((await c.call("/api/telegram/config", { method: "PATCH", body: { notify_enabled: true } })).status).toBe(401);
    expect((await c.call("/api/telegram/config", { method: "DELETE" })).status).toBe(401);
  });

  it("connects, pairs, toggles notifications and disconnects for the signed-in owner", async () => {
    await connected();
    const c = await loggedIn();
    const bad = await c.call("/api/telegram/config", { method: "PUT", body: { token: "nope", webhook_base_url: "https://me.pages.dev" } });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });

    const put = await c.json<TelegramStatus>("/api/telegram/config", { method: "PUT", body: { token: TOKEN, webhook_base_url: "https://me.pages.dev" } });
    expect(put).toMatchObject({ connected: true, bot_username: "talorys_bot", paired: false, notify_enabled: true, webhook_base_url: "https://me.pages.dev" });

    const pairing = await c.json<{ code: string; expires_at: string }>("/api/telegram/pair", { method: "POST" });
    expect(pairing.code).toMatch(/^[A-Z2-9]{8}$/);
    expect(new Date(pairing.expires_at).getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);

    const patch = await c.json<TelegramStatus>("/api/telegram/config", { method: "PATCH", body: { notify_enabled: false } });
    expect(patch.notify_enabled).toBe(false);

    const del = await c.json<TelegramStatus>("/api/telegram/config", { method: "DELETE" });
    expect(del.connected).toBe(false);
    expect(del.pairing).toBeNull();
  });

  it("surfaces Telegram's rejection as a validation error without storing anything", async () => {
    const c = await loggedIn();
    await inAgent((agent) => {
      agent.services.telegram.fetcher = botApi(() => ({ ok: false, description: "Unauthorized" })).fetcher;
    });
    const res = await c.call("/api/telegram/config", { method: "PUT", body: { token: TOKEN, webhook_base_url: "https://me.pages.dev" } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "VALIDATION_ERROR", message: expect.stringContaining("Unauthorized") } });
    await inAgent(async (agent) => {
      expect(agent.services.settings.getJson("telegram.secrets")).toBeNull();
    });
  });
});

describe("telegram middleware scoping", () => {
  it("lets the webhook skip CSRF and session but opens no other route", async () => {
    await connected();
    const secret = await inAgent((agent) => agent.services.telegram.webhookSecret());
    const anonymous = client();

    // The webhook passes even with a broken CSRF header: its own secret is the check.
    const webhook = await anonymous.call("/api/telegram/webhook", {
      method: "POST",
      body: { update_id: 2, message: { chat: { id: 100 }, text: "hello" } },
      headers: { [TELEGRAM_SECRET_HEADER]: secret!, "x-talorys-request": "0" },
    });
    expect(webhook.status).toBe(200);

    // A signed-in owner request without the CSRF header is still rejected.
    const owner = await loggedIn();
    const csrfless = await owner.call("/api/tasks", { method: "POST", body: { title: "x" }, headers: { "x-talorys-request": "0" } });
    expect(csrfless.status).toBe(403);

    // Other anonymous writes stay closed, CSRF header or not.
    expect((await anonymous.call("/api/tasks", { method: "POST", body: { title: "x" }, headers: { "x-talorys-request": "1" } })).status).toBe(401);

    // The bypass is scoped to POST: a GET of the webhook path still needs a session.
    expect((await anonymous.call("/api/telegram/webhook", { headers: { [TELEGRAM_SECRET_HEADER]: secret! } })).status).toBe(401);
  });
});
