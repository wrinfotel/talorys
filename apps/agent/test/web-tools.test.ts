import { describe, expect, it, vi } from "vitest";
import { ALL_TOOLS } from "../src/tools";
import { http, webTools } from "../src/tools/web";
import type { ImmediateTool } from "../src/tools/registry";

const ctx = { services: {} as never, timezone: "UTC", mode: "chat" as const };
const webFetch = webTools[0] as ImmediateTool;
const webSearch = webTools[1] as ImmediateTool;

/** Runs a tool and returns its result; `execute` lives only on immediate tools, which both of these are. */
function run(tool: unknown, input: unknown): Promise<unknown> {
  return Promise.resolve((tool as ImmediateTool).execute(input, ctx));
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
  const ddgHtml = `
    <div class="result">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone&amp;rut=abc">First  result</a>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone">The &amp; first snippet</a>
    </div>
    <div class="result">
      <a rel="nofollow" class="result__a" href="https://direct.example.com/two">Second result</a>
      <a class="result__snippet" href="https://direct.example.com/two">Second snippet</a>
    </div>`;

  it("parses results and unwraps redirect links", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(ddgHtml));
    http.fetch = fetchMock as unknown as typeof fetch;
    const result = (await run(webSearch, { query: "test query" })) as { results: { title: string; url: string; snippet: string }[] };
    expect(fetchMock.mock.calls[0]![1]!.body).toContain("q=test+query");
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toEqual({ title: "First result", url: "https://example.com/one", snippet: "The & first snippet" });
    expect(result.results[1]!.url).toBe("https://direct.example.com/two");
  });

  it("returns a note when nothing was parsed", async () => {
    http.fetch = vi.fn().mockResolvedValue(okResponse("<html><body>Anomaly detected</body></html>")) as unknown as typeof fetch;
    const result = (await run(webSearch, { query: "anything" })) as { results: unknown[]; note?: string };
    expect(result.results).toHaveLength(0);
    expect(result.note).toContain("No results");
  });

  it("maps HTTP blocks to a tool error", async () => {
    http.fetch = vi.fn().mockResolvedValue(new Response("", { status: 403 })) as unknown as typeof fetch;
    await expect(webSearch.execute({ query: "test" }, ctx)).rejects.toThrow("HTTP 403");
  });
});
