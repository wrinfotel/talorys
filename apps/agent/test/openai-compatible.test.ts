import { describe, expect, it } from "vitest";
import { z } from "zod";
import { classifyOpenAiCompatibleError, OpenAICompatibleProvider } from "../src/ai/openai-compatible";
import { UnavailableAiProvider, type AgentEvent, type GenerateRequest, type ToolRequest } from "../src/ai/provider";

const CONFIG = { baseUrl: "https://api.example.com/v1", apiKey: "sk-custom-test-key", model: "test-model" };
const request: GenerateRequest = { system: "Keep answers short.", messages: [{ role: "user", content: "hello" }], maxOutputTokens: 100 };

interface RecordedCall {
  url: string;
  authorization: string | null;
  body: unknown;
}

/** A fetch mock that answers each request from a scripted list and records what was sent. */
function scriptedFetch(responses: { status?: number; body?: unknown; contentType?: string }[]) {
  const calls: RecordedCall[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = responses[calls.length] ?? { status: 500, body: "no scripted response" };
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(input),
      authorization: headers["Authorization"] ?? headers["authorization"] ?? null,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response(typeof response.body === "string" ? response.body : JSON.stringify(response.body ?? {}), {
      status: response.status ?? 200,
      headers: { "content-type": response.contentType ?? "application/json" },
    });
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

/** An OpenAI-style SSE response body for streaming tests. */
function sseResponse(chunks: unknown[]): Response {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const chunk = (delta: unknown, extra: Record<string, unknown> = {}) => ({
  id: "chunk",
  object: "chat.completion.chunk",
  choices: [{ index: 0, delta, finish_reason: null }],
  ...extra,
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const result: AgentEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function toolRequest(): ToolRequest {
  return {
    ...request,
    tools: [
      {
        name: "lookup",
        description: "Look up the owner's saved details",
        inputSchema: z.object({ query: z.string() }),
        execute: async () => ({ result: "tool result" }),
      },
    ],
    maxIterations: 3,
    toolBudgetExhausted: () => false,
  };
}

describe("OpenAI-compatible provider", () => {
  it("generate() maps the text and the reported usage, sending the key as a bearer token", async () => {
    const { fetch, calls } = scriptedFetch([
      { body: { choices: [{ message: { role: "assistant", content: "hello there" } }], usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } } } },
    ]);
    const result = await new OpenAICompatibleProvider({ ...CONFIG, fetch }).generate(request);
    expect(result.text).toBe("hello there");
    expect(result.usage).toMatchObject({
      model: "test-model",
      billable: true,
      inputTokens: { reported: 12, estimated: 0 },
      outputTokens: { reported: 3, estimated: 0 },
    });
    expect(result.usage.cachedInputTokens).toBe(4);
    expect(calls[0]!.url).toBe("https://api.example.com/v1/chat/completions");
    expect(calls[0]!.authorization).toBe("Bearer sk-custom-test-key");
    // The stored key must never leak into a request body.
    expect(JSON.stringify(calls[0]!.body)).not.toContain("sk-custom-test-key");
  });

  it("generate() estimates a missing usage direction from characters", async () => {
    const { fetch } = scriptedFetch([{ body: { choices: [{ message: { role: "assistant", content: "answer text here" } }] } }]);
    const result = await new OpenAICompatibleProvider({ ...CONFIG, fetch }).generate(request);
    expect(result.usage.inputTokens).toEqual({ reported: 0, estimated: expect.any(Number) });
    expect(result.usage.outputTokens).toEqual({ reported: 0, estimated: expect.any(Number) });
    expect(result.usage.inputTokens.estimated).toBeGreaterThan(0);
    expect(result.usage.outputTokens.estimated).toBeGreaterThan(0);
  });

  it("generateWithTools() streams text deltas, runs the tool cycle and reports usage per finish-step", async () => {
    let call = 0;
    const fetch = async (): Promise<Response> => {
      const streams = [
        [
          chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: '{"query":"hello"}' } }] }),
          { id: "chunk", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 20, completion_tokens: 6 } },
        ],
        [
          chunk({ content: "Final " }),
          chunk({ content: "answer" }),
          { id: "chunk", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 30, completion_tokens: 2 } },
        ],
      ];
      return sseResponse(streams[call++]!);
    };
    const events = await collect(new OpenAICompatibleProvider({ ...CONFIG, fetch }).generateWithTools(toolRequest()));
    const types = events.map((e) => e.type);
    expect(types).toContain("tool-start");
    expect(types).toContain("tool-end");
    expect(types.filter((t) => t === "text")).toEqual(["text", "text"]);
    expect(
      events
        .filter((e) => e.type === "text")
        .map((e) => (e as { delta: string }).delta)
        .join(""),
    ).toBe("Final answer");
    const toolEnd = events.find((e) => e.type === "tool-end") as { output: unknown };
    expect(toolEnd.output).toEqual({ result: "tool result" });
    const usages = events.filter((e) => e.type === "usage").map((e) => (e as { usage: { inputTokens: { reported: number }; outputTokens: { reported: number } } }).usage);
    expect(usages).toHaveLength(2);
    expect(usages[0]!.inputTokens.reported).toBe(20);
    expect(usages[1]!.inputTokens.reported).toBe(30);
  });

  it("maps provider failures: 401 key, 402 quota, 429 rate limit, unknown model, non-JSON generic", async () => {
    const cases: { status: number; body: unknown; contentType?: string; code: string; message: RegExp }[] = [
      { status: 401, body: { error: { message: "Invalid API key provided" } }, code: "AI_UNAVAILABLE", message: /rejected the API key/ },
      { status: 402, body: { error: { message: "Insufficient credits to run this model" } }, code: "AI_QUOTA_EXHAUSTED", message: /balance or quota/ },
      { status: 429, body: { error: { message: "Too many requests" } }, code: "AI_UNAVAILABLE", message: /rate limited/ },
      { status: 404, body: { error: { message: "No endpoints found for test-model" } }, code: "AI_UNAVAILABLE", message: /model is not available on the custom provider/ },
      { status: 500, body: "<html>gateway error</html>", contentType: "text/html", code: "AI_UNAVAILABLE", message: /could not respond/ },
    ];
    for (const c of cases) {
      const { fetch } = scriptedFetch([{ status: c.status, body: c.body, contentType: c.contentType }]);
      await expect(new OpenAICompatibleProvider({ ...CONFIG, fetch }).generate(request)).rejects.toMatchObject({
        code: c.code,
        message: expect.stringMatching(c.message),
      });
    }
  });

  it("maps a quota failure raised in plain text without a usable status", async () => {
    const { fetch } = scriptedFetch([{ status: 400, body: { error: { message: "You have exceeded your monthly quota" } } }]);
    await expect(new OpenAICompatibleProvider({ ...CONFIG, fetch }).generate(request)).rejects.toMatchObject({ code: "AI_QUOTA_EXHAUSTED" });
  });

  it("classifies aborts as cancellations", () => {
    expect(classifyOpenAiCompatibleError(new Error("This operation was aborted"))).toMatchObject({ code: "AI_UNAVAILABLE", message: "The response was cancelled." });
  });

  it("keeps the daily budget contract: every call is billable", () => {
    expect(new OpenAICompatibleProvider(CONFIG).billable).toBe(true);
    expect(new OpenAICompatibleProvider(CONFIG).id).toBe("openai-compatible");
    expect(new OpenAICompatibleProvider(CONFIG).model).toBe("test-model");
  });
});

describe("UnavailableAiProvider", () => {
  const provider = new UnavailableAiProvider();
  const toolReq: ToolRequest = { ...request, tools: [], maxIterations: 1, toolBudgetExhausted: () => true };
  const failure = { code: "NOT_CONFIGURED", message: /Re-save the API key in Settings/ };

  it("fails all three methods with the explicit re-save error and no fallback", async () => {
    await expect(provider.generate(request)).rejects.toMatchObject(failure);
    await expect(collect(provider.stream(request))).rejects.toMatchObject(failure);
    await expect(collect(provider.generateWithTools(toolReq))).rejects.toMatchObject(failure);
    expect(provider.id).toBe("unavailable");
    expect(provider.billable).toBe(false);
    expect(provider.model).toBe("unavailable");
  });
});
