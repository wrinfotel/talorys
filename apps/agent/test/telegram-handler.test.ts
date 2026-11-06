import { beforeEach, describe, expect, it } from "vitest";
import type { ChatStreamEvent } from "@talorys/shared";
import type { TalorysAgent } from "../src/agent/talorys-agent";
import type { AgentRunner } from "../src/agent/runner";
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
      expect(replies(api)[1]).toContain("/help");
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
      await processUpdate({ services: agent.services, runner: () => fakeRunner(events), activeRuns: agent.activeRuns }, update("tell me everything"));
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
      await processUpdate({ services: agent.services, runner: () => fakeRunner(events), activeRuns: agent.activeRuns }, update("hello"));
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
      await processUpdate({ services: agent.services, runner: () => fakeRunner(events), activeRuns: agent.activeRuns }, update("hello"));
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
      const pending = processUpdate({ services: agent.services, runner: () => runner, activeRuns: agent.activeRuns }, update("hello"));
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
      await expect(processUpdate({ services: agent.services, runner: () => runner, activeRuns: agent.activeRuns }, update("hello"))).resolves.toBeUndefined();
      expect(replies(api)).toEqual(["Something went wrong."]);
    });
  });
});
