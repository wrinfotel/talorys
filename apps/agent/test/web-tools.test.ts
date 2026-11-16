import { describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../src/agent/runner";
import type { AgentEvent, AIProvider } from "../src/ai/provider";
import { ALL_TOOLS } from "../src/tools";
import { http, webTools } from "../src/tools/web";
import type { ImmediateTool, ToolContext } from "../src/tools/registry";
import { inAgent } from "./helpers";

const ctx = {
  services: { webSearch: { tavilyKey: async () => null, keenableKey: async () => null } },
  timezone: "UTC",
  mode: "chat" as const,
} as unknown as ToolContext;
/** A context whose owner has a Tavily key configured. */
const tavilyCtx = {
  services: { webSearch: { tavilyKey: async () => "tvly-test-key-0000000000", keenableKey: async () => null } },
  timezone: "UTC",
  mode: "chat" as const,
} as unknown as ToolContext;
/** A context whose owner has a Keenable key configured. */
const keenableCtx = {
  services: { webSearch: { tavilyKey: async () => null, keenableKey: async () => "kntest-test-key-000000" } },
  timezone: "UTC",
  mode: "chat" as const,
} as unknown as ToolContext;
const webFetch = webTools[0] as ImmediateTool;
const webSearch = webTools[1] as ImmediateTool;

/** Runs a tool and returns its result; `execute` lives only on immediate tools, which both of these are. */
function run(tool: unknown, input: unknown, context = ctx): Promise<unknown> {
  return Promise.resolve((tool as ImmediateTool).execute(input, context));
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><title>${title}</title><style>body{color:red}</style></head><body><script>evil()</script>${body}</body></html>`;
}

function okResponse(body: string, contentType = "text/html; charset=utf-8"): Response {
  return new Response(body, { status: 200, headers: { "content-type": contentType } });
}

describe("web tools registration", () => {
  it("registers both read-only tools", () => {
    for (const name of ["web_fetch", "web_search"]) {
      const tool = ALL_TOOLS.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool!.permission).toBe("read");
      expect(tool!.external).toBeUndefined();
    }
    expect(webTools).toHaveLength(2);
  });
});

describe("web_fetch", () => {
  it("extracts readable text, drops scripts and styles, keeps the title", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(page("Example title", "<p>Hello   world</p><p>Second &amp; last</p>")));
    http.fetch = fetchMock as unknown as typeof fetch;
    const result = (await run(webFetch, { url: "https://example.com/a" })) as { title: string; text: string; status: number };
    expect(result.title).toBe("Example title");
    expect(result.status).toBe(200);
    expect(result.text).toContain("Hello world");
    expect(result.text).toContain("Second & last");
    expect(result.text).not.toContain("evil");
    expect(result.text).not.toContain("color:red");
    expect(fetchMock.mock.calls[0]![0]).toBeInstanceOf(URL);
  });

  it("passes non-HTML text through without stripping", async () => {
    http.fetch = vi.fn().mockResolvedValue(okResponse('{"hello":"world"}', "application/json")) as unknown as typeof fetch;
    const result = (await run(webFetch, { url: "https://example.com/data.json" })) as { text: string; title?: string };
    expect(result.text).toBe('{"hello":"world"}');
    expect(result.title).toBeUndefined();
  });

  it("refuses non-http schemes", async () => {
    http.fetch = vi.fn() as unknown as typeof fetch;
    await expect(webFetch.execute({ url: "file:///etc/passwd" }, ctx)).rejects.toThrow("Only http and https");
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it("reports fetch failures as tool errors", async () => {
    http.fetch = vi.fn().mockRejectedValue(new TypeError("DNS error")) as unknown as typeof fetch;
    await expect(webFetch.execute({ url: "https://no-such-host.example" }, ctx)).rejects.toThrow("Couldn't fetch");
  });

  it("caps oversized pages with a clear error", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(3 * 1024 * 1024)));
      },
    });
    http.fetch = vi.fn().mockResolvedValue(new Response(stream, { status: 200, headers: { "content-type": "text/plain" } })) as unknown as typeof fetch;
    await expect(webFetch.execute({ url: "https://example.com/huge" }, ctx)).rejects.toThrow("fetch limit");
  });

  it("notes truncation for long pages", async () => {
    const long = "word ".repeat(4000);
    http.fetch = vi.fn().mockResolvedValue(okResponse(page("Long", `<p>${long}</p>`))) as unknown as typeof fetch;
    const result = (await run(webFetch, { url: "https://example.com/long" })) as { text: string; note?: string };
    expect(result.text.length).toBeLessThanOrEqual(8000);
    expect(result.note).toContain("truncated");
  });
});

describe("web_search", () => {
  // "aHR0cHM6Ly9leGFtcGxlLmNvbS9vbmU=" is base64 of https://example.com/one (Bing's /ck/a redirect payload).
  const bingHtml = `
    <li class="b_algo"><h2><a href="/ck/a?&u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS9vbmU=&ntb=1" h="ID=SERP">First  result</a></h2>
      <div class="b_caption"><p>The &amp; first snippet</p></div></li>
    <li class="b_algo"><h2><a href="https://direct.example.com/two">Second result</a></h2>
      <p>Second snippet</p></li>`;

  /** An SSE-framed JSON-RPC reply, the way both MCP search servers answer. */
  const mcpReply = (id: number, result: unknown) =>
    new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream", "mcp-session-id": "sess-1" },
    });

  /** The three HTTP calls a successful MCP search provider makes. */
  function scriptMcp(fetchMock: ReturnType<typeof vi.fn>, text: string) {
    fetchMock
      .mockResolvedValueOnce(mcpReply(1, { protocolVersion: "2025-03-26", serverInfo: { name: "search" } }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(mcpReply(2, { content: [{ type: "text", text }] }));
  }

  const exaText = [
    "Title: Limits · Cloudflare Workers docs",
    "URL: https://developers.cloudflare.com/workers/platform/limits/",
    "Published: N/A",
    "Author: N/A",
    "Highlights:",
    "Workers Free: 100,000 requests a day, 10 ms CPU.",
    "",
    "Title: Second page",
    "URL: https://example.com/two",
    "Author: nobody",
  ].join("\n");

  it("answers from Exa through the keyless MCP ring", async () => {
    const fetchMock = vi.fn();
    scriptMcp(fetchMock, exaText);
    http.fetch = fetchMock as unknown as typeof fetch;
    const result = (await run(webSearch, { query: "test query" })) as { provider: string; note?: string; results: { title: string; url: string; snippet: string }[] };
    const [initUrl, initInit] = fetchMock.mock.calls[0]!;
    expect(String(initUrl)).toBe("https://mcp.exa.ai/mcp");
    expect(JSON.parse(initInit!.body as string)).toMatchObject({ method: "initialize", params: { clientInfo: { name: "talorys" } } });
    const [, callInit] = fetchMock.mock.calls[2]!;
    expect(callInit!.headers).toMatchObject({ "mcp-session-id": "sess-1" });
    expect(JSON.parse(callInit!.body as string)).toMatchObject({ method: "tools/call", params: { name: "web_search_exa", arguments: { query: "test query", numResults: 6 } } });
    expect(result.provider).toBe("exa");
    expect(result.note).toBeUndefined();
    expect(result.results[0]).toEqual({ title: "Limits · Cloudflare Workers docs", url: "https://developers.cloudflare.com/workers/platform/limits/", snippet: "Workers Free: 100,000 requests a day, 10 ms CPU." });
    expect(result.results[1]).toEqual({ title: "Second page", url: "https://example.com/two", snippet: "" });
  });

  it("moves to Parallel when Exa fails, and notes the skip", async () => {
    const parallelJson = JSON.stringify({ search_id: "s1", results: [{ url: "https://example.com/p", title: "Parallel result", publish_date: null, excerpts: ["An excerpt from the page"] }] });
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("", { status: 500 }));
    scriptMcp(fetchMock, parallelJson);
    http.fetch = fetchMock as unknown as typeof fetch;
    const result = (await run(webSearch, { query: "test query" })) as { provider: string; note?: string; results: { title: string; url: string; snippet: string }[] };
    const [, callInit] = fetchMock.mock.calls[3]!;
    expect(String(fetchMock.mock.calls[1]![0])).toBe("https://search.parallel.ai/mcp");
    expect(JSON.parse(callInit!.body as string).params.arguments).toMatchObject({
      objective: "Find authoritative sources answering: test query",
      search_queries: ["test query"],
    });
    expect(result.provider).toBe("parallel");
    expect(result.note).toContain("exa failed");
    expect(result.results[0]).toEqual({ title: "Parallel result", url: "https://example.com/p", snippet: "An excerpt from the page" });
  });

  it("ends on Bing after the whole keyless ring fails", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("", { status: 500 }));
    fetchMock.mockResolvedValueOnce(new Response("", { status: 429 }));
    fetchMock.mockResolvedValueOnce(new Response("", { status: 503 }));
    fetchMock.mockResolvedValueOnce(okResponse(bingHtml));
    http.fetch = fetchMock as unknown as typeof fetch;
    const result = (await run(webSearch, { query: "test query" })) as { provider: string; note?: string; results: unknown[] };
    expect(result.provider).toBe("bing");
    expect(result.note).toContain("exa failed");
    expect(result.note).toContain("parallel failed");
    expect(result.note).toContain("firecrawl failed");
    expect(result.note).toContain("built-in fallback");
    expect(result.results).toHaveLength(2);
  });

  it("uses Tavily first when a key is configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [{ title: "Tavily result", url: "https://example.com/t", content: "Clean agent content" }] }), { status: 200 }),
    );
    http.fetch = fetchMock as unknown as typeof fetch;
    const result = (await run(webSearch, { query: "test query" }, tavilyCtx)) as { provider: string; results: { title: string; url: string; snippet: string }[] };
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.tavily.com/search");
    expect(JSON.parse(init!.body as string)).toMatchObject({ api_key: "tvly-test-key-0000000000", query: "test query" });
    expect(result.provider).toBe("tavily");
    expect(result.results[0]).toEqual({ title: "Tavily result", url: "https://example.com/t", snippet: "Clean agent content" });
  });

  it("falls through to the ring when Tavily rejects the key", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("Unauthorized: invalid API key", { status: 401 }));
    scriptMcp(fetchMock, exaText);
    http.fetch = fetchMock as unknown as typeof fetch;
    const result = (await run(webSearch, { query: "test query" }, tavilyCtx)) as { provider: string; note?: string; results: unknown[] };
    expect(result.provider).toBe("exa");
    expect(result.note).toContain("Tavily failed (HTTP 401");
    expect(result.results).toHaveLength(2);
  });

  it("puts Keenable first when its key is configured, and identifies the app to it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [{ title: "Keenable result", url: "https://example.com/k", description: "", snippet: "Own-index snippet" }] }), { status: 200 }),
    );
    http.fetch = fetchMock as unknown as typeof fetch;
    const result = (await run(webSearch, { query: "test query" }, keenableCtx)) as { provider: string; results: { title: string; url: string; snippet: string }[] };
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.keenable.ai/v1/search");
    expect(init!.headers).toMatchObject({ "x-keenable-title": "Talorys", authorization: "Bearer kntest-test-key-000000" });
    expect(JSON.parse(init!.body as string)).toMatchObject({ query: "test query", max_results: 6 });
    expect(result.provider).toBe("keenable");
    expect(result.results[0]).toEqual({ title: "Keenable result", url: "https://example.com/k", snippet: "Own-index snippet" });
  });

  it("reports a rejected Keenable key and moves down the ring", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('{"error":"Missing authentication"}', { status: 401 }));
    scriptMcp(fetchMock, exaText);
    http.fetch = fetchMock as unknown as typeof fetch;
    const result = (await run(webSearch, { query: "test query" }, keenableCtx)) as { provider: string; note?: string };
    expect(result.provider).toBe("exa");
    expect(result.note).toContain("Keenable failed (HTTP 401");
    expect(result.note).toContain("the API key was rejected");
  });

  it("notes an empty answer from a provider that did reply", async () => {
    const fetchMock = vi.fn();
    scriptMcp(fetchMock, "Title: A page without a usable link\nURL: not-a-url\n");
    http.fetch = fetchMock as unknown as typeof fetch;
    const result = (await run(webSearch, { query: "obscure query" })) as { provider: string; note?: string; results: unknown[] };
    expect(result.provider).toBe("exa");
    expect(result.results).toHaveLength(0);
    expect(result.note).toContain("No results");
  });

  it("maps Bing HTTP blocks to a tool error", async () => {
    http.fetch = vi.fn().mockResolvedValue(new Response("", { status: 403 })) as unknown as typeof fetch;
    await expect(webSearch.execute({ query: "test" }, ctx)).rejects.toThrow("HTTP 403");
  });

  it("parses Bing results and decodes redirect links when reached directly", async () => {
    // A fresh Response per call: each ring stage consumes the body of its own.
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(okResponse(bingHtml)));
    http.fetch = fetchMock as unknown as typeof fetch;
    const result = (await run(webSearch, { query: "test query" })) as { results: { title: string; url: string }[] };
    expect(result.results[0]).toEqual({ title: "First result", url: "https://example.com/one", snippet: "The & first snippet" });
    expect(result.results[1]!.url).toBe("https://direct.example.com/two");
  });
});

const USAGE = { model: "m", billable: false, inputTokens: { reported: 1, estimated: 0 }, outputTokens: { reported: 1, estimated: 0 }, cachedInputTokens: 0 };

/** A provider whose turn calls web_search (with a fabricated result) and then answers. */
class SearchToolProvider implements AIProvider {
  readonly id = "stub";
  readonly model = "stub-model";
  readonly billable = false;
  async generate(): Promise<{ text: string; usage: typeof USAGE }> {
    return { text: "ok", usage: USAGE };
  }
  async *stream(): AsyncIterable<AgentEvent> {
    yield* this.generateWithTools();
  }
  async *generateWithTools(): AsyncIterable<AgentEvent> {
    yield { type: "tool-start", id: "t1", name: "web_search", input: { query: "news" } };
    yield { type: "tool-end", id: "t1", name: "web_search", output: { provider: "exa", query: "news", results: [{ title: "T", url: "https://example.com/a", snippet: "s" }] } };
    yield { type: "usage", usage: USAGE };
    yield { type: "text", delta: "ok" };
  }
}

describe("tool detail for the UI", () => {
  it("attaches the search provider summary to the tool activity", async () => {
    await inAgent(async (agent) => {
      const runner = new AgentRunner(agent.services, new SearchToolProvider());
      const events: { type: string; [k: string]: unknown }[] = [];
      for await (const e of runner.chat({ message: "what is new?", signal: new AbortController().signal })) events.push(e as { type: string });
      // The turn emits the tool twice (start, then end); the last one carries the outcome.
      const tool = events.filter((e) => e.type === "tool").at(-1) as unknown as { tool: { name: string; status: string; detail?: string } };
      expect(tool.tool.name).toBe("web_search");
      expect(tool.tool.status).toBe("success");
      expect(tool.tool.detail).toBe("via exa");
    });
  });
});
