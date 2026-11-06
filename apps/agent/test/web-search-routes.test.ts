import { describe, expect, it } from "vitest";
import { inAgent, loggedIn } from "./helpers";

describe("web search routes", () => {
  it("reports the built-in provider without a key", async () => {
    const c = await loggedIn();
    const res = await c.call("/api/web-search", { method: "GET" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ provider: "bing", has_api_key: false });
  });

  it("stores the key encrypted and reports tavily", async () => {
    const c = await loggedIn();
    const put = await c.call("/api/web-search", { method: "PUT", body: { api_key: "tvly-1234567890abcdef" } });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ provider: "tavily", has_api_key: true });
    await inAgent(async (agent) => {
      const raw = agent.services.settings.getJson<{ credential?: string }>("web-search.credentials");
      expect(raw?.credential).toBeTruthy();
      expect(raw?.credential).not.toContain("tvly-1234567890abcdef");
    });
    const get = await c.call("/api/web-search", { method: "GET" });
    expect(await get.json()).toEqual({ provider: "tavily", has_api_key: true });
  });

  it("rejects a short key", async () => {
    const c = await loggedIn();
    const res = await c.call("/api/web-search", { method: "PUT", body: { api_key: "short" } });
    expect(res.status).toBe(400);
  });
});
