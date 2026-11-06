import { describe, expect, it } from "vitest";
import { inAgent } from "./helpers";

const PROVIDER = { baseUrl: "https://api.example.com/v1", model: "gpt-4o" };

describe("settings: custom AI provider", () => {
  it("parses fresh settings without aiProvider, so Workers AI stays the default", async () => {
    await inAgent((agent) => {
      agent.services.settings.delete("app.settings");
      const settings = agent.services.settings.get();
      expect(settings.aiProvider).toBeUndefined();
      // The Workers AI model field keeps its default.
      expect(settings.model).toMatch(/^@(cf|hf)\//);
    });
  });

  it("stores a custom provider and keeps the other settings", async () => {
    const before = await inAgent((agent) => agent.services.settings.get());
    await inAgent((agent) => {
      const saved = agent.services.settings.update({ aiProvider: PROVIDER });
      expect(saved.aiProvider).toEqual(PROVIDER);
      expect(saved.model).toBe(before.model);
      expect(agent.services.settings.raw()).toMatchObject({ aiProvider: PROVIDER });
    });
    await inAgent((agent) => agent.services.settings.update({ aiProvider: null }));
  });

  it("removes aiProvider on an explicit null instead of storing null", async () => {
    await inAgent((agent) => agent.services.settings.update({ aiProvider: PROVIDER }));
    await inAgent((agent) => {
      const reset = agent.services.settings.update({ aiProvider: null });
      expect(reset.aiProvider).toBeUndefined();
      expect(agent.services.settings.get().aiProvider).toBeUndefined();
      // The stored record drops the key; a null never reaches storage.
      expect("aiProvider" in agent.services.settings.raw()).toBe(false);
    });
  });
});
