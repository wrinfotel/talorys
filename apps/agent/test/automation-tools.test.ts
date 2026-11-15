import { describe, expect, it } from "vitest";
import type { AutomationRun } from "@talorys/shared";
import { ALL_TOOLS, ToolExecutor } from "../src/tools";
import { buildSystemPrompt } from "../src/agent/prompt";
import type { Services } from "../src/services/container";
import { inAgent } from "./helpers";

const ctx = (s: Services, extra: Record<string, unknown> = {}) => ({ services: s, timezone: "UTC", mode: "chat" as const, ...extra });

const runStub = (id: string, name: string): AutomationRun => ({
  id: "run-1",
  automation_id: id,
  automation_name: name,
  started_at: new Date().toISOString(),
  finished_at: new Date().toISOString(),
  status: "success",
  result: "Reminder delivered",
  error: null,
});

describe("automation management tools", () => {
  it("edits an automation's schedule, message and enabled flag", async () => {
    await inAgent(async (agent) => {
      const s = agent.services;
      const a = await s.automations.create({
        name: "Digest",
        kind: "reminder",
        message: "Daily digest",
        schedule: { type: "daily", time: "09:00" },
        enabled: true,
      });
      const executor = new ToolExecutor(ALL_TOOLS, ctx(s), { maxToolCalls: 10 });

      const result = (await executor.execute("edit_automation", { id: a.id, schedule: { type: "weekly", days: [1], time: "08:30" } }, "call-1")) as {
        automation: { id: string; schedule: string; enabled: boolean };
      };
      expect(result.automation).toMatchObject({ id: a.id, enabled: true });
      expect(s.automations.get(a.id)!.schedule).toEqual({ type: "weekly", days: [1], time: "08:30" });

      await executor.execute("edit_automation", { id: a.id, enabled: false }, "call-2");
      expect(s.automations.get(a.id)!.enabled).toBe(false);

      await executor.execute("edit_automation", { id: a.id, message: "New text" }, "call-3");
      expect(s.automations.get(a.id)!.message).toBe("New text");
    });
  });

  it("runs an automation on demand through the agent's hook", async () => {
    await inAgent(async (agent) => {
      const s = agent.services;
      const a = await s.automations.create({
        name: "Standup",
        kind: "reminder",
        message: "Stand up time",
        schedule: { type: "daily", time: "09:00" },
        enabled: true,
      });
      const executor = new ToolExecutor(ALL_TOOLS, ctx(s, { runAutomationNow: async (id: string) => runStub(id, a.name) }), { maxToolCalls: 10 });
      const result = (await executor.execute("run_automation", { id: a.id }, "call-1")) as {
        automation: { id: string; name: string; status: string; result: string | null };
      };
      expect(result.automation).toMatchObject({ id: a.id, name: "Standup", status: "success", result: "Reminder delivered" });

      // Without the hook (e.g. a scheduled run) the tool refuses instead of pretending.
      const bare = new ToolExecutor(ALL_TOOLS, ctx(s), { maxToolCalls: 10 });
      await expect(bare.execute("run_automation", { id: a.id }, "call-2")).rejects.toThrow("not available");
    });
  });

  it("tells the model in the system prompt that it manages schedules itself", () => {
    const prompt = buildSystemPrompt({ agentName: "T", timezone: "UTC", now: new Date(), autoMemory: false, memories: [] });
    expect(prompt).toContain("create_automation take effect immediately");
    expect(prompt).toContain("run_automation");
  });
});
