import { describe, expect, it } from "vitest";
import { checkForUpdate, compareVersions, LATEST_URL } from "../src/services/update-check";
import { inAgent, loggedIn } from "./helpers";

const registry = (version: string | null, calls: { n: number; url?: string }) =>
  (async (input: RequestInfo | URL) => {
    calls.n++;
    calls.url = String(input);
    if (version === null) throw new Error("offline");
    return new Response(JSON.stringify({ version }), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

describe("update check", () => {
  it("compares plain versions and ignores prereleases", () => {
    expect(compareVersions("0.1.10", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("0.1.5", "0.1.5")).toBe(0);
    expect(compareVersions("0.2.0-beta.1", "0.1.5")).toBe(0);
  });

  it("reports a newer release and caches the lookup for a day", async () => {
    await inAgent(async (agent) => {
      const s = agent.services.settings;
      s.delete("update.latest");
      const calls = { n: 0, url: undefined as string | undefined };
      const t = 1_000_000;
      const first = await checkForUpdate(s, "0.1.5", registry("0.2.0", calls), t);
      expect(first).toMatchObject({ enabled: true, latest: "0.2.0", update_available: true });
      // The fork checks its own repository, not the upstream npm package.
      expect(calls.url).toBe(LATEST_URL);
      expect(LATEST_URL).toContain("raw.githubusercontent.com/wrinfotel/talorys/main");
      await checkForUpdate(s, "0.1.5", registry("0.3.0", calls), t + 60_000);
      expect(calls.n).toBe(1);
      const later = await checkForUpdate(s, "0.1.5", registry("0.3.0", calls), t + 25 * 3600_000);
      expect(later.latest).toBe("0.3.0");
      s.delete("update.latest");
    });
  });

  it("fails quietly when offline", async () => {
    await inAgent(async (agent) => {
      const s = agent.services.settings;
      s.delete("update.latest");
      const r = await checkForUpdate(s, "0.1.5", registry(null, { n: 0 }));
      expect(r).toMatchObject({ enabled: true, latest: null, update_available: false });
      s.delete("update.latest");
    });
  });

  it("never contacts the registry when turned off", async () => {
    const c = await loggedIn();
    await c.json("/api/settings", { method: "PATCH", body: { updateCheck: false } });
    try {
      expect(await c.json("/api/system/update")).toMatchObject({ enabled: false, latest: null, update_available: false });
      await inAgent(async (agent) => {
        const calls = { n: 0 };
        await checkForUpdate(agent.services.settings, "0.1.5", registry("9.9.9", calls));
        expect(calls.n).toBe(0);
      });
    } finally {
      await c.json("/api/settings", { method: "PATCH", body: { updateCheck: true } });
    }
  });
});
