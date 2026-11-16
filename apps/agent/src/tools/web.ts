import { z } from "zod";
import { TALORYS_VERSION } from "@talorys/shared";
import { defineTool, ToolError, type ToolContext } from "./registry";

/** Injectable for tests; production uses the Workers global fetch. */
export const http = {
  fetch: (...args: Parameters<typeof fetch>): Promise<Response> => fetch(...args),
};

const FETCH_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 8000;
const MAX_SEARCH_RESULTS = 6;

/**
 * Read-only access to the public web. Workers egress has no private network behind it,
 * so fetching any http(s) URL reaches only what the public internet reaches; credentials
 * and logins stay out of reach by design (prompt.ts says the same to the model).
 */
function publicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ToolError("That is not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ToolError("Only http and https URLs can be fetched.");
  return url;
}

function requestSignal(ctx: { signal?: AbortSignal }): AbortSignal {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  return ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
}

/** Reads the body as bytes, cancelling once past the cap (same approach as the API body limit). */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ToolError(`The page exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB fetch limit.`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(bytes);
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

/**
 * Best-effort HTML to text: drops scripts, styles and comments, keeps paragraph breaks.
 * Plain string processing (not HTMLRewriter) so the extraction behaves identically in tests.
 */
function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function pageTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match ? decodeEntities(match[1]!).replace(/\s+/g, " ").trim() : "";
}

const webFetchTool = defineTool({
  name: "web_fetch",
  description:
    "Read a public web page by URL and return its text. Works for http(s) pages that don't require a login. Use it to read an article, documentation, or any link the owner mentions.",
  permission: "read",
  maxCallsPerTurn: 3,
  input: z.object({ url: z.string().max(2000) }),
  label: (i) => {
    try {
      return `Fetching ${new URL(i.url.trim()).hostname}`;
    } catch {
      return "Fetching web page";
    }
  },
  execute: async (i, ctx) => {
    const url = publicHttpUrl(i.url);
    let res: Response;
    try {
      res = await http.fetch(url, { redirect: "follow", signal: requestSignal(ctx) });
    } catch (error) {
      if (ctx.signal?.aborted) throw error;
      throw new ToolError(`Couldn't fetch ${url.hostname}: ${error instanceof Error ? error.message : "request failed"}.`);
    }
    const contentType = res.headers.get("content-type") ?? "";
    const base = { url: res.url || url.toString(), status: res.status, content_type: contentType };
    if (!/text\/|json|xml|html/i.test(contentType)) {
      return { ...base, text: "", note: `Unsupported content type "${contentType.split(";")[0]}" — only text pages can be read.` };
    }
    const body = await readCapped(res, MAX_BODY_BYTES);
    const isHtml = /html/i.test(contentType) || /^\s*<!doctype html|<html[\s>]/i.test(body);
    const text = isHtml ? stripHtml(body) : body;
    const result: { url: string; status: number; content_type: string; title?: string; text: string; note?: string } = {
      ...base,
      ...(isHtml ? { title: pageTitle(body) } : {}),
      text: text.slice(0, MAX_TEXT_CHARS),
    };
    if (text.length > MAX_TEXT_CHARS) result.note = "Text was truncated; fetch a more specific page if this part isn't what you need.";
    if (res.status >= 400) result.note = `The page responded with HTTP ${res.status}.`;
    if (!text) result.note ??= "The page had no readable text.";
    return result;
  },
});

interface WebResult {
  title: string;
  url: string;
  snippet: string;
}

const NO_RESULTS_NOTE = "No results — the search engine may be rate-limiting. Try a different query or use web_fetch on a known URL.";

/** Tavily (when the owner configured a key) returns clean JSON built for agents. */
async function tavilySearch(query: string, apiKey: string, ctx: ToolContext): Promise<WebResult[]> {
  const res = await http.fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: apiKey, query, max_results: MAX_SEARCH_RESULTS, search_depth: "basic" }),
    signal: requestSignal(ctx),
  });
  if (!res.ok) {
    const detail = (await res.text()).toLowerCase();
    throw new ToolError(
      `Tavily failed (HTTP ${res.status})${detail.includes("invalid") || detail.includes("unauthorized") ? " — the API key was rejected; update it in Settings → Integrations" : ""}.`,
    );
  }
  const json = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
  return (json.results ?? [])
    .slice(0, MAX_SEARCH_RESULTS)
    .map((r) => ({ title: (r.title ?? "").trim(), url: (r.url ?? "").trim(), snippet: (r.content ?? "").trim().slice(0, 300) }))
    .filter((r) => /^https?:\/\//.test(r.url) && r.title);
}

/** Keenable (with the owner's free key: 100,000 requests a month) ranks pages on its own index. */
async function keenableSearch(query: string, apiKey: string, ctx: ToolContext): Promise<WebResult[]> {
  const res = await http.fetch("https://api.keenable.ai/v1/search", {
    method: "POST",
    headers: { "content-type": "application/json", "x-keenable-title": "Talorys", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, max_results: MAX_SEARCH_RESULTS }),
    signal: requestSignal(ctx),
  });
  if (!res.ok) {
    const detail = (await res.text()).toLowerCase();
    throw new ToolError(
      `Keenable failed (HTTP ${res.status})${detail.includes("unauthorized") || detail.includes("authentication") ? " — the API key was rejected; update it in Settings → Integrations" : ""}.`,
    );
  }
  const json = (await res.json()) as { results?: { title?: string; url?: string; description?: string; snippet?: string }[] };
  return (json.results ?? [])
    .slice(0, MAX_SEARCH_RESULTS)
    .map((r) => ({ title: (r.title ?? "").trim(), url: (r.url ?? "").trim(), snippet: (r.snippet || r.description || "").trim().slice(0, 300) }))
    .filter((r) => /^https?:\/\//.test(r.url) && r.title);
}

/** Firecrawl's anonymous cloud tier: no key, undocumented limits — a reserve, never the primary. */
async function firecrawlSearch(query: string, ctx: ToolContext): Promise<WebResult[]> {
  const res = await http.fetch("https://api.firecrawl.dev/v2/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, limit: MAX_SEARCH_RESULTS }),
    signal: requestSignal(ctx),
  });
  if (!res.ok) throw new ToolError(`Firecrawl failed (HTTP ${res.status}).`);
  const json = (await res.json()) as { data?: { web?: { url?: string; title?: string; description?: string }[] } };
  return (json.data?.web ?? [])
    .slice(0, MAX_SEARCH_RESULTS)
    .map((r) => ({ title: (r.title ?? "").trim(), url: (r.url ?? "").trim(), snippet: (r.description ?? "").trim().slice(0, 300) }))
    .filter((r) => /^https?:\/\//.test(r.url) && r.title);
}

/** One JSON-RPC message to a Streamable-HTTP MCP server; replies may be SSE-framed, so `data:` lines are parsed. */
async function mcpRpc(
  endpoint: string,
  session: string | null,
  message: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ status: number; sessionId: string | null; replies: { id?: number; result?: { content?: { type: string; text?: string }[]; isError?: boolean }; error?: { message?: string } }[] }> {
  const res = await http.fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(session ? { "mcp-session-id": session } : {}),
    },
    body: JSON.stringify(message),
    signal: requestSignal(ctx),
  });
  const sessionId = res.headers.get("mcp-session-id");
  const body = await res.text();
  if (!res.ok) throw new ToolError(`HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}.`);
  const replies: { id?: number; result?: { content?: { type: string; text?: string }[]; isError?: boolean }; error?: { message?: string } }[] = [];
  if (/^data:/m.test(body)) {
    for (const line of body.split("\n")) {
      const payload = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (payload) replies.push(JSON.parse(payload));
    }
  } else if (body.trim()) {
    replies.push(JSON.parse(body));
  }
  return { status: res.status, sessionId, replies };
}

/**
 * Minimal MCP client for the built-in keyless search servers: open a session, then call one
 * tool and return its text content. A fresh session per search keeps this stateless — the
 * handshake costs one extra round trip, far below the request's own budget.
 */
async function mcpSearchText(endpoint: string, tool: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const open = await mcpRpc(endpoint, null, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "talorys", version: TALORYS_VERSION } },
  }, ctx);
  const session = open.sessionId;
  if (!session) throw new ToolError("The search server did not open a session.");
  // The spec's post-initialize notification; servers refuse tool calls before it.
  await mcpRpc(endpoint, session, { jsonrpc: "2.0", method: "notifications/initialized" }, ctx);
  const call = await mcpRpc(endpoint, session, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } }, ctx);
  const reply = call.replies.find((m) => m.id === 2);
  const errorMessage = reply?.error?.message;
  if (errorMessage) throw new ToolError(`${errorMessage.slice(0, 200)}.`);
  const text = reply?.result?.content?.find((c) => c.type === "text")?.text;
  if (reply?.result?.isError || text === undefined) throw new ToolError("The search server returned no usable answer.");
  return text;
}

/**
 * Exa's MCP tool replies in text blocks ("Title: …\nURL: …\nPublished: …\nAuthor: …\nHighlights: …"),
 * not JSON. `Published` and `Author` lines come and go — only Title and URL are relied on.
 */
function parseExaText(text: string): WebResult[] {
  const results: WebResult[] = [];
  for (const block of text.split(/\n\n(?=Title: )/)) {
    const title = /^Title: (.+)$/m.exec(block)?.[1]?.trim();
    const url = /^URL: (\S+)\s*$/m.exec(block)?.[1]?.trim();
    if (!title || !url || !/^https?:\/\//.test(url)) continue;
    const highlights = (/(?:^|\n)Highlights:\n?([\s\S]*)$/.exec(block)?.[1] ?? "").trim();
    results.push({ title, url, snippet: highlights.replace(/\s+\n/g, "\n").slice(0, 300) });
    if (results.length >= MAX_SEARCH_RESULTS) break;
  }
  return results;
}

/** Parallel's MCP tool wraps a JSON document in its text content. */
function parseParallelText(text: string): WebResult[] {
  let parsed: { results?: { url?: string; title?: string; excerpts?: string[] }[] };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return [];
  }
  return (parsed.results ?? [])
    .slice(0, MAX_SEARCH_RESULTS)
    .map((r) => ({ title: (r.title ?? "").trim(), url: (r.url ?? "").trim(), snippet: (r.excerpts ?? []).join("\n").trim().slice(0, 300) }))
    .filter((r) => /^https?:\/\//.test(r.url) && r.title);
}

async function exaSearch(query: string, ctx: ToolContext): Promise<WebResult[]> {
  const text = await mcpSearchText("https://mcp.exa.ai/mcp", "web_search_exa", { query, numResults: MAX_SEARCH_RESULTS }, ctx);
  return parseExaText(text);
}

/** Parallel refuses a search without both arguments: the objective frames it, the queries drive it. */
async function parallelSearch(query: string, ctx: ToolContext): Promise<WebResult[]> {
  const text = await mcpSearchText("https://search.parallel.ai/mcp", "web_search", {
    objective: `Find authoritative sources answering: ${query}`,
    search_queries: [query],
  }, ctx);
  return parseParallelText(text);
}

/** The built-in fallback: Bing's plain HTML results (Workers egress can't reach DuckDuckGo — it sits behind Cloudflare). */
async function bingSearch(query: string, ctx: ToolContext): Promise<WebResult[]> {
  const res = await http.fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&count=10`, {
    headers: {
      // Bing serves a parseable no-JS page to plain browser UAs; a bare agent UA gets less complete results.
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    },
    signal: requestSignal(ctx),
  });
  if (!res.ok) throw new ToolError(`Web search failed (HTTP ${res.status}) — the search engine may be rate-limiting. Try again later.`);
  const html = await readCapped(res, MAX_BODY_BYTES);
  return parseBingResults(html);
}

/**
 * Bing wraps result links in `/ck/a` redirects whose `u` parameter is "a1" followed by
 * the base64url-encoded target page.
 */
function unwrapBingHref(href: string): string {
  const trimmed = href.trim();
  if (!trimmed.includes("/ck/a")) return trimmed;
  try {
    const target = new URL(trimmed, "https://www.bing.com").searchParams.get("u");
    if (target?.startsWith("a1")) {
      const b64 = target.slice(2).replace(/-/g, "+").replace(/_/g, "/");
      const decoded = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
      if (/^https?:\/\//.test(decoded)) return decoded;
    }
  } catch {
    // Not a decodable redirect link; fall through to the raw href.
  }
  return trimmed;
}

function parseBingResults(html: string): WebResult[] {
  const results: WebResult[] = [];
  for (const block of html.split('<li class="b_algo').slice(1)) {
    const chunk = block.slice(0, block.indexOf("</li>"));
    const anchor = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(chunk);
    if (!anchor) continue;
    const url = unwrapBingHref(anchor[1]!);
    const title = stripHtml(anchor[2] ?? "");
    if (!/^https?:\/\//.test(url) || !title) continue;
    const paragraph = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(chunk);
    results.push({ title, url, snippet: paragraph ? stripHtml(paragraph[1] ?? "") : "" });
    if (results.length >= MAX_SEARCH_RESULTS) break;
  }
  return results;
}

const webSearchTool = defineTool({
  name: "web_search",
  description:
    "Search the public web and return result titles, URLs and short snippets. Use it for current events, facts you don't know, or when the owner asks to look something up. Follow up with web_fetch to read a promising result.",
  permission: "read",
  maxCallsPerTurn: 2,
  input: z.object({ query: z.string().min(1).max(400) }),
  label: (i) => `Web search “${i.query.trim().slice(0, 60)}”`,
  summarize: (result) => {
    if (typeof result !== "object" || result === null || !("provider" in result) || typeof result.provider !== "string") return "";
    return `via ${result.provider}`;
  },
  execute: async (i, ctx) => {
    // The search ring, in preference order: a provider the owner stored a key for (Tavily,
    // Keenable) leads, the keyless ring (Exa, Parallel — MCP; Firecrawl — anonymous REST)
    // follows, and Bing's plain-HTML results are the always-available last resort. Any
    // provider failure — rate limit, rejected key, 5xx, garbage answer — hands the query to
    // the next one; the first that answers wins and the failures ride along as a note.
    const tavily = await ctx.services.webSearch.tavilyKey();
    const keenable = await ctx.services.webSearch.keenableKey();
    const ring: { name: string; run: () => Promise<WebResult[]> }[] = [
      ...(tavily ? [{ name: "tavily", run: () => tavilySearch(i.query, tavily, ctx) }] : []),
      ...(keenable ? [{ name: "keenable", run: () => keenableSearch(i.query, keenable, ctx) }] : []),
      { name: "exa", run: () => exaSearch(i.query, ctx) },
      { name: "parallel", run: () => parallelSearch(i.query, ctx) },
      { name: "firecrawl", run: () => firecrawlSearch(i.query, ctx) },
    ];
    const failed: string[] = [];
    for (const attempt of ring) {
      try {
        const results = await attempt.run();
        const note = [
          ...(failed.length ? [`After ${failed.join("; ")} — answered by ${attempt.name}.`] : []),
          ...(results.length === 0 ? [NO_RESULTS_NOTE] : []),
        ]
          .join(" ")
          .trim();
        return { provider: attempt.name, query: i.query, results, ...(note ? { note } : {}) };
      } catch (error) {
        if (ctx.signal?.aborted) throw error;
        failed.push(`${attempt.name} failed (${error instanceof Error ? error.message : "error"})`);
      }
    }
    const results = await bingSearch(i.query, ctx);
    const note = [
      ...(failed.length ? [`After ${failed.join("; ")} — used the built-in fallback search.`] : []),
      ...(results.length === 0 ? [NO_RESULTS_NOTE] : []),
    ]
      .join(" ")
      .trim();
    return { provider: "bing" as const, query: i.query, results, ...(note ? { note } : {}) };
  },
});

export const webTools = [webFetchTool, webSearchTool];
