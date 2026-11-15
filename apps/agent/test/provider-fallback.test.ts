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
});
