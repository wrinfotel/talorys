import { describe, expect, it } from "vitest";
import { inAgent, loggedIn } from "./helpers";

describe("web search routes", () => {
  it("reports the keyless ring without any key", async () => {
    const c = await loggedIn();
    const res = await c.call("/api/web-search", { method: "GET" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ provider: "keyless", has_tavily_key: false, has_keenable_key: false });
  });

  it("stores the Tavily key encrypted and reports it as the first provider", async () => {
    const c = await loggedIn();
    const put = await c.call("/api/web-search", { method: "PUT", body: { provider: "tavily", api_key: "tvly-1234567890abcdef" } });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ provider: "tavily", has_tavily_key: true, has_keenable_key: false });
    await inAgent(async (agent) => {
      const raw = agent.services.settings.getJson<{ tavily?: string }>("web-search.credentials");
      expect(raw?.tavily).toBeTruthy();
      expect(raw?.tavily).not.toContain("tvly-1234567890abcdef");
    });
    const get = await c.call("/api/web-search", { method: "GET" });
    expect(await get.json()).toEqual({ provider: "tavily", has_tavily_key: true, has_keenable_key: false });
  });

  it("stores the Keenable key separately; a Tavily key still leads", async () => {
    const c = await loggedIn();
    await c.call("/api/web-search", { method: "PUT", body: { provider: "keenable", api_key: "keenable-1234567890" } });
    const withBoth = await c.call("/api/web-search", { method: "PUT", body: { provider: "tavily", api_key: "tvly-1234567890abcdef" } });
    expect(await withBoth.json()).toEqual({ provider: "tavily", has_tavily_key: true, has_keenable_key: true });
    // Without the Tavily key, Keenable is the first provider.
    await c.call("/api/web-search/keenable", { method: "DELETE" });
    await c.call("/api/web-search/tavily", { method: "DELETE" });
    await c.call("/api/web-search", { method: "PUT", body: { provider: "keenable", api_key: "keenable-1234567890" } });
    const get = await c.call("/api/web-search", { method: "GET" });
    expect(await get.json()).toEqual({ provider: "keenable", has_tavily_key: false, has_keenable_key: true });
  });

  it("rejects a short key and an unknown provider", async () => {
    const c = await loggedIn();
    const short = await c.call("/api/web-search", { method: "PUT", body: { provider: "tavily", api_key: "short" } });
    expect(short.status).toBe(400);
    const unknown = await c.call("/api/web-search/nope", { method: "DELETE" });
    expect(unknown.status).toBe(400);
  });
});
