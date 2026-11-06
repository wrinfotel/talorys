import { webSearchKeySchema } from "@talorys/shared";
import { Hono } from "hono";
import type { AppEnv } from "../app";
import { body } from "../middleware";

/** Owner-only status and key management for the web_search tool's optional Tavily backend. */
export const webSearchRoutes = new Hono<AppEnv>();

webSearchRoutes.get("/web-search", async (c) => {
  const key = await c.env.agent.services.webSearch.apiKey();
  return c.json({ provider: key ? "tavily" : "bing", has_api_key: key !== null });
});

webSearchRoutes.put("/web-search", async (c) => {
  const input = await body(c, webSearchKeySchema);
  await c.env.agent.services.webSearch.setApiKey(input.api_key);
  return c.json({ provider: "tavily", has_api_key: true });
});

webSearchRoutes.delete("/web-search", async (c) => {
  await c.env.agent.services.webSearch.clearApiKey();
  return c.json({ provider: "bing", has_api_key: false });
});
