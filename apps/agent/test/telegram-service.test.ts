import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { TalorysAgent } from "../src/agent/talorys-agent";
import type { Notification } from "@talorys/shared";
import { SecretBox } from "../src/services/secret-box";
import { splitMessage, telegramNotificationText, TelegramService } from "../src/telegram/service";
import { inAgent } from "./helpers";

const TOKEN = "123456:AAQ-example-token_abcdef";

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

const notification = (title: string, body: string): Notification => ({
  id: "n1",
  title,
  body,
  automation_id: null,
  read_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
});

/** A service over the agent's settings store, with the test deployment's secret key. */
function makeTelegram(agent: TalorysAgent, fetcher: typeof fetch): TelegramService {
  const key = (env as unknown as { MCP_CREDENTIAL_KEY: string }).MCP_CREDENTIAL_KEY;
  const t = new TelegramService(agent.services.settings, new SecretBox(key, "telegram"), () => {});
  t.fetcher = fetcher;
  return t;
}

beforeEach(async () => {
  await inAgent((agent) => agent.services.db.run(`DELETE FROM tal_settings WHERE key LIKE 'telegram.%'`));
});

describe("telegram message helpers", () => {
  it("strips Markdown and collapses whitespace like push messages", () => {
    expect(telegramNotificationText({ title: "**Reminder**", body: "Call `the`  dentist   now" })).toBe("Reminder\n\nCall the dentist now");
  });

  it("clips the title and body to the notification limits", () => {
    const text = telegramNotificationText({ title: "t".repeat(200), body: "x".repeat(5000) });
    expect(text.length).toBeLessThanOrEqual(100 + 2 + 3500);
    expect(text.startsWith("t")).toBe(true);
    expect(text.endsWith("…")).toBe(true);
  });

  it("splits long text at 4096, preferring a line boundary", () => {
    expect(splitMessage("short")).toEqual(["short"]);
    const noBreak = splitMessage("a".repeat(5000));
    expect(noBreak).toHaveLength(2);
    expect(noBreak[0]).toHaveLength(4096);
    const withBreak = splitMessage(`${"a".repeat(3000)}\n${"b".repeat(3000)}`);
    expect(withBreak).toHaveLength(2);
    expect(withBreak[0]).not.toContain("\n");
    for (const chunk of withBreak) expect(chunk.length).toBeLessThanOrEqual(4096);
  });
});

describe("telegram service", () => {
  it("reports a disconnected bot with no pairing", async () => {
    await inAgent(async (agent) => {
      const status = await makeTelegram(agent, happy().fetcher).status();
      expect(status).toEqual({ connected: false, bot_username: null, paired: false, notify_enabled: null, webhook_base_url: null, pairing: null });
    });
  });

  it("connects: validates the token, registers the webhook and stores only encrypted secrets", async () => {
    await inAgent(async (agent) => {
      const api = happy();
      const t = makeTelegram(agent, api.fetcher);
      const status = await t.connect(TOKEN, "https://me.pages.dev/");
      expect(api.sent.map((c) => c.url)).toEqual([
        "https://api.telegram.org/bot123456:AAQ-example-token_abcdef/getMe",
        "https://api.telegram.org/bot123456:AAQ-example-token_abcdef/setWebhook",
      ]);
      expect(api.sent[1]!.body).toMatchObject({
        url: "https://me.pages.dev/api/telegram/webhook",
        allowed_updates: ["message"],
        drop_pending_updates: true,
      });
      // Telegram only accepts secrets from [-_A-Za-z0-9]; randomToken is base64url, 43 characters.
      const secret = api.sent[1]!.body.secret_token as string;
      expect(secret).toMatch(/^[-_A-Za-z0-9]{1,256}$/);
      expect(status).toMatchObject({
        connected: true,
        bot_username: "talorys_bot",
        paired: false,
        notify_enabled: true,
        webhook_base_url: "https://me.pages.dev/",
      });
      expect(status.pairing?.code).toMatch(/^[A-Z2-9]{8}$/);

      const stored = agent.services.settings.getJson<{ token: string; webhook_secret: string }>("telegram.secrets");
      expect(stored?.token).toMatch(/^v1\./);
      expect(stored?.webhook_secret).toMatch(/^v1\./);
      expect(stored && JSON.stringify(stored)).not.toContain(TOKEN);
      expect(stored && JSON.stringify(stored)).not.toContain(secret);
      // Decryption round-trips both secrets.
      expect(await t.token()).toBe(TOKEN);
      expect(await t.webhookSecret()).toBe(secret);
    });
  });

  it("rejects a token Telegram does not accept and stores nothing", async () => {
    await inAgent(async (agent) => {
      const t = makeTelegram(agent, botApi(() => ({ ok: false, description: "Unauthorized" })).fetcher);
      await expect(t.connect("999:bad", "https://me.pages.dev")).rejects.toThrow("Unauthorized");
      expect(agent.services.settings.getJson("telegram.secrets")).toBeNull();
      expect(agent.services.settings.getJson("telegram.config")).toBeNull();
    });
  });

  it("disconnect deletes the webhook best-effort and removes every key", async () => {
    await inAgent(async (agent) => {
      const t = makeTelegram(agent, happy().fetcher);
      await t.connect(TOKEN, "https://me.pages.dev");
      const api = botApi(() => ({ ok: true, result: true }));
      t.fetcher = api.fetcher;
      const status = await t.disconnect();
      expect(status.connected).toBe(false);
      expect(api.sent[0]!.url).toContain("/deleteWebhook");
      for (const key of ["telegram.config", "telegram.secrets", "telegram.pairing", "telegram.conversation_id"]) {
        expect(agent.services.settings.getJson(key)).toBeNull();
      }
    });
  });

  it("disconnect removes the keys even when deleteWebhook fails", async () => {
    await inAgent(async (agent) => {
      const t = makeTelegram(agent, happy().fetcher);
      await t.connect(TOKEN, "https://me.pages.dev");
      t.fetcher = botApi(() => ({ ok: false, description: "Webhook not found" })).fetcher;
      const status = await t.disconnect();
      expect(status.connected).toBe(false);
      expect(agent.services.settings.getJson("telegram.secrets")).toBeNull();
    });
  });

  it("tracks the Telegram conversation id and forgets it on /new", async () => {
    await inAgent(async (agent) => {
      const t = makeTelegram(agent, happy().fetcher);
      expect(t.conversationId()).toBeUndefined();
      t.rememberConversation("c1");
      expect(t.conversationId()).toBe("c1");
      t.forgetConversation();
      expect(t.conversationId()).toBeUndefined();
    });
  });

  it("reissues pairing codes and expires old ones", async () => {
    await inAgent(async (agent) => {
      const t = makeTelegram(agent, happy().fetcher);
      await t.connect(TOKEN, "https://me.pages.dev");
      const first = t.reissuePairing();
      expect(t.activePairing()?.code).toBe(first.code);
      t.settings.setJson("telegram.pairing", { code: first.code, expires_at: new Date(Date.now() - 1000).toISOString() });
      expect(t.activePairing()).toBeNull();
      const second = t.reissuePairing();
      expect(second.code).not.toBe(first.code);
      expect(new Date(second.expires_at).getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    });
  });

  it("notify is a no-op without a paired chat, with the toggle off, or without secrets", async () => {
    await inAgent(async (agent) => {
      const api = happy();
      const t = makeTelegram(agent, api.fetcher);
      await t.connect(TOKEN, "https://me.pages.dev");
      const sends = () => api.sent.filter((c) => c.url.endsWith("/sendMessage"));

      t.notify(notification("Reminder", "Call the dentist"));
      await t.idle();
      expect(sends()).toHaveLength(0);

      t.setPaired(100);
      await t.setNotifyEnabled(false);
      t.notify(notification("Reminder", "Call the dentist"));
      await t.idle();
      expect(sends()).toHaveLength(0);
      await t.setNotifyEnabled(true);

      // Secrets gone (a rotated credential key) but the config still paired: nothing is sent.
      t.settings.setJson("telegram.secrets", { token: "v1.bogus.bogus", webhook_secret: "v1.bogus.bogus" });
      t.notify(notification("Reminder", "Call the dentist"));
      await t.idle();
      expect(sends()).toHaveLength(0);
    });
  });

  it("delivers a notification to the paired chat in the background", async () => {
    await inAgent(async (agent) => {
      const api = happy();
      const t = makeTelegram(agent, api.fetcher);
      await t.connect(TOKEN, "https://me.pages.dev");
      t.setPaired(100);
      t.notify(notification("**Reminder**", "Call `the` dentist"));
      await t.idle();
      const sends = api.sent.filter((c) => c.url.endsWith("/sendMessage"));
      expect(sends).toHaveLength(1);
      expect(sends[0]!.body).toEqual({ chat_id: 100, text: "Reminder\n\nCall the dentist" });
    });
  });

  it("never throws when delivery fails", async () => {
    await inAgent(async (agent) => {
      const t = makeTelegram(agent, happy().fetcher);
      await t.connect(TOKEN, "https://me.pages.dev");
      t.setPaired(100);
      t.fetcher = botApi(() => ({ ok: false, description: "chat not found" })).fetcher;
      expect(() => t.notify(notification("Reminder", "Call the dentist"))).not.toThrow();
      await t.idle();
    });
  });

  it("sends a message longer than Telegram's limit as several chunks", async () => {
    await inAgent(async (agent) => {
      const api = happy();
      const t = makeTelegram(agent, api.fetcher);
      await t.connect(TOKEN, "https://me.pages.dev");
      t.setPaired(100);
      await t.sendMessage(100, `${"a".repeat(3000)}\n${"b".repeat(3000)}`);
      const sends = api.sent.filter((c) => c.url.endsWith("/sendMessage"));
      expect(sends.length).toBeGreaterThanOrEqual(2);
      for (const send of sends) {
        expect((send.body.text as string).length).toBeLessThanOrEqual(4096);
        expect((send.body.chat_id as number)).toBe(100);
      }
    });
  });

  it("delivers notifications created through the repository alongside push", async () => {
    await inAgent(async (agent) => {
      const s = agent.services;
      const api = happy();
      s.telegram.fetcher = api.fetcher;
      await s.telegram.connect(TOKEN, "https://me.pages.dev");
      s.telegram.setPaired(100);
      const n = s.notifications.create({ title: "Reminder", body: "**Call** the dentist", automation_id: null });
      await s.telegram.idle();
      const sends = api.sent.filter((c) => c.url.endsWith("/sendMessage"));
      expect(sends).toHaveLength(1);
      expect(sends[0]!.body).toEqual({ chat_id: 100, text: "Reminder\n\nCall the dentist" });
      expect(n.id).toEqual(expect.any(String));
    });
  });
});
