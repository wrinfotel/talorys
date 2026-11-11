import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractLeakedToolCalls, stripToolMarkup, withLeakedToolRecovery } from "../src/agent/leaked-tools";
import type { AgentEvent, AIProvider, GenerateRequest, ToolRequest, Usage } from "../src/ai/provider";

const stubTool = (name: string, execute: (input: unknown) => Promise<unknown>) => ({ name, description: "stub", inputSchema: z.object({}), execute });

const dotsLeak = `<dots_function_call>
<invoke name="web_fetch">
<parameter name="url">https://www.kommersant.ru/theme/2912</parameter>
</invoke>
</dots_function_call>`;

const nemotronLeak = `<tool_call>
<function=web_search>
<parameter=query>новости ИИ 10 ноября 2026 искусственный интеллект релиз модель</parameter>
</function>
</tool_call>`;

const usage = (): Usage => ({
  model: "stub",
  billable: false,
  inputTokens: { reported: 10, estimated: 0 },
  outputTokens: { reported: 5, estimated: 0 },
  cachedInputTokens: 0,
});

/** A provider that replays a fixed script of rounds. */
function stubProvider(rounds: { text?: string; calls?: { id: string; name: string; input: unknown }[] }[]): {
  provider: AIProvider;
  requests: ToolRequest[];
} {
  let round = 0;
  const requests: ToolRequest[] = [];
  const provider: AIProvider = {
    id: "stub",
    model: "stub-model",
    billable: false,
    async generate(_req: GenerateRequest) {
      return { text: "", usage: usage() };
    },
    // biome-ignore lint/correctness/useYield: test stub, never streams
    async *stream() {
      return;
    },
    async *generateWithTools(req: ToolRequest): AsyncGenerator<AgentEvent> {
      requests.push(req);
      const script = rounds[Math.min(round, rounds.length - 1)];
      round += 1;
      if (script?.text) for (const delta of script.text.split(/(?<=\n)/)) yield { type: "text", delta };
      for (const call of script?.calls ?? []) {
        yield { type: "tool-start", id: call.id, name: call.name, input: call.input };
        yield { type: "tool-end", id: call.id, name: call.name, output: { ok: true } };
      }
      yield { type: "usage", usage: usage() };
    },
  };
  return { provider, requests };
}

describe("extractLeakedToolCalls", () => {
  it("parses dots-style invoke blocks and strips them", () => {
    const scan = extractLeakedToolCalls(dotsLeak);
    expect(scan.calls).toEqual([{ name: "web_fetch", args: { url: "https://www.kommersant.ru/theme/2912" } }]);
    expect(scan.cleanText).toBe("");
  });

  it("parses nemotron-style function blocks", () => {
    const scan = extractLeakedToolCalls(nemotronLeak);
    expect(scan.calls).toEqual([{ name: "web_search", args: { query: "новости ИИ 10 ноября 2026 искусственный интеллект релиз модель" } }]);
    expect(scan.cleanText).toBe("");
  });

  it("parses blocks truncated by the token limit", () => {
    const scan = extractLeakedToolCalls(`<tool_call> <function=web_search> <parameter=query> новости ИИ 10 ноября 2026`);
    expect(scan.calls).toEqual([{ name: "web_search", args: { query: "новости ИИ 10 ноября 2026" } }]);
    const truncated = extractLeakedToolCalls(`<dots_function_call>\n<invoke name="notify_owner">\n<parameter name="title">AI news`);
    expect(truncated.calls).toEqual([{ name: "notify_owner", args: { title: "AI news" } }]);
    expect(truncated.cleanText).toBe("");
  });

  it("parses Qwen/GLM-style JSON tool calls", () => {
    const scan = extractLeakedToolCalls('<tool_call>\n{"name": "get_weather", "arguments": {"city": "Paris"}}\n</tool_call>');
    expect(scan.calls).toEqual([{ name: "get_weather", args: { city: "Paris" } }]);
  });

  it("parses anthropic-style function_calls wrappers", () => {
    const scan = extractLeakedToolCalls(`<function_calls><invoke name="notify_owner"><parameter name="title">Hi</parameter><parameter name="body">B</parameter></invoke></function_calls>`);
    expect(scan.calls).toEqual([{ name: "notify_owner", args: { title: "Hi", body: "B" } }]);
  });

  it("keeps prose around markup and coerces JSON parameter values", () => {
    const scan = extractLeakedToolCalls(`Вот что нашёл:\n${dotsLeak}\nИщу дальше.`);
    expect(scan.calls).toEqual([{ name: "web_fetch", args: { url: "https://www.kommersant.ru/theme/2912" } }]);
    expect(scan.cleanText).toBe("Вот что нашёл:\n\nИщу дальше.");
    const withJson = extractLeakedToolCalls('<function_calls><invoke name="t"><parameter name="options">{"a":1}</parameter></invoke></function_calls>');
    expect(withJson.calls[0]?.args).toEqual({ options: { a: 1 } });
  });

  it("leaves plain text alone, even when it mentions tag-like words", () => {
    const plain = "I used tool_call and invoke name in prose, no markup here. 1 < 2.";
    expect(extractLeakedToolCalls(plain)).toEqual({ calls: [], cleanText: plain });
  });

  it("deduplicates identical calls and handles several blocks", () => {
    const scan = extractLeakedToolCalls(`${dotsLeak}${dotsLeak}${nemotronLeak}`);
    expect(scan.calls.map((c) => c.name)).toEqual(["web_fetch", "web_search"]);
  });

  it("stripToolMarkup only rewrites markup-shaped text", () => {
    expect(stripToolMarkup(dotsLeak)).toBe("");
    expect(stripToolMarkup("Обычный ответ без разметки.")).toBe("Обычный ответ без разметки.");
  });
});

describe("withLeakedToolRecovery", () => {
  it("executes leaked calls through the request tools and feeds results back", async () => {
    const executed: { name: string; input: unknown }[] = [];
    const req: ToolRequest = {
      system: "s",
      messages: [{ role: "user", content: "найди новости" }],
      tools: [
        stubTool("web_search", (input) => {
          executed.push({ name: "web_search", input });
          return Promise.resolve({ provider: "bing", results: [] });
        }),
      ],
      maxIterations: 3,
      maxOutputTokens: 600,
      toolBudgetExhausted: () => false,
      reserveNextStep: () => true,
    };
    const leak = `<dots_function_call>\n<invoke name="web_search">\n<parameter name="query">AI news</parameter>\n</invoke>\n</dots_function_call>`;
    const { provider, requests } = stubProvider([{ text: leak }, { text: "Готово: новости собраны." }]);
    const events: AgentEvent[] = [];
    for await (const event of withLeakedToolRecovery(provider, req)) events.push(event);
    expect(executed).toEqual([{ name: "web_search", input: { query: "AI news" } }]);
    expect(requests.length).toBe(2);
    const continuation = requests[1]?.messages.at(-1);
    expect(continuation?.role).toBe("user");
    expect(continuation?.content).toContain("executed on your behalf");
    expect(continuation?.content).toContain("web_search");
    expect(events.filter((e) => e.type === "tool-start").map((e) => (e as { name: string }).name)).toEqual(["web_search"]);
  });

  it("does not recover when the model leaked nothing", async () => {
    const req: ToolRequest = {
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      tools: [stubTool("web_search", () => Promise.resolve({}))],
      maxIterations: 3,
      maxOutputTokens: 600,
      toolBudgetExhausted: () => false,
    };
    const { provider, requests } = stubProvider([{ text: "Просто ответ без вызовов." }]);
    for await (const _event of withLeakedToolRecovery(provider, req)) void _event;
    expect(requests.length).toBe(1);
  });

  it("forces a text-only round when every round leaks markup", async () => {
    const executed: string[] = [];
    const req: ToolRequest = {
      system: "s",
      messages: [{ role: "user", content: "найди новости" }],
      tools: [
        stubTool("web_search", (input) => {
          executed.push(JSON.stringify(input));
          return Promise.resolve({ ok: true });
        }),
      ],
      maxIterations: 10,
      maxOutputTokens: 600,
      toolBudgetExhausted: () => false,
      reserveNextStep: () => true,
    };
    const mkLeak = (q: string) => `<tool_call><function=web_search><parameter=query>${q}</parameter></function></tool_call>`;
    const { provider, requests } = stubProvider([
      { text: mkLeak("ai news 1") },
      { text: mkLeak("ai news 2") },
      { text: mkLeak("ai news 3") },
      { text: "Свежие новости: релиз модели X." },
    ]);
    const events: AgentEvent[] = [];
    for await (const event of withLeakedToolRecovery(provider, req)) events.push(event);
    expect(executed).toEqual(['{"query":"ai news 1"}', '{"query":"ai news 2"}']);
    const forced = requests[3];
    expect(forced?.tools).toEqual([]);
    expect(forced?.messages.at(-1)?.content).toContain("Stop calling tools");
    const texts = events
      .filter((e) => e.type === "text")
      .map((e) => (e as { delta: string }).delta)
      .join("");
    expect(texts).toContain("Свежие новости");
  });

  it("reports an error result instead of executing past the tool budget", async () => {
    const req: ToolRequest = {
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        stubTool("web_search", () => Promise.reject(new Error("should not run"))),
      ],
      maxIterations: 3,
      maxOutputTokens: 600,
      toolBudgetExhausted: () => true,
      reserveNextStep: () => true,
    };
    const leak = `<tool_call><function=web_search><parameter=query>more news</parameter></function></tool_call>`;
    const { provider, requests } = stubProvider([{ text: leak }, { text: "Ок, отвечаю тем, что есть." }]);
    const events: AgentEvent[] = [];
    for await (const event of withLeakedToolRecovery(provider, req)) events.push(event);
    const end = events.find((e) => e.type === "tool-end") as { error?: string } | undefined;
    expect(end?.error).toContain("limit");
    expect(requests[1]?.messages.at(-1)?.content).toContain("NOT EXECUTED");
  });

  it("rescues a textless round with structured results in a fresh context", async () => {
    const req: ToolRequest = {
      system: "s",
      messages: [{ role: "user", content: "найди новости" }],
      tools: [stubTool("web_search", () => Promise.resolve({ provider: "bing", results: [{ title: "Модель X" }] }))],
      maxIterations: 4,
      maxOutputTokens: 600,
      toolBudgetExhausted: () => false,
      reserveNextStep: () => true,
    };
    // Round 0: the model makes structured calls and never writes prose (a reasoning
    // model starved by the token cap), so the whole turn would end "(No output)".
    const { provider, requests } = stubProvider([{ calls: [{ id: "c1", name: "web_search", input: { query: "ai" } }] }, { text: "Итог: модель X вышла сегодня." }]);
    const events: AgentEvent[] = [];
    for await (const event of withLeakedToolRecovery(provider, req)) events.push(event);
    expect(requests.length).toBe(2);
    const rescue = requests[1];
    expect(rescue?.tools).toEqual([]);
    expect(rescue?.messages.length).toBe(1);
    const content = String(rescue?.messages[0]?.content);
    expect(content).toContain("найди новости");
    expect(content).toContain("web_search");
    expect(content).toContain('{"ok":true}');
    const texts = events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("");
    expect(texts).toContain("Итог: модель X вышла сегодня.");
  });

  it("rescues in a fresh context when even the forced no-tools round leaks markup", async () => {
    const req: ToolRequest = {
      system: "s",
      messages: [{ role: "user", content: "найди новости" }],
      tools: [stubTool("web_search", (input) => Promise.resolve({ query: input }))],
      maxIterations: 10,
      maxOutputTokens: 600,
      toolBudgetExhausted: () => false,
      reserveNextStep: () => true,
    };
    const mkLeak = (q: string) => `<tool_call><function=web_search><parameter=query>${q}</parameter></function></tool_call>`;
    const { provider, requests } = stubProvider([
      { text: mkLeak("ai news 1") },
      { text: mkLeak("ai news 2") },
      { text: mkLeak("ai news 3") },
      { text: mkLeak("ai news 4") },
      { text: "Свежие новости: релиз модели Y." },
    ]);
    const events: AgentEvent[] = [];
    for await (const event of withLeakedToolRecovery(provider, req)) events.push(event);
    // 3 recovery rounds + the forced no-tools round (still markup) + the fresh rescue.
    expect(requests.length).toBe(5);
    const rescue = requests[4];
    expect(rescue?.tools).toEqual([]);
    expect(rescue?.messages.length).toBe(1);
    const content = String(rescue?.messages[0]?.content);
    expect(content).toContain("найди новости");
    // The exhausted round's own calls are dropped; earlier executed results are in.
    expect(content).toContain("ai news 2");
    expect(content).not.toContain("ai news 3");
    const texts = events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("");
    expect(texts).toContain("Свежие новости: релиз модели Y.");
  });

  it("retries a textless round with no results in a fresh context", async () => {
    const req: ToolRequest = {
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      tools: [stubTool("web_search", () => Promise.resolve({}))],
      maxIterations: 3,
      maxOutputTokens: 600,
      toolBudgetExhausted: () => false,
      reserveNextStep: () => true,
    };
    // Degenerate completions (a token of reasoning, no content) are transient on some
    // free routes: the rescue retries the bare task in a fresh conversation.
    const { provider, requests } = stubProvider([{ text: "" }, { text: "Вот ответ." }]);
    const events: AgentEvent[] = [];
    for await (const event of withLeakedToolRecovery(provider, req)) events.push(event);
    expect(requests.length).toBe(2);
    const rescue = requests[1];
    expect(rescue?.tools).toEqual([]);
    const content = String(rescue?.messages[0]?.content);
    expect(content).toContain("hi");
    expect(content).not.toContain("Tool results already collected");
    const texts = events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("");
    expect(texts).toContain("Вот ответ.");
  });
});
