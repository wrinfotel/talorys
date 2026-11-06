import { describe, expect, it, vi } from "vitest";
import type { TalorysAgent } from "../src/agent/talorys-agent";
import type { Env } from "../src/env";
import { AppError } from "../src/api/errors";
import { OpenAICompatibleProvider } from "../src/ai/openai-compatible";
import { CloudflareWorkersAIProvider } from "../src/ai/workers-ai";
import { MockAIProvider } from "../src/ai/mock";
import { UnavailableAiProvider, type AIProvider } from "../src/ai/provider";
import { SecretBox } from "../src/services/secret-box";
import { inAgent, loggedIn } from "./helpers";

const BASE_URL = "https://openrouter.ai/api/v1";
const MODEL = "openai/gpt-4o-mini";
const API_KEY = "sk-or-test-owner-key";

/** Test-only access to the agent's env bindings (`env` is protected on the SDK class). */
const envOf = (agent: TalorysAgent): Env => (agent as unknown as { env: Env }).env;

/** The vitest pool runs with TALORYS_MOCK_AI=1; the custom provider is only reached with the mock off. */
async function withMockAi<R>(agent: TalorysAgent, run: (agent: TalorysAgent) => Promise<R>): Promise<R> {
  const env = envOf(agent);
  const saved = env.TALORYS_MOCK_AI;
  env.TALORYS_MOCK_AI = "0";
  try {
    return await run(agent);
  } finally {
    if (saved === undefined) delete env.TALORYS_MOCK_AI;
    else env.TALORYS_MOCK_AI = saved;
  }
}

async function storeCredential(agent: TalorysAgent, credential = API_KEY): Promise<void> {
  agent.services.settings.setJson("ai.credentials", {
    credential: await new SecretBox(envOf(agent).MCP_CREDENTIAL_KEY, "ai-provider").encrypt("key", credential),
  });
}

/** All tal_settings rows, to assert on stored secrets directly. */
async function settingsRows(agent: TalorysAgent) {
  return agent.services.db.all<{ key: string; value: string }>(`SELECT key, value FROM tal_settings`);
}

const connectedProvider = (provider: AIProvider | null) => provider instanceof OpenAICompatibleProvider;

describe("ai-provider routes", () => {
  it("PUT stores the provider and an encrypted key; GET reports status without key material", async () => {
    const c = await loggedIn();
    const status = await c.json("/api/ai-provider", { method: "PUT", body: { base_url: BASE_URL, model: MODEL, api_key: API_KEY } });
    expect(status).toEqual({ kind: "custom", base_url: BASE_URL, model: MODEL, has_api_key: true });

    // GET reports the same status and never the key.
    expect(await c.json("/api/ai-provider")).toEqual(status);
    expect(JSON.stringify(status)).not.toContain(API_KEY);

    await inAgent(async (agent) => {
      // Nothing in tal_settings holds the plain key.
      const rows = await settingsRows(agent);
      expect(JSON.stringify(rows)).not.toContain(API_KEY);
      const credential = rows.find((r) => r.key === "ai.credentials");
      expect(credential?.value).toMatch(/^\{"credential":"v1\./);
      // Decrypting the stored record returns the original key, and chat would use it.
      const stored = JSON.parse(credential!.value) as { credential: string };
      expect(await new SecretBox(envOf(agent).MCP_CREDENTIAL_KEY, "ai-provider").decrypt("key", stored.credential)).toBe(API_KEY);
      await withMockAi(agent, async (a) => expect(connectedProvider(await a.aiProvider())).toBe(true));
    });
    // Later tests assume an empty vault.
    await c.json("/api/ai-provider", { method: "DELETE" });
  });

  it("PUT without a key on an empty vault is a validation error", async () => {
    const c = await loggedIn();
    const res = await c.call("/api/ai-provider", { method: "PUT", body: { base_url: BASE_URL, model: MODEL } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "VALIDATION_ERROR", message: expect.stringContaining("API key is required") } });
  });

  it("PUT with a key but no MCP_CREDENTIAL_KEY secret explains the fix", async () => {
    const c = await loggedIn();
    await inAgent(async (agent) => {
      const env = envOf(agent);
      const saved = env.MCP_CREDENTIAL_KEY;
      delete env.MCP_CREDENTIAL_KEY;
      try {
        const res = await c.call("/api/ai-provider", { method: "PUT", body: { base_url: BASE_URL, model: MODEL, api_key: API_KEY } });
        expect(res.status).toBe(503);
        expect(await res.json()).toMatchObject({ error: { code: "NOT_CONFIGURED", message: expect.stringContaining("create-talorys") } });
      } finally {
        env.MCP_CREDENTIAL_KEY = saved;
      }
    });
  });

  it("DELETE resets to Workers AI and removes the stored credential", async () => {
    const c = await loggedIn();
    await c.json("/api/ai-provider", { method: "PUT", body: { base_url: BASE_URL, model: MODEL, api_key: API_KEY } });
    const status = await c.json("/api/ai-provider", { method: "DELETE" });
    expect(status).toEqual({ kind: "workers-ai", base_url: null, model: null, has_api_key: false });
    await inAgent(async (agent) => {
      expect(agent.services.settings.get().aiProvider).toBeUndefined();
      expect((await settingsRows(agent)).some((r) => r.key === "ai.credentials")).toBe(false);
      expect(await agent.aiProvider()).toBeInstanceOf(MockAIProvider);
    });
  });

  it("GET on a default deployment reports Workers AI", async () => {
    const c = await loggedIn();
    expect(await c.json("/api/ai-provider")).toEqual({ kind: "workers-ai", base_url: null, model: null, has_api_key: false });
  });

  it("POST /test probes connectivity with the submitted config, spending no budget", async () => {
    const c = await loggedIn();
    const generate = vi.spyOn(OpenAICompatibleProvider.prototype, "generate").mockResolvedValue({
      text: "OK",
      usage: { model: MODEL, billable: true, inputTokens: { reported: 1, estimated: 0 }, outputTokens: { reported: 1, estimated: 0 }, cachedInputTokens: 0 },
    });
    try {
      // Only submitted fields: tests the unsaved form before any PUT.
      expect(await c.json("/api/ai-provider/test", { method: "POST", body: { base_url: BASE_URL, model: MODEL, api_key: API_KEY } })).toEqual({ ok: true, model: MODEL });
      // The probe is never recorded against usage counters.
      expect(await inAgent((agent) => agent.services.usage.today().ai_requests)).toBe(0);

      // A saved config can be probed without re-submitting the key.
      await inAgent(async (agent) => {
        agent.services.settings.update({ aiProvider: { baseUrl: BASE_URL, model: MODEL } });
        await storeCredential(agent);
      });
      expect(await c.json("/api/ai-provider/test", { method: "POST", body: {} })).toEqual({ ok: true, model: MODEL });

      // A failed probe is reported in the body; the transport still answers 200.
      generate.mockRejectedValueOnce(new AppError("AI_UNAVAILABLE", "The custom provider rejected the API key. Check it in Settings → AI."));
      const failed = await c.call("/api/ai-provider/test", { method: "POST", body: {} });
      expect(failed.status).toBe(200);
      expect(await failed.json()).toEqual({ ok: false, error: "The custom provider rejected the API key. Check it in Settings → AI." });

      await inAgent((agent) => {
        agent.services.settings.update({ aiProvider: null });
        agent.services.settings.delete("ai.credentials");
      });
    } finally {
      generate.mockRestore();
    }
  });

  it("POST /test without any usable configuration is a validation error", async () => {
    const c = await loggedIn();
    const res = await c.call("/api/ai-provider/test", { method: "POST", body: { base_url: BASE_URL } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  });
});

describe("ai provider selection", () => {
  it("fresh settings and an AI binding pick Workers AI (default regression)", async () => {
    await inAgent(async (agent) => {
      agent.services.settings.delete("app.settings");
      expect(agent.services.settings.get().aiProvider).toBeUndefined();
      await withMockAi(agent, async (a) => expect(await a.aiProvider()).toBeInstanceOf(CloudflareWorkersAIProvider));
    });
  });

  it("a configured provider with a readable key picks the custom provider", async () => {
    await inAgent(async (agent) => {
      agent.services.settings.update({ aiProvider: { baseUrl: BASE_URL, model: MODEL } });
      await storeCredential(agent);
      await withMockAi(agent, async (a) => {
        const provider = await a.aiProvider();
        expect(connectedProvider(provider)).toBe(true);
        expect(provider!.model).toBe(MODEL);
        expect(provider!.billable).toBe(true);
      });
      agent.services.settings.update({ aiProvider: null });
      agent.services.settings.delete("ai.credentials");
    });
  });

  it("a configured provider with an unreadable key fails explicitly instead of falling back", async () => {
    await inAgent(async (agent) => {
      agent.services.settings.update({ aiProvider: { baseUrl: BASE_URL, model: MODEL } });
      agent.services.settings.setJson("ai.credentials", { credential: "v1.garbage.garbage" });
      await withMockAi(agent, async (a) => expect(await a.aiProvider()).toBeInstanceOf(UnavailableAiProvider));
      agent.services.settings.update({ aiProvider: null });
      agent.services.settings.delete("ai.credentials");
    });
  });

  it("a configured provider without a stored key fails explicitly too", async () => {
    await inAgent(async (agent) => {
      agent.services.settings.update({ aiProvider: { baseUrl: BASE_URL, model: MODEL } });
      await withMockAi(agent, async (a) => expect(await a.aiProvider()).toBeInstanceOf(UnavailableAiProvider));
      agent.services.settings.update({ aiProvider: null });
    });
  });

  it("demo mode still picks the mock provider (regression)", async () => {
    await inAgent(async (agent) => {
      agent.services.settings.update({ demoMode: true, aiProvider: { baseUrl: BASE_URL, model: MODEL } });
      expect(await agent.aiProvider()).toBeInstanceOf(MockAIProvider);
      agent.services.settings.update({ demoMode: false, aiProvider: null });
    });
  });

  it("Clef stays on Workers AI only: disabled for the custom provider, enabled without one", async () => {
    await inAgent(async (agent) => {
      await withMockAi(agent, async (a) => expect(a.clefRun()).not.toBeNull());
      agent.services.settings.update({ aiProvider: { baseUrl: BASE_URL, model: MODEL } });
      // The memory check keeps using Workers AI's decision model, so a custom chat provider disables it.
      expect(agent.clefRun()).toBeNull();
      agent.services.settings.update({ aiProvider: null });
    });
  });
});
