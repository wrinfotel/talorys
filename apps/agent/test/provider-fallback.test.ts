import { beforeEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/runner";
import type { AgentEvent, AIProvider } from "../src/ai/provider";
import { UnavailableAiProvider } from "../src/ai/provider";
import { inAgent } from "./helpers";

beforeEach(async () => {
  // The activity log persists across tests in the same store; fallback records from one
  // test must not leak into another's assertions.
  await inAgent((agent) => agent.services.db.run(`DELETE FROM tal_activity`));
});

const USAGE = { model: "m", billable: false, inputTokens: { reported: 1, estimated: 0 }, outputTokens: { reported: 1, estimated: 0 }, cachedInputTokens: 0 };

/** A provider whose model call fails, optionally after streaming some text first. */
class FailingProvider implements AIProvider {
  readonly billable = false;
  constructor(
    readonly id: string,
    readonly model: string,
    private readonly after?: string,
  ) {}
  async generate(): Promise<{ text: string; usage: typeof USAGE }> {
    throw new Error("provider down");
  }
  async *stream(): AsyncIterable<AgentEvent> {
    yield* this.generateWithTools();
  }
  async *generateWithTools(): AsyncIterable<AgentEvent> {
    if (this.after) yield { type: "text", delta: this.after };
    throw new Error("provider down");
  }
}

class WorkingProvider implements AIProvider {
  readonly id = "workers-ai";
  readonly model = "fallback-model";
  readonly billable = false;
  async generate(): Promise<{ text: string; usage: typeof USAGE }> {
    return { text: "ok", usage: USAGE };
  }
  async *stream(): AsyncIterable<AgentEvent> {
    yield* this.generateWithTools();
  }
  async *generateWithTools(): AsyncIterable<AgentEvent> {
    yield { type: "text", delta: "ok" };
    yield { type: "usage", usage: USAGE };
  }
}

/** A provider that reports usage but streams no text and no tool calls: an empty success. */
class EmptyProvider implements AIProvider {
  readonly billable = false;
  constructor(
    readonly id: string,
    readonly model: string,
  ) {}
  async generate(): Promise<{ text: string; usage: typeof USAGE }> {
    return { text: "", usage: USAGE };
  }
  async *stream(): AsyncIterable<AgentEvent> {
    yield* this.generateWithTools();
  }
  async *generateWithTools(): AsyncIterable<AgentEvent> {
    yield { type: "usage", usage: USAGE };
  }
}

/** Streams tool activity and usage but never any prose: "did the work", wrote nothing. */
class ToolsThenSilenceProvider implements AIProvider {
  readonly id = "custom";
  readonly model = "paid-model";
  readonly billable = false;
  async generate(): Promise<{ text: string; usage: typeof USAGE }> {
    return { text: "", usage: USAGE };
  }
  async *stream(): AsyncIterable<AgentEvent> {
    yield* this.generateWithTools();
  }
  async *generateWithTools(): AsyncIterable<AgentEvent> {
    yield { type: "tool-start", id: "t1", name: "list_reminders", input: {} };
    yield { type: "tool-end", id: "t1", name: "list_reminders", output: [] };
    yield { type: "usage", usage: USAGE };
  }
}

async function turn(runner: AgentRunner) {
  const events: { type: string; [k: string]: unknown }[] = [];
  for await (const e of runner.chat({ message: "hi", signal: new AbortController().signal })) events.push(e as { type: string });
  return events;
}

describe("provider fallback", () => {
  it("falls back to Workers AI when a custom provider fails before answering", async () => {
    await inAgent(async (agent) => {
      const runner = new AgentRunner(agent.services, new FailingProvider("custom", "paid-model"), undefined, [], new WorkingProvider());
      const events = await turn(runner);
      expect(events.filter((e) => e.type === "text").map((e) => e.delta).join("")).toBe("ok");
      expect(events.at(-1)).toMatchObject({ type: "done", message: { status: "complete" } });
      expect(agent.services.activity.list(5).some((a) => a.type === "ai.fallback")).toBe(true);
    });
  });

  it("does not retry once anything was streamed", async () => {
    await inAgent(async (agent) => {
      const runner = new AgentRunner(agent.services, new FailingProvider("custom", "paid-model", "partial "), undefined, [], new WorkingProvider());
      const events = await turn(runner);
      expect(events.some((e) => e.type === "error")).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: "done", message: { status: "error" } });
      expect(agent.services.activity.list(5).some((a) => a.type === "ai.fallback")).toBe(false);
    });
  });

  it("keeps the explicit error when the custom key is unreadable instead of silently falling back", async () => {
    await inAgent(async (agent) => {
      const runner = new AgentRunner(agent.services, new UnavailableAiProvider(), undefined, [], new WorkingProvider());
      const events = await turn(runner);
      expect(events.some((e) => e.type === "error" && String((e as { message?: string }).message).includes("Re-save"))).toBe(true);
    });
  });

  it("answers normally when the primary provider works", async () => {
    await inAgent(async (agent) => {
      const runner = new AgentRunner(agent.services, new WorkingProvider(), undefined, [], new WorkingProvider());
      const events = await turn(runner);
      expect(events.at(-1)).toMatchObject({ type: "done", message: { status: "complete" } });
      expect(agent.services.activity.list(5).some((a) => a.type === "ai.fallback")).toBe(false);
    });
  });

  it("falls back when the provider streams usage but no text in chat", async () => {
    await inAgent(async (agent) => {
      const runner = new AgentRunner(agent.services, new EmptyProvider("custom", "paid-model"), undefined, [], new WorkingProvider());
      const events = await turn(runner);
      expect(events.filter((e) => e.type === "text").map((e) => e.delta).join("")).toBe("ok");
      expect(events.at(-1)).toMatchObject({ type: "done", message: { status: "complete" } });
      expect(agent.services.activity.list(5).some((a) => a.type === "ai.fallback")).toBe(true);
    });
  });

  it("ends with the no-response placeholder when even the fallback streams nothing in chat", async () => {
    await inAgent(async (agent) => {
      const runner = new AgentRunner(agent.services, new EmptyProvider("custom", "paid-model"), undefined, [], new EmptyProvider("workers-ai", "fallback-model"));
      const events = await turn(runner);
      expect(events.at(-1)).toMatchObject({
        type: "done",
        message: { status: "complete", content: "I wasn't able to produce a response. Please try rephrasing." },
      });
    });
  });
});

describe("provider fallback for scheduled runs", () => {
  beforeEach(async () => {
    // Usage counters (including the scheduled-run budget) persist across tests.
    await inAgent((agent) => agent.services.db.run(`DELETE FROM tal_usage_daily`));
  });

  it("falls back to Workers AI when the provider fails during a scheduled run", async () => {
    await inAgent(async (agent) => {
      const runner = new AgentRunner(agent.services, new FailingProvider("custom", "paid-model"), undefined, [], new WorkingProvider());
      expect(await runner.runScheduledPrompt("digest")).toBe("ok");
      expect(agent.services.activity.list(5).some((a) => a.type === "ai.fallback")).toBe(true);
    });
  });

  it("falls back when the provider streams usage but no text", async () => {
    await inAgent(async (agent) => {
      const runner = new AgentRunner(agent.services, new EmptyProvider("custom", "paid-model"), undefined, [], new WorkingProvider());
      expect(await runner.runScheduledPrompt("digest")).toBe("ok");
      expect(agent.services.activity.list(5).some((a) => a.type === "ai.fallback")).toBe(true);
    });
  });

  it("falls back when the provider ran tools but never wrote prose", async () => {
    await inAgent(async (agent) => {
      const runner = new AgentRunner(agent.services, new ToolsThenSilenceProvider(), undefined, [], new WorkingProvider());
      expect(await runner.runScheduledPrompt("digest")).toBe("ok");
      expect(agent.services.activity.list(5).some((a) => a.type === "ai.fallback")).toBe(true);
    });
  });

  it("keeps the failure when the primary streamed real text and then broke", async () => {
    await inAgent(async (agent) => {
      const runner = new AgentRunner(agent.services, new FailingProvider("custom", "paid-model", "partial "), undefined, [], new WorkingProvider());
      await expect(runner.runScheduledPrompt("digest")).rejects.toThrow();
      expect(agent.services.activity.list(5).some((a) => a.type === "ai.fallback")).toBe(false);
    });
  });

  it("does not fall back when the primary provider works", async () => {
    await inAgent(async (agent) => {
      const runner = new AgentRunner(agent.services, new WorkingProvider(), undefined, [], new WorkingProvider());
      expect(await runner.runScheduledPrompt("digest")).toBe("ok");
      expect(agent.services.activity.list(5).some((a) => a.type === "ai.fallback")).toBe(false);
    });
  });
});
