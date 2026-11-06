import { z } from "zod";
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
  execute: async (i, ctx) => {
    // Tavily when the owner configured a key; every Tavily failure falls back to the built-in
    // Bing results, so the owner still gets an answer instead of a dead end.
    const apiKey = await ctx.services.webSearch.apiKey();
    if (apiKey) {
      try {
        const results = await tavilySearch(i.query, apiKey, ctx);
        return { provider: "tavily" as const, query: i.query, results, ...(results.length === 0 ? { note: NO_RESULTS_NOTE } : {}) };
      } catch (error) {
        if (ctx.signal?.aborted) throw error;
        const results = await bingSearch(i.query, ctx);
        return {
          provider: "bing" as const,
          query: i.query,
          results,
          note: `Tavily failed (${error instanceof Error ? error.message : "error"}); used the built-in fallback search.`,
        };
      }
    }
    const results = await bingSearch(i.query, ctx);
    return { provider: "bing" as const, query: i.query, results, ...(results.length === 0 ? { note: NO_RESULTS_NOTE } : {}) };
  },
});

export const webTools = [webFetchTool, webSearchTool];
