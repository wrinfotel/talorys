import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { ChatStreamEvent } from "@talorys/shared";
import type { TalorysAgent } from "../src/agent/talorys-agent";
import type { AgentRunner } from "../src/agent/runner";
import { SecretBox } from "../src/services/secret-box";
import { agentDeps, processUpdate, type TelegramUpdate } from "../src/telegram/handler";
import { inAgent } from "./helpers";

const TOKEN = "123456:AAQ-example-token_abcdef";
const CHAT = 100;

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

/** A runner stub whose single chat turn emits the given events, for reply-shaping tests. */
function fakeRunner(events: ChatStreamEvent[]): AgentRunner {
  return {
    chat: () =>
      (async function* () {
        yield* events;
      })(),
  } as unknown as AgentRunner;
}

const start = (conversationId: string): ChatStreamEvent => ({
  type: "start",
  conversation_id: conversationId,
  user_message_id: "u",
  assistant_message_id: "a",
});

const update = (text: string, chatId = CHAT): TelegramUpdate => ({ message: { chat: { id: chatId }, text } });

/** The texts of every sendMessage the stub has seen so far. */
const replies = (api: ReturnType<typeof happy>) => api.sent.filter((c) => c.url.endsWith("/sendMessage")).map((c) => c.body.text as string);

/** Connects the bot through the container service. The chat is not paired until the test pairs it. */
async function connected(agent: TalorysAgent): Promise<ReturnType<typeof happy>> {
  const api = happy();
  agent.services.telegram.fetcher = api.fetcher;
  await agent.services.telegram.connect(TOKEN, "https://me.pages.dev");
  return api;
}

beforeEach(async () => {
  await inAgent((agent) => {
    agent.services.db.run(`DELETE FROM tal_settings WHERE key LIKE 'telegram.%'`);
    agent.services.db.run(`DELETE FROM tal_messages`);
    agent.services.db.run(`DELETE FROM tal_conversations`);
    agent.services.db.run(`DELETE FROM tal_activity`);
    // Quota counters are daily and would otherwise leak into later tests in the same store.
    agent.services.db.run(`DELETE FROM tal_usage_daily`);
  });
});

describe("telegram pairing", () => {
  it("links the chat after /start with the current code, and spends the code", async () => {
    await inAgent(async (agent) => {
      const api = await connected(agent);
      const t = agent.services.telegram;
      const { code } = t.reissuePairing();
      await processUpdate(agentDeps(agent), update(`/start ${code}`));
      expect(replies(api)).toEqual(["Paired! This chat is now linked to your Talorys agent."]);
      expect(t.allowedChatId()).toBe(CHAT);
      expect(t.activePairing()).toBeNull();
    });
  });

  it("answers a stale code with the private hint and does not pair", async () => {
    await inAgent(async (agent) => {
      const api = await connected(agent);
      const t = agent.services.telegram;
      const stale = t.reissuePairing();
      const current = t.reissuePairing();
      t.settings.setJson("telegram.pairing", { code: current.code, expires_at: new Date(Date.now() - 1000).toISOString() });
      for (const code of [stale.code, current.code]) {
        await processUpdate(agentDeps(agent), update(`/start ${code}`));
        expect(t.allowedChatId()).toBeNull();
      }
      expect(replies(api)).toHaveLength(2);
      expect(replies(api)[0]).toBe("This bot is private. Generate a pairing code in Talorys → Settings → Integrations and send /start <code>.");
    });
  });

  it("ignores messages without a /start code from unlinked chats", async () => {
    await inAgent(async (agent) => {
      const api = await connected(agent);
      for (const text of ["hello", "/start", "/start lowercase", "/start 12345678"]) {
        await processUpdate(agentDeps(agent), update(text));
      }
      expect(replies(api)).toHaveLength(0);
      expect(agent.services.telegram.allowedChatId()).toBeNull();
    });
  });
});

describe("telegram owner chat", () => {
  it("silently ignores other chats and records the attempt", async () => {
    await inAgent(async (agent) => {
      const api = await connected(agent);
      agent.services.telegram.setPaired(CHAT);
      await processUpdate(agentDeps(agent), update("hello", 200));
      expect(replies(api)).toHaveLength(0);
      expect(agent.services.activity.list()).toEqual([expect.objectContaining({ type: "telegram.stranger" })]);
    });
  });

  it("ignores updates without a message or without text", async () => {
    await inAgent(async (agent) => {
      const api = await connected(agent);
      agent.services.telegram.setPaired(CHAT);
      await processUpdate(agentDeps(agent), {});
      await processUpdate(agentDeps(agent), { message: { chat: { id: CHAT }, text: "   " } });
      expect(replies(api)).toHaveLength(0);
    });
  });

  it("/new drops the remembered conversation and /help lists the commands", async () => {
    await inAgent(async (agent) => {
      const api = await connected(agent);
      agent.services.telegram.setPaired(CHAT);
      const t = agent.services.telegram;
      t.rememberConversation("c-old");
      await processUpdate(agentDeps(agent), update("/new"));
      expect(replies(api)).toEqual(["Started a new conversation."]);
      expect(t.conversationId()).toBeUndefined();

      await processUpdate(agentDeps(agent), update("/help"));
      expect(replies(api)[1]).toContain("/new");
      expect(replies(api)[1]).toContain("/resume");
      expect(replies(api)[1]).toContain("/status");
      expect(replies(api)[1]).toContain("/help");
    });
  });

  it("/status reports the model, web search and notification state", async () => {
    await inAgent(async (agent) => {
      const api = await connected(agent);
      const t = agent.services.telegram;
      t.setPaired(CHAT);
      await processUpdate(agentDeps(agent), update("/status"));
      expect(replies(api)[0]).toContain("Cloudflare Workers AI (the built-in free model)");
      expect(replies(api)[0]).toContain("Web search: built-in (no API key)");
      expect(replies(api)[0]).toContain("Notifications to this chat: on");

      await t.setNotifyEnabled(false);
      await processUpdate(agentDeps(agent), update("/status"));
      expect(replies(api)[1]).toContain("Notifications to this chat: off");

      // A custom provider with a readable key shows the model name.
      const key = (env as unknown as { MCP_CREDENTIAL_KEY: string }).MCP_CREDENTIAL_KEY;
      const box = new SecretBox(key, "ai-provider");
      agent.services.settings.setJson("ai.credentials", { credential: await box.encrypt("key", "sk-or-test") });
      agent.services.settings.update({ aiProvider: { baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini" } });
      await processUpdate(agentDeps(agent), update("/status"));
      expect(replies(api)[2]).toContain("Model: openai/gpt-4o-mini (your custom provider)");

      // An unreadable key (e.g. a rotated deployment secret) names the fix instead.
      agent.services.settings.setJson("ai.credentials", { credential: "v1.garbage" });
      await processUpdate(agentDeps(agent), update("/status"));
      expect(replies(api)[3]).toContain("the API key is unreadable, save it again in Settings → AI");
    });
  });

  it("/resume lists recent conversations and /resume <n> switches to one", async () => {
    await inAgent(async (agent) => {
      const api = await connected(agent);
      agent.services.telegram.setPaired(CHAT);
      const t = agent.services.telegram;

      await processUpdate(agentDeps(agent), update("/resume"));
      expect(replies(api)[0]).toBe("No conversations yet — just send me a message to start one.");

      const older = agent.services.conversations.create("Watering the plants");
      const newer = agent.services.conversations.create("Trip to Japan");
      // Distinct timestamps: list() orders by updated_at, and two same-ms creates would tie.
      agent.services.db.run(`UPDATE tal_conversations SET updated_at = '2026-11-07T10:00:00.000Z' WHERE id = ?`, older.id);
      agent.services.db.run(`UPDATE tal_conversations SET updated_at = '2026-11-07T12:00:00.000Z' WHERE id = ?`, newer.id);

      await processUpdate(agentDeps(agent), update("/resume"));
      const list = replies(api)[1]!;
      expect(list).toContain("1. Trip to Japan");
      expect(list).toContain("2. Watering the plants");

      await processUpdate(agentDeps(agent), update("/resume 2"));
      expect(replies(api)[2]).toContain("Switched to “Watering the plants”.");
      expect(t.conversationId()).toBe(older.id);

      // The listing marks the conversation the chat now continues.
      await processUpdate(agentDeps(agent), update("/resume"));
      expect(replies(api)[3]).toMatch(/2\. Watering the plants .*← here/);
      expect(replies(api)[3]).not.toMatch(/1\. Trip to Japan.*← here/);

      await processUpdate(agentDeps(agent), update("/resume 9"));
      expect(replies(api)[4]).toBe("There's no conversation number 9 on the list — send /resume to see the recent ones.");

      // A plain message after the switch continues the chosen conversation, not the newest.
      await processUpdate(agentDeps(agent), update("hello again"));
      expect(agent.services.conversations.messages(older.id).some((m) => m.role === "user" && m.content === "hello again")).toBe(true);
      expect(agent.services.conversations.messages(newer.id).some((m) => m.content === "hello again")).toBe(false);
    });
  });

  it("/context and /compact report and shrink the current conversation's context", async () => {
    await inAgent(async (agent) => {
      const api = await connected(agent);
      agent.services.telegram.setPaired(CHAT);
      const conv = agent.services.conversations.create("Long chat");
      agent.services.telegram.rememberConversation(conv.id);
      for (let i = 0; i < 12; i++) {
        agent.services.conversations.addMessage({ conversation_id: conv.id, role: "user", content: `question number ${i}` });
        agent.services.conversations.addMessage({ conversation_id: conv.id, role: "assistant", content: `answer number ${i}` });
      }
      // Instant inserts can share one millisecond; distinct times make the summary boundary strict.
      const history = agent.services.conversations.messages(conv.id);
      for (const [i, m] of history.entries()) {
        agent.services.db.run(`UPDATE tal_messages SET created_at = ? WHERE id = ?`, new Date(Date.parse("2026-11-07T12:00:00.000Z") + i * 60_000).toISOString(), m.id);
      }

      await processUpdate(agentDeps(agent), update("/context"));
      expect(replies(api)[0]).toContain("Context of “Long chat”");
      expect(replies(api)[0]).toContain("24 of 24 messages");
      expect(replies(api)[0]).toContain("Summary: none yet");

      await processUpdate(agentDeps(agent), update("/compact"));
      expect(replies(api)[1]).toContain("Compacted: 18 messages folded into the summary.");
      expect(replies(api)[1]).toContain("The window is now 6 messages");
      expect(agent.services.conversations.get(conv.id)!.summary).toBeTruthy();

      await processUpdate(agentDeps(agent), update("/context"));
      expect(replies(api)[2]).toContain("6 of 24 messages");
      expect(replies(api)[2]).toContain("Summary: ");
    });
  });

  it("/context and /compact speak up when there is nothing to report", async () => {
    await inAgent(async (agent) => {
      const api = await connected(agent);
      agent.services.telegram.setPaired(CHAT);
      await processUpdate(agentDeps(agent), update("/context"));
      expect(replies(api)[0]).toContain("No conversation is going on in this chat yet");
      await processUpdate(agentDeps(agent), update("/compact"));
      expect(replies(api)[1]).toContain("No conversation is going on in this chat yet");

      const conv = agent.services.conversations.create("Short");
      agent.services.telegram.rememberConversation(conv.id);
      agent.services.conversations.addMessage({ conversation_id: conv.id, role: "user", content: "hi" });
      await processUpdate(agentDeps(agent), update("/compact"));
      expect(replies(api)[2]).toBe("Nothing to compact — this conversation is short and fits comfortably.");
    });
  });

  it("/compact refuses while the conversation is busy and without daily AI budget", async () => {
    await inAgent(async (agent) => {
      const api = await connected(agent);
      agent.services.telegram.setPaired(CHAT);
      const conv = agent.services.conversations.create("Chat");
      agent.services.telegram.rememberConversation(conv.id);

      agent.activeRuns.set(conv.id, new AbortController());
      await processUpdate(agentDeps(agent), update("/compact"));
      expect(replies(api)[0]).toBe("I'm still answering your previous message — one at a time for now.");
      agent.activeRuns.delete(conv.id);

      const limits = agent.services.settings.get().limits;
      agent.services.usage.increment({ ai_requests: limits.maxAiRequestsPerDay });
      await processUpdate(agentDeps(agent), update("/compact"));
      expect(replies(api)[1]).toContain("daily AI limit");
    });
  });

  it("registers the / command menu on the first owner message when connect missed it", async () => {
    await inAgent(async (agent) => {
      let menuFails = true;
      const api = botApi((call) => {
        if (call.url.endsWith("/getMe")) return { ok: true, result: { id: 1, username: "talorys_bot" } };
        if (call.url.endsWith("/setMyCommands")) return menuFails ? { ok: false, description: "Busy" } : { ok: true, result: true };
        return { ok: true, result: true };
      });
      agent.services.telegram.fetcher = api.fetcher;
      await agent.services.telegram.connect(TOKEN, "https://me.pages.dev"); // menu registration fails here
      agent.services.telegram.setPaired(CHAT);

      // Telegram recovered; the next message registers the menu in the background.
      menuFails = false;
      await processUpdate(agentDeps(agent), update("hello there"));
      await agent.services.telegram.idle();
      expect(api.sent.filter((c) => c.url.endsWith("/setMyCommands"))).toHaveLength(3); // 1 failed at connect + 2 now
      expect(agent.services.telegram.commandsRegistered()).toBe(true);
      expect(agent.services.telegram.conversationId()).toEqual(expect.any(String));
    });
  });

  it("runs an agent turn on a plain message and remembers the conversation", async () => {
    await inAgent(async (agent) => {
      const api = await connected(agent);
      agent.services.telegram.setPaired(CHAT);
      await processUpdate(agentDeps(agent), update("hello there"));
      const texts = replies(api);
      expect(texts).toHaveLength(1);
      expect(texts[0]).toContain(`You said: "hello there"`);
      const stored = agent.services.telegram.conversationId();
      expect(stored).toEqual(expect.any(String));
      expect(agent.services.conversations.get(stored!)!.title).toBe("hello there");
      expect(texts[0]!.length).toBeLessThanOrEqual(4096);
    });
  });

  it("politely refuses while the conversation already has a run", async () => {
    await inAgent(async (agent) => {
      const api = await connected(agent);
      agent.services.telegram.setPaired(CHAT);
      await processUpdate(agentDeps(agent), update("first message"));
      const stored = agent.services.telegram.conversationId()!;
      agent.activeRuns.set(stored, new AbortController());
      await processUpdate(agentDeps(agent), update("second message"));
      expect(replies(api)[1]).toBe("I'm still answering your previous message — one at a time for now.");
      expect(agent.services.conversations.messages(stored)).toHaveLength(2);
    });
  });
});

describe("telegram turn replies", () => {
  it("sends a long agent answer as several messages", async () => {
    await inAgent(async (agent) => {
      const api = await connected(agent);
      agent.services.telegram.setPaired(CHAT);
      const long = "x".repeat(6000);
      const events: ChatStreamEvent[] = [start("c1"), { type: "text", delta: long }];
      await processUpdate({ services: agent.services, runner: async () => fakeRunner(events), activeRuns: agent.activeRuns }, update("tell me everything"));
      const texts = replies(api);
      expect(texts.length).toBeGreaterThanOrEqual(2);
      for (const text of texts) expect(text.length).toBeLessThanOrEqual(4096);
    });
  });

  it("answers with the classified error text when the turn fails", async () => {
    await inAgent(async (agent) => {
      const api = await connected(agent);
      agent.services.telegram.setPaired(CHAT);
      const events: ChatStreamEvent[] = [start("c1"), { type: "error", code: "AI_QUOTA_EXHAUSTED", message: "Daily AI quota reached." }];
      await processUpdate({ services: agent.services, runner: async () => fakeRunner(events), activeRuns: agent.activeRuns }, update("hello"));
      expect(replies(api)).toEqual(["Daily AI quota reached."]);
    });
  });

  it("answers with a short apology when the turn produced nothing", async () => {
    await inAgent(async (agent) => {
      const api = await connected(agent);
      agent.services.telegram.setPaired(CHAT);
      const events: ChatStreamEvent[] = [
        start("c1"),
        { type: "done", message: { id: "a", conversation_id: "c1", role: "assistant", content: "", tools: [], status: "complete", error: null, created_at: "" } },
      ];
      await processUpdate({ services: agent.services, runner: async () => fakeRunner(events), activeRuns: agent.activeRuns }, update("hello"));
      expect(replies(api)).toEqual(["The AI model could not respond. Try again in a moment."]);
    });
  });

  it("sends nothing for an aborted turn and releases the conversation claim", async () => {
    await inAgent(async (agent) => {
      const api = await connected(agent);
      agent.services.telegram.setPaired(CHAT);
      const events: ChatStreamEvent[] = [start("c1"), { type: "text", delta: "partial answer" }];
      // A runner that holds the turn open until it is aborted, like a real provider would.
      const runner = {
        chat: (input: { signal: AbortSignal }) =>
          (async function* () {
            yield* events;
            while (!input.signal.aborted) await new Promise((r) => setTimeout(r, 10));
          })(),
      } as unknown as AgentRunner;
      const pending = processUpdate({ services: agent.services, runner: async () => runner, activeRuns: agent.activeRuns }, update("hello"));
      // The claim is visible to /api/chat/cancel as soon as the turn is registered.
      await new Promise((r) => setTimeout(r, 50));
      expect(agent.activeRuns.get("c1")).toBeInstanceOf(AbortController);
      agent.activeRuns.get("c1")!.abort();
      await pending;
      expect(replies(api)).toHaveLength(0);
      expect(agent.activeRuns.has("c1")).toBe(false);
    });
  });

  it("catches turn exceptions and answers once, without throwing", async () => {
    await inAgent(async (agent) => {
      const api = await connected(agent);
      agent.services.telegram.setPaired(CHAT);
      const runner = {
        chat: () =>
          (async function* () {
            yield start("c1");
            throw new Error("boom");
          })(),
      } as unknown as AgentRunner;
      await expect(processUpdate({ services: agent.services, runner: async () => runner, activeRuns: agent.activeRuns }, update("hello"))).resolves.toBeUndefined();
      expect(replies(api)).toEqual(["Something went wrong."]);
    });
  });
});
