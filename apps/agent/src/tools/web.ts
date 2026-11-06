import { z } from "zod";
import { defineTool, ToolError } from "./registry";

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

/** DuckDuckGo redirect links (`//duckduckgo.com/l/?uddg=<encoded>`) unwrap to the target page. */
function unwrapDdgHref(href: string): string {
  const trimmed = href.trim();
  if (!trimmed.includes("uddg=")) return trimmed;
  try {
    const absolute = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;
    const target = new URL(absolute).searchParams.get("uddg");
    if (target) return target;
  } catch {
    // Not a redirect link after all; fall through to the raw href.
  }
  return trimmed;
}

function parseDdgResults(html: string): WebResult[] {
  const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)];
  const titles: { title: string; url: string }[] = [];
  const snippets: string[] = [];
  for (const [, attrs, inner] of anchors) {
    const classes = /class="([^"]*)"/.exec(attrs ?? "")?.[1] ?? "";
    if (classes.includes("result__a")) {
      const href = /href="([^"]*)"/.exec(attrs ?? "")?.[1] ?? "";
      titles.push({ title: stripHtml(inner ?? ""), url: unwrapDdgHref(href) });
    } else if (classes.includes("result__snippet")) {
      snippets.push(stripHtml(inner ?? ""));
    }
  }
  return titles.slice(0, MAX_SEARCH_RESULTS).map((t, index) => ({ ...t, snippet: snippets[index] ?? "" }));
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
    let res: Response;
    try {
      res = await http.fetch("https://html.duckduckgo.com/html/", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          // A descriptive agent UA: the endpoint serves plain HTML made for parsing.
          "user-agent": "Mozilla/5.0 (compatible; Talorys personal assistant)",
        },
        body: new URLSearchParams({ q: i.query }).toString(),
        signal: requestSignal(ctx),
      });
    } catch (error) {
      if (ctx.signal?.aborted) throw error;
      throw new ToolError(`Web search failed: ${error instanceof Error ? error.message : "request failed"}.`);
    }
    if (!res.ok) throw new ToolError(`Web search failed (HTTP ${res.status}) — the search engine may be rate-limiting. Try again later.`);
    const html = await readCapped(res, MAX_BODY_BYTES);
    const results = parseDdgResults(html);
    return {
      query: i.query,
      results,
      ...(results.length === 0 ? { note: "No results — the search engine may be rate-limiting. Try a different query or use web_fetch on a known URL." } : {}),
    };
  },
});

export const webTools = [webFetchTool, webSearchTool];
