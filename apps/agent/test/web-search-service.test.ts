import { describe, expect, it } from "vitest";
import { WebSearchService } from "../src/services/web-search";
import { SecretBox } from "../src/services/secret-box";
import type { SettingsService } from "../src/services/settings";

const SECRET = "unit-test-secret-0123456789abcdef-unit";
const service = () => new WebSearchService(new FakeSettings() as unknown as SettingsService, new SecretBox(SECRET, "web-search"));

class FakeSettings {
  private store = new Map<string, unknown>();
  getJson<T>(key: string): T | null {
    return (this.store.get(key) as T) ?? null;
  }
  async setJson(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }
  delete(key: string): void {
    this.store.delete(key);
  }
}

describe("WebSearchService", () => {
  it("starts with no key", async () => {
    expect(await service().apiKey()).toBeNull();
  });

  it("stores the key encrypted and reads it back", async () => {
    const s = service();
    await s.setApiKey("tvly-live-key-0000000000000000");
    const stored = s["settings" as keyof typeof s] as unknown as FakeSettings;
    const raw = stored.getJson<{ credential?: string }>("web-search.credentials");
    expect(raw?.credential).toBeTruthy();
    expect(raw?.credential).not.toContain("tvly-live-key");
    expect(await s.apiKey()).toBe("tvly-live-key-0000000000000000");
  });

  it("returns null for a key encrypted with a different secret", async () => {
    const s = service();
    await s.setApiKey("tvly-live-key-0000000000000000");
    const rotated = new WebSearchService((s as unknown as { settings: FakeSettings }).settings as unknown as SettingsService, new SecretBox(SECRET + "x", "web-search"));
    expect(await rotated.apiKey()).toBeNull();
  });

  it("clears the key", async () => {
    const s = service();
    await s.setApiKey("tvly-live-key-0000000000000000");
    await s.clearApiKey();
    expect(await s.apiKey()).toBeNull();
  });
});
