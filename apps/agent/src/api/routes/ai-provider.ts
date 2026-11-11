import { type AiProviderStatus, aiProviderStatusSchema, aiProviderTestSchema, aiProviderUpdateSchema } from "@talorys/shared";
import { Hono } from "hono";
import type { TalorysAgent } from "../../agent/talorys-agent";
import { classifyOpenAiCompatibleError, OpenAICompatibleProvider } from "../../ai/openai-compatible";
import { SecretBox } from "../../services/secret-box";
import type { AppEnv } from "../app";
import { AppError, ValidationError } from "../errors";
import { body } from "../middleware";

export const aiProviderRoutes = new Hono<AppEnv>();

/** tal_settings record holding the encrypted custom provider API key. */
const CREDENTIAL_KEY = "ai.credentials";

/** SecretBox domain for the custom provider key; must match TalorysAgent.customProviderKey. */
function credentialBox(env: AppEnv["Bindings"]["env"]): SecretBox {
  return new SecretBox(env.MCP_CREDENTIAL_KEY, "ai-provider");
}

/** Builds the owner-facing status. The API key itself is never returned, only its presence. */
async function status(agent: TalorysAgent): Promise<AiProviderStatus> {
  const settings = agent.services.settings.get();
  const custom = settings.aiProvider;
  const active = custom !== undefined && custom.disabled !== true;
  const hasApiKey = (await agent.customProviderKey()) !== null;
  const parsed = aiProviderStatusSchema.safeParse({
    kind: active ? "custom" : "workers-ai",
    saved: custom !== undefined,
    base_url: custom?.baseUrl ?? null,
    model: custom?.model ?? null,
    has_api_key: hasApiKey,
  });
  return parsed.success
    ? parsed.data
    : { kind: "workers-ai", saved: false, base_url: null, model: null, has_api_key: false };
}

aiProviderRoutes.get("/ai-provider", async (c) => c.json(await status(c.env.agent)));

aiProviderRoutes.put("/ai-provider", async (c) => {
  const input = await body(c, aiProviderUpdateSchema);
  const s = c.env.agent.services;
  const stored = s.settings.get().aiProvider;
  if (input.disabled === true) {
    // Pause, not delete: the config and its stored key survive so the owner can
    // switch back to the custom provider with a single Save later.
    if (stored) {
      s.settings.update({ aiProvider: { baseUrl: input.base_url ?? stored.baseUrl, model: input.model ?? stored.model, disabled: true } });
    }
    return c.json(await status(c.env.agent));
  }
  if (!input.base_url || !input.model) throw new ValidationError("Base URL and model are required");
  // Changing base URL or model alone is allowed; a first-time setup needs a key.
  if (!input.api_key && !(await c.env.agent.customProviderKey())) {
    throw new ValidationError("API key is required");
  }
  if (input.api_key) {
    // Throws the understandable NOT_CONFIGURED error when the deployment has no MCP_CREDENTIAL_KEY yet.
    const box = credentialBox(c.env.env);
    box.assertAvailable();
    s.settings.setJson(CREDENTIAL_KEY, { credential: await box.encrypt("key", input.api_key) });
  }
  // disabled: false also re-activates a paused config.
  s.settings.update({ aiProvider: { baseUrl: input.base_url, model: input.model, disabled: false } });
  return c.json(await status(c.env.agent));
});

aiProviderRoutes.delete("/ai-provider", async (c) => {
  const s = c.env.agent.services;
  s.settings.update({ aiProvider: null });
  s.settings.delete(CREDENTIAL_KEY);
  return c.json(await status(c.env.agent));
});

aiProviderRoutes.post("/ai-provider/test", async (c) => {
  const input = await body(c, aiProviderTestSchema);
  const agent = c.env.agent;
  const stored = agent.services.settings.get().aiProvider;
  const baseUrl = input.base_url ?? stored?.baseUrl;
  const model = input.model ?? stored?.model;
  // Passed key wins (test the unsaved form), otherwise the stored one.
  const apiKey = input.api_key ?? (await agent.customProviderKey());
  if (!baseUrl || !model || !apiKey) {
    throw new ValidationError("Base URL, model and an API key (saved or pasted) are required to test the provider");
  }
  const provider = new OpenAICompatibleProvider({ baseUrl, apiKey, model });
  try {
    // A one-off, tiny connectivity probe: deliberately not recorded in usage counters or
    // counted against the daily AI budget (the provider returns usage, but nothing reads it).
    await provider.generate({
      system: "You are a connectivity test. Reply with exactly: OK",
      messages: [{ role: "user", content: "ping" }],
      maxOutputTokens: 16,
      temperature: 0,
    });
    return c.json({ ok: true, model });
  } catch (error) {
    const appError = error instanceof AppError ? error : classifyOpenAiCompatibleError(error);
    // The result lives in the body; the transport succeeded, only the provider call failed.
    return c.json({ ok: false, error: appError.message });
  }
});
