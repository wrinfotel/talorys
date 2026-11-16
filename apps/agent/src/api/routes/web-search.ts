import { type WebSearchStatus, webSearchKeySchema } from "@talorys/shared";
import { Hono } from "hono";
import type { TalorysAgent } from "../../agent/talorys-agent";
import type { AppEnv } from "../app";
import { ValidationError } from "../errors";
import { body } from "../middleware";

/** Owner-only status and key management for the web_search tool's keyed providers. */
export const webSearchRoutes = new Hono<AppEnv>();

/** Builds the owner-facing status. Keys themselves are never returned, only their presence. */
async function status(agent: TalorysAgent): Promise<WebSearchStatus> {
  const [tavily, keenable] = await Promise.all([agent.services.webSearch.tavilyKey(), agent.services.webSearch.keenableKey()]);
  return {
    provider: tavily ? "tavily" : keenable ? "keenable" : "keyless",
    has_tavily_key: tavily !== null,
    has_keenable_key: keenable !== null,
  };
}

webSearchRoutes.get("/web-search", async (c) => {
  return c.json(await status(c.env.agent));
});

webSearchRoutes.put("/web-search", async (c) => {
  const input = await body(c, webSearchKeySchema);
  await c.env.agent.services.webSearch.setKey(input.provider, input.api_key);
  return c.json(await status(c.env.agent));
});

webSearchRoutes.delete("/web-search/:provider", async (c) => {
  const provider = c.req.param("provider");
  if (provider !== "tavily" && provider !== "keenable") throw new ValidationError("Unknown search provider.");
  await c.env.agent.services.webSearch.clearKey(provider as "tavily" | "keenable");
  return c.json(await status(c.env.agent));
});
